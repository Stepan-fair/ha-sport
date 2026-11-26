"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const H=require("./web/health.js");
const clock=require("./web/logic.js");
clock.setDiaryZone("Europe/Moscow");
const night="2025-01-01";
const start="2024-12-31T23:45:00+03:00",end="2025-01-01T07:15:00+03:00";
const state=()=>({meals:[],workouts:[]});
const sleep=()=>({date:night,start,end,awakeMinutes:30,mealsComplete:true});
const setGoals=s=>Object.assign(H.ensure(s).settings,{sleepBonus:true,mealBonus:true,sleepGoalMinutes:420,pauseGoalMinutes:120});
const meal=(date,kind)=>({date,actualEnd:date,actualConfirmed:true,sleepMealKind:kind});

test("One waking date, actual meal end across New Year and independent, reversible bonuses",()=>{
  const s=state();setGoals(s);
  s.meals=[meal("2024-12-31T21:15:00+03:00","substantial"),meal("2024-12-31T23:15:00+03:00","light")];
  const r=H.saveSleep(s,sleep());
  const d=()=>H.day(s,night);
  assert.deepEqual([d().sleepMinutes,d().pauseMinutes,d().sleepPoints,d().mealPoints],[420,150,2,1]);
  assert.equal(H.day(s,"2024-12-31").points,0);
  H.ensure(s).settings.sleepBonus=false;assert.equal(d().points,1);
  s.meals[1].sleepMealKind="substantial";assert.equal(d().mealPoints,0);
  s.meals[1].actualConfirmed=false;assert.equal(d().pauseMinutes,null);
  s.meals=[];assert.equal(d().pauseMinutes,null);
  H.removeSleep(s,r.id);assert.equal(d().sleepMinutes,null);
});
test("Duration-only observations require an event date, no invented pause or missing nights in means",()=>{
  const s=state();setGoals(s);
  H.saveSleep(s,{date:night,minutes:450});H.saveSleep(s,{date:night,minutes:450});
  H.saveSleep(s,{date:"2025-01-03",minutes:450});
  s.healthImported={sleep:[{minutes:450,receivedAt:end,source:"phone"}]};
  assert.equal(H.day(s,night).points,2);assert.equal(H.day(s,night).pauseMinutes,null);
  const period=H.period(s,night,"2025-01-07");assert.equal(period.nights,2);
  assert.equal(period.averageSleep,450);assert.deepEqual(period.trend,[]);
  assert.equal(H.day(s,"2025-01-02").sleepMinutes,null);
});
test("Merge overlapping sleep and distinguish total, stages, awake and in-bed time; offset change is elapsed time",()=>{
  const s=state();
  H.saveSleep(s,{date:night,start:"2025-01-01T02:00+02:00",end:"2025-01-01T06:00+01:00"});
  H.saveSleep(s,{date:night,kind:"nap",start:"2025-01-01T05:20+01:00",end:"2025-01-01T07:00+01:00"});
  assert.equal(H.day(s,night).sleepMinutes,360);
  const stage={date:night,start:"2025-01-01T09:00+01:00",end:"2025-01-01T10:00+01:00",source:"Watch"};
  s.healthImported={sleep:[{...stage,id:"stage",stage:"core"},{...stage,id:"total",stage:"total"},
    {...stage,id:"bed",stage:"inBed",end:"2025-01-01T11:00+01:00"}]};
  assert.equal(H.day(s,night).sleepMinutes,420);
  const other=state();
  H.saveSleep(other,{...sleep(),awakeMinutes:undefined,awakeIntervals:[{start:"2025-01-01T03:00+03:00",end:"2025-01-01T03:30+03:00"}]});
  assert.equal(H.day(other,night).sleepMinutes,420);
});
test("Imported sleep correction and deletion survive repeated loads and can be reverted",()=>{
  const s=state();s.healthImported={sleep:[{id:"night1",date:night,source:"Sensor",minutes:430}]};
  H.saveSleep(s,{id:"night1",date:night,minutes:400});s.healthImported.sleep[0].minutes=440;
  assert.equal(H.day(s,night).sleepMinutes,400);
  H.revertSleep(s,"night1");assert.equal(H.day(s,night).sleepMinutes,440);
  H.removeSleep(s,"night1");assert.equal(H.day(s,night).sleepMinutes,null);
  H.revertSleep(s,"night1");assert.equal(H.day(s,night).sleepMinutes,440);
});
const obs=(metric,value,extra={})=>({date:night,metric,value,unit:metric==="steps"?"steps":"kcal",source:"Watch",receivedAt:end,...extra});
test("Activity uses dated replaceable totals, guards units and handles manual corrections",()=>{
  const s=state();s.healthImported={daily:[obs("steps",4200),obs("steps",5800)]};
  assert.equal(H.day(s,night).daily.steps.value,5800);
  H.saveDaily(s,obs("steps",3000));s.healthImported.daily.push(obs("steps",3200));
  assert.equal(H.day(s,night).daily.steps.value,3000);
  H.removeDaily(s,night,"steps");assert.equal(H.day(s,night).daily.steps.value,3200);
  H.removeDaily(s,night,"steps");assert.equal(H.day(s,night).daily.steps,undefined);
  H.revertDaily(s,night,"steps");assert.equal(H.period(s,night,"2025-01-07").daily.steps.days,1);
  assert.throws(()=>H.saveDaily(s,obs("steps",60,{unit:"min"})));
  assert.throws(()=>H.saveDaily(s,obs("steps",0.5)));
});
test("Use only explicitly complete source-matched daily energy; missing total remains unknown",()=>{
  const s=state(),entries=[{workout:{id:"gym"},active:300}];
  s.healthImported={daily:[obs("resting",1700,{complete:true}),obs("active",500)]};
  const exp=()=>H.expenditure(s,night,1800,entries);
  assert.equal(exp().total,2100);assert.equal(exp().method,"profile");
  s.healthImported.daily[1].complete=true;assert.equal(exp().total,2200);assert.equal(exp().method,"daily");
  s.healthImported.daily[1].source="Phone";assert.equal(exp().method,"profile");
  assert.equal(H.expenditure(s,night,null,entries).total,null);
});
const gym={id:"gym",date:"2025-01-01T18:00",end:"2025-01-01T19:00",exercises:[{name:"Присед"}]};
const watch={id:"sample",name:"Traditional Strength Training",start:"2025-01-01 18:00:00 +0300",
  end:"2025-01-01 19:00:00 +0300",duration:3500,source:{name:"Watch",identifier:"app.watch"},
  activeEnergyBurned:{qty:300,units:"kcal"},totalEnergy:{qty:400,units:"kcal"},
  distance:{qty:1000,units:"m"},avgHeartRate:{qty:110,units:"count/min"}};
test("HA Export v2 plus manual watch record and nested data produce one linked effort",()=>{
  const s=state();s.workouts=[gym];
  const first=H.saveWorkout(s,{type:watch.name,start:gym.date,end:gym.end,energyType:"active",energy:305});
  const load=()=>H.importWorkouts(s,{data:{workouts:[{...watch,workoutEvents:[{type:"treadmill"}]}]}})[0];
  const w=load();assert.equal(w.id,first.id);assert.equal(w.imported,true);
  assert.equal(w.eventId,"sample");assert.equal(w.totalKcal,400);
  assert.equal(H.day(s,night).workouts.length,1);assert.equal(load().id,w.id);
  assert.deepEqual(H.candidates(s,w.id),[gym]);
  H.linkWorkout(s,w.id,H.gymKey(gym));
  assert.equal(H.expenditure(s,night,1800,[{workout:gym,active:null,fraction:0.5}]).total,1953);
  H.revertWorkout(s,w.id);const imported=H.day(s,night).workouts[0];
  assert.equal(imported.energy,300);assert.equal(imported.totalKcal,400);
  assert.equal(imported.distanceKm,1);assert.equal(imported.avgPulse,110);
  assert.equal(imported.durationMinutes,3500/60);
  watch.activeEnergyBurned.qty=320;load();assert.equal(H.expenditure(s,night,1800,[{workout:gym,active:200}]).total,2120);
  H.linkWorkout(s,w.id,null);assert.equal(H.expenditure(s,night,1800,[{workout:gym,active:200}]).total,2000);
});
test("Dated sleep stages can be imported across midnight, updated and corrected by id",()=>{
  const s=state(),before={id:"segment",date:night,stage:"core",start:"2024-12-31T23:00+03:00",end:"2024-12-31T23:40+03:00",source:"Watch"};
  H.importSleep(s,{sleep:[before]});H.importSleep(s,[before]);assert.equal(H.day(s,night).sleepMinutes,40);
  H.saveSleep(s,{id:"segment",minutes:30,date:night});
  H.importSleep(s,[{...before,end:"2024-12-31T23:50+03:00"}]);assert.equal(H.day(s,night).sleepMinutes,30);
  H.revertSleep(s,"segment");assert.equal(H.day(s,night).sleepMinutes,50);
  assert.throws(()=>H.importSleep(s,[{id:"other",minutes:460,receivedAt:end}]));
});
test("Ambiguous candidate remains unlinked; conflicting links cannot add once more; foreign and incompatible types excluded",()=>{
  const s=state();s.workouts=[gym,{...gym,id:"other"},{...gym,id:"elsewhere",date:"2025-01-03T18:00",end:"2025-01-03T19:00"}];
  const [w]=H.importWorkouts(s,[watch]);assert.equal(H.candidates(s,w.id).length,2);assert.equal(w.gymId,null);
  const [cycling]=H.importWorkouts(s,[{...watch,id:"cycling",name:"Swimming"}]);
  assert.equal(H.candidates(s,cycling.id).length,0);
  H.linkWorkout(s,w.id,"other");H.removeWorkout(s,w.id);H.importWorkouts(s,[watch]);
  assert.equal(H.day(s,night).workouts.length,1);
  H.revertWorkout(s,w.id);assert.equal(H.day(s,night).workouts.length,2);
});
test("Validate dates, quantities, units and all items before any import is saved",()=>{
  const s=state();
  for(const row of [{minutes:420},{date:"2025-02-30",minutes:30},{date:"2099-01-01",minutes:45},
    {date:night,minutes:-1}, {...sleep(),awakeMinutes:999},{...sleep(),date:"2025-01-02"}]){
    assert.throws(()=>H.saveSleep(s,row));
  }
  for(const override of [{start:"2099-01-01T08:00Z",end:"2099-01-01T09:00Z"},{distance:{qty:1,units:"kg"}},
    {activeEnergyBurned:{qty:1,units:"W"}},{duration:-1},{start:"2025-01-01T11:00",end:"2025-01-01T12:00"},{id:""}]){
    assert.throws(()=>H.importWorkouts(s,[watch,{...watch,...override}]));
    assert.deepEqual(H.day(s,night).workouts,[]);
  }
});
test("A card for an enclosed treadmill segment cannot drive a second gym session",()=>{
  const s=state(),running={id:"run",date:"2025-01-01T18:05",end:"2025-01-01T18:15",type:"running"};
  s.workouts=[gym,running];
  const segment={...watch,id:"part",name:"Running",start:"2025-01-01T18:05+03:00",end:"2025-01-01T18:15+03:00",duration:600};
  const [part]=H.importWorkouts(s,[segment]);H.linkWorkout(s,part.id,"run");
  const [whole]=H.importWorkouts(s,[watch]);H.linkWorkout(s,whole.id,"gym");
  assert.deepEqual(H.candidates(s,part.id),[]);
  assert.equal(H.linkedWorkout(s,running),null);
  assert.equal(H.day(s,night).workouts.find(r=>r.id===part.id).parentWorkoutId,whole.id);
});
test("Prefer the selected sleep source over another device's duration-only total",()=>{
  const s=state();H.ensure(s).settings.sleepSource="watch";
  H.importSleep(s,[{...sleep(),id:"watch",source:"watch"},{id:"phone",source:"phone",date:night,minutes:480}]);
  assert.equal(H.day(s,night).sleepMinutes,420);
});
test("An explicitly preferred device sets both main sleep boundaries despite a longer overlapping phone estimate",()=>{
  const s=state();H.ensure(s).settings.sleepSource="watch";
  H.importSleep(s,[{...sleep(),id:"a",source:"watch"},{id:"b",source:"phone",start:"2024-12-31T22:45+03:00",end}]);
  const d=H.day(s,night);assert.equal(d.mainStart,start);assert.equal(d.sleepMinutes,420);
});
test("Main sleep with an unknown awake interval does not consume an overlapping nap twice",()=>{
  const s=state();
  H.importSleep(s,[{id:"duration",start,end,awakeMinutes:30,source:"one"},
    {id:"interval",start:"2025-01-01T06:35+03:00",end:"2025-01-01T07:25+03:00",kind:"nap",source:"two"}]);
  assert.equal(H.day(s,night).sleepMinutes,430);
});
test("Unclassified meals only make the last substantial one ambiguous when ordering is unknown or later",()=>{
  const s=state();setGoals(s);H.saveSleep(s,sleep());
  s.meals=[meal("2024-12-31T12:15+03:00",null),meal("2024-12-31T21:15+03:00","substantial")];
  assert.equal(H.day(s,night).mealPoints,1);
  s.meals[0].actualEnd="2024-12-31T22:15+03:00";assert.equal(H.day(s,night).mealPoints,0);
  s.meals[0].actualConfirmed=false;assert.equal(H.day(s,night).mealPoints,0);
});
test("Each report gets a fresh projection after an in-place correction",()=>{
  const s=state();H.saveSleep(s,{minutes:430,date:night});
  const first=H.prepare(s);assert.equal(first.day(night).sleepMinutes,430);
  H.saveSleep(s,{...first.day(night).episodes[0],minutes:390});
  const next=H.prepare(s);assert.equal(next.period(night,night).averageSleep,390);
  assert.equal(first.day(night).sleepMinutes,430);
});
test("Today's counters cannot be treated as complete overnight totals",()=>{
  const s=state(),date=clock.diaryTime().slice(0,10);
  assert.throws(()=>H.saveDaily(s,{date,metric:"active",value:300,complete:true}));
  s.healthImported={daily:[obs("active",500,{date,complete:true}),obs("resting",1700,{date,complete:true})]};
  assert.equal(H.expenditure(s,date,1800,[]).method,"profile");
});
test("A moved gym session or a corrected watch interval invalidates a previous match",()=>{
  const s=state(),g={...gym};s.workouts=[g];const [w]=H.importWorkouts(s,[watch]);
  H.linkWorkout(s,w.id,"gym");assert.equal(H.linkedWorkout(s,g).id,w.id);
  g.end="2025-01-02T19:00";g.date="2025-01-02T18:00";assert.equal(H.linkedWorkout(s,g),null);
  Object.assign(g,gym);H.importWorkouts(s,[{...watch,start:"2025-01-03T18:00+03:00",end:"2025-01-03T19:00+03:00"}]);
  assert.equal(H.linkedWorkout(s,g),null);
  assert.equal(H.day(s,"2025-01-03").workouts[0].gymId,null);
});
test("Sensor, normalized JSON and manual events use the diary day of the instant while retaining the source offset",()=>{
  clock.setDiaryZone("UTC");
  try{
    const s=state(),start="2026-02-14T20:30:00-08:00",end="2026-02-14T23:30:00-08:00";
    s.healthImported={sleep:[{id:"ha",date:"2026-02-15",start,end,source:"watch",minutes:180}]};
    const [fromJson]=H.importSleep(s,{id:"json",start,end,source:"phone"});
    assert.equal(fromJson.date,"2026-02-15");assert.equal(fromJson.end,end);
    const manual=H.saveSleep(s,{start,end});assert.equal(manual.date,"2026-02-15");
    assert.deepEqual(H.day(s,"2026-02-15").episodes.map(r=>r.id).sort(),["ha","json",manual.id].sort());
    assert.equal(H.day(s,"2026-02-14").sleepMinutes,null);
    const [workout]=H.importWorkouts(s,{id:"w",type:"strength",start,end});
    assert.equal(workout.date,"2026-02-15");assert.equal(workout.start,start);
    assert.equal(H.day(s,"2026-02-15").workouts.length,1);
    // Persisted records still have the original instant if the diary zone is later changed.
    s.health.sleep.find(r=>r.id===manual.id).date="2026-02-14";
    s.health.sleepImports[0].date="2026-02-14";
    s.health.workouts[0].original.date="2026-02-14";
    assert.equal(H.day(s,"2026-02-15").episodes.length,3);
    assert.equal(H.day(s,"2026-02-15").workouts.length,1);
    H.saveSleep(s,{date:"2026-02-14",minutes:400});assert.equal(H.day(s,"2026-02-14").sleepMinutes,400);
    assert.throws(()=>H.saveSleep(s,{date:"2026-02-17",start,end}));
  }finally{clock.setDiaryZone("Europe/Moscow")}
});
test("Portable identifiers belong to their source and each correction retains its diary id",()=>{
  const s=state(),first={...watch,id:"42",source:{name:"Recorder",identifier:"app.a"}};
  const second={...first,source:{name:"Recorder",identifier:"app.b"}};
  const [a,b]=H.importWorkouts(s,[first,second]);assert.notEqual(a.id,b.id);
  assert.equal(H.importWorkouts(s,[{...first,activeEnergyBurned:{qty:250,units:"kcal"}}])[0].id,a.id);
  assert.equal(H.day(s,night).workouts.find(r=>r.id===a.id).activeKcal,250);
  assert.equal(H.day(s,night).workouts.length,2);
  const one={id:"42",date:night,minutes:420,source:"A"},two={...one,source:"B",minutes:450};
  const [x,y]=H.importSleep(s,[one,two]);assert.notEqual(x.id,y.id);assert.equal(x.id,"42");
  assert.equal(H.importSleep(s,[{...two,minutes:430}])[0].id,y.id);
  H.removeSleep(s,y.id);assert.equal(H.day(s,night).episodes.length,1);
  assert.equal(H.day(s,night).episodes[0].minutes,420);
  H.revertSleep(s,y.id);assert.equal(H.day(s,night).episodes.length,2);
});
test("True UUIDs use a single event across source representations and casing",()=>{
  const s=state(),id="eaf9d528-cbf1-4cba-b433-37c22d118347";
  const [w]=H.importWorkouts(s,[{...watch,id}]);
  assert.equal(H.importWorkouts(s,[{...watch,id:id.toUpperCase(),source:"New label"}])[0].id,w.id);
  assert.equal(H.day(s,night).workouts.length,1);
  const [x]=H.importSleep(s,[{id,date:night,minutes:421,source:"A"}]);
  assert.equal(H.importSleep(s,[{id:id.toUpperCase(),date:night,minutes:430,source:"B"}])[0].id,x.id);
  assert.equal(H.day(s,night).episodes.length,1);
});
