import { resolve } from "node:path";
import { chromium } from "playwright";
const EXT = resolve(import.meta.dirname, "../../dist");
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
const nb = await ctx.newPage();
nb.on("console", (m) => console.log("[page]", m.type(), m.text().slice(0, 200)));
nb.on("pageerror", (e) => console.log("[pageerror]", e.message));
for (let i = 0; i < 30; i++) { try { await nb.goto("http://localhost:8899/notebooks/test.ipynb?token=ainbtest", { waitUntil: "domcontentloaded" }); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
await nb.waitForFunction(() => window.jupyterapp?.shell?.currentWidget?.content?.widgets?.length > 1, null, { timeout: 60000 });
await nb.waitForTimeout(2000);
await nb.evaluate(() => {
  window.__events = [];
  window.addEventListener("message", (e) => { if (e.data?.__ainbToExt) window.__events.push(e.data); });
  window.postMessage({ __ainbToPage: true, reqId: 1, op: { op: "update_cell", cellId: "code1", source: "x = 1\nprint(x)", review: true } }, location.origin);
});
await nb.waitForTimeout(1000);
console.log("events:", JSON.stringify(await nb.evaluate(() => window.__events)).slice(0, 400));
console.log("cards:", await nb.locator(".ainb-review").count());
const btn = nb.locator(".ainb-review").getByRole("button", { name: "Accept" });
console.log("btn visible:", await btn.isVisible());
const box = await btn.boundingBox();
console.log("hit:", await nb.evaluate(({x, y}) => { const e = document.elementFromPoint(x, y); const deep = e?.shadowRoot?.elementFromPoint(x, y); return [e?.tagName + "." + e?.className, deep?.tagName + "." + deep?.className]; }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }));
await nb.evaluate(() => { for (const t of ["mousedown","mouseup","click","pointerdown"]) document.addEventListener(t, (e) => console.log("EVT", t, e.composedPath()[0]?.tagName, e.defaultPrevented), true); });
await btn.click();
await nb.waitForTimeout(1000);
console.log("after click cards:", await nb.locator(".ainb-review").count());
console.log("source:", JSON.stringify(await nb.evaluate(() => window.jupyterapp.shell.currentWidget.content.widgets[1].model.sharedModel.getSource())));
console.log("events:", JSON.stringify(await nb.evaluate(() => window.__events.map(e => e.kind + ":" + (e.event?.type ?? "")))));
await ctx.close();
