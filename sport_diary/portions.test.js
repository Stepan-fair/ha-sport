"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {calculate, describe, preferredText, recent, saveMeal} = require("./web/portions");

const sample = {name:"Тестовый продукт", code:"00001001", unit:"г", nut:[120,16,4,5], sizes:{package:180}, preferred:{mode:"package",count:1}};
function intake(card, mode, count, extra={}) {
  const {baseTotals, ...snapshot} = calculate(card, {mode,count,...extra});
  return {...structuredClone(card),...snapshot,id:"m1",date:"2026-01-10T12:00"};
}
function approx(actual, expected) {
  actual.forEach((value,i) => assert.ok(Math.abs(value-expected[i]) < 1e-10));
}

test("package defaults and immutable 90 g snapshot", () => {
  assert.equal(preferredText(sample), "1 упаковка · 180 г");
  for (const count of ["0.5","0,5"]) {
    const meal = intake(sample,"package",count);
    assert.equal(meal.amount,90);
    approx(meal.totals,[108,14.4,3.6,4.5]);
    const updated = {...sample,sizes:{package:200}};
    const state = {products:[updated],meals:[]};
    saveMeal(state,meal,sample,false);
    assert.equal(calculate(state.products[0],{mode:"package",count:0.5}).amount,100);
    assert.equal(state.meals[0].amount,90);
    assert.deepEqual(state.products[0].preferred,{mode:"package",count:1});
    assert.equal(recent(state.meals,"2026-01-10")[0].portion.count,0.5);
  }
});

test("millilitres and legacy partial labels", () => {
  const drink = {unit:"мл",nut:[40,1,null,5],sizes:{serving:250}};
  assert.equal(calculate(drink,{mode:"serving",count:"1,5"}).amount,375);
  assert.deepEqual(calculate(drink,{mode:"base",count:"150"}).totals,[60,1.5,null,7.5]);
  for(const value of [0,-1,"","2,4,5",NaN,Infinity,"0x10"]) assert.throws(()=>calculate(drink,{mode:"base",count:value}));
  assert.throws(()=>calculate(drink,{mode:"package",count:1}));
  const legacy = {unit:"г",nut:[null,null,null,0]};
  assert.deepEqual(calculate(legacy,{mode:"base",count:100}).totals,[null,null,null,0]);
  assert.equal(preferredText(legacy),"");
});

test("named basis with unknown mass, Russian labels, independent oil", () => {
  const dish = {name:"Тестовое блюдо",unit:"г",basis:"piece",pieceName:"яйцо",nut:[70,6,5,0.4]};
  for (const [count,label] of [[1,"1 яйцо"],[2,"2 яйца"],[5,"5 яиц"]]) assert.equal(describe("piece",count,dish,null),label);
  assert.deepEqual(calculate(dish,{mode:"piece",count:4}).totals,[280,24,20,1.6]);
  const oil = {grams:"5",nut:[900,0,100,0]};
  const meal = intake(dish,"piece",4,{oil});
  assert.equal(meal.amount,null);
  assert.deepEqual(meal.totals,[325,24,25,1.6]);
  assert.deepEqual(intake(dish,"piece",1,{oil}).totals,[115,6,10,0.4]);
  const db = {products:[{...dish,preferred:{mode:"piece",count:2}}],meals:[]};
  saveMeal(db,meal,dish,false);
  assert.equal(preferredText(db.products[0]),"2 яйца");
  db.products[0].nut=[80,8,4,1];
  assert.deepEqual(db.meals[0].totals,[325,24,25,1.6]);
  assert.throws(()=>calculate(dish,{mode:"base",count:50}));
  assert.throws(()=>calculate(dish,{mode:"piece",count:1,oil:{grams:5,nut:[null,0,100,0]}}));
  assert.equal(calculate({...dish,sizes:{piece:50}},{mode:"base",count:75}).totals[0],105);
  assert.throws(()=>calculate({...dish,basis:"100"},{mode:"piece",count:4}));
  assert.equal(calculate({...dish,basis:"100",sizes:{piece:50}},{mode:"piece",count:4}).totals[0],140);
});

test("one-off write and correction preserve catalog, recent ordinary meal and other day state", () => {
  const ordinary=intake(sample,"package",1);
  const db={products:[structuredClone(sample)],meals:[ordinary],foodComplete:{"2026-01-10":true}};
  const prior=JSON.stringify(db.products),different={...sample,nut:[120,10,4,11]};
  const meal={...intake(different,"base",150),oneOff:true,id:"single",date:"2026-01-10T14:20"};
  saveMeal(db,meal,different,false);
  assert.deepEqual(meal.totals,[180,15,6,16.5]);
  saveMeal(db,{...meal,...calculate(different,{mode:"base",count:100})},different,true);
  assert.deepEqual(db.meals[1].totals,[120,10,4,11]);
  assert.equal(db.meals.length,2);
  assert.equal(JSON.stringify(db.products),prior);
  assert.deepEqual(recent(db.meals,"2026-01-10"),[ordinary]);
  assert.deepEqual(db.foodComplete,{"2026-01-10":true});
  const single={meals:[]};
  saveMeal(single,meal,different,false);
  assert.ok(!Object.hasOwn(single,"products"));
  assert.deepEqual(recent(single.meals,"2026-01-10"),[]);
});

test("filter one-offs before limiting recent choices and include legacy meals", () => {
  const legacy = Array.from({length:5},(_,i)=>({name:"Запись "+i,date:"2026-01-01T10:0"+i,amount:100,unit:"г",nut:[1,2,3,4]}));
  const singles = legacy.map((m,i)=>({...m,name:"Разовая "+i,oneOff:true,date:"2026-01-02T10:00"}));
  assert.deepEqual(recent([...legacy,...singles],"2026-01-02"),legacy.slice().reverse());
});

test("correcting the amount of a legacy meal does not revert a newer card label", () => {
  const old = {name:"Напиток", unit:"мл", code:"", nut:[40,1,1,5]};
  const updated = {...old,nut:[50,1,1,6]};
  const db = {products:[updated],meals:[{...old,id:"m1",date:"2026-01-10T12:00",amount:250}]};
  saveMeal(db,intake(old,"base",150),old,true);
  assert.deepEqual(db.products,[updated]);
  assert.equal(db.meals.length,1);
  assert.equal(db.meals[0].totals[0],60);
});
