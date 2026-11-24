"use strict";
const $=id=>document.getElementById(id);
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const local=(d=new Date())=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
let selectedDay=local().slice(0,10), viewedMonth=selectedDay.slice(0,7), expanded=false;
let manualTime="",manualPeriod="",settingsOpen=false;
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
 editingMeal=null;selectedDay=day;viewedMonth=day.slice(0,7);manualTime="";manualPeriod="";lastSummary=null;results=[];restoreDraft();
}
function dayLabel(day){return new Date(day+"T12:00").toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"})}

let who="person1", tab=0, state,rev,draft,results=[], lastSummary=null, busy=false;
let people=[],scale=[],editingMeal=null;
const tabs=["Сегодня","Тренировка","Питание","Профиль"];
const goals=["Общая форма","Сила","Набор мышц","Снижение веса","Выносливость"];
const options=(items,sel)=>items.map(x=>'<option '+(x===sel?'selected':'')+'>'+esc(x)+'</option>').join('');
const field=(id,label,type,value,attrs="")=>'<label>'+label+'<input id="'+id+'" type="'+type+'" value="'+esc(value)+'" '+attrs+'></label>';
const dt=(id,label,value=stamp())=>field(id,label,"datetime-local",value,'required min="'+selectedDay+'T00:00" max="'+selectedDay+'T23:59"');
const check=(label,attrs,on=false)=>'<label class="check"><input type="checkbox" '+attrs+' '+(on?'checked':'')+'>'+esc(label)+'</label>';
const btn=(id,label,primary=false)=>'<button type="button" data-action="'+id+'" class="'+(primary?'primary':'')+'">'+label+'</button>';
const card=(title,body)=>'<article><h2>'+esc(title)+'</h2>'+body+'</article>';
const note=t=>$("message").textContent=t;
function initial(){
 return {profile:{height:"",age:"",sex:"",goal:goals[0],extra:[],week:Array(7).fill("Отдых"),minutes:45,step:2.5,equipment:[...starterEquipment],focus:"",fixed:false,supps:[]},weights:[],workouts:[],meals:[],supps:[]};
}
async function request(path,body){
 const signal=typeof AbortSignal!=="undefined"&&AbortSignal.timeout?AbortSignal.timeout(path.startsWith("weights/")?2500:12000):undefined;
 const r=await fetch(path,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal}:{signal});
 if(!r.ok) throw Object.assign(Error(r.status===409?"Профиль изменён на другом устройстве. Обнови страницу и повтори сохранение.":r.status===403?"Нет доступа к этому профилю HA.":"Сервер недоступен. Повтори сохранение после восстановления связи."),{status:r.status});
 return r.json();
}
async function commit(change){
 const next=structuredClone(state);change(next);
 const reply=await request("profile/"+who,{rev,data:next}); rev=reply.rev; state=next;
}
function retain(){localStorage.setItem(key(),JSON.stringify(draft))}
function unpack(result){
 const defaults=initial(),data=result.data;
 const loaded={...defaults,...data,profile:{...defaults.profile,...data.profile}};
 loaded.meals=loaded.meals.map((m,i)=>m.id?m:{...m,id:"legacy-"+i+"-"+m.date});
 return loaded;
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
     if(JSON.stringify(existing)!==JSON.stringify(item.workout)){
       if(JSON.stringify(existing)!==JSON.stringify(item.before)){
         conflict=true;break;
       }
       if(index<0)latest.workouts.push(item.workout);else latest.workouts[index]=item.workout;
       try{const write=await request("profile/"+who,{rev:result.rev,data:latest});rev=write.rev}
       catch(e){if(e.status===409&&attempt<2)continue;throw e}
     }else rev=result.rev;
     state=latest;if(localStorage.getItem(item.key)===item.raw)localStorage.removeItem(item.key);break;
   }
 }
 if(conflict)throw Error("На другом устройстве изменили тренировку. Локальная копия доступна во вкладке «Тренировка».");
}
function pendingPanel(){
 return queued().map(({workout,before})=>card("Сохранено на этом устройстве",'<p>'+esc(workout.date.replace("T"," "))+' · '+total(workout).sets+' подходов. Ожидает подтверждения сервера.</p>'+btn("sync-workouts","Отправить в HA")+btn("review-"+workout.id,"Проверить локальную копию"))).join("");
}
async function refreshScale(user){
 const incoming=await request("weights/"+user);
 if(user===who&&Array.isArray(incoming))scale=incoming;
}
async function load(){
 const user=who;
 const result=await request("profile/"+user);
 if(user!==who)return;
 state=unpack(result);rev=result.rev;
 if(queued().length){
   busy=true;$("who").disabled=true;
   try{await flushWorkouts()}catch(e){note(e.message)}finally{busy=false;$("who").disabled=false}
 }
 restoreDraft();
 render();
 await refreshScale(user).catch(()=>{});
 if(who===user&&tab===3&&!busy)render();
}
async function initialize(){
 people=await request("profiles");
 $("who").hidden=people.length<2;
 $("single-profile").hidden=people.length!==1;
 $("single-profile").textContent=people.length===1?people[0].name:"";
 if(!people.length){$("content").textContent="Укажи ID своей учётной записи HA в настройках приложения и открой панель снова.";$("who").disabled=true;return}
 if(!people.some(p=>p.id===who))who=people[0].id;
 $("who").innerHTML=people.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("");
 $("who").value=who;await load();
}
const pendingForms=new Map();
let formBindings=[], renderedScope="";
function render(){
 const scope=JSON.stringify([who,tab,selectedDay]);
 const open=scope===renderedScope?Array.from(document.querySelectorAll("details[data-disclosure][open]"),d=>d.dataset.disclosure):[];
 renderedScope=scope;
 document.querySelector("nav").innerHTML=tabs.map((t,i)=>'<button class="'+(i===tab?'active':'')+'" data-tab="'+i+'">'+t+'</button>').join('');
 $("content").innerHTML=(tab?'<h1 class="page-title">'+esc(tabs[tab])+'</h1>'+btn("show-calendar",dayLabel(selectedDay)+" ▾"):"")+[today,workout,food,profile][tab]();if(tab===0)showTaken();
 for(const d of document.querySelectorAll("details[data-disclosure]"))if(open.includes(d.dataset.disclosure))d.open=true;
 bindSaveButtons();
 for(const group of document.querySelectorAll(".equipmentGroup:has(.eqCount)"))updateEquipmentCount(group);
 updateFinishButton();
}
const formSelectors={
 profile:"#height,#birth,#sex,#goal,#focus,#minutes,#step,#fixed,[name=extra],[name=legday],[name=eq],[data-week],[data-step-name]",
 "save-supps":"[name=uses]",meal:"#product,#barcode,#amount,#mealdate,#unit,#nut0,#nut1,#nut2,#nut3",weight:"#kg,#wdate"
};
function formKey(action,name=""){
 const day=["meal","weight"].includes(action)?selectedDay+(action==="meal"&&editingMeal?"|"+editingMeal:""):"";
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
 binding.button.hidden=!Object.keys(patch).length;
 rememberForm(binding.key,binding.button.hidden?null:patch);
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
   const fields=Array.from(controls,el=>({el,id:isNote?"text":(el.id||el.dataset.stepName||el.name+":"+el.value),base:fieldValue(el)}));
   const binding={key,button,fields};formBindings.push(binding);trackForm(binding,true);
 }
}
function updateEquipmentCount(group){
 group.querySelector(".eqCount").textContent=group.querySelectorAll("input[name=eq]:checked").length+" из "+group.querySelectorAll("input[name=eq]").length;
}
function updateFormEdits(ev){
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
function updateFinishButton(){
 const finish=document.querySelector('[data-action="finish"]');
 if(finish&&draft){
   finish.hidden=!draft.exercises.some(e=>e.sets.some(s=>s.done))&&!draft.cardio.some(c=>Object.values(c).some(v=>v!==""&&v!=null));
   if($("finishHint"))$("finishHint").hidden=!finish.hidden;
 }
}
function updateSupplementButton(){
 const submit=document.querySelector('[data-action="supp"]');
 if(submit)submit.hidden=!selected("supp").length;
}
function guideFor(name){
 return Object.hasOwn(guides,name)?guides[name]:null;
}
function guidePanel(name){
 const g=guideFor(name);
 if(!g)return '<p class="muted">Своё упражнение · можно сохранить личную настройку.</p>';
 if(g.legacy)return '<p class="muted">В этой записи не указан тренажёр. В новой тренировке можно выбрать его точный вариант.</p>';
 const photos=g.photo?'<div class="guidePhotos">'+[0,1].map(i=>'<figure><img data-photo="'+esc(exercisePhotoBase+g.photo+'/'+i+'.jpg')+'" alt="'+esc(name+(i?' — второе положение':' — первое положение'))+'" decoding="async"><figcaption>'+(i?'Положение 2':'Положение 1')+'</figcaption><button type="button" class="retryPhoto" hidden>Загрузить фото ещё раз</button></figure>').join("")+'</div><small>Пример оборудования · Free Exercise DB</small>':
   '<p><a href="'+esc(g.reference)+'" target="_blank" rel="noopener noreferrer">Посмотреть тренажёр на сайте производителя ↗</a></p>';
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
 return '<h3>Доступные упражнения</h3><p class="muted">Отметь упражнения, которые можно выполнять в твоём зале. Из них составляется план.</p>'+Array.from(groups,([group,names])=>'<details class="equipmentGroup" data-disclosure="'+esc("equipment:"+group)+'"><summary>'+esc(group)+' <span class="eqCount"></span></summary><div>'+names.map(n=>'<div>'+check(exerciseLabel(n),'name="eq" value="'+esc(n)+'"',profile.equipment.includes(n))+'<label>Шаг, кг<input type="number" min="0" max="100" step="any" data-step-name="'+esc(noteKey(n))+'" value="'+esc(profile.exerciseSteps?.[noteKey(n)]??"")+'" placeholder="По профилю"></label></div>').join("")+'</div></details>').join("");
}
function period(d){const h=new Date(d).getHours();return h<6?"Ночь":h<12?"Утро":h<18?"День":"Вечер"}
const periods=["Утро","День","Вечер","Ночь"];
const bars='<i class="gripBars" aria-hidden="true"></i>';
function planPanel(day){
 const slot=trainingSlot(state,draft,day);
 const logged=state.workouts.some(w=>w.date.startsWith(day))||draft?.date.startsWith(day);
 const loggedByName=new Map(state.supps.filter(x=>x.date.slice(0,10)===day).flatMap(x=>x.names.map(n=>[canonicalSupp(n),x])));
 const moves=state.suppMoves?.[day]||{};
 const names=[...new Set([...state.profile.supps.map(canonicalSupp),...loggedByName.keys()])];
 const rows=names.map(name=>{
 const [planned,hint]=schedule(name,slot),entry=loggedByName.get(name),move=moves[name];
 return {name,section:entry?.period||move?.period||planned,hint:entry?"Принято · "+entry.date.slice(11,16):move?"Перенесено · "+move.clock:hint,taken:!!entry};
 });
 return '<div class="day-plan"><div><small>План на день</small><h3>'+ (slot==="Отдых"?"День отдыха":"Тренировка · "+slot.toLowerCase())+'</h3></div><label>Планы на зал<select id="daySlot" '+(logged?'disabled title="Время взято из занятия"':"")+'>'+options(["Отдых","Утром","Днём","Вечером"],slot)+'</select></label></div>'+
 ["Утро","День","Вечер","Ночь","По назначению","По своей схеме"].map(time=>{
 const items=rows.filter(x=>x.section===time);
 if(!items.length&&(!names.length||!periods.includes(time)))return "";
 return '<div class="timegroup" data-slot="'+time+'"><strong>'+time+'</strong><div>'+items.map(x=>'<div class="dose"><button class="handle grip" type="button" data-move="'+esc(x.name)+'" aria-label="Перенести '+esc(x.name)+'" title="Перенести">'+bars+'</button>'+check(x.name,'name="supp" value="'+esc(x.name)+'" '+(x.taken?'disabled':''),x.taken)+'<small>'+esc(x.hint)+'</small></div>').join("")+(items.length?"":'<small>Нет приёмов</small>')+'</div></div>';
 }).join('')+(names.length?'':btn("configure","Выбрать мои добавки"));
}
function weekStrip(){
 const first=new Date((expanded?viewedMonth+"-01":selectedDay)+"T12:00");
 const last=new Date(first.getFullYear(),first.getMonth()+1,0,12);
 const offset=(first.getDay()+6)%7, count=expanded?7*Math.ceil((offset+last.getDate())/7):7;
 const label=first.toLocaleDateString("ru-RU",{month:"long",year:"numeric"});
 first.setDate(first.getDate()-offset);
 const workouts=new Set(state.workouts.map(w=>w.date.slice(0,10)));
 const food=new Set(state.meals.map(m=>m.date.slice(0,10)));
 const days=Array.from({length:count},(_,i)=>{
 const d=new Date(first);d.setDate(first.getDate()+i);const day=local(d).slice(0,10);
 const hasGym=workouts.has(day),complete=!!state.foodComplete?.[day],hasMeal=food.has(day)||complete;
 return '<button data-action="date-'+day+'" class="calDay '+(day===selectedDay?'chosen ':'')+(expanded&&!day.startsWith(viewedMonth)?'outside':'')+'" aria-pressed="'+(day===selectedDay)+'" aria-label="'+dayLabel(day)+(hasGym?', тренировка':'')+(complete?', питание заполнено':hasMeal?', есть запись еды':'')+'">'+d.getDate()+'<span class="dots">'+(hasGym?'<i class="gym"></i>':'')+(hasMeal?'<i class="meal '+(complete?'complete':'partial')+'"></i>':'')+'</span></button>';
 }).join('');
 return '<section class="calendar" aria-label="Календарь"><div class="calTop">'+btn("cal-toggle",label+(expanded?" ▴":" ▾"))+(expanded?'<button data-action="cal-prev" aria-label="Предыдущий месяц">←</button><button data-action="cal-next" aria-label="Следующий месяц">→</button>':'')+btn("cal-today","Сегодня")+'</div><div class="calGrid">'+["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(x=>'<small>'+x+'</small>').join('')+days+'</div><small class="legend"><i class="gym"></i>Тренировка <i class="meal partial"></i>Есть еда <i class="meal complete"></i>День заполнен</small></section>';
}
function hero(){
 const day=selectedDay,slot=trainingSlot(state,draft,day);
 const name=people.find(p=>p.id===who)?.name||"Профиль";
 const date=new Date(day+"T12:00").toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long"});
 const from=new Date(day+"T12:00");from.setDate(from.getDate()-6);from.setHours(0,0,0,0);const count=state.workouts.filter(x=>Date.parse(x.date)>=from.getTime()&&x.date.slice(0,10)<=day).length;
 return '<section class="hero"><div class="orbit" aria-hidden="true"></div><div class="heroMain"><small>'+esc(date)+'</small><h1>'+esc(name)+', твой день</h1><p>'+(draft?"Есть начатая тренировка":slot==="Отдых"?"По плану отдых":"В плане зал · "+slot.toLowerCase())+'</p>'+btn("open",draft?"Продолжить занятие →":"Открыть тренировку →",true)+'</div><div class="heroFoot"><b>'+count+'</b> занятий за 7 дней <span>·</span> <b>'+state.profile.minutes+'</b> мин в плане</div>'+weekStrip()+'</section>';
}
function today(){
 const date=stamp();return hero()+card("Мои добавки",'<div id="planPanel">'+planPanel(date.slice(0,10))+'</div>'+(state.profile.supps.length?dt("sdate","Когда принял",date)+'<label>Период отметки<select id="period">'+options(["Утро","День","Вечер","Ночь"],manualPeriod||period(date))+'</select></label>'+btn("supp","Подтвердить приём",true):'<input type="hidden" id="sdate" value="'+date+'">'))+
 card("Приём за выбранный день",state.supps.filter(x=>x.date.startsWith(selectedDay)).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).map(x=>'<p>'+esc(x.date.replace('T',' '))+' · '+esc(x.period)+' · '+esc(x.names.join(', '))+'</p>'+x.names.map(n=>btn("undo-supp-"+esc(encodeURIComponent(n)),"Снять отметку · "+esc(n))).join("")).join('')||'Пока пусто');
}
function progressMeter(){
 const sets=draft.exercises.flatMap(e=>e.sets),done=sets.filter(s=>s.done).length;
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
 return '<details class="edit"><summary>Изменить упражнение и порядок</summary><div class="actions">'+(i>0?btn("up-"+i,"↑ Выше"):"")+(i+1<draft.exercises.length?btn("down-"+i,"↓ Ниже"):"")+btn("remove-"+i,"Убрать")+'</div>'+exercisePicker(i)+'</details>';
}
function workout(){
 if(!draft)return pendingPanel()+state.workouts.filter(w=>w.date.startsWith(selectedDay)).map(summary).join("")+card("Новая тренировка",dt("start","Дата и время начала")+btn("start","Начать тренировку",true));
 return card("Тренировка",dt("start","Начало",draft.date)+'<small> Черновик на этом устройстве</small>')+
 card("Состав тренировки",progressMeter()+(draft.exercises.length?"":'<p class="muted">Добавь упражнение вручную или заполни дорожку. Для автоплана отметь доступные упражнения в настройках профиля.</p>')+'<div class="sequence">'+draft.exercises.map((e,i)=>'<div class="exerciseRow" data-ex-index="'+i+'"><button type="button" class="reorderGrip grip" data-reorder="'+i+'" aria-label="Порядок: '+esc(exerciseLabel(e.name))+'. Стрелки вверх и вниз меняют позицию" title="Изменить позицию">'+bars+'</button><b>'+String(i+1).padStart(2,"0")+'</b><span>'+esc(exerciseLabel(e.name))+'</span><button type="button" data-action="remove-'+i+'" aria-label="Удалить '+esc(exerciseLabel(e.name))+'">Удалить</button></div>').join("")+'</div>'+exercisePicker(null))+
 draft.exercises.map((e,i)=>card(exerciseLabel(e.name),guidePanel(e.name)+notePanel(e.name,i)+editExercise(i)+'<p>Прошлый раз · '+esc(e.previous||"первое занятие")+'</p>'+e.sets.map((t,j)=>'<div class="set" data-i="'+i+'" data-j="'+j+'">'+field("k"+i+"_"+j,"кг","number",t.kg,'data-k="kg" min="0" step="0.1"')+field("r"+i+"_"+j,"Повторы","number",t.reps,'data-k="reps" min="1" step="1"')+check("Готово",'data-k="done"',t.done)+check("Запас",'data-k="easy"',t.easy)+'</div>').join('')+btn("add-"+i,"+ Подход")+btn("sub-"+i,"− Подход"))).join('')+
 ["Разминка","Заминка"].map((name,i)=>{const c=draft.cardio[i];return card(name+" · дорожка",field("sec"+i,"Время, мин:сек","text",c.time,'data-c="'+i+'" data-f="time" placeholder="7:04"')+
 [["hr","Средний пульс"],["speed","Скорость, км/ч"],["incline","Уклон, %"],["distance","Дистанция, м"],["power","Мощность, Вт"],["kcal","Энергия, ккал"]].map(([k,n])=>field(k+i,n,"number",c[k],'min="0" step="any" data-c="'+i+'" data-f="'+k+'"')).join(''))}).join('')+
 card("Завершение",dt("end","Окончание (по умолчанию — момент сохранения)",draft.end||(selectedDay===local().slice(0,10)?stamp():""))+'<div class="actions">'+'<small id="finishHint">Отметь подход или заполни дорожку, чтобы завершить занятие.</small>'+btn("finish","Закончить и сохранить",true)+btn("cancel","Отменить тренировку")+'</div>');
}
function summary(w){
 const t=total(w);const gains=[];
 const cardio=w.cardio.map(c=>'<p><b>'+esc(c.role)+'</b> · '+Math.floor(c.seconds/60)+':'+String(c.seconds%60).padStart(2,"0")+[["hr","уд/мин"],["speed","км/ч"],["incline","% уклон"],["distance","м"],["power","Вт"],["kcal","ккал"]].filter(([k])=>c[k]!=null&&c[k]!=="").map(([k,u])=>" · "+esc(c[k])+" "+u).join("")+"</p>").join("");
 for(const [i,e] of w.exercises.entries()){const before=e.previous;const actual=e.sets.filter(t=>t.done).map(t=>t.kg+" × "+t.reps).join(", ");if(actual)gains.push('<p>'+esc(exerciseLabel(e.name))+' · '+esc(actual)+(before?'<br><small>Раньше · '+esc(before)+'</small>':'')+'</p>'+guidePanel(e.name)+notePanel(e.name,"history-"+w.id+"-"+i))}
 const ready=w.exercises.filter(e=>e.sets.length&&e.sets.every(t=>t.done&&t.easy)).map(e=>exerciseLabel(e.name));
 const feedback=ready.length?"С запасом выполнены все подходы: "+ready.join(", ")+".":"";
 const missed=w.exercises.some(e=>e.sets.some(t=>!t.done));
 return card("Итог тренировки",'<p>'+t.minutes+' мин · '+t.sets+' подходов · '+t.volume+' кг суммарно</p><p>'+ (t.estimated===null?(t.consoleCount?t.consoleKcal+' ккал по консоли · общий расход неизвестен':'Для оценки калорий нужен вес на дату занятия'):(w.kg?'≈ ':'')+t.estimated+' ккал за занятие')+' · '+t.points+' баллов · вес '+(w.kg??'—')+' кг</p>'+cardio+btn('edit-workout-'+esc(w.id),'Исправить тренировку')+esc(feedback)+gains.join('')+'<p>'+ (missed?'Занятие записано. В следующий раз повтори незавершённые рабочие подходы в комфортном объёме.':'План выполнен. При следующем старте будут учтены повторы и отмеченный запас.')+'</p>');
}
function food(){
 const meal=state.meals.find(x=>x.id===editingMeal);
 const recent=state.meals.filter(m=>m.date.slice(0,10)<=selectedDay).sort((a,b)=>b.date.localeCompare(a.date));
 const repeat=recent.filter((m,i)=>recent.findIndex(x=>x.name===m.name)===i).slice(0,5);
 return card("Поиск продуктов",field("query","Название или штрихкод","search","")+btn("search","Найти")+(repeat.length?'<details><summary>Повторить недавнюю порцию</summary>'+repeat.map(m=>btn("repeat-meal-"+esc(m.id),esc(m.name)+" · "+esc(m.amount)+" "+esc(m.unit))).join("")+"</details>":"")+(window.BarcodeDetector?'<label>Фото штрихкода<input type="file" id="scan" accept="image/*" capture="environment"></label>':'')+'<small> Open Food Facts · ODbL</small><div id="matches"></div>')+
 card("Порция",dt("mealdate","Когда",meal?.date||stamp())+field("product","Продукт","text",meal?.name||"")+field("barcode","Штрихкод, если есть","text",meal?.code||"",'inputmode="numeric" maxlength="14"')+field("amount","Масса или объём","number",meal?.amount??100,'min="0.1" step="any"')+'<label>Единица<select id="unit">'+options(["г","мл"],meal?.unit||"г")+'</select></label><p>На 100 г или 100 мл по этикетке</p>'+["Ккал","Белки","Жиры","Углеводы"].map((n,i)=>field("nut"+i,n,"number",meal?.nut[i]??"","step=any min=0")).join('')+btn("meal",meal?"Сохранить исправление":"Сохранить порцию",true)+(meal?btn("cancel-meal","Отмена"):""))+
 card("Дневник питания",field("foodday","За день","date",selectedDay)+'<div id="entries">'+mealList(selectedDay)+'</div>'+btn("food-complete",state.foodComplete?.[selectedDay]?"Снять отметку заполнения":"День питания заполнен"));
}
function mealList(day){
 const m=state.meals.filter(x=>x.date.startsWith(day));
 return m.map(x=>'<p>'+esc(x.date.slice(11))+' · '+esc(x.name)+' · '+x.amount+' '+esc(x.unit)+' · '+esc(x.nut[0]==null?"ккал неизвестны":Math.round(x.nut[0]*x.amount/100)+" ккал")+'</p>'+btn("edit-meal-"+esc(x.id),"Исправить") + btn("remove-meal-"+esc(x.id),"Удалить")).join('')+'<p>'+["ккал","г белка","г жиров","г углеводов"].map((u,i)=>m.some(x=>x.nut[i]===null)?'нет данных ('+u+')':Math.round(m.reduce((a,x)=>a+x.nut[i]*x.amount/100,0))+' '+u).join(' · ')+'</p>';
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
 const measurement=measurementAt(state,until,scale),kg=measurement?.kg;
 const source=measurement?new Date(measurement.date).toLocaleString("ru-RU")+" · "+(measurement.source==="ha"?"Весы HA":measurement.source==="manual"?"Вручную":"Ранее сохранено"):"";
 if(!settingsOpen){
 const history=state.workouts.filter(w=>w.date.slice(0,10)<=selectedDay).sort((a,b)=>b.date.localeCompare(a.date));
 const day=history.filter(w=>w.date.startsWith(selectedDay));
 return card("Результаты",'<p>Вес на дату · <b>'+esc(kg??"—")+' кг</b><br><small>'+esc(source)+'</small></p><p>Занятий к этой дате · <b>'+history.length+'</b></p><p>Рабочих подходов за день · <b>'+day.reduce((n,w)=>n+total(w).sets,0)+'</b></p>'+btn("settings","Настройки профиля"))+
 card("История тренировок",history.map(w=>btn("history-"+w.id,esc(w.date.replace("T"," ")))).join("")||"Пока пусто");
 }
 const age=p.birth?Math.floor((Date.now()-Date.parse(p.birth))/(365.2425*86400000)):null;
 const metrics=[age!==null?"Возраст · "+age:null,kg&&Number(p.height)>0?"ИМТ · "+(kg/(Number(p.height)/100)**2).toFixed(1):null].filter(Boolean).join(" · ");
 return btn("results","← К результатам")+'<section class="profileEditor">'+card("Данные профиля",field("height","Рост, см","number",p.height)+field("birth","Дата рождения","date",p.birth||"")+'<label>Пол<select id="sex">'+options(["","Мужской","Женский"],p.sex)+'</select></label><p>'+metrics+'</p><p>Вес · '+(kg||"—")+' кг · '+esc(source)+'</p>'+field("kg","Внести вес, кг","number","","step=any")+dt("wdate","Дата взвешивания")+btn("weight","Записать вес"))+
 card("Настройки плана",'<label>Основная цель<select id="goal">'+options(goals,p.goal)+'</select></label><div>Дополнительные цели</div>'+goals.map(n=>check(n,'name="extra" value="'+esc(n)+'"',p.extra.includes(n))).join('')+'<div><label>Приоритет<select id="focus">'+options(["","ног","тяга","Жим"],p.focus)+'</select></label></div>'+field("minutes","Длительность, мин","number",p.minutes)+field("step","Шаг прибавки, кг","number",p.step,"step=any")+check("Оставлять пропущенный день ног на том же дне недели (иначе — продолжить очередь в ближайшую тренировку)",'id="fixed"',p.fixed)+'<details class="equipmentGroup weekPlan"><summary>Недельное расписание</summary><div>'+[1,2,3,4,5,6,0].map(i=>'<label>'+['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][i]+'<select data-week="'+i+'" id="week'+i+'">'+options(['Отдых','Утром','Днём','Вечером'],p.week?.[i]||'Отдых')+'</select></label>').join('')+'</div></details><div>Дни с акцентом на ноги</div>'+["Вс","Пн","Вт","Ср","Чт","Пт","Сб"].map((n,i)=>check(n,'name="legday" value="'+i+'"',(p.legDays||[2]).includes(i))).join("")+exercisePreferences(p))+'<div class="profileSaveBar">'+btn("profile","Сохранить профиль",true)+'</div></section>'+
 supplementPreferences(p);
}
const val=id=>$(id).value;
const selected=n=>Array.from(document.querySelectorAll('input[name="'+n+'"]:checked:not(:disabled)'),x=>x.value);
function when(id){const d=val(id);if(d.slice(0,10)!==selectedDay)throw Error("Выбери день события в календаре.");if(!d||Date.parse(d)>Date.now()+60000)throw Error("Укажи дату и время события в прошлом или сейчас.");return d}
async function action(a){
 if(a==="food-complete"){if(selectedDay>local().slice(0,10))throw Error("Этот день ещё не наступил.");await commit(s=>{s.foodComplete={...s.foodComplete,[selectedDay]:!s.foodComplete?.[selectedDay]}});render();return}
 if(a==="settings"||a==="results"){settingsOpen=a==="settings";render();return}
 if(a.startsWith("date-")||a==="cal-today"){selectDay(a==="cal-today"?local().slice(0,10):a.slice(5));expanded=false;render();return}
 if(a==="show-calendar"){tab=0;expanded=true;render();return}
 if(a==="cal-toggle"){expanded=!expanded;viewedMonth=selectedDay.slice(0,7);render();return}
 if(a==="cal-prev"||a==="cal-next"){const d=new Date(viewedMonth+"-01T12:00");d.setMonth(d.getMonth()+(a==="cal-prev"?-1:1));viewedMonth=local(d).slice(0,7);render();return}
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
 if(a==="save-supps"){const uses=selected("uses");await saveForm("save-supps",s=>s.profile.supps=uses);render();note("Выбор добавок сохранён.");return}
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
       const past=state.workouts.filter(w=>w.date<draft.date).sort((a,b)=>b.date.localeCompare(a.date));
       const exercise=exerciseFor(name,state.profile,past,draft.date);
       if(pos==="new")items.push(exercise);else items[i]=exercise;
     }
   }
   retain();render();return;
 }
 if(a==="sync-workouts"){await flushWorkouts();render();note("Отправлено в дневник.");return}
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
   copy.editBase=current||null;draft=copy;retain();if(review&&localStorage.getItem(pending.key)===pending.raw)localStorage.removeItem(pending.key);tab=1;render();return
 }
 if(a==="open"){tab=1;render();return}
 if(a==="start"){const date=when("start");draft={id:newEntryId(),date,exercises:plan(state,date),cardio:[{},{}]};retain();lastSummary=null}
 if(a==="cancel"){if(!confirm("Удалить черновик этой тренировки?"))return;draft=null;retain()}
 if(a.startsWith("add-")||a.startsWith("sub-")){const sets=draft.exercises[+a.split("-")[1]].sets;if(a.startsWith("add"))sets.push({...sets.at(-1),kg:sets.at(-1)?.kg||0,reps:sets.at(-1)?.reps||10,done:false,easy:false});else sets.pop();retain()}
 if(a==="finish"){
   const w=structuredClone(draft);w.date=when("start");w.end=(draft.end||selectedDay!==local().slice(0,10))?when("end"):local();await refreshScale(who).catch(()=>{});
   const before=w.editBase||null;delete w.editBase;
   w.startedAt=before?.date===w.date&&before.startedAt?before.startedAt:new Date(w.date).toISOString();
   w.endedAt=before?.end===w.end&&before.endedAt?before.endedAt:new Date(w.end).toISOString();
   const sample=measurementAt(state,w.startedAt,scale);
   if(before&&before.date===w.date){w.kg=before.kg;w.weightSample=before.weightSample||null}
   else{w.kg=sample?.kg??null;w.weightSample=sample?{date:sample.date,source:sample.source||"legacy",kg:sample.kg}:null}
   w.person=before?.person||{height:state.profile.height,birth:state.profile.birth,sex:state.profile.sex};
   if(w.exercises.some(e=>e.sets.some(t=>t.done&&(!Number.isInteger(t.reps)||t.reps<1||!Number.isFinite(t.kg)||t.kg<0)))){
     throw Error("У отмеченного подхода укажи повторы и вес. Для упражнения без отягощения введи 0 кг.");
   }
   w.cardio=w.cardio.flatMap((c,i)=>{if(!Object.values(c).some(x=>x!==''&&x!=null))return [];if(!/^\d{1,3}:[0-5]\d$/.test(c.time||""))throw Error("Укажи время дорожки в формате мин:сек.");
    const [m,s]=c.time.split(":").map(Number),seconds=m*60+s;
    if(!seconds)throw Error("Время дорожки должно быть больше нуля.");
    return [{...c,role:i?"Заминка":"Разминка",seconds,kcal:c.kcal==null||c.kcal===""?null:Number(c.kcal)}]});
   if(Date.parse(w.end)<=Date.parse(w.date)||w.cardio.reduce((a,c)=>a+c.seconds,0)>(Date.parse(w.end)-Date.parse(w.date))/1000)throw Error("Проверь время начала, окончания и длительность дорожки.");
   if(!total(w).sets&&!w.cardio.length)throw Error("Отметь выполненный подход или внеси дорожку.");
   localStorage.setItem(queuePrefix()+w.id,JSON.stringify({workout:w,before}));
   draft=null;retain();lastSummary=w;
   try{await flushWorkouts();note("Тренировка сохранена в дневнике.")}catch(e){note("Сохранено на устройстве. "+e.message)}
 }
 if(a.startsWith("history-")){const w=state.workouts.find(w=>w.id===a.slice(8));selectDay(w.date.slice(0,10));tab=1}
 if(a==="weight"){const kg=Number(val("kg")),date=new Date(when("wdate")).toISOString();if(!(kg>0&&kg<700))throw Error("Проверь вес.");await saveForm("weight",s=>{
   s.weights=s.weights.filter(w=>!(w.source==="manual"&&Date.parse(w.date)===Date.parse(date)));s.weights.push({kg,date,source:"manual"})
 })}
 if(a==="profile"){const minutes=Number(val("minutes")),step=Number(val("step"));if(val("birth")&&Date.parse(val("birth"))>Date.now()||val("height")&&!(Number(val("height"))>0&&Number(val("height"))<300))throw Error("Проверь рост и дату рождения.");if(!Number.isFinite(minutes)||!Number.isFinite(step)||minutes<10||minutes>240||step<=0||step>20)throw Error("Проверь оборудование, длительность и шаг прибавки.");const exerciseSteps={};for(const f of document.querySelectorAll("[data-step-name]"))if(f.value!==""){if(!f.checkValidity())throw Error("Проверь шаг веса у упражнения.");exerciseSteps[f.dataset.stepName]=Number(f.value)}
   const week=Array.from({length:7},(_,i)=>val("week"+i));
   await saveForm("profile",s=>Object.assign(s.profile,{week,exerciseSteps,height:val("height"),birth:val("birth"),sex:val("sex"),minutes,step,goal:val("goal"),focus:val("focus"),extra:selected("extra"),fixed:$("fixed").checked,legDays:selected("legday").map(Number),equipment:selected("eq")}))}
 if(a.startsWith("undo-supp-")){const name=decodeURIComponent(a.slice(10));if(!confirm("Снять отметку о приёме?"))return;await commit(s=>s.supps=s.supps.map(x=>x.date.startsWith(selectedDay)?{...x,names:x.names.filter(n=>n!==name)}:x).filter(x=>x.names.length));render();return}
 if(a==="supp"){
 const date=when("sdate"),names=selected("supp"),actualPeriod=val("period");
 if(!names.length)throw Error("Выбери принятые добавки.");
 await commit(s=>{for(const name of names){
 const move=s.suppMoves?.[selectedDay]?.[name],when=move?selectedDay+"T"+move.clock:date;
 if(Date.parse(when)>Date.now()+60000)throw Error("Время приёма ещё не наступило.");
 if(!s.supps.some(x=>x.date.startsWith(selectedDay)&&x.names.some(n=>canonicalSupp(n)===name)))s.supps.push({date:when,period:move?.period||actualPeriod,names:[name]});
 }});
 }
 if(a==="search"){
   const q=val("query").trim();if(q.length<2)throw Error("Введи название или штрихкод.");
   const recent=[...(state.products||[]),...state.meals.slice().reverse()].filter(x=>x.code===q||x.name.toLowerCase().includes(q.toLowerCase()));
   let remote=[];try{remote=await request("food?q="+encodeURIComponent(q))}catch{note("Онлайн-поиск недоступен. Можно выбрать недавний продукт или ввести данные с этикетки.")}
   results=[...recent,...remote.map(x=>({code:x.code||"",name:[x.product_name,x.brands].filter(Boolean).join(" · "),nut:["energy-kcal","proteins","fat","carbohydrates"].map(k=>x.nutriments?.[k+"_100g"]??null),unit:x.nutrition_data_per==="100ml"?"мл":"г"}))].filter((x,i,all)=>x.name&&all.findIndex(y=>y.name===x.name)===i);
   $("matches").innerHTML=results.map((x,i)=>btn("pick-"+i,esc(x.name))).join("")||"Совпадений нет.";return
 }
 if(a.startsWith("pick-")){const x=results[+a.slice(5)];$("product").value=x.name;$("barcode").value=x.code||"";$("unit").value=x.unit;x.nut.forEach((v,i)=>$("nut"+i).value=v??"");const meal=formBindings.find(b=>b.button.dataset.action==="meal");if(meal)trackForm(meal);return}
 if(a==="cancel-meal"){rememberForm(formKey("meal"),null);editingMeal=null;render();return}
 if(a.startsWith("repeat-meal-")){const m=state.meals.find(x=>x.id===a.slice(12));if(!m)return;editingMeal=null;render();$("product").value=m.name;$("barcode").value=m.code||"";$("unit").value=m.unit;$("amount").value=m.amount;m.nut.forEach((v,i)=>$("nut"+i).value=v??"");trackForm(formBindings.find(b=>b.button.dataset.action==="meal"));$("amount").focus();return}
 if(a.startsWith("edit-meal-")){editingMeal=a.slice(10);render();$("product").focus();return}
 if(a.startsWith("remove-meal-")){const id=a.slice(12);if(!confirm("Удалить эту порцию из дневника?"))return;await commit(s=>s.meals=s.meals.filter(m=>m.id!==id));editingMeal=null;render();return}
 if(a==="meal"){const code=val("barcode").trim();if(code&&!/^\d{8,14}$/.test(code))throw Error("Укажи штрихкод из 8–14 цифр.");
 const name=val("product").trim(),amount=Number(val("amount")),date=when("mealdate"),unit=val("unit"),nut=[0,1,2,3].map(i=>val("nut"+i)===""?null:Number(val("nut"+i)));if(!name||amount<=0||nut.some(x=>x<0))throw Error("Проверь продукт, порцию и пищевую ценность.");const id=editingMeal||newEntryId(),portion={id,name,amount,date,unit,nut,code};await saveForm("meal",s=>{if(editingMeal)s.meals=s.meals.map(m=>m.id===id?portion:m);else s.meals.push(portion);s.products=[{name,code,nut,unit},...(s.products||[]).filter(p=>code?p.code!==code:p.name!==name)]});editingMeal=null;render();$("foodday").value=date.slice(0,10);$("entries").innerHTML=mealList(date.slice(0,10));return}
 render();
}
function showTaken(){
 const d=$("sdate")?.value;
 if(d&&$("planPanel")){const panel=$("planPanel");panel.innerHTML=planPanel(d.slice(0,10));panel.dataset.day=d.slice(0,10);updateSupplementButton()}
}
document.addEventListener("change",async ev=>{
 if(ev.target.name==="supp")updateSupplementButton();
 if(["sdate","mealdate","wdate","start"].includes(ev.target.id)&&ev.target.value.startsWith(selectedDay)){manualTime=ev.target.value.slice(11);manualPeriod=period(ev.target.value)}
 if(ev.target.id==="period")manualPeriod=ev.target.value;
 if(ev.target.id==="foodday"&&ev.target.value){selectDay(ev.target.value);render();return}
 if(ev.target.id==="sdate"&&!ev.target.value.startsWith(selectedDay)){ev.target.value=stamp();note("День меняется в календаре.")}
 if(ev.target.id!=="daySlot"||busy)return;
 const date=selectedDay,slot=ev.target.value;
 busy=true;$("who").disabled=true;
 try{await commit(s=>{s.dayPlans={...s.dayPlans,[date]:slot}});if(date===selectedDay){const el=document.querySelector(".hero");if(el)el.outerHTML=hero()}showTaken()}catch(e){note(e.message);showTaken()}finally{busy=false;$("who").disabled=false}
});
document.addEventListener("input",ev=>{const x=ev.target;if(x.id==="sdate"&&x.value.startsWith(selectedDay)&&$("period")){$("period").value=period(x.value);manualTime=x.value.slice(11);manualPeriod="";}if(!draft||tab!==1)return;
 if(x.dataset.k){const row=x.closest(".set");draft.exercises[row.dataset.i].sets[row.dataset.j][x.dataset.k]=x.type==="checkbox"?x.checked:x.value===""?null:Number(x.value)}
 if(x.dataset.c!==undefined)draft.cardio[x.dataset.c][x.dataset.f]=x.value;
 if(x.dataset.k==="done"||x.dataset.c!==undefined)updateFinishButton();
 if(x.dataset.k==="done"&&$("setMeter"))$("setMeter").outerHTML=progressMeter();
 if(x.id==="start"&&x.value.startsWith(selectedDay))draft.date=x.value;if(x.id==="end")draft.end=x.value;retain()});
document.addEventListener("click",async ev=>{const b=ev.target.closest("button");if(!b||b.hidden||b.classList.contains("retryPhoto")||busy||!state||b.dataset.move||b.hasAttribute("data-reorder")||b.closest("dialog"))return;note("");
 if(b.dataset.tab!==undefined){tab=+b.dataset.tab;render();return}
 busy=true;$("who").disabled=true;b.setAttribute("aria-busy","true");b.parentElement.querySelector(".saveError")?.remove();try{if(b.dataset.action==="finish"&&Array.from(document.querySelectorAll("#content input")).some(i=>!i.reportValidity()))return;await action(b.dataset.action)}catch(e){
   note(e.message);
   if(formBindings.some(f=>f.button===b)||b.dataset.action==="finish"){
     const message=document.createElement("p");message.className="saveError";message.textContent=e.message;b.after(message);
   }
 }finally{b.removeAttribute("aria-busy");busy=false;$("who").disabled=false}});
$("who").onchange=()=>{if(busy||!people.some(p=>p.id===$("who").value)){$("who").value=who;return}who=$("who").value;scale=[];editingMeal=null;settingsOpen=false;state=null;draft=null;lastSummary=null;results=[];tab=0;$("content").innerHTML="";note("");load().catch(e=>note(e.message))};
if(typeof window!=="undefined"&&window.addEventListener){
 const recover=async()=>{
   if(!state||busy||document.hidden)return;
   const user=who;
   if(queued().length){
     busy=true;$("who").disabled=true;
     try{await flushWorkouts();render();note("Тренировка сохранена в дневнике.")}catch(e){note(e.message)}
     finally{busy=false;$("who").disabled=false}
   }
   const was=JSON.stringify(scale);await refreshScale(user).catch(()=>{});
   if(who===user&&tab===3&&!busy&&was!==JSON.stringify(scale))render();
 };
 window.addEventListener("online",recover);document.addEventListener("visibilitychange",recover);
 window.setInterval(recover,60000);
}
initialize().catch(e=>note(e.message));
const clocks={"Утро":"09:00","День":"13:00","Вечер":"19:00","Ночь":"00:00"};
function proposedClock(slot,original){
 if(original&&period(selectedDay+"T"+original)===slot)return original;
 if(period(stamp())===slot)return stamp().slice(11);
 return clocks[slot];
}
function openMove(name,target){
 if(busy||document.querySelector("dialog[open]"))return;
 const source=document.querySelector('[data-move="'+CSS.escape(name)+'"]');
 if(!source)return;
 const old=state.supps.find(x=>x.date.startsWith(selectedDay)&&x.names.some(n=>canonicalSupp(n)===name));
 const move=state.suppMoves?.[selectedDay]?.[name];
 const initial=target||old?.period||move?.period||source.closest("[data-slot]").dataset.slot;
 const slot=periods.includes(initial)?initial:period(stamp());
 const dlg=document.createElement("dialog");
 dlg.setAttribute("aria-label","Перенос добавки");
 dlg.innerHTML='<form><h2>'+esc(name)+'</h2><p>'+dayLabel(selectedDay)+'</p><label>Период<select name="slot">'+options(periods,slot)+'</select></label><label>Время<input required type="time" name="clock" value="'+proposedClock(slot,old?.date.slice(11)||move?.clock)+'"></label><p class="moveError" role="status"></p><div class="actions"><button class="primary" type="submit">'+(old?"Исправить отметку":"Перенести")+'</button><button type="button" name="cancel">Отмена</button></div></form>';
 document.body.append(dlg);
 const form=dlg.querySelector("form"),fields=form.elements;
 fields.slot.onchange=()=>fields.clock.value=proposedClock(fields.slot.value,fields.clock.value);
 fields.clock.onchange=()=>{if(fields.clock.value)fields.slot.value=period(selectedDay+"T"+fields.clock.value)};
 fields.cancel.onclick=()=>dlg.close();
 dlg.onclose=()=>{dlg.remove();document.querySelector('[data-move="'+CSS.escape(name)+'"]')?.focus({preventScroll:true})};
 form.onsubmit=async event=>{
 event.preventDefault();if(busy)return;
 const clock=fields.clock.value,date=selectedDay+"T"+clock,destination=period(date);
 const checked=selected("supp");
 busy=true;
 try{
 if(old&&Date.parse(date)>Date.now()+60000)throw Error("Фактический приём нельзя перенести в будущее.");
 await commit(s=>{
 s.suppMoves||={};s.suppMoves[selectedDay]={...s.suppMoves[selectedDay],[name]:{period:destination,clock}};
 if(old){s.supps=s.supps.map(x=>x.date.startsWith(selectedDay)?{...x,names:x.names.filter(n=>canonicalSupp(n)!==name)}:x).filter(x=>x.names.length);
 s.supps.push({date,period:destination,names:[name]})}
 });
 render();document.querySelectorAll('input[name="supp"]:not(:disabled)').forEach(el=>el.checked=checked.includes(el.value));updateSupplementButton();dlg.close();note(old?"Время приёма исправлено.":"Период изменён. Приём можно подтвердить галочкой.");
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
