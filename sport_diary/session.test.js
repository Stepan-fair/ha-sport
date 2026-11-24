const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
test("Старт, изменение числа подходов, отмена и сохранение по профилю",async()=>{
 const entries=new Map(),drafts=new Map(),nodes=new Map();
 function node(id){if(!nodes.has(id))nodes.set(id,{value:"",innerHTML:"",dataset:{}});return nodes.get(id)}
 const ctx=vm.createContext({document:{getElementById:node,querySelector:node,querySelectorAll:()=>[],addEventListener(){}},
    crypto:require("crypto"),localStorage:{get length(){return drafts.size},key:i=>[...drafts.keys()][i],removeItem:k=>drafts.delete(k),getItem:k=>drafts.get(k),setItem:(k,v)=>drafts.set(k,v)},confirm:()=>true,structuredClone,
    fetch:async(p,o)=>({ok:true,json:async()=>{
      if(p==="profiles")return [{id:"person1",name:"Первый"},{id:"person2",name:"Второй"}];
      if(p.startsWith("weight")) return [];
      if(o?.body){const b=JSON.parse(o.body);entries.set(p,{data:b.data,rev:b.rev+1})}
      return entries.get(p)||{data:{},rev:0};
    }})});
 ctx.exerciseCatalog=require("./web/catalog.json");
 ctx.exercisePhotoBase="photos/";
 for(const f of ["logic.js","app.js"])vm.runInContext(fs.readFileSync(path.join(__dirname,"web",f),"utf8"),ctx);
 const run=s=>vm.runInContext(s,ctx);
 await run("load()");
 run('selectDay("2026-01-01")');
 node("start").value="2026-01-01T10:00";
 await run('action("start")');const n=run("draft.exercises[0].sets.length");
 await run('action("add-0")');assert.equal(run("draft.exercises[0].sets.length"),n+1);
 await run('action("sub-0")');assert.equal(run("draft.exercises[0].sets.length"),n);
 await run('action("cancel")');assert.equal(run("draft"),null);assert.equal(entries.size,0);
 await run('action("start")');node("end").value="2026-01-01T11:00";
 run('draft.end=$("end").value;draft.exercises[0].sets[0].done=true');
 const original=run("draft.exercises[0].name");
 await run('action("down-0")');
 assert.equal(run("draft.exercises[1].name"),original);
 assert.equal(run("draft.exercises[1].sets[0].done"),true);
 node("exercise-new").value="Моё упражнение";
 await run('action("choose-new")');
 assert.equal(run("draft.exercises.at(-1).name"),"Моё упражнение");
 node("exercise-0").value="Подъём гантелей в стороны";
 await run('action("choose-0")');
 assert.equal(run("draft.exercises[0].name"),"Подъём гантелей в стороны");
 await run('action("remove-0")');
 assert.equal(run("draft.exercises[0].name"),original);
 await run("load()");
 assert.equal(run("draft.exercises.at(-1).name"),"Моё упражнение");
 await run('action("finish")');assert.equal(entries.get("profile/person1").data.workouts.length,1);
 assert.equal(entries.has("profile/person2"),false);
});
