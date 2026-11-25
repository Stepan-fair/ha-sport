const test=require("node:test");
const assert=require("node:assert/strict");
const {plan,atTime,total,workoutEnergy}=require("./web/logic.js");
const catalogue=require("./web/catalog.json");
const {doseEntry,measurementAt}=require("./web/logic.js");
test("Дата из календаря, период из карточки и необязательное точное время",()=>{
 const day="2026-11-24",now=day+"T13:15";
 assert.deepEqual(doseEntry("А",day,"Утро","",now),{date:day,period:"Утро",names:["А"]});
 assert.equal(doseEntry("А",day,"День","12:30",now).date,day+"T12:30");
 assert.throws(()=>doseEntry("А",day,"Утро","02:53",now));
 assert.throws(()=>doseEntry("А",day,"Вечер","",now));
 assert.throws(()=>doseEntry("А",day,"День","13:16",now));
 assert.throws(()=>doseEntry("А","2026-11-25","Ночь","",now));
 assert.throws(()=>doseEntry("А",day,"По назначению","",now));
});
test("Привязанные весы имеют приоритет при совпадении времени, более свежий ручной ввод сохраняется",()=>{
 const date="2026-11-24T08:00:00Z",entity="sensor.test_weight";
 const ha={kg:71,date,source:"ha",entity},manual={kg:72,date,source:"manual"},s={weights:[manual]};
 assert.equal(measurementAt(s,date,[ha],entity),ha);
 assert.equal(measurementAt(s,date,[ha],""),manual);
 assert.equal(measurementAt(s,"2026-11-23", [ha],entity),null);
 s.weights.push({...manual,date:"2026-11-24T08:01:00Z",kg:73});
 assert.equal(measurementAt(s,"2026-11-25",[ha],entity).kg,73);
});
const {localFoods, importedFood, distinctFoods}=require("./web/foods.js");
test("Локальный поиск учитывает жирность, порядок слов, сохранённые карточки и штрихкоды",()=>{
 const lookup=q=>localFoods(q,[],[]);
 assert.deepEqual(lookup("яйца")[0].nut,[157,12.7,11.5,0.8]);
 assert.equal(lookup("4600605029312")[0].name,"Творог 5% · Простоквашино");
 assert.equal(lookup("творог").length,4);
 assert.equal(lookup("0.1% ТВОРОГ")[0].nut[0],55);
 assert.equal(lookup("кефир 5%").length,0);
 assert.equal(lookup("йогурт греческий")[0].nut[1],7);
 const packaged=lookup("творог 5")[0];
 const saved={...packaged,nut:[120,18,5,2]};
 assert.equal(distinctFoods(localFoods("ТВОРОГ 5%",[saved],[]))[0],saved);
 const remote=importedFood({code:"12345678",product_name_ru:"Молоко",nutriments:{proteins_100g:0}});
 assert.deepEqual(remote.nut,[null,0,null,null]);
 const other={...remote,code:"12345679"};
 assert.deepEqual(distinctFoods([remote,other,remote]),[remote,other]);
 assert.deepEqual(localFoods("12345678",[remote,other],[]),[remote]);
 assert.equal(importedFood({brands:"Без названия"}),null);
});
const s={profile:{goal:"Сила",equipment:["Жим ногами"],minutes:45,step:2.5},weights:[{date:"2026-11-20",kg:90},{date:"2026-11-24",kg:95}],workouts:[]};
test("Последний вес по моменту события сохраняется независимо от давности и порядка ввода",()=>{
 const scale=[{kg:94,date:"2026-01-01T10:00:00+03:00",source:"ha"},{kg:91,date:"2026-06-01T07:00:00Z",source:"ha"}];
 const state={weights:[{kg:92,date:"2026-02-01T08:00:00Z",source:"manual"},{kg:93,date:"2026-01-10T08:00:00Z",source:"manual"}]};
 assert.equal(atTime(state,"2025-12-01T00:00Z",scale),undefined);
 assert.equal(atTime(state,"2026-01-05T00:00Z",scale),94);
 assert.equal(atTime(state,"2026-05-30T00:00Z",scale),92);
 assert.equal(atTime(state,"2027-08-10T00:00Z",scale),91);
 state.weights.push({kg:90,date:"2026-06-01T10:00:00+03:00",source:"manual"});
 assert.equal(atTime(state,"2026-06-01T07:00:00Z",scale),90);
});
test("Датированная масса и отдельные интервалы кардио",()=>{
 assert.equal(atTime(s,"2026-11-22"),90);
 const t=total({date:"2026-11-22T09:00",end:"2026-11-22T10:00",kg:90,exercises:[{sets:[{done:true,kg:10,reps:10}]}],cardio:[{seconds:600,kcal:50},{seconds:600,kcal:40}]});
 assert.equal(t.estimated,311);
});
test("План опирается на завершённые подходы до выбранной даты",()=>{
 const e=plan(s,"2026-11-22")[0];
 e.sets=e.sets.map(t=>({...t,kg:50,easy:true,done:true}));
 const history={...s,workouts:[{date:"2026-11-22",exercises:[e]}]};
 assert.equal(plan(history,"2026-11-24")[0].sets[0].kg,52.5);
 assert.equal(plan(history,"2026-11-21")[0].sets[0].kg,0);
 e.sets[1].done=false;
 assert.equal(plan(history,"2026-11-24")[0].sets[0].kg,50);
});
test("Индивидуальный шаг тренажёра и индивидуальное расписание",()=>{
 const p={...s.profile,exerciseSteps:{"exercise:жим ногами":1}};
 const e=plan(s,"2026-11-20")[0];
 e.sets.forEach(t=>Object.assign(t,{kg:50,done:true,easy:true,reps:8}));
 assert.equal(plan({...s,profile:p,workouts:[{date:"2026-11-20",exercises:[e]}]},"2026-11-24")[0].sets[0].kg,51);
 const {trainingSlot}=require("./web/logic.js");
 assert.equal(trainingSlot({profile:{week:{2:"Утром"}},workouts:[]},null,"2026-11-24"),"Утром");
});
test("Расписание учитывает план, перенос, черновик и выполненную тренировку",()=>{
 const {canonicalSupp,schedule,trainingSlot}=require("./web/logic.js");
 const day="2026-11-24";
 const state={workouts:[]};
 assert.equal(trainingSlot(state,null,day),"Вечером");
 state.dayPlans={[day]:"Отдых"};
 assert.equal(trainingSlot(state,null,day),"Отдых");
 assert.equal(trainingSlot(state,{date:day+"T09:00"},day),"Утром");
 state.workouts.push({date:day+"T15:00"});
 assert.equal(trainingSlot(state,null,day),"Днём");
 assert.equal(canonicalSupp("Creatine Monohydrate"),"Креатин");
 assert.equal(schedule("Протеин","Вечером")[0],"Вечер");
 assert.equal(schedule("Протеин","Отдых")[0],"День");
 assert.equal(schedule("Железо","Утром")[0],"По назначению");
});
test("Для каждого доступного упражнения есть техника, мышцы и непустой план",()=>{
 assert.ok(catalogue["Жим ногами горизонтальный"] && catalogue["Жим ногами под 45°"]);
 for(const [name,guide] of Object.entries(catalogue)){
   for(const field of ["group","station","recognize","setup","movement","avoid","primary","secondary"])
     assert.ok(guide[field]?.trim(),name+" / "+field);
   if(guide.photo)assert.match(guide.photo,/^[a-zA-Z0-9_-]+$/);
   else assert.ok(guide.legacy || guide.reference?.startsWith("https://"),name);
   assert.deepEqual(plan({...s,profile:{...s.profile,equipment:[name]}}, "2026-11-24").map(e=>e.name),[name]);
 }
 assert.deepEqual(plan({...s,profile:{...s.profile,equipment:[]}}, "2026-11-24"),[]);
});
test("История, шаг веса и автоматический выбор разделены по варианту жима",()=>{
 const variants=["Жим ногами под 45°","Жим ногами горизонтальный","Жим ногами"];
 const exercises=variants.map((name,i)=>({name,sets:[{kg:[80,40,100][i],reps:8,done:true}]}));
 const history={date:"2026-04-02T12:00",exercises};
 for(let i=0;i<variants.length;i++){
   const state={...s,profile:{...s.profile,equipment:[variants[i]]},workouts:[history]};
   const item=plan(state,"2026-04-04T10:00")[0];
   assert.equal(item.name,variants[i]);assert.equal(item.sets[0].kg,exercises[i].sets[0].kg);
   state.workouts=[{...history,exercises:exercises.filter(e=>e.name!==variants[i])}];
   assert.equal(plan(state,"2026-04-04T10:00")[0].sets[0].kg,0);
 }
 const state={...s,profile:{...s.profile,equipment:variants},workouts:[]};
 const first=plan(state,"2026-04-04T10:00");
 assert.equal(first.length,1);assert.equal(first[0].name,variants[0]);
 state.workouts=[history];
 const next=plan(state,"2026-04-05T10:00");
 assert.equal(next.length,1);assert.equal(next[0].name,variants[1]);
 for(const [i,name] of variants.entries()){
   const steps=Object.fromEntries(variants.map((v,j)=>["exercise:"+v.toLowerCase(),j+1]));
   const completed=exercises.map(e=>({...e,sets:Array.from({length:3},()=>({...e.sets[0],easy:true}))}));
   const specific={...s,profile:{...s.profile,equipment:[name],exerciseSteps:steps},workouts:[{...history,exercises:completed}]};
   assert.equal(plan(specific,"2026-04-04T10:00")[0].sets[0].kg,exercises[i].sets[0].kg+i+1);
 }
});
test("Одно кардио сохраняет очередь, удалённые подходы не повышают вес",()=>{
 const state={...s,profile:{...s.profile,equipment:Object.keys(catalogue)}};
 const when="2026-11-24", before=plan(state,when);
 const cardio={date:"2026-11-20",exercises:[],cardio:[{seconds:600}]};
 assert.deepEqual(plan({...state,workouts:[cardio]},when),before);
 const e={...before[0],sets:[{kg:50,reps:8,easy:true,done:true}]};
 const next=plan({...s,profile:{...s.profile,equipment:[e.name]},workouts:[{date:"2026-11-22",exercises:[e]}]},when);
 assert.equal(next[0].sets[0].kg,50);
});
test("В каждой группе конкретные машины используют только собственную историю",()=>{
 const families=new Map();
 for(const [name,guide] of Object.entries(catalogue)){
   if(!guide.family)continue;
   if(!families.has(guide.family))families.set(guide.family,[]);
   families.get(guide.family).push(name);
 }
 assert.equal(families.size,5);
 for(const names of families.values()){
   const old=names.find(name=>catalogue[name].legacy),variants=names.filter(name=>name!==old);
   assert.ok(old&&variants.length>=2);
   const workouts=[{date:"2026-01-05T10:00",exercises:[{name:old,sets:[{kg:84,reps:8,done:true}]}]}];
   const state={...s,profile:{...s.profile,equipment:[old,...variants]},workouts};
   const planned=plan(state,"2026-01-07T10:00");
   assert.equal(planned.length,1);assert.ok(variants.includes(planned[0].name));
   assert.equal(planned[0].sets[0].kg,0);
   assert.equal(workouts[0].exercises[0].name,old);
 }
});

test("Treadmill incline, console priority and performed sets control energy independently",()=>{
 const session={date:"2026-11-22T09:00",end:"2026-11-22T10:00",kg:80,
   exercises:[{sets:[{done:false,reps:12,kg:100}]}],cardio:[{seconds:600,speed:5,incline:0}]};
 const level=workoutEnergy(session);
 assert.equal(level.minutes,10);
 const machine=session.cardio[0];machine.incline=5;
 assert.ok(workoutEnergy(session).gross>level.gross);
 machine.speed=7;machine.incline=0;const transition=workoutEnergy(session).gross;
 machine.incline=5;assert.ok(workoutEnergy(session).gross>transition);
 machine.speed=0;machine.distance=1000;const fromDistance=workoutEnergy(session).gross;
 machine.speed=6;assert.equal(workoutEnergy(session).gross,fromDistance);
 machine.kcal=30;assert.deepEqual(workoutEnergy(session),{gross:30,minutes:10});
 session.exercises[0].sets[0].done=true;
 assert.equal(workoutEnergy(session).minutes,60);
 assert.equal(Math.round(workoutEnergy(session).gross),275);
 machine.seconds=4000;assert.equal(workoutEnergy(session).gross,null);
});
