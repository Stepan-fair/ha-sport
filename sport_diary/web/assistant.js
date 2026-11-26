"use strict";
(() => {
  const el = id => document.getElementById(id);
  const message = text => { el("message").textContent = text; };
  const num = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 2});
  const pendingKey = "sport:nutrition:pending:" + location.pathname;
  let pending = sessionStorage.getItem(pendingKey), selected = {}, searchGeneration = 0, dayGeneration = 0;
  let visibleMeals = [], correction = null;

  function operationId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
  }

  async function request(path, body) {
    const opts = body ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {};
    const response = await fetch(path, opts);
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error ||
      (response.status === 403 ? "Нет доступа к питанию этого профиля." : "Не удалось получить данные.")), {status: response.status});
    return result;
  }
  function paragraph(text) {
    const p = document.createElement("p"); p.textContent = text; return p;
  }
  function macros(values, daily) {
    return values.map((value, i) => {
      const unit = ["ккал","г белка","г жиров","г углеводов"][i];
      if (value != null) return num.format(value) + " " + unit;
      if (!daily?.missing[i]) return "— " + unit;
      const known = daily.count > daily.missing[i] ? num.format(daily.known[i]) : "—";
      return known + " " + unit + " (неизвестно для " + daily.missing[i] + " порц.)";
    }).join(" · ");
  }
  function describe(meal) {
    const quantity = meal.portion ? SportPortions.describe(meal.portion.mode, meal.portion.count, meal, meal.amount)
      : (meal.amount == null ? "Количество неизвестно" : num.format(meal.amount) + " " + meal.unit);
    return meal.date.replace("T", " ") + " · " + meal.name + " · " + quantity + " · " + macros(meal.totals)
      + (meal.oil ? " · Из них масло — " + num.format(meal.oil.grams) + " г (" +
        macros(meal.oil.nut.map(v => v == null ? null : v * meal.oil.grams / 100)) + ")" : "")
      + (meal.estimateNote ? " · Приблизительно: " + meal.estimateNote : "");
  }
  async function showDay() {
    const date = el("day").value, token = ++dayGeneration;
    el("summary").replaceChildren();
    if (!date) return;
    const data = await request("nutrition/days/" + encodeURIComponent(date));
    if (token !== dayGeneration) return;
    visibleMeals = data.meals;
    const option = (value, label) => {const o = document.createElement("option"); o.value = value; o.textContent = label; return o;};
    el("proposal-meal").replaceChildren(option("", "Выберите приём"), ...visibleMeals.map(m => option(m.id, describe(m))));
    if (correction && visibleMeals.some(m => m.id === correction.id)) el("proposal-meal").value = correction.id;
    else clearCorrection();
    const items = data.meals.map(m => paragraph(describe(m)));
    const protein = data.supplementProtein;
    if (protein) {
      const amount = protein.grams == null ? "неизвестно" : num.format(protein.grams) + " г" + (protein.incomplete ? " + неизвестно" : "");
      items.push(paragraph("Белок из добавок, учтённый отдельно · " + amount));
    }
    el("summary").replaceChildren(...items, paragraph("Съедено · " + macros(data.totals, data)),
      paragraph("Суточный расход · " + (data.maintenance == null ? "нет данных" : num.format(data.maintenance) + " ккал")
        + " · Баланс по внесённому: " + (data.balance == null ? "—" : num.format(data.balance) + " ккал")
        + (data.partialCalories ? " (по порциям с известной калорийностью)" : "")));
  }
  function sizeFields() {
    const mode = el("mode").value, basis = el("basis").value;
    el("size-label").hidden = mode === "base";
    el("size").required = mode !== "base" && !(mode === "piece" && basis === "piece");
    el("piece-label").hidden = mode !== "piece" && basis !== "piece";
    el("piece").required = mode === "piece";
    el("piece-size-label").hidden = basis !== "piece" || mode === "piece";
    el("piece-size").required = !el("piece-size-label").hidden;
  }
  function clearNutrients() {
    for (let i = 0; i < 4; i++) el("nut" + i).value = "";
    sizeFields();
    message("Введите КБЖУ для выбранной единицы и основания.");
  }
  function clearPortionExtras() {
    el("estimate").value = "";
    el("one-off").checked = false;
    el("preference-panel").hidden = false;
    el("oil").value = "";
    for (let i = 0; i < 4; i++) {
      el("oil" + i).value = "";
      el("oil" + i).required = false;
    }
  }
  let doseGeneration=0;
  async function showProteinFields(){
    const kind=el("product-kind").value, day=el("date").value, token=++doseGeneration;
    el("protein-fields").hidden=!kind;
    el("protein-contribution").hidden=kind!=="protein_mix";
    const select=el("protein-dose");
    const option=(value,text)=>{const node=document.createElement("option");node.value=value;node.textContent=text;return node};
    select.replaceChildren(option("","Отдельный приём"));
    if(!kind||!day)return;
    const rows=await request("nutrition/protein-doses/"+encodeURIComponent(day));
    if(token!==doseGeneration)return;
    for(const row of rows)select.append(option(row.id,[row.time,row.servings==null?"Количество неизвестно":num.format(row.servings)+" саше"].filter(Boolean).join(" · ")));
  }
  function setProteinInputs(card){
    el("product-kind").value=card.productKind||"";
    for(const key of ["servings","powderGrams","proteinGrams"])el("protein-"+key).value="";
    showProteinFields().catch(err=>message(err.message));
  }
  function pick(card,focusTime=true) {
    clearPortionExtras();
    selected = card;
    setProteinInputs(card);
    el("name").value = card.name;
    el("mode").value = card.preferred?.mode || (card.pieceName || card.basis === "piece" ? "piece" : "base"); el("basis").value = card.basis || "100";
    el("unit").value = card.unit || "г"; el("piece").value = card.pieceName || "";
    el("count").value = card.preferred?.count ?? "";
    el("preference-mode").value = el("mode").value;
    el("preference-count").value = card.preferred?.count ?? "";
    el("preference-reason").value = "";
    el("preference-with-meal").checked = false;
    el("size").value = card.sizes?.[el("mode").value] ?? ""; el("piece-size").value = card.sizes?.piece ?? "";
    for (let i = 0; i < 4; i++) el("nut" + i).value = card.nut?.[i] ?? "";
    sizeFields(); updatePreview(); message(""); el("save").hidden = false;
    if(focusTime)el("time").focus();
  }
  async function search() {
    const q = el("lookup").value.trim(), token = ++searchGeneration;
    const results = el("card-results"); results.replaceChildren(); message("");
    const personal = await request("nutrition/cards?q=" + encodeURIComponent(q));
    let choices = personal;
    if (q) {
      choices = [...choices, ...localFoods(q, [], [])];
      if (q.length >= 2) {
        try {
          const catalog = await request("food?source=catalog&q=" + encodeURIComponent(q));
          choices.push(...catalog.products);
          if (catalog.status !== "ready" && token === searchGeneration) message("Расширенный каталог пока недоступен.");
        } catch (err) { if (token === searchGeneration) message(err.message); }
      }
    }
    if (token !== searchGeneration) return;
    for (const item of distinctFoods(choices, 30)) {
      const b = document.createElement("button"); b.type = "button";
      b.textContent = item.name + " · " + macros(item.nut) + (item.basis === "piece" ? " на штуку" : " на 100 " + (item.unit || "г"));
      b.addEventListener("click", () => pick(item)); results.append(b);
    }
    if (!results.children.length) results.append(paragraph("Карточек не найдено. Можно внести блюдо вручную."));
  }
  function payload() {
    const mode = el("mode").value, sizes = {...selected.sizes};
    if (mode !== "base") {
      if (el("size").value) sizes[mode] = el("size").valueAsNumber;
      else delete sizes[mode];
    }
    if (!el("piece-size-label").hidden) sizes.piece = el("piece-size").valueAsNumber;
    const fields = prefix => Array.from({length: 4}, (_, i) => el(prefix+i).valueAsNumber);
    const body = {operationId: pending, date: el("date").value + "T" + el("time").value, name: el("name").value,
      mode, count: el("count").valueAsNumber, unit: el("unit").value, basis: el("basis").value,
      sizes, pieceName: el("piece").value, nut: fields("nut"), code: selected.code || "",
      origin: selected.origin || (selected.catalogItem ? "Каталог HA" : selected.source ? "Встроенный каталог" : "Ведение питания"),
      oneOff: el("one-off").checked, estimateNote: el("estimate").value.trim()};
    if (el("oil").valueAsNumber > 0) body.oil = {grams: el("oil").valueAsNumber, nut: fields("oil")};
    if(el("product-kind").value){
      body.productKind=el("product-kind").value;
      const details={};
      for(const key of ["servings","powderGrams","proteinGrams"]){
        if(key==="proteinGrams"&&body.productKind!=="protein_mix")continue;
        if(el("protein-"+key).value)details[key]=el("protein-"+key).valueAsNumber;
      }
      if(Object.keys(details).length)body.proteinDetails=details;
      if(el("protein-dose").value)body.linkDoseId=el("protein-dose").value;
    }
    return body;
  }
  function updatePreview() {
    const preview = el("assistant-preview");
    preview.textContent = "";
    if (!el("count").value) return;
    try {
      const body = payload();
      const {totals} = SportPortions.calculate(body, body);
      preview.textContent = "В порции · " + macros(totals);
    } catch {
      // A partially entered label or quantity has no portion total yet.
    }
  }
  async function readBack(id) {
    const meal = await request("nutrition/meals/" + encodeURIComponent(id));
    el("day").value = meal.date.slice(0, 10);
    el("receipt").textContent = "Сохранено и проверено · " + describe(meal) + " · ID " + meal.id;
    await showDay();
  }
  function finish() {
    sessionStorage.removeItem(pendingKey); pending = null;
    selected = {}; el("assistant-form").reset(); sizeFields();
    setProteinInputs({});
    el("preference-form").reset(); el("preference-panel").hidden = false;
    el("date").value = el("day").value; el("save").hidden = true;
    for (let i = 0; i < 4; i++) el("oil" + i).required = false;
    updatePreview();
  }
  async function save(ev) {
    ev.preventDefault();
    const button = el("save");
    if (button.disabled) return;
    button.disabled = true; message("");
    try {
      if (!pending) {
        pending = operationId();
        sessionStorage.setItem(pendingKey, pending);
      }
      const body = payload();
      if (el("preference-with-meal").checked && !body.oneOff) {
        const {changes,reason,targetId,version} = preferenceBody();
        if (!reason.trim()) throw Error("Укажите пожелание об обычной единице в настройках карточки.");
        body.preferenceProposal = {changes,reason,...(targetId?{targetId,version}:{})};
      }
      const saved = await request("nutrition/meals", body);
      await readBack(saved.id); finish();
      if (body.preferenceProposal) message("Порция сохранена. Пожелание передано владельцу на подтверждение.");
    } catch (err) {
      if (err.status === 409 && pending) {
        try { await readBack("nutrition-" + pending); finish(); message("Ранее отправленная порция уже записана. Проверьте её перед новым вводом."); }
        catch (other) { message(other.status === 404 ? err.message : other.message); }
      } else if (err.status === 410) { finish(); message(err.message); }
      else message(err.message || "Повторите сохранение после восстановления связи.");
    } finally { button.disabled = false; }
  }
  function clearCorrection() {
    correction = null;
    el("correction-form").reset();
    el("proposal-current").textContent = "";
  }
  function labelValues(id) {
    const values = el(id).value.trim().split(/\s+/).map(s => SportPortions.number(s, "КБЖУ", true));
    if (values.length !== 4) throw Error("Введите четыре числа КБЖУ через пробел.");
    return values;
  }
  function correctionBody() {
    if (!correction || !el("proposal-meal").value) throw Error("Выберите сохранённый приём.");
    const changes = {};
    if (el("proposal-count").value) changes.count = el("proposal-count").valueAsNumber;
    if (el("proposal-date").value) changes.date = el("proposal-date").value;
    if (el("proposal-nut").value.trim()) changes.nut = labelValues("proposal-nut");
    const oil = el("proposal-oil"), label = el("proposal-oil-nut").value.trim();
    if (oil.value || label) {
      const grams = oil.value ? oil.valueAsNumber : correction.oil?.grams;
      if (grams !== 0 && !grams) throw Error("Введите массу масла для этой порции.");
      changes.oil = grams === 0 ? null : {grams, nut: label ? labelValues("proposal-oil-nut") : correction.oil?.nut};
    }
    return {kind:"meal", targetId:correction.id, version:correction.version, reason:el("proposal-reason").value, changes};
  }
  function preferenceBody() {
    if (el("one-off").checked) throw Error("Для разовой записи личная карточка не создаётся.");
    const changes = {mode:el("preference-mode").value};
    if (el("preference-count").value) changes.count = el("preference-count").valueAsNumber;
    const body = {kind:"preference", reason:el("preference-reason").value, changes};
    if (selected.id && selected.version) return {...body, targetId:selected.id, version:selected.version};
    const {name, unit, basis, sizes, pieceName, nut, code, origin} = payload();
    return {...body, card:{name, unit, basis, sizes, pieceName, nut, code, origin}};
  }
  async function sendProposal(event, buttonId, getBody) {
    event.preventDefault();
    const button = el(buttonId), storageKey = pendingKey + ":" + buttonId;
    if (button.disabled) return;
    button.disabled = true;
    try {
      const body = getBody();
      body.operationId = sessionStorage.getItem(storageKey) || operationId();
      sessionStorage.setItem(storageKey, body.operationId);
      await request("nutrition/proposals", body);
      sessionStorage.removeItem(storageKey);
      if (body.kind === "meal") clearCorrection();
      else el("preference-reason").value = "";
      message("Предложение передано владельцу. Решение появится в его дневнике питания.");
    } catch (err) {
      if (err.status >= 400 && err.status < 500) sessionStorage.removeItem(storageKey);
      message(err.message);
    } finally { button.disabled = false; }
  }
  el("proposal-meal").addEventListener("change", () => {
    const meal = visibleMeals.find(m => m.id === el("proposal-meal").value);
    clearCorrection();
    if (meal) {
      correction = meal; el("proposal-meal").value = meal.id;
      el("proposal-current").textContent = describe(meal);
    }
  });
  el("correction-form").addEventListener("submit", ev => sendProposal(ev, "send-correction", correctionBody));
  el("preference-form").addEventListener("submit", ev => sendProposal(ev, "send-preference", preferenceBody));
  el("one-off").addEventListener("change", () => { el("preference-panel").hidden = el("one-off").checked; });
  el("assistant-form").addEventListener("submit", save);
  el("assistant-form").addEventListener("input", () => { el("save").hidden = false; updatePreview(); });
  el("assistant-form").addEventListener("change", updatePreview);
  el("search-form").addEventListener("submit", ev => { ev.preventDefault(); search().catch(err => message(err.message)); });
  el("lookup").addEventListener("input", () => { ++searchGeneration; el("card-results").replaceChildren(); });
  el("day").addEventListener("change", () => {
    clearCorrection(); visibleMeals = []; el("proposal-meal").replaceChildren();
    el("date").value = el("day").value; el("time").value = "";
    showProteinFields().catch(err=>message(err.message));
    showDay().catch(err => message(err.message));
  });
  el("mode").addEventListener("change", () => { el("size").value = selected.sizes?.[el("mode").value] ?? ""; sizeFields(); });
  el("basis").addEventListener("change", clearNutrients);
  for(const id of ["product-kind","date"])el(id).addEventListener("change",()=>showProteinFields().catch(err=>message(err.message)));
  el("unit").addEventListener("change", () => {
    selected = {...selected, sizes: {}};
    el("size").value = ""; el("piece-size").value = "";
    if (el("mode").value === "base") el("count").value = "";
    clearNutrients();
  });
  el("name").addEventListener("input", () => {
    if (selected.name && selected.name !== el("name").value) {
      pick({name:el("name").value},false);
      selected={};
    }
  });
  el("name").addEventListener("change", () => {
    if (!selected.name) selected = {name:el("name").value};
  });
  el("oil").addEventListener("input", () => {
    for (let i = 0; i < 4; i++) el("oil" + i).required = el("oil").valueAsNumber > 0;
  });
  (async () => {
    const {today, zone} = await request("nutrition/context");
    el("day").value = today; el("date").value = today; el("zone").textContent = zone ? "(" + zone + ")" : "";
    if (pending) {
      try { await readBack("nutrition-" + pending); finish(); return; }
      catch (err) { if (err.status !== 404) throw err; }
    }
    await showDay();
  })().catch(err => message(err.message));
})();
