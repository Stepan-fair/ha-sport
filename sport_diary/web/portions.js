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
    const baseTotals = nutrients(card.nut, !input.allowPartial && (perPiece || mode === "piece")).map(value => value === null ? null : value * factor);
    let oil;
    if (input.oil) oil = {grams:number(input.oil.grams, "Масло, г"), nut:nutrients(input.oil.nut, !input.allowPartial)};
    if (oil && input.oil.fiber != null && input.oil.fiber !== "") oil.fiber=number(input.oil.fiber,"Клетчатка в масле",true);
    const fiber = card.fiber == null || card.fiber === "" ? null : number(card.fiber,"Клетчатка",true);
    let fiberTotal = fiber === null || (oil && oil.fiber == null) ? null : fiber*factor+(oil ? oil.fiber*oil.grams/100 : 0);
    const totals = baseTotals.map((value, i) => value === null || oil && oil.nut[i]===null ? null : value + (oil ? oil.nut[i] * oil.grams / 100 : 0));
    const old=input.original;
    if(old && old.name===card.name && old.unit===card.unit && (old.basis||"100")===(card.basis||"100") &&
       (old.portion?.mode||"base")===mode && Number(old.portion?.count??old.amount)===count &&
       Number(old.amount)===Number(amount) && (mode==="piece" || !perPiece || old.sizes?.piece===card.sizes?.piece)){
      if(Number.isFinite(old.fiberTotal) && (old.fiber??null)===fiber &&
          (old.oil?.grams??0)===(oil?.grams??0) && (old.oil?.fiber??null)===(oil?.fiber??null))fiberTotal=old.fiberTotal;
      for(let i=0;i<4;i++){
        const sameOil=(old.oil?.grams??0)===(oil?.grams??0) && (old.oil?.nut?.[i]??null)===(oil?.nut?.[i]??null);
        if(sameOil && (old.nut?.[i]??null)===(card.nut[i]??null) && Number.isFinite(old.totals?.[i]))totals[i]=old.totals[i];
      }
    }
    if ((amount !== null && !Number.isFinite(amount)) || [...totals,fiberTotal].some(v => v !== null && !Number.isFinite(v))) throw Error("Проверь количество и состав.");
    return {amount, portion:{mode, count, size}, baseTotals, totals, fiberTotal, ...(oil ? {oil} : {})};
  }

  function describe(mode, count, card, amount) {
    if (mode === "base") return format.format(count) + " " + card.unit;
    const forms = mode === "piece" && card.pieceName?.toLowerCase() === "яйцо" ? words.egg : words[mode];
    const label = forms ? forms[plural.select(count)] : "× " + (card.pieceName || "шт.");
    return format.format(count) + " " + label + (amount == null ? "" : " · " + format.format(amount) + " " + card.unit);
  }

  function mealNutrients(meal) {
    const quantity = value => Number.isFinite(value) && value >= 0 ? value : null;
    const portion = meal.portion || {};
    const amount = Number(meal.amount) > 0 ? Number(meal.amount) : portion.count * (portion.mode === "base" ? 1 : portion.size);
    const factor = meal.basis === "piece" ? (portion.mode === "piece" ? portion.count : amount / meal.sizes?.piece) : amount / 100;
    return [0,1,2,3].map(i => {
      const stored = quantity(meal.totals?.[i]);
      if (stored !== null) return stored;
      const label = quantity(meal.nut?.[i]);
      const base = quantity(meal.baseTotals?.[i]) ?? (label !== null && factor > 0 ? quantity(label * factor) : null);
      if (!meal.oil || base === null) return base;
      const oil = quantity(meal.oil.nut?.[i]), grams = quantity(meal.oil.grams);
      return oil === null || grams === null ? null : quantity(base + oil * grams / 100);
    });
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

  function setDoseLink(state, meal, oldMeal, selected) {
    const oldDay=oldMeal?.date.slice(0,10), newDay=meal.date.slice(0,10);
    const entries=state.supps || [];
    if(selected!=null){
      const candidate=entries[selected];
      if(!candidate || candidate.mealId && candidate.mealId!==meal.id && state.meals.some(row=>row.id===candidate.mealId) ||
         ![oldDay,newDay].includes(candidate.date.slice(0,10)))throw Error("Отметка протеина уже изменилась.");
    }
    state.supps=entries.flatMap((entry,i)=>{
      if(entry.mealId!==meal.id&&i!==selected)return [entry];
      const linked=i===selected || selected===undefined && entry.mealId===meal.id;
      const copy={...entry};
      if(!linked){delete copy.mealId;return [copy]}
      copy.mealId=meal.id;
      const isProtein=name=>/протеин|protein/i.test(name);
      const remainder=entry.names.filter(name=>!isProtein(name));
      copy.date=newDay+copy.date.slice(10);copy.names=entry.names.filter(isProtein);
      const rest={...entry,names:remainder};delete rest.mealId;
      return remainder.length?[rest,copy]:[copy];
    });
  }

  function setMealTime(meal, date, previousDate=meal.date) {
    if(date!==previousDate){
      delete meal.actualConfirmed;
      delete meal.actualEnd;
    }
    meal.date=date;
  }

  function saveMeal(state, meal, card, editing) {
    const original = editing && state.meals.find(old => old.id === meal.id);
    if(original)setMealTime(meal,meal.date,original.date);
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

  function recordedFoodCount(meals){
    return meals.filter(meal=>Number(meal.amount)>0||Number(meal.portion?.count)>0).length;
  }
  return {recordedFoodCount, number, nutrients, calculate, mealNutrients, describe, preferredText, sameProduct, setDoseLink, setMealTime, saveMeal, recent};
})();
if (typeof module !== "undefined") module.exports = SportPortions;
