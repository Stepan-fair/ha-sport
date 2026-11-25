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
  ["Творог 2% · Простоквашино", [99, 17, 2, 3.3], dairySource + "tvorog-2-200-g/"],
  ["Творог 5% · Простоквашино", [117, 15, 5, 3], dairySource + "tvorog-5-200-g/", "", "4600605029312"],
  ["Творог рассыпчатый 9% · Простоквашино", [157, 16, 9, 3], dairySource + "tvorog-rassypchatyi-9-320-g/"],
  ["Творог мягкий 0,1% · Простоквашино", [55, 10, 0.1, 3.4], dairySource + "tvorog-myagkiy-0-1--170-g/", "обезжиренный"],
  ["Йогурт греческий натуральный 2% · TEOS", [62.8, 7, 2, 4.2], "https://av.ru/i/330313", "теос савушкин"],
  ["Молоко пастеризованное 2,5% · Простоквашино", [53, 3, 2.5, 4.7], dairySource + "moloko-pasterizovannoe-2-5-930-ml/"],
  ["Сметана 10% · Простоквашино", [117, 2.8, 10, 3.9], dairySource + "smetana-10-300-g/"],
  ["Сметана 15% · Простоквашино", [160, 2.7, 15, 3.6], dairySource + "smetana-15-300-g/"],
  ["Кефир 1% · Простоквашино", [37, 3, 1, 4], dairySource + "kefir-1-930-g/"],
  ["Кефир 2,5% · Простоквашино", [51, 3, 2.5, 4], dairySource + "kefir-2-5-930-g/"],
  ["Гречка ядрица, сухая · MAKFA", [309, 12.6, 3.3, 57.1], "https://market.yandex.ru/card/makfa-krupa-grechnevaya-yadritsa-800-g-3-sht/103579492743/questions", "гречневая крупа макфа"],
  ["Макароны лапша, сухие · MAKFA", [342, 12, 1.3, 70.5], "https://www.makfa.ru/catalog/makaronnaya-produktsiya/klassicheskie-makaronnye-izdeliya/", "макфа паста"]
].map(([name, nut, source, aliases = "", code = ""]) => ({name, nut, source, aliases, code, unit: "г"}));

function foodText(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/(\d),(\d)/g, "$1.$2").trim();
}

function localFoods(query, products, meals) {
  const words = foodText(query).split(/\s+/);
  const barcode = /^\d{8,14}$/.test(query);
  return [...products, ...meals.slice().reverse(), ...pantry].filter(item => {
    if (barcode) return item.code === query;
    const text = foodText(item.name + " " + (item.aliases || ""));
    return words.every(word => /^\d+(\.\d+)?%?$/.test(word)
      ? (text.match(/\d+(?:\.\d+)?%?/g) || []).some(n => n === word || n === word + "%")
      : text.includes(word));
  });
}

function importedFood(item) {
  const title = item.product_name_ru || item.product_name;
  if (!title) return null;
  const nut = ["energy-kcal", "proteins", "fat", "carbohydrates"].map(key => {
    const value = item.nutriments?.[key + "_100g"];
    return value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  });
  return {name: [title, item.brands].filter(Boolean).join(" · "), code: String(item.code || ""),
    nut, unit: item.nutrition_data_per === "100ml" ? "мл" : "г", online: true};
}

function distinctFoods(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item?.name) return false;
    const key = item.code || foodText(item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (typeof module !== "undefined") module.exports = {localFoods, importedFood, distinctFoods};
