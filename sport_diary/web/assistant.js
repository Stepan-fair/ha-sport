"use strict";
(() => {
  const el = id => document.getElementById(id);
  const message = text => { el("message").textContent = text; };
  const num = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 2});
  const pendingKey = "sport:nutrition:pending:" + location.pathname;
  let pending = sessionStorage.getItem(pendingKey), selected = {}, searchGeneration = 0, dayGeneration = 0;

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
    const items = data.meals.map(m => paragraph(describe(m)));
    const protein = data.supplementProtein;
    if (protein) {
      const amount = protein.grams == null ? "неизвестно" : num.format(protein.grams) + " г" + (protein.incomplete ? " + неизвестно" : "");
      items.push(paragraph("Белок из добавок, учтённый отдельно · " + amount));
    }
    el("summary").replaceChildren(...items, paragraph("Съедено · " + macros(data.totals, data)),
      paragraph("Суточный расход · " + (data.maintenance == null ? "нет данных" : num.format(data.maintenance) + " ккал")
        + " · День " + (data.complete ? "заполнен" : "открыт")));
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
  function pick(card) {
    selected = card;
    el("name").value = card.name;
    el("mode").value = card.preferred?.mode || "base"; el("basis").value = card.basis || "100";
    el("unit").value = card.unit || "г"; el("piece").value = card.pieceName || "";
    el("count").value = card.preferred?.count ?? "";
    el("size").value = card.sizes?.[el("mode").value] ?? ""; el("piece-size").value = card.sizes?.piece ?? "";
    for (let i = 0; i < 4; i++) el("nut" + i).value = card.nut?.[i] ?? "";
    sizeFields(); message(""); el("save").hidden = false; el("time").focus();
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
    return body;
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
    el("date").value = el("day").value; el("save").hidden = true;
    for (let i = 0; i < 4; i++) el("oil" + i).required = false;
  }
  async function save(ev) {
    ev.preventDefault();
    const button = el("save");
    if (button.disabled) return;
    button.disabled = true; message("");
    try {
      if (!pending) {
        const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
        pending = [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join("-");
        sessionStorage.setItem(pendingKey, pending);
      }
      const saved = await request("nutrition/meals", payload());
      await readBack(saved.id); finish();
    } catch (err) {
      if (err.status === 409 && pending) {
        try { await readBack("nutrition-" + pending); finish(); message("Ранее отправленная порция уже записана. Проверьте её перед новым вводом."); }
        catch (other) { message(other.message); }
      } else if (err.status === 410) { finish(); message(err.message); }
      else message(err.message || "Повторите сохранение после восстановления связи.");
    } finally { button.disabled = false; }
  }
  el("assistant-form").addEventListener("submit", save);
  el("assistant-form").addEventListener("input", () => { el("save").hidden = false; });
  el("search-form").addEventListener("submit", ev => { ev.preventDefault(); search().catch(err => message(err.message)); });
  el("lookup").addEventListener("input", () => { ++searchGeneration; el("card-results").replaceChildren(); });
  el("day").addEventListener("change", () => {
    el("date").value = el("day").value; el("time").value = "";
    showDay().catch(err => message(err.message));
  });
  el("mode").addEventListener("change", () => { el("size").value = selected.sizes?.[el("mode").value] ?? ""; sizeFields(); });
  el("basis").addEventListener("change", clearNutrients);
  el("unit").addEventListener("change", () => {
    selected = {...selected, sizes: {}};
    el("size").value = ""; el("piece-size").value = "";
    if (el("mode").value === "base") el("count").value = "";
    clearNutrients();
  });
  el("name").addEventListener("input", () => { if (selected.name !== el("name").value) selected = {}; });
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
