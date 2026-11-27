"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const P=require("./web/supplement-products"),R=require("./web/reports"),G=require("./web/goals"),Portions=require("./web/portions");
const d="2026-11-20",state=()=>({profile:{supps:[...P.names]},supps:[],meals:[],weights:[],workouts:[]});
const event=(id,name="Протеин",extra={})=>({id,name,date:d+"T09:00",period:"Утро",...extra});
const approx=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
function total(s,day=d){return R.nutritionForDay(s,day)}
test("Three independent shakes in the same period; replay is idempotent; deletion affects one meal only",()=>{
 const s=state();for(const id of ["a","b","c"])P.saveEvent(s,event(id));P.saveEvent(s,event("b"));
 assert.equal(s.supps.length,3);assert.equal(s.meals.length,3);
 const n=total(s);[868.56,92.5965,31.2,55.2075].forEach((v,i)=>approx(n.totals[i],v));
 assert.equal(n.doses.proteinEvents,3);assert.equal(n.doses.proteinServings,3);approx(n.doses.powderGrams,90);approx(n.doses.proteinGrams,65.25);approx(n.doses.milkMl,900);approx(n.doses.milkProtein,27.3465);
 P.removeEvent(s,"b");approx(total(s).totals[0],579.04);assert.deepEqual(s.supps.map(e=>e.id),["a","c"]);
});
test("One event can contain two sachets while count of events remains one",()=>{const s=state();P.saveEvent(s,event("a","Протеин",{servings:2}));assert.equal(total(s).doses.proteinEvents,1);assert.equal(total(s).doses.proteinServings,2);approx(total(s).totals[0],579.04)});
test("Water correction of only the second shake; ordinary recipe and adjacent snapshots remain unchanged",()=>{
 const s=state();for(const id of ["a","b","c"])P.saveEvent(s,event(id));const recipe=P.recipeFor(s,"Протеин",d);recipe.milk.ml=0;
 P.saveEvent(s,event("b","Протеин",{edit:true,recipe}));[704.79,83.481,23.475,40.53].forEach((v,i)=>approx(total(s).totals[i],v));assert.equal(P.recipeFor(s,"Протеин",d).milk.ml,300);
});
test("Dated recipe baselines keep backdated events and existing snapshots independent between profiles",()=>{
 const s=state(),other=state(),old=P.saveEvent(s,event("a")),saved=JSON.stringify(old);const r=P.recipeFor(s,"Протеин",d);r.milk.ml=200;P.saveRecipe(s,"Протеин","2026-11-21",r);
 assert.equal(JSON.stringify(s.supps[0]),saved);assert.equal(P.recipeFor(s,"Протеин",d).milk.ml,300);assert.equal(P.recipeFor(other,"Протеин","2026-11-22").milk.ml,300);
 P.saveEvent(s,event("b","Протеин",{date:"2026-11-22T09:00"}));assert.equal(s.supps[1].productSnapshot.milkMl,200);
 P.saveEvent(s,event("c"));assert.equal(s.supps[2].productSnapshot.milkMl,300);
});
test("Editing and deleting the meal side changes exactly its linked event and period totals",()=>{
 const s=state();P.saveEvent(s,event("a"));P.saveEvent(s,event("b"));const m=s.meals[0];
 const updated={...m,date:"2026-11-21T19:00",...Portions.calculate(m,{mode:"piece",count:2}),proteinDetails:{servings:2,powderGrams:60,proteinGrams:43.5}};
 Portions.saveMeal(s,updated,m,true);P.syncFromMeal(s,updated);assert.equal(s.supps[0].period,"Вечер");approx(total(s).totals[0],289.52);approx(total(s,"2026-11-21").totals[0],579.04);assert.equal(total(s,"2026-11-21").doses.milkMl,600);
 R.removeMealIntake(s,updated.id);assert.equal(s.supps.length,1);assert.equal(s.supps[0].id,"b");assert.equal(s.meals.length,1);
});
test("Editing event date keeps the meal linked and recomputes day/week/month/year",()=>{
 const s=state();P.saveEvent(s,event("a"));P.saveEvent(s,event("a","Протеин",{edit:true,date:"2026-10-31T10:00",servings:2}));
 assert.equal(s.meals[0].date,"2026-10-31T10:00");assert.equal(total(s).count,0);
 for(const period of ["day","week","month","year"]){const r=R.diaryReport(s,[],"","2026-10-31",period,"2026-11-27");approx(r.nutrition.known[0],579.04);assert.equal(r.doses.proteinEvents,1)}
});
test("Existing full shake links without adding calories; only-milk linking adds powder once",()=>{
 const s=state();s.meals.push({id:"old",name:"Мой шейк",date:d+"T09:00",amount:300,totals:[300,32,11,19],productKind:"protein_mix",proteinDetails:{servings:1,powderGrams:30,proteinGrams:21.75}});
 P.saveEvent(s,event("a","Протеин",{mealId:"old",linkMode:"complete"}));assert.equal(s.meals.length,1);approx(total(s).totals[0],300);approx(total(s).doses.proteinGrams,21.75);
 const t=state();t.meals.push({id:"milk",name:"Молоко",date:d+"T09:00",amount:309,totals:[163.77,9.1155,7.725,14.6775]});
 P.saveEvent(t,event("a","Протеин",{mealId:"milk",linkMode:"milk"}));P.saveEvent(t,event("a","Протеин",{mealId:"milk",linkMode:"milk"}));assert.equal(t.meals.length,1);approx(total(t).totals[0],289.52);
 assert.throws(()=>P.saveEvent(t,event("b","Протеин",{mealId:"milk"})),/уже связана/);
});
test("Two creatine portions separate powder, monohydrate and active; approx zero does not create food or unknown protein",()=>{
 const s=state();P.saveEvent(s,event("a","Креатин"));P.saveEvent(s,event("b","Креатин"));const n=total(s);assert.equal(n.count,0);assert.deepEqual(n.missing,[0,0,0,0]);assert.equal(n.doses.creatinePowderGrams,6);assert.equal(n.doses.creatineMonohydrateGrams,5.2);assert.equal(n.doses.creatineActiveGrams,4.576);assert.deepEqual(s.supps[0].productSnapshot.recipe.label,[null,null,null,null]);
 s.meals.push({id:"food",name:"Еда",date:d,amount:100,totals:[100,10,1,2]});assert.deepEqual(total(s).totals,[100,10,1,2]);assert.equal(R.diaryReport(s,[],"",d,"day","2026-11-27").foodDays,1);
});
test("Omega records manufacturer energy and nested active components without double-counting fat",()=>{
 const s=state();P.saveEvent(s,event("o","Омега-3",{servings:2}));assert.deepEqual(total(s).totals,[20,.4,2.6,0]);assert.equal(total(s).doses.omegaMg,1900);assert.equal(total(s).doses.epaMg,1100);assert.equal(total(s).doses.dhaMg,460);assert.equal(total(s).doses.fishOilMg,2600);assert.equal(R.diaryReport(s,[],"",d,"day","2026-11-27").foodDays,0);
});
test("Ferromalt normal and one-off dose, network replay, dated concentration and disabled profiles",()=>{
 const s=state();P.saveEvent(s,event("f","Ферромальт"));P.saveEvent(s,event("f","Ферромальт"));let n=total(s);assert.equal(n.doses.ironEvents,1);assert.equal(n.doses.ironDrops,40);assert.equal(n.doses.ironMl,2);assert.equal(n.doses.ironMg,100);
 P.saveEvent(s,event("g","Железо",{drops:20}));n=total(s);assert.equal(n.doses.ironEvents,2);assert.equal(n.doses.ironMg,150);assert.equal(P.recipeFor(s,"Железо",d).drops,40);
 const r=P.recipeFor(s,"Железо",d);r.ironMgPerMl=25;P.saveRecipe(s,"Железо","2026-11-21",r);assert.equal(s.supps[0].productSnapshot.ironMg,100);
 P.saveEvent(s,event("h","Железо",{date:"2026-11-22T09:00"}));assert.equal(total(s,"2026-11-22").doses.ironMg,50);
 P.setAvailability(s,"2026-11-23",["Протеин"]);assert.throws(()=>P.saveEvent(s,event("stale","Железо")),/отключена/);assert.equal(s.supps.length,3);
 const second=state();second.profile.supps=[];assert.throws(()=>P.saveEvent(second,event("f","Ферромальт")),/отключена/);
});
test("Disabling preserves nutrition facts and dated plans; reenabling restores existing events",()=>{
 const s=state();P.saveEvent(s,event("a"));P.setAvailability(s,"2026-11-21",[]);approx(total(s).totals[0],289.52);assert.deepEqual(P.availableOn(s,d),P.names);assert.deepEqual(P.availableOn(s,"2026-11-22"),[]);assert.throws(()=>P.saveEvent(s,event("b")),/отключена/);P.setAvailability(s,"2026-11-23",["Протеин"]);assert.equal(s.supps.length,1);assert.equal(P.enabled(s,"Протеин"),true);
});
test("Legacy unknown product is never reinterpreted; targets compare only matching substance",()=>{
 const s=state();s.supps.push({date:d,names:["Креатин"],servings:1,creatinePerServing:3});G.setCreatine(s,d,true,3,3,"active");
 let r=R.diaryReport(s,[],"",d,"day","2026-11-27");assert.equal(r.nutritionGoals.creatine.comparedDays,0);assert.equal(r.nutritionGoals.rows[0].creatine.missing,1);
 G.setCreatine(s,d,true,3,3,"legacy");r=R.diaryReport(s,[],"",d,"day","2026-11-27");assert.equal(r.nutritionGoals.creatine.actual,3);
 const t=state();P.saveEvent(t,event("a","Креатин"));G.setCreatine(t,d,true,3,3,"powder");r=R.diaryReport(t,[],"",d,"day","2026-11-27");assert.equal(r.nutritionGoals.creatine.actual,3);G.setCreatine(t,d,true,2.288,3,"active");approx(R.diaryReport(t,[],"",d,"day","2026-11-27").nutritionGoals.creatine.actual,2.288);
});
test("Dose increase creates no extra points and no derived iron treatment target",()=>{
 const s=state();P.saveEvent(s,event("a","Железо"));const points=R.diaryReport(s,[],"",d,"day","2026-11-27").points;P.saveEvent(s,event("a","Железо",{edit:true,drops:80}));assert.equal(R.diaryReport(s,[],"",d,"day","2026-11-27").points,points);assert.equal(s.ironGoals,undefined);
});
test("Label unit conversion model is exact; zero-milk recipe and independently altered brand remain local",()=>{
 const s=state(),r=P.recipeFor(s,"Протеин",d);r.milk.basis="100ml";r.milk.label=r.milk.label.map(v=>v*1.03);r.powderBasis="serving";r.powderLabel=[125.75,21.75,2.675,3.725];P.saveRecipe(s,"Протеин",d,r);approx(P.snapshot("Протеин",r,1).totals[0],289.52);assert.throws(()=>P.saveRecipe(s,"Железо",d,{...P.recipeFor(s,"Железо",d),dropsPerMl:0}),/Проверь/);
});
test("Moving a meal-corrected snapshot does not silently restore the earlier recipe",()=>{
 const s=state();P.saveEvent(s,event("a"));const m=s.meals[0];m.totals=[320,33,12,20];m.baseTotals=[...m.totals];P.syncFromMeal(s,m);
 P.saveEvent(s,event("a","Протеин",{edit:true,date:"2026-11-21T09:00"}));assert.deepEqual(total(s,"2026-11-21").totals,[320,33,12,20]);
 P.saveEvent(s,event("a","Протеин",{edit:true,date:"2026-11-21T09:00",servings:2}));assert.deepEqual(total(s,"2026-11-21").totals,[640,66,24,40]);
});
test("A month with different creatine target substances keeps distinct totals",()=>{
 const s=state();P.saveEvent(s,event("a","Креатин"));P.saveEvent(s,event("b","Креатин",{date:"2026-11-21T09:00"}));
 G.setCreatine(s,d,true,3,3,"powder");G.setCreatine(s,"2026-11-21",true,2.288,3,"active");
 const c=R.diaryReport(s,[],"","2026-11-21","month","2026-11-27").nutritionGoals.creatine;
 assert.equal(c.actual,null);assert.equal(c.percent,null);assert.equal(c.bySubstance.length,2);assert.equal(c.bySubstance[0].actual,3);approx(c.bySubstance[1].actual,2.288);
});
test("Linking 200 ml or 206 g of existing milk preserves actual milk volume and mass",()=>{
 for(const [unit,amount] of [["мл",200],["г",206]]){
  const s=state();s.meals.push({id:"milk",name:"Молоко",date:d,unit,amount,totals:[109.18,6.077,5.15,9.785]});
  P.saveEvent(s,event("a","Протеин",{mealId:"milk",linkMode:"milk"}));assert.equal(s.supps[0].productSnapshot.milkMl,200);assert.equal(s.supps[0].productSnapshot.milkGrams,206);assert.equal(s.meals[0].amount,236);approx(total(s).totals[0],234.93);
  assert.equal(s.supps[0].productSnapshot.recipe.milk.ml,200);assert.equal(P.recipeFor(s,"Протеин",d).milk.ml,300);
 }
 const s=state();s.meals.push({id:"milk",name:"Молоко",date:d,totals:[109.18,6.077,5.15,9.785]});
 P.saveEvent(s,event("a","Протеин",{mealId:"milk",linkMode:"milk"}));assert.equal(s.supps[0].productSnapshot.milkMl,null);assert.equal(total(s).doses.milkMlUnknown,1);approx(total(s).totals[0],234.93);
});
test("Invalid dates, periods and links leave the entire state unchanged",()=>{
 const s=state();P.saveEvent(s,event("a"));
 for(const bad of [event("b","Протеин",{date:d+"T99:99"}),event("b","Протеин",{period:"whatever"}),event("b","Протеин",{mealId:s.meals[0].id})]){
  const before=JSON.stringify(s);assert.throws(()=>P.saveEvent(s,bad));assert.equal(JSON.stringify(s),before);
 }
});
test("An actual calendar day and period can be recorded without inventing an exact clock",()=>{
 const s=state();P.saveEvent(s,event("a","Протеин",{date:d,period:"День"}));assert.equal(s.supps[0].date,d);assert.equal(s.meals[0].date,d);P.syncFromMeal(s,s.meals[0]);assert.equal(s.supps[0].period,"День");
 const before=JSON.stringify(s);assert.throws(()=>P.saveEvent(s,event("b","Протеин",{mealId:"deleted"})));assert.equal(JSON.stringify(s),before);
});
