// The chat panel for the browser tests: the real chat UI (packages/ui) in a
// plain page, with VS Code's host logic for notebooks in Chrome tabs
// (PanelCore) and its bridge link, minus VS Code itself. This is what the
// VS Code sidebar does for a Colab or Kaggle tab.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { BridgeLink } from "../../vscode/src/bridge.js";
import { NO_LOCAL_NOTEBOOKS, PanelCore } from "../../vscode/src/panel-core.js";
import type { PanelEvent } from "../../ui/src/panel-messages.js";

const UI = resolve(__dirname, "../../ui");

const ENTRY = `
import { render } from "preact";
import { App } from "./src/app.tsx";
import { PanelHostContext } from "./src/host.ts";

const listeners = new Set();
window.addEventListener("ainb-event", (e) => { for (const l of listeners) l(e.detail); });
async function call(method, params = {}) {
  const r = await window.ainbRequest(method, params);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}
const host = {
  request: call,
  on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  watchTab(listener) {
    let seen = false;
    const off = this.on((e) => { if (e.event === "activeTab") { seen = true; listener(e.params); } });
    void call("activeTab.get").then((id) => { if (!seen) listener(id); }, () => {});
    return () => { seen = true; off(); };
  },
  getPrefs: () => call("prefs.get"),
  setPrefs: (prefs) => call("prefs.set", prefs),
  copy: async () => {},
  openLink: async () => false,
};
render(<PanelHostContext.Provider value={host}><App /></PanelHostContext.Provider>, document.getElementById("root"));
`;

let bundle: Promise<string> | undefined;
function webview(): Promise<string> {
  bundle ??= build({
    stdin: { contents: ENTRY, resolveDir: UI, loader: "tsx", sourcefile: "harness.tsx" },
    bundle: true,
    write: false,
    format: "esm",
    target: "chrome130",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: { "@ainb/protocol": resolve(UI, "../protocol/src/index.ts") },
    logLevel: "silent",
  }).then((r) => r.outputFiles[0]!.text);
  return bundle;
}

/** Open the panel, connected to the bridge as the editor. */
export async function openPanel(ctx: BrowserContext, port: number, token: string): Promise<Page> {
  const page = await ctx.newPage();
  let prefs: unknown = null;
  let ready = false;
  const post = (event: PanelEvent) => {
    if (!ready || page.isClosed()) return;
    void page.evaluate((e) => window.dispatchEvent(new CustomEvent("ainb-event", { detail: e })), event).catch(() => {});
  };
  const link: BridgeLink = new BridgeLink(
    "e2e",
    (event) => {
      post(event);
      if (event.event === "state") core.connectionChanged(event.params.conn === "connected");
    },
    () => Promise.reject(new Error("The test panel has no notebooks of its own.")),
    (event) => core.onBrowser(event),
  );
  const core: PanelCore = new PanelCore(link, NO_LOCAL_NOTEBOOKS, post);
  await page.exposeFunction("ainbRequest", async (method: string, params: unknown) => {
    try {
      if (method === "prefs.get") return { ok: true, result: prefs };
      if (method === "prefs.set") {
        prefs = params;
        return { ok: true, result: null };
      }
      if (method === "config.auto") {
        await link.connect({ port, token });
        return { ok: true, result: null };
      }
      return { ok: true, result: (await core.handle(method, params)) ?? null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  page.on("close", () => link.dispose());
  const css = readFileSync(resolve(UI, "chat.css"), "utf8");
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Agent in Notebook</title><style>${css}</style></head><body><div id="root"></div></body></html>`);
  ready = true;
  await page.addScriptTag({ content: await webview(), type: "module" });
  await link.connect({ port, token });
  return page;
}

/** Point the chat at the notebook whose title contains `title` (a picker shows when there are several). */
export async function pickNotebook(panel: Page, title: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const picker = panel.locator(".notebook-pick");
    if (await picker.count()) {
      const options = await picker.locator("option").allTextContents();
      const label = options.find((o) => o.includes(title));
      if (label) {
        await picker.selectOption({ label });
        return;
      }
    } else if ((await panel.locator(".notebook-title").textContent())?.includes(title)) return;
    if (Date.now() > deadline) throw new Error(`No notebook titled ${title} in the panel.`);
    await panel.waitForTimeout(250);
  }
}
