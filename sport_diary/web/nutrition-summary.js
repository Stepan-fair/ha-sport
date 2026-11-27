"use strict";
// Invoked locally by the ingress server. Only the projected nutrition result goes to the assistant.
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
let result;
if (process.argv[2] === "portion") {
  const {calculate} = require("./portions.js");
  try {
    result = calculate(input.card, {mode: input.mode, count: input.count, oil: input.oil, original: input.original, allowPartial: !!input.original});
  } catch (error) {
    result = {error: error.message};
  }
} else if (process.argv[2] === "mealTotals") {
  result = input.map(require("./portions.js").mealNutrients);
} else if (process.argv[2] === "proteinRecipe") {
  const p=require("./supplement-products.js");
  const recipe=p.enabled(input.state,"Протеин")?p.recipeFor(input.state,"Протеин",input.day):null;
  result=recipe?{recipe,oneServing:p.snapshot("Протеин",recipe,1),linkRule:"Read existing meals and protein-dose candidates before recording. Link a complete shake once; do not add milk twice."}:null;
} else if (process.argv[2] === "syncSupplementMeal") {
  require("./supplement-products.js").syncFromMeal(input.state,input.meal);
  result=input.state.supps||[];
} else if (process.argv[2] === "day") {
  const {diaryReport, nutritionForDay} = require("./reports.js");
  const {state, day, entity, scale} = input;
  const report = diaryReport(state, scale, entity, day, "day");
  const row = report.rows.find(item => item.day === day);
  const {totals, known, missing, count, supplements} = row?.nutrition || nutritionForDay(state, day);
  result = {day, totals, known, missing, count, maintenance: row?.maintenance ?? null, balance: row?.balance ?? null, partialCalories: missing[0] > 0};
  if(report.nutritionGoals?.fiber.knownCount)result.fiber=report.nutritionGoals.fiber;
  const separate = supplements.filter(item => !item.linked);
  if (separate.length) {
    const protein = separate.map(item => item.nut[1]).filter(Number.isFinite);
    result.supplementProtein = {grams: protein.length ? protein.reduce((sum, grams) => sum + grams, 0) : null,
      incomplete: protein.length < separate.length};
  }
} else {
  throw Error("Unknown calculation");
}
process.stdout.write(JSON.stringify(result));
