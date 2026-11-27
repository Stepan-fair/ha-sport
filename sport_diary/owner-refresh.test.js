"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

test("Открытый дневник перечитывает порции, сохраняет ввод и отбрасывает устаревшие ответы",async()=>{
  const day="2026-02-14", pending=[], elements=new Map();
  function field(id){
    if(!elements.has(id))elements.set(id,{innerHTML:"",value:"",querySelector:()=>null});
    return elements.get(id);
  }
  const ctx=vm.createContext({
    document:{getElementById:field,querySelector:()=>null,addEventListener(){}},
    localStorage:{length:0}, exerciseCatalog:require("./web/catalog.json"),
    foodWords:require("./web/food-words.json"),structuredClone,
    fetch:async (url,opts)=>{
      if(url==="profiles")return new Promise(()=>{});
      if(url.startsWith("weights/"))return {ok:true,json:async()=>[]};
      return new Promise(resolve=>pending.push({url,method:opts?.method||"GET",payload:opts?.body&&JSON.parse(opts.body),
        reply:(data,status=200)=>resolve({ok:status===200,status,json:async()=>data})}));
    }
  });
  const run=script=>vm.runInContext(script,ctx);
  for(const script of ["logic","visibility","foods","portions","supplement-products","supplement-view","goals","health","reports","goals-view","health-view","report-view","app"]){
    run(fs.readFileSync(path.join(__dirname,"web",script+".js"),"utf8"));
  }
  const badSensor=assert.rejects(run('request("health/person1",{refresh:true})'),/Уточните дату показания/);
  pending.shift().reply({error:"Уточните дату показания"},400);
  await badSensor;
  const tooLarge=assert.rejects(run('request("profile/person1",{data:{},rev:0})'),/размер/i);
  pending.shift().reply({},413);await tooLarge;
  const meal=(id,kcal)=>({id,date:day+"T10:00",name:id,amount:100,unit:"г",nut:[kcal,0,0,0],totals:[kcal,0,0,0]});
  const original={rev:1,data:{meals:[meal("a",400)]}};
  const incoming={rev:2,data:{meals:[...original.data.meals,meal("b",350)]}};
  ctx.original=original;
  run('selectedDay="2026-02-14"; tab=2; state=unpack(original); rev=original.rev; renderDiaryUpdate()');
  assert.match(field("food-diary").innerHTML,/400 ккал/);
  field("product").value="Черновик";
  field("query").value="творог";
  async function refresh(result){
    const task=run("recoverDiary()");
    assert.equal(pending.length,1);
    const {url,reply}=pending.shift();
    assert.equal(url,"profile/person1");reply(result);
    await task;
  }
  run('people=[{id:"person1",name:"Первый"}]');
  await refresh(incoming);
  assert.match(field("food-diary").innerHTML,/750 ккал/);
  assert.match(field("health-panels").innerHTML,/Отметить окончание/);
  await refresh(incoming);
  assert.equal(run("state.meals.length"),2);
  assert.equal(field("product").value,"Черновик");
  assert.equal(field("query").value,"творог");

  const measured={daily:[{metric:"steps",date:day,unit:"steps",value:5123,source:"test",receivedAt:day+"T19:00Z"}],sleep:[]};
  await refresh({...incoming,data:{...incoming.data,healthImported:measured}});
  assert.equal(run("state.healthImported.daily[0].value"),5123);
  assert.equal(field("product").value,"Черновик");
  const change=run('commit(s=>s.profile.minutes=42)');
  const saving=pending.shift();
  assert.equal(saving.method,"POST");
  assert.equal(Object.hasOwn(saving.payload.data,"healthImported"),false);
  saving.reply({rev:3});await change;
  assert.equal(run("state.healthImported.daily[0].value"),5123);

  // A delayed GET cannot roll back a newer local save or repopulate another profile.
  await refresh(original);
  assert.equal(run("rev"),3);
  run('editingMeal="b"; editingMealBase=JSON.stringify(state.meals[1])');
  await refresh({rev:4,data:{meals:[original.data.meals[0],meal("b",500)]}});
  await assert.rejects(run('action("meal")'),/Порция изменилась/);
  assert.equal(pending.length,0);
  const delayed=run("recoverDiary()");
  run('who="person2";profileGeneration++;rev=1;state=initial()');
  pending.shift().reply({...incoming,rev:3});
  await delayed;
  assert.equal(run("state.meals.length"),0);
  assert.equal(run("rev"),1);
  run('who="person1";profileGeneration++');
  const previousVisit=run("recoverDiary()");
  run('who="person2";profileGeneration++;who="person1";profileGeneration++');
  pending.shift().reply({...incoming,rev:5});
  await previousVisit;
  assert.equal(run("rev"),1);

  const conflict=assert.rejects(run('commit(s=>s.profile.minutes=60)'),/Профиль изменён/);
  assert.equal(pending[0].method,"POST");
  pending.shift().reply({},409);
  await new Promise(setImmediate);
  assert.equal(pending[0].method,"GET");
  pending.shift().reply(incoming);
  await conflict;
  assert.match(field("food-diary").innerHTML,/750 ккал/);
  assert.equal(field("product").value,"Черновик");
  assert.equal(run("rev"),2);
});
