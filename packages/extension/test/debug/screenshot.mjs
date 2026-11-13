// Captures the side panel at its real width during a Colab review, for eyeballing the UI.
//   node test/debug/screenshot.mjs   (bridge and extension must be built)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../../../..");
const EXT = resolve(ROOT, "packages/extension/dist");
const TOKEN = "shot-token-0123456789abcdef";
const PORT = 47991;
const home = mkdtempSync(join(tmpdir(), "ainb-shot-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ token: TOKEN, port: PORT }));
writeFileSync(
  join(home, "agents.json"),
  JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [resolve(ROOT, "packages/bridge/test/fixtures/fake-agent.mjs")] }]),
);
const bridge = spawn(process.execPath, [resolve(ROOT, "packages/bridge/dist/cli.js"), "serve"], { env: { ...process.env, AINB_HOME: home }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  colorScheme: process.env.DARK ? "dark" : "light",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  const nb = await ctx.newPage();
  await nb.goto("https://colab.research.google.com/github/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await nb.waitForFunction(() => window.colab?.global?.notebook?.cells?.length > 7, null, { timeout: 120_000 });
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.includes("colab"))?.id);
  const cellId = await nb.evaluate(() => window.colab.global.notebook.cells[7].getId());

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 760 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await panel.waitForSelector(".setup");
  await panel.screenshot({ path: "test/debug/shot-setup.png" });
  // No native host in this browser: pair by hand.
  await panel.getByText("Connect with a pairing token instead").click();
  await panel.getByPlaceholder("from the bridge's console").fill(TOKEN);
  await panel.getByLabel("Port").fill(String(PORT));
  await panel.getByRole("button", { name: "Connect" }).click();
  await panel.getByLabel("Agent").selectOption("fake");
  await panel.getByLabel("Review").check();

  const steps = [
    { say: "I'll put a small example in the empty code cell." },
    { tool: "list_cells", args: {} },
    { tool: "update_cell", args: { cell_id: cellId, source: 'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, 3]})\ndf.describe()' } },
  ];
  const box = panel.getByPlaceholder(/Ask about this notebook/);
  await box.fill(`Fill in the empty cell. SCRIPT: ${JSON.stringify(steps)}`);
  await box.press("Enter");
  await panel.locator(".card.review.pending").waitFor({ timeout: 60_000 });
  await panel.waitForTimeout(500);
  await panel.screenshot({ path: `test/debug/shot-review${process.env.DARK ? "-dark" : ""}.png` });
  await nb.screenshot({ path: "test/debug/shot-colab.png" });
  console.log("screenshots written");
} finally {
  await ctx.close();
  bridge.kill();
}
