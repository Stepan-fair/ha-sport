"use strict";
const $=id=>document.getElementById(id);
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const local=diaryTime;
let selectedDay=local().slice(0,10), viewedMonth=selectedDay.slice(0,7), expanded=false;
let manualTime="",settingsOpen=false,calendarClockStarted=false;
let sectionCalendarOpen=false;
const pendingDoses=new Set();
const draftDoseAmounts=new Map();
const stamp=()=>selectedDay+"T"+(manualTime||local().slice(11));
const key=()=> "sport:diary:draft:"+who+":"+selectedDay;
function restoreDraft(){
 const oldKey="sport:diary:draft:"+who;
 const old=JSON.parse(localStorage.getItem(oldKey)||"null");
 if(old){const migrated=oldKey+":"+old.date.slice(0,10);if(!localStorage.getItem(migrated))localStorage.setItem(migrated,JSON.stringify(old));localStorage.setItem(oldKey,"null")}
 draft=JSON.parse(localStorage.getItem(key())||"null");
 if(draft&&!draft.editBase&&state.workouts.some(w=>w.id===draft.id)){draft=null;retain()}
}
function selectDay(day){
 if(day!==selectedDay){pendingDoses.clear();draftDoseAmounts.clear()}
 editingMeal=null;selectedDay=day;viewedMonth=day.slice(0,7);manualTime="";lastSummary=null;results=[];restoreDraft();
}
function dayLabel(day){return new Date(day+"T12:00").toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"})}

let who="person1", tab=0, state,rev,draft,results=[], lastSummary=null, busy=false;
let people=[],scale=[],editingMeal=null;
let profileGeneration=0, recoveringGeneration=null, editingMealBase=null;
const tabs=["Сегодня","Тренировка","Питание","Профиль"];
const goals=["Общая форма","Сила","Набор мышц","Снижение веса","Выносливость"];
const options=(items,sel)=>items.map(x=>'<option '+(x===sel?'selected':'')+'>'+esc(x)+'</option>').join('');
const field=(id,label,type,value,attrs="")=>'<label>'+label+'<input id="'+id+'" type="'+type+'" value="'+esc(value)+'" '+attrs+'></label>';
function canMoveDate(id){return id==="wdate"&&$("original-weight")?.value||id==="mealdate"&&editingMeal||draft?.editBase&&(id==="start"||id==="end")}
const dt=(id,label,value=stamp(),required=true)=>{
 const limits=canMoveDate(id)?' max="'+local()+'"':' min="'+selectedDay+'T00:00" max="'+(id==="end"?shiftDay(selectedDay,1):selectedDay)+'T23:59"';
 return field(id,label,"datetime-local",value,(required?"required":"")+limits);
};
const check=(label,attrs,on=false)=>'<label class="check"><input type="checkbox" '+attrs+' '+(on?'checked':'')+'>'+esc(label)+'</label>';
const btn=(id,label,primary=false)=>'<button type="button" data-action="'+id+'" class="'+(primary?'primary':'')+'">'+label+'</button>';
const card=(title,body)=>'<article><h2>'+esc(title)+'</h2>'+body+'</article>';
const note=t=>$("message").textContent=t;
function initial(){
 return {profile:{height:"",age:"",sex:"",goal:goals[0],extra:[],week:Array(7).fill("Отдых"),minutes:45,step:2.5,equipment:[...starterEquipment],focus:"",fixed:false,supps:[]},weights:[],workouts:[],meals:[],supps:[]};
}
async function request(path,body){
 if(body?.data&&path.startsWith("profile/")){
   const data={...body.data};delete data.healthImported;
   body={...body,data};
 }
 const signal=typeof AbortSignal!=="undefined"&&AbortSignal.timeout?AbortSignal.timeout(12000):undefined;
 const r=await fetch(path,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal}:{signal});
 if(!r.ok&&path.startsWith("food?")){
   const data=await r.json().catch(()=>({}));
   throw Object.assign(Error("Не удалось выполнить поиск."),{status:r.status,reason:data?.reason});
 }
 if(r.status===413)throw Object.assign(Error("Размер записи превышает допустимый. При импорте выбери файл за меньший период."),{status:413});
 if(!r.ok&&path.startsWith("health/")){
   const data=await r.json().catch(()=>({}));
   const fallback=r.status===403?"Нет доступа к датчикам этого профиля.":"Не удалось обновить показания. Проверь настройки привязки.";
   throw Object.assign(Error(typeof data.error==="string"?data.error:fallback),{status:r.status});
 }
 if(!r.ok&&path.startsWith("proposals/")){
   const data=await r.json().catch(()=>({}));
   throw Object.assign(Error(data.error||"Не удалось загрузить предложения владельца."),{status:r.status});
 }
 if(!r.ok) throw Object.assign(Error(r.status===409?"Профиль изменён на другом устройстве. Сверь запись перед повторным сохранением.":r.status===403?"Нет доступа к этому профилю HA.":"Сервер недоступен. Повтори сохранение после восстановления связи."),{status:r.status});
 return r.json();
}
async function commit(change){
 const user=who,generation=profileGeneration;
 const next=structuredClone(state);change(next);
 try{
   const reply=await request("profile/"+user,{rev,data:next});
   if(user===who&&generation===profileGeneration&&reply.rev>=rev){
     rev=reply.rev;if(reply.diaryStartedOn)next.diaryStartedOn=reply.diaryStartedOn;state=next;
   }
 }catch(e){
   if(e.status===409){
     const latest=await request("profile/"+user).catch(()=>null);
     if(user===who&&generation===profileGeneration&&latest&&latest.rev>rev){
       state=unpack(latest);rev=latest.rev;renderDiaryUpdate();
     }
   }
   throw e;
 }
}
function retain(){localStorage.setItem(key(),JSON.stringify(draft))}
function unpack(result){
 const defaults=initial(),data=result.data;
 const loaded={...defaults,...data,profile:{...defaults.profile,...data.profile}};
 loaded.meals=loaded.meals.map((m,i)=>m.id?m:{...m,id:"legacy-"+i+"-"+m.date});
 return loaded;
}
const markerPrefix=()=> "sport:draft-marker:"+who+":";
function markerChanges(){
 const changes=[];
 for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);
   if(key?.startsWith(markerPrefix()))changes.push({key,id:key.slice(markerPrefix().length),date:localStorage.getItem(key)});
 }
 return changes;
}
function hasPendingDraftMarkers(){return markerChanges().length>0}
function queueMarker(id,date){localStorage.setItem(markerPrefix()+id,date||"")}
function reportState(){
 const markers={...state.workoutDrafts};
 for(const {id,date} of markerChanges())if(date)markers[id]={date};else delete markers[id];
 if(draft&&!draft.editBase)markers[draft.id]={date:draft.date};
 return {...state,workoutDrafts:markers};
}
function findStoredDrafts(){
 const prefix="sport:diary:draft:"+who+":",changes=[];
 for(let i=0;i<localStorage.length;i++){
   const k=localStorage.key(i);
   if(!k?.startsWith(prefix))continue;
   const d=JSON.parse(localStorage.getItem(k)||"null");
   if(d?.id&&!d.editBase&&!state.workouts.some(w=>w.id===d.id)&&state.workoutDrafts?.[d.id]?.date!==d.date)
     changes.push(d);
 }
 for(const d of changes)queueMarker(d.id,d.date);
}
async function syncDraftMarkers(){
 const changes=markerChanges(),user=who,generation=profileGeneration;
 if(!changes.length)return;
 for(let attempt=0;attempt<3;attempt++){
   const result=await request("profile/"+user);
   if(user!==who||generation!==profileGeneration)return;
   const latest=result.rev===rev?structuredClone(state):unpack(result),markers=latest.workoutDrafts||={};
   let changed=false;
   for(const {id,date} of changes){
     const desired=latest.workouts.some(w=>w.id===id)?"":date;
     if((markers[id]?.date||"")===desired)continue;
     if(desired)markers[id]={date:desired};else delete markers[id];
     changed=true;
   }
   try{
     const write=changed?await request("profile/"+user,{rev:result.rev,data:latest}):result;
     if(user!==who||generation!==profileGeneration)return;
     if(write.diaryStartedOn)latest.diaryStartedOn=write.diaryStartedOn;
     if(write.rev>=rev){rev=write.rev;state=latest}
     for(const {key,date} of changes)if(localStorage.getItem(key)===date)localStorage.removeItem(key);
     return;
   }catch(e){if(e.status!==409||attempt===2)throw e}
 }
}
async function publishDraftMarker(id,date){
 queueMarker(id,date);
 try{await syncDraftMarkers()}catch{note("Изменение сохранено на устройстве и будет отправлено в дневник при восстановлении связи.")}
}
const queuePrefix=()=> "sport:pending-workout:"+who+":";
function queued(){
 const items=[];
 for(let i=0;i<localStorage.length;i++){
   const k=localStorage.key(i);
   if(k?.startsWith(queuePrefix())){const raw=localStorage.getItem(k);if(raw)items.push({key:k,raw,...JSON.parse(raw)})}
 }
 return items;
}
async function flushWorkouts(){
 let conflict=false;
 for(const item of queued()){
   for(let attempt=0;attempt<3;attempt++){
     const result=await request("profile/"+who),latest=unpack(result);
     const index=latest.workouts.findIndex(w=>w.id===item.workout.id);
     const existing=latest.workouts[index]||null;
     if(JSON.stringify(existing)!==JSON.stringify(item.workout)||latest.workoutDrafts?.[item.workout.id]){
       if(JSON.stringify(existing)!==JSON.stringify(item.workout)&&JSON.stringify(existing)!==JSON.stringify(item.before)){
         conflict=true;break;
       }
       if(index<0)latest.workouts.push(item.workout);else latest.workouts[index]=item.workout;
       if(latest.workoutDrafts)delete latest.workoutDrafts[item.workout.id];
       try{const write=await request("profile/"+who,{rev:result.rev,data:latest});rev=write.rev;if(write.diaryStartedOn)latest.diaryStartedOn=write.diaryStartedOn}
       catch(e){if(e.status===409&&attempt<2)continue;throw e}
     }else rev=result.rev;
     state=latest;localStorage.removeItem(markerPrefix()+item.workout.id);if(localStorage.getItem(item.key)===item.raw)localStorage.removeItem(item.key);break;
   }
 }
 if(conflict)throw Error("На другом устройстве изменили тренировку. Локальная копия доступна во вкладке «Тренировка».");
}
function pendingPanel(){
 return queued().filter(({workout})=>workout.date.startsWith(selectedDay)).map(({workout})=>card("Сохранено на этом устройстве",'<p>'+esc(workout.date.replace("T"," "))+' · '+total(workout).sets+' подходов. Ожидает подтверждения сервера.</p>'+btn("sync-workouts","Отправить в HA")+btn("review-"+workout.id,"Проверить локальную копию"))+summary(workout,true)).join("");
}
async function refreshScale(user){
 const generation=profileGeneration;
 const incoming=await request("weights/"+user);
 if(user===who&&generation===profileGeneration&&Array.isArray(incoming))scale=incoming;
}
function boundScale(){
 return (people.find(person=>person.id===who)?.weightEntity||"").trim();
}
async function load(){
 const user=who,generation=profileGeneration;
 const result=await request("profile/"+user);
 if(user!==who||generation!==profileGeneration)return;
 state=unpack(result);rev=result.rev;
 if(queued().length){
   busy=true;$("who").disabled=true;
   try{await flushWorkouts()}catch(e){note(e.message)}finally{busy=false;$("who").disabled=false}
 }
 restoreDraft();findStoredDrafts();
 if(hasPendingDraftMarkers()){
   busy=true;$("who").disabled=true;
   try{await syncDraftMarkers()}catch(e){note(e.message)}finally{busy=false;$("who").disabled=false}
 }
 render();
 const previousScale=JSON.stringify(scale);
 await refreshScale(user).catch(()=>{});
 if(who===user&&generation===profileGeneration&&!busy&&previousScale!==JSON.stringify(scale))renderDiaryUpdate();
}
async function initialize(){
 people=await request("profiles");
 if(people[0]?.timeZone){setDiaryZone(people[0].timeZone);if(!state){selectedDay=local().slice(0,10);viewedMonth=selectedDay.slice(0,7)}}
 if(!calendarClockStarted&&typeof window!=="undefined"&&window.addEventListener){calendarClockStarted=true;watchCalendarDay()}
 $("who").hidden=people.length<2;
 $("single-profile").hidden=people.length!==1;
 $("single-profile").textContent=people.length===1?people[0].name:"";
 if(!people.length){$("content").textContent="Дневник пока не привязан к этой учётной записи. Администратор HA может открыть Настройки → Приложения → Спорт → Конфигурация и указать ID пользователя для нужного профиля. После сохранения перезапустите приложение.";$("who").disabled=true;return}
 if(!people.some(p=>p.id===who))who=people[0].id;
 $("who").innerHTML=people.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("");
 $("who").value=who;await load();
}
const pendingForms=new Map();
let formBindings=[], renderedScope="";
function healthContext(){
 return {state,day:selectedDay,tab,settingsOpen,profile:people.find(p=>p.id===who),zone:diaryZone,
   commit,request,render,note,reload:load,busy,setBusy(value){busy=value;$("who").disabled=value}};
}
function render(){
 const scope=JSON.stringify([who,tab,selectedDay]);
 const open=scope===renderedScope?Array.from(document.querySelectorAll("details[data-disclosure][open]"),d=>d.dataset.disclosure):[];
 renderedScope=scope;
 for(const button of document.querySelectorAll("nav [data-tab]")){
   const current=Number(button.dataset.tab)===tab;
   button.classList.toggle("active",current);
   if(current)button.setAttribute("aria-current","page");
   else button.removeAttribute("aria-current");
 }
 let heading="";
 if(tab){
   heading='<div class="sectionHead"><h1 class="page-title">'+esc(tabs[tab])+'</h1>'+
     '<button type="button" class="dateButton" data-action="show-calendar" aria-label="Выбрать дату, '+esc(dayLabel(selectedDay))+'" aria-expanded="'+sectionCalendarOpen+'">'+esc(dayLabel(selectedDay))+' <span aria-hidden="true">▾</span></button></div>';
   if(sectionCalendarOpen)heading+=weekStrip();
 }
 const healthPanels=SportHealthView.panels(healthContext());
 $("content").innerHTML=heading+[today,workout,food,profile][tab]()+'<div id="health-panels" data-health-panels'+(healthPanels?'':' hidden')+'>'+healthPanels+'</div>';
 if(tab===2)refreshProposals();
 if(tab===0)updateSupplementButton();
 for(const d of document.querySelectorAll("details[data-disclosure]"))if(open.includes(d.dataset.disclosure))d.open=true;
 bindSaveButtons();
 updatePortionPreview();
 syncEnergyFields();
 SportGoalsView.sync();
 for(const group of document.querySelectorAll(".equipmentGroup:has(.eqCount)"))updateEquipmentCount(group);
 updateFinishButton();
}
const formSelectors={
 "save-protein-goal":"#protein-mode,#protein-goal,#regular-strength","save-creatine-goal":"#creatine-plan,#creatine-goal,#creatine-size",
 "save-energy":"#energy-mode,#daily-maint,#energy-factor","save-track":"#reward-track",
 profile:"#height,#birth,#sex,#goal,#focus,#minutes,#step,#fixed,#workingSets,#returning,[data-load-unit],[name=extra],[name=legday],[name=eq],[data-week],[data-step-name]",
 "save-supps":"[name=uses]",meal:"#meal-form input,#meal-form select",weight:"#kg,#wdate,#original-weight"
};
function formKey(action,name=""){
 const day=["meal","weight","save-energy","save-protein-goal","save-creatine-goal"].includes(action)?selectedDay+(action==="meal"&&editingMeal?"|"+editingMeal:""):"";
 return JSON.stringify([who,day,action,name]);
}
function rememberForm(key,patch){
 if(patch)pendingForms.set(key,patch);else pendingForms.delete(key);
 try{
   const id="sport:editing:"+key;
   if(patch)sessionStorage.setItem(id,JSON.stringify(patch));else sessionStorage.removeItem(id);
 }catch{/* Edits remain in memory if the browser disables session storage. */}
}
const fieldValue=el=>el.type==="checkbox"?el.checked:el.value;
function trackForm(binding,restore=false){
 const patch=restore?(pendingForms.get(binding.key)||{}):{};
 for(const {el,id,base} of binding.fields){
   if(restore && Object.hasOwn(patch,id)){
     if(el.type==="checkbox")el.checked=patch[id];else el.value=patch[id];
   }
   const value=fieldValue(el);
   if(value!==base)patch[id]=value;else delete patch[id];
 }
 const changed=Object.keys(patch);
 binding.button.hidden=!changed.some(id=>binding.button.dataset.action!=="meal"||!["usual-mode","usual-count"].includes(id));
 rememberForm(binding.key,changed.length?patch:null);
}
function bindSaveButtons(){
 formBindings=[];
 for(const button of document.querySelectorAll("button[data-action]")){
   const action=button.dataset.action, isNote=action.startsWith("save-note-");
   if(!isNote&&!Object.hasOwn(formSelectors,action))continue;
   const controls=isNote?[button.closest("details").querySelector("textarea")]:document.querySelectorAll(formSelectors[action]);
   const key=formKey(isNote?"note":action,button.dataset.noteKey||"");
   if(!pendingForms.has(key)){
     try{const data=sessionStorage.getItem("sport:editing:"+key);if(data)pendingForms.set(key,JSON.parse(data))}catch{}
   }
   const fields=Array.from(controls,el=>({el,id:isNote?"text":(el.id||(el.dataset.loadUnit?"unit:"+el.dataset.loadUnit:"")||el.dataset.stepName||el.name+":"+el.value),base:fieldValue(el)}));
   const binding={key,button,fields};formBindings.push(binding);trackForm(binding,true);
 }
}
function updateEquipmentCount(group){
 group.querySelector(".eqCount").textContent=group.querySelectorAll("input[name=eq]:checked").length+" из "+group.querySelectorAll("input[name=eq]").length;
}
function updateFormEdits(ev){
 if(ev.type==="change"&&ev.target.id==="original-weight"){
   const row=ev.target.value?JSON.parse(ev.target.value):null;
   $("kg").value=row?.kg??"";$("wdate").value=row?local(diaryInstant(row.date)).slice(0,16):stamp();
   $("wdate").min=row?"":selectedDay+"T00:00";$("wdate").max=row?local():selectedDay+"T23:59";
 }
 if(["protein-mode","creatine-plan"].includes(ev.target.id))SportGoalsView.sync();
 if(["product","barcode","unit","nut0","nut1","nut2","nut3","food-fiber"].includes(ev.target.id)&&$("food-origin"))$("food-origin").value="Вручную";
 if(ev.target.closest?.("#meal-form")){
   if(ev.target.id==="unit"&&ev.target.dataset.previousUnit!==ev.target.value){
     const perHundred=val("food-basis")==="100";
     if(perHundred)for(let i=0;i<4;i++)$("nut"+i).value="";
     if(perHundred)$("food-fiber").value="";
     for(const mode of ["serving","package","piece"])$("size-"+mode).value="";
     if(val("portion-mode")==="base")$("amount").value="";
     if(val("usual-mode")==="base")$("usual-count").value="";
     const hint=$("food-unit-note");
     hint.textContent=(perHundred?"Введи КБЖУ на 100 "+ev.target.value+" и размеры в "+ev.target.value:
       "Введи размеры в "+ev.target.value+". КБЖУ на одну штуку сохранены")+".";
     hint.hidden=false;
   }
   if(ev.type==="change"&&ev.target.id==="portion-mode")$("amount").value="";
   if(ev.type==="change"&&ev.target.id==="food-basis"){
     $("food-fiber").value="";
     for(let i=0;i<4;i++)$("nut"+i).value="";
     $("food-origin").value="Вручную";
     if(ev.target.value==="piece"){$("portion-mode").value="piece";$("amount").value=""}
   }
   updatePortionPreview();
 }
 if(ev.target.name==="eq")updateEquipmentCount(ev.target.closest(".equipmentGroup"));
 const binding=formBindings.find(b=>b.fields.some(f=>f.el===ev.target));
 if(!binding)return;
 trackForm(binding);
 for(const other of formBindings.filter(b=>b!==binding && b.key===binding.key)){
   other.fields[0].el.value=ev.target.value;trackForm(other);
 }
}
document.addEventListener("input",updateFormEdits);
document.addEventListener("change",updateFormEdits);
async function saveForm(action,change,name=""){
 const key=formKey(action,name),submitted=pendingForms.get(key);
 await commit(change);
 if(submitted===pendingForms.get(key))rememberForm(key,null);
}
function distanceMeters(c){
 if(c.distanceKm==null)return c.distance;
 if(c.distanceKm.trim()==="")return "";
 const km=Number(c.distanceKm.trim().replace(",","."));
 return Number.isFinite(km)?Math.round(km*1e6)/1000:NaN;
}
function hasCardioResult(c){
 return Object.entries(c).some(([k,value])=>k!=="activity"&&value!==""&&value!=null);
}
function workoutSignature(w){
 const exercises=w.exercises.map(e=>[e.name,e.restSeconds,e.sets.map(t=>[t.kg,t.reps,!!t.done,!!t.easy,!!t.warmup])]);
 const cardio=w.cardio.map(c=>[...["time","hr","speed","incline","power","kcal","activity"].map(k=>String(c[k]??"")),String(distanceMeters(c)??"")]);
 return JSON.stringify([w.date,w.end,exercises,cardio,w.timing]);
}
function updateFinishButton(){
 const finish=document.querySelector('[data-action="finish"]');
 if(finish&&draft){
   finish.hidden=!draft.exercises.some(e=>e.sets.some(s=>s.done))&&!draft.cardio.some(hasCardioResult);
   const unchanged=draft.editSignature&&draft.editSignature===workoutSignature(draft);
   if(unchanged)finish.hidden=true;
   if($("finishHint")){
     $("finishHint").hidden=!finish.hidden;
     $("finishHint").textContent=unchanged?"Измени результат, чтобы сохранить исправление.":"Отметь подход или заполни дорожку, чтобы завершить занятие.";
   }
 }
}
function updateSupplementButton(){
 const submit=document.querySelector('[data-action="supp"]');
 if(submit)submit.hidden=!selected("supp").length;
}
function guideFor(name){
 return Object.hasOwn(guides,name)?guides[name]:null;
}
function guidePanel(name,settings=false){
 const g=guideFor(name);
 if(!g||g.legacy){
   const hint=g?"В старой записи не указан конкретный тренажёр. Выбери точный вариант в каталоге.":"Для своего упражнения можно сохранить личную настройку. Добавь в название вариант тренажёра.";
   return settings?'<details class="exerciseGuide" data-disclosure="'+esc("guide:"+name)+'"><summary>Об упражнении</summary><p class="guideBody">'+hint+'</p></details>':'<p class="muted">'+hint+'</p>';
 }
 const frames=g.photo?[0,1].map(i=>[exercisePhotoBase+g.photo+'/'+i+'.jpg','Положение '+(i+1)]):[[g.visualUrl,'Пример · '+g.visualSource]];
 const photos='<div class="guidePhotos">'+frames.map(([url,caption])=>'<figure><img data-photo="'+esc(url)+'" alt="'+esc(name+' · '+caption)+'" decoding="async" referrerpolicy="no-referrer"><figcaption>'+esc(caption)+'</figcaption><button type="button" class="retryPhoto" hidden>Загрузить фото ещё раз</button></figure>').join("")+'</div>'+
   (g.photo?'<small>Пример оборудования · Free Exercise DB</small>':'<a href="'+esc(g.reference)+'" target="_blank" rel="noopener noreferrer">Открыть пример у '+esc(g.visualSource)+' ↗</a>');
 return '<details class="exerciseGuide" data-disclosure="'+esc("guide:"+name)+'"><summary>Фото и техника</summary><div class="guideBody"><h3>'+esc(g.station)+'</h3><p>'+esc(g.recognize)+'</p>'+photos+'<dl>'+
 [["Настройка",g.setup],["Движение",g.movement],["На что обратить внимание",g.avoid],["Основная нагрузка",g.primary],["Помогают или стабилизируют",g.secondary]].map(([title,body])=>'<dt>'+title+'</dt><dd>'+esc(body)+'</dd>').join("")+'</dl></div></details>';
}
document.addEventListener("toggle",e=>{
 if(e.target.open && e.target.matches?.(".exerciseGuide"))for(const img of e.target.querySelectorAll("img[data-photo]:not([src])"))img.src=img.dataset.photo;
},true);
document.addEventListener("error",e=>{
 if(!e.target.matches?.("img[data-photo]"))return;
 e.target.hidden=true;e.target.closest("figure").querySelector("button").hidden=false;
},true);
document.addEventListener("click",e=>{
 const button=e.target.closest(".retryPhoto");if(!button)return;
 const img=button.closest("figure").querySelector("img");
 button.hidden=true;img.hidden=false;img.src=img.dataset.photo;
});
function notePanel(name,i){
 const key=noteKey(name),saved=state.profile.exerciseNotes?.[key]||"";
 return '<details class="exerciseNote" data-disclosure="'+esc("note:"+key)+'"><summary>Моя настройка'+(saved?' · есть запись':'')+'</summary><label>Комментарий к упражнению<textarea rows="3" maxlength="500" placeholder="Например: сиденье 4, спинка 2, рукоять узкая">'+esc(saved)+'</textarea></label><button type="button" class="primary" data-action="save-note-'+esc(i)+'" data-note-key="'+esc(key)+'" data-ex-name="'+esc(name)+'" hidden>Сохранить комментарий</button></details>';
}
function knownExerciseNames(){
 const p=state.profile;
 const recorded=[...p.equipment,...(p.customExercises||[]),...state.workouts.flatMap(w=>w.exercises.map(e=>e.name)),...(draft?.exercises||[]).map(e=>e.name)];
 return [...new Set([...Object.keys(guides).filter(n=>!guides[n].legacy),...recorded])];
}
function exercisePreferences(profile){
 const groups=new Map();
 for(const name of knownExerciseNames()){
   const group=guideFor(name)?.group||"Свои упражнения";
   if(!groups.has(group))groups.set(group,[]);
   groups.get(group).push(name);
 }
 return '<h3>Доступные упражнения</h3><p class="muted">Отметь упражнения, которые можно выполнять в твоём зале. Из них составляется план.</p>'+Array.from(groups,([group,names])=>'<details class="equipmentGroup" data-disclosure="'+esc("equipment:"+group)+'"><summary>'+esc(group)+' <span class="eqCount"></span></summary><div>'+names.map(n=>'<div class="exerciseChoice">'+check(exerciseLabel(n),'name="eq" value="'+esc(n)+'"',profile.equipment.includes(n))+guidePanel(n,true)+'<label>Как записываю вес<select data-load-unit="'+esc(noteKey(n))+'">'+options(loadUnits,profile.loadUnits?.[noteKey(n)]||loadUnits[0])+'</select></label><label>Шаг, кг<input type="number" min="0" max="100" step="any" data-step-name="'+esc(noteKey(n))+'" value="'+esc(profile.exerciseSteps?.[noteKey(n)]??"")+'" placeholder="По профилю"></label></div>').join("")+'</div></details>').join("");
}
const bars='<i class="gripBars" aria-hidden="true"></i>';
function doseFields(name,entry,day,editing){
 if(!["Протеин","Креатин"].includes(name))return "";
 const protein=name==="Протеин",pastUnknown=editing&&entry.servings==null;
 const servings=entry.servings??(editing?"":1);
 const separate=editing&&state.supps.filter(row=>row.date.slice(0,10)===day&&row.names.some(n=>canonicalSupp(n)===name)).length>1;
 const quantity='<label>'+(protein?"Саше":"Порций")+(separate?" в этой отметке":" за весь день")+'<input name="servings" type="number" inputmode="decimal" step="any" min="0" value="'+esc(servings)+'"'+(pastUnknown?' placeholder="Количество неизвестно"':"")+'></label>';
 let details="";
 const creatineSize=entry.creatinePerServing??(editing&&entry.servings!=null?3:SportGoals.creatineRule(state,day).serving);
 if(!protein)details='<label>Креатин в одной порции, г<input name="creatinePerServing" type="number" step="any" min="0.01" value="'+esc(creatineSize)+'"></label>';
 if(protein){
   const meals=state.meals.filter(m=>m.date.slice(0,10)===day&&
     !state.supps.some(d=>d!==entry&&d.mealId===m.id&&d.names.some(n=>canonicalSupp(n)==="Протеин")));
   details='<small>Первый Русский Протеин · 22 г белка в саше</small>'+
    '<label>Масса порошка в саше по упаковке, г (можно изменить)<input name="powderPerServing" type="number" inputmode="decimal" min="0" step="any" placeholder="Масса неизвестна" value="'+esc(entry.powderPerServing??(editing?"":30))+'"></label>'+
    (meals.length?'<label>Учёт в питании<select name="mealId"><option value="">Добавить белок отдельно</option>'+meals.map(m=>'<option value="'+esc(m.id)+'" '+(m.id===entry.mealId?"selected":"")+'>Весь протеин уже учтён · '+esc(m.date.slice(11,16)+" "+m.name)+'</option>').join("")+'</select></label>':"")+
    '<details><summary>КБЖУ одного саше по упаковке</summary>'+["Ккал","Белки, г","Жиры, г","Углеводы, г"].map((label,i)=>
      '<label>'+label+'<input name="doseNut'+i+'" type="number" step="any" min="0" value="'+esc(entry.perServing?.[i]??(i===1?22:""))+'"></label>').join("")+'</details>';
 }
 const tip=separate?"В этот день есть другие отметки. Каждая входит в итог отдельно.":"Если принимал ещё раз, укажи общее количество за день.";
 const content='<div data-dose-controls="'+esc(name)+'">'+quantity+'<small>'+tip+'</small>'+details+'</div>';
 if(editing)return content;
 return '<details class="doseQuantity" data-disclosure="'+esc("quantity:"+name)+'"><summary>'+ (protein?"Первый Русский Протеин · 22 г белка в саше":"Креатин · "+numberRu(creatineSize)+" г в порции")+' · количество</summary>'+content+'</details>';
}
function doseAmounts(controls){
 const read=name=>controls.querySelector('[name="'+name+'"]')?.value||"";
 return {servings:read("servings"),powderPerServing:read("powderPerServing"),mealId:read("mealId"),
   creatinePerServing:read("creatinePerServing"),
   perServing:controls.querySelector('[name="doseNut0"]')?[0,1,2,3].map(i=>read("doseNut"+i)):null};
}
function doseSnapshot(name,values,previous){
 if(!values)return {};
 const facts=recordedDose(name,Number(values.servings),values.powderPerServing===""?null:Number(values.powderPerServing),values.mealId);
 if(name==="Протеин"&&Array.isArray(previous?.perServing))facts.perServing=[...previous.perServing];
 if(name==="Протеин"&&values.perServing)facts.perServing=SportPortions.nutrients(values.perServing);
 if(name==="Креатин")facts.creatinePerServing=SportPortions.number(values.creatinePerServing||previous?.creatinePerServing||3,"Креатин в одной порции");
 return facts;
}
document.addEventListener("input",event=>{
 const controls=event.target.closest?.("[data-dose-controls]");
 if(!controls)return;
 if(!controls.closest("dialog"))draftDoseAmounts.set(who+"|"+controls.dataset.doseControls,doseAmounts(controls));
});
function planPanel(day){
 const slot=trainingSlot(state,draft,day);
 const logged=state.workouts.some(w=>w.date.startsWith(day))||draft?.date.startsWith(day);
 const loggedByName=new Map(state.supps.filter(x=>x.date.slice(0,10)===day).flatMap(x=>x.names.map(n=>[canonicalSupp(n),x])));
 const moves=state.suppMoves?.[day]||{};
 const snapshot=state.suppPlans?.[day],unknownPlan=loggedByName.size&&!Array.isArray(snapshot);
 const names=[...new Set([...(Array.isArray(snapshot)?snapshot:state.profile.supps).map(canonicalSupp),...loggedByName.keys()])];
 if(SportGoals.creatineRule(state,day).enabled&&!names.includes("Креатин"))names.push("Креатин");
 const rows=names.map(name=>{
 const [planned,hint]=schedule(name,slot),entry=loggedByName.get(name),move=moves[name];
 const clock=entry?entry.date.slice(11,16):move?.clock;
 const status=entry?"Принято":unknownPlan?"Можно добавить пропущенную отметку":day<local().slice(0,10)?"Не принимал":move?"Перенесено":"";
 return {name,section:entry?.period||move?.period||planned,hint:entry&&clock&&period(entry.date)!==entry.period?"Принято · "+clock+" · проверь время через кнопку переноса":status?status+(clock?" · "+clock:""):hint,taken:!!entry};
 });
 return '<div class="day-plan"><div><small>План на день</small><h3>'+ (slot==="Отдых"?"День отдыха":"Тренировка · "+slot.toLowerCase())+'</h3></div><label>Планы на зал<select id="daySlot" '+(logged?'disabled title="Время взято из занятия"':"")+'>'+options(["Отдых",...Object.keys(trainingSlots)],slot)+'</select></label></div>'+
 ["Утро","День","Вечер","Ночь","По назначению","По своей схеме"].map(time=>{
 const items=rows.filter(x=>x.section===time);
 if(!items.length&&(!names.length||!periods.includes(time)))return "";
 return '<div class="timegroup" data-slot="'+time+'"><strong>'+time+'</strong><div>'+items.map(x=>'<div class="dose"><button class="handle grip" type="button" data-move="'+esc(x.name)+'" aria-label="Перенести '+esc(x.name)+'" title="Перенести">'+bars+'</button>'+check(x.name,'name="supp" value="'+esc(x.name)+'" '+(x.taken?'disabled':''),x.taken||pendingDoses.has(x.name))+'<small>'+esc(x.hint)+'</small>'+(!x.taken?doseFields(x.name,draftDoseAmounts.get(who+"|"+x.name)||{},day,false):"")+'</div>').join("")+(items.length?"":'<small>Нет приёмов</small>')+'</div></div>';
 }).join('')+(names.length?'':btn("configure","Выбрать мои добавки"));
}
function weekStrip(){
 const first=new Date((expanded?viewedMonth+"-01":selectedDay)+"T12:00");
 const last=new Date(first.getFullYear(),first.getMonth()+1,0,12);
 const offset=(first.getDay()+6)%7, count=expanded?7*Math.ceil((offset+last.getDate())/7):7;
 const focusDay=expanded&&!selectedDay.startsWith(viewedMonth)?viewedMonth+"-01":selectedDay;
 const currentDay=local().slice(0,10);
 const label=first.toLocaleDateString("ru-RU",{month:"long",year:"numeric"});
 first.setDate(first.getDate()-offset);
 const workouts=new Set();
 for(const w of state.workouts){
   const {start,end,minutes}=workoutInterval(w);
   if(!Number.isFinite(start.getTime()))continue;
   workouts.add(diaryTime(start).slice(0,10));
   if(minutes>0)workouts.add(diaryTime(new Date(end.getTime()-1)).slice(0,10));
 }
 const open=new Set(Object.values(reportState().workoutDrafts).map(m=>m.date.slice(0,10)));
 const foods=foodByDate(state);
 let hasLegacy=false;
 const days=Array.from({length:count},(_,i)=>{
 const d=new Date(first);d.setDate(first.getDate()+i);const day=reportDate(d);
 const rows=foods.get(day),hasMeal=rows&&SportPortions.recordedFoodCount(rows.meals)>0;
 const activity=trainingStatus(day,currentDay,workouts.has(day),open.has(day));
 const gymClass={"Тренировка":"gym","В процессе":"gym active","Отдых":"gym restDay"}[activity];
 const status=supplementStatus(state,day,currentDay),symbol={"Принял":"taken","Принял часть":"some","Не принимал":"none","Есть отметки":"recorded"}[status];
 if(symbol==="recorded")hasLegacy=true;
 return '<button data-action="date-'+day+'" tabindex="'+(day===focusDay?0:-1)+'" '+(day===currentDay?'aria-current="date" ':'')+'class="calDay '+(day===selectedDay?'chosen ':'')+(expanded&&!day.startsWith(viewedMonth)?'outside':'')+'" aria-pressed="'+(day===selectedDay)+'" aria-label="'+dayLabel(day)+', '+activity+(hasMeal?', есть запись еды':'')+', добавки · '+status+'">'+d.getDate()+'<span class="dots">'+(gymClass?'<i class="'+gymClass+'"></i>':'')+(hasMeal?'<i class="meal"></i>':'')+(symbol?'<i class="doseMark '+symbol+'"></i>':'')+'</span></button>';
 }).join('');
 const legacyLegend=hasLegacy?' <i class="doseMark recorded"></i>Есть отметки (план неизвестен)':'';
 return '<section class="calendar" aria-label="Календарь"><div class="calTop">'+btn("cal-toggle",label+(expanded?" ▴":" ▾"))+(expanded?'<button data-action="cal-prev" aria-label="Предыдущий месяц">←</button><button data-action="cal-next" aria-label="Следующий месяц">→</button>':'')+btn("cal-today","Сегодня")+'</div><div class="calGrid">'+["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(x=>'<small>'+x+'</small>').join('')+days+'</div><small class="legend"><i class="gym"></i>Тренировка <i class="gym active"></i>В процессе <i class="gym restDay"></i>Отдых <i class="meal"></i>Есть еда</small><small class="legend">Добавки <i class="doseMark taken"></i>Принял <i class="doseMark some"></i>Часть <i class="doseMark none"></i>Не принимал'+legacyLegend+'</small></section>';
}
document.addEventListener("keydown",event=>{
 if(event.key==="Escape"&&sectionCalendarOpen&&tab&&event.target.closest?.(".calendar")){
   sectionCalendarOpen=false;expanded=false;render();
   document.querySelector('[data-action="show-calendar"]')?.focus();
   return
 }
 const grid=event.target.closest?.(".calGrid");
 if(!grid||!event.target.classList.contains("calDay"))return;
 const days=Array.from(grid.querySelectorAll(".calDay")),index=days.indexOf(event.target);
 const column=index%7;
 const offsets={ArrowRight:1,ArrowLeft:-1,ArrowDown:7,ArrowUp:-7,Home:-column,End:6-column};
 if(!Object.hasOwn(offsets,event.key))return;
 event.preventDefault();
 const target=days[Math.max(0,Math.min(days.length-1,index+offsets[event.key]))];
 event.target.tabIndex=-1;target.tabIndex=0;target.focus()
});
function hero(){
 const day=selectedDay,slot=trainingSlot(state,draft,day);
 const row=diaryReport(reportState(),scale,boundScale(),day,"day").rows[0];
 const status=row?.trainingStatus||("По плану · "+slot);
 const name=people.find(p=>p.id===who)?.name||"Профиль";
 const date=new Date(day+"T12:00").toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long"});
 const from=new Date(day+"T12:00");from.setDate(from.getDate()-6);from.setHours(0,0,0,0);const count=state.workouts.filter(x=>Date.parse(x.date)>=from.getTime()&&x.date.slice(0,10)<=day).length;
 return '<section class="hero"><div class="orbit" aria-hidden="true"></div><div class="heroMain"><small>'+esc(date)+'</small><h1>'+esc(name)+', твой день</h1><p>'+esc(status)+'</p>'+btn("open",draft?"Продолжить занятие →":"Открыть тренировку →",true)+'</div><div class="heroFoot"><b>'+count+'</b> занятий за 7 дней <span>·</span> <b>'+state.profile.minutes+'</b> мин в плане</div>'+weekStrip()+'</section>';
}
function today(){
 return hero()+dailyRecap()+card("Мои добавки",'<div id="planPanel">'+planPanel(selectedDay)+'</div>'+btn("supp","Подтвердить приём",true))+
 card("Приём за выбранный день",'<p id="doseStatus">'+supplementStatus(state,selectedDay)+'</p>'+state.supps.filter(x=>x.date.startsWith(selectedDay)).sort((a,b)=>(periodStart[b.period]||"").localeCompare(periodStart[a.period]||"")||b.date.localeCompare(a.date)).map(x=>x.names.map(n=>{
   const name=canonicalSupp(n),id=esc(encodeURIComponent(n)),isProtein=name==="Протеин",quantified=isProtein||name==="Креатин";
   const facts=isProtein?proteinIntake(state.meals.find(m=>m.id===x.mealId&&m.date.startsWith(selectedDay)),x):null;
   const servings=facts?.servings??x.servings, grams=isProtein?facts.proteinGrams:scaledValue(x.creatinePerServing??3,servings);
   const amount=quantified?(" · "+(servings>0?doseNumber(servings)+(isProtein?" саше":" порц."):"количество неизвестно")+
     (grams==null?"":" · "+doseNumber(grams)+(isProtein?" г белка":" г креатина"))):"";
   return '<div data-history-index="'+state.supps.indexOf(x)+'"><p>'+esc(x.period+(x.date.length>10?" "+x.date.slice(11):"")+" · "+n+amount)+'</p>'+btn("edit-dose-"+id,"Исправить · "+esc(n))+btn("undo-supp-"+id,"Снять отметку · "+esc(n))+'</div>';
 }).join("")).join(""));
}
function progressMeter(){
 const optional=draft.timing?estimateWorkout(draft.exercises,draft.timing).optional:[];
 const sets=draft.exercises.flatMap((e,i)=>optional.includes(i)?e.sets.filter(s=>s.done):e.sets),done=sets.filter(s=>s.done).length;
 return '<div class="meter" id="setMeter"><span>Выполнено подходов</span><b>'+done+' / '+sets.length+'</b><progress max="'+Math.max(1,sets.length)+'" value="'+done+'"></progress></div>';
}
function exercisePicker(i){
 const suffix=i===null?"new":i;
 const groups=new Map();
 for(const name of new Set([...state.profile.equipment,...knownExerciseNames()])){
   const group=state.profile.equipment.includes(name)?"Доступны в моём зале":guideFor(name)?.group||"Свои упражнения";
   if(!groups.has(group))groups.set(group,[]);
   groups.get(group).push(name);
 }
 const groupOptions=Array.from(groups,([label,names])=>'<optgroup label="'+esc(label)+'">'+names.map(n=>'<option value="'+esc("name:"+n)+'">'+esc(exerciseLabel(n))+'</option>').join("")+'</optgroup>').join("");
 return '<label class="exercisePicker">Упражнение<select id="exercise-'+suffix+'" data-picker="'+suffix+'"><option value="">Выбрать упражнение…</option><option value="custom">Ввести своё название…</option>'+groupOptions+'</select></label>'+
   '<label class="exercisePicker" hidden>Своё название<input id="custom-'+suffix+'" type="text" maxlength="100" autocomplete="off"></label>'+btn("choose-"+suffix,i===null?"Добавить упражнение":"Заменить");
}
document.addEventListener("change",event=>{
 const pos=event.target.dataset?.picker;if(pos===undefined)return;
 const input=$("custom-"+pos),custom=event.target.value==="custom";
 input.closest("label").hidden=!custom;
 if(custom)input.focus();
});
function editExercise(i){
 const rest=draft.timing?field("rest-"+i,"Пауза между рабочими подходами, с","number",strengthBlock(draft.exercises[i],i).restSeconds,'data-rest="'+i+'" min="0" max="600" step="1" required'):"";
 return '<details class="edit"><summary>Изменить упражнение и порядок</summary><div class="actions">'+(i>0?btn("up-"+i,"↑ Выше"):"")+(i+1<draft.exercises.length?btn("down-"+i,"↓ Ниже"):"")+btn("remove-"+i,"Убрать")+'</div>'+rest+exercisePicker(i)+'</details>';
}
function plannedLine(e){
 if(!e.prescription?.length)return "";
 const values=e.prescription.map(t=>t.kg+" × "+t.reps);
 const text=values.every(s=>s===values[0])?values.length+" подх. по "+values[0]:values.join(", ");
 return '<p class="muted">Исходный план · '+esc(text)+(e.loadUnit?" · "+esc(e.loadUnit):"")+'</p>';
}
function planOverview(session){
 if(!session.timing)return "";
 const {timing,exercises}=session,t=estimateWorkout(exercises,timing);
 const cardioRow=(name,c)=>'<li>'+name+' · '+(c.minutes?esc(c.activity)+' · '+c.minutes+' мин':'пропущена по плану')+'</li>';
 const rows=exercises.map((e,i)=>{
   const block=t.blocks[i];
   return '<li>'+esc(exerciseLabel(e.name))+' · '+block.minutes+' мин · рабочих подходов '+block.working+(block.ramp?', подводящих '+block.ramp:'')+(t.optional.includes(i)?' · <b>по желанию</b>':'')+'</li>';
 });
 const over=t.total-timing.budget;
 const count=t.blocks.reduce((sum,b)=>sum+b.working,0);
 let reserve="";
 if(session===draft&&timing.reserve&&!exercises.some(e=>e.name===timing.reserve)){
   const e=exerciseFor(timing.reserve,state.profile,completedBefore(state.workouts.filter(w=>w.id!==session.id),session.date),session.date);
   const extra=estimateWorkout([...exercises,e],timing).total-t.total;
reserve=t.total+extra<=timing.budget?btn("reserve-exercise","Добавить по желанию · "+esc(e.name)+" · +"+extra+" мин"):'<p class="muted">'+esc(e.name)+' · ещё '+extra+' мин. Для этого блока не хватает '+(t.total+extra-timing.budget)+' мин.</p>';
 }
 return '<div id="workoutBudget"><p><b>Оценка '+t.total+' из '+timing.budget+' мин.</b> Силовых упражнений '+exercises.length+', рабочих подходов '+count+'.</p>'+
   (over>0?'<p role="status"><b>Сверх бюджета на '+over+' мин.</b>'+(t.optional.length?' Обязательная часть · '+t.required+' мин.':'')+'</p>':'')+
   '<ol>'+cardioRow("Разминка",timing.cardio[0])+rows.join("")+cardioRow("Заминка",timing.cardio[1])+'</ol>'+
   '<small>В блоках учтены настройка, подходы и паузы. Переходы и запас · '+t.transitions+' мин.'+(timing.samples?' Поправка к общему времени по прошлым занятиям ('+timing.samples+') · '+(t.adjustment>0?'+':'')+t.adjustment+' мин.':'')+'</small>'+reserve+'</div>';
}
const cardioActivities=["Дорожка","Спокойная ходьба","Велотренажёр","Эллипсоид","Другое"];
function cardioBlock(i){
 const role=i?"Заминка":"Разминка",c=draft.cardio[i],proposal=draft.timing?.cardio[i];
 const planFields=proposal?'<p>В плане: '+esc(proposal.activity)+' · План '+esc(proposal.minutes)+' мин.</p>':"";
 const attrs=k=>'data-c="'+i+'" data-f="'+k+'"';
 const km=c.distanceKm??(c.distance!=null&&c.distance!==""?Number(c.distance)/1000:"");
 return card(role,planFields+'<h3>Фактический результат</h3><label>Вид активности<select '+attrs("activity")+'>'+options(cardioActivities,c.activity||"Дорожка")+'</select></label>'+
   field("sec"+i,"Время, мин:сек","text",c.time,attrs("time")+' placeholder="7:04"')+
   field("distance"+i,"Дистанция, км","text",km,attrs("distance")+' inputmode="decimal" pattern="[0-9]+([.,][0-9]+)?"')+
   [["speed","Средняя скорость, км/ч"],["incline","Средний уклон, %"],["hr","Средний пульс, уд/мин"],["power","Средняя мощность, Вт"],["kcal","Энергия, ккал"]].map(([k,n])=>field(k+i,n,"number",c[k],'min="0" step="any" '+attrs(k))).join(''));
}
function workout(){
 if(!draft)return pendingPanel()+(Object.values(state.workoutDrafts||{}).some(m=>m.date.startsWith(selectedDay))?card("В процессе","<p>Черновик тренировки открыт на другом устройстве.</p>"):"")+state.workouts.filter(w=>w.date.startsWith(selectedDay)&&!queued().some(item=>item.workout.id===w.id)).map(w=>summary(w)).join("")+card("Новая тренировка",dt("start","Дата и время начала")+planOverview(buildWorkoutPlan(state,stamp()))+btn("start","Начать тренировку",true));
 return card("Тренировка",dt("start","Начало",draft.date)+'<small> Черновик на этом устройстве</small>'+planOverview(draft))+
 card("Состав тренировки",(draft.focusLabel?'<p>Акцент плана · '+esc(draft.focusLabel)+'</p>':'')+(draft.guidance?'<p>'+esc(draft.guidance)+'</p>':'')+progressMeter()+(draft.exercises.length?"":'<p class="muted">'+(state.profile.equipment.length?'В выбранное время целиком помещается только кардио. Можно добавить силовое упражнение вручную; оно может увеличить длительность занятия.':'Выбери доступные упражнения в настройках профиля или добавь упражнение вручную.')+'</p>')+'<div class="sequence">'+draft.exercises.map((e,i)=>'<div class="exerciseRow" data-ex-index="'+i+'"><button type="button" class="reorderGrip grip" data-reorder="'+i+'" aria-label="Порядок: '+esc(exerciseLabel(e.name))+'. Стрелки вверх и вниз меняют позицию" title="Изменить позицию">'+bars+'</button><b>'+String(i+1).padStart(2,"0")+'</b><span>'+esc(exerciseLabel(e.name))+'</span><button type="button" data-action="remove-'+i+'" aria-label="Удалить '+esc(exerciseLabel(e.name))+'">Удалить</button></div>').join("")+'</div>'+exercisePicker(null))+
 cardioBlock(0)+draft.exercises.map((e,i)=>card(exerciseLabel(e.name),guidePanel(e.name)+notePanel(e.name,i)+editExercise(i)+plannedLine(e)+(e.advice?'<p>'+esc(e.advice)+'</p>':'')+'<p>Прошлый раз · '+esc(e.previous||"первое занятие")+'</p>'+e.sets.map((t,j)=>'<div class="set" data-i="'+i+'" data-j="'+j+'">'+field("k"+i+"_"+j,"кг","number",t.kg,'data-k="kg" min="0" step="0.1"')+field("r"+i+"_"+j,"Повторы","number",t.reps,'data-k="reps" min="1" step="1"')+check("Готово",'data-k="done"',t.done)+check("Подводящий подход",'data-k="warmup"',t.warmup)+'</div>' ).join('')+btn("add-"+i,"+ Подход")+btn("sub-"+i,"− Подход"))).join('')+cardioBlock(1)+
 card("Завершение",dt("end",selectedDay===local().slice(0,10)?"Окончание · оставь пустым, чтобы закончить сейчас":"Когда закончил тренировку",draft.end||"",selectedDay!==local().slice(0,10))+'<div class="actions">'+'<small id="finishHint">Отметь подход или заполни дорожку, чтобы завершить занятие.</small>'+btn("finish","Закончить и сохранить",true)+btn("cancel","Отменить тренировку")+'</div>');
}
function summary(w,pending=false){
 const kg=workoutWeightAtStart(w,state,scale,boundScale()),t=total(w,kg),gains=[];
 const cardio=w.cardio.map(c=>'<p><b>'+esc(c.role)+'</b>'+(c.activity?' · '+esc(c.activity):'')+' · '+Math.floor(c.seconds/60)+':'+String(c.seconds%60).padStart(2,"0")+[["hr","уд/мин"],["speed","км/ч"],["incline","% уклон"],["distance","км"],["power","Вт"],["kcal","ккал"]].filter(([k])=>c[k]!=null&&c[k]!=="").map(([k,u])=>" · "+esc(k==="distance"?(Number(c[k])/1000).toLocaleString("ru-RU",{maximumFractionDigits:4}):c[k])+" "+u).join("")+"</p>").join("");
 const prior=completedBefore(state.workouts.filter(entry=>entry.id!==w.id),w.date);
 for(const [i,e] of w.exercises.entries()){
   const done=e.sets.filter(t=>t.done);
   if(!done.length)continue;
   const actual=done.map(t=>t.kg+" × "+t.reps+(t.warmup?" (разминка)":"")).join(", ");
   const p={...state.profile,loadUnits:{...state.profile.loadUnits,[noteKey(e.name)]:e.loadUnit||""}};
   const next=exerciseFor(e.name,p,[w,...prior],w.end||w.date);
   gains.push('<p><b>'+esc(exerciseResultName(e))+'</b> · '+esc(actual)+(e.previous?'<br><small>Раньше · '+esc(e.previous)+'</small>':'')+'</p>'+plannedLine(e)+'<p>'+esc(next.advice)+'</p>'+guidePanel(e.name)+notePanel(e.name,"history-"+w.id+"-"+i));
 }
 const ready=w.exercises.filter(e=>{
   const sets=e.sets.filter(t=>!t.warmup);
   return qualifyingWeight({sets,planned:e.plannedSets||0},3)>0;
 }).map(e=>exerciseLabel(e.name));
 const feedback=ready.length?"По 12 повторов выполнены все рабочие подходы: "+ready.join(", ")+".":"";
 const missed=w.exercises.some(e=>e.sets.some(t=>!t.done)||e.sets.filter(t=>t.done&&!t.warmup).length<(e.plannedSets||0));
 const energy=t.estimated!=null?(kg?'≈ ':'')+t.estimated+' ккал за занятие':t.consoleCount?t.consoleKcal+' ккал по консоли · общий расход неизвестен':kg?'Для этой активности введи фактические ккал с консоли, чтобы учесть расход.':'Для оценки калорий нужен вес на начало занятия.';
 const linked=SportHealth.linkedWorkout(state,w);
 const watch=linked&&SportVisibility.section(state,"watch")?reportMetrics([["Активные ккал часов",linked.activeKcal==null?"—":numberRu(linked.activeKcal)+" ккал"],
   ["Полные ккал часов",linked.totalKcal==null?"—":numberRu(linked.totalKcal)+" ккал"],
   ["Средний пульс",linked.avgPulse==null?"—":numberRu(linked.avgPulse)+" уд/мин"]]):"";
 const energyNote=t.estimated==null?"":'<p class="muted">Показана оценка полного расхода за занятие. В суточном отчёте выбранный источник указан рядом с расходом.</p>';
 return card("Итог тренировки",'<p>'+t.minutes+' мин · '+t.sets+' подходов · '+t.volume+' кг суммарно</p><p>'+energy+' · вес '+(kg??'—')+' кг</p>' +energyNote+watch+'<p class="muted">За день с записанной тренировкой · +8 баллов. Все начисления доступны в профиле.</p>'+cardio+(pending?"":btn('edit-workout-'+esc(w.id),'Исправить тренировку')+btn('delete-workout-'+esc(w.id),'Удалить тренировку'))+esc(feedback)+gains.join('')+'<p>'+ (missed?'Занятие записано. В следующий раз повтори незавершённые рабочие подходы в комфортном объёме.':'План выполнен. При следующем старте будут учтены повторы и отмеченный запас.')+'</p>');
}
const mealLabels=["Ккал","Белки","Жиры","Углеводы"];
const portionModes={base:"Граммы / миллилитры",serving:"Порции",package:"Упаковки",piece:"По штукам"};
const proteinKinds={"":"Обычная еда",protein:"Протеиновая добавка",protein_mix:"Блюдо или напиток с протеиновой добавкой"};
function foodSelect(id,label,choices,selected){
 return '<label>'+label+'<select id="'+id+'">'+Object.entries(choices).map(([v,title])=>'<option value="'+v+'" '+(selected===v?'selected':'')+'>'+esc(title)+'</option>').join("")+'</select></label>';
}
const decimalField=(id,label,value)=>field(id,label,"text",value??"",'inputmode="decimal" autocomplete="off"');
function mealQuantityText(meal){
 return meal.portion?SportPortions.describe(meal.portion.mode,meal.portion.count,meal,meal.amount):meal.amount+" "+meal.unit;
}
function readFoodCard(){
 const code=val("barcode").trim(),name=val("product").trim(),basis=val("food-basis"),pieceName=val("piece-name").trim();
 if(code&&!/^\d{8,14}$/.test(code))throw Error("Укажи штрихкод из 8–14 цифр.");
 const sizes={};
 for(const mode of ["serving","package","piece"]){
   const raw=val("size-"+mode).trim();
   if(raw)sizes[mode]=SportPortions.number(raw,"Размер единицы");
 }
 const nut=SportPortions.nutrients(mealLabels.map((_,i)=>val("nut"+i)),basis==="piece"&&!editingMeal);
 const fiber=val("food-fiber").trim();
 if(basis==="piece"&&!pieceName)throw Error("Укажи название штуки для этой этикетки.");
 return {name,code,unit:val("unit"),nut,origin:val("food-origin"),...(basis==="piece"?{basis}:{}),
   ...(fiber?{fiber:SportPortions.number(fiber,"Клетчатка",true)}:{}),
   ...(val("product-kind")?{productKind:val("product-kind")}:{ }),
   ...(pieceName?{pieceName}:{}),...(Object.keys(sizes).length?{sizes}:{})};
}
function currentPortion(card){
 const grams=val("oil-grams").trim(),oilLabel=mealLabels.map((_,i)=>val("oil-nut"+i).trim());
 const hasOil=grams!==""&&SportPortions.number(grams,"Масло, г",true)>0;
 if(!grams&&oilLabel.some(Boolean))throw Error("Укажи, сколько граммов масла пришлось на эту порцию.");
 const original=editingMeal&&state.meals.find(m=>m.id===editingMeal);
 const result=SportPortions.calculate(card,{mode:val("portion-mode"),count:val("amount"),allowPartial:!!original,original,...(hasOil?{oil:{grams,nut:oilLabel,fiber:val("oil-fiber")}}:{})});
 if(card.productKind){
   const info={};
   for(const key of ["servings","powderGrams","proteinGrams"]){
     if(key==="proteinGrams"&&card.productKind==="protein")continue;
     const value=val("protein-"+key);
     if(value.trim())info[key]=SportPortions.number(value,"Состав протеиновой добавки",key==="proteinGrams");
   }
   if(info.proteinGrams!=null&&result.totals[1]!=null&&info.proteinGrams>result.totals[1])throw Error("Белка из порошка больше, чем белка во всей порции.");
   if(Object.keys(info).length)result.proteinDetails=info;
 }
 return result;
}
function readPersonalCard(){
 const card=readFoodCard();
 const usual=val("usual-count").trim(),mode=val("usual-mode");
 if(mode){
   const {portion}=SportPortions.calculate(card,{mode,count:usual||1});
   card.preferred={mode,...(usual?{count:portion.count}:{})};
 }else if(usual){
   throw Error("Выбери обычную единицу для указанного количества.");
 }
 return card;
}
function cardFields(card){
 return [card.name,card.code||"",card.unit,card.nut,card.basis||"100",card.pieceName||"",card.productKind||"",
   card.fiber??null,
   ...["serving","package","piece"].map(mode=>card.sizes?.[mode]??null),
   card.preferred?.mode||"",card.preferred?.count??null];
}
function updateFoodCardButton(){
 const button=$("card-options").querySelector('[data-action="save-food-card"]');
 button.hidden=true;
 if($("one-off").checked||!val("product").trim())return;
 try{
   const card=readPersonalCard(),existing=(state.products||[]).find(p=>SportPortions.sameProduct(p,card));
   button.hidden=Boolean(existing&&JSON.stringify(cardFields(existing))===JSON.stringify(cardFields(card)));
 }catch{button.hidden=false}
}
const macroUnits=["ккал","г белка","г жиров","г углеводов"];
function showMacros(values){
 return macroUnits.map((u,i)=>(Number.isFinite(values[i])?numberRu(values[i]):"—")+" "+u).join(" · ");
}
function updatePortionPreview(){
 if(tab!==2)return;
 const panel=$("portion-preview");
 if(!panel)return;
 $("food-basis-label").textContent=SportPortions.nutritionBasisLabel({basis:val("food-basis"),unit:val("unit"),pieceName:val("piece-name")});
 $("unit").dataset.previousUnit=val("unit");
 $("card-options").hidden=$("one-off").checked;
 $("protein-portion").hidden=!val("product-kind");
 $("protein-proteinGrams").closest("label").hidden=val("product-kind")!=="protein_mix";
 updateFoodCardButton();
 if(!val("product").trim()){panel.textContent="";return}
 try{
   const card=readFoodCard(),portion=currentPortion(card);
   const quantity=SportPortions.describe(portion.portion.mode,portion.portion.count,card,portion.amount);
   const oil=portion.oil?"<p>Основа · "+showMacros(portion.baseTotals)+"</p><p>Масло · "+numberRu(portion.oil.grams)+" г · "+showMacros(portion.oil.nut.map(v=>v==null?null:v*portion.oil.grams/100))+"</p>":"";
   panel.innerHTML="<p><strong>"+esc(quantity)+"</strong></p>"+oil+"<p>В съеденной порции · "+showMacros(portion.totals)+(portion.fiberTotal!=null?" · клетчатка "+numberRu(portion.fiberTotal)+" г":"")+"</p>";
 }catch(e){panel.textContent=e.message}
}
function selectFoodCard(item,repeat=false){
 const pref=repeat?item.portion:item.preferred;
 const mode=pref?.mode||(!repeat&&(item.pieceName||item.basis==="piece")?"piece":"base");
 const count=pref?.count??(repeat?item.amount:!pref&&mode==="base"?100:"");
 const usual=repeat?(state.products||[]).find(p=>SportPortions.sameProduct(p,item))?.preferred:item.preferred;
 const values={product:item.name,barcode:item.code||"",unit:item.unit,"food-basis":item.basis||"100","piece-name":item.pieceName||"",
   "food-fiber":item.fiber??"","oil-fiber":repeat?item.oil?.fiber??"":"",
   "product-kind":item.productKind||"","protein-servings":repeat?item.proteinDetails?.servings??"":"",
   "protein-powderGrams":repeat?item.proteinDetails?.powderGrams??"":"","protein-proteinGrams":repeat?item.proteinDetails?.proteinGrams??"":"", "protein-dose":"",
   "portion-mode":mode,amount:count,"usual-mode":usual?.mode||"","usual-count":usual?.count??"",
   "estimate-note":repeat?item.estimateNote||"":"","oil-grams":repeat?item.oil?.grams??"":"",
   "food-origin":item.origin||(pantry.includes(item)?"Встроенный каталог":item.catalogItem?"Каталог HA":item.online?"Open Food Facts":"Из дневника")};
 for(const name of ["serving","package","piece"])values["size-"+name]=item.sizes?.[name]??(item.portion?.mode===name?item.portion.size:"")??"";
 mealLabels.forEach((_,i)=>{values["nut"+i]=item.nut?.[i]??"";values["oil-nut"+i]=repeat?item.oil?.nut[i]??"":""});
 for(const [id,value] of Object.entries(values))$(id).value=value;
 $("one-off").checked=Boolean(editingMeal&&state.meals.find(m=>m.id===editingMeal)?.oneOff);
 $("food-unit-note").hidden=true;
 $("food-label").open=false;$("oil-options").open=Boolean(repeat&&item.oil);
 updatePortionPreview();
 const binding=formBindings.find(b=>b.button.dataset.action==="meal");if(binding)trackForm(binding);
 $("amount").focus();$("amount").select();
}
function mealForm(meal){
 const card=meal||{},previous=meal&&(state.products||[]).find(x=>SportPortions.sameProduct(x,meal)),prefs=previous?.preferred;
 const sizes={...card.sizes};
 if(meal?.portion?.size && meal.portion.mode!=="base")sizes[meal.portion.mode]=meal.portion.size;
 return '<div id="meal-form"><input type="hidden" id="food-origin" value="'+esc(card.origin||(meal?"Из дневника":"Вручную"))+'">'+
   dt("mealdate","Когда",meal?.date||stamp())+field("product","Продукт или блюдо","text",card.name||"",'maxlength="150"')+
   field("meal-group","Приём пищи, по желанию","text",meal?.mealGroup||"",'list="meal-groups" maxlength="80" placeholder="Например, завтрак"')+
   '<datalist id="meal-groups">'+[...new Set(["Завтрак","Обед","Ужин","Перекус",...state.meals.filter(m=>m.date.startsWith(selectedDay)&&m.mealGroup).map(m=>m.mealGroup)])].map(g=>'<option value="'+esc(g)+'"></option>').join("")+'</datalist>'+
   foodSelect("portion-mode","Как указать количество",portionModes,meal?.portion?.mode||"base")+
   decimalField("amount","Съедено",meal?.portion?.count??meal?.amount??100)+
   foodSelect("product-kind","Вид продукта",proteinKinds,card.productKind||"")+
   '<div id="protein-portion"'+(card.productKind?'':' hidden')+'><p>Вклад порошка в фактически съеденную порцию. Общие КБЖУ блюда укажи с учётом всех ингредиентов.</p>'+
   decimalField("protein-servings","Число саше, если известно",meal?.proteinDetails?.servings)+
   decimalField("protein-powderGrams","Масса порошка, г",meal?.proteinDetails?.powderGrams)+
   decimalField("protein-proteinGrams","Белок из порошка в смешанной порции, г",meal?.proteinDetails?.proteinGrams)+
   '<label>Связь с отметкой протеина<select id="protein-dose"><option value="">Отдельный приём</option>'+
   state.supps.flatMap((row,i)=>row.date.slice(0,10)===selectedDay&&row.names.some(n=>canonicalSupp(n)==="Протеин")&&(!row.mealId||row.mealId===meal?.id||!state.meals.some(m=>m.id===row.mealId))?
     ['<option value="'+i+'" '+(row.mealId&&row.mealId===meal?.id?'selected':'')+'>'+esc((row.date.slice(11,16)||row.period)+" · "+(row.servings==null?"количество неизвестно":doseNumber(row.servings)+" саше"))+'</option>']:[]).join("")+
   '</select></label></div>'+
   check("Только в дневник",'id="one-off" '+(meal?.oneOff?'disabled':''),meal?.oneOff)+
   '<div id="portion-preview" aria-live="polite"></div>'+
   '<details id="food-label" data-disclosure="food-label"><summary>Ввести этикетку и размеры</summary>'+
   field("barcode","Штрихкод","text",card.code||"",'inputmode="numeric" maxlength="14"')+
   foodSelect("unit","Единица на этикетке",{"г":"г","мл":"мл"},card.unit||"г")+
   '<p id="food-unit-note" class="muted" aria-live="polite" hidden></p>'+
   foodSelect("food-basis","Основание КБЖУ",{"100":"На 100 г / 100 мл",piece:"На одну штуку без добавленного масла"},card.basis||"100")+
   '<p id="food-basis-label" aria-live="polite">'+esc(SportPortions.nutritionBasisLabel(card))+'</p>'+
   mealLabels.map((n,i)=>decimalField("nut"+i,n,card.nut?.[i])).join("")+
   decimalField("food-fiber","Клетчатка на выбранное основание, г (если известна)",card.fiber)+
   decimalField("size-serving","Размер порции в г/мл",sizes.serving)+decimalField("size-package","Размер упаковки в г/мл",sizes.package)+
   field("piece-name","Название штуки, например яйцо","text",card.pieceName||"",'maxlength="50"')+
   decimalField("size-piece","Съедобный размер одной штуки в г/мл, если известен",sizes.piece)+
   field("estimate-note","Что оценено приблизительно","text",meal?.estimateNote||"",'maxlength="300"')+'</details>'+
   '<details id="oil-options" data-disclosure="food-oil"'+(meal?.oil?' open':'')+'><summary>Масло для жарки</summary>'+
   '<p>Добавь только долю масла, которую съел. Основа блюда должна быть без этого масла.</p>'+
   decimalField("oil-grams","Масло в съеденной порции, г",meal?.oil?.grams)+'<p>По этикетке масла на 100 г</p>'+
   decimalField("oil-fiber","Клетчатка масла, г на 100 г (если известна)",meal?.oil?.fiber)+
   mealLabels.map((n,i)=>decimalField("oil-nut"+i,n,meal?.oil?.nut[i])).join("")+'</details>'+
   '<details id="card-options" data-disclosure="food-card"><summary>Настроить личную карточку</summary>'+
   foodSelect("usual-mode","Обычная единица",{"":"Без предпочтения",...portionModes},prefs?.mode||"")+decimalField("usual-count","Обычное количество (по желанию)",prefs?.count)+
   btn("save-food-card","Сохранить настройки карточки")+'</details>'+
   btn("meal",meal?"Сохранить исправление":"Сохранить порцию",true)+(meal?btn("cancel-meal","Отмена"):"")+'</div>';
}
function recentPortions(){
 const repeat=SportPortions.recent(state.meals,selectedDay);
 return repeat.length?'<details data-disclosure="recent-meals"><summary>Повторить недавнюю порцию</summary>'+repeat.map(m=>btn("repeat-meal-"+esc(m.id),esc(m.name)+" · "+esc(mealQuantityText(m)))).join("")+"</details>":"";
}
function openMealEditor(meal,showLabel=false){
 if(!meal)throw Error("Приём удалён. Заново сверь данные.");
 editingMeal=meal.id;editingMealBase=JSON.stringify(meal);
 render();
 if(showLabel)$("food-label").open=true;
 $("product").focus();
}
function preferenceText(item){
 if(!item?.preferred)return "Не задано";
 const {mode,count}=item.preferred;
 if(count==null)return (mode==="piece"?item.pieceName:mode==="base"?item.unit:portionModes[mode])+" · количество не задано";
 return SportPortions.preferredText(item)||String(count)+" · "+portionModes[mode];
}
function proposalDetails(p){
 const {before,after}=p;
 const change=(label,from,to)=>'<p>'+esc(label)+' · '+esc(from)+' → '+esc(to)+'</p>';
 let info='<p><b>'+esc(after.name)+'</b></p><p>'+esc(p.reason)+'</p>';
 if(p.kind==="preference"){
   info+=change("Обычная порция",before?preferenceText(before):"Новая карточка",preferenceText(after));
   if(!before)info+='<p>'+showMacros(after.nut)+' '+esc(after.basis==="piece"?"на 1 "+after.pieceName:"на 100 "+after.unit)+'</p>';
 }else{
   info+=change("Дата и время",before.date.replace("T"," "),after.date.replace("T"," "));
   if("count" in p.changes)info+=change("Количество",mealQuantityText(before),mealQuantityText(after));
   if("nut" in p.changes)info+=change("КБЖУ этикетки",showMacros(before.nut),showMacros(after.nut));
   if("fiber" in p.changes||before.fiberTotal!==after.fiberTotal)info+=change("Клетчатка порции, г",before.fiberTotal??"неизвестно",after.fiberTotal??"неизвестно");
   if("mealGroup" in p.changes)info+=change("Приём пищи",before.mealGroup||"По времени",after.mealGroup||"По времени");
   if("oil" in p.changes){
     const oil=item=>item.oil?numberRu(item.oil.grams)+" г · "+showMacros(item.oil.nut)+" на 100 г":"Без масла";
     info+=change("Масло",oil(before),oil(after));
   }
   info+=change("КБЖУ порции",showMacros(before.totals),showMacros(after.totals));
   for(const d of p.days){
     const delta=d.change.map((v,i)=>(v>0?"+":"")+numberRu(v)+" "+macroUnits[i]+
       (d.missingAfter[i]||d.missingBefore[i]?" (по известным данным)":"")).join(" · ");
     info+='<p>'+esc(dayLabel(d.day)+" · изменение итога · "+delta)+'</p>';
   }
 }
 return info;
}
async function refreshProposals(){
 const panel=$("food-proposals"),user=who;
 if(!panel||!people.some(p=>p.id===user&&p.reviewProposals))return;
 try{
   const proposals=await request("proposals/"+user);
   if(who!==user||panel!==$("food-proposals"))return;
   const pending=proposals.filter(p=>p.status==="pending"),history=proposals.filter(p=>p.status!=="pending");
   const review=p=>proposalDetails(p)+btn("approve-proposal-"+esc(p.id),"Подтвердить",true)+
     btn("reject-proposal-"+esc(p.id),"Отклонить")+(p.kind==="meal"?btn("review-meal-"+esc(p.targetId),"Открыть «Исправить»"):"");
   const past=history.length?'<details><summary>Решения по предложениям ('+history.length+')</summary>'+history.map(p=>
     '<section><h3>'+(p.status==="approved"?"Подтверждено":"Отклонено")+'</h3>'+proposalDetails(p)+'</section>').join("")+'</details>':"";
   panel.innerHTML=proposals.length?card("Предложения помощника",pending.map(p=>'<section>'+review(p)+'</section>').join("")+past):"";
 }catch(error){if(who===user&&panel===$("food-proposals"))panel.textContent=error.message;}
}
function foodDiary(){
 return '<div id="food-proposals"></div>'+card("Дневник питания",'<p>'+esc(dayLabel(selectedDay))+'</p>'+nutritionEnergySummary()+'<div id="entries">'+mealList(selectedDay)+'</div>');
}
function food(){
 const meal=editingMeal&&editingMealBase?JSON.parse(editingMealBase):null;
 return card("Поиск продуктов",field("query","Название или штрихкод","search","",'enterkeyhint="search" maxlength="100"')+btn("search","Найти")+'<div id="recent-portions">'+recentPortions()+'</div>'+(window.BarcodeDetector?'<label>Фото штрихкода<input type="file" id="scan" accept="image/*" capture="environment"></label>':'')+'<div id="matches" aria-live="polite"></div>')+
 card("Порция",mealForm(meal))+'<div id="food-diary">'+foodDiary()+'</div>';
}
let foodSearchId=0;
let foodSearchTimer;
function showFoodMatches(panel,message,offerOnline){
 const rows=results.map((item,index)=>{
   const personal=(state.products||[]).includes(item);
   const origin=personal?'Моя карточка':pantry.includes(item)?'<a href="'+esc(item.source)+'" target="_blank" rel="noopener noreferrer">Карточка продукта ↗</a>':item.catalogItem?'Каталог на HA':item.online?'Онлайн · Open Food Facts':'Из дневника';
   const portion=personal&&item.preferred?preferenceText(item):"";
   const detail=[portion,item.quantity].filter(Boolean).map(esc).join(" · ");
   return '<div class="foodMatch">'+btn("pick-"+index,esc(item.name))+'<small>'+origin+(detail?' · '+detail:'')+'</small></div>';
 });
 const credit=results.some(item=>item.catalogItem||item.online)?'<small>© <a href="https://world.openfoodfacts.org/" target="_blank" rel="noopener noreferrer">Участники Open Food Facts</a> · <a href="https://github.com/TerjeRu/lethio-food-db" target="_blank" rel="noopener noreferrer">Каталог Lethio</a> · <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">ODbL</a></small>':'';
 panel.innerHTML=rows.join("")+credit+(message?'<p>'+esc(message)+'</p>':'')+(offerOnline?btn("search-online","Искать в Open Food Facts"):'');
}
const foodErrors={
 dns:"HA не смог определить сетевой адрес сервиса (DNS).",
 timeout:"Сервис не ответил вовремя.",
 rate_limit:"Сервис временно ограничил число запросов. Попробуй позже.",
 blocked:"Сервис отклонил запрос от HA (HTTP 403).",
 tls:"HA не смог установить защищённое соединение.",
 bad_data:"Сервис вернул данные в неожиданном формате.",
 unavailable:"HA не удалось получить ответ от сервиса."
};
function foodFailure(reason){
 return foodErrors[reason]||(/^http_\d{3}$/.test(reason)?"Сервис вернул HTTP "+reason.slice(5)+".":"Не удалось получить данные.");
}
async function startFoodSearch(forceOnline){
 clearTimeout(foodSearchTimer);
 const q=val("query").trim(),panel=$("matches"),id=++foodSearchId,profile=who,day=selectedDay;
 if(q.length<2){results=[];showFoodMatches(panel,"Введи хотя бы две буквы названия или штрихкод.",false);return}
 if(!forceOnline)results=distinctFoods(localFoods(q,state.products||[],state.meals),40);
 showFoodMatches(panel,forceOnline?"Ищу в Open Food Facts…":"Ищу в каталоге на HA…",false);
 const current=()=>id===foodSearchId&&who===profile&&selectedDay===day&&$("matches")===panel&&val("query").trim()===q;
 try{
   const response=await request((forceOnline?"food?q=":"food?source=catalog&q=")+encodeURIComponent(forceOnline?(providerFoodQuery(q)||q):q));
   if(!current())return;
   if(forceOnline){
     const before=results.length;
     results=distinctFoods([...results,...rankedFoods(q,response.map(importedFood))],40);
     showFoodMatches(panel,results.length===before?"Других совпадений в Open Food Facts нет. Можно ввести данные с упаковки.":"",false);
   }else{
     results=distinctFoods([...results,...response.products],40);
     const status={loading:"Расширенный каталог загружается на HA. Уже можно выбрать продукт или ввести его вручную.",
       unavailable:"HA пока не загрузил расширенный каталог. "+foodFailure(response.reason)+" Загрузка повторится автоматически.",
       demo:"В демо доступны встроенные карточки и твои продукты. Полный каталог открывается в HA."};
     showFoodMatches(panel,status[response.status]||(!results.length?"В каталоге совпадений нет. Можно поискать онлайн или ввести данные с упаковки.":""),response.status!=="demo");
   }
 }catch(error){
   if(!current())return;
   const message=error.status===403?"У этого аккаунта нет доступа к поиску в HA.":error.reason?(error.reason==="demo"?error.message:"Open Food Facts. "+foodFailure(error.reason)):"Не удалось получить ответ от приложения на HA. Повтори поиск.";
   showFoodMatches(panel,message,error.status!==403&&error.reason!=="demo");
 }
}
document.addEventListener("keydown",ev=>{
 if(ev.target.id==="query"&&ev.key==="Enter"&&!ev.isComposing){ev.preventDefault();document.querySelector('[data-action="search"]').click()}
});
document.addEventListener("input",ev=>{
 if(ev.target.id!=="query")return;
 const input=ev.target, panel=$("matches"), q=input.value.trim(), profile=who, day=selectedDay;
 clearTimeout(foodSearchTimer);
 foodSearchId++;
 results=q.length>=2?distinctFoods(localFoods(q,state.products||[],state.meals),40):[];
 if(q.length<2){panel.replaceChildren();return}
 showFoodMatches(panel,"",false);
 foodSearchTimer=setTimeout(()=>{if(who===profile&&selectedDay===day&&$("query")===input&&input.value.trim()===q)startFoodSearch(false)},300);
});
function mealList(day){
 const m=state.meals.filter(x=>x.date.startsWith(day)).sort((a,b)=>a.date.localeCompare(b.date));
 const macros=m.map(x=>{
   const values=SportPortions.mealNutrients(x);
   const detail=(x.oil?'<p>В том числе масло · '+numberRu(x.oil.grams)+' г · '+showMacros(macroUnits.map((_,i)=>scaledValue(x.oil.nut?.[i],x.oil.grams/100)))+'</p>':'')+
     (x.mealGroup?'<p>Приём пищи · '+esc(x.mealGroup)+'</p>':'')+(x.fiberTotal!=null?'<p>Клетчатка · '+numberRu(x.fiberTotal)+' г</p>':'')+
     (x.estimateNote?'<p>Приблизительно · '+esc(x.estimateNote)+'</p>':'');
   return '<p>'+esc(x.date.slice(11))+' · '+esc(x.name)+' · '+esc(mealQuantityText(x))+' · '+(Number.isFinite(values[0])?numberRu(values[0]):"—")+' ккал'+(x.oneOff?' · Только в дневник':'')+'</p>'+
     '<details><summary>КБЖУ порции</summary><p>'+showMacros(values)+'</p>'+detail+'<p>Источник · '+esc(x.origin||"Из дневника")+'</p></details>'+btn("edit-meal-"+esc(x.id),"Исправить")+btn("remove-meal-"+esc(x.id),"Удалить");
 });
 const daily=nutritionForDay(state,day);
 const supplements=daily.supplements.map(s=>'<p>'+esc(s.name)+' · '+(s.linked?'Учтено в порции':'Добавка · '+showMacros(s.nut))+'</p>');
 const totals=macroUnits.map((unit,i)=>{
   if(daily.missing[i]>0&&daily.count>daily.missing[i])return numberRu(daily.known[i])+' '+unit+' (по известным значениям)';
   return (Number.isFinite(daily.totals[i])?numberRu(daily.totals[i]):'—')+' '+unit;
 });
 return macros.join("")+supplements.join("")+'<p><strong>Итого за день</strong> · '+totals.join(" · ")+'</p>';
}
document.addEventListener("change",async ev=>{
 if(ev.target.id!=="scan"||!ev.target.files.length)return;
 try{const bmp=await createImageBitmap(ev.target.files[0]);let codes;
 try{codes=await new BarcodeDetector({formats:["ean_13","ean_8","upc_a"]}).detect(bmp)}finally{bmp.close()}
 if(!codes.length)throw Error("Код не распознан. Введи цифры с упаковки.");
 $("query").value=codes[0].rawValue;document.querySelector('[data-action="search"]').click();
 }catch(e){note(e.message)}
});
function supplementPreferences(p){
 const chosen=new Set(p.supps.map(canonicalSupp));
 const catalog=[...new Set([...Object.keys(supplements),...chosen])];
 return card("Мои добавки",'<p class="muted">Выбери то, что используешь. План появится на экране «Сегодня».</p><div class="catalog">'+catalog.map(n=>{
 const info=Object.hasOwn(supplements,n)?supplements[n]:null;
 return '<div>'+check(n,'name="uses" value="'+esc(n)+'"',chosen.has(n))+'<small>'+esc(info?info[0]+" · "+info[1]:"Личная запись")+'</small></div>';
 }).join("")+'</div>'+btn("save-supps","Сохранить выбор",true));
}
function profile(){
 const p=state.profile,until=selectedDay===local().slice(0,10)?new Date().toISOString():selectedDay+"T23:59:59.999";
 const measurement=measurementAt(state,until,scale,boundScale()),kg=measurement?.kg;
 const source=measurement?diaryInstant(measurement.date).toLocaleString("ru-RU",{timeZone:diaryZone})+" · "+(measurement.timeBasis==="legacy"?"Архив весов HA · время обновления":measurement.source==="ha"?"Весы HA":measurement.source==="manual"?"Вручную":"Ранее сохранено"):"";
 if(!settingsOpen)return resultsPage();
 const age=p.birth?Number(selectedDay.slice(0,4))-Number(p.birth.slice(0,4))-Number(selectedDay.slice(5)<p.birth.slice(5)):Number(p.age)||null;
 const metrics=[age!==null?"Возраст · "+age:null,kg&&Number(p.height)>0?"ИМТ · "+(kg/(Number(p.height)/100)**2).toFixed(1):null].filter(Boolean).join(" · ");
 const entity=boundScale();
 const linked=/^(sensor|input_number)\.[a-z0-9_]+$/.test(entity);
 let scaleStatus='Сущность веса не привязана';
 if(entity)scaleStatus=linked?'Привязана сущность <code>'+esc(entity)+'</code>':'Проверь ID сущности в конфигурации. Он должен начинаться с sensor. или input_number.';
 const conflict=people.find(p=>p.id===who)?.scaleConflict;
 const scaleHelp=conflict?"Обоим профилям назначена одна сущность. Выбери два разных персональных датчика, которые HA наполняет по диапазонам веса.":linked?(scale.some(w=>w.entity===entity)?"Вес подставляется автоматически. Более свежий ручной замер тоже учитывается.":"Пока нет показаний от этих весов. Проверь значение и единицу массы у сущности в HA."):"Привязать весы можно в Настройки HA → Приложения → Спорт → Конфигурация.";
 const binding='<div class="scaleBinding"><strong>Весы Home Assistant</strong><p>'+scaleStatus+'</p><small>'+scaleHelp+'</small>'+btn('scale-features','Проверить датчики весов в HA')+'<p id="scale-features" role="status"></p>'+disclosure("mi-scale-guide","Какие данные даёт Mi Scale V2",'<p><b>Stabilized weight</b> — устойчивый вес. Именно его удобно распределять в HA по личным диапазонам. Быстрого взвешивания для этого достаточно.</p><p><b>Weight и impedance</b> — вес и сопротивление в омах от одного полного измерения. Весы должны успеть измерить сопротивление. Проценты жира и мышц были бы отдельными оценками.</p><p><b>Non-stabilized weight</b> — промежуточные значения, <b>weight removed</b> — снятие нагрузки, <b>RSSI</b> — качество сигнала Bluetooth.</p><a href="https://custom-components.github.io/ble_monitor/by_property#stabilized-weight" target="_blank" rel="noopener noreferrer">Описание Passive BLE Monitor ↗</a>')+'</div>';
 const samples=state.weights.filter(w=>w.source==="manual"&&validBodyWeight(w.kg)&&Number.isFinite(diaryInstant(w.date).getTime())&&local(diaryInstant(w.date)).startsWith(selectedDay));
 const manual=(samples.length?'<label>Ручное взвешивание<select id="original-weight"><option value="">Новый замер</option>'+samples.map(w=>'<option value="'+esc(JSON.stringify({date:w.date,kg:w.kg}))+'">'+esc("Исправить · "+local(diaryInstant(w.date)).slice(11,16)+" · "+numberRu(w.kg)+" кг")+'</option>').join("")+'</select></label>':"")+
   field("kg","Вес, кг","number","","step=any")+dt("wdate","Дата взвешивания")+btn("weight","Сохранить замер");
 const manualForm=linked?'<details class="equipmentGroup" data-disclosure="manual-weight"><summary>Внести отдельный замер вручную</summary><div>'+manual+'</div></details>':manual;
 return btn("results","← К результатам")+'<section class="profileEditor">'+card("Данные профиля",field("height","Рост, см","number",p.height)+field("birth","Дата рождения","date",p.birth||"")+'<label>Пол<select id="sex">'+options(["","Мужской","Женский"],p.sex)+'</select></label><p>'+metrics+'</p><p>Вес · '+(kg||"—")+' кг · '+esc(source)+'</p>'+binding+manualForm)+
 card("Настройки плана",'<label>Основная цель<select id="goal">'+options(goals,p.goal)+'</select></label><div>Дополнительные цели</div>'+goals.map(n=>check(n,'name="extra" value="'+esc(n)+'"',p.extra.includes(n))).join('')+'<div><label>Приоритет<select id="focus">'+options(["","Ноги","Спина","Грудь","Плечи","Руки"],priorityGroup(p))+'</select></label></div>'+field("minutes","Длительность, мин","number",p.minutes)+field("step","Шаг прибавки, кг","number",p.step,"step=any")+check("Оставлять пропущенный день ног на том же дне недели (иначе — продолжить очередь в ближайшую тренировку)",'id="fixed"',p.fixed)+'<label>Рабочие подходы<select id="workingSets"><option value="0">По длительности и истории</option>'+[2,3,4].map(n=>'<option value="'+n+'" '+(Number(p.workingSets)===n?'selected':'')+'>'+n+'</option>').join('')+'</select></label>'+check("Возвращаюсь после перерыва · без автоматической прибавки",'id="returning"',p.returning)+'<details class="equipmentGroup weekPlan"><summary>Недельное расписание</summary><div>'+[1,2,3,4,5,6,0].map(i=>'<label>'+['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][i]+'<select data-week="'+i+'" id="week'+i+'">'+options(["Отдых",...Object.keys(trainingSlots)],p.week?.[i]||'Отдых')+'</select></label>').join('')+'</div></details><div>Дни с акцентом на ноги</div>'+["Вс","Пн","Вт","Ср","Чт","Пт","Сб"].map((n,i)=>check(n,'name="legday" value="'+i+'"',(p.legDays||[2]).includes(i))).join("")+exercisePreferences(p))+'<div class="profileSaveBar">'+btn("profile","Сохранить профиль",true)+'</div></section>'+
 SportGoalsView.settings(state,selectedDay)+reportSettings()+supplementPreferences(p);
}
const val=id=>$(id).value;
const selected=n=>Array.from(document.querySelectorAll('input[name="'+n+'"]:checked:not(:disabled)'),x=>x.value);
function when(id){
 const d=val(id),day=d.slice(0,10),ms=diaryInstant(d).getTime();
 if(!canMoveDate(id)&&day!==selectedDay&&!(id==="end"&&day===shiftDay(selectedDay,1)))throw Error("Выбери день события в календаре.");
 if(!Number.isFinite(ms)||ms>Date.now()+60000)throw Error("Укажи дату и время события в прошлом или сейчас.");
 return d;
}
function syncEnergyFields(){
 const mode=$("energy-mode");if(!mode)return;
 if($("energy-auto"))$("energy-auto").hidden=mode.value!=="auto";
 if($("energy-manual"))$("energy-manual").hidden=mode.value!=="manual";
}
document.addEventListener("change",ev=>{
 if(ev.target.id==="report-exercise"){reportExercise=ev.target.value;render();$("report-exercise")?.focus({preventScroll:true})}
 if(ev.target.id==="energy-mode")syncEnergyFields();
});
async function action(a,historyIndex){
 if(a==="save-protein-goal"){
   await saveForm(a,s=>SportGoals.setProtein(s,selectedDay,val("protein-mode"),Number(val("protein-goal")),$("regular-strength").checked));render();return;
 }
 if(a==="save-creatine-goal"){
   await saveForm(a,s=>{if(!SportVisibility.supplement(s,"Креатин"))throw Error("Креатин отключён в настройках профиля.");return SportGoals.setCreatine(s,selectedDay,$("creatine-plan").checked,Number(val("creatine-goal")),Number(val("creatine-size")))});render();return;
 }
 if(a.startsWith("approve-proposal-")||a.startsWith("reject-proposal-")){
   const approve=a.startsWith("approve-proposal-"),id=a.slice(approve?17:16);
   await request("proposals/"+who,{id,decision:approve?"approve":"reject"});
   await load();note(approve?"Изменение подтверждено.":"Предложение отклонено.");return;
 }
 if(a.startsWith("review-meal-")){
   const m=state.meals.find(item=>item.id===a.slice(12));
   if(!m)throw Error("Приём удалён. Заново сверь данные.");
   selectDay(m.date.slice(0,10));openMealEditor(m);return;
 }
 if(a.startsWith("refine-meal-")){
   const meal=state.meals.find(m=>m.id===decodeURIComponent(a.slice(12)));
   if(meal){selectDay(meal.date.slice(0,10));tab=2;openMealEditor(meal,true)}
   return;
 }
 if(a.startsWith("refine-dose-")){
   const [,index,encoded]=/^refine-dose-(\d+)-(.+)$/.exec(a)||[];
   const entry=state.supps[index];
   if(entry){selectDay(entry.date.slice(0,10));tab=0;render();openMove(decodeURIComponent(encoded),null,false,true,Number(index))}
   return;
 }
 if(a==="confirm-legacy-servings"){
   const count=SportPortions.number(val("legacy-servings"),"Число порций");
   const checked=Array.from(document.querySelectorAll('[name="legacy-quantity"]:checked'),
     el=>({index:Number(el.dataset.index),name:el.value})).sort((a,b)=>b.index-a.index);
   if(!checked.length)throw Error("Выбери отметки для исправления.");
   if(!confirm("Записать "+doseNumber(count)+" порц. в каждую отметку?\n"+checked.map(({index,name})=>dayLabel(state.supps[index].date.slice(0,10))+" · "+name).join("\n")))return;
   await commit(s=>{
     for(const {index,name} of checked){
       const old=s.supps[index];
       if(old.servings!=null)throw Error("Количество уже уточнено.");
       const updated={...old,names:[name],servings:count};
       s.supps=replaceRecordedDose(s.supps,index,name,updated);
     }
   });render();return;
 }
 if(a==="scale-features"){
   const panel=$("scale-features");panel.textContent="Проверяю сущности…";
   try{
     const data=await request("scale-info/"+who),labels={weight:"вес завершённого измерения",stable:"стабилизированный вес",unstable:"промежуточный вес",impedance:"импеданс (Ом)",removed:"снятие нагрузки",signal:"уровень сигнала Bluetooth (дБм)"};
     panel.textContent=data.demo?"Проверка доступна в установленном приложении HA.":data.sensors.length?
       data.sensors.map(x=>(x.model||"Весы")+" · "+labels[x.kind]).join(" / ")+". В личный дневник поступает вес с привязанной персональной сущности.":
       "У поддерживаемых интеграций не распознаны датчики весов. Привязку персонального веса можно использовать отдельно.";
   }catch{panel.textContent="HA не ответил на проверку датчиков. Попробуй позже."}
   return;
 }
 if(a==="report-day"){reportPeriod="day";settingsOpen=false;tab=3;render();return}
 if(a.startsWith("period-")&&Object.hasOwn(reportPeriods,a.slice(7))){reportPeriod=a.slice(7);render();return}
 if(a==="save-track"){
   const track=val("reward-track");if(!Object.hasOwn(tracks,track))return;
   await saveForm("save-track",s=>s.profile.rewardTrack=track);render();return;
 }
 if(a==="save-energy"){
   const day=selectedDay,mode=val("energy-mode"),p=state.profile;
   if(day>local().slice(0,10))throw Error("Выбери текущую или прошлую дату.");
   const rule={mode};
   if(mode==="manual"){
     rule.kcal=Number(val("daily-maint"));
     if(!Number.isSafeInteger(rule.kcal)||rule.kcal<=0)throw Error("Укажи суточный расход в ккал.");
   }else if(mode==="auto"){
     Object.assign(rule,{birth:p.birth,age:Number(p.age)||null,height:Number(p.height),sex:p.sex,factor:Number(val("energy-factor"))});
     if(maintenance(rule,day,70)==null)throw Error("Для оценки с 19 лет сначала сохрани дату рождения, рост и пол в профиле.");
   }else if(mode!=="off")return;
   await saveForm("save-energy",s=>{(s.energyRules||={})[day]=rule});render();return;
 }
 if(a==="settings"||a==="results"){settingsOpen=a==="settings";render();return}
 if(a.startsWith("date-")||a==="cal-today"){
   selectDay(a==="cal-today"?local().slice(0,10):a.slice(5));expanded=false;sectionCalendarOpen=false;render();
   const target=tab?'[data-action="show-calendar"]':'[data-action="date-'+selectedDay+'"]';
   document.querySelector(target)?.focus?.({preventScroll:true});
   return
 }
 if(a==="show-calendar"){
   sectionCalendarOpen=!sectionCalendarOpen;expanded=sectionCalendarOpen;viewedMonth=selectedDay.slice(0,7);render();
   document.querySelector(sectionCalendarOpen?'[data-action="date-'+selectedDay+'"]':'[data-action="show-calendar"]')?.focus?.({preventScroll:true});
   return
 }
 if(a==="cal-toggle"){expanded=!expanded;viewedMonth=selectedDay.slice(0,7);render();document.querySelector('[data-action="cal-toggle"]')?.focus?.();return}
 if(a==="cal-prev"||a==="cal-next"){const d=new Date(viewedMonth+"-01T12:00");d.setMonth(d.getMonth()+(a==="cal-prev"?-1:1));viewedMonth=reportDate(d).slice(0,7);render();document.querySelector('[data-action="'+a+'"]')?.focus?.();return}
 if(a==="configure"){tab=3;settingsOpen=true;render();document.querySelector(".catalog")?.scrollIntoView({block:"center"});return}
 if(a.startsWith("save-note-")){
   const button=document.querySelector('[data-action="'+CSS.escape(a)+'"]');
   if(!button)return;
   const field=button.closest("details").querySelector("textarea"),value=field.value.trim(),key=button.dataset.noteKey;
   if(field.value.length>500)throw Error("Комментарий может содержать до 500 символов.");
   await saveForm("note",s=>{
     const notes=s.profile.exerciseNotes||={};
     if(value){
       notes[key]=value;
       const name=button.dataset.exName;
       if(!guideFor(name)&&!(s.profile.customExercises||[]).some(n=>noteKey(n)===key)){
         (s.profile.customExercises||=[]).push(name);
       }
     }else delete notes[key];
   },key);
   render();document.querySelector('[data-action="'+CSS.escape(a)+'"]')?.closest("details").querySelector("summary").focus({preventScroll:true});
   note(value?"Комментарий сохранён.":"Комментарий удалён.");return
 }
 if(a==="save-supps"){
   const uses=selected("uses"),today=local().slice(0,10);
   await saveForm("save-supps",s=>{
     s.profile.supps=uses;
     if(Array.isArray(s.suppPlans?.[today]))s.suppPlans[today]=[...uses];
   });render();note("Выбор добавок сохранён.");return;
 }
 if(/^(?:up|down|remove|choose)-\d+$/.test(a)||a==="choose-new"){
   const [op,pos]=a.split("-"),i=Number(pos),items=draft.exercises;
   if(op==="up"||op==="down"){
     const j=i+(op==="up"?-1:1);if(i>=0&&j>=0&&i<items.length&&j<items.length)[items[i],items[j]]=[items[j],items[i]];
   }else{
     const choice=op==="choose"?val("exercise-"+pos):"";
     const typed=(choice==="custom"?val("custom-"+pos):choice.slice(5)).trim().replace(/\s+/g," ");
     if(typed.length>100)throw Error("Название упражнения должно быть не длиннее 100 символов.");
     const name=knownExerciseNames().find(n=>noteKey(n)===noteKey(typed))||typed;
     if(choice==="custom"&&guideFor(name)?.legacy)throw Error("Уточни тренажёр в названии или выбери конкретный вариант из списка.");
     if(op==="choose"&&pos!=="new"&&items[i]?.name===name)return;
     if(op==="choose"&&!name)throw Error("Выбери упражнение или введи своё название.");
     if(pos!=="new"&&items[i].sets.some(t=>t.done)&&!confirm("Убрать упражнение вместе с отмеченными подходами?"))return;
     if(op==="remove")items.splice(i,1);
     else{
       const past=completedBefore(state.workouts.filter(w=>w.id!==draft.id),draft.date);
       const exercise=exerciseFor(name,state.profile,past,draft.date);
       exercise.manual=true;
       if(pos==="new")items.push(exercise);else items[i]=exercise;
     }
   }
   retain();render();return;
 }
 if(a==="sync-workouts"){await flushWorkouts();render();note("Отправлено в дневник.");return}
 if(a.startsWith("delete-workout-")){
   const id=a.slice("delete-workout-".length);
   if(queued().some(item=>item.workout.id===id))throw Error("Сначала отправь локальную правку в дневник.");
   if(!confirm("Удалить сохранённую тренировку и пересчитать результаты?"))return;
   await commit(s=>{s.workouts=s.workouts.filter(w=>w.id!==id)});
   lastSummary=null;render();return;
 }
 if(a.startsWith("edit-workout-")||a.startsWith("review-")){
   if(draft)throw Error("Сначала закончи или отмени открытый черновик.");
   const review=a.startsWith("review-"),id=a.slice(review?7:13);
   const pending=queued().find(item=>item.workout.id===id);
   if(!review&&pending)throw Error("На этом устройстве есть неотправленная правка. Открой локальную копию тренировки.");
   const current=unpack(await request("profile/"+who)).workouts.find(w=>w.id===id);
   const w=review?pending?.workout:current;
   if(!w)throw Error("Запись недоступна.");
   if(review&&!confirm("Открыть локальную копию? После проверки сохранение заменит текущую версию в HA."))return;
   selectDay(w.date.slice(0,10));if(draft)throw Error("На этой дате уже есть открытый черновик.");
   const copy=structuredClone(w);
   copy.cardio=["Разминка","Заминка"].map(role=>{const c=copy.cardio.find(x=>x.role===role);if(!c)return {};const {seconds,role:unused,...fields}=c;return {...fields,time:fields.time||Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0")}});
   copy.editBase=current||null;if(!review)copy.editSignature=workoutSignature(copy);draft=copy;retain();if(review&&localStorage.getItem(pending.key)===pending.raw)localStorage.removeItem(pending.key);tab=1;render();return
 }
 if(a==="open"){tab=1;render();return}
 if(a==="reserve-exercise"&&draft?.timing?.reserve){
   const extra=exerciseFor(draft.timing.reserve,state.profile,completedBefore(state.workouts.filter(w=>w.id!==draft.id),draft.date),draft.date);
   if(!draft.exercises.some(e=>e.name===extra.name)&&estimateWorkout([...draft.exercises,extra],draft.timing).total<=draft.timing.budget){
     extra.optional=true;draft.exercises.push(extra);retain();
   }
   render();return;
 }
 if(a==="start"){const date=when("start"),past=completedBefore(state.workouts,date),p=state.profile;
   const cycle=trainingCycle(p,past,date),availableGroups=new Set(p.equipment.map(n=>guideFor(n)?.group).filter(Boolean));
   const group=availableGroups.size===1?[...availableGroups][0]:cycle===0&&availableGroups.has("Ноги")?"Ноги":priorityGroup(p)||"Общая тренировка";
   draft={id:newEntryId(),date,focusLabel:group,...buildWorkoutPlan(state,date),cardio:[{},{}]};retain();lastSummary=null;await publishDraftMarker(draft.id,date)}
 if(a==="cancel"){if(!confirm("Удалить черновик этой тренировки?"))return;const cancelled=draft;draft=null;retain();
   if(!cancelled.editBase)await publishDraftMarker(cancelled.id,"")}
 if(a.startsWith("add-")||a.startsWith("sub-")){const sets=draft.exercises[+a.split("-")[1]].sets;if(a.startsWith("add"))sets.push({...sets.at(-1),kg:sets.at(-1)?.kg||0,reps:sets.at(-1)?.reps||10,done:false,easy:false,warmup:false});else sets.pop();retain()}
 if(a==="finish"){
   const w=structuredClone(draft);w.date=when("start");w.end=(draft.end||selectedDay!==local().slice(0,10))?when("end"):local();await refreshScale(who).catch(()=>{});
   const before=w.editBase||null;delete w.editBase;delete w.editSignature;
   if(w.timing){
     const optional=estimateWorkout(w.exercises,w.timing).optional;
     w.exercises=w.exercises.flatMap((e,i)=>{
       if(!optional.includes(i))return [e];
       const sets=e.sets.filter(t=>t.done);
       return sets.length?[{...e,optional:true,sets,plannedSets:sets.filter(t=>!t.warmup).length}]:[];
     });
   }
   w.startedAt=before?.date===w.date&&before.startedAt?before.startedAt:diaryInstant(w.date).toISOString();
   w.endedAt=before?.end===w.end&&before.endedAt?before.endedAt:diaryInstant(w.end).toISOString();
   const sample=measurementAt(state,w.startedAt,scale,boundScale());
   if(before&&before.date===w.date){w.kg=before.kg;w.weightSample=before.weightSample||null}
   else{w.kg=sample?.kg??null;w.weightSample=sample?{date:sample.date,source:sample.source||"legacy",kg:sample.kg,entity:sample.entity,timeBasis:sample.timeBasis}:null}
   w.person=before?.person||{height:state.profile.height,birth:state.profile.birth,sex:state.profile.sex};
   if(w.exercises.some(e=>e.sets.some(t=>t.done&&(!Number.isInteger(t.reps)||t.reps<1||!Number.isFinite(t.kg)||t.kg<0)))){
     throw Error("У отмеченного подхода укажи повторы и вес. Для упражнения без отягощения введи 0 кг.");
   }
   w.cardio=w.cardio.flatMap((c,i)=>{if(!hasCardioResult(c))return [];if(!/^\d{1,3}:[0-5]\d$/.test(c.time||""))throw Error("Укажи время дорожки в формате мин:сек.");
    if(c.distanceKm!=null){c.distance=distanceMeters(c);delete c.distanceKm}
    for(const key of ["kcal","hr","speed","incline","distance","power"]){
      if(c[key]!==""&&c[key]!=null&&(!Number.isFinite(Number(c[key]))||Number(c[key])<0))throw Error("Проверь показания дорожки: нужны числа от нуля.");
    }
    const [m,s]=c.time.split(":").map(Number),seconds=m*60+s;
    if(!seconds)throw Error("Время дорожки должно быть больше нуля.");
    return [{...c,role:i?"Заминка":"Разминка",seconds,kcal:c.kcal==null||c.kcal===""?null:Number(c.kcal)}]});
   const elapsed=Date.parse(w.endedAt)-Date.parse(w.startedAt);
   if(elapsed<=0||elapsed>86400000||w.cardio.reduce((a,c)=>a+c.seconds,0)>elapsed/1000)throw Error("Проверь время начала, окончания и длительность дорожки.");
   if(!total(w).sets&&!w.cardio.length)throw Error("Отметь выполненный подход или внеси дорожку.");
   localStorage.setItem(queuePrefix()+w.id,JSON.stringify({workout:w,before}));
   draft=null;retain();lastSummary=w;
   try{await flushWorkouts();note("Тренировка сохранена в дневнике.")}catch(e){note("Сохранено на устройстве. "+e.message)}
   if(w.date.slice(0,10)!==selectedDay)selectDay(w.date.slice(0,10));
 }
 if(a.startsWith("history-")){const w=state.workouts.find(w=>w.id===a.slice(8));selectDay(w.date.slice(0,10));tab=1}
 if(a==="weight"){const kg=Number(val("kg")),date=diaryInstant(when("wdate")).toISOString();if(!(kg>0&&kg<700))throw Error("Проверь вес.");await saveForm("weight",s=>{
   SportGoals.saveWeight(s,$("original-weight")?.value?JSON.parse(val("original-weight")):null,date,kg)
 })}
 if(a==="profile"){const minutes=Number(val("minutes")),step=Number(val("step"));if(val("birth")&&Date.parse(val("birth"))>Date.now()||val("height")&&!(Number(val("height"))>0&&Number(val("height"))<300))throw Error("Проверь рост и дату рождения.");if(!Number.isFinite(minutes)||!Number.isFinite(step)||minutes<10||minutes>240||step<=0||step>20)throw Error("Проверь оборудование, длительность и шаг прибавки.");const exerciseSteps={};for(const f of document.querySelectorAll("[data-step-name]"))if(f.value!==""){if(!f.checkValidity())throw Error("Проверь шаг веса у упражнения.");exerciseSteps[f.dataset.stepName]=Number(f.value)}
   const week=Array.from({length:7},(_,i)=>val("week"+i));
   const prior=autoEnergyRule(state.profile,activeEnergyRule());
   await saveForm("profile",s=>{Object.assign(s.profile,{week,exerciseSteps,workingSets:Number(val("workingSets")),returning:$("returning").checked,
       loadUnits:Object.fromEntries(Array.from(document.querySelectorAll("[data-load-unit]")).filter(el=>el.value!==loadUnits[0]).map(el=>[el.dataset.loadUnit,el.value])),height:val("height"),birth:val("birth"),sex:val("sex"),minutes,step,goal:val("goal"),focus:val("focus"),extra:selected("extra"),fixed:$("fixed").checked,legDays:selected("legday").map(Number),equipment:selected("eq")});
     if(prior.mode==="auto"&&(prior.birth!==s.profile.birth||prior.sex!==s.profile.sex||prior.height!==Number(s.profile.height))){
       const rules=s.energyRules||={};
       if(!Object.keys(rules).some(key=>key<selectedDay)&&prior.birth&&prior.height&&prior.sex)rules["0001-01-01"]=prior;
       rules[selectedDay]={mode:"auto",birth:s.profile.birth,age:Number(s.profile.age)||null,sex:s.profile.sex,height:Number(s.profile.height),factor:prior.factor};
     }
     SportGoals.profileChanged(s,selectedDay);
   })}
 if(a.startsWith("edit-dose-")){openMove(canonicalSupp(decodeURIComponent(a.slice(10))),null,false,true,historyIndex);return}
 if(a.startsWith("undo-supp-")){
   const name=decodeURIComponent(a.slice(10));if(!confirm("Снять отметку о приёме?"))return;
   await commit(s=>{
     const index=historyIndex??s.supps.findIndex(x=>x.date.startsWith(selectedDay)&&x.names.some(n=>canonicalSupp(n)===canonicalSupp(name)));
     rememberDosePlan(s,selectedDay);
     if(canonicalSupp(name)==="Протеин")preserveMealProtein(s,s.supps[Number(index)]);
     s.supps=replaceRecordedDose(s.supps,Number(index),name);
   });render();return;
 }
 if(a==="supp"){
 const choices=Array.from(document.querySelectorAll('input[name="supp"]:checked:not(:disabled)'),input=>{
   const slot=input.closest("[data-slot]").dataset.slot;
   const move=state.suppMoves?.[selectedDay]?.[input.value];
   const controls=input.closest(".dose").querySelector("[data-dose-controls]");
   return {...doseEntry(input.value,selectedDay,slot,move?.clock,local()),...doseSnapshot(input.value,controls?doseAmounts(controls):null)};
 });
 if(!choices.length)throw Error("Выбери принятые добавки.");
 await commit(s=>addDoseEntries(s,selectedDay,choices));
 for(const entry of choices){pendingDoses.delete(entry.names[0]);draftDoseAmounts.delete(who+"|"+entry.names[0])}
 }
 if(a==="search"||a==="search-online"){startFoodSearch(a==="search-online");return}
 if(a.startsWith("pick-")){const item=results[+a.slice(5)];if(item)selectFoodCard(item);return}
 if(a==="cancel-meal"){rememberForm(formKey("meal"),null);editingMeal=null;render();return}
 if(a.startsWith("repeat-meal-")){const m=state.meals.find(x=>x.id===a.slice(12)&&!x.oneOff);if(!m)return;editingMeal=null;render();$("one-off").checked=false;selectFoodCard(m,true);return}
 if(a.startsWith("edit-meal-")){openMealEditor(state.meals.find(m=>m.id===a.slice(10)));return}
 if(a.startsWith("remove-meal-")){const id=a.slice(12);if(!confirm("Удалить эту порцию из дневника?"))return;await commit(s=>removeMealIntake(s,id));editingMeal=null;render();return}
 if(a==="save-food-card"){
   if($("one-off").checked)throw Error("Для разовой порции настройки карточки недоступны.");
   const card=readPersonalCard();
   if(!card.name)throw Error("Введи название продукта.");
   await commit(s=>{s.products=[card,...(s.products||[]).filter(p=>!SportPortions.sameProduct(p,card))]});
   if(results.some(item=>SportPortions.sameProduct(item,card))){
     results=results.map(item=>SportPortions.sameProduct(item,card)?card:item);
     showFoodMatches($("matches"),"",Boolean($("matches").querySelector('[data-action="search-online"]')));
   }
   updateFoodCardButton();note("Настройки личной карточки сохранены.");return;
 }
 if(a==="meal"){
   if(editingMeal&&editingMealBase!==JSON.stringify(state.meals.find(m=>m.id===editingMeal)))throw Error("Порция изменилась на другом устройстве. Сверь запись в дневнике, нажми «Отмена» и открой исправление заново.");
   const card=readFoodCard();
   if(!card.name)throw Error("Введи название продукта.");
   const intake=currentPortion(card),id=editingMeal||newEntryId(),date=when("mealdate"),estimateNote=val("estimate-note").trim();
   const old=editingMeal&&state.meals.find(m=>m.id===id);
   const portion={...old,...card,...intake,id,date};
   if(val("meal-group").trim())portion.mealGroup=val("meal-group").trim();else delete portion.mealGroup;
   if(card.fiber==null)delete portion.fiber;
   for(const key of ["sizes","basis","pieceName","productKind"])if(!(key in card))delete portion[key];
   if(!intake.proteinDetails)delete portion.proteinDetails;
   const linked=card.productKind?(val("protein-dose")===""?null:Number(val("protein-dose"))):old?.productKind?null:undefined;
   if(!intake.oil)delete portion.oil;
   if(estimateNote)portion.estimateNote=estimateNote;else delete portion.estimateNote;
   if($("one-off").checked)portion.oneOff=true;else delete portion.oneOff;
   await saveForm("meal",s=>{SportPortions.setDoseLink(s,portion,old,linked);SportPortions.saveMeal(s,portion,card,Boolean(editingMeal))});
   if(date.slice(0,10)!==selectedDay)selectDay(date.slice(0,10));
   editingMeal=null;editingMealBase=null;manualTime=date.slice(11,16);render();return;
 }
 render();
}
function showTaken(){
 if($("planPanel")){$("planPanel").innerHTML=planPanel(selectedDay);updateSupplementButton()}
}
document.addEventListener("change",async ev=>{
 if(ev.target.name==="supp"){
   const input=ev.target;
   if(input.checked&&!periods.includes(input.closest("[data-slot]").dataset.slot)){
     input.checked=false;openMove(input.value,null,true);
   }else if(input.checked)pendingDoses.add(input.value);else pendingDoses.delete(input.value);
   updateSupplementButton();
 }
 if(["mealdate","wdate","start"].includes(ev.target.id)&&ev.target.value.startsWith(selectedDay))manualTime=ev.target.value.slice(11);
 if(ev.target.id==="start"&&!draft&&$("workoutBudget")&&ev.target.value.startsWith(selectedDay))$("workoutBudget").outerHTML=planOverview(buildWorkoutPlan(state,ev.target.value));

 if(ev.target.id!=="daySlot"||busy)return;
 const date=selectedDay,slot=ev.target.value;
 busy=true;$("who").disabled=true;
 try{await commit(s=>{s.dayPlans={...s.dayPlans,[date]:slot}});if(date===selectedDay){const el=document.querySelector(".hero");if(el)el.outerHTML=hero()}showTaken()}catch(e){note(e.message);showTaken()}finally{busy=false;$("who").disabled=false}
});
document.addEventListener("input",ev=>{const x=ev.target;if(!draft||tab!==1)return;
 if(x.dataset.k){const row=x.closest(".set");draft.exercises[row.dataset.i].sets[row.dataset.j][x.dataset.k]=x.type==="checkbox"?x.checked:x.value===""?null:Number(x.value)}
 if(x.dataset.c!==undefined){
   const c=draft.cardio[x.dataset.c];
   if(x.dataset.f==="distance"){c.distanceKm=x.value;delete c.distance}
   else c[x.dataset.f]=x.value;
 }
 if(x.dataset.rest!==undefined&&x.value!==""&&x.validity.valid)draft.exercises[x.dataset.rest].restSeconds=Number(x.value);
 const changedBudget=x.dataset.rest!==undefined||["reps","warmup"].includes(x.dataset.k);
 if(draft.timing&&changedBudget&&$("workoutBudget"))$("workoutBudget").outerHTML=planOverview(draft);
 if((x.dataset.k==="done"||changedBudget)&&$("setMeter"))$("setMeter").outerHTML=progressMeter();
 if(x.id==="start"&&(x.value.startsWith(selectedDay)||canMoveDate("start")))draft.date=x.value;if(x.id==="end")draft.end=x.value;updateFinishButton();retain()});
document.addEventListener("click",async ev=>{const b=ev.target.closest("button");if(!b||(!b.dataset.action&&b.dataset.tab===undefined)||b.hidden||b.classList.contains("retryPhoto")||busy||!state||b.dataset.move||b.hasAttribute("data-reorder")||b.closest("dialog"))return;note("");
 if(b.dataset.tab!==undefined){
   if(!state)return;
   const next=Number(b.dataset.tab);
   if(tab!==next){
     sectionCalendarOpen=false;tab=next;render();
     const heading=document.querySelector("#content h1");
     if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true})}
   }
   window.scrollTo(0,0);
   return
 }
 busy=true;$("who").disabled=true;b.setAttribute("aria-busy","true");b.parentElement.querySelector(".saveError")?.remove();try{if(b.dataset.action==="finish"&&Array.from(document.querySelectorAll("#content input")).some(i=>!i.closest("[data-health-panels]")&&!i.reportValidity()))return;await action(b.dataset.action,b.closest("[data-history-index]")?.dataset.historyIndex)}catch(e){
   note(e.message);
   if(formBindings.some(f=>f.button===b)||["finish","save-food-card"].includes(b.dataset.action)){
     const message=document.createElement("p");message.className="saveError";message.textContent=e.message;b.after(message);
   }
 }finally{b.removeAttribute("aria-busy");busy=false;$("who").disabled=false}});
$("who").onchange=()=>{if(busy||!people.some(p=>p.id===$("who").value)){$("who").value=who;return}who=$("who").value;profileGeneration++;reportExercise="";reportPeriod="week";pendingDoses.clear();draftDoseAmounts.clear();manualTime="";scale=[];editingMeal=null;settingsOpen=false;state=null;draft=null;lastSummary=null;results=[];tab=0;$("content").innerHTML="";note("");load().catch(e=>note(e.message))};
function watchCalendarDay(){
 let shownDay=local().slice(0,10),timer;
 function refresh(){
   window.clearTimeout(timer);
   const now=new Date(),current=local(now).slice(0,10);
   if(current!==shownDay&&state){
     if(busy||document.querySelector("dialog[open]")){timer=window.setTimeout(refresh,1000);return}
     shownDay=current;
     renderDiaryUpdate();
   }
   const midnight=diaryInstant(shiftDay(current,1));
   timer=window.setTimeout(refresh,midnight.getTime()-now.getTime());
 }
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh()});
 window.addEventListener("pageshow",refresh);
 refresh();
}
function renderDiaryUpdate(){
 if(tab===2||tab===1&&draft){
   const panel=$("health-panels");
   if(panel){
     const expanded=new Set(Array.from(panel.querySelectorAll?.("details[open]")||[],d=>d.dataset.disclosure));
     panel.innerHTML=SportHealthView.panels(healthContext());
     panel.hidden=!panel.innerHTML;
     for(const el of panel.querySelectorAll?.("details[data-disclosure]")||[])el.open=expanded.has(el.dataset.disclosure);
   }
 }
 if(tab===2){
   // Leave the form, its caret and any in-flight catalogue search attached to the DOM.
   $("food-diary").innerHTML=foodDiary();
   refreshProposals();
   const recent=$("recent-portions"),open=recent.querySelector("details")?.open;
   recent.innerHTML=recentPortions();
   if(open&&recent.firstElementChild)recent.firstElementChild.open=true;
   const calendar=document.querySelector(".calendar");
   if(calendar)calendar.outerHTML=weekStrip();
   return;
 }
 if(tab===1&&draft){
   const calendar=document.querySelector(".calendar");
   if(calendar)calendar.outerHTML=weekStrip();
   return;
 }
 const active=document.activeElement;
 const binding=formBindings.find(b=>b.fields.some(f=>f.el===active));
 const field=binding?.fields.find(f=>f.el===active);
 const start=field&&active.selectionStart,end=field&&active.selectionEnd;
 render();
 if(field){
   const replacement=formBindings.find(b=>b.key===binding.key)?.fields.find(f=>f.id===field.id)?.el;
   replacement?.focus({preventScroll:true});
   if(typeof start==="number")replacement?.setSelectionRange(start,end);
 }
}
async function recoverDiary(){
 const user=who,generation=profileGeneration;
 const ready=()=>who===user&&profileGeneration===generation&&state&&!busy&&!document.hidden&&!document.querySelector("dialog[open]");
 if(!ready()||recoveringGeneration===generation)return;
 recoveringGeneration=generation;
 try{
   const before=rev;
   if(queued().length||hasPendingDraftMarkers()){
     busy=true;$("who").disabled=true;
     try{
       if(queued().length){await flushWorkouts();note("Тренировка сохранена в дневнике.")}
       if(hasPendingDraftMarkers())await syncDraftMarkers();
     }catch(e){note(e.message)}
     finally{busy=false;$("who").disabled=false}
   }
   const result=await request("profile/"+user).catch(()=>null);
   if(!ready())return;
   const changedSensors=result&&result.rev>=rev&&JSON.stringify(result.data?.healthImported)!==JSON.stringify(state.healthImported);
   if(result&&(result.rev>rev||changedSensors)){state=unpack(result);rev=result.rev}
   if(rev!==before||changedSensors)renderDiaryUpdate();
   const was=JSON.stringify(scale);
   await refreshScale(user).catch(()=>{});
   if(ready()&&was!==JSON.stringify(scale))renderDiaryUpdate();
 }finally{if(recoveringGeneration===generation)recoveringGeneration=null}
}
if(typeof window!=="undefined"&&window.addEventListener){
 for(const event of ["online","focus","pageshow"])window.addEventListener(event,recoverDiary);
 document.addEventListener("visibilitychange",recoverDiary);
 window.setInterval(recoverDiary,60000);
}
SportHealthView.bind(document,healthContext);
initialize().catch(e=>note(e.message));
function openMove(name,target,checkAfter=false,fromAction=false,historyIndex){
 if(busy&&!fromAction||document.querySelector("dialog[open]"))return;
 const source=document.querySelector('[data-move="'+CSS.escape(name)+'"]');
 if(!source)return;
 const index=Number(historyIndex??state.supps.findIndex(x=>x.date.startsWith(selectedDay)&&x.names.some(n=>canonicalSupp(n)===name)));
 const old=state.supps[index];
 const move=state.suppMoves?.[selectedDay]?.[name];
 const initial=target||old?.period||move?.period||source.closest("[data-slot]").dataset.slot;
 const slot=periods.includes(initial)?initial:period(local());
 const previousClock=old?old.date.slice(11,16):move?.clock;
 const clock=previousClock&&period(selectedDay+"T"+previousClock)===slot?previousClock:"";
 const dlg=document.createElement("dialog");
 dlg.setAttribute("aria-label",old?"Исправление приёма":"Перенос добавки");
 dlg.innerHTML='<form><h2>'+esc(name)+'</h2><p>'+dayLabel(selectedDay)+'</p><label>Время суток<select name="slot">'+options(periods,slot)+'</select></label><label>Точное время, если помнишь<input type="time" name="clock" value="'+esc(clock)+'"></label>'+(old?doseFields(name,old,selectedDay,true):"")+'<p class="moveError" role="status"></p><div class="actions"><button class="primary" type="submit">'+(old?"Исправить отметку":"Выбрать период")+'</button><button type="button" name="cancel">Отмена</button></div></form>';
 document.body.append(dlg);
 const form=dlg.querySelector("form"),fields=form.elements;
 if(old&&["Протеин","Креатин"].includes(name)){
   const label=document.createElement("label");
   label.textContent="Дата приёма"+(old.mealId?" и связанной порции":"");
   const input=document.createElement("input");
   input.type="date";input.name="intakeDay";input.required=true;input.max=local().slice(0,10);input.value=selectedDay;
   label.append(input);form.querySelector("h2").after(label);
 }
 if(old?.mealId&&name==="Протеин"&&fields.mealId){
   const meal=state.meals.find(m=>m.id===old.mealId&&m.date.startsWith(selectedDay));
   if(meal?.productKind){
     const edit=document.createElement("button");edit.type="button";edit.textContent="Исправить состав связанной порции · "+meal.name;
     const info=proteinIntake(meal,null);
     function sourceFields(){
       const linked=fields.mealId.value===meal.id;edit.hidden=!linked;
       for(const [input,value] of [[fields.servings,info.servings],[fields.powderPerServing,info.servings>0&&info.powderGrams!=null?info.powderGrams/info.servings:null]]){
         if(value==null)continue;
         input.readOnly=linked;
         if(linked)input.value=value;
       }
     }
     fields.mealId.after(edit);fields.mealId.addEventListener("change",sourceFields);sourceFields();
     edit.onclick=()=>{dlg.close();tab=2;editingMeal=meal.id;render();$("food-label").open=true;$("product").focus()};
   }
 }
 fields.slot.onchange=()=>{if(fields.clock.value&&period(selectedDay+"T"+fields.clock.value)!==fields.slot.value)fields.clock.value=""};
 fields.cancel.onclick=()=>dlg.close();
 dlg.onclose=()=>{dlg.remove();document.querySelector('[data-move="'+CSS.escape(name)+'"]')?.focus({preventScroll:true})};
 form.onsubmit=async event=>{
 event.preventDefault();if(busy)return;
 const clock=fields.clock.value,destination=fields.slot.value;
 busy=true;
 try{
 const intakeDay=fields.intakeDay?.value||selectedDay;
 const entry=doseEntry(name,intakeDay,destination,clock,old?local():null);
 const controls=form.querySelector("[data-dose-controls]");
 if(controls){
   const values=doseAmounts(controls);
   if(values.servings||old.servings!=null)Object.assign(entry,doseSnapshot(name,values,old));
   else if(name==="Протеин"){
     if(values.mealId)entry.mealId=values.mealId;
     if(values.powderPerServing!=="")entry.powderPerServing=SportPortions.number(values.powderPerServing,"Масса порошка в саше");
     if(values.perServing)entry.perServing=SportPortions.nutrients(values.perServing);
     if(old.intakeSnapshot)entry.intakeSnapshot=old.intakeSnapshot;
     if(old.powderTotal!=null)entry.powderTotal=old.powderTotal;
   }
 }
 await commit(s=>{
 s.suppMoves||={};s.suppMoves[intakeDay]={...s.suppMoves[intakeDay],[name]:{period:destination,clock}};
 if(intakeDay!==selectedDay&&entry.mealId){
   const linked=s.meals.find(m=>m.id===entry.mealId);
   if(linked){
     const moved=intakeDay+linked.date.slice(10);
     if(diaryInstant(moved).getTime()>Date.now()+60000)throw Error("Время связанной порции ещё не наступило.");
     SportPortions.setMealTime(linked,moved);
   }
 }
 if(old)s.supps=replaceRecordedDose(s.supps,index,name,entry);
 });
 if(checkAfter)pendingDoses.add(name);
 if(intakeDay!==selectedDay)selectDay(intakeDay);
 render();dlg.close();note(old?"Отметка исправлена.":"Период выбран. Подтверди приём, когда будешь готов.");
 }catch(e){dlg.querySelector(".moveError").textContent=e.message}finally{busy=false}
 };
 dlg.showModal();
}
let drag=null, suppressMoveClick=false;
function clearDrag(){
 document.querySelectorAll(".dropTarget").forEach(el=>el.classList.remove("dropTarget"));
 if(drag){drag.handle.classList.remove("dragging");cancelAnimationFrame(drag.frame)}
 drag=null;
}
function moveExercise(from,to){
 if(!draft||from===to||from<0||to<0||from>=draft.exercises.length||to>=draft.exercises.length)return;
 const [exercise]=draft.exercises.splice(from,1);draft.exercises.splice(to,0,exercise);
 retain();render();document.querySelector('[data-reorder="'+to+'"]')?.focus({preventScroll:true});
 note(exercise.name+" · позиция "+(to+1));
}
document.addEventListener("keydown",e=>{
 const h=e.target.closest("[data-reorder]");
 if(!h||busy||!["ArrowUp","ArrowDown","Home","End"].includes(e.key))return;
 e.preventDefault();const i=Number(h.dataset.reorder);
 moveExercise(i,e.key==="Home"?0:e.key==="End"?draft.exercises.length-1:i+(e.key==="ArrowUp"?-1:1));
});
function dropAt(x,y){
 const el=document.elementFromPoint(x,y);
 if(drag.exercise)return el?.closest("[data-ex-index]")||null;
 const target=el?.closest("[data-slot]");return target&&periods.includes(target.dataset.slot)?target:null;
}
function updateDrop(){
 if(!drag?.moving)return;
 const target=dropAt(drag.x,drag.y);
 if(drag.target!==target){drag.target?.classList.remove("dropTarget");target?.classList.add("dropTarget");drag.target=target}
 const edge=100, bottom=innerHeight-75;
 if(drag.y<edge)window.scrollBy(0,-8);else if(drag.y>bottom-edge)window.scrollBy(0,8);
 drag.frame=requestAnimationFrame(updateDrop);
}
document.addEventListener("pointerdown",e=>{
 const handle=e.target.closest("[data-move],[data-reorder]");
 if(busy||!handle||e.button!==0||!e.isPrimary)return;
 suppressMoveClick=false;drag={handle,exercise:handle.hasAttribute("data-reorder"),id:e.pointerId,x:e.clientX,y:e.clientY,startY:e.clientY,startX:e.clientX};
 handle.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove",e=>{
 if(!drag||e.pointerId!==drag.id)return;drag.x=e.clientX;drag.y=e.clientY;
 if(!drag.moving&&Math.hypot(drag.x-drag.startX,drag.y-drag.startY)>6){
 drag.moving=true;drag.handle.classList.add("dragging");updateDrop()}
});
document.addEventListener("pointerup",e=>{
 if(!drag||e.pointerId!==drag.id)return;
 const name=drag.handle.dataset.move,moving=drag.moving;
 const target=dropAt(e.clientX,e.clientY),exercise=drag.exercise,from=Number(drag.handle.dataset.reorder);
 clearDrag();if(moving)suppressMoveClick=true;if(moving&&target){if(exercise)moveExercise(from,Number(target.dataset.exIndex));else{openMove(name,target.dataset.slot)}}
});
document.addEventListener("pointercancel",clearDrag);
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&drag)clearDrag()});
function openPosition(i){
 const dlg=document.createElement("dialog"),name=draft.exercises[i].name;
 dlg.setAttribute("aria-label","Позиция упражнения");
 dlg.innerHTML='<form><h2>'+esc(name)+'</h2><label>Позиция в тренировке<select>'+draft.exercises.map((e,j)=>'<option value="'+j+'" '+(j===i?'selected':'')+'>'+(j+1)+' · '+esc(exerciseLabel(e.name))+'</option>').join("")+'</select></label><div class="actions"><button class="primary">Переместить</button><button type="button">Отмена</button></div></form>';
 document.body.append(dlg);let focus=i;
 dlg.querySelector("form").onsubmit=e=>{e.preventDefault();focus=Number(dlg.querySelector("select").value);moveExercise(i,focus);dlg.close()};
 dlg.querySelector('[type=button]').onclick=()=>dlg.close();dlg.onclose=()=>{dlg.remove();document.querySelector('[data-reorder="'+focus+'"]')?.focus({preventScroll:true})};dlg.showModal();
}
document.addEventListener("click",e=>{const h=e.target.closest("[data-move],[data-reorder]");if(!h||busy)return;
 if(suppressMoveClick&&e.detail){suppressMoveClick=false;return}if(h.hasAttribute("data-reorder"))openPosition(Number(h.dataset.reorder));else openMove(h.dataset.move)});
