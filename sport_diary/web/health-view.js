"use strict";
const SportHealthView=(()=>{
  const metrics={
    steps:["Шаги","шагов","sensor.iphone_steps"],
    distance:["Дистанция ходьбы и бега","км","sensor.iphone_distance"],
    exercise:["Упражнения","мин","sensor.iphone_exercise_minutes"],
    active:["Активная энергия","ккал","sensor.iphone_active_energy"],
    resting:["Энергия покоя","ккал","sensor.iphone_basal_energy"],
    restingPulse:["Пульс покоя","уд/мин","sensor.iphone_resting_heart_rate"]
  };
  const sensors={sleep:["Сон","мин","sensor.iphone_sleep"],...metrics};
  const kinds={strength:"Силовая тренировка",running:"Бег",walking:"Ходьба",cycling:"Велосипед",other:"Другая тренировка"};
  const energies={active:"Активные ккал",total:"Всего ккал",resting:"Ккал покоя"};
  const stages={awake:"Бодрствование",inbed:"В постели",in_bed:"В постели","in bed":"В постели",asleep:"Сон",total:"Всего сна",sleep:"Сон",asleepunspecified:"Сон",light:"Лёгкий сон",
    deep:"Глубокий сон",asleepdeep:"Глубокий сон",core:"Базовый сон",asleepcore:"Базовый сон",rem:"Быстрый сон",asleeprem:"Быстрый сон"};
  const snapshots=new Map();
  const h=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const number=x=>Number(x).toLocaleString("ru-RU",{maximumFractionDigits:2});
  function duration(x){
    if(x==null)return "Нет наблюдения";
    const minutes=Math.round(x),hours=Math.floor(minutes/60);
    return [hours?hours+" ч":"",minutes%60?minutes%60+" мин":""].filter(Boolean).join(" ")||"0 мин";
  }
  const dayLabel=d=>d?d.slice(8,10)+"."+d.slice(5,7)+"."+d.slice(0,4):"";
  const timeLabel=t=>t?dayLabel(t)+" "+t.slice(11,16):"";
  const sourceLabel=r=>[r.source==="manual"?"Вручную":r.source,r.manual&&r.imported?"исправлено вручную":""].filter(Boolean).join(" · ")||"Вручную";
  const field=(name,label,type,value="",attrs="")=>'<label>'+h(label)+'<input type="'+type+'" name="'+name+'" value="'+h(value)+'" '+attrs+'></label>';
  const numeric=(name,label,value,attrs="")=>field(name,label,"number",value??"",(/\bmin="/.test(attrs)?"":'min="0" ')+attrs);
  const select=(name,label,entries,target)=>'<label>'+h(label)+'<select name="'+name+'">'+Object.entries(entries).map(([id,text])=>'<option value="'+h(id)+'"'+(id===target?' selected':'')+'>'+h(text)+'</option>').join("")+'</select></label>';
  const check=(name,label,value)=>'<label class="check"><input type="checkbox" name="'+name+'"'+(value?' checked':'')+'>'+h(label)+'</label>';
  const button=(action,label,key="")=>'<button type="button" data-health="'+action+'" data-key="'+h(key)+'">'+h(label)+'</button>';
  const actions=(...items)=>'<div class="actions">'+items.join("")+'</div>';
  const muted=t=>'<p class="muted">'+h(t)+'</p>';
  const section=(key,title,value,body)=>'<article class="healthPanel"><details data-disclosure="health-'+key+'"><summary><strong>'+h(title)+'</strong><span>'+h(value)+'</span></summary><div class="healthBody">'+body+'</div></details></article>';
  const listRow=(title,info,controls)=>'<div class="healthRow"><div><strong>'+h(title)+'</strong><small>'+h(info)+'</small></div>'+controls+'</div>';
  const allowed=c=>Boolean(c?.profile?.id&&c.state&&(!c.profile.role||["owner","user","admin"].includes(c.profile.role)));
  const model=c=>c.model||SportHealth;
  const healthDay=c=>model(c).day(c.state,c.day);
  function offsetLabel(minutes){
    const n=Math.abs(minutes);
    return (minutes<0?"-":"+")+String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0");
  }
  function timestamp(wall,zone,offset="",original=""){
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?:\:\d\d(?:\.\d+)?)?$/.test(wall))throw Error("Укажи дату и время события.");
    const base=Date.parse(wall+"Z");
    if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,16)!==wall.slice(0,16))throw Error("Проверь дату и время.");
    let suffix=offset.trim().replace("−","-");
    if(suffix){
      if(!/^[+-](?:0\d|1[0-3]):[0-5]\d$|^[+-]14:00$/.test(suffix))throw Error("Укажи смещение UTC в формате +03:00 или −05:00.");
    }else{
      const fmt=new Intl.DateTimeFormat("sv-SE",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
      const display=ms=>fmt.format(new Date(ms)).replace(" ","T");
      const offsets=new Set();
      for(const delta of [-36,0,36]){
        const sample=Math.floor((base+delta*3600000)/60000)*60000;
        offsets.add((Date.parse(display(sample)+"Z")-sample)/60000);
      }
      const possible=[...offsets].filter(n=>display(base-n*60000)===wall.slice(0,16));
      if(!possible.length)throw Error("При переводе часов это местное время пропущено. Уточни время события.");
      if(possible.length!==1)throw Error("Этот час повторяется. Укажи смещение UTC для нужного момента.");
      suffix=offsetLabel(possible[0]);
    }
    const origOffset=original.match(/(Z|[+-]\d\d:\d\d)$/i)?.[0]?.replace(/^Z$/i,"+00:00");
    if(origOffset===suffix&&wall===original.slice(0,16))return original;
    return wall+suffix;
  }
  function instantFields(name,label,value=""){
    const offset=value?.match(/(Z|[+-]\d\d:\d\d)$/i)?.[0]?.replace(/^Z$/i,"+00:00")||"";
    return '<div class="healthInstant">'+field(name,label,"datetime-local",value?.slice(0,16),'step="60"')+
      field(name+"Offset","Смещение UTC","text",offset,'placeholder="Авто" maxlength="6" size="6"')+'</div>';
  }
  const zoneTip=c=>muted("Время дневника — "+c.zone+". В поездке или при повторе часа укажи смещение UTC для каждого момента, например +03:00.");
  function stampAt(data,name,c,oldValue=""){
    return timestamp(data.get(name)||"",c.zone,data.get(name+"Offset")||"",oldValue||"");
  }
  function optionalNumber(data,name){
    const raw=data.get(name);
    if(raw==null||raw==="")return undefined;
    const n=Number(raw);
    if(!Number.isFinite(n)||n<0)throw Error("Проверь числовые поля.");
    return n;
  }
  function hiddenRows(c,kind){
    return model(c).hiddenImports(c.state,c.day,kind).map(r=>{
      const label=kind==="sleep"?(r.kind==="nap"?"Дневной сон":"Сон"):(kinds[r.type]||r.type);
      return listRow(label+" · "+duration(kind==="sleep"?r.minutes:r.durationMinutes),"Скрытая запись · "+sourceLabel(r),
        button("undo-"+kind,"Восстановить",r.id));
    }).join("");
  }
  function sleepPanel(c,d){
    const rows=d.episodes.map(row=>{
      const shape=row.start&&row.end?timeLabel(row.start)+" — "+timeLabel(row.end):"Только длительность";
      const notes=[shape,sourceLabel(row)];
      if(row.inBedMinutes!=null)notes.push("в постели "+duration(row.inBedMinutes));
      if(row.awakeMinutes!=null)notes.push("бодрствование "+duration(row.awakeMinutes));
      if(row.awakenings!=null)notes.push("пробуждений: "+number(row.awakenings));
      const period=row.stage?(stages[row.stage]||row.stage):(row.kind==="nap"?"Дневной сон":"Основной сон");
      return listRow(period+" · "+duration(row.minutes),notes.join(" · "),
        actions(button("sleep","Исправить",row.id),row.manual&&row.imported?button("undo-sleep","Отменить правку",row.id):"",button("delete-sleep","Удалить",row.id)));
    }).join("");
    return section("sleep","Сон",duration(d.sleepMinutes),rows+hiddenRows(c,"sleep")+actions(button("sleep","Записать сон"),button("import-sleep","Импортировать сон из JSON"))+
      '<div data-health-pending="sleep">'+pendingButton(snapshots.get(c.profile.id),"sleep")+'</div>'+
      muted("Основной сон относится к дате пробуждения. Для дневного сна можно добавить отдельную запись."));
  }
  function activityPanel(c,d){
    const hidden=c.state.health?.daily?.[c.day]||{};
    const rows=Object.entries(metrics).map(([key,[label,unit]])=>{
      const r=d.daily[key];
      if(!r&&!hidden[key]?.hidden)return "";
      if(!r)return listRow(label,"Показание скрыто",button("undo-daily","Восстановить",key));
      const desc=[sourceLabel(r),r.complete?"полные сутки":"полнота суток не подтверждена",r.receivedAt?"получено "+new Date(r.receivedAt).toLocaleString("ru-RU",{timeZone:c.zone}):""].filter(Boolean).join(" · ");
      return listRow(label+" · "+number(r.value)+" "+unit,desc,actions(button("daily","Исправить",key),button("delete-daily",r.manual?"Снять ручную запись":"Скрыть показание",key)));
    }).join("");
    return section("activity","Суточная активность",Object.keys(d.daily).length?"Показателей за день · "+Object.keys(d.daily).length:"Нет наблюдений",rows+actions(button("daily","Внести показатель"))+
      '<div data-health-pending="activity">'+pendingButton(snapshots.get(c.profile.id),"activity")+'</div>'+
      muted("При отсутствии сигнала сохраняется последнее измерение на его исходной дате."));
  }
  function pendingButton(s,key){
    const n=s?.candidates?.filter(r=>(r.metric==="sleep")===(key==="sleep")).length;
    return n&&s.canManage?button("sensors","Уточнить дату показаний HA · "+n):"";
  }
  function workoutPanel(c,d){
    const rows=d.workouts.map(r=>{
      const gym=(c.state.workouts||[]).find(w=>model(c).gymKey(w)===r.gymId);
      const info=[timeLabel(r.start)+" — "+timeLabel(r.end),sourceLabel(r)];
      if(r.parentWorkoutId)info.push("Часть тренировки часов");
      for(const [key,label] of Object.entries(energies))if(r[key+"Kcal"]!=null)info.push(label+" · "+number(r[key+"Kcal"]));
      if(r.eventId)info.push("ID часов · "+r.eventId);
      if(r.distanceKm!=null)info.push(number(r.distanceKm)+" км");
      if(r.avgPulse!=null)info.push("ср. "+number(r.avgPulse)+" уд/мин");
      if(r.maxPulse!=null)info.push("макс. "+number(r.maxPulse)+" уд/мин");
      if(gym)info.push("связано с занятием "+timeLabel(gym.startedAt||gym.date));
      return listRow((kinds[r.type]||r.type)+" · "+duration(r.durationMinutes),info.join(" · "),
        actions(button("workout","Исправить",r.id),r.parentWorkoutId?"":button("link",gym?"Изменить связь":"Связать с занятием",r.id),r.manual&&r.imported?button("undo-workout","Отменить правку",r.id):"",button("delete-workout","Удалить",r.id)));
    }).join("");
    return section("watch","Внешние данные с Apple Watch",d.workouts.length?"Записей за день · "+d.workouts.length:"Нет записей за день",rows+hiddenRows(c,"workout")+actions(button("workout","Внести тренировку с Apple Watch"),button("import","Импортировать JSON")));
  }
  function mealPanel(c){
    const rows=(c.state.meals||[]).filter(m=>m.date?.startsWith(c.day));
    if(!rows.length)return "";
    const body=rows.map(m=>{
      const labels={substantial:"Существенная еда",light:"Лёгкий перекус"};
      const info=[m.date.slice(11,16),labels[m.sleepMealKind],m.actualConfirmed&&m.actualEnd?"закончено "+timeLabel(m.actualEnd):"окончание не указано"].filter(Boolean).join(" · ");
      return listRow(m.name||"Приём пищи",info,button("meal","Отметить окончание",m.id));
    }).join("");
    return section("meals","Окончание приёмов пищи","Для вечернего режима",body);
  }
  function settingsPanel(c){
    const s=c.state.health?.settings||{};
    return section("health-settings","Сон и источники данных",c.profile.name||"",
      listRow("Личные ориентиры","Сон · "+duration(s.sleepGoalMinutes??420)+"; пауза после еды · "+duration(s.pauseGoalMinutes??120),button("settings","Настроить ориентиры и баллы"))+
      listRow("Датчики Home Assistant","Отдельное подключение каждого показателя профиля",button("sensors","Открыть датчики")));
  }
  function panels(c){
    if(!allowed(c))return "";
    if(c.tab===3)return c.settingsOpen?settingsPanel(c):"";
    if(c.tab===2)return mealPanel(c);
    if(c.tab!==0&&c.tab!==1)return "";
    const d=healthDay(c);
    return c.tab===0?sleepPanel(c,d)+activityPanel(c,d):workoutPanel(c,d);
  }
  const getSleep=(c,id)=>healthDay(c).episodes.find(row=>row.id===id);
  const getWorkout=(c,id)=>healthDay(c).workouts.find(row=>row.id===id);
  const getDaily=(c,metric)=>healthDay(c).daily[metric];
  const getMeal=(c,id)=>(c.state.meals||[]).find(row=>row.id===id);
  const requiredRecord=(row)=>{if(!row)throw Error("Запись изменилась. Открой её снова.");return row};
  function guardedChange(c,find,change){
    const initial=JSON.stringify(find(c));
    return (state,data,form)=>{
      if(JSON.stringify(find({...c,state}))!==initial)throw Error("Запись изменилась на другом устройстве. Открой её заново и сверь данные.");
      return change(state,data,form);
    };
  }
  function dateField(name,label,value){
    return field(name,label,"date",value,'required');
  }
  function awakenRow(i,seg){
    return '<fieldset class="healthAwake"><legend>Период бодрствования</legend>'+
      instantFields("awakeStart"+i,"Проснулся",seg?.start)+instantFields("awakeEnd"+i,"Снова заснул",seg?.end)+
      '<button type="button" data-remove-awake>Убрать период</button></fieldset>';
  }
  function sleepEditor(c,id){
    const m=model(c),r=id?requiredRecord(getSleep(c,id)):{};
    const hrs=r.minutes!=null?Math.floor(r.minutes/60):"",mins=r.minutes!=null?Number((r.minutes%60).toFixed(2)):"";
    const method=r.start?"interval":"quick";
    const body=select("kind","Эпизод",{main:"Основной сон",nap:"Дневной сон"},r.kind||"main")+
      select("method","Как записать", {quick:"Только длительность",interval:"Начало и пробуждение"},method)+
      '<fieldset data-mode="quick"><legend>Фактический сон</legend>'+dateField("date","Дата пробуждения",r.date||c.day)+
      '<div class="healthPair">'+numeric("hours","Часы",hrs,'max="24" step="1"')+numeric("minutes","Минуты",mins,'max="59.99" step="any"')+'</div></fieldset>'+
      '<fieldset data-mode="interval"><legend>Границы сна</legend>'+instantFields("start","Начало",r.start)+instantFields("end","Окончание",r.end)+
      (r.stage?dateField("stageDate","Дата пробуждения для этой стадии",r.date):"")+zoneTip(c)+
      numeric("awakenings","Число пробуждений",r.awakenings,'step="1"')+
      select("wakeMethod","Бодрствование",{total:"Суммарные минуты",intervals:"Отдельные интервалы"},r.awakeIntervals?.length?"intervals":"total")+
      '<div data-wake="total">'+numeric("awakeMinutes","Минут бодрствования",r.awakeMinutes,'step="any"')+'</div>'+
      '<div data-wake="intervals"><div data-awake-list>'+((r.awakeIntervals||[]).map((seg,i)=>awakenRow(i,seg)).join(""))+'</div><button type="button" data-add-awake>Добавить пробуждение</button></div>'+
      '<div data-main-meal>'+check("mealsComplete","Все существенные приёмы и перекусы до этого сна внесены",r.mealsComplete)+'</div></fieldset>'+
      numeric("inBedMinutes","Минут в постели, если известно",r.inBedMinutes,'step="any"')+
      field("source","Источник или устройство","text",r.source==="manual"?"":r.source,'maxlength="120" placeholder="Вручную"');
    return {title:id?"Исправить сон":"Записать сон",body,setup(form){
      let count=r.awakeIntervals?.length||0;
      function toggle(){
        const mode=form.elements.method.value, wake=form.elements.wakeMethod.value;
        for(const el of form.querySelectorAll("[data-mode]")){el.disabled=el.hidden=el.dataset.mode!==mode}
        for(const el of form.querySelectorAll("[data-wake]"))el.hidden=el.dataset.wake!==wake;
        form.querySelector("[data-main-meal]").hidden=form.elements.kind.value!=="main";
      }
      form.addEventListener("change",toggle);
      form.addEventListener("click",ev=>{
        if(ev.target.closest("[data-add-awake]"))form.querySelector("[data-awake-list]").insertAdjacentHTML("beforeend",awakenRow(count++));
        if(ev.target.closest("[data-remove-awake]"))ev.target.closest(".healthAwake").remove();
      });
      toggle();
    },save:guardedChange(c,ctx=>id?getSleep(ctx,id):null,(s,data)=>{
      const row={id:id||undefined,kind:data.get("kind"),source:data.get("source")?.trim()||"manual",inBedMinutes:optionalNumber(data,"inBedMinutes")};
      if(r.stage)row.stage=r.stage;
      if(data.get("method")==="quick"){
        row.date=data.get("date");
        row.minutes=(optionalNumber(data,"hours")||0)*60+(optionalNumber(data,"minutes")||0);
        if(!row.minutes)throw Error("Укажи фактическую длительность сна в часах или минутах.");
      }else{
        row.start=stampAt(data,"start",c,r.start);
        row.end=stampAt(data,"end",c,r.end);
        if(data.get("stageDate"))row.date=data.get("stageDate");
        if(r.start===row.start&&r.end===row.end&&r.minutes!=null&&r.awakeMinutes==null&&!r.awakeIntervals?.length&&!data.get("awakeMinutes")&&data.get("wakeMethod")!=="intervals")row.minutes=r.minutes;
        row.awakenings=optionalNumber(data,"awakenings");
        if(data.get("wakeMethod")==="intervals"){
          row.awakeIntervals=[];
          for(const key of data.keys())if(/^awakeStart\d+$/.test(key)){
            const i=key.slice("awakeStart".length),old=r.awakeIntervals?.[Number(i)];
            row.awakeIntervals.push({start:stampAt(data,key,c,old?.start),end:stampAt(data,"awakeEnd"+i,c,old?.end)});
          }
          if(!row.awakeIntervals.length)throw Error("Добавь период бодрствования или выбери суммарные минуты.");
        }else row.awakeMinutes=optionalNumber(data,"awakeMinutes");
        row.mealsComplete=row.kind==="main"&&data.has("mealsComplete");
      }
      const saved=m.saveSleep(s,row);
      return "Сон сохранён за "+dayLabel(saved.date)+".";
    })};
  }
  function dailyEditor(c,key){
    const old=key?getDaily(c,key):null;
    const body=select("metric","Показатель",Object.fromEntries(Object.entries(metrics).map(([k,[label,unit]])=>[k,label+" · "+unit])),key||"steps")+
      dateField("date","Дата измерения",c.day)+numeric("value","Измеренное значение",old?.value,'step="any" required')+
      field("source","Источник или устройство","text",old?.source==="manual"?"":old?.source,'maxlength="120" placeholder="Вручную"')+
      check("complete","Подтверждаю покрытие полных суток",old?.complete)+muted("Для расхода нужны энергия покоя и активная энергия за полные сутки от одного источника. Назови его одинаково в обеих записях.");
    return {title:key?"Исправить показатель":"Внести суточный показатель",body,setup(form){
      if(key){form.elements.metric.disabled=true;form.elements.date.readOnly=true}
    },save:(s,data)=>{
      const metric=key||data.get("metric"),date=key?c.day:data.get("date");
      if(JSON.stringify(model(c).day(s,date).daily[metric])!==JSON.stringify(model(c).day(c.state,date).daily[metric]))throw Error("Показатель изменился. Открой его заново.");
      model(c).saveDaily(s,{date,metric,value:optionalNumber(data,"value"),source:data.get("source")?.trim()||"manual",complete:data.has("complete")});
      return "Показатель сохранён за "+dayLabel(date)+".";
    }};
  }
  function workoutEditor(c,id){
    const r=id?requiredRecord(getWorkout(c,id)):{};
    const custom=r.type&&!Object.hasOwn(kinds,r.type);
    const body=select("type","Вид тренировки",{...kinds,custom:"Указать название"},custom?"custom":r.type||"strength")+
      '<div data-custom-type>'+field("customType","Название вида тренировки","text",custom?r.type:"",'maxlength="100"')+'</div>'+
      instantFields("start","Начало тренировки",r.start)+instantFields("end","Окончание тренировки",r.end)+zoneTip(c)+
      numeric("durationMinutes","Минут тренировки, если измерены отдельно",r.durationMinutes,'step="any"')+
      '<fieldset><legend>Энергия занятия</legend>'+Object.entries(energies).map(([key,label])=>numeric(key+"Kcal",label,r[key+"Kcal"],'step="any"')).join("")+'</fieldset>'+
      numeric("distanceKm","Дистанция, км",r.distanceKm,'step="any"')+
      '<div class="healthPair">'+numeric("avgPulse","Средний пульс, уд/мин",r.avgPulse,'step="any"')+numeric("maxPulse","Пиковый пульс, уд/мин",r.maxPulse,'step="any"')+'</div>'+
      field("source","Модель часов или источник","text",r.source==="manual"?"":r.source,'maxlength="120" placeholder="Вручную"');
    return {title:id?"Исправить данные Apple Watch":"Тренировка с Apple Watch",body,setup(form){
      const sync=()=>{form.querySelector("[data-custom-type]").hidden=form.elements.type.value!=="custom"};
      form.elements.type.addEventListener("change",sync);sync();
    },
      save:guardedChange(c,ctx=>id?getWorkout(ctx,id):null,(s,data)=>{
        const row={id:id||undefined,type:data.get("type")==="custom"?data.get("customType").trim():data.get("type"),start:stampAt(data,"start",c,r.start),end:stampAt(data,"end",c,r.end),
          source:data.get("source").trim()||"manual"};
        for(const key of ["durationMinutes","distanceKm","activeKcal","totalKcal","restingKcal","avgPulse","maxPulse"])row[key]=optionalNumber(data,key);
        if(r.eventId)row.eventId=r.eventId;
        if(r.sourceIdentifier&&r.source===row.source)row.source={name:row.source,identifier:r.sourceIdentifier};
        model(c).saveWorkout(s,row);
        return "Данные Apple Watch сохранены. Связь с занятием можно выбрать в карточке за "+dayLabel(row.start)+".";
      })};
  }
  function linkEditor(c,id){
    const m=model(c),row=requiredRecord(getWorkout(c,id)),gym=c.state.workouts||[];
    const suggested=new Set(m.candidates(c.state,id).map(m.gymKey));
    const sorted=gym.filter(w=>suggested.has(m.gymKey(w))||row.gymId===m.gymKey(w)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    const opts=Object.assign(Object.create(null),{'':"Без связи"});
    for(const workout of sorted){
      const key=m.gymKey(workout);
      const label=[timeLabel(workout.startedAt||workout.date),workout.endedAt||workout.end?"до "+timeLabel(workout.endedAt||workout.end):"",suggested.has(key)?"совпадают вид и время":""].filter(Boolean).join(" · ");
      opts[key]=label+" · "+(workout.exercises?.map(ex=>ex.name).filter(Boolean).slice(0,2).join(", ")||"занятие зала");
    }
    const hint=suggested.size>1?"Совпало несколько занятий. Выбери по времени и упражнениям.":suggested.size===1?"Подходящее занятие отмечено в списке. Подтверди связь.":"Нет занятий зала с совпадающим видом и интервалом. Проверь дату, время и вид тренировки.";
    return {title:"Связь с занятием зала",body:muted(timeLabel(row.start)+" · "+(kinds[row.type]||row.type))+muted(hint)+select("gym","Занятие из этого профиля",opts,row.gymId||""),
      save:guardedChange(c,ctx=>getWorkout(ctx,id),(s,data)=>{m.linkWorkout(s,id,data.get("gym")||null);return data.get("gym")?"Связь с занятием сохранена.":"Связь снята."})};
  }
  function mealEditor(c,id){
    const r=requiredRecord(getMeal(c,id));
    return {title:r.name||"Окончание приёма пищи",body:muted("В дневнике записано "+timeLabel(r.date)+". Укажи, когда действительно закончил есть.")+
      select("kind","Для вечернего режима",{"":"Без отметки",substantial:"Существенный приём",light:"Лёгкий перекус"},r.sleepMealKind||"")+
      instantFields("end","Фактическое окончание еды",r.actualConfirmed?r.actualEnd:"")+zoneTip(c),
      save:guardedChange(c,ctx=>getMeal(ctx,id),(s,data)=>{
        const meal=requiredRecord(getMeal({...c,state:s},id)),kind=data.get("kind");
        if(!kind&&data.get("end"))throw Error("Выбери тип приёма или очисти время окончания, чтобы снять отметку.");
        const end=kind&&data.get("end")?stampAt(data,"end",c,r.actualEnd):null;
        if(end&&Date.parse(end)>Date.now())throw Error("Фактическое окончание еды ещё не наступило.");
        delete meal.sleepMealKind;delete meal.actualEnd;delete meal.actualConfirmed;
        if(kind)meal.sleepMealKind=kind;
        if(end){meal.actualEnd=end;meal.actualConfirmed=true}
        return kind?"Отметка еды сохранена.":"Отметка еды снята.";
      })};
  }
  function settingsEditor(c){
    const s=c.state.health?.settings||{},p=c.state.profile||{},m=model(c);
    const age=p.birth?Number(c.day.slice(0,4))-Number(p.birth.slice(0,4))-Number(c.day.slice(5)<p.birth.slice(5)):p.age;
    const pref=(key,current,rows)=>{
      const choices=new Set([current,...rows.map(r=>r.source)].filter(Boolean));
      if(!choices.size)return "";
      const opts=Object.fromEntries([["","Автоматически"],...[...choices].map(v=>[v,v==="manual"?"Вручную":v])]);
      return select("source_"+key,sensors[key][0],opts,current||"");
    };
    const sleepRows=[...(c.state.healthImported?.sleep||[]),...(c.state.health?.sleepImports||[]),...(c.state.health?.sleep||[])];
    const preferences=pref("sleep",s.sleepSource,sleepRows)+Object.keys(metrics).map(k=>pref(k,s.dailySources?.[k],(c.state.healthImported?.daily||[]).filter(r=>r.metric===k))).join("");
    const ageHint=age!=null&&age!==""?"Справочный ориентир для этого возраста · "+m.sleepReference(age):"Укажи возраст или дату рождения в профиле для справочного ориентира.";
    return {title:"Сон и вечерний режим",body:
      '<fieldset><legend>Длительность сна</legend>'+check("sleepBonus","Начислять 2 балла за личную цель сна",s.sleepBonus)+
      numeric("sleepGoalMinutes","Личная цель, мин",s.sleepGoalMinutes??420,'min="1" max="1440" step="1" required')+
      muted(ageHint)+'<a href="https://www.cdc.gov/sleep/about/" target="_blank" rel="noopener noreferrer">Ориентиры сна по возрасту · CDC</a></fieldset>'+
      '<fieldset><legend>Вечерний режим</legend>'+check("mealBonus","Начислять 1 балл за паузу после еды",s.mealBonus)+
      numeric("pauseGoalMinutes","Личная пауза, мин",s.pauseGoalMinutes??120,'min="1" max="1440" step="1" required')+
      muted("Отметь в «Питании» тип и окончание еды. В записи основного сна подтверди полноту дневника за предыдущее бодрствование.")+'</fieldset>'+
      (preferences?'<fieldset><legend>Предпочтительные источники</legend>'+preferences+'</fieldset>':""),
      save:guardedChange(c,ctx=>ctx.state.health?.settings,(state,data)=>{
        const settings=m.ensure(state).settings;
        settings.sleepBonus=data.has("sleepBonus");settings.mealBonus=data.has("mealBonus");
        for(const k of ["sleepGoalMinutes","pauseGoalMinutes"]){
          const n=optionalNumber(data,k);if(!Number.isInteger(n)||n<1||n>1440)throw Error("Укажи цель от 1 до 1440 минут.");
          settings[k]=n;
        }
        if(data.has("source_sleep"))settings.sleepSource=data.get("source_sleep");
        for(const k of Object.keys(metrics))if(data.has("source_"+k)){
          settings.dailySources||={};
          if(data.get("source_"+k))settings.dailySources[k]=data.get("source_"+k);else delete settings.dailySources[k];
        }
        return "Настройки сна сохранены.";
      })};
  }
  function importEditor(c,sleep=false){
    const hint=sleep?"Подходит запись, массив или объект со списком sleep. Для каждого эпизода нужны id и дата пробуждения date с длительностью minutes либо границы start и end со смещениями UTC. Можно указать источник source, вид эпизода kind (main или nap) и стадию stage.":
      "Подходит экспорт Health Auto Export со списком data.workouts или запись с полями id, type, start и end. Время начала и конца должно содержать смещение. После импорта открой дату тренировки для связи с занятием зала.";
    return {title:sleep?"Импорт сна":"Импорт тренировки",body:'<label>Файл JSON<input type="file" name="file" accept=".json,application/json" required></label>'+muted(hint),
      submit:"Импортировать",async prepare(data){
        const file=data.get("file");
        if(!file||file.size===0)throw Error("Выбери непустой JSON-файл.");
        if(file.size>10*1024*1024)throw Error("Выбери файл меньше 10 МБ, например экспорт за одну неделю.");
        let payload;try{payload=JSON.parse(await file.text())}catch{throw Error("Не удалось прочитать JSON. Проверь формат файла.")}
        return payload;
      },save(s,data,form,payload){
        const rows=sleep?model(c).importSleep(s,payload):model(c).importWorkouts(s,payload);
        const dates=[...new Set(rows.map(r=>r.date||r.start.slice(0,10)))].sort();
        return "Обработано записей: "+rows.length+(dates.length?" · "+(dates.length===1?dayLabel(dates[0]):dayLabel(dates[0])+" – "+dayLabel(dates.at(-1))):"")+".";
      }};
  }
  function management(c,action,key){
    const m=model(c);
    const restorable=(read,kind)=>(ctx,id)=>read(ctx,id)||m.hiddenImports(ctx.state,ctx.day,kind).find(r=>r.id===id);
    const targets={
      "delete-sleep":[getSleep,"Удалить запись сна","Удалить",s=>m.removeSleep(s,key)],
      "undo-sleep":[restorable(getSleep,"sleep"),"Восстановить исходную запись сна","Восстановить",s=>m.revertSleep(s,key)],
      "delete-daily":[getDaily,"Снять значение за день","Подтвердить",s=>m.removeDaily(s,c.day,key)],
      "undo-daily":[(ctx,k)=>ctx.state.health?.daily?.[c.day]?.[k],"Восстановить исходное показание","Восстановить",s=>m.revertDaily(s,c.day,key)],
      "delete-workout":[getWorkout,"Удалить данные Apple Watch","Удалить",s=>m.removeWorkout(s,key)],
      "undo-workout":[restorable(getWorkout,"workout"),"Восстановить исходную запись часов","Восстановить",s=>m.revertWorkout(s,key)]
    };
    if(!Object.hasOwn(targets,action))return null;
    const [read,title,submit,change]=targets[action],r=requiredRecord(read(c,key));
    const target=action.includes("daily")?metrics[key][0]:action.includes("sleep")?(r.kind==="nap"?"Дневной сон":"Основной сон"):kinds[r.type]||r.type;
    const info=[target,dayLabel(c.day),r.start?timeLabel(r.start):"",r.value!=null?number(r.value)+" "+metrics[key]?.[1]:""].filter(Boolean).join(" · ");
    return {title,body:muted(info),submit,save:guardedChange(c,ctx=>read(ctx,key),(s)=>{change(s);return "Дневник обновлён."})};
  }
  function editor(c,action,key){
    const factories={sleep:sleepEditor,daily:dailyEditor,workout:workoutEditor,link:linkEditor,meal:mealEditor,settings:settingsEditor,import:ctx=>importEditor(ctx),"import-sleep":ctx=>importEditor(ctx,true)};
    return Object.hasOwn(factories,action)?factories[action](c,key):management(c,action,key);
  }
  const sensorStatus={ok:"Есть показание",unavailable:"Источник недоступен",invalid:"Проверь значение и единицу",needs_date:"Для показания нужна дата"};
  function sensorContents(s){
    const enabled=new Set(s.enabled||[]),b=s.bindings||{};
    const rows=Object.entries(sensors).map(([key,[label,unit,example]])=>{
      const entity=b[key],text=label+" · "+unit;
      const status=s.status?.[key];
      const labelHtml=s.canManage&&entity?check("ha_"+key,text,enabled.has(key)):'<strong>'+h(text)+'</strong>';
      const state=enabled.has(key)?sensorStatus[status]||"Ожидает первого показания":"Сбор выключен";
      return '<div class="healthSensor">'+labelHtml+(entity?'<code>'+h(entity)+'</code><small>'+h(state)+'</small>':'<small>Добавь персональную сущность в конфигурацию приложения HA, например <code>'+h(example)+'</code>.</small>')+
        (s.canManage&&(entity||s.healthImported?.daily?.some(x=>x.metric===key)||key==="sleep"&&s.healthImported?.sleep?.length)?button("clear-source","Очистить историю датчика",key):"")+'</div>';
    }).join("");
    const candidates=(s.candidates||[]).filter(r=>Object.hasOwn(sensors,r.metric)).map((r,i)=>{
      const sleep=r.metric==="sleep",[label,unit]=sensors[r.metric];
      return '<fieldset class="healthCandidate" data-candidate="'+h(r.id)+'"><legend>'+h(label+" · "+(sleep?duration(r.minutes??r.value):number(r.value)+" "+unit))+'</legend>'+
        muted("Источник: "+(r.source||"HA")+". Дата события в показании отсутствует.")+
        (s.canManage?field("candidateDate"+i,sleep?"Дата пробуждения":"Дата измерения","date","")+actions(button("confirm-candidate","Записать за эту дату"),button("dismiss-candidate","Пропустить это показание")):"")+'</fieldset>';
    }).join("");
    return muted("Датчики назначает администратор в конфигурации «Спорт» для этого профиля. Если iPhone заблокирован или доступ к данным выключен, показание может поступить позже.")+
      (!s.canManage?muted("Изменить согласие на сбор и подтвердить дату может владелец этого профиля."):"")+
      rows+(s.canManage&&Object.keys(b).length?actions(button("save-sensors","Сохранить подключение")):"")+
      (enabled.size&&s.canManage?actions(button("refresh-sensors","Проверить показания сейчас")):"")+candidates;
  }
  function modal(doc,title,trigger){
    const dlg=doc.createElement("dialog");
    dlg.className="healthDialog";
    dlg.setAttribute("aria-label",title);
    dlg.innerHTML='<form><h2>'+h(title)+'</h2><div data-body></div><p role="alert" class="healthError"></p><div class="actions" data-footer></div></form>';
    doc.body.append(dlg);
    dlg.addEventListener("close",()=>{dlg.remove();if(trigger.isConnected)trigger.focus({preventScroll:true})});
    return {dlg,form:dlg.querySelector("form"),body:dlg.querySelector("[data-body]"),footer:dlg.querySelector("[data-footer]"),error:dlg.querySelector("[role=alert]")};
  }
  function bind(doc,context){
    const pendingRequests=new Map();
    doc.addEventListener("toggle",async e=>{
      const section=e.target;
      if(!section.open||!["health-sleep","health-activity"].includes(section.dataset?.disclosure))return;
      const c=context();
      if(!allowed(c))return;
      const id=c.profile.id;
      let request=pendingRequests.get(id);
      if(!request){
        request=c.request("health/"+encodeURIComponent(id));
        pendingRequests.set(id,request);
      }
      try{
        const s=await request;
        if(!sameScope(c)||!Array.isArray(s?.candidates))return;
        snapshots.set(id,s);
        for(const slot of doc.querySelectorAll("[data-health-pending]"))slot.innerHTML=pendingButton(s,slot.dataset.healthPending);
      }catch{/* A missing sensor connection leaves the manual forms available. */}
      finally{if(pendingRequests.get(id)===request)pendingRequests.delete(id)}
    },true);
    const sameScope=(old)=>{
      const cur=context();
      return allowed(cur)&&old.profile.id===cur.profile.id&&old.day===cur.day&&old.tab===cur.tab;
    };
    const cancelButton='<button type="button" data-close>Отмена</button>';
    async function run(c,ui,job){
      if(ui.form.getAttribute("aria-busy")==="true"||context().busy)return;
      if(!sameScope(c)){ui.dlg.close();return}
      ui.error.textContent="";
      ui.form.setAttribute("aria-busy","true");
      const unlock=!!c.setBusy;
      if(unlock)c.setBusy(true);
      for(const b of ui.form.querySelectorAll("button"))b.disabled=true;
      const onCancel=e=>e.preventDefault();
      ui.dlg.addEventListener("cancel",onCancel);
      try{await job()}catch(e){ui.error.textContent=e.message||"Не удалось сохранить данные."}
      finally{
        ui.dlg.removeEventListener("cancel",onCancel);
        ui.form.removeAttribute("aria-busy");
        for(const b of ui.form.querySelectorAll("button"))b.disabled=false;
        if(unlock)c.setBusy(false);
      }
    }
    function showEditor(c,spec,trigger){
      const ui=modal(doc,spec.title,trigger);
      ui.body.innerHTML=spec.body;
      ui.footer.innerHTML='<button type="submit" class="primary">'+h(spec.submit||"Сохранить")+'</button>'+cancelButton;
      ui.form.querySelector("[data-close]").onclick=()=>ui.dlg.close();
      spec.setup?.(ui.form);
      ui.form.onsubmit=e=>{
        e.preventDefault();
        run(c,ui,async()=>{
          const data=new FormData(ui.form),prepared=await spec.prepare?.(data);
          if(!sameScope(c))throw Error("Открой заново нужный профиль и дату.");
          let message;
          await c.commit(s=>{message=spec.save(s,data,ui.form,prepared)});
          if(sameScope(c)){c.render();c.note(message||"Сохранено.")}
          ui.dlg.close();
        });
      };
      ui.dlg.showModal();
    }
    async function showSensors(c,trigger){
      const ui=modal(doc,"Датчики профиля · "+(c.profile.name||""),trigger),path="health/"+encodeURIComponent(c.profile.id);
      const close='<button type="button" data-close>Закрыть</button>';
      ui.footer.innerHTML=close;
      ui.form.onsubmit=e=>e.preventDefault();
      ui.footer.querySelector("button").onclick=()=>ui.dlg.close();
      ui.dlg.showModal();
      const draw=s=>{snapshots.set(c.profile.id,s);ui.body.innerHTML=sensorContents(s)};
      const retrieve=async(body)=>{
        const snapshot=await c.request(path,body);
        if(!sameScope(c)||!ui.dlg.open)return;
        if(!snapshot||!snapshot.bindings||!Array.isArray(snapshot.enabled))throw Error("Настройки датчиков недоступны.");
        draw(snapshot);
        if(body){await c.reload();if(sameScope(c))c.note("Данные датчиков обновлены.")}
      };
      ui.body.textContent="Загрузка привязок…";
      await run(c,ui,()=>retrieve());
      if(!ui.dlg.open)return;
      if(!ui.body.querySelector(".healthSensor"))ui.body.innerHTML=button("retry-sensors","Повторить загрузку");
      ui.body.addEventListener("click",e=>{
        const el=e.target.closest("button[data-health]");
        if(!el)return;
        const a=el.dataset.health,s=snapshots.get(c.profile.id),fieldset=el.closest("[data-candidate]");
        if(!s?.canManage&&a!=="retry-sensors")return;
        run(c,ui,async()=>{
          if(a==="retry-sensors")return retrieve();
          if(a==="save-sensors"){
            const enabled=Object.keys(s.bindings).filter(k=>ui.form.elements["ha_"+k]?.checked);
            return retrieve({enabled});
          }
          if(a==="refresh-sensors")return retrieve({refresh:true});
          if(a==="confirm-candidate"){
            const date=fieldset.querySelector("input").value;
            if(!date)throw Error("Выбери подтверждённую дату события.");
            return retrieve({confirmReading:fieldset.dataset.candidate,date});
          }
          if(a==="dismiss-candidate")return retrieve({dismissReading:fieldset.dataset.candidate});
          if(a==="clear-source"){
            if(!doc.defaultView.confirm("Удалить сохранённые показания «"+sensors[el.dataset.key][0]+"» и отключить этот датчик в профиле?"))return;
            return retrieve({clear:[el.dataset.key]});
          }
        });
      });
    }
    doc.addEventListener("click",e=>{
      const trigger=e.target.closest?.("button[data-health]");
      if(!trigger||trigger.closest("dialog")||doc.querySelector("dialog[open]"))return;
      const c=context();
      if(!allowed(c)||c.busy)return;
      try{
        if(trigger.dataset.health==="sensors"){showSensors(c,trigger).catch(err=>c.note(err.message));return}
        const spec=editor(c,trigger.dataset.health,trigger.dataset.key);
        if(spec)showEditor(c,spec,trigger);
      }catch(err){c.note(err.message)}
    });
  }
  return {panels,bind,timestamp,editor,sensorContents};
})();
if(typeof module!=="undefined")module.exports=SportHealthView;
