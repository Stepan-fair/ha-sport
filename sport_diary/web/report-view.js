"use strict";
let reportPeriod="week", reportExercise="";
const reportPeriods={day:"День",week:"Неделя",month:"Месяц",year:"Год"};
const tracks={strength:"Прогресс в упражнениях",rhythm:"Ритм дневника"};
const numberRu=n=>Number(n).toLocaleString("ru-RU",{maximumFractionDigits:1});
const doseNumber=n=>Number(n).toLocaleString("ru-RU",{maximumFractionDigits:4});
const signed=n=>(n>0?"+":"")+numberRu(n);
const shortDay=d=>d.slice(8,10)+"."+d.slice(5,7);
const disclosure=(id,label,body)=>'<details class="reportDetail" data-disclosure="'+id+'"><summary>'+esc(label)+'</summary><div>'+body+'</div></details>';
function reportMetrics(values){
  return '<div class="reportMetrics">'+values.map(([label,value])=>'<div><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong></div>').join("")+'</div>';
}
function reportTable(head,rows){
  return '<div class="reportScroll"><table><thead><tr>'+head.map(h=>'<th scope="col">'+esc(h)+'</th>').join("")+'</tr></thead><tbody>'+
    rows.map(row=>'<tr>'+row.map(v=>'<td>'+esc(v)+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>';
}
function graph(points,label,unit){
  if(!points.length)return '<p class="muted">За этот период записей нет.</p>';
  const xs=points.map(p=>Date.parse(p[0]+"T12:00Z")),ys=points.map(p=>p[1]);
  const min=Math.min(...ys),max=Math.max(...ys),lo=unit==="ккал"?Math.min(min,0):min,hi=unit==="ккал"?Math.max(max,0):max;
  const x=i=>xs.length===1?160:12+296*(xs[i]-xs[0])/(xs.at(-1)-xs[0]||1);
  const y=v=>hi===lo?38:64-52*(v-lo)/(hi-lo);
  const path=points.map((p,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(p[1]).toFixed(1)).join(" ");
  const line=unit==="ккал"?'<path class="graphZero" d="M8 '+y(0)+'H312"/>':"";
  return '<figure class="reportGraph"><figcaption>'+esc(label)+' <small>от '+numberRu(min)+' до '+numberRu(max)+' '+unit+'</small></figcaption>'+
    '<svg aria-hidden="true" viewBox="0 0 320 76" preserveAspectRatio="none">'+line+'<path d="'+path+'"/>'+
    points.map((p,i)=>'<circle cx="'+x(i).toFixed(1)+'" cy="'+y(p[1]).toFixed(1)+'" r="'+(points.length>60?1.1:2.7)+'"/>').join("")+'</svg>'+
    '<div class="graphAxis"><span>'+shortDay(points[0][0])+'</span><span>'+numberRu(ys.at(-1))+' '+unit+' · '+shortDay(points.at(-1)[0])+'</span></div></figure>';
}
function reportName(){return Object.hasOwn(tracks,state.profile.rewardTrack)?state.profile.rewardTrack:(who==="person1"?"strength":"rhythm")}
function rewardBody(r){
  const lane=reportName()==="strength",w=r.week;
  const goal=lane?"Запиши подходы одного упражнения в двух занятиях недели":"Запиши питание за семь дней недели";
  const goalState=lane?(w.repeat?"Выполнено · +5":"Тренировочных дней на этой неделе · "+w.gym):(w.food===7?"Выполнено · +15":w.food+" из 7 дней");
  const badges=r.achievements.map(([label,day])=>'<li><b>'+esc(label)+'</b><small>'+esc(dayLabel(day))+'</small></li>').join("");
  return '<section class="rewardBanner"><span>Уровень '+(1+Math.floor(r.points/100))+'</span><strong>'+numberRu(r.points)+' баллов</strong>'+
    '<progress aria-label="До следующего уровня" max="100" value="'+(r.points%100)+'"></progress><small>Ещё '+(100-r.points%100)+' до следующего уровня</small></section>'+
    '<p><b>'+esc(tracks[reportName()])+'</b><br>'+esc(goal)+' · '+esc(goalState)+'</p>'+
    '<p class="muted">За неделю с '+shortDay(monday(selectedDay))+': питание '+w.food+'/7, дни с тренировкой или отдыхом '+w.activity+'/7. Ещё 20 баллов за 7 дней питания и 2 тренировочных дня, либо за 1 тренировочный день и 6 дней отдыха.</p>'+
    reportMetrics([["Серия дней с питанием",r.foodStreak.current],["Самая длинная серия",r.foodStreak.longest]])+
    disclosure("badges","Мои достижения · "+r.achievements.length,badges?'<ul class="earned">'+badges+'</ul>':'<p>Первое достижение откроется после записи тренировки или полной недели питания.</p>')+
    disclosure("ledger","Начисления за период · "+r.periodPoints, r.periodPoints?reportTable(["Дата","За что","Баллы"],r.rows.slice().reverse().flatMap(d=>d.awards.map(a=>[shortDay(d.day),a.label,"+"+a.value]))):'<p>Пока нет начислений.</p>');
}
function energyMethodLabel(row){
  if(row.energyMethod==="daily")return "Суточные измерения";
  if(row.energyMethod==="workout")return "Профиль и активные ккал занятия";
  return row.energyMode==="manual"?"Введено вручную":row.energyMode==="off"?"Отключено":"Оценка по профилю";
}
function energyBody(r){
  const day=r.rows.find(d=>d.day===r.end),known=r.knownBalances,partial=r.partialBalances;
  const partialSum=partial.reduce((sum,d)=>sum+d.balance,0);
  const history=r.rows.map(d=>[shortDay(d.day),d.meals>d.unknown?numberRu(d.kcal):"—",d.maintenance??"—",
    d.balance==null?"—":signed(d.balance),d.unknown?"Уточнить калорийность: "+d.unknown+" порц.":d.meals?"Все записанные порции учтены":"Нет еды"]);
  return (day?reportMetrics([["Расход на "+shortDay(day.day),day.maintenance==null?"—":"≈ "+numberRu(day.maintenance)+" ккал"],
    ["Источник расхода",energyMethodLabel(day)],
    [day.energyMode==="manual"?"Введено за сутки":day.energyMethod==="daily"?"Энергия покоя":"Обычный день",day.base==null?"—":numberRu(day.base)+" ккал"],
    [day.energyMethod==="daily"?"Активные ккал за сутки":"Добавка за зал",day.active==null?"—":"+"+numberRu(day.active)+" ккал"]]):"")+
    (day?.energyCoverage&&(day.energyReceivedAt||day.energyMethod!=="profile")?'<p class="muted">'+esc(day.energyCoverage)+'</p>':"")+
    (day?.energyReceivedAt?'<p class="muted">Последнее обновление · '+esc(diaryTime(new Date(day.energyReceivedAt)).replace("T"," "))+'</p>':"")+
    '<p>Баланс по внесённому на данный момент = записанные калории − оценка расхода за полные сутки.</p>'+
    reportMetrics([["Дефицит за дни с известной калорийностью",known.length?numberRu(r.deficit)+" ккал":"—"],
      ["Профицит за такие дни",known.length?numberRu(r.surplus)+" ккал":"—"],
      ["Съедено по известным порциям",r.meals>r.unknown?numberRu(r.kcal)+" ккал":"—"]])+
    (partial.length?'<p>Предварительный баланс за '+partial.length+' дн. с частичной калорийностью: '+signed(partialSum)+' ккал. Эти дни показаны отдельно от сумм дефицита и профицита.</p>':"")+
    (day?.energyMode==="auto"&&day.base==null?'<p>Для оценки расхода нужны рост, пол, возраст от 19 лет и вес на выбранную дату.</p>':"")+
    graph(known.map(d=>[d.day,d.balance]),"Баланс по внесённым порциям с известной калорийностью","ккал")+
    (r.rows.length?disclosure("food-history","Расход и питание по дням",reportTable(["Дата","Съедено, ккал","Расход, ккал","Баланс","Питание"],history)):"");
}
function nutritionEnergySummary(){
  const r=diaryReport(reportState(),scale,boundScale(),selectedDay,"day"),d=r.rows[0];
  const hint=[];
  if(!d?.foodCount)hint.push(d?.meals?"Есть отметка добавки. Приёмы еды пока не внесены.":"Пока нет записей питания.");
  if(d?.unknown)hint.push("Уточни калорийность "+d.unknown+" порц. Учтены известные калории.");
  if(d&&d.maintenance==null)hint.push("Для оценки расхода проверь профиль или укажи расход вручную.");
  if(d?.maintenance!=null)hint.push("Расход · "+energyMethodLabel(d)+(d.energyCoverage?.includes("не подтверждены")?" · данные часов за день неполные.":"."));
  return reportMetrics([["Съедено по известным порциям",d&&d.meals>d.unknown?numberRu(d.kcal)+" ккал":"—"],
    ["Расход за сутки",d?.maintenance==null?"—":"≈ "+numberRu(d.maintenance)+" ккал"],
    [d?.partialCalories?"Предварительный баланс":"Баланс по внесённому",d?.balance==null?"—":signed(d.balance)+" ккал"]])+
    (hint.length?'<p class="muted">'+esc(hint.join(" "))+'</p>':"");
}
function intakeBody(r){
  const n=r.nutrition,d=r.doses;
  const issues=r.rows.flatMap(row=>row.nutrition?.issues||[]);
  function metric(label,value,known,unknown,unit){
    const text=known?doseNumber(value)+" "+unit:unknown?"Нет значения":"—";
    const rows=issues.filter(row=>row.fields.includes(label));
    const form=new Intl.PluralRules("ru").select(rows.length);
    const refine=rows.length?'<details><summary>Уточнить '+rows.length+' '+({one:"запись",few:"записи",many:"записей"}[form]||"записи")+'</summary>'+rows.map(row=>{
      const action=row.kind==="meal"?"refine-meal-"+encodeURIComponent(row.id):"refine-dose-"+row.index+"-"+encodeURIComponent(row.label);
      return '<p>'+btn(esc(action),esc(dayLabel(row.date.slice(0,10))+" · "+(row.date.slice(11,16)||row.period||"")+" · "+row.label))+
        '<br><small>'+esc(label)+'</small></p>';
    }).join("")+'</details>':"";
    return '<div><small>'+esc(label)+'</small><strong>'+esc(text)+'</strong>'+refine+'</div>';
  }
  const macros=intakeLabels.map((label,i)=>metric(label,n.known[i],n.knownCount[i],n.missing[i],i===0?"ккал":"г"));
  const ended=r.elapsed>0&&r.end<r.today;
  const doses=doseMetrics.map(([key,prefix,label,unit])=>metric(label,d[key],d[prefix+"Known"]||(ended&&!d[prefix+"Unknown"]),d[prefix+"Unknown"],unit));
  return reportMetrics([["Дней с записью еды",r.foodDays],["Из них с известным белком всех внесённых порций",r.loggedProteinDays]])+
    '<div class="reportMetrics">'+macros.join("")+doses.join("")+'</div>'+legacyDoseSelection(issues);
}
function legacyDoseSelection(issues){
  const choices=issues.filter(row=>row.kind==="dose"&&state.supps[row.index]?.servings==null&&row.fields.some(f=>f.startsWith("Порции")));
  if(choices.length<2)return "";
  return disclosure("legacy-quantities","Указать количество для нескольких отметок",
    '<p>Выбери отметки, для которых известно одинаковое число порций. Даты указаны рядом с каждой добавкой.</p>'+
    choices.map(row=>check(dayLabel(row.date.slice(0,10))+" · "+row.period+" · "+row.label,'name="legacy-quantity" data-index="'+row.index+'" value="'+esc(row.label)+'"')).join("")+
    decimalField("legacy-servings","Порций в каждой выбранной отметке","")+btn("confirm-legacy-servings","Применить к выбранным датам"));
}
function exerciseBody(r){
  if(!r.exerciseNames.length)return '<p>Пока нет выполненных подходов за выбранный период.</p>';
  const name=r.exerciseNames.includes(reportExercise)?reportExercise:r.exerciseNames[0];
  const records=r.rows.map(d=>d.exercises.get(name)).filter(Boolean);
  return '<label>Упражнение и тренажёр<select id="report-exercise">'+options(r.exerciseNames,name)+'</select></label>'+
    graph(records.map(v=>[v.day,v.kg]),"Наибольший записанный вес за день","кг")+
    graph(records.map(v=>[v.day,v.sets]),"Рабочие подходы за день","подх.")+
    disclosure("set-history","Вес и повторы рабочих подходов",reportTable(["Дата","Подходы","Кг × повторы"],records.map(v=>[shortDay(v.day),v.sets,v.lines.join(" · ")])));
}
function healthPeriodBody(r){
  const h=r.health;
  if(!h.nights&&!Object.values(h.daily).some(m=>m.days))return "";
  const rows=[],labels={steps:["Шаги","шаг."],distance:["Ходьба и бег","км"],exercise:["Упражнения","мин"],
    active:["Активная энергия","ккал"],resting:["Энергия покоя","ккал"],restingPulse:["Пульс покоя","уд/мин"]};
  for(const [key,[label,unit]] of Object.entries(labels)){
    const m=h.daily[key];
    if(m?.days)rows.push([label,numberRu(m.average)+" "+unit,m.days+" из "+r.elapsed]);
  }
  const sleep=h.nights?reportMetrics([["Среднее за ночь",numberRu(h.averageSleep/60)+" ч"],["Ночей с данными",h.nights+" из "+r.elapsed]])+
    graph(r.rows.filter(d=>d.health?.hasNight).map(d=>[d.day,d.health.sleepMinutes/60]),"Сон по датам пробуждения","ч")+
    (h.trend.length?reportTable(["Пробуждение","Начало основного сна","Конец","Сон, ч"],h.trend.map(n=>[shortDay(n.date),diaryTime(new Date(n.start)).slice(11,16),diaryTime(new Date(n.end)).slice(11,16),numberRu(n.minutes/60)])):""):"";
  return disclosure("health-period","Сон и повседневная активность",sleep+
    (rows.length?reportTable(["Показатель","Среднее за день","Дней с данными"],rows):""));
}
function resultsPage(){
  const r=diaryReport(reportState(),scale,boundScale(),selectedDay,reportPeriod);
  const delta=r.weights.length>=2?r.weights.at(-1).kg-r.weights[0].kg:null;
  const history=[...new Set(r.rows.flatMap(d=>d.sessions.map(part=>part.workout)))].sort((a,b)=>b.date.localeCompare(a.date));
  const tabs=Object.entries(reportPeriods).map(([id,name])=>'<button type="button" data-action="period-'+id+'" aria-pressed="'+(id===reportPeriod)+'">'+name+'</button>').join("");
  const kilograms=r.latest?numberRu(r.latest.kg)+" кг":"—";
  const weightSource=w=>w.timeBasis==="legacy"?"Архив весов HA · время обновления":w.source==="ha"?"Весы HA":"Дневник";
  const weightInfo=r.latest?dayLabel(r.latest.day)+' · '+weightSource(r.latest):'Пока нет записей веса.';
  return '<article class="reportHead"><div class="reportTitle"><h2>Мои итоги</h2>'+btn("settings","Настройки профиля")+'</div><div class="periodPick" aria-label="Период итогов">'+tabs+'</div>'+
    '<p>'+esc(r.elapsed?r.start===r.end?dayLabel(r.end):shortDay(r.start)+' — '+dayLabel(r.end):'Период ещё не начался')+'</p>'+
    reportMetrics([["Вес на дату",kilograms],["Начато занятий",r.workouts],["Дней с записью питания",r.foodDays+" / "+r.elapsed],["Баллы за период","+"+r.periodPoints]])+'</article>'+
    '<article class="reportList"><h2>Динамика</h2>'+disclosure("body-weight","Вес тела · "+(delta==null?kilograms:signed(delta)+" кг"),'<p>'+esc(weightInfo)+'</p>'+
      graph(r.weights.map(w=>[w.day,w.kg]),"Последнее измерение каждого дня","кг")+
      (r.weights.length?disclosure("weighings","Точные значения",reportTable(["Дата","Вес, кг","Источник"],r.weights.map(w=>[dayLabel(w.day),numberRu(w.kg),weightSource(w)]))):""))+
    disclosure("exercises","Тренировки и упражнения · "+r.sets+" подх.",reportMetrics([["Время",r.minutes+" мин"],["Повторы",r.reps],["Сумма вес × повторы",numberRu(r.volume)+" кг"]])+exerciseBody(r))+
    disclosure("intake","Питание и добавки за период",intakeBody(r)+SportGoalsView.report(r.nutritionGoals,reportPeriod))+
    healthPeriodBody(r)+
    disclosure("energy","Баланс энергии по внесённому · "+(r.balance==null?"нет оценки":(r.partialBalances.length?"предварительно ":"≈ ")+signed(r.balance)+" ккал"),energyBody(r))+'</article>'+
    card("Баллы и достижения",rewardBody(r))+
    disclosure("workouts-list","История тренировок · "+history.length,history.map(w=>btn("history-"+esc(w.id),esc(w.date.replace("T"," ")))).join("")||"<p>В этом периоде занятий нет.</p>");
}
function dailyRecap(){
  const r=diaryReport(reportState(),scale,boundScale(),selectedDay,"day"),d=r.rows[0];
  const status=d?.trainingStatus||("По плану · "+trainingSlot(state,draft,selectedDay));
  return card("Итог дня",reportMetrics([["Питание",d?.foodCount?d.foodCount+" порц.":"—"],["Тренировка",status],["Расход за сутки",d?.maintenance!=null?"≈ "+numberRu(d.maintenance)+" ккал":"—"],["Баланс по внесённому",d?.balance==null?"—":signed(d.balance)+" ккал"+(d.partialCalories?" (частично)":"")],["Баллы","+"+r.periodPoints]])+
    btn("report-day","Посмотреть итог"))+SportGoalsView.today(r.nutritionGoals);
}
function activeEnergyRule(){
  return Object.entries(state.energyRules||{}).filter(([day])=>day<=selectedDay).sort(([a],[b])=>b.localeCompare(a))[0]?.[1]||null;
}
function reportSettings(){
  const rule=autoEnergyRule(state.profile,activeEnergyRule());
  const fieldSelect=(id,title,values,value)=>'<label>'+title+'<select id="'+id+'">'+Object.entries(values).map(([k,v])=>'<option value="'+k+'" '+(k===String(value)?"selected":"")+'>'+esc(v)+'</option>').join("")+'</select></label>';
  return card("Личная мотивация",fieldSelect("reward-track","Что показывать первым",tracks,reportName())+'<p class="muted">Оба вида достижений доступны всегда. У каждого профиля свой счёт.</p>'+btn("save-track","Сохранить выбор",true))+
    card("Оценка расхода энергии",'<p>Настройка действует с '+esc(dayLabel(selectedDay))+'. Для прошлых записей выбери дату начала в календаре.</p>'+
    fieldSelect("energy-mode","Суточный расход",{auto:"Автоматически по профилю и тренировкам",manual:"Указать полный расход",off:"Не оценивать"},rule.mode)+
    '<div id="energy-auto" '+(rule.mode==="auto"?"":"hidden")+'>'+fieldSelect("energy-factor","Обычная активность вне зала",{"1.2":"1,2 · преимущественно сидя","1.4":"1,4 · небольшая активность","1.6":"1,6 · умеренная активность","1.8":"1,8 · высокая активность"},rule.factor||1.2)+'<p class="muted">По умолчанию берём малоподвижный день и последний известный вес на дату. Учитываем длительность силовой части с выполненными подходами и интервалы дорожки. Коэффициент можно уточнить под работу и ходьбу.</p></div>'+
    '<div id="energy-manual" '+(rule.mode==="manual"?"":"hidden")+'>'+field("daily-maint","Полный расход за сутки, ккал","number",rule.kcal??"",'min="1" step="1"')+'</div>'+btn("save-energy","Сохранить расход",true));
}
