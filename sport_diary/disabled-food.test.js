"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const visibility=require("./web/visibility"),products=require("./web/supplement-products");
const reports=require("./web/reports"),health=require("./web/health"),healthView=require("./web/health-view");
const day="2026-02-14";

function fixture(){
  const state={profile:{supps:["Протеин"],equipment:[]},meals:[],supps:[],workouts:[]};
  products.saveEvent(state,{id:"shake",name:"Протеин",date:day+"T09:00",period:"Утро"});
  state.meals.push({id:"ordinary",name:"Протеиновый йогурт без добавки",date:day+"T12:00",amount:100,unit:"г",nut:[100,12,2,4]});
  state.meals.push({id:"legacy",name:"Связанный старый шейк",date:day+"T13:00",amount:100,unit:"мл",nut:[null,25,1,3]});
  state.supps.push({date:day+"T13:00",names:["Протеин"],mealId:"legacy",servings:1,perServing:[120,22,1,3]});
  state.products=[{name:"Рецепт порошка",productKind:"protein",unit:"г",nut:[400,75,4,10]}];
  return state;
}

function appContext(state){
  const elements=new Map();
  function field(id){
    if(!elements.has(id))elements.set(id,{value:"",hidden:false,innerHTML:"",checked:false,querySelector:()=>null});
    return elements.get(id);
  }
  const ctx=vm.createContext({document:{getElementById:field,querySelector:()=>null,addEventListener(){}},
    localStorage:{length:0},exerciseCatalog:require("./web/catalog.json"),foodWords:require("./web/food-words.json"),structuredClone,crypto:require("node:crypto").webcrypto,
    fetch:async url=>{if(url==="profiles")return new Promise(()=>{});throw Error("Unexpected request: "+url)}});
  const run=script=>vm.runInContext(script,ctx);
  for(const script of ["logic","visibility","foods","portions","supplement-products","supplement-view","goals","health","reports","goals-view","health-view","report-view","app"])
    run(fs.readFileSync(path.join(__dirname,"web",script+".js"),"utf8"));
  ctx.input=state;
  run('state=unpack({data:input});selectedDay="2026-02-14";tab=2;people=[{id:"person1"}];');
  return {run,field,ctx};
}

test("Отключённые рецепты и связанные порции скрыты, обычная еда и исторические итоги сохранены",()=>{
  const state=fixture(),before=structuredClone(state),report=()=>reports.diaryReport(state,[],"",day,"day","2026-02-15");
  const total=report();
  state.profile.supps=[];
  assert.deepEqual(state.meals.map(m=>visibility.food(state,m)),[false,true,false]);
  assert.equal(visibility.food(state,state.products[0]),false);
  assert.equal(visibility.food(state,{proteinDetails:{servings:1}}),false);
  assert.equal(visibility.food({profile:{},supps:[]},{productKind:"protein_mix"}),false);
  assert.deepEqual([report().kcal,report().nutrition,report().points],[total.kcal,total.nutrition,total.points]);
  assert.deepEqual(state.meals,before.meals);assert.deepEqual(state.supps,before.supps);
  const {run,field}=appContext(state);
  const diary=run('mealList(selectedDay)+recentPortions()');
  assert.match(diary,/Протеиновый йогурт без добавки/);
  assert.doesNotMatch(diary,/Связанный старый шейк|Первый Русский|Учтено в порции|Рецепт порошка/);
  run('results=[...state.products,...state.meals];showFoodMatches($("matches"),"",false)');
  assert.equal(run("results.length"),1);assert.match(field("matches").innerHTML,/Протеиновый йогурт/);
  const detail=run('intakeBody(diaryReport(state,[],"",selectedDay,"day","2026-02-15"))');
  assert.doesNotMatch(detail,/refine-meal-legacy|Связанный старый шейк|Порошок протеина/);
  const panels=healthView.panels({state,day,tab:2,profile:{id:"p1"},model:health});
  assert.match(panels,/Протеиновый йогурт/);assert.doesNotMatch(panels,/Связанный старый шейк|Первый Русский/);
  state.profile.supps=["Протеин"];
  assert.ok(state.meals.every(m=>visibility.food(state,m)));
  assert.deepEqual(state,before);
});

test("Старые формы не исправляют, не удаляют и не повторяют скрытый приём",async()=>{
  const state=fixture(),{run,field}=appContext(state);
  run('editingMeal="legacy";editingMealBase=JSON.stringify(state.meals[2])');
  field("product").value="Незавершённое исправление";
  field("product-kind").value="protein_mix";
  run('state.profile.supps=[];renderDiaryUpdate()');
  assert.equal(field("meal-form").hidden,true);
  assert.equal(field("unavailable-food").hidden,false);
  assert.equal(field("product").value,"Незавершённое исправление");
  assert.throws(()=>run('openMealEditor(state.meals[2])'),/отключ/);
  assert.throws(()=>run('selectFoodCard(state.products[0])'),/отключ/);
  for(const action of ["meal","remove-meal-legacy","repeat-meal-legacy"])
    await assert.rejects(run('action('+JSON.stringify(action)+')'),/отключ/);
  assert.equal(run("state.meals.length"),3);
  assert.equal(run("state.meals[2].amount"),100);
  run('state.profile.supps=["Протеин"];updateFoodAvailability()');
  assert.equal(field("meal-form").hidden,false);
  assert.equal(field("product").value,"Незавершённое исправление");
});

test("Незавершённый новый рецепт и личная карточка не сохраняются после отключения",async()=>{
  const {run,field}=appContext(fixture());
  run('state.profile.supps=[];readFoodCard=()=>({name:"Черновик",productKind:"protein",unit:"г",nut:[100,22,1,3]});readPersonalCard=readFoodCard;currentPortion=()=>({amount:100,totals:[100,22,1,3]});when=()=>selectedDay+"T14:00"');
  field("protein-dose").value="";
  await assert.rejects(run('action("meal")'),/отключ/);
  await assert.rejects(run('action("save-food-card")'),/отключ/);
  assert.equal(run("state.meals.length"),3);
  assert.equal(run("state.products.length"),1);
});

test("Форма окончания еды перепроверяет доступность связанного приёма",()=>{
  const state=fixture(),context={state,day,tab:2,profile:{id:"p1"},model:health,zone:"UTC"};
  const editor=healthView.editor(context,"meal","legacy"),before=structuredClone(state.meals);
  state.profile.supps=[];
  assert.throws(()=>editor.save(state,new Map([["kind","light"]])),/отключ/);
  assert.throws(()=>healthView.editor(context,"meal","legacy"),/отключ/);
  assert.deepEqual(state.meals,before);
  state.meals=state.meals.filter(m=>m.id!=="ordinary");
  assert.equal(healthView.panels(context),"");
});
