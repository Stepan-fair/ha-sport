let diaryZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
const diaryClocks=new Map();
function setDiaryZone(zone){
  if(!zone)return;
  try{new Intl.DateTimeFormat("en",{timeZone:zone});diaryZone=zone}catch{/* Older clients keep their system zone. */}
}
function diaryTime(instant=new Date(),zone=diaryZone){
  if(!diaryClocks.has(zone))diaryClocks.set(zone,new Intl.DateTimeFormat("sv-SE",{
    timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}));
  return diaryClocks.get(zone).format(instant).replace(" ","T");
}
function diaryInstant(value,zone=diaryZone){
  if(typeof value!=="string"||/[zZ]$|[+-]\d\d:?\d\d$/.test(value))return new Date(value);
  const wall=value.length===10?value+"T00:00":value;
  const target=Date.parse(wall+"Z");
  if(!Number.isFinite(target))return new Date(NaN);
  let instant=new Date(target);
  for(let i=0;i<3;i++){
    const formatted=diaryTime(instant,zone);
    if(formatted===wall.slice(0,16))return instant;
    instant=new Date(instant.getTime()+Date.parse(wall.slice(0,16)+"Z")-Date.parse(formatted+"Z"));
  }
  return new Date(NaN);
}
const programs = [
  ["Жим ногами под 45°","Вертикальная тяга на верхнем блоке","Жим от груди горизонтальный в тренажёре","Сгибание ног сидя","Горизонтальная тяга на нижнем блоке"],
  ["Горизонтальная тяга на нижнем блоке","Жим ногами горизонтальный","Жим лёжа","Разгибание ног","Вертикальная тяга на верхнем блоке"]
];
const guides = typeof module === "undefined" ? exerciseCatalog : require("./catalog.json");
const starterEquipment = [...new Set(programs.flat())];
function movementKey(name){return guides[name]?.family||name}
function exerciseLabel(name){return guides[name]?.legacy?name+" · тренажёр не указан":name}
function newEntryId(){
  if(typeof crypto.randomUUID==="function")return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&0x0f)|0x40;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}
function noteKey(name){
 return "exercise:" + name.normalize("NFC").trim().replace(/\s+/g," ").toLocaleLowerCase("ru");
}
const periods=["Утро","День","Вечер","Ночь"];
const trainingSlots={"Утром":"Утро","Днём":"День","Вечером":"Вечер","Ночью":"Ночь"};
const periodStart={"Ночь":"00:00","Утро":"06:00","День":"12:00","Вечер":"18:00"};
function period(date){
 const hour=Number(date.slice(11,13));
 return hour<6?"Ночь":hour<12?"Утро":hour<18?"День":"Вечер";
}
function doseEntry(name,day,slot,clock,now){
 if(!periods.includes(slot))throw Error("Выбери время суток для «"+name+"».");
 if(clock&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)||period(day+"T"+clock)!==slot)){
   throw Error("Время для «"+name+"» должно попадать в период «"+slot+"». Можно оставить только период.");
 }
 if(now&&day+"T"+(clock||periodStart[slot])>now)throw Error("Приём «"+name+"» ещё в будущем. Проверь день и период.");
 return {date:clock?day+"T"+clock:day,period:slot,names:[name]};
}
function validBodyWeight(kg){return Number.isFinite(kg)&&kg>0&&kg<700}
function preferMeasurement(row,time,best,bestTime,entity){
 if(!best)return true;
 // 0.6.0 stored attribute-update times. They only provide a fallback until
 // a reading with a known measurement time exists.
 if((row.timeBasis==="legacy")!==(best.timeBasis==="legacy"))return row.timeBasis!=="legacy";
 const priority=w=>entity&&w.source==="ha"&&w.entity===entity?2:w.source==="manual"?1:0;
 return time>bestTime||time===bestTime&&priority(row)>=priority(best);
}
function measurementAt(s,date,scale=[],preferredEntity=""){
 const until=diaryInstant(date).getTime();
 let best=null,bestTime=-Infinity;
 for(const w of [...(scale||[]),...(s.weights||[])]){
   if(typeof w?.date!=="string")continue;
   const at=diaryInstant(w.date).getTime();
   if(Number.isFinite(at)&&at<=until&&validBodyWeight(w.kg)&&preferMeasurement(w,at,best,bestTime,preferredEntity)){
     best=w;bestTime=at;
   }
 }
 return best;
}
function atTime(s,date,scale=[]){return measurementAt(s,date,scale)?.kg}
function savedWorkoutWeight(w){
 const kg=Number(w.kg),start=w.startedAt||w.date,sample=w.weightSample;
 return validBodyWeight(kg)&&(!sample?.date||diaryInstant(sample.date)<=diaryInstant(start))?kg:null;
}
function workoutWeightAtStart(w,state,scale,entity){
 const saved=savedWorkoutWeight(w);
 if(saved!=null&&w.weightSample?.timeBasis!=="legacy")return saved;
 return measurementAt(state,w.startedAt||w.date,scale,entity)?.kg??saved;
}
function workoutInterval(w){
 const start=diaryInstant(w.startedAt||w.date),end=diaryInstant(w.endedAt||w.end);
 return {start,end,minutes:(end-start)/60000};
}
function completedBefore(workouts,date){
 const at=Date.parse(date);
 return workouts.filter(w=>!w.cancelled&&!w.canceled&&!["cancelled","canceled","aborted"].includes(w.status)&&Date.parse(w.endedAt||w.end||w.date)<=at&&Date.parse(w.date)<at)
   .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
}
function workingExercises(w){
 return (w.exercises||[]).filter(e=>e.sets.some(t=>t.done&&!t.warmup&&t.reps>0));
}
const focusGroups={"ног":"Ноги","тяга":"Спина","Жим":"Грудь"};
function priorityGroup(p){return focusGroups[p.focus]||p.focus||""}
function trainingCycle(p,past,date){
 if(p.fixed)return (p.legDays||[2]).includes(new Date(date).getDay())?0:1;
 const legs=p.equipment.some(n=>guides[n]?.group==="Ноги"),upper=p.equipment.some(n=>guides[n]?.group&&guides[n].group!=="Ноги");
 let next=0;
 for(const workout of [...past].reverse()){
   const done=workingExercises(workout);
   if(!done.length)continue;
   if(next===0&&legs&&!done.some(e=>guides[e.name]?.group==="Ноги"))continue;
   if(next===1&&upper&&done.every(e=>guides[e.name]?.group==="Ноги"))continue;
   next=1-next;
 }
 return next;
}
function compoundLift(name){
 return ["leg-press","row","pulldown","chest-press"].includes(movementKey(name))||["Жим лёжа","Жим гантелей на скамье","Присед с гантелью у груди"].includes(name);
}
function strengthBlock(e,index){
 const working=e.sets.filter(t=>!t.warmup),explicit=e.sets.length-working.length;
 const compound=compoundLift(e.name),plates=e.name==="Жим ногами под 45°"||/штанг|Жим лёжа/i.test(e.name);
 const setup=plates?4:3,restSeconds=e.restSeconds??(plates?150:compound?120:90);
 if(!e.sets.length)return {minutes:0,ramp:0,working:0,restSeconds};
 const ramp=explicit||(working.length?(index===0?2:compound?1:0):0);
 const performance=working.reduce((sum,t)=>sum+Math.min(40,Math.max(1,Number(t.reps)||10))*0.08,0);
 return {minutes:Math.ceil(setup+ramp*2+performance+Math.max(0,working.length-1)*restSeconds/60),ramp,working:working.length,restSeconds};
}
function transitionMinutes(count){return count?4+Math.ceil((count-1)*1.5):0}
function workoutPace(past,equipment){
 const available=new Set(equipment.map(movementKey)),ratios=[];
 for(const w of past){
   const elapsed=(Date.parse(w.endedAt||w.end)-Date.parse(w.startedAt||w.date))/60000;
   const done=workingExercises(w).map(e=>({...e,sets:e.sets.filter(t=>t.done&&t.reps>0)}));
   if(!(elapsed>=15&&elapsed<=240)||done.length<2||!done.some(e=>available.has(movementKey(e.name))))continue;
   const cardio=(w.cardio||[]).reduce((sum,c)=>sum+(Number(c.seconds)>0?Number(c.seconds)/60:NaN),0);
   const base=done.reduce((sum,e,i)=>sum+strengthBlock(e,i).minutes,0);
   const ratio=(elapsed-cardio-transitionMinutes(done.length))/base;
   if(!(ratio>=0.5&&ratio<=2.5))continue;
   ratios.push(ratio);
   if(ratios.length===5)break;
 }
 if(ratios.length<2)return {pace:1,samples:0};
 ratios.sort((a,b)=>a-b);
 const middle=(ratios.length-1)/2;
 const median=(ratios[Math.floor(middle)]+ratios[Math.ceil(middle)])/2;
 // End-to-end observations include unmeasured waiting; blend a small sample with the initial estimate.
 const weight=ratios.length/(ratios.length+3);
 return {pace:1+(Math.max(0.5,Math.min(2,median))-1)*weight,samples:ratios.length};
}
function estimateWorkout(exercises,timing){
 let station=0;
 const blocks=exercises.map(e=>strengthBlock(e,e.sets.length?station++:station));
 const cardio=timing.cardio.reduce((sum,c)=>sum+c.minutes,0);
 const duration=indices=>{
   const active=indices.filter(i=>blocks[i].minutes>0);
   return cardio+transitionMinutes(active.length)+Math.round(active.reduce((sum,i,j)=>sum+strengthBlock(exercises[i],j).minutes,0)*timing.pace);
 };
 const all=exercises.map((_,i)=>i),mandatory=all.filter(i=>!exercises[i].optional);
 const optional=all.filter(i=>exercises[i].optional);
 const total=duration(all);
 // Keep manual additions and the lead lift; the last automatic accessory can be skipped.
 for(let j=mandatory.length-1;j>0&&duration(mandatory)>timing.budget;j--){
   const i=mandatory[j];
   if(exercises[i].manual)continue;
   optional.push(i);mandatory.splice(j,1);
 }
 const transitions=transitionMinutes(blocks.filter(b=>b.minutes).length);
 const adjustment=total-cardio-transitions-blocks.reduce((sum,b)=>sum+b.minutes,0);
 return {blocks,total,transitions,adjustment,optional,required:duration(mandatory)};
}
function buildWorkoutPlan(s,date){
 const past=completedBefore(s.workouts,date),p=s.profile;
 const strengthDays=past.filter(w=>workingExercises(w).length);
 const cycle=trainingCycle(p,past,date);
 const available=[...new Set(p.equipment)].filter(n=>!guides[n]?.legacy||
   !p.equipment.some(other=>!guides[other]?.legacy&&movementKey(other)===movementKey(n)));
 let list=programs[cycle].map(name=>available.includes(name)?name:
   available.find(n=>movementKey(n)===movementKey(name))).filter(Boolean);
 const group=priorityGroup(p);
 const goals=new Set([p.goal,...(p.extra||[])]);
 const budget=Number(p.minutes)||45;
 const timing={budget,...workoutPace(past,p.equipment),cardio:[
   {activity:"Дорожка",minutes:budget>=40?15:budget>=20?4:3},
   {activity:"Спокойная ходьба",minutes:budget>=35?5:3}
 ]};
 const priority=available.filter(n=>group&&guides[n]?.group===group);
 if(priority.length&&!list.some(n=>guides[n]?.group===group))list.unshift(priority[0]);
 // The main lift leads the leg session. The chosen focus leads the other session.
 const upperLead=list.find(n=>guides[n]?.group&&guides[n].group!=="Ноги");
 const lead=cycle===0&&list.some(n=>guides[n]?.group==="Ноги")?"Ноги":group||guides[upperLead]?.group;
 if(lead){
   let i=list.findIndex(n=>guides[n]?.group===lead);
   if(i>0)list.unshift(list.splice(i,1)[0]);
   if(group&&group!==lead){
     i=list.findIndex(n=>guides[n]?.group===group);
     if(i>1)list.splice(1,0,list.splice(i,1)[0]);
   }
 }
 // Fill missing movements from the member's actual equipment, favouring different muscle groups.
 while(list.length<6){
   const remaining=available.filter(n=>!list.some(chosen=>movementKey(chosen)===movementKey(n)));
   if(!remaining.length)break;
   const coverage=n=>list.filter(x=>guides[x]?.group===guides[n]?.group).length;
   remaining.sort((a,b)=>coverage(a)-coverage(b));
   list.push(remaining[0]);
 }
 if(goals.has("Сила")){
   const first=list.shift();
   list.sort((a,b)=>Number(compoundLift(b))-Number(compoundLift(a)));
   if(first)list.unshift(first);
 }
 const exercises=[];
 for(const name of list){
   const next=exerciseFor(name,p,past,date);
   if(estimateWorkout([...exercises,next],timing).total>budget){
     timing.reserve=name;break;
   }
   exercises.push(next);
 }
 if(strengthDays.length&&exercises.length>=3){
   const slot=exercises.length-1,group=guides[exercises[slot].name]?.group;
   const others=exercises.slice(0,slot),used=new Set(others.map(e=>movementKey(e.name)));
   const lastDone=name=>strengthDays.find(w=>workingExercises(w).some(e=>e.name===name))?.date||"";
   const options=available.filter(n=>guides[n]?.group===group&&!used.has(movementKey(n))&&n!==timing.reserve);
   options.sort((a,b)=>lastDone(a).localeCompare(lastDone(b)));
   for(const name of options){
     const next=exerciseFor(name,p,past,date);
     if(estimateWorkout([...others,next],timing).total<=budget){exercises[slot]=next;break}
   }
 }
 return {exercises,timing};
}
function plan(s,date){return buildWorkoutPlan(s,date).exercises}
const loadUnits=["Как в прежних записях","Весь вес","Одна гантель","Только блины","Шкала тренажёра"];
function exerciseResultName(e){return e.loadUnit?e.name+" · "+e.loadUnit:e.name}
function exerciseHistory(name,past,unit){
 const records=[];
 for(const w of past){
   const entries=(w.exercises||[]).filter(e=>e.name===name&&(e.loadUnit||"")===unit);
   if(!entries.length)continue;
   const sets=entries.flatMap(e=>e.sets.filter(t=>!t.warmup));
   const planned=entries.reduce((n,e)=>n+(e.plannedSets||e.sets.filter(t=>!t.warmup).length),0);
   records.push({date:w.date,sets,planned});
 }
 return records;
}
function qualifyingWeight(record,required){
 if(!record)return 0;
 const sets=record.sets,kg=sets[0]?.kg;
 if(sets.length<Math.max(3,required,record.planned)||sets.length>4||!(kg>0))return 0;
 return sets.every(t=>t.done&&t.reps>=12&&t.easy&&t.kg===kg)?kg:0;
}
function exerciseFor(name,p,past,date){
 const loadUnit=p.loadUnits?.[noteKey(name)]||"";
 const records=exerciseHistory(name,past,loadUnit);
 const previous=records.find(r=>r.sets.some(t=>t.done));
 const completed=previous?.sets.filter(t=>t.done)||[];
 const targetSets=Number(p.workingSets)||(p.returning||p.minutes<=35?2:completed.length===4?4:3);
 const initial=p.goal==="Сила"?8:p.goal==="Выносливость"||(p.extra||[]).includes("Выносливость")?12:10;
 const latest=records[0],earlier=records[1],kg=qualifyingWeight(latest,targetSets);
 const dayGap=(a,b)=>(Date.parse(a)-Date.parse(b))/86400000;
 const pair=kg>0&&kg===qualifyingWeight(earlier,targetSets)&&latest.date.slice(0,10)!==earlier.date.slice(0,10)
   &&dayGap(date,latest.date)<14&&dayGap(latest.date,earlier.date)<14;
 const step=Number(p.exerciseSteps?.[noteKey(name)]??p.step);
 const increase=pair&&!p.returning&&step>0&&step<=kg*0.1;
 const sets=Array.from({length:targetSets},(_,i)=>{
   const last=completed[Math.min(i,completed.length-1)];
   const reps=increase?10:last?Math.min(12,Math.max(1,last.reps+(last.easy?1:0))):initial;
   return {kg:increase?Math.round((kg+step)*1000)/1000:last?.kg||0,reps,done:false,easy:false};
 });
 let advice="Подбери комфортный рабочий вес и запиши результат.";
 if(previous){
   if(increase)advice="Две тренировки по 12 с запасом. Предложен следующий шаг веса и 10 повторов.";
   else if(p.returning)advice="Режим возвращения: вес можно уменьшить, автоматическая прибавка отключена.";
   else if(pair)advice="Критерий выполнен. Для прибавки нужен доступный шаг до 10% рабочего веса.";
   else if(completed.length<previous.planned||previous.sets.some(t=>!t.done))advice="В прошлый раз часть рабочих подходов осталась незавершённой. Можно снизить вес и повторить план в комфортном объёме.";
   else if(kg)advice="Все рабочие подходы по 12 с запасом. Для прибавки повтори результат ещё раз.";
   else advice="Сохраняй комфортный вес. Для прибавки нужны 3–4 полных рабочих подхода по 12 с запасом в двух занятиях подряд.";
 }
 const prescription=sets.map(t=>({kg:t.kg,reps:t.reps}));
 return {name,sets,loadUnit,plannedSets:targetSets,prescription,advice,previous:completed.map(t=>t.kg+" × "+t.reps).join(", ")};
}
function treadmillMet(c){
 const measuredSpeed=Number(c.speed);
 const speed=measuredSpeed>0?measuredSpeed:Number(c.distance)/Number(c.seconds)*3.6;
 if(!(speed>0&&speed<=30))return 3;
 const grade=Math.max(0,Math.min(Number(c.incline)||0,30))/100;
 const walking=kmh=>1+kmh*1000/60*(0.1+1.8*grade)/3.5;
 const running=kmh=>1+kmh*1000/60*(0.2+0.9*grade)/3.5;
 if(speed<=6)return walking(speed);
 if(speed>=8.1)return running(speed);
 // Gait is unknown between brisk walking and running. Interpolate the endpoints.
 return walking(6)+(speed-6)/2.1*(running(8.1)-walking(6));
}
function workoutEnergy(w,bodyKg){
 const saved=savedWorkoutWeight(w);
 const kg=Number(w.weightSample?.timeBasis==="legacy"?bodyKg??saved:saved??bodyKg);
 const duration=workoutInterval(w).minutes;
 const cardio=w.cardio||[],done=(w.exercises||[]).some(e=>(e.sets||[]).some(t=>t.done&&Number(t.reps)>0));
 const treadmillMinutes=cardio.reduce((sum,c)=>sum+Number(c.seconds)/60,0);
 if(!(duration>0)||!Number.isFinite(treadmillMinutes)||treadmillMinutes>duration||cardio.some(c=>!(Number(c.seconds)>0)))return {gross:null,minutes:0};
 const strength=done?duration-treadmillMinutes:0;
 const minutes=strength+treadmillMinutes;
 if(!minutes||(!(kg>0)&&strength>0))return {gross:null,minutes};
 const kcalPerMetMinute=3.5*kg/200;
 let gross=strength>0?3.5*kcalPerMetMinute*strength:0;
 for(const c of cardio){
   if(c.kcal!=null&&c.kcal!==""&&Number.isFinite(Number(c.kcal))&&Number(c.kcal)>=0)gross+=Number(c.kcal);
   else if(kg>0&&(!c.activity||["Дорожка","Спокойная ходьба"].includes(c.activity)))gross+=treadmillMet(c)*kcalPerMetMinute*Number(c.seconds)/60;
   else return {gross:null,minutes};
 }
 return {gross,minutes};
}
function total(w,bodyKg){
 const sets=(w.exercises||[]).flatMap(e=>e.sets||[]).filter(t=>t.done);
 const minutes=workoutInterval(w).minutes;
 const consoleEntries=(w.cardio||[]).filter(c=>c.kcal!=null&&c.kcal!=="");
 const consoleKcal=consoleEntries.reduce((sum,c)=>sum+Number(c.kcal),0);
 const energy=workoutEnergy(w,bodyKg);
 return {sets:sets.length,volume:sets.reduce((n,t)=>n+t.kg*t.reps,0),minutes:Math.round(minutes),
   estimated:energy.gross==null?null:Math.round(energy.gross),consoleKcal,consoleCount:consoleEntries.length,points:10+Math.min(10,sets.length)};
}

const supplements = {
 "Омега-3": ["Омега-3", "Источник ЭПК и ДГК.", "Утро", "С завтраком или другим приёмом пищи."],
 "Витамин D3": ["Витамин D3", "Витамин D участвует в обмене кальция.", "Утро", "С едой, содержащей немного жира. Завтрак — удобный вариант."],
 "Креатин": ["Моногидрат креатина", "Для повторных коротких интенсивных усилий.", "Утро", "Удобно с завтраком, в том числе в день отдыха."],
 "Магний": ["Магний", "Источник магния.", "Вечер", "С ужином по схеме из вашего дневника."],
 "Протеин": ["Белковая смесь", "Способ добрать белок, когда его мало в еде.", "День", "По необходимости между приёмами пищи."],
 "Железо": ["Железо", "Препарат железа. Доза и дни определяются назначением.", "По назначению", "Ручная отметка по назначенной схеме."]
};
function canonicalSupp(name){
 const rules=[[/омег|omega/i,"Омега-3"],[/витамин\s*[дd]\s*3?|^d3$/i,"Витамин D3"],[/креатин|creatine/i,"Креатин"],[/магний|magnesium/i,"Магний"],[/протеин|protein/i,"Протеин"],[/железо/i,"Железо"]];
 return rules.find(([re])=>re.test(name))?.[1]||name;
}
function recordedDose(name,servings,powder=30,mealId=""){
 const kind=canonicalSupp(name);
 if(kind!=="Креатин"&&kind!=="Протеин")return {};
 if(!Number.isFinite(servings)||servings<=0)throw Error("Укажи положительное число принятых порций за день.");
 if(kind==="Креатин")return {servings,creatinePerServing:3};
 const facts={servings,perServing:[null,22,null,null]};
 if(powder!=null){
   if(!Number.isFinite(powder)||powder<=0)throw Error("Проверь массу порошка на одно саше.");
   facts.powderPerServing=powder;
 }
 if(mealId)facts.mealId=mealId;
 return facts;
}
function replaceRecordedDose(entries,index,name,replacement){
 const old=entries[index],kind=canonicalSupp(name);
 if(!old||!old.names.some(n=>canonicalSupp(n)===kind))throw Error("Отметка уже изменилась. Обнови страницу.");
 const names=old.names.filter(n=>canonicalSupp(n)!==kind);
 const rest=names.length?[{...old,names}]:[];
 if(rest.length&&kind==="Протеин")for(const key of ["mealId","powderPerServing","perServing","intakeSnapshot","powderTotal"])delete rest[0][key];
 if(replacement)rest.push(replacement);
 return [...entries.slice(0,index),...rest,...entries.slice(index+1)];
}
function rememberDosePlan(state,day){
 const plans=state.suppPlans||={};
 if(Object.hasOwn(plans,day))return;
 // Existing marks from before daily snapshots carry no evidence of the plan.
 plans[day]=(state.supps||[]).some(row=>row.date.slice(0,10)===day)?null:[...new Set((state.profile?.supps||[]).map(canonicalSupp))];
}
function addDoseEntries(state,day,entries){
 rememberDosePlan(state,day);
 const rows=state.supps||=[];
 const taken=new Set(rows.filter(row=>row.date.slice(0,10)===day).flatMap(row=>row.names.map(canonicalSupp)));
 for(const entry of entries){
   const name=canonicalSupp(entry.names[0]);
   if(!taken.has(name)){rows.push(entry);taken.add(name)}
 }
}
function trainingSlot(state,draft,day){
 const actual=state.workouts.filter(w=>w.date.slice(0,10)===day).sort((a,b)=>a.date.localeCompare(b.date))[0];
 const session=actual||(draft?.date.slice(0,10)===day?draft:null);
 if(session)return Object.keys(trainingSlots).find(slot=>trainingSlots[slot]===period(session.date));
 const dow=new Date(day+"T12:00").getDay();
 return state.dayPlans?.[day]||state.profile?.week?.[dow]||({0:"Днём",2:"Вечером"}[dow]||"Отдых");
}
function schedule(name,slot){
 const label=canonicalSupp(name), item=supplements[label];
 if(!Object.hasOwn(supplements,label))return ["По своей схеме","Время из твоей личной схемы."];
 if(label==="Креатин"&&slot!=="Отдых")return [trainingSlots[slot],"Можно перед залом для удобства. Важнее регулярность приёма."];
 if(label==="Протеин"&&slot!=="Отдых")return [trainingSlots[slot],"После зала, если белковой еды не хватает. Можно с другим приёмом пищи."];
 return [item[2],item[3]];
}
if(typeof module!=="undefined") module.exports={diaryTime,diaryInstant,setDiaryZone,exerciseResultName,workoutEnergy,workoutWeightAtStart,workoutInterval,validBodyWeight,preferMeasurement,plan,buildWorkoutPlan,estimateWorkout,atTime,measurementAt,total,canonicalSupp,schedule,trainingSlot,doseEntry,recordedDose,replaceRecordedDose,addDoseEntries};
