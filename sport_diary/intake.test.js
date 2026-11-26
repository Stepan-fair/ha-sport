"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {nutritionForDay,diaryReport}=require("./web/reports");
const date="2026-03-02";
const protein=(day,servings,fields={})=>({date:day,names:["Протеин"],period:"Утро",servings,...fields});
const meal=(day,id,nut,extra={})=>({date:day+"T12:00",name:id,id,nut,amount:100,...extra});
test("Сохранённые поля, основание на штуку и доля масла восстанавливаются по каждому нутриенту",()=>{
  const s={meals:[meal(date,"еда",[100,16,0,null],{amount:90,totals:[91,null,0,null]}),
    meal(date,"яйцо",[70,6,null,0],{basis:"piece",amount:null,portion:{mode:"piece",count:2,size:null},
      oil:{grams:5,nut:[900,0,100,null]}})]};
  const n=nutritionForDay(s,date);
  assert.deepEqual(n.known,[276,26.4,0,0]);
  assert.deepEqual(n.missing,[0,0,1,2]);
  assert.equal(n.issues.filter(x=>x.fields.includes("Жиры")).length,1);
});
test("Белок, масло и порошок не удваиваются при связи с чистой или смешанной порцией",()=>{
  const shake=meal(date,"шейк",[180,30,1,3],{productKind:"protein_mix",proteinDetails:{servings:1,powderGrams:30,proteinGrams:22}});
  const pure=meal(date,"чистый",[120,22,1,3],{productKind:"protein",proteinDetails:{servings:1,powderGrams:30}});
  const s={meals:[shake,pure],supps:[protein(date,1,{mealId:"шейк",powderPerServing:30}),protein(date,null,{mealId:"чистый"})]};
  const n=nutritionForDay(s,date);
  assert.equal(n.totals[1],52);assert.equal(n.doses.proteinGrams,44);
  assert.equal(n.doses.proteinServings,2);assert.equal(n.doses.powderGrams,60);
  assert.equal(n.doses.proteinServingsUnknown,0);
  s.supps=[];assert.equal(nutritionForDay(s,date).doses.proteinGrams,44);
});
test("Три дня, два профиля и независимая полнота саше и состава",()=>{
  const days=[date,"2026-03-03","2026-03-04"];
  const s={meals:days.map((d,i)=>meal(d,"еда",[100,30+10*i,0,0])),supps:[
    protein(days[0],1,{powderPerServing:30}),protein(days[1],.5,{powderPerServing:30}),
    {date:days[2],names:["Креатин"],servings:2}]};
  const run=state=>diaryReport(state,[],null,days[2],"week",days[2]);
  const r=run(s);assert.deepEqual(r.rows.map(d=>d.nutrition.totals[1]),[52,51,50]);
  assert.deepEqual([r.nutrition.totals[1],r.doses.proteinGrams,r.doses.proteinServings,r.doses.powderGrams,r.doses.creatineGrams],[153,33,1.5,45,6]);
  assert.equal(run({}).nutrition.count,0);
  s.supps[0].names=["Другой protein"];const partial=run(s);
  assert.equal(partial.doses.proteinUnknown,1);assert.equal(partial.doses.proteinServingsUnknown,0);
  s.supps.push(protein(days[2],null));assert.equal(run(s).doses.proteinServingsUnknown,1);
});
test("Перенос шейка переносит только протеин из общей отметки, удаление любой стороны сохраняет вклад порошка",()=>{
  const {setDoseLink}=require("./web/portions");
  const {removeMealIntake,preserveMealProtein}=require("./web/reports");
  const original=meal(date,"шейк",[180,30,1,3],{productKind:"protein_mix",proteinDetails:{proteinGrams:22}});
  const next={...original,date:"2026-03-03T18:00"};
  const s={meals:[next],supps:[{...protein(date,1,{powderPerServing:30,mealId:"шейк"}),names:["Протеин","Креатин"]}]};
  setDoseLink(s,next,original,0);
  assert.equal(nutritionForDay(s,date).doses.creatineGrams,3);assert.equal(nutritionForDay(s,date).count,0);
  const day=next.date.slice(0,10);
  assert.equal(nutritionForDay(s,day).totals[1],30);
  const copy=structuredClone(s);
  preserveMealProtein(copy,copy.supps[1]);copy.supps.pop();
  assert.equal(nutritionForDay(copy,day).doses.powderGrams,30);
  assert.equal(nutritionForDay(copy,day).doses.proteinGrams,22);
  removeMealIntake(s,"шейк");
  assert.equal(s.supps[1].mealId,undefined);assert.equal(nutritionForDay(s,day).totals[1],22);
});
test("Отчёт отделяет ноль на прошедшую дату, сегодняшний пропуск, известный ноль и источник отсутствующего поля",()=>{
  const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
  const ctx=vm.createContext({...require("./web/logic"),SportPortions:require("./web/portions"),
    state:{supps:[]},esc:String,btn:(a,b)=>'<button data-action="'+a+'">'+b+'</button>',dayLabel:String});
  for(const name of ["goals","health","reports","report-view"])vm.runInContext(fs.readFileSync(path.join(__dirname,"web",name+".js"),"utf8"),ctx);
  function render(s,today){
    ctx.state=s;ctx.report=diaryReport(s,[],null,date,"day",today);
    return vm.runInContext("intakeBody(report)",ctx);
  }
  const past="2026-03-03";
  assert.match(render({},past), /Калории<\/small><strong>—/);
  assert.match(render({},past), /Креатин<\/small><strong>0 г/);
  assert.match(render({supps:[{date,names:["Креатин"],servings:1}]},past), /Порошок протеина<\/small><strong>0 г/);
  assert.match(render({meals:[meal(date,"завтрак",[80,10,0,0])]},date), /Креатин<\/small><strong>—/);
  const text=render({meals:[meal(date,"кефир",[80,10,0,0]),meal(date,"ужин",[90,1,null,2])]},past);
  assert.match(text,/Жиры<\/small><strong>0 г<\/strong><details><summary>Уточнить 1 запись/);
  assert.ok(text.includes("refine-meal-"+encodeURIComponent("ужин")));
  assert.ok(text.includes("2026-03-02 · 12:00 · ужин"));
});
