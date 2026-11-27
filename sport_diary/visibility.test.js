"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const ui=require("./web/health-view");
const health=require("./web/health");
const visibility=require("./web/visibility");
const reports=require("./web/reports");
const goalsUI=require("./web/goals-view");
const day="2026-04-06";
const context=state=>({state,day,tab:0,profile:{id:"p1"},model:health,zone:"Europe/Moscow"});

test("Отключённые внешние разделы и показатели скрыты без удаления истории",()=>{
 const state={profile:{visibility:{sleep:false,watch:false,mealTiming:false,dailyMetrics:{steps:false}}},
   health:{daily:{[day]:{steps:{value:1234,source:"manual",date:day,unit:"steps"}}}},workouts:[],meals:[]};
 const c=context(state),before=structuredClone(state);
 assert.doesNotMatch(ui.panels(c),/data-disclosure="health-sleep"|Шаги/);
 c.tab=1;assert.equal(ui.panels(c),"");
 c.tab=2;assert.equal(ui.panels(c),"");
 assert.deepEqual(state,before);
});

test("Настройки видимости изолированы по профилю и сохраняют историю дат",()=>{
 const a={profile:{}},b={profile:{}},before=structuredClone(b);
 visibility.save(a,day,{sleep:false,watch:false,dailyMetrics:{steps:false}});
 assert.equal(visibility.section(a,"sleep"),false);
 assert.equal(visibility.section(a,"sleep","2026-04-05"),true);
 assert.equal(visibility.dailyMetric(a,"steps"),false);
 assert.equal(visibility.dailyMetric(a,"distance"),true);
 assert.deepEqual(b,before);
 assert.throws(()=>visibility.save(a,"2026-02-31",{}),/дат/);
 const c=context(a),form=ui.editor(c,"visibility","");
 form.save(a,new Map([["visible_sleep","on"],["visible_watch","on"],["visible_activity","on"],["metric_steps","on"]]));
 assert.equal(visibility.section(a,"sleep"),true);
 assert.equal(visibility.dailyMetric(a,"distance"),false);
});

test("Скрытые показатели исключены из форм и повторная проверка запрещает устаревший ввод",()=>{
 const state={profile:{visibility:{mealTiming:false,dailyMetrics:{steps:false}}},workouts:[],meals:[]},c=context(state);
 assert.doesNotMatch(ui.editor(c,"sleep","").body,/name="mealsComplete"/);
 const form=ui.editor(c,"daily","");
 assert.doesNotMatch(form.body,/<option value="steps"/);
 assert.throws(()=>form.save(state,new Map([["metric","steps"],["date",day],["value","1500"]])),/отключ/);
 assert.equal(state.health,undefined);
});

test("Скрытие добавок сохраняет калории, белок и баллы, скрывая лишь детализацию",()=>{
 const state={profile:{supps:["Протеин","Креатин"],equipment:[]},workouts:[],meals:[],supps:[
  {date:day+"T12:00",names:["Протеин"],servings:1,perServing:[120,22,2,3],powderPerServing:30},
  {date:day+"T13:00",names:["Креатин"],servings:1,creatinePerServing:3}
 ]};
 const report=()=>reports.diaryReport(state,[],"",day,"day","2026-04-07");
 const before=report();assert.equal(before.kcal,120);
 state.profile.supps=[];
 const after=report();
 assert.deepEqual([after.kcal,after.nutrition.known,after.points],[before.kcal,before.nutrition.known,before.points]);
 const view=goalsUI.report(after.nutritionGoals,"day",state)+goalsUI.settings(state,day);
 assert.doesNotMatch(view,/Личный план креатина|<b>Креатин|Вклад протеиновой добавки/);
 for(const key of ["creatineGrams","monohydrateGrams","proteinGrams","milkProteinGrams","omegaCapsules","fishOilMg","ironMg"])assert.equal(visibility.doseMetric(state,key),false,key);
 state.profile.supps=["Железо"];
 assert.equal(visibility.doseMetric(state,"ironMg"),true);
 assert.equal(visibility.doseMetric(state,"proteinGrams"),false);
});

test("Открытая форма не записывает отключённый раздел после обновления профиля",()=>{
 const state={profile:{},workouts:[],meals:[]},c=context(state);
 const editor=ui.editor(c,"sleep","");
 state.profile.visibility={sleep:false};
 assert.throws(()=>editor.save(state,new Map([["method","quick"],["date",day],["minutes","420"],["kind","main"]])),/отключ/);
 assert.equal(state.health,undefined);
});
