"use strict";
const energyLogic=typeof module==="undefined"?{workoutEnergy,measurementAt,exerciseResultName,canonicalSupp}:require("./logic.js");
function autoEnergyRule(profile,stored){
  if(stored?.mode==="manual"||stored?.mode==="off")return stored;
  const data=stored||profile||{};
  return {mode:"auto",height:Number(data.height),birth:data.birth,age:Number(data.age),sex:data.sex,
    factor:stored?.mode==="auto"?stored.factor:1.2};
}
// All report dates are calendar days in the diary's local time.
function reportDate(d){
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");
}
function shiftDay(day,n){
  const d=new Date(day+"T12:00");d.setDate(d.getDate()+n);return reportDate(d);
}
function monday(day){return shiftDay(day,-((new Date(day+"T12:00").getDay()+6)%7))}
function reportStart(day,period){
  return period==="year"?day.slice(0,4)+"-01-01":period==="month"?day.slice(0,7)+"-01":period==="week"?monday(day):day;
}
function supplementStatus(state,day,today=reportDate(new Date())){
  const taken=new Set((state.supps||[]).filter(x=>x.date.slice(0,10)===day).flatMap(x=>x.names.map(energyLogic.canonicalSupp)));
  if(!taken.size)return day<today?"Не принимал":day===today?"Пока нет отметки":"Запланировано";
  const planned=state.suppPlans?.[day];
  if(!Array.isArray(planned))return "Есть отметки";
  return planned.some(n=>!taken.has(energyLogic.canonicalSupp(n)))?"Принял часть":"Принял";
}
const macroSlots=[0,1,2,3];
function scaledValue(value,factor){
  if(!Number.isFinite(value)||value<0||!Number.isFinite(factor)||factor<=0)return null;
  const result=value*factor;
  return Number.isFinite(result)?result:null;
}
function emptyIntake(){
  return {count:0,known:[0,0,0,0],missing:[0,0,0,0],totals:[null,null,null,null]};
}
function mergeIntake(sum,part){
  sum.count+=part.count;
  for(const i of macroSlots){
    sum.known[i]+=part.known[i];
    sum.missing[i]+=part.missing[i];
    sum.totals[i]=sum.count&&!sum.missing[i]?sum.known[i]:null;
  }
  return sum;
}
function emptyDoseTotals(){
  return {creatineGrams:0,creatineServings:0,creatineUnknown:0,proteinGrams:0,proteinServings:0,proteinUnknown:0,powderGrams:0,powderUnknown:0};
}
function dayIntake(meals,entries){
  const summary=emptyIntake(), doses=emptyDoseTotals(), supplements=[];
  function add(nut){
    mergeIntake(summary,{count:1,known:nut.map(v=>v??0),missing:nut.map(v=>Number(v==null))});
  }
  for(const m of meals){
    add(macroSlots.map(i=>Array.isArray(m.totals)?scaledValue(m.totals[i],1):scaledValue(m.nut?.[i],Number(m.amount)/100)));
  }
  for(const entry of entries){
    const kinds=new Set(entry.names.map(energyLogic.canonicalSupp));
    const servings=Number.isFinite(entry.servings)&&entry.servings>0?entry.servings:null;
    if(kinds.has("Креатин")){
      doses.creatineServings+=servings||0;
      const grams=scaledValue(entry.creatinePerServing,servings);
      if(grams==null)doses.creatineUnknown++;else doses.creatineGrams+=grams;
    }
    if(kinds.has("Протеин")){
      doses.proteinServings+=servings||0;
      const nut=macroSlots.map(i=>scaledValue(entry.perServing?.[i],servings));
      if(nut[1]==null)doses.proteinUnknown++;else doses.proteinGrams+=nut[1];
      const powder=scaledValue(entry.powderPerServing,servings);
      if(powder==null)doses.powderUnknown++;else doses.powderGrams+=powder;
      const linked=!!entry.mealId&&meals.some(m=>m.id===entry.mealId);
      supplements.push({name:"Протеин",servings,nut,linked,mealId:entry.mealId||null});
      if(!linked)add(nut);
    }
  }
  return {...summary,doses,supplements};
}
function foodByDate(state){
  const days=new Map();
  function append(day,key,row){
    if(!days.has(day))days.set(day,{meals:[],supps:[]});
    days.get(day)[key].push(row);
  }
  (state.meals||[]).forEach((m,i)=>append(m.date.slice(0,10),"meals",m.id?m:{...m,id:"legacy-"+i+"-"+m.date}));
  for(const entry of state.supps||[])append(entry.date.slice(0,10),"supps",entry);
  return days;
}
function nutritionForDay(state,day){
  const rows=foodByDate(state).get(day);
  return dayIntake(rows?.meals||[],rows?.supps||[]);
}
function dailyWeights(state,scale,preferred){
  const days=new Map();
  for(const row of [...(scale||[]),...(state.weights||[])]){
    const instant=new Date(row.date),ms=instant.getTime();
    if(!Number.isFinite(ms)||!Number.isFinite(row.kg)||row.kg<=0||row.kg>=700)continue;
    const day=reportDate(instant),old=days.get(day);
    const rank=row.source==="ha"&&row.entity===preferred?2:row.source==="manual"?1:0;
    if(!old||ms>old.ms||ms===old.ms&&rank>=old.rank)days.set(day,{day,kg:row.kg,ms,rank,source:row.source});
  }
  return [...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
}
function maintenance(rule,day,kg){
  if(!rule)return null;
  if(rule.mode==="manual")return Number.isFinite(rule.kcal)&&rule.kcal>0?rule.kcal:null;
  if(!["auto","estimate"].includes(rule.mode)||!kg||!(rule.height>0)||!["Мужской","Женский"].includes(rule.sex)||![1.2,1.4,1.6,1.8].includes(rule.factor))return null;
  const age=rule.birth?Number(day.slice(0,4))-Number(rule.birth.slice(0,4))-Number(day.slice(5)<rule.birth.slice(5)):rule.age;
  if(!(age>=19))return null;
  const estimate=(10*kg+6.25*rule.height-5*age+(rule.sex==="Мужской"?5:-161))*rule.factor;
  return estimate>0?Math.round(estimate):null;
}
function diaryReport(state,scale,entity,anchor,period,today=reportDate(new Date())){
  const start=reportStart(anchor,period),end=anchor<today?anchor:today;
  const days=new Map();
  function entry(day){
    if(!days.has(day))days.set(day,{day,meals:0,kcal:0,unknown:0,workouts:0,sessions:[],sets:0,reps:0,volume:0,minutes:0,points:0,awards:[],exercises:new Map()});
    return days.get(day);
  }
  for(const [day,rows] of foodByDate(state)){
    if(day>end)continue;
    const d=entry(day),nutrition=dayIntake(rows.meals,rows.supps);
    d.nutrition=nutrition;d.meals=nutrition.count;d.kcal=nutrition.known[0];d.unknown=nutrition.missing[0];
  }
  for(const w of state.workouts||[]){
    const day=w.date.slice(0,10);if(day>end)continue;
    const d=entry(day);d.workouts++;
    const finishDay=w.end?.slice(0,10);
    if(finishDay===shiftDay(day,1)){
      // Old entries store local wall times. Split the estimate in proportion to the elapsed local session.
      const a=Date.parse(w.date),b=Date.parse(w.end),midnight=Date.parse(finishDay+"T00:00");
      const first=b>a?Math.max(0,Math.min(1,(midnight-a)/(b-a))):1;
      d.sessions.push({workout:w,fraction:first});
      if(finishDay<=end&&first<1)entry(finishDay).sessions.push({workout:w,fraction:1-first});
    }else d.sessions.push({workout:w,fraction:1});
    const minutes=(Date.parse(w.end)-Date.parse(w.date))/60000;
    if(Number.isFinite(minutes)&&minutes>0)d.minutes+=minutes;
    for(const ex of w.exercises||[]){
      const sets=(ex.sets||[]).filter(x=>x.done&&Number.isFinite(x.kg)&&x.kg>=0&&Number.isInteger(x.reps)&&x.reps>0);
      if(!sets.length)continue;
      const label=energyLogic.exerciseResultName(ex);
      const item=d.exercises.get(label)||{day,sets:0,reps:0,kg:0,volume:0,lines:[]};
      for(const t of sets){
        d.sets++;d.reps+=t.reps;d.volume+=t.kg*t.reps;
        if(t.warmup)continue;
        item.sets++;item.reps+=t.reps;item.volume+=t.kg*t.reps;item.kg=Math.max(item.kg,t.kg);
        item.lines.push(t.kg+" × "+t.reps);
      }
      if(item.sets)d.exercises.set(label,item);
    }
  }
  for(const [day,v] of Object.entries(state.restLog||{}))if(day<=end&&v)entry(day).rest=true;
  for(let day=start;day<=end;day=shiftDay(day,1))entry(day);
  const sorted=[...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
  const rules=Object.entries(state.energyRules||{}).sort(([a],[b])=>a.localeCompare(b));
  const weightRows=dailyWeights(state,scale,entity).filter(w=>w.day<=end);
  let wi=0,ri=0,weight=null,rule=null,points=0;
  const weeks=new Map();
  const achievements=new Map();
  function award(d,label,value){d.awards.push({label,value});d.points+=value;points+=value}
  function unlock(d,label,value){if(!achievements.has(label)){achievements.set(label,d.day);award(d,label,value)}}
  let loggedTrainingDays=0,loggedFoodDays=0;
  for(const d of sorted){
    while(wi<weightRows.length&&weightRows[wi].day<=d.day)weight=weightRows[wi++];
    while(ri<rules.length&&rules[ri][0]<=d.day)rule=rules[ri++][1];
    d.complete=!!state.foodComplete?.[d.day]&&d.meals>0;
    const usableRule=autoEnergyRule(state.profile,rule);
    const kg=weight?.kg||d.sessions.find(s=>Number(s.workout.kg)>0)?.workout.kg;
    d.balance=null;d.base=maintenance(usableRule,d.day,kg);d.maintenance=d.base;
    d.active=null;d.energyMode=usableRule.mode;
    if(usableRule.mode==="auto"&&d.base!=null){
      let extra=0;
      for(const {workout:w,fraction} of d.sessions){
        const bodyKg=Number(w.kg)>0?w.kg:energyLogic.measurementAt(state,w.startedAt||w.date,scale||[],entity)?.kg;
        const session=energyLogic.workoutEnergy(w,bodyKg);
        if(session.gross==null){extra=null;break}
        extra+=fraction*Math.max(0,session.gross-d.base*session.minutes/1440);
      }
      d.active=extra==null?null:Math.round(extra);
      d.maintenance=d.active==null?null:d.base+d.active;
    }
    if(d.complete&&!d.unknown&&d.maintenance!=null)d.balance=Math.round(d.kcal)-d.maintenance;
    const key=monday(d.day);
    const week=weeks.get(key)||{food:0,gym:0,activity:0,joint:false,repeat:false,moves:new Set()};
    weeks.set(key,week);
    if(d.meals)award(d,"Питание записано",2);
    if(d.complete){week.food++;loggedFoodDays++;award(d,"Дневник питания заполнен",3);if(loggedFoodDays===30)unlock(d,"30 дней дневника питания",15);if(loggedFoodDays===100)unlock(d,"100 дней дневника питания",30)}
    if(d.workouts){week.gym++;week.activity++;loggedTrainingDays++;if(loggedTrainingDays===10)unlock(d,"10 дней тренировок",15);if(loggedTrainingDays===50)unlock(d,"50 дней тренировок",30);award(d,"Тренировка записана",8);unlock(d,"Первая тренировка",5)}
    else if(d.rest){week.activity++;award(d,"День отдыха отмечен",2)}
    if(!week.repeat&&[...d.exercises.keys()].some(name=>week.moves.has(name))){
      week.repeat=true;award(d,"Упражнение записано в два разных дня недели",5);unlock(d,"Есть с чем сравнить",5);
    }
    for(const name of d.exercises.keys())week.moves.add(name);
    if(d.complete&&week.food===7){award(d,"Семь дней питания",15);unlock(d,"Первая полная неделя питания",5)}
    if(!week.joint&&week.food===7&&(week.gym>=2||week.gym>=1&&week.activity===7)){
      week.joint=true;award(d,"Полная неделя питания, тренировок и отдыха",20);unlock(d,"Неделя целиком",5);
    }
  }
  const rows=sorted.filter(d=>d.day>=start),weights=weightRows.filter(w=>w.day>=start);
  const sum=key=>rows.reduce((n,d)=>n+d[key],0);
  const balances=rows.filter(d=>d.balance!=null);
  const exerciseNames=[...new Set(rows.flatMap(d=>[...d.exercises.keys()]))].sort((a,b)=>a.localeCompare(b,"ru"));
  const nutrition=emptyIntake(),doses=emptyDoseTotals();
  for(const row of rows)if(row.nutrition){
    mergeIntake(nutrition,row.nutrition);
    for(const field of Object.keys(doses))doses[field]+=row.nutrition.doses[field];
  }
  return {start,end,rows,weights,nutrition,doses,latest:weightRows.at(-1),exerciseNames,workouts:sum("workouts"),sets:sum("sets"),reps:sum("reps"),volume:sum("volume"),
    minutes:Math.round(sum("minutes")),meals:sum("meals"),kcal:Math.round(sum("kcal")),unknown:sum("unknown"),foodDays:rows.filter(d=>d.complete).length,
    balances,balance:balances.length?balances.reduce((n,d)=>n+d.balance,0):null,
    deficit:-balances.reduce((n,d)=>n+Math.min(0,d.balance),0),surplus:balances.reduce((n,d)=>n+Math.max(0,d.balance),0),
    periodPoints:sum("points"),points,achievements:[...achievements],week:weeks.get(monday(anchor))||{food:0,gym:0,activity:0,repeat:false,joint:false},
    elapsed:start>end?0:1+Math.round((Date.parse(end+"T12:00Z")-Date.parse(start+"T12:00Z"))/86400000)};
}
if(typeof module!=="undefined")module.exports={diaryReport,reportStart,maintenance,dailyWeights,autoEnergyRule,nutritionForDay,supplementStatus};
