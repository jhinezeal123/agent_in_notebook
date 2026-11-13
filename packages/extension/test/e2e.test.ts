// End-to-end in a real browser: Chromium with the built extension, the built
// bridge, the scripted fake agent, and real notebooks (public Colab page; a
// local Jupyter Notebook 7, which is what Kaggle embeds).
//
//   E2E=1 [AINB_E2E_JUPYTER=<path to jupyter executable>] pnpm --filter @ainb/extension exec vitest run test/e2e.test.ts
//
// Running cells on Colab needs a signed-in runtime, so Colab covers editing and
// review; Jupyter covers running.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { formatLaunchCommand } from "@ainb/protocol";

const RUN = !!process.env.E2E;
const JUPYTER = process.env.AINB_E2E_JUPYTER;
const ROOT = resolve(__dirname, "../../..");
const EXT = resolve(__dirname, "../dist");
const CLI = resolve(ROOT, "packages/bridge/dist/cli.js");
const FAKE_AGENT = resolve(ROOT, "packages/bridge/test/fixtures/fake-agent.mjs");
const TOKEN = "e2e-token-0123456789abcdef";
const PORT = 47900 + Math.floor(Math.random() * 90);
const JUPYTER_PORT = 8890 + Math.floor(Math.random() * 9);
const COLAB = "https://colab.research.google.com/github/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb";

let bridge: ChildProcess | null = null;
let jupyter: ChildProcess | null = null;
let ctx: BrowserContext;
let extId: string;

async function waitHttp(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

beforeAll(async () => {
  if (!RUN) return;
  const home = mkdtempSync(join(tmpdir(), "ainb-e2e-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ token: TOKEN, port: PORT }));
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT] }]));
  bridge = spawn(process.execPath, [CLI, "serve"], { env: { ...process.env, AINB_HOME: home }, stdio: "inherit" });
  await waitHttp(`http://127.0.0.1:${PORT}/health`, 20_000);

  if (JUPYTER) {
    const work = mkdtempSync(join(tmpdir(), "ainb-jnb-"));
    writeFileSync(
      join(work, "e2e.ipynb"),
      JSON.stringify({
        cells: [
          { cell_type: "markdown", id: "intro", metadata: {}, source: ["# E2E"] },
          { cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["x = 41\n", "print(x + 1)"] },
        ],
        metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    jupyter = spawn(
      JUPYTER,
      ["notebook", "--no-browser", `--port=${JUPYTER_PORT}`, "--IdentityProvider.token=e2e", "--JupyterNotebookApp.expose_app_in_browser=True"],
      { cwd: work, stdio: "ignore" },
    );
    await waitHttp(`http://localhost:${JUPYTER_PORT}/api/status?token=e2e`, 60_000);
  }

  ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1400, height: 1000 },
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;
}, 120_000);

afterAll(async () => {
  await ctx?.close();
  bridge?.kill();
  if (jupyter?.pid) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(jupyter.pid), "/T", "/F"], { stdio: "ignore" });
    else jupyter.kill();
  }
});

async function tabIdOf(page: Page): Promise<number> {
  const sw = ctx.serviceWorkers()[0]!;
  const url = page.url();
  return sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)!.id!;
  }, url);
}

async function openPanel(notebookPage: Page): Promise<Page> {
  const tabId = await tabIdOf(notebookPage);
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  // Either the setup screen or, once paired, the main view.
  await panel.locator(".setup, .app").first().waitFor({ timeout: 30_000 });
  if (await panel.locator(".setup").count()) {
    // No native host in this browser: pair by hand.
    await panel.getByText("Connect with a pairing token instead").click();
    await panel.getByPlaceholder("from the bridge's console").fill(TOKEN);
    await panel.getByLabel("Port").fill(String(PORT));
    await panel.getByRole("button", { name: "Connect" }).click();
  }
  await panel.getByLabel("Agent").selectOption("fake");
  return panel;
}

async function send(panel: Page, text: string) {
  const box = panel.getByPlaceholder(/Ask about this notebook|Queue a follow-up/);
  await box.fill(text);
  const sendButton = panel.getByRole("button", { name: "Send", exact: true });
  if (await sendButton.count()) await expect.poll(() => sendButton.isEnabled(), { timeout: 120_000 }).toBe(true);
  await box.press("Enter");
}

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

describe.skipIf(!RUN)("Colab", () => {
  let nb: Page;
  let panel: Page;
  const dumpOnFailure = (name: string) =>
    onTestFailed(async () => {
      await panel?.screenshot({ path: `test/debug/fail-${name}-panel.png` }).catch(() => {});
      await nb?.screenshot({ path: `test/debug/fail-${name}-nb.png` }).catch(() => {});
    });

  it("attaches to a Colab notebook and pairs with the bridge", async () => {
    nb = await ctx.newPage();
    await nb.goto(COLAB, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await nb.waitForFunction(() => (window as any).colab?.global?.notebook?.cells?.length > 0, null, { timeout: 120_000 });
    panel = await openPanel(nb);
    await expect.poll(() => panel.locator(".top-title").textContent(), { timeout: 60_000 }).toContain("Colab");
    await expect.poll(() => panel.locator(".top-title").textContent()).toContain("colab-github-demo.ipynb");
  }, 300_000);

  it("lets the agent read and write cells", async () => {
    dumpOnFailure("write");
    const before = await nb.evaluate(() => (window as any).colab.global.notebook.cells.length);
    await panel.getByRole("radio", { name: "Write" }).click();
    await panel.getByLabel("Review").uncheck();
    await send(
      panel,
      script([
        { tool: "list_cells", args: {} },
        { tool: "insert_cell", args: { cell_type: "code", source: "print('from agent')", index: 1 } },
        { tool: "insert_cell", args: { cell_type: "markdown", source: "## Added by the agent", index: 1 } },
      ]),
    );
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 60_000 }).toContain("RESULT insert_cell: Inserted markdown cell");
    const cells = await nb.evaluate(() => (window as any).colab.global.notebook.cells.map((c: any) => [c.getType(), c.getText()]));
    expect(cells.length).toBe(before + 2);
    expect(cells[1]).toEqual(["text", "## Added by the agent"]);
    expect(cells[2]).toEqual(["code", "print('from agent')"]);
    // The fake agent writes a line after each call, so no two calls are adjacent and none are grouped.
    await expect.poll(() => panel.locator(".tool-title").first().textContent()).toBe("notebook · list_cells");
  }, 120_000);

  it("inserts a code block from the transcript as a cell below the selected one", async () => {
    dumpOnFailure("insert");
    const before = await nb.evaluate(() => (window as any).colab.global.notebook.cells.length);
    await send(panel, script([{ say: "Try this:\n\n```python\nprint('from the panel')\n```\n" }]));
    const block = panel.locator(".msg.agent").last().locator(".code");
    await block.waitFor({ timeout: 30_000 });
    expect(await block.locator(".code-lang").textContent()).toBe("python");
    await block.getByRole("button", { name: "Insert as cell" }).click();
    await expect.poll(() => nb.evaluate(() => (window as any).colab.global.notebook.cells.length), { timeout: 30_000 }).toBe(before + 1);
    const texts = await nb.evaluate(() => (window as any).colab.global.notebook.cells.map((c: any) => c.getText()));
    expect(texts).toContain("print('from the panel')");
  }, 120_000);

  it("undoes the agent's changes to the notebook from the side panel", async () => {
    dumpOnFailure("undo");
    const texts = () => nb.evaluate(() => (window as any).colab.global.notebook.cells.map((c: any) => c.getText()));
    const before = await texts();
    const cellId = await nb.evaluate(() => (window as any).colab.global.notebook.cells[1].getId());
    await send(
      panel,
      script([
        { tool: "update_cell", args: { cell_id: cellId, source: "print('to be undone')" } },
        { tool: "insert_cell", args: { cell_type: "markdown", source: "## temporary", index: 0 } },
      ]),
    );
    const changes = panel.locator(".msg.agent").last().locator(".changes");
    await expect.poll(() => changes.textContent(), { timeout: 60_000 }).toContain("2 notebook changes");
    expect((await texts()).length).toBe(before.length + 1);
    await changes.getByRole("button", { name: "Undo", exact: true }).click();
    await changes.getByRole("button", { name: "Undo", exact: true }).click(); // confirm
    await expect.poll(texts, { timeout: 30_000 }).toEqual(before);
    await expect.poll(() => changes.textContent()).toContain("undone");
  }, 120_000);

  it("shows a change in Colab's inline diff and applies it from the side panel", async () => {
    await panel.getByLabel("Review").check();
    const cellId = await nb.evaluate(() => (window as any).colab.global.notebook.cells[2].getId());
    await send(panel, script([{ tool: "update_cell", args: { cell_id: cellId, source: "print('reviewed')" } }]));
    // Colab's own Accept / Reject UI appears in the cell...
    await nb.locator("colab-inline-cell-diff").waitFor({ timeout: 30_000 });
    // ...and the same review appears in the side panel.
    const card = panel.locator(".card.review.pending");
    await card.waitFor({ timeout: 30_000 });
    expect(await card.locator(".row.a").first().textContent()).toContain("print('reviewed')");
    await card.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 30_000 }).toContain("the user accepted the change");
    expect(await nb.locator("colab-inline-cell-diff").count()).toBe(0);
    expect(await nb.evaluate((id) => (window as any).colab.global.notebook.cells.find((c: any) => c.getId() === id).getText(), cellId)).toBe("print('reviewed')");
    await expect.poll(() => panel.locator(".badge.accepted").count()).toBe(1);
  }, 120_000);

  it("rejects from Colab's own buttons and removes a rejected new cell", async () => {
    const count = await nb.evaluate(() => (window as any).colab.global.notebook.cells.length);
    await send(panel, script([{ tool: "insert_cell", args: { cell_type: "code", source: "rejected = True", index: 0 } }]));
    const diff = nb.locator("colab-inline-cell-diff");
    await diff.waitFor({ timeout: 30_000 });
    expect(await nb.evaluate(() => (window as any).colab.global.notebook.cells.length)).toBe(count + 1);
    await diff.getByRole("button", { name: "Reject" }).click();
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 30_000 }).toContain("REJECTED");
    expect(await nb.evaluate(() => (window as any).colab.global.notebook.cells.length)).toBe(count);
    await expect.poll(() => panel.locator(".badge.rejected").count()).toBe(1);
  }, 120_000);

  it("refuses to run cells outside Autonomous mode", async () => {
    const cellId = await nb.evaluate(() => (window as any).colab.global.notebook.cells.find((c: any) => c.getType() === "code").getId());
    await send(panel, script([{ tool: "run_cells", args: { cell_ids: [cellId] } }]));
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 30_000 }).toContain("running cells is not allowed");
  }, 60_000);
});

describe.skipIf(!RUN || !JUPYTER)("Jupyter (Kaggle's editor)", () => {
  let nb: Page;
  let panel: Page;

  it("attaches, edits, runs, and reviews with the inline card", async () => {
    nb = await ctx.newPage();
    await nb.goto(`http://localhost:${JUPYTER_PORT}/notebooks/e2e.ipynb?token=e2e`, { waitUntil: "domcontentloaded" });
    panel = await openPanel(nb);
    await expect.poll(() => panel.locator(".top-title").textContent(), { timeout: 60_000 }).toContain("e2e.ipynb");
    const model = panel.getByLabel("Model", { exact: true });
    await expect.poll(() => model.isEnabled(), { timeout: 30_000 }).toBe(true);
    expect(await panel.locator(".msg.user").count()).toBe(0);
    await model.selectOption("smart");
    await panel.getByRole("radio", { name: "Autonomous" }).click();
    await panel.getByLabel("Review").uncheck();

    await send(
      panel,
      "ECHO_MODEL\n" + script([
        { tool: "edit_cell", args: { cell_id: "calc", old_text: "41", new_text: "99" } },
        { tool: "run_cells", args: { cell_ids: ["calc"] } },
        { tool: "insert_cell", args: { cell_type: "code", source: "raise ValueError('nope')", after_cell_id: "calc" } },
        { tool: "run_all", args: {} },
      ]),
    );
    const last = () => panel.locator(".msg.agent").last().textContent();
    await expect.poll(last, { timeout: 90_000 }).toContain("RESULT run_all");
    const text = (await last())!;
    expect(text).toContain("[model smart]");
    expect(text).toMatch(/RESULT run_cells: cell calc: ok \(exec 1\)\s*100/);
    expect(text).toContain("[error] ValueError: nope");
    const src = await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets.map((w: any) => w.model.sharedModel.getSource()));
    expect(src).toEqual(["# E2E", "x = 99\nprint(x + 1)", "raise ValueError('nope')"]);

    // Review: our card appears in the cell; accepting in the page applies it.
    await panel.getByLabel("Review").check();
    await send(panel, script([{ tool: "update_cell", args: { cell_id: "calc", source: "x = 1\nprint(x)" } }]));
    const card = nb.locator(".ainb-review");
    await card.waitFor({ timeout: 30_000 });
    expect(await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets[1].model.sharedModel.getSource())).toBe("x = 99\nprint(x + 1)");
    await card.getByRole("button", { name: "Accept" }).click();
    await expect.poll(last, { timeout: 30_000 }).toContain("the user accepted the change");
    expect(await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets[1].model.sharedModel.getSource())).toBe("x = 1\nprint(x)");
    expect(await card.count()).toBe(0);

    // Editing a cell while a review waits must preserve the user's new source.
    await send(panel, script([{ tool: "update_cell", args: { cell_id: "calc", source: "x = 2\nprint(x)" } }]));
    await card.waitFor({ timeout: 30_000 });
    await nb.evaluate(() => {
      const cell = (window as any).jupyterapp.shell.currentWidget.content.widgets.find((w: any) => w.model.id === "calc");
      cell.model.sharedModel.setSource("x = 7\nprint(x) # user edit");
      // Apply in the same task, before the review's conflict polling runs.
      (document.querySelector(".ainb-review")!.shadowRoot!.querySelector("button.accept") as HTMLButtonElement).click();
    });
    await expect.poll(last, { timeout: 30_000 }).toContain("REJECTED");
    expect(await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets.find((w: any) => w.model.id === "calc").model.sharedModel.getSource())).toBe("x = 7\nprint(x) # user edit");
    expect(await card.count()).toBe(0);

    // Review on + Autonomous: a run waits for permission.
    await send(panel, script([{ tool: "run_cells", args: { cell_ids: ["calc"] } }]));
    const prompt = panel.locator(".card.prompt.waiting");
    await prompt.waitFor({ timeout: 30_000 });
    await prompt.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(last, { timeout: 60_000 }).toContain("cell calc: ok");
  }, 240_000);

  it("manages a custom ACP command and selects its model before chatting", async () => {
    await panel.getByRole("button", { name: "Manage agents", exact: true }).click();
    const dialog = panel.getByRole("dialog");
    const launchCommand = formatLaunchCommand(process.execPath, [FAKE_AGENT]);
    await dialog.getByLabel("Name (optional)").fill("Browser custom ACP");
    await dialog.getByLabel("Launch command").fill(launchCommand);
    await dialog.getByRole("button", { name: "Test connection" }).click();
    await expect.poll(() => dialog.getByRole("status").textContent(), { timeout: 30_000 }).toContain("Connected");
    await dialog.getByRole("button", { name: "Add agent", exact: true }).click();
    await expect.poll(() => panel.getByLabel("Agent", { exact: true }).locator("option:checked").textContent(), { timeout: 30_000 }).toBe("Browser custom ACP");
    const model = panel.getByLabel("Model", { exact: true });
    await expect.poll(() => model.isEnabled(), { timeout: 30_000 }).toBe(true);
    await model.selectOption("smart");
    await send(panel, "ECHO_MODEL custom first prompt");
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 30_000 }).toContain("[model smart]");
    await panel.getByRole("button", { name: "Manage agents", exact: true }).click();
    const row = dialog.locator(".manager-agent").filter({ hasText: "Browser custom ACP" });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await dialog.getByLabel("Name (optional)").fill("Renamed browser ACP");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => panel.getByLabel("Agent", { exact: true }).locator("option:checked").textContent()).toBe("Renamed browser ACP");
    await expect.poll(() => model.isEnabled(), { timeout: 30_000 }).toBe(true);
    await panel.getByRole("button", { name: "Manage agents", exact: true }).click();
    await dialog.locator(".manager-agent").filter({ hasText: "Renamed browser ACP" }).getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => panel.getByLabel("Agent", { exact: true }).locator("option").allTextContents()).not.toContain("Renamed browser ACP");
    await dialog.getByRole("button", { name: "Close agent manager" }).click();
  }, 120_000);
});
