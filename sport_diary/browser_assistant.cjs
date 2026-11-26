"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {createInterface} = require("node:readline");
const {chromium, devices, webkit} = require("playwright");

async function run(engine, device, mobile) {
  const browser = await engine.launch(mobile ? {} : {chromiumSandbox:true});
  const fixture = spawn("python", ["-u", path.join(__dirname, "browser_assistant_fixture.py")], {stdio:["pipe","pipe","inherit"]});
  const pending = new Map();
  let sequence = 0;
  createInterface({input: fixture.stdout}).on("line", line => {
    const reply = JSON.parse(line); pending.get(reply.i).resolve(reply); pending.delete(reply.i);
  });
  const stopped = new Promise(resolve => fixture.once("exit", code => {
    for (const {reject} of pending.values()) reject(Error("Fixture stopped: " + code));
    resolve(code);
  }));
  const send = (requestPath, body, user = "helper") => new Promise((resolve, reject) => {
    const i = sequence++; pending.set(i, {resolve, reject});
    fixture.stdin.write(JSON.stringify({i, path:requestPath, body, user}) + "\n");
  });
  const writes = [], errors = [];
  const click = locator => mobile ? locator.tap() : locator.click();
  async function openAs(user) {
    const context = await browser.newContext({...devices[device], locale:"ru-RU", timezoneId:"Europe/Moscow"});
    const prefix = "http://127.0.0.1:38491/api/hassio_ingress/" + user + "/";
    await context.route("**/*", async route => {
      const req = route.request();
      if (!req.url().startsWith(prefix)) return route.abort();
      const subpath = "/" + req.url().slice(prefix.length);
      const body = req.postData() ? req.postDataJSON() : undefined;
      const reply = await send(subpath, body, user);
      if (subpath === "/nutrition/meals" && req.method() === "POST") {
        writes.push({body, status: reply.status});
        if (writes.length === 1) return route.abort("failed"); // The server committed; the response was lost.
      }
      const type = subpath === "/" ? "text/html; charset=utf-8" : subpath.endsWith(".js") ? "text/javascript" :
        subpath.endsWith(".css") ? "text/css" : "application/json";
      await route.fulfill({status: reply.status, contentType: type, body: Buffer.from(reply.data, "base64")});
    });
    const page = await context.newPage();
    page.on("pageerror", err => errors.push(String(err)));
    await page.clock.setFixedTime(new Date("2026-02-14T15:00:00Z"));
    await page.goto(prefix);
    return page;
  }
  try {
    const owner = await openAs("u1");
    await owner.locator(".calDay.chosen").waitFor();
    await click(owner.getByRole("button", {name:"Питание",exact:true}));
    await owner.locator("#entries").getByText(/Завтрак.*400 ккал/).waitFor();
    await owner.locator("#product").fill("Неоконченный ввод");
    const second = await openAs("u2");
    await second.locator(".calDay.chosen").waitFor();
    await click(second.getByRole("button", {name:"Питание",exact:true}));
    const page = await openAs("helper");
    await page.locator("#summary").getByText(/Съедено/).waitFor();
    assert.equal(await page.locator("#save").isVisible(), false);
    assert.equal(await page.locator("#time").inputValue(), "");
    await page.locator("#name").fill("Яичница");
    await click(page.locator("details").filter({has:page.locator("#oil")}).locator("summary"));
    await page.locator("#oil").fill("5");
    for(const [i,n] of [900,0,100,0].entries()) await page.locator("#oil"+i).fill(String(n));
    await page.locator("#estimate").fill("Масло от предыдущего блюда");
    await page.locator("#one-off").check();
    await page.locator("#lookup").fill("йогурт");
    await click(page.getByRole("button", {name:"Найти продукт"}));
    await click(page.locator("#card-results").getByRole("button", {name:/^Йогурт ·/}));
    assert.equal(await page.locator("#mode").inputValue(), "package");
    assert.equal(await page.locator("#nut0").inputValue(), "80");
    assert.equal(await page.locator("#oil").inputValue(), "");
    assert.equal(await page.locator("#estimate").inputValue(), "");
    assert.equal(await page.locator("#one-off").isChecked(), false);
    for (const [field, value] of [["basis","piece"], ["unit","мл"]]) {
      await page.locator("#" + field).selectOption(value);
      assert.deepEqual(await page.locator("#nut0,#nut1,#nut2,#nut3").evaluateAll(inputs => inputs.map(n => n.value)), ["","","",""]);
      assert.equal(await page.locator("#nut0").evaluate(input => input.validity.valueMissing), true);
      if (field === "unit") assert.equal(await page.locator("#size").inputValue(), "");
      await click(page.locator("#card-results").getByRole("button", {name:/^Йогурт ·/}));
      assert.equal(await page.locator("#nut0").inputValue(), "80");
      assert.equal(await page.locator("#size").inputValue(), "125");
    }
    await page.locator("#date").fill("2026-02-14"); await page.locator("#time").fill("09:45");
    await page.locator("#count").fill("3.5");
    await page.locator("#assistant-preview").getByText(/350 ккал/).waitFor();
    await page.locator("#estimate").fill("Количество по фото");
    await click(page.locator("#save"));
    await page.waitForFunction(() => document.getElementById("message").textContent.length > 0 && !document.getElementById("save").disabled);
    await click(page.locator("#save"));
    await page.locator("#receipt").filter({hasText:/Сохранено и проверено.*350 ккал/}).waitFor();
    await page.locator("#summary").getByText(/1\s?950 ккал/).waitFor();
    await page.locator("#summary").getByText(/Съедено.*750 ккал/).waitFor();
    assert.deepEqual(writes.map(w => w.status), [201, 200]);
    assert.equal(writes[0].body.operationId, writes[1].body.operationId);
    assert.equal(writes[0].body.oil, undefined);
    assert.equal(writes[0].body.oneOff, false);
    assert.equal(await page.locator("#summary").getByText(/Йогурт/).count(), 1);
    assert.equal(await page.locator("#save").isVisible(), false);
    assert.equal(await page.evaluate(async () => (await fetch("profile/person1")).status), 403);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await owner.bringToFront();
    await owner.evaluate(() => window.dispatchEvent(new Event("focus")));
    await owner.locator("#entries").getByText(/Йогурт.*350 ккал/).waitFor();
    await owner.locator("#food-diary").getByText(/750 ккал/).first().waitFor();
    assert.equal(await owner.locator("#product").inputValue(), "Неоконченный ввод");
    await second.bringToFront();
    await second.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await second.locator('#entries [data-action^="edit-meal-"]').count(), 0);
    await page.bringToFront();
    await click(page.getByText("Предложить исправление приёма", {exact:true}));
    const savedId = "nutrition-" + writes[0].body.operationId;
    await page.locator("#proposal-meal").selectOption(savedId);
    await page.locator("#proposal-count").fill("2");
    await page.locator("#proposal-reason").fill("Уточнено фактическое количество");
    await click(page.locator("#send-correction"));
    await page.locator("#message").getByText(/передано владельцу/).waitFor();
    async function latestOwnerRequest() {
      await owner.bringToFront();
      await click(owner.getByRole("button", {name:"Сегодня", exact:true}));
      await click(owner.getByRole("button", {name:"Питание", exact:true}));
      return owner.locator('#food-proposals [data-action^="approve-proposal-"]');
    }
    const approveCorrection = await latestOwnerRequest();
    await approveCorrection.waitFor();
    await owner.locator("#entries").getByText(/Йогурт.*350 ккал/).waitFor();
    await click(owner.locator('[data-action="review-meal-' + savedId + '"]'));
    assert.equal(await owner.locator("#product").inputValue(), "Йогурт");
    assert.equal(await owner.locator("#amount").inputValue(), "3.5");
    await click(owner.locator('[data-action="cancel-meal"]'));
    await click(approveCorrection);
    await owner.locator("#entries").getByText(/Йогурт.*200 ккал/).waitFor();
    assert.equal(await owner.locator('#entries [data-action^="edit-meal-"]').count(), 2);

    await page.bringToFront();
    await click(page.getByRole("button", {name:"Найти продукт"}));
    await click(page.locator("#card-results").getByRole("button", {name:/^Йогурт ·/}));
    await click(page.locator("#preference-panel > summary"));
    await page.locator("#preference-mode").selectOption("package");
    await page.locator("#preference-count").fill("2");
    await page.locator("#preference-reason").fill("Обычно две упаковки");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/nutrition/proposals") && response.ok()),
      click(page.locator("#send-preference"))
    ]);
    const approvePreference = await latestOwnerRequest();
    await click(approvePreference);
    await approvePreference.waitFor({state:"detached"});
    const cards = await page.evaluate(async () => (await fetch("nutrition/cards?q=" + encodeURIComponent("Йогурт"))).json());
    assert.deepEqual(cards.find(card=>card.name==="Йогурт").preferred, {mode:"package",count:2});
    await owner.locator("#entries").getByText(/Йогурт.*200 ккал/).waitFor();
    await page.bringToFront();
    await page.locator("#lookup").fill("Тестовая яичница");
    await click(page.getByRole("button", {name:"Найти продукт"}));
    await click(page.locator("#card-results").getByRole("button", {name:/^Тестовая яичница/}));
    assert.equal(await page.locator("#mode").inputValue(), "piece");
    assert.equal(await page.locator("#count").inputValue(), "");
    await page.locator("#count").fill("4");
    await page.locator("#assistant-preview").getByText(/280 ккал/).waitFor();
    assert.equal(await page.locator("#preference-count").inputValue(), "");
    assert.deepEqual(errors, []); console.log("Assistant and owner sync OK:", device);
  } finally {
    fixture.stdin.end(); await browser.close();
    assert.equal(await stopped, 0);
  }
}
(async () => {
  await run(chromium, "Desktop Chrome", false);
  await run(webkit, "iPhone 13", true);
})().catch(err => { console.error(err); process.exitCode = 1; });
