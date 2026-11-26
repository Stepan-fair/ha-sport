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
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  await page.reload();
  await page.locator(".calDay.chosen").waitFor();
  await activate(food);
  await activate(page.locator('[data-action="show-calendar"]'));
  await activate(page.locator('[data-action="cal-prev"]'));
  await activate(page.locator('[data-action="' + action + '"]'));
  await entry.waitFor();
  assert.equal(await page.locator('#entries [data-action^="edit-meal-"]').count(), 1);
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
        assert.deepEqual(errors, []);
        console.log(engine.name() + " · " + device + " · сохранение и повторное открытие прошли");
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
