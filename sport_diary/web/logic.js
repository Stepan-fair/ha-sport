const programs = [
  [["Жим ногами","жим"],["Вертикальная тяга","тяга"],["Жим от груди","жим"],["Сгибание ног","ноги"],["Горизонтальная тяга","тяга"]],
  [["Горизонтальная тяга","тяга"],["Жим ногами","жим"],["Жим лёжа","жим"],["Разгибание ног","ноги"],["Вертикальная тяга","тяга"]]
];
const guides = typeof module === "undefined" ? exerciseCatalog : require("./catalog.json");
const starterEquipment = [...new Set(programs.flat().map(([name])=>name))];
function noteKey(name){
 return "exercise:" + name.normalize("NFC").trim().replace(/\s+/g," ").toLocaleLowerCase("ru");
}
function measurementAt(s,date,scale=[]){
 const until=Date.parse(date);
 let best=null,bestTime=-Infinity;
 for(const w of [...scale,...s.weights]){
   const at=Date.parse(w.date);
   const eligible=at>bestTime||at===bestTime&&(w.source==="manual"||best?.source!=="manual");
   if(Number.isFinite(at)&&at<=until&&eligible&&Number.isFinite(w.kg)&&w.kg>0&&w.kg<700){
     best=w;bestTime=at;
   }
 }
 return best;
}
function atTime(s,date,scale=[]){return measurementAt(s,date,scale)?.kg}
function plan(s,date){
 const past=s.workouts.filter(w=>Date.parse(w.date)<Date.parse(date)).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
 const p=s.profile, day=new Date(date).getDay();
 const strengthDays=past.filter(w=>w.exercises.some(e=>e.sets.some(t=>t.done)));
 const cycle=p.fixed?Number((p.legDays||[2]).includes(day)?0:1):strengthDays.length%2;
 let list=programs[cycle].map(x=>x[0]).filter(n=>p.equipment.includes(n));
 if(p.focus) list.sort((a,b)=>Number(b.toLowerCase().includes(p.focus.toLowerCase()))-Number(a.toLowerCase().includes(p.focus.toLowerCase())));
 if(cycle===0) list.sort((a,b)=>Number(/ног/i.test(b))-Number(/ног/i.test(a)));
 const count=Math.max(1,Math.min(5, Math.floor(p.minutes/10)+([p.goal,...(p.extra||[])].includes("Набор мышц")?1:0)));
 // Fill missing movements from the member's actual equipment, favouring different muscle groups.
 const remaining=[...new Set(p.equipment)].filter(n=>!list.includes(n));
 while(list.length<count && remaining.length){
   const coverage=n=>list.filter(x=>guides[x]?.group===guides[n]?.group).length;
   remaining.sort((a,b)=>coverage(a)-coverage(b));
   list.push(remaining.shift());
 }
 if(strengthDays.length && count>=3 && list.length>=count){
   const slot=count-1,group=guides[list[slot]]?.group;
   const options=p.equipment.filter(n=>guides[n]?.group===group&&!list.slice(0,slot).includes(n));
   // Keep the main lifts comparable and vary the last accessory within the same group.
   const lastDone=name=>strengthDays.find(w=>w.exercises.some(e=>e.name===name&&e.sets.some(t=>t.done)))?.date||"";
   if(options.length>1)list[slot]=options.sort((a,b)=>lastDone(a).localeCompare(lastDone(b)))[0];
 }
 return list.slice(0,count).map(name=>exerciseFor(name,p,past,date));
}
function exerciseFor(name,p,past,date){
   const prev=past.map(w=>w.exercises.find(e=>e.name===name&&e.sets.some(t=>t.done))).find(Boolean);
   const completed=prev?.sets.filter(t=>t.done)||[];
   const target=p.goal==="Сила"?8:p.goal==="Выносливость"?15:12;
   const targetSets=p.minutes<=35?2:3;
   const increase=prev && completed.length>=Math.max(targetSets,prev.plannedSets||0) && completed.length===prev.sets.length && completed.every(t=>t.reps>=target&&t.easy&&t.kg>0) && Date.parse(date)-Date.parse(past.find(w=>w.exercises.includes(prev)).date)<14*86400000;
   const step=p.exerciseSteps?.[noteKey(name)]??p.step;
   const sets=Array.from({length:targetSets},(_,i)=>{
     const last=completed[Math.min(i,completed.length-1)];
     const kg=last?.kg||0;
     return {kg:kg+(increase&&step>0&&step<=kg*.1?step:0),reps:target,done:false,easy:false};
   });
   return {name,sets,plannedSets:targetSets,previous:completed.map(t=>t.kg+" × "+t.reps).join(", ")};
}
function total(w){
 const sets=w.exercises.flatMap(e=>e.sets).filter(t=>t.done);
 const minutes=(Date.parse(w.end)-Date.parse(w.date))/60000;
 const cardio=w.cardio.reduce((n,c)=>n+c.seconds/60,0);
 const strength=Math.max(0,minutes-cardio);
 const weight=w.kg;
 const consoleEntries=w.cardio.filter(c=>c.kcal!=null&&c.kcal!=="");
 const consoleKcal=consoleEntries.reduce((sum,c)=>sum+Number(c.kcal),0);
 const complete=!!weight||(!sets.length&&consoleEntries.length===w.cardio.length&&w.cardio.length>0);
 const estimated=weight?Math.round((sets.length?strength*2.5*weight/60:0)+w.cardio.reduce((n,c)=>n+(c.kcal??(c.seconds/3600*weight*3)),0)):complete?consoleKcal:null;
 return {sets:sets.length,volume:sets.reduce((n,t)=>n+t.kg*t.reps,0),minutes:Math.round(minutes),estimated,consoleKcal,consoleCount:consoleEntries.length,points:10+Math.min(10,sets.length)};
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
function trainingSlot(state,draft,day){
 const actual=state.workouts.filter(w=>w.date.slice(0,10)===day).sort((a,b)=>a.date.localeCompare(b.date))[0];
 const session=actual||(draft?.date.slice(0,10)===day?draft:null);
 if(session){const h=Number(session.date.slice(11,13));return h<12?"Утром":h<18?"Днём":"Вечером"}
 const dow=new Date(day+"T12:00").getDay();
 return state.dayPlans?.[day]||state.profile?.week?.[dow]||({0:"Днём",2:"Вечером"}[dow]||"Отдых");
}
function schedule(name,slot){
 const label=canonicalSupp(name), item=supplements[label];
 if(!Object.hasOwn(supplements,label))return ["По своей схеме","Время из твоей личной схемы."];
 if(label==="Креатин"&&slot!=="Отдых")return [({"Утром":"Утро","Днём":"День","Вечером":"Вечер"})[slot],"Можно перед залом для удобства. Важнее регулярность приёма."];
 if(label==="Протеин"&&slot!=="Отдых")return [({"Утром":"Утро","Днём":"День","Вечером":"Вечер"})[slot],"После зала, если белковой еды не хватает. Можно с другим приёмом пищи."];
 return [item[2],item[3]];
}
if(typeof module!=="undefined") module.exports={plan,atTime,measurementAt,total,canonicalSupp,schedule,trainingSlot};
