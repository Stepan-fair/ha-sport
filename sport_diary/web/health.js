"use strict";
const SportHealth=(()=>{
  const clock=typeof module==="undefined"?{diaryInstant,diaryTime,workoutInterval}:require("./logic.js");
  const minute=60000;
  const units={steps:"steps",distance:"km",exercise:"min",active:"kcal",resting:"kcal",restingPulse:"bpm"};
  const present=x=>x!==undefined&&x!==null&&x!=="";
  const fail=message=>{throw new Error(message)};
  function number(x,label,min=0,max=Infinity){
    if(!["string","number"].includes(typeof x)||String(x).trim()===""||!Number.isFinite(Number(x))||x<min||x>max)
      fail("Проверьте значение «"+label+"».");
    return Number(x);
  }
  function label(x,name){
    if(typeof x!=="string"||!x.trim()||x.length>256)fail("Проверьте поле «"+name+"».");
    return x.trim();
  }
  function calendar(value){
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail("Укажите дату события.");
    const time=Date.parse(value+"T12:00Z");
    if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail("Проверьте календарную дату.");
    return value;
  }
  function eventDate(value){
    if(calendar(value)>clock.diaryTime().slice(0,10))fail("Фактическая дата ещё не наступила.");
    return value;
  }
  const diaryDayOf=stamp=>clock.diaryTime(new Date(stamp)).slice(0,10);
  function timestamp(value,allowLocal=true){
    if(typeof value!=="string")fail("Укажите дату и время.");
    const iso=value.trim().replace(/^(\d{4}-\d\d-\d\d) /,"$1T")
      .replace(/\s*([+-]\d\d):?(\d\d)$/,"$1:$2");
    const match=iso.match(/^(\d{4}-\d\d-\d\d)T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/i);
    if(!match||!allowLocal&&!match[5])fail("Укажите точное время и часовое смещение.");
    calendar(match[1]);
    if(match[5]?.match(/^[+-]14:(?!00)/))fail("Проверьте часовое смещение.");
    const instant=clock.diaryInstant(iso);
    if(!Number.isFinite(+instant))fail("Некорректное местное время.");
    if(match[5])return iso;
    if(clock.diaryTime(instant)!==iso.slice(0,16))fail("Уточните местное время.");
    const offset=Math.round((Date.parse(iso+"Z")-instant)/minute);
    const pad=n=>String(n).padStart(2,"0");
    return iso+(offset<0?"-":"+")+pad(Math.floor(Math.abs(offset)/60))+":"+pad(Math.abs(offset)%60);
  }
  function interval(row,allowLocal=true){
    const start=timestamp(row.start,allowLocal),end=timestamp(row.end,allowLocal);
    const span=(Date.parse(end)-Date.parse(start))/minute;
    if(span<=0||span>1440||Date.parse(end)>Date.now())fail("Проверьте границы фактического интервала (до 24 часов).");
    return {start,end,span};
  }
  function ensure(state){
    const health=state.health||={};
    health.sleep||=[];health.daily||={};health.workouts||=[];health.settings||={};
    return health;
  }
  function newId(){
    return globalThis.crypto?.randomUUID?.()||"h-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2);
  }
  // HealthKit UUIDs survive a change of exporter. Short identifiers are local to a source.
  function eventKey(row){
    const id=row.eventId??row.id;
    if(typeof id!=="string")return null;
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return "uuid:"+id.toLowerCase();
    return JSON.stringify([row.sourceIdentifier??row.source,id]);
  }
  function union(parts){
    const result=[];
    for(const [a,b] of [...parts].sort((x,y)=>x[0]-y[0])){
      const last=result.at(-1);
      if(last&&last[1]>=a)last[1]=Math.max(last[1],b);
      else result.push([a,b]);
    }
    return result;
  }
  function subtract(parts,occupied){
    let free=parts;
    for(const [lo,hi] of occupied){
      free=free.flatMap(([a,b])=>b<=lo||a>=hi?[[a,b]]:[[a,Math.min(b,lo)],[Math.max(a,hi),b]].filter(([x,y])=>x<y));
    }
    return free;
  }
  const length=spans=>spans.reduce((sum,[a,b])=>sum+(b-a)/minute,0);
  function normalizeSleep(row,allowLocal){
    const result={kind:row.kind??"main",source:label(row.source??"Вручную","Источник"),mealsComplete:row.mealsComplete===true};
    if(present(row.sourceIdentifier))result.sourceIdentifier=label(row.sourceIdentifier,"Идентификатор источника");
    if(present(row.eventId))result.eventId=label(row.eventId,"Идентификатор события");
    if(!["main","nap"].includes(result.kind))fail("Укажите основной или дневной сон.");
    if(present(row.unit)&&row.unit!=="min")fail("Длительность сна ожидается в минутах.");
    result.unit="min";
    if(present(row.stage)){
      result.stage=label(row.stage,"Стадия сна").toLowerCase();
      if(!["awake","inbed","in_bed","in bed","total","asleep","sleep","asleepunspecified","core","deep","rem","light","asleepcore","asleepdeep","asleeprem"].includes(result.stage))
        fail("Неизвестная стадия сна.");
    }
    const detailed=present(row.start)||present(row.end);
    let span;
    if(detailed){
      const bounds=interval(row,allowLocal);
      span=bounds.span;result.start=bounds.start;result.end=bounds.end;result.date=diaryDayOf(result.end);
      if(present(row.date)&&calendar(row.date)!==result.date){
        const difference=Date.parse(row.date)-Date.parse(result.date);
        if(!result.stage||difference!==86400000)fail("Укажите дату пробуждения.");
        result.date=eventDate(row.date);
      }
    }else result.date=eventDate(row.date);
    if(present(row.awakenings)){
      result.awakenings=number(row.awakenings,"Число пробуждений",0,1440);
      if(!Number.isInteger(result.awakenings))fail("Введите целое число пробуждений.");
    }
    if(present(row.inBedMinutes))result.inBedMinutes=number(row.inBedMinutes,"В постели",0,1440);
    if(present(row.awakeMinutes))result.awakeMinutes=number(row.awakeMinutes,"Бодрствование",0,span??1440);
    if(present(row.awakeIntervals)){
      if(!detailed||!Array.isArray(row.awakeIntervals))fail("Для пробуждений нужны границы сна.");
      result.awakeIntervals=row.awakeIntervals.map(w=>{
        const {start,end}=interval(w,allowLocal);
        if(Date.parse(start)<Date.parse(result.start)||Date.parse(end)>Date.parse(result.end))fail("Пробуждение выходит за границы сна.");
        return {start,end};
      });
      const known=length(union(result.awakeIntervals.map(w=>[Date.parse(w.start),Date.parse(w.end)])));
      if(result.awakeMinutes!=null&&result.awakeMinutes<known)fail("Длительность пробуждений меньше указанных интервалов.");
      result.awakeMinutes??=known;
    }
    const possible=detailed?span-(result.awakeMinutes??0):1440;
    result.minutes=present(row.minutes)?number(row.minutes,"Фактический сон",0,possible+0.00001):
      detailed?possible:fail("Укажите фактическую длительность сна.");
    if(result.inBedMinutes!=null&&result.inBedMinutes+0.00001<result.minutes)fail("Время в постели меньше фактического сна.");
    if(!result.minutes&& !["awake","inbed","in_bed"].includes(result.stage))fail("Укажите положительную длительность сна.");
    result.receivedAt=row.receivedAt||new Date().toISOString();
    return result;
  }
  function externalSleep(state){
    const rows=new Map();
    for(const r of [...(state.healthImported?.sleep||[]),...(state.health?.sleepImports||[])]){
      try{
        // The stored day of a bounded main episode can predate a change of diary zone.
        const original=normalizeSleep(r.end&&!r.stage?{...r,date:undefined}:r,false);
        const id=label(r.id,"Идентификатор");
        rows.set(id,{...original,id,imported:true,manual:false});
      }catch{/* A sensor without a dated observation can only be confirmed manually. */}
    }
    return rows;
  }
  function sleepRows(state){
    const rows=externalSleep(state);
    for(const item of state.health?.sleep||[]){
      if(item.hidden)rows.delete(item.id);
      else {
        const date=!item.stage&&Number.isFinite(Date.parse(item.end))?diaryDayOf(item.end):item.date;
        rows.set(item.id,{...item,date,id:item.id,manual:true,imported:rows.has(item.id)});
      }
    }
    return [...rows.values()];
  }
  function replace(rows,item){
    const i=rows.findIndex(r=>r.id===item.id);
    if(i<0)rows.push(item);else rows[i]=item;
  }
  function payloadRows(payload,key){
    if(typeof payload==="string"){
      try{payload=JSON.parse(payload)}catch{fail("Проверьте формат JSON.")}
    }
    const rows=payload?.data?.[key]??payload?.[key]??(Array.isArray(payload)?payload:[payload]);
    if(!Array.isArray(rows)||!rows.length||rows.length>10000)fail("Выберите от 1 до 10 000 записей.");
    return rows;
  }
  function importSleep(state,payload){
    const events=payloadRows(payload,"sleep").map(row=>{
      if(!row||typeof row!=="object")fail("Некорректная запись сна.");
      const eventId=label(row.eventId??row.externalId??row.id,"Идентификатор события");
      return {...normalizeSleep({...row,source:row.source??"Импорт сна"},false),eventId};
    });
    const list=ensure(state).sleepImports||=[];
    const sourceIds=new Map(list.map(r=>[eventKey(r),r.id]));
    const usedIds=new Set([...list,...(state.healthImported?.sleep||[]),...(state.health.sleep||[])].map(r=>r.id));
    const ids=events.map(row=>{
      const key=eventKey(row);
      const id=sourceIds.get(key)??(usedIds.has(row.eventId)?newId():row.eventId);
      sourceIds.set(key,id);usedIds.add(id);replace(list,{...row,id});return id;
    });
    const all=new Map(sleepRows(state).map(r=>[r.id,r]));
    return ids.map(id=>all.get(id)).filter(Boolean);
  }
  function saveSleep(state,input){
    const fields=normalizeSleep(input,true),list=ensure(state).sleep;
    const existing=list.find(x=>!x.hidden&&x.source===fields.source&&x.date===fields.date&&x.kind===fields.kind&&
      x.start===fields.start&&x.end===fields.end&&(fields.start||x.minutes===fields.minutes));
    const id=present(input.id)?label(input.id,"Идентификатор"):existing?.id||newId();
    replace(list,{...fields,id,manual:true});return sleepRows(state).find(r=>r.id===id);
  }
  function hiddenImports(state,date,kind){
    if(kind==="sleep"){
      const hidden=(state.health?.sleep||[]).filter(row=>row.hidden);
      if(!hidden.length)return [];
      const originals=externalSleep(state);
      return hidden.map(row=>originals.get(row.id)).filter(row=>row&&row.date===date);
    }
    return (state.health?.workouts||[]).filter(item=>item.hidden&&item.original&&diaryDayOf(item.original.start)===date)
      .map(item=>({...item.original,id:item.id,date}));
  }
  function revertSleep(state,id){const h=ensure(state);h.sleep=h.sleep.filter(r=>r.id!==id)}
  function removeSleep(state,id){
    if(externalSleep(state).has(id))replace(ensure(state).sleep,{id,hidden:true});
    else revertSleep(state,id);
  }
  function normalizeDaily(r,manual){
    if(!Object.hasOwn(units,r.metric))fail("Неизвестный суточный показатель.");
    const unit=r.unit??units[r.metric];
    if(unit!==units[r.metric])fail("Неверная единица для этого показателя.");
    const max={steps:300000,distance:1000,exercise:1440,active:30000,resting:15000,restingPulse:300}[r.metric];
    const value=number(r.value,"Значение",r.metric==="restingPulse"?1:0,max);
    if(r.metric==="steps"&&!Number.isInteger(value))fail("Шаги указываются целым числом.");
    return {metric:r.metric,date:eventDate(r.date),value,unit,source:label(r.source??"Вручную","Источник"),manual,
      complete:r.complete===true,receivedAt:r.receivedAt||new Date().toISOString(),...(r.entity?{entity:r.entity}:{})};
  }
  function saveDaily(state,input){
    if(input.complete===true&&input.date>=clock.diaryTime().slice(0,10))fail("Полноту можно подтвердить после окончания суток.");
    const row=normalizeDaily(input,true),h=ensure(state);
    (h.daily[row.date]||={})[row.metric]=row;return row;
  }
  function dailyRows(state,date,observations=state.healthImported?.daily||[]){
    const result={};
    for(const r of observations){
      if(r.date!==date)continue;
      try{
        const row=normalizeDaily(r,false),preferred=state.health?.settings?.dailySources?.[r.metric];
        if(preferred&&row.source!==preferred)continue;
        const prev=result[r.metric];
        if(!prev||Date.parse(row.receivedAt)>=Date.parse(prev.receivedAt))result[row.metric]=row;
      }catch{/* Unavailable readings do not replace the last dated measurement. */}
    }
    for(const [metric,row] of Object.entries(state.health?.daily?.[date]||{})){
      if(!Object.hasOwn(units,metric))continue;
      if(row.hidden)delete result[metric];else result[metric]=row;
    }
    return result;
  }
  function revertDaily(state,date,metric){
    if(!Object.hasOwn(units,metric))fail("Неизвестный показатель.");
    const group=state.health?.daily?.[calendar(date)];
    if(group){delete group[metric];if(!Object.keys(group).length)delete state.health.daily[date]}
  }
  function removeDaily(state,date,metric){
    const row=dailyRows(state,calendar(date))[metric];
    if(row?.manual||!row)revertDaily(state,date,metric);
    else (ensure(state).daily[date]||={})[metric]={hidden:true};
  }
  const conversion={
    kcal:{kcal:1,Cal:1,kJ:1/4.184},km:{km:1,m:0.001,mi:1.609344},bpm:{"count/min":1,bpm:1,"уд/мин":1}
  };
  function quantity(value,unit,target,name,max){
    if(!present(value))return undefined;
    const factors=conversion[target];
    if(!Object.hasOwn(factors,unit))fail("Несовместимая единица для «"+name+"».");
    return number(number(value,name)*factors[unit],name,0,max);
  }
  function sample(item,target,name,max){
    if(!present(item))return undefined;
    if(typeof item!=="object"||!present(item.qty))fail("Не задано измерение «"+name+"».");
    return quantity(item.qty,item.units,target,name,max);
  }
  function normalizeWorkout(r,manual){
    if(!r||typeof r!=="object")fail("Некорректная тренировка.");
    const bounds=interval(r,manual),type=label(r.type??r.name,"Вид тренировки");
    const result={type,start:bounds.start,end:bounds.end,date:diaryDayOf(bounds.start),
      durationMinutes:bounds.span,receivedAt:r.receivedAt||new Date().toISOString()};
    if(present(r.date)&&calendar(r.date)!==result.date)fail("Дата тренировки должна совпадать с началом.");
    const seconds=present(r.duration)?number(r.duration,"Длительность",0,bounds.span*60+1):undefined;
    const duration=r.durationMinutes??(seconds==null?bounds.span:seconds/60);
    result.durationMinutes=number(duration,"Минуты тренировки",1/60000,bounds.span+1/60);
    const source=typeof r.source==="object"&&r.source?r.source.name??r.source.identifier:r.source;
    result.source=label(source??(manual?"Вручную":"Health Auto Export"),"Источник");
    if(r.source?.identifier)result.sourceIdentifier=label(r.source.identifier,"Идентификатор источника");
    else if(present(r.sourceIdentifier))result.sourceIdentifier=label(r.sourceIdentifier,"Идентификатор источника");
    const externalId=r.eventId??r.externalId??(manual?null:r.id);
    if(present(externalId))result.eventId=label(externalId,"Идентификатор события");
    if(!manual&&!result.eventId)fail("Для повторяемого импорта нужен идентификатор события.");
    for(const [key,val] of [["activeKcal",sample(r.activeEnergyBurned,"kcal","Активная энергия",30000)??r.activeKcal],
      ["totalKcal",sample(r.totalEnergy,"kcal","Общая энергия",30000)??r.totalKcal],
      ["restingKcal",r.restingKcal]]){
      if(present(val))result[key]=number(val,"Энергия",0,30000);
    }
    if(present(r.energy)){
      if(!["active","total","resting"].includes(r.energyType))fail("Уточните вид энергии.");
      const energy=quantity(r.energy,r.energyUnit??"kcal","kcal","Энергия занятия",30000);
      result[r.energyType+"Kcal"]=energy;result.energyType=r.energyType;
    }
    if(!result.energyType)result.energyType=["active","total","resting"].find(k=>present(result[k+"Kcal"]));
    if(result.energyType){result.energy=result[result.energyType+"Kcal"];result.energyUnit="kcal"}
    const distance=sample(r.distance,"km","Дистанция",1000)??quantity(r.distanceKm,r.distanceUnit??"km","km","Дистанция",1000);
    if(distance!==undefined)result.distanceKm=distance;
    for(const [key,item,value] of [["avgPulse",r.avgHeartRate??r.heartRate?.avg,r.avgPulse],
      ["maxPulse",r.maxHeartRate??r.heartRate?.max,r.maxPulse]]){
      const pulse=sample(item,"bpm","Пульс",300)??quantity(value,r.pulseUnit??"bpm","bpm","Пульс",300);
      if(pulse!=null)result[key]=number(pulse,"Пульс",1,300);
    }
    if(result.avgPulse>result.maxPulse)fail("Средний пульс выше максимального.");
    return result;
  }
  function workoutType(type){
    const t=String(type||"strength").trim().toLowerCase();
    if(/strength|functional training|cross training|силов|тренаж|gym/.test(t))return "strength";
    if(/run|бег|treadmill|дорожк/.test(t))return "running";
    if(/walk|ходьб/.test(t))return "walking";
    if(/cycl|вело/.test(t))return "cycling";
    return t;
  }
  const gymKey=w=>w.id||w.startedAt||w.date;
  function effective(item){
    if(!item||item.hidden)return null;
    const original=item.original,override=item.override;
    const row={...(override??original),id:item.id,gymId:item.gymId??null,manual:!!override,imported:!!original};
    if(original&&override){
      row.eventId=original.eventId;
      if(original.sourceIdentifier)row.sourceIdentifier=original.sourceIdentifier;
      for(const type of ["active","total","resting"]){
        // An edited energy replaces its own kind. Keep separately measured alternatives.
        if(type!==original.energyType&&type!==override.energyType&&original[type+"Kcal"]!=null)
          row[type+"Kcal"]=original[type+"Kcal"];
      }
      if(item.manualBeforeImport){
        for(const key of ["distanceKm","avgPulse","maxPulse"])if(original[key]!=null)row[key]??=original[key];
      }
    }
    return row;
  }
  function compatible(w,g){
    if(!g||g.cancelled||g.canceled||["draft","cancelled","canceled","aborted"].includes(g.status)||
      workoutType(g.type??g.workoutType)!==workoutType(w.type))return false;
    const range=clock.workoutInterval(g);
    return +range.end>+range.start&&Date.parse(w.start)<+range.end&&Date.parse(w.end)>+range.start;
  }
  function workoutRows(state){
    const rows=(state.health?.workouts||[]).map(effective).filter(Boolean);
    const gym=new Map((state.workouts||[]).map(g=>[gymKey(g),g]));
    const strength=rows.filter(w=>workoutType(w.type)==="strength");
    for(const w of rows){
      if(Number.isFinite(Date.parse(w.start)))w.date=diaryDayOf(w.start);
      if(["running","walking"].includes(workoutType(w.type))){
        const inside=strength.find(p=>(p.sourceIdentifier??p.source)===(w.sourceIdentifier??w.source)&&
          Date.parse(p.start)<=Date.parse(w.start)&&Date.parse(p.end)>=Date.parse(w.end)&&
          Date.parse(p.end)-Date.parse(p.start)>Date.parse(w.end)-Date.parse(w.start));
        if(inside)w.parentWorkoutId=inside.id;
      }
      if(w.gymId&&(w.parentWorkoutId||!compatible(w,gym.get(w.gymId))))w.gymId=null;
    }
    return rows;
  }
  function saveWorkout(state,input){
    const fields=normalizeWorkout(input,true),list=ensure(state).workouts;
    let item=input.id?list.find(w=>w.id===input.id):null;
    if(!item&&!input.id){
      const matches=list.filter(w=>sameWorkout(w.override??w.original,fields));
      if(matches.length===1)item=matches[0];
    }
    if(!item){item={id:input.id?label(input.id,"Идентификатор"):newId()};list.push(item)}
    item.override=fields;delete item.hidden;delete item.manualBeforeImport;
    return effective(item);
  }
  function sameWorkout(a,b){
    return a&&workoutType(a.type)===workoutType(b.type)&&Math.abs(Date.parse(a.start)-Date.parse(b.start))<minute&&
      Math.abs(Date.parse(a.end)-Date.parse(b.end))<minute;
  }
  function importWorkouts(state,payload){
    const events=payloadRows(payload,"workouts").map(r=>normalizeWorkout(r,false));
    const items=ensure(state).workouts;
    const records=new Map(items.filter(w=>w.original).map(w=>[eventKey(w.original),w]));
    return events.map(fields=>{
      const key=eventKey(fields);
      let item=records.get(key);
      if(!item){
        const matches=items.filter(w=>!w.original&&sameWorkout(w.override,fields));
        if(matches.length===1){item=matches[0];item.manualBeforeImport=true}
      }
      if(!item){item={id:newId()};items.push(item)}
      item.original=fields;records.set(key,item);
      return effective(item);
    }).filter(Boolean);
  }
  function candidates(state,id){
    const w=workoutRows(state).find(r=>r.id===id);
    if(!w||w.parentWorkoutId)return [];
    return (state.workouts||[]).filter(g=>compatible(w,g));
  }
  function linkWorkout(state,id,gymId){
    const h=ensure(state),item=h.workouts.find(w=>w.id===id);
    if(!effective(item))fail("Тренировка не найдена.");
    if(gymId!=null){
      if(!candidates(state,id).some(g=>gymKey(g)===gymId))fail("Выберите совпадающую тренировку.");
      if(workoutRows(state).some(w=>w.id!==id&&w.gymId===gymId))fail("Сначала снимите существующую связь.");
    }
    item.gymId=gymId??null;return effective(item);
  }
  function removeWorkout(state,id){
    const h=ensure(state),item=h.workouts.find(w=>w.id===id);
    if(item?.original){item.hidden=true;delete item.gymId}
    else h.workouts=h.workouts.filter(w=>w.id!==id);
  }
  function revertWorkout(state,id){
    const item=state.health?.workouts?.find(w=>w.id===id);
    if(item?.original){delete item.override;delete item.hidden}
  }
  const bedStages=new Set(["inbed","in_bed","in bed","awake"]);
  const totalStages=new Set(["total","asleep","sleep","asleepunspecified"]);
  function sleepRank(row,preferred){
    return (row.manual?8:0)+(row.source===preferred?4:0)+(!row.stage||totalStages.has(row.stage)?2:0);
  }
  function sleepSummary(rows,preferred){
    const rank=(a,b)=>sleepRank(b,preferred)-sleepRank(a,preferred)||b.minutes-a.minutes||a.id.localeCompare(b.id);
    const measured=rows.filter(r=>!bedStages.has(r.stage)).sort(rank);
    const primary=measured.filter(r=>r.kind==="main");
    const covered=[];
    let minutes=0,main=null;
    for(const kind of ["main","nap"]){
      const available=measured.filter(r=>r.kind===kind);
      const group=preferred&&available.some(r=>r.source===preferred)?
        available.filter(r=>r.manual||r.source===preferred):available;
      if(!group.length)continue;
      const ranged=group.filter(r=>r.start);
      const simple=group.filter(r=>!r.start);
      const aggregate=simple[0],best=ranged[0],before=minutes;
      // A personally selected or corrected duration is authoritative over weaker sources.
      if(aggregate&&(!best||sleepRank(aggregate,preferred)>sleepRank(best,preferred))){
        minutes+=aggregate.minutes;
        if(kind==="main")main=aggregate;
        continue;
      }
      for(const row of ranged){
        const a=Date.parse(row.start),b=Date.parse(row.end);
        const awakes=[...(row.awakeIntervals||[]),...rows.filter(x=>x.source===row.source&&x.stage==="awake"&&x.start)];
        const awake=union(awakes.map(r=>[Math.max(a,Date.parse(r.start)),Math.min(b,Date.parse(r.end))]).filter(([x,y])=>x<y));
        const spans=subtract([[a,b]],awake),free=subtract(spans,covered);
        // With only a duration for wakes their exact position in the overlap is unknown.
        const unknownWake=Math.max(0,length(spans)-row.minutes);
        minutes+=Math.max(0,length(free)-unknownWake);
        covered.splice(0,covered.length,...union([...covered,[a,b]]));
      }
      if(aggregate&&sleepRank(aggregate,preferred)>=sleepRank(best,preferred)&&minutes-before<aggregate.minutes)minutes=before+aggregate.minutes;
      if(kind==="main"&&best){
        // Adjacent sleep stages together describe the main interval and its actual onset.
        const clusters=union(ranged.map(r=>[Date.parse(r.start),Date.parse(r.end)]));
        const cluster=clusters.find(([a,b])=>a<=Date.parse(best.start)&&b>=Date.parse(best.end));
        const inCluster=ranged.filter(r=>Date.parse(r.start)>=cluster[0]&&Date.parse(r.end)<=cluster[1]);
        main={...best,start:inCluster.find(r=>Date.parse(r.start)===cluster[0]).start,
          end:inCluster.find(r=>Date.parse(r.end)===cluster[1]).end,mealsComplete:inCluster.some(r=>r.mealsComplete)};
      }
    }
    return {sleepMinutes:measured.length?Math.min(1440,Math.round(minutes)):null,main,hasNight:primary.length>0};
  }
  function sleepReference(age){
    if(age==null||age===""||!Number.isFinite(Number(age))||age<0)return "Укажите возраст для справочного ориентира CDC.";
    if(age<4/12)return "14–17 часов";
    if(age<1)return "12–16 часов";
    if(age<3)return "11–14 часов";
    if(age<6)return "10–13 часов";
    if(age<13)return "9–12 часов";
    if(age<18)return "8–10 часов";
    if(age<=60)return "от 7 часов";
    return age<65?"7–9 часов":"7–8 часов";
  }
  function lowerBound(rows,time){
    let lo=0,hi=rows.length;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid].at<time)lo=mid+1;else hi=mid}
    return lo;
  }
  function pauseBeforeSleep(main,wakings,meals){
    if(!main?.mealsComplete||!main.start)return null;
    const start=Date.parse(main.start);
    let wake=start-1440*minute;
    for(let i=lowerBound(wakings,start)-1;i>=0&&wakings[i].at>wake;i--){
      if(wakings[i].date<main.date){wake=wakings[i].at;break}
    }
    let last=null,lastUnclassified=-Infinity;
    for(let i=lowerBound(meals,wake);i<meals.length&&meals[i].at<=start;i++){
      const m=meals[i];
      if(m.kind==="light")continue;
      if(!m.confirmed)return null;
      if(m.kind==="substantial")last=m.at;else lastUnclassified=m.at;
    }
    return last===null||lastUnclassified>last?null:(start-last)/minute;
  }
  function dayResult(date,episodes,settings,wakings,meals,daily,workouts){
    const {main,hasNight,sleepMinutes}=sleepSummary(episodes,settings.sleepSource);
    const pauseMinutes=pauseBeforeSleep(main,wakings,meals);
    const target=settings.sleepGoalMinutes??420,pauseTarget=settings.pauseGoalMinutes??120;
    const sleepPoints=settings.sleepBonus===true&&hasNight&&target>0&&sleepMinutes>=target?2:0;
    const mealPoints=settings.mealBonus===true&&pauseTarget>0&&pauseMinutes!==null&&pauseMinutes>=pauseTarget?1:0;
    return {date,episodes,sleepMinutes,mainStart:main?.start??null,mainEnd:main?.end??null,hasNight,
      pauseMinutes,sleepPoints,mealPoints,points:sleepPoints+mealPoints,daily,workouts};
  }
  function periodResult(dates,getDay,start,end){
    const daily={},trend=[];
    let sum=0,nights=0;
    for(const date of dates){
      if(date<start||date>end)continue;
      const d=getDay(date);
      if(d.hasNight){nights++;sum+=d.sleepMinutes}
      if(d.mainStart&&d.mainEnd)trend.push({date,start:d.mainStart,end:d.mainEnd,minutes:d.sleepMinutes});
      for(const [metric,row] of Object.entries(d.daily)){
        const stat=daily[metric]||={days:0,sum:0,average:null};
        stat.days++;stat.sum+=row.value;stat.average=stat.sum/stat.days;
      }
    }
    return {nights,averageSleep:nights?Math.round(sum/nights):null,trend,daily};
  }
  function latestTime(rows){
    return rows.filter(r=>r?.receivedAt&&Number.isFinite(Date.parse(r.receivedAt)))
      .sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt))[0]?.receivedAt??null;
  }
  function expenditureResult(daily,linked,past,base,entries=[]){
    const {active,resting}=daily;
    if(past&&active?.complete===true&&resting?.complete===true&&active.source&&active.source===resting.source){
      return {total:Math.round(active.value+resting.value),base:resting.value,active:active.value,method:"daily",
        coverage:"Полные сутки · "+active.source,receivedAt:latestTime([active,resting])};
    }
    const watches=[],observations=[active,resting];
    let added=0,allKnown=true;
    for(const entry of entries){
      const w=linked.get(gymKey(entry.workout));
      if(w?.activeKcal!=null){added+=w.activeKcal*(entry.fraction??1);watches.push(w)}
      else if(Number.isFinite(entry.active))added+=entry.active;
      else allKnown=false;
    }
    const method=watches.length?"workout":"profile";
    let coverage=watches.length?"Часы · связанные занятия":"Оценка по профилю";
    if(active||resting)coverage+=" · полные сутки не подтверждены";
    return {total:allKnown&&Number.isFinite(base)?Math.round(base+added):null,base,active:allKnown?Math.round(added):null,
      method,coverage,receivedAt:latestTime([...observations,...watches])};
  }
  function byDate(rows){
    const index=new Map();
    for(const row of rows){
      if(!index.has(row.date))index.set(row.date,[]);
      index.get(row.date).push(row);
    }
    return index;
  }
  // This projection belongs to a single report, never to a mutable profile's lifetime.
  function prepare(state){
    const sleep=sleepRows(state),workouts=workoutRows(state);
    const sleepDays=byDate(sleep),workoutDays=byDate(workouts),linked=new Map();
    for(const row of workouts)if(row.gymId!=null)linked.set(row.gymId,row);
    const sensorDays=byDate(state.healthImported?.daily||[]);
    const activeDays=new Map(),dayCache=new Map();
    for(const date of new Set([...sensorDays.keys(),...Object.keys(state.health?.daily||{})])){
      if(typeof date!=="string"||!/^\d{4}-\d\d-\d\d$/.test(date))continue;
      const values=dailyRows(state,date,sensorDays.get(date)||[]);
      if(Object.keys(values).length)activeDays.set(date,values);
    }
    const dateList=[...new Set([...activeDays.keys(),...sleepDays.keys(),...workoutDays.keys()])].sort();
    const settings={...state.health?.settings},today=clock.diaryTime().slice(0,10);
    const wakings=sleep.filter(r=>r.kind==="main"&&r.end&&!bedStages.has(r.stage))
      .map(r=>({at:Date.parse(r.end),date:r.date})).sort((a,b)=>a.at-b.at);
    const meals=sleep.some(r=>r.mealsComplete&&r.start)?(state.meals||[]).map(m=>{
      const confirmed=m.actualConfirmed===true&&present(m.actualEnd);
      return {kind:m.sleepMealKind,confirmed,at:+clock.diaryInstant(confirmed?m.actualEnd:m.date)};
    }).filter(m=>Number.isFinite(m.at)).sort((a,b)=>a.at-b.at):[];
    function readDay(date){
      if(!dayCache.has(date))dayCache.set(date,dayResult(date,sleepDays.get(date)||[],settings,wakings,meals,
        activeDays.get(date)||{},workoutDays.get(date)||[]));
      return dayCache.get(date);
    }
    return {dates:()=>[...dateList],day:readDay,period:(start,end)=>periodResult(dateList,readDay,start,end),
      expenditure:(date,base,entries)=>expenditureResult(activeDays.get(date)||{},linked,date<today,base,entries),
      linkedWorkout:w=>linked.get(gymKey(w))??null};
  }
  const dates=state=>prepare(state).dates();
  const day=(state,date)=>prepare(state).day(date);
  const period=(state,start,end)=>prepare(state).period(start,end);
  const expenditure=(state,date,base,entries)=>prepare(state).expenditure(date,base,entries);
  const linkedWorkout=(state,w)=>prepare(state).linkedWorkout(w);
  return {ensure,saveSleep,removeSleep,revertSleep,saveDaily,removeDaily,revertDaily,saveWorkout,removeWorkout,
    revertWorkout,importWorkouts,importSleep,hiddenImports,candidates,linkWorkout,linkedWorkout,gymKey,day,period,dates,expenditure,sleepReference,prepare};
})();
if(typeof module!=="undefined")module.exports=SportHealth;
