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
  const send = (requestPath, body) => new Promise((resolve, reject) => {
    const i = sequence++; pending.set(i, {resolve, reject});
    fixture.stdin.write(JSON.stringify({i, path:requestPath, body}) + "\n");
  });
  try {
    const context = await browser.newContext({...devices[device], locale:"ru-RU"});
    const prefix = "http://127.0.0.1:38491/api/hassio_ingress/test/";
    const writes = [];
    await context.route("**/*", async route => {
      const req = route.request();
      if (!req.url().startsWith(prefix)) return route.abort();
      const subpath = "/" + req.url().slice(prefix.length);
      const body = req.postData() ? req.postDataJSON() : undefined;
      const reply = await send(subpath, body);
      if (subpath === "/nutrition/meals" && req.method() === "POST") {
        writes.push({id: body.operationId, status: reply.status});
        if (writes.length === 1) return route.abort("failed"); // The server committed; the response was lost.
      }
      const type = subpath === "/" ? "text/html; charset=utf-8" : subpath.endsWith(".js") ? "text/javascript" :
        subpath.endsWith(".css") ? "text/css" : "application/json";
      await route.fulfill({status: reply.status, contentType: type, body: Buffer.from(reply.data, "base64")});
    });
    const page = await context.newPage();
    const click = locator => mobile ? locator.tap() : locator.click();
    const errors = []; page.on("pageerror", err => errors.push(String(err)));
    await page.goto(prefix);
    await page.locator("#summary").getByText(/Съедено/).waitFor();
    assert.equal(await page.locator("#save").isVisible(), false);
    assert.equal(await page.locator("#time").inputValue(), "");
    await page.locator("#lookup").fill("йогурт");
    await click(page.getByRole("button", {name:"Найти продукт"}));
    await click(page.locator("#card-results").getByRole("button", {name:/^Йогурт ·/}));
    assert.equal(await page.locator("#mode").inputValue(), "package");
    assert.equal(await page.locator("#nut0").inputValue(), "80");
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
    await page.locator("#estimate").fill("Количество по фото");
    await click(page.locator("#save"));
    await page.waitForFunction(() => document.getElementById("message").textContent.length > 0 && !document.getElementById("save").disabled);
    await click(page.locator("#save"));
    await page.locator("#receipt").filter({hasText:/Сохранено и проверено.*100 ккал/}).waitFor();
    await page.locator("#summary").getByText(/1\s?950 ккал.*открыт/).waitFor();
    assert.deepEqual(writes.map(w => w.status), [201, 200]); assert.equal(writes[0].id, writes[1].id);
    assert.equal(await page.locator("#summary").getByText(/Йогурт/).count(), 1);
    assert.equal(await page.locator("#save").isVisible(), false);
    assert.equal(await page.evaluate(async () => (await fetch("profile/person1")).status), 403);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []); await context.close(); console.log("Assistant OK:", device);
  } finally {
    fixture.stdin.end(); await browser.close();
    assert.equal(await stopped, 0);
  }
}
(async () => {
  await run(chromium, "Desktop Chrome", false);
  await run(webkit, "iPhone 13", true);
})().catch(err => { console.error(err); process.exitCode = 1; });
