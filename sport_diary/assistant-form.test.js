"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function form(responses) {
  const fields = new Map();
  function field(id) {
    if (!fields.has(id)) fields.set(id, Object.assign(new EventTarget(), {
      value:"", reset(){}, replaceChildren(...children){this.children=children;}
    }));
    return fields.get(id);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "web/assistant.js"), "utf8"), {
    document:{getElementById:field, createElement:()=>({})}, location:{pathname:"/"},
    sessionStorage:{getItem:()=>responses ? "pending" : null, removeItem(){}},
    fetch:key => responses ? Promise.resolve({ok:true,json:async()=>responses[key]}) : new Promise(() => {})
  });
  field("mode").value = "base";
  field("basis").value = "100";
  field("unit").value = "г";
  const nutrients = [0,1,2,3].map(i => field("nut" + i));
  ["157","12.7","11.5","0.8"].forEach((value, i) => { nutrients[i].value = value; });
  function change(id, value) { field(id).value = value; field(id).dispatchEvent(new Event("change")); }
  return {field, change, values:() => nutrients.map(input => input.value)};
}

test("Помощник вводит КБЖУ на яйцо заново при смене основания с 100 г", () => {
  const {field, change, values} = form();
  field("oil0").value = "900";
  change("mode", "piece");
  assert.deepEqual(values(), ["157","12.7","11.5","0.8"]);
  change("basis", "piece");
  assert.deepEqual(values(), ["","","",""]);
  assert.equal(field("oil0").value, "900");
});

test("Помощник не переносит КБЖУ, массу порции и массу штуки в миллилитры", () => {
  const {field, change, values} = form();
  field("size").value = "125"; field("piece-size").value = "60"; field("count").value = "120";
  change("unit", "мл");
  assert.deepEqual(values(), ["","","",""]);
  for (const id of ["size", "piece-size", "count"]) assert.equal(field(id).value, "");
});

test("Перечитанная порция показывает масло, а суточная сводка сохраняет известные КБЖУ", async () => {
  const day = "2026-02-14";
  const meal = {id:"nutrition-pending", date:day+"T08:00", name:"Омлет", amount:200, unit:"г",
    totals:[500, 15, 10, 0], oil:{grams:5, nut:[900, 0, 100, 0]}};
  const {field} = form({
    "nutrition/context":{today:day, zone:"MSK"},
    "nutrition/meals/nutrition-pending":meal,
    ["nutrition/days/"+day]:{day, meals:[meal], count:2, totals:[null,37,null,null],
      known:[500,37,10,0], missing:[1,0,1,1], supplementProtein:{grams:22,incomplete:false}, complete:false, maintenance:null}
  });
  await new Promise(setImmediate);
  const summary = field("summary").children.map(node => node.textContent).join("\n");
  assert.match(summary, /500 ккал[^·]*неизвестн/);
  assert.match(summary, /0 г углеводов[^·]*неизвестн/);
  assert.match(summary, /Белок из добавок.*22 г/);
  assert.match(field("receipt").textContent, /[Мм]асло.*5 г.*45 ккал/);
});
