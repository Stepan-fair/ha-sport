"use strict";
const energyLogic=typeof module==="undefined"?{diaryTime,diaryInstant,workoutEnergy,workoutWeightAtStart,workoutInterval,validBodyWeight,preferMeasurement,exerciseResultName,canonicalSupp}:require("./logic.js");
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
function supplementStatus(state,day,today=energyLogic.diaryTime().slice(0,10)){
  const taken=new Set((state.supps||[]).filter(x=>x.date.slice(0,10)===day).flatMap(x=>x.names.map(energyLogic.canonicalSupp)));
  if(!taken.size)return day<today?"Не принимал":day===today?"Пока нет отметки":"Запланировано";
  const planned=state.suppPlans?.[day];
  if(!Array.isArray(planned))return "Есть отметки";
  return planned.some(n=>!taken.has(energyLogic.canonicalSupp(n)))?"Принял часть":"Принял";
}
const macroSlots=[0,1,2,3];
const intakePortions=typeof module==="undefined"?SportPortions:require("./portions.js");
const intakeLabels=["Калории","Белки всего","Жиры","Углеводы"];
function scaledValue(value,factor){
  if(!Number.isFinite(value)||value<0||!Number.isFinite(factor)||factor<=0)return null;
  const result=value*factor;
  return Number.isFinite(result)?result:null;
}
function emptyIntake(){
  return {count:0,known:[0,0,0,0],knownCount:[0,0,0,0],missing:[0,0,0,0],totals:[null,null,null,null]};
}
function mergeIntake(sum,part){
  sum.count+=part.count;
  for(const i of macroSlots){
    sum.known[i]+=part.known[i];
    sum.missing[i]+=part.missing[i];
    sum.knownCount[i]=sum.count-sum.missing[i];
    sum.totals[i]=sum.count&&!sum.missing[i]?sum.known[i]:null;
  }
  return sum;
}
const doseMetrics=[
  ["creatineGrams","creatine","Креатин","г"],["proteinGrams","protein","Белок из протеина","г"],
  ["creatineServings","creatineServings","Порции креатина","порц."],["proteinServings","proteinServings","Порции протеина","саше"],
  ["powderGrams","powder","Порошок протеина","г"]
];
function emptyDoseTotals(){
  return Object.fromEntries(doseMetrics.flatMap(([key,prefix])=>[[key,0],[prefix+"Known",0],[prefix+"Unknown",0]]));
}
function proteinIntake(meal,entry){
  const info=meal?.proteinDetails;
  const measured=value=>scaledValue(value,1);
  const positive=value=>value>0?measured(value):null;
  const sachet=meal?.productKind==="protein"&&/^(саше|sachet)$/i.test(meal.pieceName?.trim());
  const savedCount=sachet?(meal.portion?.mode==="piece"?meal.portion.count:meal.amount/meal.sizes?.piece):null;
  const servings=positive(info?.servings)??positive(savedCount)??positive(entry?.servings);
  const fixedSachet=entry?.names.some(n=>["протеин","первый русский протеин"].includes(n.toLowerCase()));
  const perServing=macroSlots.map(i=>measured(entry?.perServing?.[i])??(i===1&&fixedSachet?22:null));
  const nut=perServing.map((value,i)=>scaledValue(value,servings)??measured(entry?.intakeSnapshot?.[i]));
  const pure=meal?.productKind==="protein";
  const fromMeal=pure?intakePortions.mealNutrients(meal)[1]:null;
  const powderGrams=measured(info?.powderGrams)??(sachet&&meal.unit==="г"?measured(meal.amount):null)??
    scaledValue(entry?.powderPerServing,servings)??measured(entry?.powderTotal);
  const proteinGrams=fromMeal??measured(info?.proteinGrams)??nut[1];
  return {servings,powderGrams,proteinGrams,nut};
}
function dayIntake(meals,entries){
  const summary=emptyIntake(), doses=emptyDoseTotals(), supplements=[],issues=[];
  function missing(source,field){
    if(!source.fields.length)issues.push(source);
    source.fields.push(field);
  }
  function add(nut,source){
    mergeIntake(summary,{count:1,known:nut.map(v=>v??0),missing:nut.map(v=>Number(v==null))});
    nut.forEach((value,i)=>{if(value==null)missing(source,intakeLabels[i])});
  }
  function record(key,value,source){
    const [,prefix,label]=doseMetrics.find(metric=>metric[0]===key);
    if(value==null){doses[prefix+"Unknown"]++;missing(source,label)}
    else {doses[prefix+"Known"]++;doses[key]+=value}
  }
  function protein(meal,entry,source){
    const {servings,powderGrams,proteinGrams,nut}=proteinIntake(meal,entry);
    record("proteinGrams",proteinGrams,source);
    record("proteinServings",servings,source);
    record("powderGrams",powderGrams,source);
    return {name:"Протеин",servings,nut,linked:!!meal,mealId:meal?.id||null};
  }
  const linked=new Map();
  for(const entry of entries){
    if(!entry.mealId||!entry.names.some(n=>energyLogic.canonicalSupp(n)==="Протеин"))continue;
    if(!linked.has(entry.mealId))linked.set(entry.mealId,[]);
    linked.get(entry.mealId).push(entry);
  }
  for(const m of meals){
    const source={kind:"meal",id:m.id,date:m.date,label:m.name,fields:[]};
    const nut=intakePortions.mealNutrients(m),marks=linked.get(m.id)||[];
    if(m.productKind==="protein"&&!m.oil&&marks.length===1){
      const confirmed=proteinIntake(m,marks[0]);
      for(const i of macroSlots)nut[i]??=confirmed.nut[i];
    }
    add(nut,source);
    if(["protein","protein_mix"].includes(m.productKind)&&!linked.has(m.id))protein(m,null,source);
  }
  for(const entry of entries){
    const kinds=new Set(entry.names.map(energyLogic.canonicalSupp));
    const servings=Number.isFinite(entry.servings)&&entry.servings>0?entry.servings:null;
    const source=name=>({kind:"dose",index:entry.sourceIndex,date:entry.date,label:name,period:entry.period,fields:[]});
    if(kinds.has("Креатин")){
      const src=source("Креатин");
      record("creatineServings",servings,src);
      record("creatineGrams",scaledValue(entry.creatinePerServing??3,servings),src);
    }
    if(kinds.has("Протеин")){
      const src=source("Протеин"),meal=entry.mealId&&meals.find(m=>m.id===entry.mealId);
      const sameMeal=meal&&linked.get(meal.id);
      let s;
      if(sameMeal?.length>1 && ["protein","protein_mix"].includes(meal.productKind)){
        // Several old marks can point to the same portion. Its powder belongs to that portion only once.
        const first=sameMeal[0]===entry;
        if(first)protein(meal,null,{kind:"meal",id:meal.id,date:meal.date,label:meal.name,fields:[]});
        s={name:"Протеин",...proteinIntake(null,entry),linked:true,mealId:meal.id};
      }else s=protein(meal,entry,src);
      supplements.push(s);
      if(!meal)add(s.nut,src);
    }
  }
  return {...summary,doses,supplements,issues};
}
function removeMealIntake(state,id){
  const meal=state.meals.find(m=>m.id===id);
  if(!meal)return;
  state.supps=(state.supps||[]).flatMap(row=>{
    if(row.mealId!==id)return [row];
    const protein=row.names.filter(n=>energyLogic.canonicalSupp(n)==="Протеин"),others=row.names.filter(n=>!protein.includes(n));
    if(!protein.length||!others.length)return [row];
    const rest={...row,names:others};delete rest.mealId;
    return [rest,{...row,names:protein}];
  });
  for(const dose of state.supps||[]){
    if(dose.mealId!==id||!dose.names.some(n=>energyLogic.canonicalSupp(n)==="Протеин"))continue;
    const facts=proteinIntake(meal,dose);
    const nut=meal.productKind==="protein"&&!meal.oil?intakePortions.mealNutrients(meal).map((v,i)=>v??facts.nut[i]):[...facts.nut];
    nut[1]=facts.proteinGrams;
    if(facts.servings>0){
      dose.servings=facts.servings;
      dose.perServing=nut.map(v=>v==null?null:v/facts.servings);
      if(facts.powderGrams!=null)dose.powderPerServing=facts.powderGrams/facts.servings;
    }else{
      dose.intakeSnapshot=nut;
      if(facts.powderGrams!=null)dose.powderTotal=facts.powderGrams;
    }
    delete dose.mealId;
  }
  state.meals=state.meals.filter(m=>m.id!==id);
}
function preserveMealProtein(state,dose){
  if(!dose?.mealId)return;
  const meal=state.meals.find(m=>m.id===dose.mealId);
  if(!meal)return;
  const {servings,powderGrams,proteinGrams}=proteinIntake(meal,dose);
  meal.productKind||="protein_mix";
  meal.proteinDetails={...meal.proteinDetails};
  if(servings!=null)meal.proteinDetails.servings=servings;
  if(powderGrams!=null)meal.proteinDetails.powderGrams=powderGrams;
  if(meal.productKind==="protein_mix"&&proteinGrams!=null)meal.proteinDetails.proteinGrams=proteinGrams;
}
function foodByDate(state){
  const days=new Map();
  function append(day,key,row){
    if(!days.has(day))days.set(day,{meals:[],supps:[]});
    days.get(day)[key].push(row);
  }
  (state.meals||[]).forEach((m,i)=>append(m.date.slice(0,10),"meals",m.id?m:{...m,id:"legacy-"+i+"-"+m.date}));
  (state.supps||[]).forEach((entry,sourceIndex)=>append(entry.date.slice(0,10),"supps",{...entry,sourceIndex}));
  return days;
}
function nutritionForDay(state,day){
  const rows=foodByDate(state).get(day);
  return dayIntake(rows?.meals||[],rows?.supps||[]);
}
function dailyWeights(state,scale,preferred){
  const days=new Map();
  for(const row of [...(scale||[]),...(state.weights||[])]){
    if(typeof row?.date!=="string")continue;
    const instant=energyLogic.diaryInstant(row.date),ms=instant.getTime();
    if(!Number.isFinite(ms)||!energyLogic.validBodyWeight(row.kg))continue;
    const day=energyLogic.diaryTime(instant).slice(0,10),old=days.get(day);
    if(energyLogic.preferMeasurement(row,ms,old,old?.ms,preferred))days.set(day,{...row,day,ms});
  }
  const sorted=[...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
  const firstConfirmed=sorted.find(row=>row.timeBasis!=="legacy")?.day;
  return sorted.filter(row=>row.timeBasis!=="legacy"||!firstConfirmed||row.day<firstConfirmed);
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
function trainingStatus(day,today,recorded,inProgress){
  if(day>today)return "По плану";
  if(recorded)return "Тренировка";
  if(inProgress)return "В процессе";
  return day<today?"Отдых":"Тренировки пока нет";
}
function diaryReport(state,scale,entity,anchor,period,today=energyLogic.diaryTime().slice(0,10)){
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
    const interval=energyLogic.workoutInterval(w);
    if(!Number.isFinite(interval.start.getTime()))continue;
    const day=energyLogic.diaryTime(interval.start).slice(0,10);if(day>end)continue;
    const d=entry(day);d.workouts++;
    if(interval.minutes>0){
      const finishDay=energyLogic.diaryTime(interval.end).slice(0,10);
      let from=interval.start;
      for(let partDay=day;partDay<=finishDay&&partDay<=end&&from<interval.end;partDay=shiftDay(partDay,1)){
        const until=partDay===finishDay?interval.end:energyLogic.diaryInstant(shiftDay(partDay,1)+"T00:00");
        const minutes=(until-from)/60000;
        if(minutes>0){
          const part=entry(partDay);
          part.minutes+=minutes;part.sessions.push({workout:w,fraction:minutes/interval.minutes});
        }
        from=until;
      }
    }else d.sessions.push({workout:w,fraction:1}); // Legacy visit with unknown duration.
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
  for(const marker of Object.values(state.workoutDrafts||{})){
    const day=marker?.date?.slice(0,10);
    if(day&&day<=end)entry(day).inProgress=true;
  }
  // Earlier versions have no persisted start date until the next write.
  let origin=state.diaryStartedOn;
  for(const day of days.keys())if(!origin||day<origin)origin=day;
  for(const w of state.weights||[]){
    const instant=energyLogic.diaryInstant(w.date);
    if(Number.isFinite(instant.getTime())){
      const day=energyLogic.diaryTime(instant).slice(0,10);
      if(!origin||day<origin)origin=day;
    }
  }
  // A daily report also shows the current week's counters. Earlier empty weeks only
  // contribute rest points, so count their otherwise unrepresented days in bulk.
  const weekStart=monday(anchor);
  for(let day=weekStart;day<=end;day=shiftDay(day,1))entry(day);
  for(let day=start;day<=end;day=shiftDay(day,1))entry(day);
  const sorted=[...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
  const rules=Object.entries(state.energyRules||{}).sort(([a],[b])=>a.localeCompare(b));
  const weightRows=dailyWeights(state,scale,entity).filter(w=>w.day<=end);
  let wi=0,ri=0,weight=null,rule=null,points=0;
  const cutoff=end<today?shiftDay(end,1):end;
  if(origin&&origin<cutoff){
    const daysSinceStart=(Date.parse(cutoff+"T00:00Z")-Date.parse(origin+"T00:00Z"))/86400000;
    const represented=sorted.filter(d=>d.day>=origin&&d.day<cutoff).length;
    points=2*(daysSinceStart-represented);
  }
  const weeks=new Map();
  const achievements=new Map();
  function award(d,label,value){d.awards.push({label,value});d.points+=value;points+=value}
  function unlock(d,label,value){if(!achievements.has(label)){achievements.set(label,d.day);award(d,label,value)}}
  let loggedTrainingDays=0,loggedFoodDays=0,lastFoodDay=null;
  const foodStreak={current:0,longest:0};
  for(const d of sorted){
    while(wi<weightRows.length&&weightRows[wi].day<=d.day)weight=weightRows[wi++];
    while(ri<rules.length&&rules[ri][0]<=d.day)rule=rules[ri++][1];
    d.trainingStatus=trainingStatus(d.day,today,d.sessions.length,d.inProgress);
    d.partialCalories=d.unknown>0;
    const usableRule=autoEnergyRule(state.profile,rule);
    const kg=weight?.kg||d.sessions.map(s=>energyLogic.workoutWeightAtStart(s.workout,state,scale,entity)).find(Boolean);
    d.balance=null;d.base=maintenance(usableRule,d.day,kg);d.maintenance=d.base;
    d.active=null;d.energyMode=usableRule.mode;
    if(usableRule.mode==="auto"&&d.base!=null){
      let extra=0;
      for(const {workout:w,fraction} of d.sessions){
        const bodyKg=energyLogic.workoutWeightAtStart(w,state,scale,entity);
        const session=energyLogic.workoutEnergy(w,bodyKg);
        if(session.gross==null){extra=null;break}
        extra+=fraction*Math.max(0,session.gross-d.base*session.minutes/1440);
      }
      d.active=extra==null?null:Math.round(extra);
      d.maintenance=d.active==null?null:d.base+d.active;
    }
    if(d.meals>d.unknown&&d.maintenance!=null)d.balance=Math.round(d.kcal)-d.maintenance;
    const key=monday(d.day);
    const week=weeks.get(key)||{food:0,gym:0,activity:0,joint:false,repeat:false,moves:new Set()};
    weeks.set(key,week);
    if(d.meals){
      week.food++;loggedFoodDays++;
      foodStreak.current=lastFoodDay===shiftDay(d.day,-1)?foodStreak.current+1:1;
      foodStreak.longest=Math.max(foodStreak.longest,foodStreak.current);lastFoodDay=d.day;
      award(d,"Питание записано",5);
      if(loggedFoodDays===30)unlock(d,"30 дней дневника питания",15);
      if(loggedFoodDays===100)unlock(d,"100 дней дневника питания",30);
    }
    if(d.workouts){week.gym++;week.activity++;loggedTrainingDays++;if(loggedTrainingDays===10)unlock(d,"10 дней тренировок",15);if(loggedTrainingDays===50)unlock(d,"50 дней тренировок",30);award(d,"Тренировка записана",8);unlock(d,"Первая тренировка",5)}
    else if(d.sessions.length){week.activity++}
    else if(d.trainingStatus==="Отдых"&&origin&&d.day>=origin){week.activity++;award(d,"День отдыха",2)}
    if(!week.repeat&&[...d.exercises.keys()].some(name=>week.moves.has(name))){
      week.repeat=true;award(d,"Упражнение записано в два разных дня недели",5);unlock(d,"Есть с чем сравнить",5);
    }
    for(const name of d.exercises.keys())week.moves.add(name);
    if(d.meals&&week.food===7){award(d,"Семь дней питания",15);unlock(d,"Первая полная неделя питания",5)}
    if(!week.joint&&week.food===7&&(week.gym>=2||week.gym>=1&&week.activity===7)){
      week.joint=true;award(d,"Полная неделя питания, тренировок и отдыха",20);unlock(d,"Неделя целиком",5);
    }
  }
  if(lastFoodDay!==end&&(end!==today||lastFoodDay!==shiftDay(end,-1)))foodStreak.current=0;
  const rows=sorted.filter(d=>d.day>=start),weights=weightRows.filter(w=>w.day>=start);
  const sum=key=>rows.reduce((n,d)=>n+d[key],0);
  const balances=rows.filter(d=>d.balance!=null);
  const partialBalances=balances.filter(d=>d.partialCalories),knownBalances=balances.filter(d=>!d.partialCalories);
  const exerciseNames=[...new Set(rows.flatMap(d=>[...d.exercises.keys()]))].sort((a,b)=>a.localeCompare(b,"ru"));
  const nutrition=emptyIntake(),doses=emptyDoseTotals();
  for(const row of rows)if(row.nutrition){
    mergeIntake(nutrition,row.nutrition);
    for(const field of Object.keys(doses))doses[field]+=row.nutrition.doses[field];
  }
  return {start,end,today,rows,weights,nutrition,doses,latest:weightRows.at(-1),exerciseNames,workouts:sum("workouts"),sets:sum("sets"),reps:sum("reps"),volume:sum("volume"),
    minutes:Math.round(sum("minutes")),meals:sum("meals"),kcal:Math.round(sum("kcal")),unknown:sum("unknown"),foodDays:rows.filter(d=>d.meals>0).length,
    balances,partialBalances,knownBalances,balance:balances.length?balances.reduce((n,d)=>n+d.balance,0):null,
    deficit:knownBalances.reduce((n,d)=>n+Math.max(0,-d.balance),0),surplus:knownBalances.reduce((n,d)=>n+Math.max(0,d.balance),0),
    periodPoints:sum("points"),points,foodStreak,achievements:[...achievements],week:weeks.get(monday(anchor))||{food:0,gym:0,activity:0,repeat:false,joint:false},
    elapsed:start>end?0:1+Math.round((Date.parse(end+"T12:00Z")-Date.parse(start+"T12:00Z"))/86400000)};
}
if(typeof module!=="undefined")module.exports={trainingStatus,diaryReport,reportStart,maintenance,dailyWeights,autoEnergyRule,nutritionForDay,supplementStatus,removeMealIntake,preserveMealProtein};
