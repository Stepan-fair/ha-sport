"use strict";

const assert = require("node:assert/strict");
const {readFile} = require("node:fs/promises");
const {createServer} = require("node:http");
const path = require("node:path");
const {chromium, webkit, devices} = require("playwright");

async function exercisePage(page, mobile) {
  const activate = locator => mobile ? locator.tap() : locator.click();
  const today = page.locator(".calDay.chosen");
  await today.waitFor();
  assert.match(await today.getAttribute("aria-label"), /Тренировки пока нет/);
  const nav = page.getByRole("navigation", {name:"Разделы дневника"});
  assert.equal(await nav.getByRole("button").count(), 4);

  const food = nav.getByRole("button", {name:"Питание"});
  if (mobile) await food.tap();
  else { await food.focus(); await page.keyboard.press("Enter"); }
  await activate(page.locator('[data-action="show-calendar"]'));
  await activate(page.locator('[data-action="cal-prev"]'));
  const dateButton = page.locator(".calDay:not(.outside)").nth(12);
  const action = await dateButton.getAttribute("data-action");
  const day = action.slice("date-".length);
  assert.match(await dateButton.getAttribute("aria-label"), /Отдых/);
  await activate(dateButton);
  assert.equal(await food.getAttribute("aria-current"), "page");
  assert.equal((await page.locator("#mealdate").inputValue()).slice(0, 10), day);

  const query = page.locator("#query");
  await activate(query);
  await page.keyboard.insertText("тврог");
  const match = page.locator("#matches").getByRole("button", {name:"Творог 5% · Простоквашино", exact:true});
  await activate(match);
  await page.locator("#amount").fill("200");
  await page.locator("#portion-preview").getByText(/234 ккал/).waitFor();
  await activate(page.locator('[data-action="meal"]'));
  const entry = page.locator("#entries").getByText(/Творог 5%.*234 ккал/);
  await entry.waitFor();
  assert.equal(await page.locator('[data-action="food-complete"]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  await page.reload();
  await page.locator(".calDay.chosen").waitFor();
  await activate(food);
  await activate(page.locator('[data-action="show-calendar"]'));
  await activate(page.locator('[data-action="cal-prev"]'));
  const recordedDay = page.locator('[data-action="' + action + '"]');
  assert.match(await recordedDay.getAttribute("aria-label"), /Отдых, есть запись еды/);
  await activate(recordedDay);
  await entry.waitFor();
  assert.equal(await page.locator('#entries [data-action^="edit-meal-"]').count(), 1);
}

async function exerciseSleep(page, mobile) {
  const activate = locator => mobile ? locator.tap() : locator.click();
  await page.clock.setFixedTime("2026-01-15T12:00:00Z");
  await page.reload();
  const sleep = page.locator('[data-disclosure="health-sleep"]');
  const summary = sleep.locator("summary");
  await activate(summary);
  await activate(sleep.getByRole("button", {name:"Записать сон", exact:true}));
  const dialog = page.getByRole("dialog", {name:"Записать сон"});
  await dialog.getByLabel("Часы", {exact:true}).fill("7");
  await dialog.getByLabel("Минуты", {exact:true}).fill("35");
  await activate(dialog.getByRole("button", {name:"Сохранить", exact:true}));
  await dialog.waitFor({state:"hidden"});
  await summary.getByText("7 ч 35 мин", {exact:true}).waitFor();
  await page.reload();
  await summary.getByText("7 ч 35 мин", {exact:true}).waitFor();
  await activate(summary);
  await sleep.getByText("Основной сон · 7 ч 35 мин", {exact:true}).waitFor();
}

async function run() {
  const preview = await readFile(path.join(__dirname, "../artifacts/sport/Sport-preview.html"));
  const server = createServer((req, res) => {
    if (req.url !== "/") { res.writeHead(404).end(); return; }
    res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"}).end(preview);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    for (const [engine, device, mobile] of [[chromium,"Desktop Chrome",false],[webkit,"iPhone 13",true]]) {
      const browser = await engine.launch(mobile ? {} : {chromiumSandbox:true});
      try {
        const context = await browser.newContext({...devices[device], locale:"ru-RU", timezoneId:"Europe/Moscow"});
        await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(origin);
        await exercisePage(page, mobile);
        await exerciseSleep(page, mobile);
        assert.deepEqual(errors, []);
        console.log(engine.name() + " · " + device + " · сохранение и повторное открытие прошли");
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
