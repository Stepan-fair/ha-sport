"use strict";
const SportSupplementView=(()=>{
 const product=typeof module==="undefined"?SportSupplementProducts:require("./supplement-products.js");
 const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const input=(key,label,value,type="number")=>'<label>'+escape(label)+'<input data-recipe-field="'+key+'" type="'+type+'" '+(type==="number"?'step="any" min="0" inputmode="decimal" ':'')+'value="'+escape(value)+'"></label>';
 const select=(key,label,value,choices)=>'<label>'+escape(label)+'<select data-recipe-field="'+key+'">'+Object.entries(choices).map(([k,v])=>'<option value="'+escape(k)+'"'+(value===k?' selected':'')+'>'+escape(v)+'</option>').join("")+'</select></label>';
 const macro=(prefix,values,label)=>'<fieldset><legend>'+escape(label)+'</legend>'+["Ккал","Белки, г","Жиры, г","Углеводы, г"].map((n,i)=>input(prefix+"."+i,n,values[i])).join("")+'</fieldset>';
 function fields(name,r){
  let specific="";
  if(name==="Протеин")specific=input("powderGrams","Масса одного саше, г",r.powderGrams)+select("powderBasis","Основание этикетки порошка",r.powderBasis,{"100g":"На 100 г","serving":"На одно саше"})+macro("powderLabel",r.powderLabel,"КБЖУ порошка на выбранное основание")+input("milk.brand","Молоко или напиток",r.milk.brand,"text")+input("milk.ml","Молоко на саше, мл (0 = на воде)",r.milk.ml)+select("milk.basis","Основание этикетки молока",r.milk.basis,{"100g":"На 100 г","100ml":"На 100 мл"})+input("milk.density","Соответствие г/мл для этого молока",r.milk.density)+macro("milk.label",r.milk.label,"КБЖУ молока на выбранное основание")+input("milk.source","Источник этикетки молока и плотности",r.milk.source||"","text");
  if(name==="Креатин")specific=input("powderGrams","Порошок на порцию, г",r.powderGrams)+input("monohydrateGrams","Моногидрат на порцию, г",r.monohydrateGrams)+input("activeGrams","Креатин на порцию, г",r.activeGrams)+select("nutritionMode","Пищевая ценность",r.nutritionMode,{approxZero:"Практическая оценка ≈ 0; этикетка неизвестна",label:"Моя уточнённая этикетка"})+macro("label",r.label,"КБЖУ на порцию, если известны");
  if(name==="Омега-3")specific=[["fishOilMg","Рыбий жир"],["omegaMg","Омега-3, не менее"],["epaMg","ЭПК, не менее"],["dhaMg","ДГК, не менее"]].map(([key,label])=>input(key,label+" на капсулу, мг",r[key])).join("")+macro("label",r.label,"КБЖУ на одну капсулу");
  if(name==="Железо")specific=input("drops","Обычный приём, капель",r.drops)+input("dropsPerMl","Капель в 1 мл этого препарата",r.dropsPerMl)+input("ironMgPerMl","Железо, мг в 1 мл",r.ironMgPerMl);
  return '<div data-recipe-editor data-name="'+escape(name)+'" data-original="'+escape(JSON.stringify(r))+'">'+input("brand","Марка или препарат",r.brand,"text")+input("variant","Вариант или вкус",r.variant,"text")+input("servings","Обычное количество порций / капсул",r.servings)+specific+input("source","Источник или этикетка",r.source,"text")+input("note","Примечание к составу",r.note,"text")+'<label class="check"><input type="checkbox" data-recipe-field="estimated"'+(r.estimated?' checked':'')+'>Расчётная оценка</label></div>';
 }
 function read(container){
  const editor=container.matches?.("[data-recipe-editor]")?container:container.querySelector("[data-recipe-editor]");
  const r=JSON.parse(editor.dataset.original);
  for(const el of editor.querySelectorAll("[data-recipe-field]")){
   const parts=el.dataset.recipeField.split("."),key=parts.pop();let object=r;for(const part of parts)object=object[part];
   object[key]=el.type==="checkbox"?el.checked:el.type==="number"?(el.value===""?null:Number(el.value)):el.value;
  }
  return product.validate(editor.dataset.name,r);
 }
 function settings(state,day){return product.names.filter(name=>product.enabled(state,name)).map(name=>{
  const r=product.recipeFor(state,name,day),history=Object.keys(state.supplementRecipes?.[name]||{}).filter(d=>d!=="0001-01-01").sort();
  return '<details data-recipe-settings="'+escape(name)+'"><summary>Обычный рецепт · '+escape(r.brand)+'</summary><p>Изменение действует с выбранной даты для новых приёмов. Уже записанные приёмы сохраняют свой состав.</p><label>Дата действия<input data-recipe-date type="date" value="'+day+'"></label>'+fields(name,r)+'<p>'+escape(r.note)+'</p>'+(history.length?'<small>Даты сохранённых рецептов: '+history.join(", ")+'</small>':"")+'<button type="button" data-action="save-supplement-recipe" hidden>Сохранить обычный рецепт</button></details>';
 }).join("")}
 function doseFields(state,name,entry,day,editing){
  const r=entry.recipe||entry.productSnapshot?.recipe||product.recipeFor(state,name,day),s=entry.productSnapshot||product.snapshot(name,r,Number(entry.servings)||r.servings);
  let links="";
  if(name==="Протеин"){
   const meals=(state.meals||[]).filter(m=>m.date.slice(0,10)===day&&!state.supps.some(e=>e.id!==entry.id&&e.mealId===m.id));
   links='<label>Связь с питанием<select name="mealId"><option value="">Создать шейк с порошком и молоком</option>'+meals.map(m=>'<option value="'+escape(m.id)+'"'+(m.id===entry.mealId?' selected':'')+'>'+escape(m.name)+'</option>').join("")+'</select></label><label>Что уже внесено в выбранной порции<select name="linkMode"><option value="complete">Весь шейк: КБЖУ уже включают порошок и молоко</option><option value="milk">Только молоко: добавить порошок один раз</option></select></label>';
  }
  const content='<div data-dose-controls="'+escape(name)+'" data-product-dose><label>'+(name==="Протеин"?"Саше в этом приёме":name==="Омега-3"?"Капсул в этом приёме":"Порций в этом приёме")+'<input name="servings" type="number" min="0" step="any" value="'+escape(s.servings)+'"></label>'+(name==="Железо"?'<label>Фактически капель<input name="drops" type="number" min="0" step="any" value="'+escape(s.drops)+'"></label>':"")+links+'<details><summary>Состав только этого приёма</summary>'+fields(name,r)+'</details><p data-dose-preview>'+escape(product.summary(name,s))+(s.totals?' · '+s.totals.map((v,i)=>(v==null?"не указано":Number(v).toLocaleString("ru-RU",{maximumFractionDigits:4}))+[" ккал"," г белка"," г жиров"," г углеводов"][i]).join(" · "):"")+'</p><small>'+escape(r.note)+'</small></div>';
  return editing?content:'<details class="doseQuantity"><summary>'+escape(product.summary(name,s))+'</summary>'+content+'</details>';
 }
 function values(controls){return {servings:Number(controls.querySelector('[name="servings"],[name="updated-servings"]').value),drops:controls.querySelector('[name="drops"],[name="updated-drops"]')?Number(controls.querySelector('[name="drops"],[name="updated-drops"]').value):undefined,mealId:controls.querySelector('[name="mealId"],[name="updated-mealId"]')?.value,linkMode:controls.querySelector('[name="linkMode"],[name="updated-linkMode"]')?.value,recipe:read(controls)}}
 function changed(target){const controls=target.closest?.("[data-product-dose]");if(controls)try{const v=values(controls),s=product.snapshot(controls.dataset.doseControls,v.recipe,v.servings,v.drops);controls.querySelector('[data-dose-preview]').textContent=product.summary(controls.dataset.doseControls,s)+(s.totals?' · '+s.totals.map((x,i)=>(x==null?"не указано":Number(x).toLocaleString("ru-RU",{maximumFractionDigits:4}))+[" ккал"," г белка"," г жиров"," г углеводов"][i]).join(" · "):"")}catch(e){controls.querySelector('[data-dose-preview]').textContent=e.message}}
 // Unit changes convert the current label through the known mass; they never just rename numbers.
 function convertBasis(select){if(!select.matches?.('[data-recipe-field="powderBasis"],[data-recipe-field="milk.basis"]'))return;const editor=select.closest("[data-recipe-editor]"),original=JSON.parse(editor.dataset.original),powder=select.dataset.recipeField==="powderBasis",old=select.dataset.previousBasis||(powder?original.powderBasis:original.milk.basis);if(old===select.value)return;const measure=Number(editor.querySelector('[data-recipe-field="'+(powder?"powderGrams":"milk.density")+'"]').value);if(!(measure>0)){select.value=old;throw Error("Для перевода основания укажи массу или плотность.")};const factor=powder?(old==="100g"?measure/100:100/measure):(old==="100g"?measure:1/measure);for(let i=0;i<4;i++){const el=editor.querySelector('[data-recipe-field="'+(powder?"powderLabel":"milk.label")+'.'+i+'"]');if(el.value!=="")el.value=Number(el.value)*factor}select.dataset.previousBasis=select.value}
 return {settings,doseFields,values,read,changed,convertBasis};
})();
if(typeof module!=="undefined")module.exports=SportSupplementView;
