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
  const goal=lane?"Запиши подходы одного упражнения в двух занятиях недели":"Отметь питание за семь дней недели";
  const goalState=lane?(w.repeat?"Выполнено · +5":"Тренировочных дней на этой неделе · "+w.gym):(w.food===7?"Выполнено · +15":w.food+" из 7 дней");
  const badges=r.achievements.map(([label,day])=>'<li><b>'+esc(label)+'</b><small>'+esc(dayLabel(day))+'</small></li>').join("");
  return '<section class="rewardBanner"><span>Уровень '+(1+Math.floor(r.points/100))+'</span><strong>'+numberRu(r.points)+' баллов</strong>'+
    '<progress aria-label="До следующего уровня" max="100" value="'+(r.points%100)+'"></progress><small>Ещё '+(100-r.points%100)+' до следующего уровня</small></section>'+
    '<p><b>'+esc(tracks[reportName()])+'</b><br>'+esc(goal)+' · '+esc(goalState)+'</p>'+
    '<p class="muted">За неделю с '+shortDay(monday(selectedDay))+': питание '+w.food+'/7, тренировки и отмеченные дни отдыха '+w.activity+'/7. Ещё 20 баллов за 7 дней питания и 2 тренировочных дня, либо за 1 тренировочный день и 6 отмеченных дней отдыха.</p>'+
    disclosure("badges","Мои достижения · "+r.achievements.length,badges?'<ul class="earned">'+badges+'</ul>':'<p>Первое достижение откроется после записи тренировки или полной недели питания.</p>')+
    disclosure("ledger","Начисления за период · "+r.periodPoints, r.periodPoints?reportTable(["Дата","За что","Баллы"],r.rows.slice().reverse().flatMap(d=>d.awards.map(a=>[shortDay(d.day),a.label,"+"+a.value]))):'<p>Пока нет начислений.</p>');
}
function energyBody(r){
  const missing=r.elapsed-r.balances.length,day=r.rows.find(d=>d.day===r.end);
  let msg=r.balance===null?"Пока нет дней, для которых можно оценить баланс.":'Оценка за '+r.balances.length+' дн. из '+r.elapsed+'.';
  if(missing>0)msg+=" Для остальных нужны заполненный день питания, калорийность каждой порции и данные для оценки расхода.";
  if(day?.energyMode==="auto"&&day.base==null)msg+=" Для авторасчёта нужны рост, пол, возраст от 19 лет и вес, известный на выбранную дату.";
  return (day?reportMetrics([["Расход на "+shortDay(day.day),day.maintenance==null?"—":"≈ "+numberRu(day.maintenance)+" ккал"],
    [day.energyMode==="manual"?"Введено за сутки":"Обычный день",day.base==null?"—":numberRu(day.base)+" ккал"],
    ["Добавка за зал",day.active==null?"—":"+"+numberRu(day.active)+" ккал"]]):"")+
    reportMetrics([["Сумма дефицита",r.balance==null?"—":numberRu(r.deficit)+" ккал"],["Сумма профицита",r.balance==null?"—":numberRu(r.surplus)+" ккал"],["Съедено по известным порциям",r.meals>r.unknown?numberRu(r.kcal)+" ккал":"—"],["Средний баланс в учтённый день",r.balance==null?"—":signed(Math.round(r.balance/r.balances.length))+" ккал"]])+
    '<p>'+esc(msg)+'</p><p class="muted">Баланс = записанное питание − оценка полного суточного расхода. Авторасчёт складывает обычный день и дополнительные калории записанных занятий. Ручное значение задаёт полный расход.</p>'+
    graph(r.balances.map(d=>[d.day,d.balance]),"Баланс по заполненным дням","ккал")+
    (r.rows.length?disclosure("food-history","Расход и питание по дням",reportTable(["Дата","Съедено, ккал","Расход, ккал","Баланс"],r.rows.map(d=>[shortDay(d.day),!d.meals?"—":d.unknown?"неполные КБЖУ":numberRu(d.kcal),d.maintenance??"—",d.balance==null?"—":signed(d.balance)]))):"");
}
function nutritionEnergySummary(){
  const r=diaryReport(state,scale,boundScale(),selectedDay,"day"),d=r.rows[0];
  const balance=d?.balance;
  const status=balance==null?"Пока нет оценки":balance<0?"Дефицит "+numberRu(-balance)+" ккал":balance>0?"Профицит "+numberRu(balance)+" ккал":"0 ккал";
  let hint="";
  if(d&&balance==null){
    if(!d.complete)hint+=" Отметь заполненный день питания.";
    if(d.unknown)hint+=" Для части порций неизвестна калорийность.";
    if(d.maintenance==null)hint+=" Для оценки расхода проверь данные профиля или укажи расход вручную.";
  }
  return reportMetrics([["Расход за сутки",d?.maintenance==null?"—":"≈ "+numberRu(d.maintenance)+" ккал"],["Баланс дня",status]])+
    (hint?'<p class="muted">'+esc(hint.trim())+'</p>':"");
}
function intakeBody(r){
  const n=r.nutrition,d=r.doses;
  const amount=(value,missing,unit)=>missing?(value?doseNumber(value)+" "+unit+" + неизвестно":"Неизвестно"):doseNumber(value)+" "+unit;
  const macros=["Калории","Белки всего","Жиры","Углеводы"].map((label,i)=>[label,n.count?amount(n.known[i],n.missing[i],i===0?"ккал":"г"):"—"]);
  return reportMetrics(macros)+reportMetrics([
    ["Креатин",amount(d.creatineGrams,d.creatineUnknown,"г")],
    ["Белок из протеина",amount(d.proteinGrams,d.proteinUnknown,"г")],
    ["Порции креатина",amount(d.creatineServings,d.creatineUnknown,"порц.")],
    ["Порции протеина",amount(d.proteinServings,d.proteinUnknown,"саше")],
    ["Порошок протеина",amount(d.powderGrams,d.powderUnknown,"г")]])+
    (d.proteinUnknown||d.creatineUnknown?'<p class="muted">Есть отметки без количества. Укажи принятые порции в календаре за эти дни.</p>':"");
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
function resultsPage(){
  const r=diaryReport(state,scale,boundScale(),selectedDay,reportPeriod);
  const delta=r.weights.length>=2?r.weights.at(-1).kg-r.weights[0].kg:null;
  const history=r.rows.length?state.workouts.filter(w=>w.date.slice(0,10)>=r.start&&w.date.slice(0,10)<=r.end).sort((a,b)=>b.date.localeCompare(a.date)):[];
  const tabs=Object.entries(reportPeriods).map(([id,name])=>'<button type="button" data-action="period-'+id+'" aria-pressed="'+(id===reportPeriod)+'">'+name+'</button>').join("");
  const kilograms=r.latest?numberRu(r.latest.kg)+" кг":"—";
  const weightInfo=r.latest?'Последнее взвешивание '+dayLabel(r.latest.day)+' · '+(r.latest.source==="ha"?"весы HA":"дневник"):'Пока нет записей веса.';
  return '<article class="reportHead"><div class="reportTitle"><h2>Мои итоги</h2>'+btn("settings","Настройки профиля")+'</div><div class="periodPick" aria-label="Период итогов">'+tabs+'</div>'+
    '<p>'+esc(r.elapsed?r.start===r.end?dayLabel(r.end):shortDay(r.start)+' — '+dayLabel(r.end):'Период ещё не начался')+'</p>'+
    reportMetrics([["Вес на дату",kilograms],["Тренировки",r.workouts],["Дней питания заполнено",r.foodDays+" / "+r.elapsed],["Баллы за период","+"+r.periodPoints]])+'</article>'+
    '<article class="reportList"><h2>Динамика</h2>'+disclosure("body-weight","Вес тела · "+(delta==null?kilograms:signed(delta)+" кг"),'<p>'+esc(weightInfo)+'</p>'+
      graph(r.weights.map(w=>[w.day,w.kg]),"Последнее измерение каждого дня","кг")+
      (r.weights.length?disclosure("weighings","Точные значения",reportTable(["Дата","Вес, кг","Источник"],r.weights.map(w=>[dayLabel(w.day),numberRu(w.kg),w.source==="ha"?"Весы HA":"Дневник"]))):""))+
    disclosure("exercises","Тренировки и упражнения · "+r.sets+" подх.",reportMetrics([["Время",r.minutes+" мин"],["Повторы",r.reps],["Сумма вес × повторы",numberRu(r.volume)+" кг"]])+exerciseBody(r))+
    disclosure("intake","Питание и добавки за период",intakeBody(r))+
    disclosure("energy","Баланс энергии · "+(r.balance==null?"нет оценки":"≈ "+signed(r.balance)+" ккал"),energyBody(r))+'</article>'+
    card("Баллы и достижения",rewardBody(r))+
    disclosure("workouts-list","История тренировок · "+history.length,history.map(w=>btn("history-"+esc(w.id),esc(w.date.replace("T"," ")))).join("")||"<p>В этом периоде занятий нет.</p>");
}
function dailyRecap(){
  const r=diaryReport(state,scale,boundScale(),selectedDay,"day"),d=r.rows[0];
  const rest=state.restLog?.[selectedDay];
  return card("Итог дня",reportMetrics([["Питание",d?.meals?(d.complete?"Заполнено":d.meals+" порц."):"—"],["Тренировка",r.workouts?(r.sets?r.sets+" подх.":"Записано"):rest?"Отдых":"—"],["Расход за сутки",d?.maintenance!=null?"≈ "+numberRu(d.maintenance)+" ккал":"—"],["Баллы","+"+r.periodPoints]])+
    btn("report-day","Посмотреть итог")+(!r.workouts&&selectedDay<=local().slice(0,10)?btn("rest-log",rest?"Снять отметку отдыха":"Отметить день отдыха"):""));
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
