"use strict";

const SportGoals = (() => {
  const {canonicalSupp: supplementKind} = typeof module === "undefined" ? {canonicalSupp} : require("./logic");
  const portions = typeof module === "undefined" ? SportPortions : require("./portions");
  const baseProtein = {mode:"fact"};
  const baseCreatine = {enabled:false, serving:3};
  const positive = n => Number.isFinite(n) && n > 0;
  const valid = n => Number.isFinite(n) && n >= 0;
  const nextDay = (day, offset) => new Date(Date.parse(day+"T12:00:00Z") + offset*86400000).toISOString().slice(0,10);

  function ruleAt(rules, day, fallback) {
    let since="";
    for(const date of Object.keys(rules||{})) if(date<=day && date>since)since=date;
    return since ? {...rules[since], since} : {...fallback};
  }
  const proteinRule = (state, day) => ruleAt(state.proteinGoals,day,baseProtein);
  const creatineRule = (state, day) => ruleAt(state.creatineGoals,day,baseCreatine);

  function autoRule(profile, regular) {
    return {mode:"auto",birth:profile.birth||"",age:Number(profile.age)||null,regular:!!regular,
      strength:[profile.goal,...(profile.extra||[])].some(g=>g==="Сила"||g==="Набор мышц")};
  }
  function eligible(rule, day) {
    const age=rule.birth ? Number(day.slice(0,4))-Number(rule.birth.slice(0,4))-Number(day.slice(5)<rule.birth.slice(5)) : rule.age;
    return age>=18 && (rule.strength || rule.regular);
  }
  function setProtein(state, day, mode, grams, regular=false) {
    let rule={mode};
    if(mode==="auto") {
      rule=autoRule(state.profile,regular);
      if(!eligible(rule,day))throw Error("Для автоориентира укажи взрослый возраст и силовую цель или подтверди регулярные силовые занятия.");
    } else if(mode==="manual") {
      if(!positive(grams))throw Error("Укажи личную цель белка в граммах.");
      rule.grams=grams;
    } else if(mode!=="fact")throw Error("Выбери режим учёта белка.");
    (state.proteinGoals||={})[day]=rule;
  }
  function profileChanged(state, day) {
    const {since,...old}=proteinRule(state,day);
    if(old.mode!=="auto")return;
    const rule=autoRule(state.profile,old.regular);
    if(Object.keys(rule).some(key=>rule[key]!==old[key]))state.proteinGoals[day]=rule;
  }
  function setCreatine(state, day, enabled, grams, serving, substance="legacy") {
    if(!["powder","monohydrate","active","legacy"].includes(substance))throw Error("Укажи вещество для цели креатина.");
    if(!positive(serving) || (enabled&&!positive(grams)))throw Error("Укажи положительную массу порции и дневную цель включённого плана.");
    (state.creatineGoals||={})[day]={enabled:!!enabled,serving,substance,unit:"g",...(enabled?{grams}:{})};
  }
  function proteinTarget(rule, day, weight) {
    if(rule.mode==="manual")return rule.grams;
    if(rule.mode==="auto" && eligible(rule,day) && weight)return Math.round(16*weight.kg)/10;
    return null;
  }
  function weightTrends(weights, end) {
    return [7,28].map(days=>{
      const start=nextDay(end,1-days), observations=weights.filter(w=>w.day>=start && w.day<=end);
      return {days,count:observations.length,latest:observations.at(-1)||null,
        mean:observations.length ? observations.reduce((sum,w)=>sum+w.kg,0)/observations.length : null};
    });
  }
  function saveWeight(state, original, date, kg) {
    if(!Number.isFinite(kg)||kg<=0||kg>=700)throw Error("Проверь вес.");
    const matches=(a,b)=>a.source==="manual" && a.date===b.date && a.kg===b.kg;
    const i=original?state.weights.findIndex(w=>matches(w,original)):-1;
    if(original && i<0)throw Error("Исходный замер изменился. Выбери его повторно.");
    const other=state.weights.findIndex((w,j)=>j!==i && w.source==="manual" && Date.parse(w.date)===Date.parse(date));
    if(original && other>=0)throw Error("На это время уже есть отдельный ручной замер.");
    const row={...(i>=0?state.weights[i]:{}),source:"manual",date,kg};
    const index=i>=0?i:other;
    if(index>=0)state.weights.splice(index,1);
    state.weights.push(row);
  }
  function mealGroups(meals, supps, calculate) {
    const groups = new Map(), mealLabels=new Map();
    function bucket(label) {
      const key=label.toLocaleLowerCase("ru");
      if(!groups.has(key))groups.set(key,{label,meals:[],supps:[]});
      return groups.get(key);
    }
    for(const m of meals) {
      const label=m.mealGroup?.trim()||m.date.slice(11,16)||"Время не указано";
      bucket(label).meals.push(m);
      if(m.id)mealLabels.set(m.id,label);
    }
    for(const s of supps) {
      if(!s.names.some(name=>supplementKind(name)==="Протеин"))continue;
      const label=mealLabels.get(s.mealId)||s.date.slice(11,16)||s.period||"Время не указано";
      bucket(label).supps.push(s);
    }
    return [...groups.values()].map(rows=>{
      const n=calculate(rows.meals,rows.supps);
      return {label:rows.label,known:n.known[1],missing:n.missing[1],count:n.count,powder:n.doses.proteinGrams,powderUnknown:n.doses.proteinUnknown};
    });
  }
  function newTotals() {return {planDays:0,recordedDays:0,comparedDays:0,actual:0,target:0,credit:0,percent:null}}
  function compare(total, target, actual, recorded) {
    if(recorded)total.recordedDays++;
    if(target==null)return;
    total.planDays++;
    if(actual==null)return;
    total.comparedDays++;
    total.actual+=actual;total.target+=target;total.credit+=Math.min(actual,target);
  }
  function report(state, start, end, today, weights, food, calculate) {
    const rows=[], protein=newTotals(), creatine=newTotals(),creatineBySubstance=new Map(), fiber={known:0,knownCount:0,count:0}, groups=new Map();
    const until=end<today?end:today;
    let wi=0,weight=null;
    for(let day=start;day<=until;day=nextDay(day,1)) {
      while(wi<weights.length && weights[wi].day<=day)weight=weights[wi++];
      const p=proteinRule(state,day),c=creatineRule(state,day),target=proteinTarget(p,day,weight);
      const {meals,supps}=food.get(day)||{meals:[],supps:[]}, n=calculate(meals,supps), doses=n.doses;
      const substance=c.substance||"legacy", entries=supps.filter(e=>e.names.some(n=>supplementKind(n)==="Креатин"));
      const amounts=entries.map(e=>{
        if(substance==="legacy")return !e.productSnapshot&&positive(e.servings)?(e.creatinePerServing??3)*e.servings:null;
        const key={powder:"powderGrams",monohydrate:"monohydrateGrams",active:"activeGrams"}[substance];
        return e.productSnapshot?.[key]??(e.creatineBasis===substance&&positive(e.servings)?e.creatinePerServing*e.servings:null);
      });
      const creatineMissing=amounts.filter(v=>!valid(v)).length,creatineKnown=amounts.some(valid),creatineMarked=entries.length>0;
      const creatineTotal=amounts.filter(valid).reduce((a,b)=>a+b,0);
      const creatineActual=creatineMissing||(!creatineMarked&&day>=today) ? null : creatineTotal;
      const product=typeof module==="undefined"?SportSupplementProducts:require("./supplement-products.js");
      const enabledThen=!state.supplementAvailability||product.availableOn(state,day).includes("Креатин");
      const creatineTarget=c.enabled&&enabledThen?c.grams:null;
      const gramValues=meals.map(m=>m.fiberTotal).filter(valid);
      const f={known:gramValues.reduce((s,v)=>s+v,0),knownCount:gramValues.length,count:n.count};
      const dayGroups=mealGroups(meals,supps,calculate);
      for(const g of dayGroups) {
        const key=g.label.toLocaleLowerCase("ru");
        if(!groups.has(key))groups.set(key,{label:g.label,known:0,count:0,missing:0,powder:0,powderUnknown:0});
        const dest=groups.get(key);
        for(const key of ["known","count","missing","powder","powderUnknown"])dest[key]+=g[key];
      }
      for(const key of Object.keys(fiber))fiber[key]+=f[key];
      const recorded=portions.recordedFoodCount(meals)>0;
      compare(protein,target,n.totals[1],recorded);
      compare(creatine,creatineTarget,creatineActual,creatineMarked);
      if(creatineTarget!=null||creatineMarked){
        if(!creatineBySubstance.has(substance))creatineBySubstance.set(substance,{...newTotals(),substance});
        compare(creatineBySubstance.get(substance),creatineTarget,creatineActual,creatineMarked);
      }
      rows.push({day,weight,groups:dayGroups,fiber:f,
        protein:{mode:p.mode,target,actual:n.totals[1],known:n.known[1],count:n.count,missing:n.missing[1],issues:n.issues.filter(x=>x.fields.includes("Белки всего"))},
        creatine:{target:creatineTarget,actual:creatineActual,known:creatineTotal,knownCount:amounts.filter(valid).length,missing:creatineMissing,substance},
        powder:{known:doses.proteinGrams,knownCount:doses.proteinKnown,missing:doses.proteinUnknown}});
    }
    for(const metric of [protein,creatine,...creatineBySubstance.values()])if(metric.target>0)metric.percent=Math.round(100*metric.credit/metric.target);
    creatine.bySubstance=[...creatineBySubstance.values()];
    if(creatine.bySubstance.filter(v=>v.comparedDays).length>1){creatine.actual=null;creatine.target=null;creatine.credit=null;creatine.percent=null}
    return {rows,protein,creatine,fiber,groups:[...groups.values()],trends:weightTrends(weights,until),latest:weights.filter(w=>w.day<=until).at(-1)||null};
  }
  return {proteinRule,creatineRule,setProtein,setCreatine,profileChanged,saveWeight,report};
})();
if(typeof module!=="undefined")module.exports=SportGoals;
