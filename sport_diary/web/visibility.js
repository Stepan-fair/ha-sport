"use strict";
// Presentation settings never remove recorded events or change their totals.
const SportVisibility=(()=>{
  const logic=typeof module==="undefined"?{canonicalSupp,diaryTime}:require("./logic");
  const sections={sleep:"Сон",activity:"Суточная активность",watch:"Внешние данные с Apple Watch",mealTiming:"Окончание приёмов пищи"};
  const metrics={steps:"Шаги",distance:"Дистанция",exercise:"Минуты активности",active:"Активная энергия",resting:"Энергия покоя",restingPulse:"Пульс покоя"};
  function normalize(raw={}){
    raw=raw||{};
    return {...Object.fromEntries(Object.keys(sections).map(k=>[k,raw[k]!==false])),dailyMetrics:Object.fromEntries(Object.keys(metrics).map(k=>[k,raw.dailyMetrics?.[k]!==false]))};
  }
  function config(state,day){
    if(day){
      const rule=Object.entries(state.visibilityHistory||{}).filter(([d])=>d<=day).sort(([a],[b])=>b.localeCompare(a))[0]?.[1];
      if(rule)return normalize(rule);
    }
    return normalize(state.profile?.visibility);
  }
  function section(state,key,day){
    const c=config(state,day);
    return Object.hasOwn(sections,key)&&c[key]&&(key!=="activity"||Object.values(c.dailyMetrics).some(Boolean));
  }
  function dailyMetric(state,key,day){return section(state,"activity",day)&&config(state,day).dailyMetrics[key]===true}
  function supplement(state,name){return (state.profile?.supps||[]).some(n=>logic.canonicalSupp(n)===logic.canonicalSupp(name))}
  function exercise(state,name){return (state.profile?.equipment||[]).includes(name)}
  function doseMetric(state,key){
    const kind=/^(creatine|monohydrate)/.test(key)?"Креатин":/^(protein|powder|milk)/.test(key)?"Протеин":/^(omega|fishOil|epa|dha)/.test(key)?"Омега-3":/^iron/.test(key)?"Железо":null;
    return !kind||supplement(state,kind);
  }
  function issue(state,row){return row.kind!=="dose"||supplement(state,row.label)}
  function save(state,day,next){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+"T12:00Z"))||new Date(day+"T12:00Z").toISOString().slice(0,10)!==day||day>logic.diaryTime().slice(0,10))throw Error("Выбери текущую или прошлую дату настройки.");
    const history=state.visibilityHistory||={};
    if(!Object.keys(history).length)history["0001-01-01"]=config(state);
    history[day]=normalize(next);
    state.profile||={};state.profile.visibility=config(state,logic.diaryTime().slice(0,10));
  }
  function actionSection(action){
    if(["sleep","import-sleep","delete-sleep","undo-sleep"].includes(action))return "sleep";
    if(["daily","delete-daily","undo-daily"].includes(action))return "activity";
    if(["workout","import","link","delete-workout","undo-workout"].includes(action))return "watch";
    if(action==="meal")return "mealTiming";
    return null;
  }
  function assertAction(state,action,metric){
    const key=actionSection(action);
    if(key&&!section(state,key))throw Error("Этот раздел отключён в настройках профиля. Включи его перед записью.");
    if(key==="activity"&&metric&&!dailyMetric(state,metric))throw Error("Этот показатель отключён в настройках профиля.");
  }
  return {sections,metrics,normalize,config,section,dailyMetric,supplement,exercise,doseMetric,issue,save,assertAction};
})();
if(typeof module!=="undefined")module.exports=SportVisibility;
