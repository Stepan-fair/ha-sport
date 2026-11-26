const test=require("node:test");
const assert=require("node:assert/strict");
const {diaryReport,reportStart,maintenance,dailyWeights}=require("./web/reports");
const base=()=>({profile:{},meals:[],weights:[],workouts:[],energyRules:{"2026-01-01":{mode:"manual",kcal:2000}},foodComplete:{},restLog:{}});
const meal=(day,kcal,amount=100)=>({date:day+"T12:00",nut:[kcal],amount});
function workout(day,name="Жим",kg=40){
  return {date:day+"T18:00",end:day+"T18:45",exercises:[{name,sets:[{kg,reps:10,done:true},{kg:90,reps:1,done:false}]}]};
}
const run=(s,day,p="week",scale=[])=>diaryReport(s,scale,"sensor.mass",day,p,day);
test("Calendar periods use Monday, cutoff, leap day and calendar years",()=>{
  assert.equal(reportStart("2027-01-03","week"),"2026-12-28");
  assert.equal(reportStart("2024-02-29","month"),"2024-02-01");
  const s=base();s.workouts=[workout("2026-01-01"),workout("2026-03-01"),workout("2026-03-02")];
  assert.equal(run(s,"2026-03-01","year").workouts,2);
  assert.equal(run(s,"2026-03-01","month").workouts,1);
  assert.equal(diaryReport(s,[],"","2026-03-04","day","2026-03-01").elapsed,0);
});
test("Balance counts only complete known meals, applies dated expenditure once and keeps deficit separate",()=>{
  const s=base();
  for(const [day,kcal] of [["01",1800],["02",2200],["03",null],["04",0],["05",1000]]){const d="2026-02-"+day;s.meals.push(meal(d,kcal));s.foodComplete[d]=day!=="05"}
  s.foodComplete["2026-02-06"]=true;s.workouts.push(workout("2026-02-02"));s.energyRules["2026-02-04"]={mode:"off"};
  const r=run(s,"2026-02-07","month");
  assert.equal(r.balances.length,2);assert.equal(r.deficit,200);assert.equal(r.surplus,200);assert.equal(r.balance,0);
  assert.equal(r.foodDays,4);assert.equal(r.unknown,1);
  assert.equal(run(s,"2026-02-07","day").balance,null);
});
test("Estimates require effective profile settings and a weight known on that date",()=>{
  const s=base(),rule={mode:"estimate",height:180,birth:"2000-03-01",sex:"Мужской",factor:1.4};
  s.energyRules={"2026-02-27":rule};s.weights=[{date:"2026-02-28T12:00",kg:80,source:"manual"}];
  for(const d of ["2026-02-27","2026-02-28","2026-03-01"]){s.meals.push(meal(d,1900));s.foodComplete[d]=true}
  const r=run(s,"2026-03-01","year");assert.equal(r.balances.length,2);assert.equal(r.balances[0].maintenance,2166);assert.equal(r.balances[1].maintenance,2160);
  assert.equal(maintenance({...rule,birth:"2015-03-01"},"2026-03-01",80),null);
});
test("Source precedence, incomplete sets, duplicate exercise entries and exact machine names",()=>{
  const s=base(),day="2026-02-02",date=day+"T12:00";
  s.weights=[{date,kg:81,source:"manual"},{date:"2026-02-03T10:00",kg:82,source:"manual"}];
  const scale=[{date,kg:80,source:"ha",entity:"sensor.mass"}];
  assert.equal(dailyWeights(s,scale,"sensor.mass")[0].kg,80);
  s.workouts=[workout(day,"Жим 45°"),workout(day,"Жим 45°",50),workout(day,"Жим горизонтальный",30)];
  const r=run(s,day,"week",scale);assert.equal(r.weights.length,1);assert.equal(r.sets,3);assert.equal(r.volume,1200);
  assert.equal(r.rows[0].exercises.get("Жим 45°").kg,50);assert.equal(r.rows[0].exercises.get("Жим 45°").sets,2);
});
test("Weekly rewards remain personal and reversible after edits or duplicate entries",()=>{
  const s=base(),end="2026-11-29";
  for(let i=23;i<=29;i++){const day="2026-11-"+i;s.meals.push(meal(day,1500));s.foodComplete[day]=true;s.restLog[day]=true}
  s.workouts=[workout("2026-11-24"),workout("2026-11-26")];
  const r=run(s,end);
  assert.equal(r.week.joint,true);assert.equal(r.week.repeat,true);assert.equal(r.week.activity,7);
  const scheduled={...s,restLog:{}};assert.equal(run(scheduled,end).week.joint,true);
  assert.equal(r.achievements.length,4);assert.equal(r.periodPoints,r.points);
  s.meals.push(meal(end,100));s.workouts.push(workout("2026-11-24"));
  assert.equal(run(s,end).points,r.points);
  s.foodComplete[end]=false;assert.equal(run(s,end).week.joint,false);assert.ok(run(s,end).points<r.points);
  assert.equal(run(base(),end).points,0);
  assert.ok(run(s,"2026-11-23").points<r.points);
});

test("Automatic expense is available on rest days, uses the last known weight and needs complete meals for balance",()=>{
  const s=base(),day="2026-02-04";
  delete s.energyRules;
  s.profile={height:180,birth:"2000-03-01",sex:"Мужской"};
  s.weights=[{date:"2025-09-01T12:00",kg:80,source:"manual"},{date:"2026-02-05T08:00",kg:85,source:"manual"}];
  const report=run(s,day),row=report.rows.at(-1);
  assert.equal(report.rows.length,3);assert.ok(report.rows.every(d=>d.maintenance===2166));
  assert.equal(row.active,0);assert.equal(row.balance,null);
  s.meals=[meal(day,2000)];s.foodComplete={[day]:true};
  assert.equal(run(s,day).balance,-166);
  assert.equal(run({...s,weights:[]},day).balance,null);
  assert.equal(run({...s,profile:{...s.profile,sex:""}},day).rows.at(-1).maintenance,null);
});

test("Training adds only the daily increment and respects snapshots, clock times, edits and manual modes",()=>{
  const s=base(),day="2026-02-04";
  s.energyRules={};s.profile={height:180,birth:"2000-03-01",sex:"Мужской"};
  s.weights=[{date:day+"T08:00",kg:80,source:"manual"},{date:day+"T22:00",kg:85,source:"manual"}];
  const first={...workout(day),date:day+"T09:00",end:day+"T10:00",kg:90,cardio:[{seconds:600,kcal:45},{seconds:600,kcal:50}]};
  const second={...workout(day),date:day+"T17:00",end:day+"T17:30"};
  s.workouts=[first,second];
  const row=()=>run(s,day,"day").rows[0];
  assert.equal(row().base,2226);
  // 40 minutes of lifting at the saved 90 kg, then two console readings.
  // The later session uses the 80 kg weighing available at 17:00.
  assert.equal(row().active,Math.round(3.5*3.5*90/200*40+95+3.5*3.5*80/200*30-2226*90/1440));
  assert.equal(row().maintenance,row().base+row().active);
  const initial=row().active;second.exercises[0].sets[0].kg*=2;assert.equal(row().active,initial);
  s.workouts.pop();assert.ok(row().active<initial);
  s.workouts=[{...second,end:second.date}];assert.equal(row().maintenance,null);
  s.energyRules[day]={mode:"manual",kcal:2300};assert.equal(row().maintenance,2300);
  s.energyRules[day]={mode:"off"};assert.equal(row().maintenance,null);
  s.energyRules={};s.workouts=[second];s.weights.shift();assert.equal(row().maintenance,null);
});

test("Переход через полночь делит вклад в сутки и сохраняет одну тренировку",()=>{
 const s=base(),start="2026-02-02",end="2026-02-03";s.energyRules={};
 s.profile={height:180,birth:"2000-03-01",sex:"Мужской"};s.weights=[{date:start+"T09:00",kg:80}];
 const w={date:start+"T23:30",end:end+"T00:30",kg:80,cardio:[{seconds:3600,kcal:300}],exercises:[]};
 s.workouts=[w];const r=run(s,end,"week");assert.equal(r.workouts,1);assert.equal(r.minutes,60);
 assert.equal(r.rows[0].active,105);assert.equal(r.rows[1].active,105);
 assert.equal(run(s,start,"day").rows[0].active,105);
});
test("История рабочих подходов разделена по способу записи и исключает разминку",()=>{
 const s=base(),day="2026-04-13";const a=workout(day),b=workout(day);
 a.exercises[0].loadUnit="Одна гантель";a.exercises[0].sets.push({done:true,kg:8,reps:14,warmup:true});
 s.workouts=[a,b];const r=run(s,day,"day");
 assert.equal(r.sets,3);assert.deepEqual(r.exerciseNames,["Жим","Жим · Одна гантель"]);
 assert.equal(r.rows[0].exercises.get("Жим · Одна гантель").sets,1);
});

const {nutritionForDay,supplementStatus}=require("./web/reports");
const {recordedDose,addDoseEntries}=require("./web/logic");
const dayA="2026-03-02",dayB="2026-03-03";
const dose=(name,day,details)=>({date:day,period:"Утро",names:[name],...details});
test("Исправление и удаление одной старой отметки сохраняет прежние участники группы и повторный приём в этот день",()=>{
 const {replaceRecordedDose}=require("./web/logic");
 const old=dose("Креатин",dayA);old.names.push("Протеин");
 const another=dose("Протеин",dayA,{period:"Вечер"});
 const fixed=dose("Протеин",dayA,{servings:1.5,perServing:[null,22,null,null]});
 const rows=replaceRecordedDose([old,another],0,"Протеин",fixed);
 assert.deepEqual(rows,[{...old,names:["Креатин"]},fixed,another]);
 assert.deepEqual(replaceRecordedDose(rows,2,"Протеин"),[rows[0],fixed]);
 assert.deepEqual(old.names,["Креатин","Протеин"]);
});
test("Местная полночь закрывает пустой день, внесение и снятие отметки меняют статус только выбранного профиля",()=>{
 const s=base();s.profile.supps=["Креатин","Протеин"];
 assert.equal(supplementStatus(s,dayA,dayA),"Пока нет отметки");
 assert.equal(supplementStatus(s,dayB,dayA),"Запланировано");
 assert.equal(supplementStatus(s,dayA,dayB),"Не принимал");
 s.supps=[];addDoseEntries(s,dayA,[dose("Creatine Monohydrate",dayA)]);
 assert.equal(supplementStatus(s,dayA,dayB),"Принял часть");
 s.supps[0].names.push("Протеин");assert.equal(supplementStatus(s,dayA,dayB),"Принял");
 assert.equal(supplementStatus(base(),dayA,dayB),"Не принимал");
 s.supps=[];assert.equal(supplementStatus(s,dayA,dayB),"Не принимал");
});
test("Добавление и удаление добавок из профиля не пересчитывает план прошлого дня",()=>{
 const s=base();s.profile.supps=["Креатин"];s.supps=[];
 addDoseEntries(s,dayA,[dose("Креатин",dayA)]);
 s.profile.supps.push("Протеин");
 addDoseEntries(s,dayB,[dose("Креатин",dayB)]);
 assert.equal(supplementStatus(s,dayA,dayB),"Принял");
 assert.equal(supplementStatus(s,dayB,dayB),"Принял часть");
 s.profile.supps=[];
 assert.equal(supplementStatus(s,dayB,"2026-03-04"),"Принял часть");
 s.supps=s.supps.filter(x=>x.date!==dayB);
 assert.equal(supplementStatus(s,dayB,"2026-03-04"),"Не принимал");
 addDoseEntries(s,dayB,[dose("Протеин",dayB)]);
 assert.equal(supplementStatus(s,dayB,"2026-03-04"),"Принял часть");
 const legacy={profile:{supps:["Креатин"]},supps:[dose("Креатин",dayA)]};
 assert.equal(supplementStatus(legacy,dayA,dayB),"Есть отметки");
 addDoseEntries(legacy,dayA,[dose("Протеин",dayA)]);
 assert.equal(supplementStatus(legacy,dayA,dayB),"Есть отметки");
});
test("Размер принятой порции: дробные количества и независимые граммы креатина, порошка и белка",()=>{
 assert.deepEqual(recordedDose("Креатин",0.5),{servings:0.5,creatinePerServing:3});
 assert.deepEqual(recordedDose("Протеин",1.5),{servings:1.5,perServing:[null,22,null,null],powderPerServing:30});
 assert.deepEqual(recordedDose("Протеин",1,null),{servings:1,perServing:[null,22,null,null]});
 assert.equal(recordedDose("Протеин",2,30,"serving1").mealId,"serving1");
 assert.equal(recordedDose("Протеин",1,28).powderPerServing,28);
 assert.throws(()=>recordedDose("Протеин",1,-1));
 for(const n of [0,-1,"",Infinity,NaN])assert.throws(()=>recordedDose("Протеин",n));
});
test("Питание считает зафиксированные КБЖУ и отдельный протеин по одному разу; удалённая или вчерашняя связь исключается",()=>{
 const s=base();
 s.meals=[{...meal(dayA,150),id:"plate",totals:[560,24,19,55]}, {...meal(dayB,2),id:"later",totals:[12,4,0,0]}];
 s.foodComplete[dayA]=true;
 s.supps=[dose("Протеин",dayA,{servings:1.5,perServing:[null,22,null,null]}),dose("Креатин",dayA,{servings:2,creatinePerServing:3})];
 const get=()=>nutritionForDay(s,dayA);
 assert.deepEqual(get().totals,[null,57,null,null]);assert.deepEqual(get().known,[560,57,19,55]);
 assert.deepEqual(get().missing,[1,0,1,1]);assert.equal(get().count,2);
 assert.equal(run(s,dayA,"day").balance,null);
 s.supps[0].mealId="later";assert.equal(get().totals[1],57);
 s.supps[0].mealId="plate";assert.deepEqual(get().totals,[560,24,19,55]);assert.equal(get().count,1);
 assert.equal(get().supplements[0].linked,true);assert.equal(run(s,dayA,"day").balance,-1440);
 s.meals.shift();assert.deepEqual(get().totals,[null,33,null,null]);
 s.supps.shift();assert.deepEqual(get().totals,[null,null,null,null]);assert.equal(get().count,0);
});
test("Отчёты разделяют порции, белок из добавки и общий белок за день, неделю, месяц и год",()=>{
 const s=base();s.meals=[{...meal(dayB,200),totals:[190,12,10,1]}];s.supps=[];
 for(const day of ["2025-12-31","2026-01-01","2026-03-01",dayA,dayB]){
   s.supps.push(dose("Креатин",day,{servings:0.5,creatinePerServing:3}),dose("Протеин",day,{servings:2,perServing:[null,22,null,null],powderPerServing:30}));
 }
 for(const [period,days] of [["day",1],["week",2],["month",3],["year",4]]){
   const r=run(s,dayB,period);
   assert.equal(r.doses.creatineGrams,1.5*days);assert.equal(r.doses.proteinGrams,44*days);
   assert.equal(r.doses.proteinServings,2*days);assert.equal(r.doses.powderGrams,60*days);
   assert.equal(r.nutrition.totals[1],12+44*days);
 }
 s.supps.push(dose("Протеин",dayB));s.supps.push(dose("Креатин",dayB));
 const r=run(s,dayB,"day");assert.equal(r.doses.proteinUnknown,1);assert.equal(r.doses.creatineUnknown,1);
 assert.equal(r.nutrition.totals[1],null);assert.equal(r.nutrition.known[1],56);
});
