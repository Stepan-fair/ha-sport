"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function form(responses) {
  const fields = new Map();
  function element(){
    const node=Object.assign(new EventTarget(),{value:"",children:[],focus(){},reset(){},
      replaceChildren(...children){this.children=children;},append(child){this.children.push(child);}});
    Object.defineProperty(node,"valueAsNumber",{get(){return this.value===""?NaN:Number(this.value);}});
    return node;
  }
  function field(id) {
    if (!fields.has(id)) fields.set(id,element());
    return fields.get(id);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "web/assistant.js"), "utf8"), {
    document:{getElementById:field, createElement:element,querySelectorAll:()=>[field("refresh-availability")]}, location:{pathname:"/"},
    crypto:require("node:crypto").webcrypto,SportPortions:require("./web/portions.js"),
    distinctFoods:require("./web/foods.js").distinctFoods,
    sessionStorage:{getItem:()=>responses&&typeof responses!=="function" ? "pending" : null, removeItem(){}, setItem(){}},
    fetch:(key,opts) => responses ? Promise.resolve({ok:true,json:async()=>typeof responses==="function"?responses(key,opts):responses[key]}) : new Promise(() => {})
  });
  field("mode").value = "base";
  field("basis").value = "100";
  field("unit").value = "г";
  const nutrients = [0,1,2,3].map(i => field("nut" + i));
  ["157","12.7","11.5","0.8"].forEach((value, i) => { nutrients[i].value = value; });
  function change(id, value) { field(id).value = value; field(id).dispatchEvent(new Event("change")); }
  return {field, change, values:() => nutrients.map(input => input.value)};
}

test("Помощник вводит КБЖУ на яйцо заново при смене основания с 100 г", () => {
  const {field, change, values} = form();
  field("oil0").value = "900";
  change("mode", "piece");
  assert.deepEqual(values(), ["157","12.7","11.5","0.8"]);
  change("basis", "piece");
  assert.deepEqual(values(), ["","","",""]);
  assert.equal(field("oil0").value, "900");
});

test("Подпись КБЖУ отделяет основание этикетки от количества съеденной порции",()=>{
  const {field,change}=form();
  const refresh=()=>field("assistant-form").dispatchEvent(new Event("input"));
  field("name").value="Продукт";field("count").value="200";
  refresh();
  assert.equal(field("nutrition-basis").textContent,"КБЖУ продукта на 100 г");
  assert.match(field("assistant-preview").textContent,/В съеденной порции · 314 ккал/);
  field("unit").value="мл";refresh();
  assert.equal(field("nutrition-basis").textContent,"КБЖУ продукта на 100 мл");
  change("mode","piece");change("basis","piece");field("piece").value="яйцо";
  field("count").value="4";
  [70,6,5,0].forEach((v,i)=>field("nut"+i).value=String(v));refresh();
  assert.equal(field("nutrition-basis").textContent,"КБЖУ продукта на 1 яйцо");
  assert.match(field("assistant-preview").textContent,/В съеденной порции · 280 ккал · 24 г белка/);
});

test("Выбор йогурта очищает масло и пометки яичницы в предпросмотре и запросе", async () => {
  const day="2026-02-14", sent=[];
  const card={name:"Йогурт",unit:"г",nut:[60,3,2,6],preferred:{mode:"base",count:100}};
  const {field}=form((key,opts)=>{
    if(key==="nutrition/context")return {today:day};
    if(key==="nutrition/cards?q=")return [card];
    if(key==="nutrition/meals"){
      sent.push(JSON.parse(opts.body)); return {id:"y"};
    }
    const meal={...card,id:"y",amount:100,date:day+"T09:00",totals:card.nut};
    if(key==="nutrition/meals/y")return meal;
    return {day,meals:[],totals:[0,0,0,0]};
  });
  await new Promise(setImmediate);
  field("time").value="09:00";
  field("oil").value="5";field("oil").dispatchEvent(new Event("input"));
  [900,0,100,0].forEach((v,i)=>field("oil"+i).value=String(v));
  field("estimate").value="Яичница по фото";field("one-off").checked=true;
  field("search-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  field("card-results").children[0].dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.equal(field("oil").value,"");
  for(let i=0;i<4;i++){assert.equal(field("oil"+i).value,"");assert.equal(field("oil"+i).required,false);}
  assert.match(field("assistant-preview").textContent,/60 ккал/);
  field("assistant-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(sent.length,1);
  assert.equal(sent[0].oil,undefined);
  assert.equal(sent[0].estimateNote,"");
  assert.equal(sent[0].oneOff,false);
  assert.equal(sent[0].date,day+"T09:00");
  assert.equal(require("./web/portions.js").calculate(sent[0],sent[0]).totals[0],60);
});

test("Помощник не переносит КБЖУ, массу порции и массу штуки в миллилитры", () => {
  const {field, change, values} = form();
  field("size").value = "125"; field("piece-size").value = "60"; field("count").value = "120";
  change("unit", "мл");
  assert.deepEqual(values(), ["","","",""]);
  for (const id of ["size", "piece-size", "count"]) assert.equal(field(id).value, "");
});

test("Ввод нового названия вручную очищает сведения о предыдущем блюде", () => {
  const {field,change,values}=form();
  change("name","Яичница");
  field("time").value="09:25";
  field("oil").value="5";field("oil0").value="900";field("estimate").value="по фото";
  field("name").value="Йогурт";field("name").dispatchEvent(new Event("input"));
  assert.equal(field("name").value,"Йогурт");
  assert.equal(field("time").value,"09:25");
  assert.deepEqual(values(),["","","",""]);
  for(const id of ["oil","oil0","estimate"])assert.equal(field(id).value,"");
});

test("Перечитанная порция показывает масло, а суточная сводка сохраняет известные КБЖУ", async () => {
  const day = "2026-02-14";
  const meal = {id:"nutrition-pending", date:day+"T08:00", name:"Омлет", amount:200, unit:"г",
    totals:[500, 15, 10, 0], oil:{grams:5, nut:[900, 0, 100, 0]}};
  const {field} = form({
    "nutrition/context":{today:day, zone:"MSK"},
    "nutrition/meals/nutrition-pending":meal,
    ["nutrition/days/"+day]:{day, meals:[meal], count:2, totals:[null,37,null,null],
      known:[500,37,10,0], missing:[1,0,1,1], supplementProtein:{grams:22,incomplete:false}, complete:false, maintenance:null}
  });
  await new Promise(setImmediate);
  const summary = field("summary").children.map(node => node.textContent).join("\n");
  assert.match(summary, /500 ккал[^·]*неизвестн/);
  assert.match(summary, /0 г углеводов[^·]*неизвестн/);
  assert.match(summary, /Белок из добавок.*22 г/);
  assert.match(field("receipt").textContent, /[Мм]асло.*5 г.*45 ккал/);
});

test("Отключённый протеин скрывает выбор и блокирует старую форму без потери введённых значений",async()=>{
  const day="2026-02-14",sent=[],proposals=[];let enabled=true;
  const {field,change}=form((key,opts)=>{
    if(key==="nutrition/context")return {today:day,proteinEnabled:enabled};
    if(key.startsWith("nutrition/protein-doses/"))return [{id:"dose",time:"09:00",servings:1}];
    if(key==="nutrition/meals"){sent.push(JSON.parse(opts.body));return {id:"saved"};}
    if(key==="nutrition/proposals"){proposals.push(JSON.parse(opts.body));return {id:"proposal"};}
    if(key==="nutrition/meals/saved")return {id:"saved",name:"Шейк",date:day+"T10:00",amount:100,unit:"г",totals:[157,12.7,11.5,.8]};
    return {day,meals:[],totals:[0,0,0,0]};
  });
  await new Promise(setImmediate);
  assert.equal(field("product-kind-label").hidden,false);
  field("name").value="Шейк";field("count").value="100";field("time").value="10:00";
  change("product-kind","protein_mix");
  await new Promise(setImmediate);
  field("protein-servings").value="1";field("protein-dose").value="dose";
  enabled=false;
  field("assistant-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(sent.length,0);
  assert.equal(field("product-kind-label").hidden,true);
  assert.equal(field("protein-fields").hidden,true);
  assert.equal(field("assistant-form").hidden,true);
  assert.equal(field("unavailable-food").hidden,false);
  assert.equal(field("name").value,"Шейк");assert.equal(field("protein-dose").value,"dose");
  field("preference-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(sent.length,0);assert.equal(proposals.length,0);assert.match(field("message").textContent,/отключ/);
  enabled=true;
  field("refresh-availability").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.equal(field("assistant-form").hidden,false);
  assert.equal(field("protein-servings").value,"1");assert.equal(field("protein-dose").value,"dose");
  field("preference-mode").value="base";field("preference-count").value="100";field("preference-reason").value="Обычная порция";
  field("preference-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(proposals.length,1);assert.equal(proposals[0].card.productKind,"protein_mix");
  field("assistant-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(sent.length,1);assert.equal(sent[0].productKind,"protein_mix");assert.equal(sent[0].linkDoseId,"dose");
});

test("Помощник сохраняет черновик поправки связанного приёма, когда владелец отключает категорию",async()=>{
  const day="2026-02-14",sent=[];let enabled=true;
  const meal={id:"linked",version:"v",name:"Связанный напиток",date:day+"T10:00",amount:100,unit:"г",totals:[100,22,1,3]};
  const {field,change}=form((key,opts)=>{
    if(key==="nutrition/context")return {today:day,proteinEnabled:enabled};
    if(key==="nutrition/proposals"){sent.push(JSON.parse(opts.body));return {id:"proposal"};}
    return {day,meals:enabled?[meal]:[],totals:[100,22,1,3]};
  });
  await new Promise(setImmediate);
  change("proposal-meal","linked");field("proposal-count").value="150";field("proposal-reason").value="Уточнён объём";
  enabled=false;
  field("correction-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(sent.length,0);assert.equal(field("correction-form").hidden,true);
  assert.equal(field("proposal-count").value,"150");assert.equal(field("proposal-reason").value,"Уточнён объём");
  assert.doesNotMatch(field("summary").children.map(n=>n.textContent).join(" "),/Связанный напиток/);
  enabled=true;
  field("refresh-availability").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.equal(field("correction-form").hidden,false);assert.equal(field("proposal-meal").value,"linked");
  assert.equal(field("proposal-count").value,"150");
  field("correction-form").dispatchEvent(new Event("submit"));
  await new Promise(setImmediate);
  assert.equal(sent.length,1);assert.equal(sent[0].changes.count,150);
});

test("Первое открытие с отключённым протеином оставляет обычную еду доступной",async()=>{
  const {field}=form(key=>key==="nutrition/context"?{today:"2026-02-14",proteinEnabled:false}:{meals:[],totals:[0,0,0,0]});
  await new Promise(setImmediate);
  assert.equal(field("product-kind-label").hidden,true);
  assert.equal(field("protein-fields").hidden,true);
  assert.equal(field("assistant-form").hidden,false);
});
