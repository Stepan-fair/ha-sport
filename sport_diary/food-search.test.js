"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const {localFoods, importedFood, distinctFoods, rankedFoods, providerFoodQuery}=require("./web/foods.js");

test("Опечатки, синонимы, бренд, точная жирность и размер упаковки",()=>{
  const find=q=>localFoods(q,[],[]);
  for(const query of ["тврог","тварог","твоорг"]) assert.deepEqual(find(query),find("творог"));
  assert.equal(find("кАрТоШкА варёная")[0].name,"Картофель отварной");
  assert.equal(find("сельдь")[0],find("селёдка")[0]);
  assert.equal(find("простоквашнио творог 5% 0,2 кг")[0].code,"4600605029312");
  assert.equal(find("кефир 5%").length,0);
  assert.equal(find("творог 8%").length,0);
  assert.equal(find("творог 5% 180г").length,2);
  assert.equal(find("творог 5% 200 мл").length,0);
  assert.equal(find("4600605029313").length,0);
  assert.deepEqual(find("4600605029343")[0].nut,[99,17,2,3.3]);
  assert.equal(providerFoodQuery("тварог Простоквашино"),"творог простоквашино");
});

test("Разовое питание исключается до удаления повторов и ограничения выдачи",()=>{
  const kept={name:"Суп с горохом", code:"00123456", nut:[41,2,1,6]};
  const meal={...kept,nut:[55,2,2,8]};
  const single={...kept,nut:[80,4,2,9],oneOff:true};
  const others=Array.from({length:45},(_,i)=>({...single,name:"Суп "+i,code:""}));
  const all=localFoods("суп",[kept],[meal,single,...others]);
  assert.deepEqual(distinctFoods(all,1),[kept]);
  assert.deepEqual(localFoods("00123456",[],[single]),[]);
  assert.deepEqual(localFoods("суп",[],[...others,meal]),[meal]);
  assert.deepEqual(distinctFoods([single,meal,kept],1),[meal]);
  assert.deepEqual(rankedFoods("горох суп", [kept]),[kept]);
});

test("Выбор по данным OFF сохраняет основание КБЖУ и исключает чужой штрихкод",()=>{
  const item={product_name_ru:"Кефир 2,5%",brands:"Тест",code:"00123456",quantity:"900 мл",
    nutriments:{"energy-kcal_100g":51,proteins_100g:3,fat_100g:2.5,carbohydrates_100g:4}};
  const gram=importedFood({...item,nutrition_data_per:"100g"});
  const ml=importedFood({...item,nutrition_data_per:"100ml"});
  assert.equal(gram.unit,"г");
  assert.equal(ml.unit,"мл");
  assert.deepEqual(gram.nut,[51,3,2.5,4]);
  assert.deepEqual(rankedFoods("кефир 2,5% 0.9 л",[gram]),[gram]);
  assert.deepEqual(rankedFoods("кефир 5%",[gram]),[]);
  assert.deepEqual(rankedFoods("00123457",[gram]),[]);
});

test("Энергия из Open Food Facts учитывается один раз на указанное основание",()=>{
  const {calculate}=require("./web/portions.js");
  const item={product_name:"Йогурт",nutrition_data_per:"100ml"};
  const card=nutriments=>importedFood({...item,nutriments});
  for(const key of ["energy-kj_100g","energy_100g"]){
    const food=card({[key]:"418.4"});
    assert.equal(food.unit,"мл");
    assert.equal(food.nut[0],100);
    assert.equal(calculate(food,{mode:"base",count:50}).totals[0],50);
  }
  for(const kcal of [0,93]){
    assert.equal(card({"energy-kcal_100g":kcal,"energy-kj_100g":418.4}).nut[0],kcal);
  }
  assert.equal(card({"energy-kj_100g":0}).nut[0],0);
  assert.equal(card({"energy-kj_serving":418.4,"energy-kcal_100g":" "}).nut[0],null);
});

test("Подсказки появляются при вводе, старый ответ отбрасывается при смене текста, профиля или дня",async()=>{
  const js=name=>fs.readFileSync(path.join(__dirname,"web",name),"utf8");
  const app=js("app.js"), events={}, requests=[];
  let timer;
  const widgets={query:{id:"query",value:""},matches:{innerHTML:"",replaceChildren(){this.innerHTML=""}}};
  const context=vm.createContext({
    foodWords:require("./web/food-words.json"), who:"person1", selectedDay:"2026-01-20",
    state:{products:[],meals:[]}, results:[], $:id=>widgets[id], val:id=>widgets[id].value,
    document:{addEventListener:(type,callback)=>{events[type]=callback}},
    esc:String, btn:(name,label)=>label, SportPortions:{preferredText:()=>""},
    clearTimeout:()=>{timer=null}, setTimeout:callback=>{timer=callback;return 1},
    request:url=>new Promise(resolve=>requests.push({url,resolve})),
  });
  vm.runInContext(js("foods.js"),context);
  vm.runInContext(app.slice(app.indexOf("let foodSearchId="),app.indexOf("function mealList(")),context);
  const type=q=>{widgets.query.value=q;events.input({target:widgets.query})};
  for(const change of ["query","who","selectedDay","panel"]){
    type("тварог");
    assert.match(widgets.matches.innerHTML,/Творог 5%/);
    const before=requests.length;
    timer();
    assert.equal(requests.length,before+1);
    if(change==="query") type("кефир");
    if(change==="who") context.who="person2";
    if(change==="selectedDay") context.selectedDay="2026-01-21";
    if(change==="panel") widgets.matches={innerHTML:"Новый экран"};
    const visible=widgets.matches.innerHTML;
    requests.at(-1).resolve({status:"ready",products:[{name:"Устаревшее совпадение",catalogItem:true}]});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(widgets.matches.innerHTML,visible);
    assert.ok(!context.results.some(row=>row.name==="Устаревшее совпадение"));
  }
  type("банан");
  const before=requests.length;
  context.who="person1";
  timer();
  assert.equal(requests.length,before);
});
