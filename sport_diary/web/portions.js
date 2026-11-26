"use strict";

const SportPortions = (() => {
  const modes = ["base", "serving", "package", "piece"];
  const plural = new Intl.PluralRules("ru");
  const format = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 4});
  const words = {
    serving: {one:"порция", few:"порции", many:"порций", other:"порции"},
    package: {one:"упаковка", few:"упаковки", many:"упаковок", other:"упаковки"},
    egg: {one:"яйцо", few:"яйца", many:"яиц", other:"яйца"}
  };

  function number(value, label, allowZero = false) {
    const text = typeof value === "string" ? value.trim().replace(",", ".") : value;
    const parsed = typeof text === "number" || (typeof text === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) ? Number(text) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) throw Error("Проверь поле «" + label + "».");
    return parsed;
  }

  function nutrients(values, requireAll = false) {
    if (!Array.isArray(values) || values.length !== 4) throw Error("Укажи КБЖУ по этикетке.");
    return values.map(value => {
      if (value === null || value === undefined || value === "") {
        if (requireAll) throw Error("Укажи все четыре значения КБЖУ по этикетке.");
        return null;
      }
      return number(value, "КБЖУ", true);
    });
  }

  function calculate(card, input) {
    const {mode} = input;
    if (!modes.includes(mode) || !["г", "мл"].includes(card.unit)) throw Error("Выбери единицу количества.");
    const count = number(input.count, "Количество");
    const suppliedSize = mode === "base" ? 1 : card.sizes?.[mode];
    const size = suppliedSize == null ? null : number(suppliedSize, "Размер единицы");
    const perPiece = card.basis === "piece";
    if (mode === "piece" && !card.pieceName?.trim()) throw Error("Укажи название единицы, например «яйцо».");
    if (size === null && !(mode === "piece" && perPiece)) throw Error("Укажи размер выбранной единицы или введи количество в г/мл.");
    const amount = size === null ? null : count * size;
    if (perPiece && mode !== "piece" && !card.sizes?.piece) throw Error("Для пересчёта укажи размер одной штуки в г/мл.");
    const factor = perPiece ? (mode === "piece" ? count : amount / number(card.sizes.piece, "Размер одной штуки")) : amount / 100;
    const baseTotals = nutrients(card.nut, perPiece || mode === "piece").map(value => value === null ? null : value * factor);
    let oil;
    if (input.oil) oil = {grams:number(input.oil.grams, "Масло, г"), nut:nutrients(input.oil.nut, true)};
    const totals = baseTotals.map((value, i) => value === null ? null : value + (oil ? oil.nut[i] * oil.grams / 100 : 0));
    if ((amount !== null && !Number.isFinite(amount)) || totals.some(v => v !== null && !Number.isFinite(v))) throw Error("Проверь количество и КБЖУ.");
    return {amount, portion:{mode, count, size}, baseTotals, totals, ...(oil ? {oil} : {})};
  }

  function describe(mode, count, card, amount) {
    if (mode === "base") return format.format(count) + " " + card.unit;
    const forms = mode === "piece" && card.pieceName?.toLowerCase() === "яйцо" ? words.egg : words[mode];
    const label = forms ? forms[plural.select(count)] : "× " + (card.pieceName || "шт.");
    return format.format(count) + " " + label + (amount == null ? "" : " · " + format.format(amount) + " " + card.unit);
  }

  function preferredText(card) {
    if (!card.preferred) return "";
    try {
      const {amount, portion} = calculate(card, card.preferred);
      return describe(portion.mode, portion.count, card, amount);
    } catch { return ""; }
  }

  function sameProduct(a, b) {
    if (a.code && b.code) return a.code === b.code;
    return a.name.trim().toLocaleLowerCase("ru") === b.name.trim().toLocaleLowerCase("ru");
  }

  function saveMeal(state, meal, card, editing) {
    const original = editing && state.meals.find(old => old.id === meal.id);
    if (editing) state.meals = state.meals.map(old => old.id === meal.id ? meal : old);
    else state.meals.push(meal);
    if (meal.oneOff) return;
    const products = state.products || [];
    const existing = products.find(item => sameProduct(item, card));
    // Consumption and historical corrections cannot overwrite an explicitly configured label or default.
    const unchangedLabel = original && original.name === card.name && (original.code || "") === (card.code || "") &&
      original.unit === card.unit && JSON.stringify(original.nut) === JSON.stringify(card.nut);
    if (existing && (existing.preferred || existing.sizes || existing.basis === "piece" || unchangedLabel)) return;
    const saved = structuredClone(card);
    delete saved.preferred;
    state.products = [saved, ...products.filter(item => !sameProduct(item, card))];
  }

  function recent(meals, day) {
    const sorted = meals.filter(m => !m.oneOff && m.date.slice(0, 10) <= day).sort((a,b) => b.date.localeCompare(a.date));
    return sorted.filter((m,i) => sorted.findIndex(other => sameProduct(other,m)) === i).slice(0, 5);
  }

  return {number, nutrients, calculate, describe, preferredText, sameProduct, saveMeal, recent};
})();
if (typeof module !== "undefined") module.exports = SportPortions;
