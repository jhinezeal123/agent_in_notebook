// Captures the side panel mid-turn at its real width: grouped tool calls, a
// code block toolbar, the working timer and a question pinned above the composer.
//   node test/debug/chat-ui.mjs   (bridge and extension must be built; DARK=1 for dark mode)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../../../..");
const EXT = resolve(ROOT, "packages/extension/dist");
const TOKEN = "shot-token-0123456789abcdef";
const PORT = 47992;
const home = mkdtempSync(join(tmpdir(), "ainb-shot-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ token: TOKEN, port: PORT }));
writeFileSync(
  join(home, "agents.json"),
  JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [resolve(ROOT, "packages/bridge/test/fixtures/fake-agent.mjs")] }]),
);
const bridge = spawn(process.execPath, [resolve(ROOT, "packages/bridge/dist/cli.js"), "serve"], { env: { ...process.env, AINB_HOME: home }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const suffix = process.env.DARK ? "-dark" : "";

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

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 760 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await panel.waitForSelector(".setup");
  await panel.getByPlaceholder("from the bridge's console").fill(TOKEN);
  await panel.getByLabel("Port").fill(String(PORT));
  await panel.getByRole("button", { name: "Connect" }).click();
  await panel.getByLabel("Agent").selectOption("fake");
  await panel.getByLabel("Review").uncheck();
  await panel.getByLabel("Notebook only").uncheck();

  const steps = [
    { say: "Let me look at the notebook first." },
    { tool: "list_cells", args: {}, quiet: true },
    { tool: "read_cells", args: { start_index: 0, end_index: 2 }, quiet: true },
    { tool: "notebook_info", args: {}, quiet: true },
    { say: "\n\nHere is a cell you could add:\n\n```python\nimport pandas as pd\ndf = pd.read_csv('data.csv')\ndf.head()\n```\n\nI also want to check your installed packages." },
    { permission: "Run shell: pip list" },
    { say: "\n\nDone." },
  ];
  const box = panel.getByPlaceholder(/Ask about this notebook/);
  await box.fill(`Help me load my data. SCRIPT: ${JSON.stringify(steps)}`);
  // Send stays disabled until the agent's session is open.
  const sendButton = panel.getByRole("button", { name: "Send", exact: true });
  for (let i = 0; i < 240 && !(await sendButton.isEnabled()); i++) await panel.waitForTimeout(250);
  // The toggles were switched off before the chat opened; they must have stuck.
  if (await panel.getByLabel("Review").isChecked()) throw new Error("Review switched itself back on");
  if (await panel.getByLabel("Notebook only").isChecked()) throw new Error("Notebook only switched itself back on");
  await box.press("Enter");
  await panel.locator(".card.prompt.dock").waitFor({ timeout: 30_000 }).catch(async (e) => { await panel.screenshot({ path: "test/debug/shot-chat-fail.png" }); throw e; });
  await panel.waitForTimeout(2200);
  await panel.screenshot({ path: `test/debug/shot-chat${suffix}.png` });
  await panel.locator(".group-head").first().click();
  await panel.waitForTimeout(200);
  await panel.screenshot({ path: `test/debug/shot-chat-open${suffix}.png` });
  console.log("screenshots written");
} finally {
  await ctx.close();
  bridge.kill();
}
