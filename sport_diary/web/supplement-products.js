"use strict";
// Product characteristics are public. Choices, dated recipes and actual events belong to one profile.
const SportSupplementProducts=(()=>{
 const canonical=typeof module==="undefined"?canonicalSupp:require("./logic.js").canonicalSupp;
 const clone=value=>JSON.parse(JSON.stringify(value));
 const names=["Протеин","Креатин","Омега-3","Железо"];
 const basisLabels={powder:"порошок",monohydrate:"моногидрат",active:"креатин",legacy:"вещество не уточнено"};
 const defaults={
  "Протеин":{productId:"first-russian-protein-average",brand:"Первый Русский Протеин",variant:"Среднее четырёх вкусов",servings:1,powderGrams:30,powderLabel:[419.1666666666667,72.5,8.916666666666666,12.416666666666666],powderBasis:"100g",milk:{brand:"Среднее Простоквашино 2,5%",ml:300,density:1.03,basis:"100g",label:[53,2.95,2.5,4.75],source:"https://prostokvashino.ru/product/moloko-ultrapasterizovannoe-2-5-950-ml/; https://prostokvashino.ru/product/moloko-pasterizovannoe-2-5-930-ml/; https://dairyprocessinghandbook.tetrapak.com/chapter/chemistry-milk"},estimated:true,source:"https://protein-rm.ru/catalog/sashe-boks-protein-450-gr-klubnika/",note:"Среднее четырёх вкусов в равных долях. Молоко и плотность — оценка; 300 мл относятся к добавленному молоку."},
  "Креатин":{productId:"ostrovit-creatine-green-apple-1000",brand:"OstroVit Creatine Monohydrate",variant:"Зелёное яблоко",ean:"5903933917931",scoop:0.75,packageGrams:1000,labeledServings:333,servings:1,powderGrams:3,monohydrateGrams:2.6,activeGrams:2.288,label:[null,null,null,null],nutritionMode:"approxZero",estimated:true,source:"https://ostrovit.com/en/products/ostrovit-creatine-monohydrate-1000-g-26789.html",note:"Исходная этикетка КБЖУ неизвестна. Практическая оценка ≈ 0 для 0,4 г вкусовых компонентов. Креатин не является пищевым белком. Вода без заданного объёма."},
  "Омега-3":{productId:"evalar-triple-omega-950",brand:"Эвалар Тройная Омега-3 950 мг",variant:"1 капсула",servings:1,fishOilMg:1300,omegaMg:950,epaMg:550,dhaMg:230,label:[10,0.2,1.3,0],estimated:true,source:"https://shop.evalar.ru/catalog/anti-age/triple-omega-3-950-mg/offer-182931/",note:"КБЖУ на капсулу по опубликованной этикетке. 10 ккал расходятся с 12,5 ккал по БЖУ; сохраняется значение производителя. Омега-3, ЭПК и ДГК входят в рыбий жир, повторно к жирам не прибавляются."},
  "Железо":{productId:"ferromalt-50mg-ml",brand:"Ферромальт",variant:"Капли 50 мг/мл",servings:1,drops:40,dropsPerMl:20,ironMgPerMl:50,estimated:false,source:"https://medi.ru/instrukciya/ferromalt_27693/",note:"Пересчёт указанного владельцем приёма, не назначение. Коэффициент капель относится только к этому препарату; дни и частота приёма не заданы."}
 };
 function dayOK(day){if(!/^\d{4}-\d\d-\d\d$/.test(day)||new Date(day+"T12:00Z").toISOString().slice(0,10)!==day)throw Error("Проверь дату действия.")}
 function num(value,label,zero=false){const n=Number(value);if(value===""||value==null||!Number.isFinite(n)||n<0||(!zero&&!n)||n>1000000)throw Error("Проверь «"+label+"».");return n}
 function nutrients(values,unknown=false){if(!Array.isArray(values)||values.length!==4)throw Error("Укажи четыре значения КБЖУ.");return values.map(v=>unknown&&v==null?null:num(v,"КБЖУ",true))}
 function at(rows,day,fallback){const key=Object.keys(rows||{}).filter(d=>d<=day).sort().at(-1);return clone(key?rows[key]:fallback)}
 function supported(name){return names.includes(canonical(name))}
 function recipeFor(state,name,day){name=canonical(name);if(!supported(name))return null;return at(state.supplementRecipes?.[name],day,defaults[name])}
 function validate(name,recipe){
  name=canonical(name);if(!supported(name))throw Error("Неизвестный продукт.");const r=clone(recipe);
  for(const field of ["productId","brand","variant","source","note"])if(typeof r[field]!=="string"||r[field].length>2000)throw Error("Проверь описание продукта.");
  r.servings=num(r.servings,"Обычное количество");
  if(name==="Протеин"){
   r.powderGrams=num(r.powderGrams,"Масса саше");r.powderLabel=nutrients(r.powderLabel);
   if(!["100g","serving"].includes(r.powderBasis))throw Error("Проверь основание этикетки порошка.");
   const m=r.milk;if(!m||typeof m.brand!=="string")throw Error("Проверь молоко.");m.ml=num(m.ml,"Объём молока",true);m.density=num(m.density,"Плотность молока");m.label=nutrients(m.label);
   if(!["100g","100ml"].includes(m.basis))throw Error("Проверь основание этикетки молока.");
  }else if(name==="Креатин"){
   for(const key of ["powderGrams","monohydrateGrams","activeGrams"])r[key]=num(r[key],key);
   if(r.activeGrams>r.monohydrateGrams||r.monohydrateGrams>r.powderGrams)throw Error("Массы компонентов превышают массу продукта.");
   if(!["approxZero","label"].includes(r.nutritionMode))throw Error("Проверь способ учёта КБЖУ.");r.label=nutrients(r.label,r.nutritionMode==="approxZero");
  }else if(name==="Омега-3"){
   for(const key of ["fishOilMg","omegaMg","epaMg","dhaMg"])r[key]=num(r[key],key,true);r.label=nutrients(r.label);
   if(r.epaMg+r.dhaMg>r.omegaMg||r.omegaMg>r.fishOilMg)throw Error("Компоненты омега-3 превышают общий рыбий жир.");
  }else for(const key of ["drops","dropsPerMl","ironMgPerMl"])r[key]=num(r[key],key);
  return r;
 }
 function saveRecipe(state,name,day,recipe){dayOK(day);name=canonical(name);const r=validate(name,recipe),all=state.supplementRecipes||={},rows=all[name]||={};if(!Object.keys(rows).length)rows["0001-01-01"]=clone(defaults[name]);rows[day]=r;return clone(r)}
 function enabled(state,name){return (state.profile?.supps||[]).some(n=>canonical(n)===canonical(name))}
 function availableOn(state,day){return at(state.supplementAvailability,day,(state.profile?.supps||[]).map(canonical))}
 function setAvailability(state,day,chosen){dayOK(day);const rows=state.supplementAvailability||={};if(!Object.keys(rows).length)rows["0001-01-01"]=[...new Set((state.profile?.supps||[]).map(canonical))];const list=[...new Set(chosen.map(canonical))].filter(n=>!/кофеин|теанин|caffeine|theanine/i.test(n));rows[day]=list;state.profile||={};state.profile.supps=list}
 function snapshot(name,recipe,servings,drops){
  const r=validate(name,recipe),count=num(servings??r.servings,"Количество"),out={recipe:r,servings:count,estimated:!!r.estimated};
  if(name==="Протеин"){
   const powder=r.powderLabel.map(v=>v*(r.powderBasis==="100g"?r.powderGrams/100:1)*count),milk=r.milk.label.map(v=>v*r.milk.ml*(r.milk.basis==="100g"?r.milk.density:1)/100*count);
   Object.assign(out,{powderGrams:r.powderGrams*count,powderProtein:powder[1],milkMl:r.milk.ml*count,milkGrams:r.milk.ml*r.milk.density*count,milkProtein:milk[1],powderNutrition:powder,milkNutrition:milk,totals:powder.map((v,i)=>v+milk[i])});
  }else if(name==="Креатин")Object.assign(out,{powderGrams:r.powderGrams*count,monohydrateGrams:r.monohydrateGrams*count,activeGrams:r.activeGrams*count,totals:r.nutritionMode==="approxZero"?[0,0,0,0]:r.label.map(v=>v*count),nutritionMode:r.nutritionMode,activePer100g:r.activeGrams/r.powderGrams*100,monohydratePer100g:r.monohydrateGrams/r.powderGrams*100});
  else if(name==="Омега-3"){for(const key of ["fishOilMg","omegaMg","epaMg","dhaMg"])out[key]=r[key]*count;out.totals=r.label.map(v=>v*count)}
  else {out.drops=num(drops??r.drops*count,"Капли");out.ml=out.drops/r.dropsPerMl;out.ironMg=out.ml*r.ironMgPerMl}
  return out;
 }
 function rememberPlan(state,day){const plans=state.suppPlans||={};if(!Object.hasOwn(plans,day))plans[day]=(state.supps||[]).some(x=>x.date.slice(0,10)===day)?null:availableOn(state,day)}
 function makeMeal(entry){
  const s=entry.productSnapshot,r=s.recipe,mass=s.milkGrams==null?null:s.powderGrams+s.milkGrams,size=mass==null?null:mass/s.servings;
  return {id:entry.mealId||"supp-meal-"+entry.id,supplementEventId:entry.id,supplementComponents:{powder:clone(s.powderNutrition),milk:clone(s.milkNutrition),milkMl:s.milkMl},date:entry.date,name:s.mealName||(r.brand+" · "+r.variant+(s.milkMl===0?" · на воде":" + "+r.milk.brand)),unit:"г",basis:"piece",pieceName:"шейк",sizes:size==null?{}:{piece:size},nut:s.totals.map(v=>v/s.servings),amount:mass,portion:{mode:"piece",count:s.servings,size},baseTotals:[...s.totals],totals:[...s.totals],productKind:"protein_mix",proteinDetails:{servings:s.servings,powderGrams:s.powderGrams,proteinGrams:s.powderProtein},estimateNote:r.estimated?"Расчётный состав: "+r.note:"",oneOff:true};
 }
 function saveEvent(state,event){
  // Validate on a transaction copy. A failed link or malformed quantity cannot leave a partial plan/meal.
  const next=clone(state),entry=saveEventMutable(next,event);
  for(const key of ["supps","suppPlans","meals"])if(Object.hasOwn(next,key))state[key]=next[key];
  return entry;
 }
 function saveEventMutable(state,event){
  const name=canonical(event.name||event.names?.[0]||""),day=String(event.date||"").slice(0,10);dayOK(day);
  if(!/^\d{4}-\d\d-\d\d(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)?$/.test(event.date)||!["Утро","День","Вечер","Ночь"].includes(event.period))throw Error("Проверь фактическое время и период приёма.");
  if(!enabled(state,name))throw Error("Добавка отключена. Обнови выбор в настройках.");
  if(typeof event.id!=="string"||!event.id||event.id.length>180)throw Error("У приёма должен быть собственный ID.");
  const rows=state.supps||=[],index=rows.findIndex(e=>e.id===event.id),old=rows[index];
  if(old&&!event.edit)return old; // Same operation receipt; never add the same event twice.
  if(old&&canonical(old.names[0])!==name)throw Error("Этот ID принадлежит другому приёму.");
  rememberPlan(state,day);if(old)rememberPlan(state,old.date.slice(0,10));
  const entry={...(old||{}),id:event.id,names:[name],date:event.date,period:event.period};
  if(supported(name)){
   const recipe=event.recipe||old?.productSnapshot?.recipe||recipeFor(state,name,day);
   let s=snapshot(name,recipe,event.servings??old?.servings,event.drops??(event.servings==null?old?.productSnapshot?.drops:undefined));
   const previous=old?.productSnapshot;
   if(previous&&JSON.stringify(recipe)===JSON.stringify(previous.recipe)&&
      (name!=="Железо"||s.drops===previous.drops)){
    const factor=s.servings/previous.servings;
    // A move, or a change of quantity, keeps a meal-side correction's measured composition.
    if(factor===1||previous.correctedFromMeal){
     s=clone(previous);
     if(factor!==1)for(const [key,value] of Object.entries(s)){
      if(typeof value==="number"&&!key.endsWith("Per100g"))s[key]=value*factor;
      else if(Array.isArray(value))s[key]=value.map(n=>n==null?null:n*factor);
     }
    }
   }
   Object.assign(entry,{servings:s.servings,productSnapshot:s});
   if(name==="Креатин")Object.assign(entry,{creatinePerServing:recipe.activeGrams,creatineBasis:"active"});
   if(name==="Протеин"){
    Object.assign(entry,{powderPerServing:recipe.powderGrams,perServing:s.powderNutrition.map(v=>v/s.servings)});
    state.meals||=[];
    const requested=event.mealId===undefined?old?.mealId:event.mealId;
    const linked=requested&&state.meals.find(m=>m.id===requested);
    if(requested&&!linked)throw Error("Связанная порция уже изменилась. Выбери её заново.");
    if(linked&&rows.some(d=>d.id!==entry.id&&d.mealId===linked.id))throw Error("Эта порция уже связана с другим приёмом.");
    if(old?.mealId&&old.mealId!==requested)state.meals=state.meals.filter(m=>m.id!==old.mealId||m.supplementEventId!==old.id);
    entry.mealId=linked?.id||"supp-meal-"+entry.id;
    if(linked&&!linked.supplementEventId){
     if(event.linkMode==="milk"){
      const p=typeof module==="undefined"?SportPortions:require("./portions.js"),totals=p.mealNutrients(linked);
      if(totals.some(v=>v==null))throw Error("Для связи молока укажи его полные КБЖУ.");
      s.milkNutrition=totals;s.milkProtein=totals[1];s.totals=s.powderNutrition.map((v,i)=>v+totals[i]);
      const amount=Number.isFinite(linked.amount)&&linked.amount>0?linked.amount:null;
      s.milkMl=amount==null?null:linked.unit==="мл"?amount:linked.unit==="г"?amount/recipe.milk.density:null;
      s.milkGrams=s.milkMl==null?null:s.milkMl*recipe.milk.density;
      if(s.milkMl!=null)s.recipe.milk.ml=s.milkMl/s.servings;
      s.correctedFromMeal=true;
      const combined=makeMeal(entry);Object.assign(linked,combined,{id:entry.mealId});
     }else{
      const p=typeof module==="undefined"?SportPortions:require("./portions.js");
      s.totals=p.mealNutrients(linked);s.milkProtein=Math.max(0,(s.totals[1]||0)-s.powderProtein);s.externalMeal=true;s.correctedFromMeal=true;s.mealName=linked.name;
      linked.supplementEventId=entry.id;linked.productKind||="protein_mix";linked.proteinDetails||={servings:s.servings,powderGrams:s.powderGrams,proteinGrams:s.powderProtein};
      if(linked.proteinDetails.proteinGrams>s.totals[1])throw Error("Белка порошка больше, чем в связанной порции.");
      linked.date=entry.date;
     }
    }else{
     const meal=makeMeal(entry),i=state.meals.findIndex(m=>m.id===entry.mealId);if(i<0)state.meals.push(meal);else state.meals[i]=meal;
    }
   }
  }
  if(index<0)rows.push(entry);else rows[index]=entry;
  if(entry.productSnapshot?.externalMeal){const meal=state.meals.find(m=>m.id===entry.mealId);if(meal)syncFromMeal(state,meal)}
  return entry;
 }
 function removeEvent(state,id){const old=(state.supps||[]).find(e=>e.id===id);if(!old)return;if(!enabled(state,old.names[0]))throw Error("Добавка отключена. Для исправления включи её в настройках.");state.supps=state.supps.filter(e=>e.id!==id);state.meals=(state.meals||[]).filter(m=>m.supplementEventId!==id)}
 function syncFromMeal(state,meal){
  const e=(state.supps||[]).find(e=>e.id===meal.supplementEventId||e.mealId===meal.id&&e.productSnapshot&&canonical(e.names[0])==="Протеин");if(!e)return;
  const s=e.productSnapshot;if(!s)return;
  e.date=meal.date;if(meal.date.length>=16){const hour=Number(meal.date.slice(11,13));e.period=hour<6?"Ночь":hour<12?"Утро":hour<18?"День":"Вечер";}
  const info=meal.proteinDetails||{},oldCount=s.servings,newCount=info.servings??oldCount,factor=newCount/oldCount;
  s.servings=e.servings=newCount;
  for(const key of ["milkMl","milkGrams"])if(s[key]!=null)s[key]*=factor;
  s.powderGrams=info.powderGrams??s.powderGrams*factor;s.powderProtein=info.proteinGrams??s.powderProtein*factor;
  const p=typeof module==="undefined"?SportPortions:require("./portions.js");s.totals=p.mealNutrients(meal);s.milkProtein=s.totals[1]==null?null:Math.max(0,s.totals[1]-s.powderProtein);s.correctedFromMeal=true;
  s.powderNutrition=s.powderNutrition.map(v=>v*factor);s.powderNutrition[1]=s.powderProtein;
  s.milkNutrition=s.totals.map((v,i)=>v==null?null:Math.max(0,v-s.powderNutrition[i]));
 }
 function summary(name,s){const r=s.recipe;return name==="Протеин"?r.brand+" · "+s.servings+" саше · "+s.powderGrams+" г + "+(s.milkMl==null?"молоко: объём неизвестен":s.milkMl?"молоко "+s.milkMl+" мл":"вода"):name==="Креатин"?r.brand+" · "+s.powderGrams+" г порошка · "+s.monohydrateGrams+" г моногидрата · "+s.activeGrams+" г креатина":name==="Железо"?r.brand+" · "+s.drops+" капель · "+s.ironMg+" мг железа":r.brand+" · "+s.servings+" капс. · "+s.omegaMg+" мг омега-3"}
 return {names,basisLabels,recipeFor,saveRecipe,supported,enabled,availableOn,setAvailability,snapshot,saveEvent,removeEvent,syncFromMeal,summary,validate};
})();
if(typeof module!=="undefined")module.exports=SportSupplementProducts;
