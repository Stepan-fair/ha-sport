"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const ui=require("./web/health-view.js");
const health=require("./web/health.js");
const {setDiaryZone}=require("./web/logic.js");
setDiaryZone("Europe/Moscow");
const day="2025-05-10",previous="2025-05-09";
const context=(data={})=>({day,tab:0,state:{workouts:[],meals:[],profile:{},...data},profile:{id:"example-owner",name:"Тест"},model:health,zone:"Europe/Moscow"});
const data=fields=>new Map(Object.entries(fields));
function save(ctx,action,fields,id=""){
  const form=ui.editor(ctx,action,id);
  const next=structuredClone(ctx.state);
  form.save(next,data(fields));
  ctx.state=next;
}

test("ручное время сохраняет смещение события, включая повтор осеннего часа",()=>{
  assert.equal(ui.timestamp("2025-10-26T02:30","Europe/Berlin","+02:00"),"2025-10-26T02:30+02:00");
  assert.equal(ui.timestamp("2025-10-26T02:30","Europe/Berlin","+01:00"),"2025-10-26T02:30+01:00");
  assert.throws(()=>ui.timestamp("2025-10-26T02:30","Europe/Berlin"),/смещение/);
  assert.throws(()=>ui.timestamp("2025-03-30T02:30","Europe/Berlin"),/часов/);
  assert.equal(ui.timestamp("2025-03-30T03:30","Europe/Berlin"),"2025-03-30T03:30+02:00");
  assert.equal(ui.timestamp("2026-11-25T23:45","Europe/Moscow"),"2026-11-25T23:45+03:00");
  assert.equal(ui.timestamp("2026-11-25T23:45","Europe/Moscow","+03:00","2026-11-25T23:45:36.250+03:00"),"2026-11-25T23:45:36.250+03:00");
});

test("помощник и непривязанный профиль не получают форм ввода",()=>{
  assert.equal(ui.panels({state:{},day:"2026-11-24",tab:0}),"");
  assert.equal(ui.panels({state:{},day:"2026-11-24",tab:0,profile:{id:"person1",role:"helper"}}),"");
});

test("формы еды, основного и дневного сна пересчитывают ночь и снимают выплату после исправления",()=>{
  const c=context({meals:[{id:"meal",date:previous+"T22:10",name:'<ужин>'}]});
  save(c,"settings",{sleepBonus:"on",mealBonus:"on",sleepGoalMinutes:"420",pauseGoalMinutes:"120"});
  save(c,"meal",{kind:"substantial",end:previous+"T21:15"},"meal");
  save(c,"sleep",{kind:"main",method:"interval",start:previous+"T23:45",end:day+"T07:15",awakenings:"1",awakeMinutes:"30",wakeMethod:"total",mealsComplete:"on"});
  let d=health.day(c.state,day);
  assert.equal(d.sleepMinutes,420);assert.equal(d.points,3);assert.equal(d.pauseMinutes,150);
  assert.match(ui.panels(c),/Основной сон · 7 ч/);
  assert.match(ui.panels({...c,tab:2,day:previous}),/&lt;ужин&gt;/);
  save(c,"sleep",{kind:"nap",method:"quick",date:day,hours:"0",minutes:"20"});
  assert.equal(health.day(c.state,day).sleepMinutes,440);
  save(c,"meal",{kind:"light",end:previous+"T21:15"},"meal");
  assert.equal(health.day(c.state,day).points,2);
  const id=d.episodes[0].id;
  save(c,"sleep",{kind:"main",method:"interval",start:previous+"T23:45",end:day+"T07:15",wakeMethod:"intervals",
    awakeStart0:day+"T02:00",awakeEnd0:day+"T03:00"},id);
  assert.equal(health.day(c.state,day).sleepMinutes,410);
  save(c,"delete-sleep",{},id);assert.equal(health.day(c.state,day).sleepMinutes,20);
});

test("неизвестное окончание еды и конфликт изменений не подменяются временем записи",()=>{
  const c=context({meals:[{id:"meal",date:previous+"T22:10",name:"Ужин"}]});
  const edit=ui.editor(c,"meal","meal");
  assert.doesNotMatch(edit.body,/value="2025-05-09T22:10"/);
  save(c,"meal",{kind:"substantial",end:""},"meal");
  assert.equal(c.state.meals[0].actualEnd,undefined);
  assert.throws(()=>edit.save(c.state,data({kind:"light",end:""})),/изменилась/);
});

test("суточный ввод, отмена исправления, скрытие и возврат показания",()=>{
  const c=context({healthImported:{daily:[{metric:"steps",date:day,value:5800,source:"Watch",receivedAt:day+"T23:55:00Z"}]}});
  save(c,"daily",{value:"4200",source:"Watch",complete:"on"},"steps");
  assert.equal(health.day(c.state,day).daily.steps.value,4200);
  assert.match(ui.panels(c),/полные сутки/);
  save(c,"delete-daily",{},"steps");
  assert.equal(health.day(c.state,day).daily.steps.value,5800);
  save(c,"delete-daily",{},"steps");
  assert.match(ui.panels(c),/Восстановить/);
  save(c,"undo-daily",{},"steps");
  assert.equal(health.day(c.state,day).daily.steps.value,5800);
});

test("импорт JSON сна и тренировок, связь с выбранным занятием и отмена правки",async()=>{
  const start=day+"T17:00+03:00",end=day+"T18:00+03:00";
  const c=context({workouts:[
    {id:"session-1",date:day+"T17:00",start,endedAt:end},
    {id:"session-2",date:day+"T17:15",startedAt:day+"T17:15",endedAt:end},
    {id:"other",date:day+"T10:00",endedAt:day+"T11:00"}
  ]});
  const item={id:"watch-test",start,end,type:"strength",source:"Watch",activeKcal:230,totalKcal:290};
  const form=ui.editor(c,"import","");
  const file=new File([JSON.stringify(item)],"example.json",{type:"application/json"});
  const payload=await form.prepare(data({file}));
  form.save(c.state,null,null,payload);form.save(c.state,null,null,payload);
  let rows=health.day(c.state,day).workouts;
  assert.equal(rows.length,1);
  const id=rows[0].id;
  assert.match(ui.editor(c,"link",id).body,/Совпало несколько/);
  assert.doesNotMatch(ui.editor(c,"link",id).body,/value="other"/);
  save(c,"link",{gym:"session-2"},id);
  save(c,"workout",{type:"strength",start:day+"T17:00",end:day+"T18:00",source:"Watch",activeKcal:"240",totalKcal:"290",avgPulse:"110"},id);
  assert.equal(health.day(c.state,day).workouts[0].totalKcal,290);
  save(c,"undo-workout",{},id);rows=health.day(c.state,day).workouts;
  assert.equal(rows[0].activeKcal,230);assert.equal(rows[0].gymId,"session-2");
  save(c,"link",{gym:""},id);
  save(c,"delete-workout",{},id);
  assert.equal(health.day(c.state,day).workouts.length,0);assert.equal(c.state.workouts.length,3);
  const sleep=ui.editor(c,"import-sleep","");
  const sleepPayload={sleep:[{id:"stage",date:day,stage:"deep",start:previous+"T23:43:00+03:00",end:previous+"T23:59:00+03:00"}]};
  sleep.save(c.state,null,null,sleepPayload);sleep.save(c.state,null,null,sleepPayload);
  assert.equal(health.day(c.state,day).episodes.length,1);
  assert.match(ui.editor(c,"sleep","stage").body,/name="stageDate" value="2025-05-10"/);
  await assert.rejects(()=>form.prepare(data({file:new File(["{"],"bad.json")})),/JSON/);
});

test("форма HA различает разрешения владельца, пустые даты и единицы неподтверждённых измерений",()=>{
  const snapshot={bindings:{sleep:"sensor.s",steps:"sensor.walk"},enabled:["sleep","steps"],status:{steps:"needs_date",sleep:"unavailable"},
    candidates:[{id:"night",metric:"sleep",minutes:430,source:"Watch"},{id:"movement",metric:"steps",value:5800,source:"<i>"}]};
  const view=ui.sensorContents({...snapshot,canManage:true});
  assert.match(view,/Источник недоступен/);assert.match(view,/Выбери|Дата измерения/);assert.match(view,/7 ч 10 мин/);
  assert.match(view,/шагов/);assert.match(view,/&lt;i&gt;/);assert.doesNotMatch(view,/<i>/);
  assert.match(view,/name="candidateDate0" value=""/);
  assert.doesNotMatch(ui.sensorContents({...snapshot,canManage:false}),/data-health="(?:confirm|save|clear|dismiss)/);
});
