"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const goals = require("./web/goals");
const view = require("./web/goals-view");
const {calculate} = require("./web/portions");
const {saveMeal, setMealTime} = require("./web/portions");
const {nutritionForDay, dailyWeights} = require("./web/reports");
const day = n => "2026-11-"+String(n).padStart(2,"0");
function report(state, start, end, today = 30) {
  const food = new Map();
  for(const kind of ["meals","supps"]) for(const item of state[kind]||[]) {
    const date=item.date.slice(0,10);
    if(!food.has(date))food.set(date,{meals:[],supps:[]});
    food.get(date)[kind].push(item);
  }
  return goals.report(state,day(start),day(end),day(today),dailyWeights(state,[],""),food,
    (meals,supps)=>nutritionForDay({meals,supps},(meals[0]||supps[0])?.date.slice(0,10)||""));
}
const meal=(n,time,grams,extra={})=>({date:day(n)+"T"+time,id:time,name:"Еда",amount:100,totals:[100,grams,1,2],...extra});
const weight=(n,kg,time="08:00")=>({date:day(n)+"T"+time,source:"manual",kg});

test("Автономная история целей, вес до даты и исправление замера до следующего",()=>{
  const s={profile:{birth:"1988-07-01",goal:"Сила"},weights:[weight(3,93),weight(6,90)]};
  goals.setProtein(s,day(1),"auto",null,false);
  goals.setProtein(s,day(8),"manual",120,false);
  goals.setProtein(s,day(10),"fact");
  const values=()=>report(s,1,10).rows.map(r=>r.protein.target);
  assert.deepEqual(values(),[null,null,148.8,148.8,148.8,144,144,120,120,null]);
  s.weights[0]=weight(4,60);
  assert.deepEqual(values(),[null,null,null,96,96,144,144,120,120,null]);
  s.profile.goal="Общая форма"; goals.profileChanged(s,day(7));
  assert.equal(report(s,7,7).rows[0].protein.target,null);
  assert.equal(report(s,6,6).rows[0].protein.target,144);
  assert.equal(report(s,8,8).rows[0].protein.target,120);
});

test("Для общей формы нужно подтвердить силовые, несовершеннолетним остаётся личная цель",()=>{
  const s={profile:{goal:"Общая форма",age:30},weights:[weight(1,60)]};
  assert.throws(()=>goals.setProtein(s,day(1),"auto",null,false));
  goals.setProtein(s,day(1),"auto",null,true);
  assert.equal(report(s,1,1).rows[0].protein.target,96);
  s.profile.birth="2012-03-01";
  assert.throws(()=>goals.setProtein(s,day(2),"auto",null,true));
  goals.setProtein(s,day(2),"manual",70);
  assert.equal(report(s,2,2).rows[0].protein.target,70);
});

test("План креатина ограничен датами, нет переноса излишка, открытого и неизвестного нуля",()=>{
  const s={supps:[{date:day(2),names:["Креатин"],servings:2,creatinePerServing:3},
    {date:day(4),names:["Креатин"]},{date:day(5),names:["Креатин"],servings:1,creatinePerServing:4}]};
  goals.setCreatine(s,day(1),false,null,3);goals.setCreatine(s,day(2),true,3,3);
  goals.setCreatine(s,day(5),false,null,4);goals.setCreatine(s,day(6),true,5,4);
  const r=report(s,1,8,6);
  assert.deepEqual(r.rows.map(x=>x.creatine.actual),[0,6,0,null,4,null]);
  assert.deepEqual(r.rows.map(x=>x.creatine.target),[null,3,3,3,null,5]);
  assert.equal(r.creatine.percent,50);assert.equal(r.creatine.comparedDays,2);
  assert.equal(r.creatine.planDays,4);
});

test("Источники белка объединяются по приёмам, связанный шейк учитывается один раз",()=>{
  const s={profile:{},meals:[meal(3,"08:00",6,{mealGroup:"Завтрак",fiberTotal:0}),meal(3,"08:01",22,{mealGroup:" завтрак ",productKind:"protein",fiberTotal:1}),
    meal(3,"14:17",null)],supps:[{date:day(3)+"T08:01",names:["Протеин"],servings:1,mealId:"08:01"},
      {date:day(3)+"T17:12",names:["Протеин"],servings:0.5}]};
  goals.setProtein(s,day(1),"manual",100);const r=report(s,1,5,4);
  assert.deepEqual(r.groups.map(g=>[g.label,g.known,g.missing]),[["Завтрак",28,0],["14:17",0,1],["17:12",11,0]]);
  assert.equal(r.rows[2].protein.known,39);assert.equal(r.rows[2].powder.known,33);
  assert.equal(r.protein.recordedDays,1);assert.equal(r.protein.comparedDays,0);
  assert.deepEqual(r.fiber,{known:1,knownCount:2,count:4});
  assert.match(view.report(r),/2 из 4 порций/);
  const html=view.today(report(s,3,3,4));
  assert.match(html,/не менее 39 г/);assert.match(html,/refine-meal-14%3A17/);
});

test("Тренд веса использует один замер на дату и не заполняет пропуски",()=>{
  const s={weights:[weight(1,90),weight(10,88),weight(24,80),weight(24,78,"13:00"),weight(28,82),weight(30,110)]};
  const r=report(s,29,29);
  assert.deepEqual(r.trends.map(t=>[t.days,t.mean,t.count,t.latest.day]),[[7,80,2,day(28)],[28,248/3,3,day(28)]]);
});

test("Отдельный шейк даёт граммы для сравнения с целью, пищевое покрытие требует съеденной порции",()=>{
  const s={profile:{},meals:[meal(2,"12:00",null,{amount:null}),meal(3,"09:10",30,{amount:null,portion:{mode:"piece",count:1}})],
    supps:[{date:day(1)+"T08:00",names:["Протеин"],servings:1}]};
  goals.setProtein(s,day(1),"manual",100);
  const r=report(s,1,3);
  assert.equal(r.protein.recordedDays,1);
  assert.equal(r.protein.comparedDays,2);
  assert.equal(r.protein.actual,52);
});

test("Исправление ручного веса переносит один замер и проверяет исходную запись",()=>{
  const old={source:"manual",kg:80,date:"2026-11-04T05:10:00.000Z"};
  const sameTimeHA={...old,source:"ha"};
  const s={weights:[old,sameTimeHA]};
  goals.saveWeight(s,old,"2026-11-05T08:10:00.000Z",79);
  assert.deepEqual(s.weights,[sameTimeHA,{source:"manual",kg:79,date:"2026-11-05T08:10:00.000Z"}]);
  assert.throws(()=>goals.saveWeight(s,old,"2026-11-06T08:10:00.000Z",75));
});

test("Снимок клетчатки различает пропуск и ноль, учитывает основание по штукам",()=>{
  const c={unit:"г",nut:[100,1,2,3],basis:"piece",pieceName:"лодочка",fiber:1.5};
  assert.equal(calculate(c,{mode:"piece",count:2}).fiberTotal,3);
  assert.equal(calculate({...c,fiber:0},{mode:"piece",count:1}).fiberTotal,0);
  assert.equal(calculate({...c,fiber:null},{mode:"piece",count:1}).fiberTotal,null);
  assert.equal(calculate(c,{mode:"piece",count:2,oil:{grams:5,nut:[900,0,100,0]}}).fiberTotal,null);
  assert.equal(calculate(c,{mode:"piece",count:2,oil:{grams:5,nut:[900,0,100,0],fiber:0}}).fiberTotal,3);
});

test("OFF переносит клетчатку именно на выбранное основание и сохраняет известный ноль",()=>{
  const {importedFood}=require("./web/foods");
  const convert=nutriments=>importedFood({product_name:"Тест",nutrition_data_per:"100ml",nutriments});
  assert.equal(calculate(convert({fiber_100g:0}),{mode:"base",count:20}).fiberTotal,0);
  assert.equal(calculate(convert({fiber_100g:"1.5"}),{mode:"base",count:200}).fiberTotal,3);
  assert.equal(calculate(convert({fiber_serving:10}),{mode:"base",count:200}).fiberTotal,null);
});

test("Редактор еды и перенос связанного шейка требуют повторного подтверждения окончания",()=>{
  const original={...meal(3,"19:00",20),oneOff:true,sleepMealKind:"substantial",actualConfirmed:true,actualEnd:day(3)+"T19:15+03:00"};
  const s={meals:[original]};
  saveMeal(s,{...original,amount:150},original,true);
  assert.equal(s.meals[0].actualEnd,original.actualEnd);
  for(const date of [day(3)+"T20:00",day(4)+"T19:00"]){
    s.meals=[original];saveMeal(s,{...original,date},original,true);
    assert.deepEqual([s.meals[0].sleepMealKind,s.meals[0].actualConfirmed,s.meals[0].actualEnd],["substantial",undefined,undefined]);
    const linked={...original};setMealTime(linked,date);
    assert.deepEqual([linked.date,linked.sleepMealKind,linked.actualConfirmed,linked.actualEnd],[date,"substantial",undefined,undefined]);
  }
});
