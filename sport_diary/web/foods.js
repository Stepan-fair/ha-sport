"use strict";

// Values are per 100 g, in the order kcal, protein, fat and carbohydrates.
const dairySource = "https://prostokvashino.ru/product/";
const basicFoodSource = "https://zpp.rospotrebnadzor.ru/advices/57827";
const pantry = [
  ["Банан свежий", [96, 1.5, 0.5, 21], basicFoodSource],
  ["Апельсин свежий", [43, 0.9, 0.2, 8.1], basicFoodSource],
  ["Виноград свежий", [72, 0.6, 0.6, 15.4], basicFoodSource],
  ["Огурец свежий", [14, 0.8, 0.1, 2.5], basicFoodSource, "огурцы"],
  ["Капуста белокочанная", [28, 1.8, 0.1, 4.7], basicFoodSource],
  ["Картофель отварной", [75, 2, 0.4, 15.8], basicFoodSource, "картошка вареная"],
  ["Яйцо куриное варёное", [157, 12.7, 11.5, 0.8], basicFoodSource, "яйца отварные"],
  ["Треска отварная", [79, 18, 0.8, 0], basicFoodSource, "рыба вареная"],
  ["Батон нарезной", [262, 7.6, 2.8, 51.4], basicFoodSource, "хлеб пшеничный"],
  ["Сыр костромской", [343, 25.6, 26, 0], basicFoodSource],
  ["Фундук", [651, 15, 61.5, 9.4], basicFoodSource, "орех"],
  ["Масло подсолнечное", [900, 0, 100, 0], basicFoodSource, "растительное"],
  ["Грибы белые", [34, 3.7, 1.7, 1.1], basicFoodSource, "боровики"],
  ["Молоко 1%", [40, 3, 1, 4.8], basicFoodSource],
  ["Молоко 3,2%", [60, 2.9, 3.2, 4.7], basicFoodSource],
  ["Каша манная вязкая", [100, 2.2, 3, 16.3], basicFoodSource, "манка"],
  ["Антрекот из говядины", [220, 29.6, 11.2, 0], basicFoodSource],
  ["Сельдь атлантическая жирная", [248, 17.7, 19.5, 0], basicFoodSource],
  ["Отбивная свиная жареная", [261, 27.2, 16, 0], basicFoodSource],
  ["Колбаса варёная «Телячья»", [310, 13.2, 28.4, 0.4], basicFoodSource],
  ["Сардельки свиные", [332, 10.1, 31.6, 1.8], basicFoodSource],
  ["Сахар-песок", [400, 0, 0, 100], basicFoodSource],
  ["Чипсы картофельные", [531, 8.1, 33.9, 51.5], basicFoodSource],
  ["Конфеты шоколадные", [533, 7, 30.7, 57], basicFoodSource],
  ["Масло сливочное «Вологодское»", [750, 0.5, 82.5, 1], basicFoodSource],
  ["Творог 2% · Простоквашино", [99, 17, 2, 3.3], dairySource + "tvorog-2-200-g/", "", "4600605029343", "200 г"],
  ["Творог 5% · Простоквашино", [117, 15, 5, 3], dairySource + "tvorog-5-200-g/", "", "4600605029312", "200 г"],
  ["Творог рассыпчатый 9% · Простоквашино", [157, 16, 9, 3], dairySource + "tvorog-rassypchatyi-9-320-g/", "", "", "320 г"],
  ["Творог мягкий 0,1% · Простоквашино", [55, 10, 0.1, 3.4], dairySource + "tvorog-myagkiy-0-1--170-g/", "обезжиренный", "", "170 г"],
  ["Творог 5% · ВкусВилл · Лебедяньмолоко", [121, 16, 5, 3], "https://vkusvill.ru/goods/tvorog-5-27695/", "", "", "180 г"],
  ["Творог 5% · ВкусВилл · Курское молоко", [116.2, 16, 5, 1.8], "https://vkusvill.ru/goods/tvorog-5-27695/", "", "", "180 г"],
  ["Йогурт греческий натуральный 2% · TEOS", [62.8, 7, 2, 4.2], "https://av.ru/i/330313", "теос савушкин"],
  ["Молоко пастеризованное 2,5% · Простоквашино", [53, 3, 2.5, 4.7], dairySource + "moloko-pasterizovannoe-2-5-930-ml/"],
  ["Сметана 10% · Простоквашино", [117, 2.8, 10, 3.9], dairySource + "smetana-10-300-g/"],
  ["Сметана 15% · Простоквашино", [160, 2.7, 15, 3.6], dairySource + "smetana-15-300-g/"],
  ["Кефир 1% · Простоквашино", [37, 3, 1, 4], dairySource + "kefir-1-930-g/"],
  ["Кефир 2,5% · Простоквашино", [51, 3, 2.5, 4], dairySource + "kefir-2-5-930-g/"],
  ["Гречка ядрица, сухая · MAKFA", [309, 12.6, 3.3, 57.1], "https://market.yandex.ru/card/makfa-krupa-grechnevaya-yadritsa-800-g-3-sht/103579492743/questions", "гречневая крупа макфа"],
  ["Макароны лапша, сухие · MAKFA", [342, 12, 1.3, 70.5], "https://www.makfa.ru/catalog/makaronnaya-produktsiya/klassicheskie-makaronnye-izdeliya/", "макфа паста"]
].map(([name, nut, source, aliases = "", code = "", quantity = ""]) => ({name, nut, source, aliases, code, quantity, unit: "г"}));

function foodText(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/(\d),(\d)/g, "$1.$2").trim();
}

const foodWordGroups = typeof module !== "undefined" && module.exports ? require("./food-words.json") : foodWords;
const foodCanonical = new Map(foodWordGroups.flatMap(group => group.map(word => [word,group[0]])));
const foodStopWords = new Set(["и","с","со","на","по","из","для","жирности"]);
function foodTokens(value) {
  const units = {kg:"кг",g:"г",ml:"мл",l:"л",гр:"г"};
  const normalized = foodText(value).replace(/(\d+(?:\.\d+)?)\s*(%|кг|гр|мл|г|л|kg|ml|g|l)(?!\p{L})/gu, (_, amount, rawUnit) => {
    const unit=units[rawUnit] || rawUnit;
    if(unit==="кг" || unit==="л") return String(Math.round(Number(amount)*1e6)/1000) + (unit==="кг" ? "г" : "мл");
    return String(Number(amount)) + unit;
  });
  return (normalized.match(/\d+(?:\.\d+)?(?:%|г|мл)?|\p{L}+/gu) || []).filter(word=>!foodStopWords.has(word));
}

// One insertion, deletion, substitution or transposition of adjacent letters.
function oneFoodEdit(a, b) {
  if (Math.min(a.length,b.length)<4 || Math.abs(a.length-b.length)>1) return false;
  if (a.length>b.length) return oneFoodEdit(b,a);
  let i=0;
  while(i<a.length && a[i]===b[i]) i++;
  if (a.length<b.length) return a.slice(i)===b.slice(i+1);
  return a.slice(i+1)===b.slice(i+1) ||
    (a[i]===b[i+1] && a[i+1]===b[i] && a.slice(i+2)===b.slice(i+2));
}

function termScore(word, candidate) {
  if (word===candidate) return 6;
  if (/^\d/.test(word)) return candidate===word+"%" ? 5 : 0;
  const group=foodCanonical.get(word), other=foodCanonical.get(candidate);
  if (group && group===other) return 5;
  if (word.length>=2 && candidate.startsWith(word)) return 4;
  if (oneFoodEdit(word,candidate)) return 2;
  return other && oneFoodEdit(word,other) ? 1 : 0;
}

function rankedFoods(query, items) {
  const q=query.trim();
  const available=items.filter(item=>item?.name && !item.oneOff);
  if (/^\d{8,14}$/.test(q)) return available.filter(item=>String(item.code||"")===q);
  const words=foodTokens(q);
  if (!words.length) return [];
  const hits=[];
  for (const item of available) {
    const tokens=foodTokens([item.name,item.aliases,item.quantity].filter(Boolean).join(" "));
    const scores=words.map(word=>tokens.reduce((best,token)=>Math.max(best,termScore(word,token)),0));
    if (scores.every(Boolean)) hits.push({item,score:scores.reduce((sum,n)=>sum+n,0)});
  }
  return hits.sort((a,b)=>b.score-a.score).map(hit=>hit.item);
}

function localFoods(query, products, meals) {
  return [...rankedFoods(query,products), ...rankedFoods(query,meals.slice().reverse()), ...rankedFoods(query,pantry)];
}

function providerFoodQuery(query) {
  if (/^\d{8,14}$/.test(query)) return query;
  return foodTokens(query).map(word=>{
    if (/^\d/.test(word)) return word;
    if (foodCanonical.has(word)) return foodCanonical.get(word);
    const near=new Set([...foodCanonical].filter(([alias])=>oneFoodEdit(word,alias)).map(([,head])=>head));
    return near.size===1 ? near.values().next().value : word;
  }).join(" ");
}

function importedFood(item) {
  const title = item?.product_name_ru || item?.product_name;
  if (!title) return null;
  function perHundred(key) {
    const value = item.nutriments?.[key + "_100g"];
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const nut = ["energy-kcal", "proteins", "fat", "carbohydrates"].map(perHundred);
  if (nut[0] === null) {
    // Open Food Facts normalizes the generic energy_100g field to kilojoules.
    const kj = perHundred("energy-kj") ?? perHundred("energy");
    if (kj !== null) nut[0] = kj * 1000 / 4184;
  }
  const fiber=perHundred("fiber");
  return {name: [title, item.brands].filter(Boolean).join(" · "), code: String(item.code || ""), quantity: item.quantity || "", ...(fiber==null?{}:{fiber}),
    nut, unit: item.nutrition_data_per === "100ml" ? "мл" : "г", online: true};
}

function distinctFoods(items,limit=Infinity) {
  const codes = new Set(), names = new Set(), unlabelled = new Set();
  return items.filter(item => {
    if (!item?.name || item.oneOff) return false;
    const name=foodText(item.name), code=String(item.code || "");
    if (code ? (codes.has(code) || unlabelled.has(name)) : names.has(name)) return false;
    if (code) codes.add(code); else unlabelled.add(name);
    names.add(name);
    return true;
  }).slice(0,limit);
}

if (typeof module !== "undefined") module.exports = {localFoods, importedFood, distinctFoods, rankedFoods, providerFoodQuery};
