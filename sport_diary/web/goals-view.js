"use strict";

const SportGoalsView = (() => {
  const model=typeof module==="undefined"?SportGoals:require("./goals");
  const visibility=typeof module==="undefined"?SportVisibility:require("./visibility");
  const enabled=(state,name)=>!state||visibility.supplement(state,name);
  const substanceLabels={powder:"Порошок продукта",monohydrate:"Моногидрат креатина",active:"Креатин (вещество)",legacy:"Вещество старой цели не уточнено"};
  const num=new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1});
  const fmt=n=>num.format(n);
  const html=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const date=d=>d.split("-").reverse().join(".");
  const checked=on=>on?" checked":"";
  const article=(title,body)=>"<article><h2>"+html(title)+"</h2>"+body+"</article>";
  const grams=(id,label,value)=>'<label>'+label+'<input type="number" min="0.01" step="any" id="'+id+'" value="'+html(value)+'"></label>';
  function settings(state, day) {
    const p=model.proteinRule(state,day),c=model.creatineRule(state,day);
    const modes={fact:"Только учёт",auto:"Автоматически",manual:"Моя цель в г/сут"};
    const options=Object.entries(modes).map(([key,label])=>'<option value="'+key+'"'+(key===p.mode?" selected":"")+'>'+label+'</option>').join("");
    const since='<p>Изменения действуют с '+html(date(day))+'. Для другой даты выбери день в календаре.</p>';
    const history=(rules,describe)=>Object.keys(rules||{}).length?'<details><summary>История настроек</summary>'+Object.entries(rules).sort(([a],[b])=>b.localeCompare(a)).map(([d,r])=>'<p>'+html(date(d)+' · '+describe(r))+'</p>').join("")+'</details>':"";
    return article("Цель общего белка",since+'<label>Режим<select id="protein-mode">'+options+'</select></label>'+
      '<div id="protein-manual">'+grams("protein-goal","Белок за день, г",p.grams)+'</div>'+
      '<div id="protein-auto"><label class="check"><input id="regular-strength" type="checkbox"'+checked(p.regular)+'>Регулярно занимаюсь силовыми тренировками</label>'+
      '<p>Автоориентир для здоровых взрослых с силовыми занятиями — 1,6 г/кг в сутки, включая дни отдыха. Для общей формы, выносливости и снижения веса подтверди характер занятий. При беременности или медицинских ограничениях выбери учёт факта или личную согласованную цель.</p>'+
      '<p>Справочный диапазон для тренирующихся взрослых — 1,4–2,0 г/кг. <a href="https://pubmed.ncbi.nlm.nih.gov/28642676/" target="_blank" rel="noopener noreferrer">Позиция ISSN</a></p></div>'+
      '<button class="primary" data-action="save-protein-goal">Сохранить цель белка</button>'+history(state.proteinGoals,r=>r.mode==="manual"?fmt(r.grams)+" г/сут":modes[r.mode]))+
      (enabled(state,"Креатин")?article("Личный план креатина",since+'<label class="check"><input id="creatine-plan" type="checkbox"'+checked(c.enabled)+'>Включить ежедневный план</label>'+
      '<div id="creatine-target">'+grams("creatine-goal","Моя цель в сутки, г",c.grams??3)+'</div>'+
      '<label>Что измеряет моя цель<select id="creatine-substance">'+Object.entries(substanceLabels).map(([key,label])=>'<option value="'+key+'"'+(key===(c.substance||"legacy")?' selected':'')+'>'+label+'</option>').join("")+'</select></label>'+
      grams("creatine-size","Масса в старых отметках без продукта, г",c.serving??3)+
      '<p>Новый продукт хранит отдельно массу порошка, моногидрата и креатина. Старые записи без вида вещества не преобразуются автоматически и не сравниваются с новой целью. План действует и в дни отдыха.</p>'+
      '<button class="primary" data-action="save-creatine-goal">Сохранить план и размер порции</button>'+
      history(state.creatineGoals,r=>(r.enabled?fmt(r.grams)+" г/сут":"План выключен")+" · порция "+fmt(r.serving)+" г")):"");
  }
  function sync() {
    const el=id=>document.getElementById(id);
    if(el("protein-mode")){
      el("protein-auto").hidden=el("protein-mode").value!=="auto";
      el("protein-manual").hidden=el("protein-mode").value!=="manual";
    }
    if(el("creatine-plan"))el("creatine-target").hidden=!el("creatine-plan").checked;
  }
  function known(value,count,missing) {
    if(!count)return missing?"Количество неизвестно":"Нет записей";
    return (missing?"Записано не менее ":"")+fmt(value)+" г";
  }
  function dayBody(row,state) {
    const p=row.protein,c=row.creatine,powder=row.powder;
    const result=known(p.known,p.count-p.missing,p.missing);
    const links=p.issues.filter(i=>!state||visibility.issue(state,i)).map(i=>{
      const action=i.kind==="meal"?"refine-meal-"+encodeURIComponent(i.id):"refine-dose-"+i.index+"-"+encodeURIComponent(i.label);
      return '<button type="button" data-action="'+html(action)+'">'+html("Уточнить · "+i.label+" "+i.date.slice(11,16))+'</button>';
    }).join("");
    const how=p.mode==="auto"&&row.weight ? '<p>Расчётный вес · '+fmt(row.weight.kg)+' кг · '+html(date(row.weight.day))+' · '+
      (row.weight.source==="manual"?"Ручной ввод":row.weight.source==="ha"?"Весы HA":"Дневник")+'</p>':"";
    const dose=c.actual!=null?fmt(c.actual)+" г":known(c.known,c.knownCount,c.missing);
    return '<p><b>Белок из еды и добавок</b> · '+result+(p.target!=null?' / '+fmt(p.target)+' г':' · '+(p.mode==="auto"?'недостаточно данных для ориентира':'только факт'))+'</p>'+
      (p.target!=null&&p.count>p.missing?'<p>До ориентира по внесённым данным · '+fmt(Math.max(0,p.target-p.known))+' г</p>':"")+how+links+
      (enabled(state,"Протеин")&&(powder.knownCount||powder.missing)?'<details><summary>Вклад протеиновой добавки</summary><p>'+known(powder.known,powder.knownCount,powder.missing)+'</p></details>':"")+
      (enabled(state,"Креатин")?'<p><b>Креатин · '+html(substanceLabels[c.substance||"legacy"])+'</b> · '+dose+(c.target==null?' · план выключен':' / '+fmt(c.target)+' г')+'</p>':"");
  }
  function today(data,state) {
    return data?.rows.length?article("Питание и личные цели",dayBody(data.rows.at(-1),state)):"";
  }
  function report(data,period,state) {
    if(!data?.rows.length)return "";
    const p=data.protein,c=data.creatine,f=data.fiber;
    const comparison=metric=>metric.bySubstance?.filter(v=>v.comparedDays).length>1?metric.bySubstance.filter(v=>v.comparedDays).map(v=>substanceLabels[v.substance]+": "+fmt(v.actual)+" / "+fmt(v.target)+" г · "+v.percent+"%").join("; "):metric.comparedDays?fmt(metric.actual)+' / '+fmt(metric.target)+' г за '+metric.comparedDays+' дн. · выполнение '+metric.percent+'%':'Пока нет сопоставимых дней (проверь вид вещества цели и записей)';
    const groups=data.groups.map(g=>'<p><b>'+html(g.label)+'</b> · '+known(g.known,g.count-g.missing,g.missing)+
      (enabled(state,"Протеин")&&(g.powder||g.powderUnknown)?' · из порошка '+known(g.powder,g.powder>0?1:0,g.powderUnknown):"")+'</p>').join("");
    const trend=data.trends.map(t=>'<p>За '+t.days+' дней · '+(t.count?fmt(t.mean)+' кг':'нет замеров')+' · дней с замерами '+t.count+' из '+t.days+'</p>').join("");
    const details=data.rows.length===1 ? dayBody(data.rows[0],state) : '<p>Белок из еды и добавок · '+comparison(p)+'</p><p>Дни с внесённой порцией еды · '+p.recordedDays+' из '+data.rows.length+' · дней с ориентиром '+p.planDays+'</p>'+
      (enabled(state,"Креатин")?'<p>Креатин · '+comparison(c)+'</p><p>План креатина действовал '+c.planDays+' дн. Закрытые дни без отметки учтены как 0 г.</p>':"")+
      '<p>Процент рассчитан по дням с известным количеством и действующей целью. Превышение дневной цели учитывается в граммах. В выполнении за сутки доступно до 100%.</p>'+
      '<details><summary>Цели и записи по датам</summary>'+data.rows.filter(r=>r.protein.count||r.protein.target!=null||enabled(state,"Креатин")&&(r.creatine.target!=null||r.creatine.knownCount||r.creatine.missing))
        .map(r=>'<details><summary>'+html(date(r.day))+'</summary>'+dayBody(r,state)+'</details>').join("")+'</details>';
    return article("Цели питания",details)+
      (groups?article("Белок по приёмам пищи",groups):"")+
      (f.count?article("Клетчатка",'<p>'+known(f.known,f.knownCount,f.count-f.knownCount)+'</p><p>Сведения о клетчатке · '+f.knownCount+' из '+f.count+' порций.</p>'+
        '<p>Общий ориентир ВОЗ для взрослых — от 25 г в день из пищи. <a href="https://www.who.int/news/item/17-07-2023-who-updates-guidelines-on-fats-and-carbohydrates" target="_blank" rel="noopener noreferrer">Рекомендации ВОЗ</a></p>'):"")+
      article("Средняя масса тела",trend+(data.latest?'<p>Последний замер · '+html(date(data.latest.day))+' · '+fmt(data.latest.kg)+' кг</p>':""));
  }
  return {settings,sync,today,report};
})();
if(typeof module!=="undefined")module.exports=SportGoalsView;
