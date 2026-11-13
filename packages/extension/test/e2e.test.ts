// End-to-end in a real browser: Chromium with the built extension, the built
// bridge, the scripted fake agent, and real notebooks (public Colab page; a
// local Jupyter Notebook 7, which is what Kaggle embeds). The chat is the
// real chat UI with VS Code's host logic for Chrome tabs (panel-harness.ts),
// in a page of its own, as the VS Code sidebar would show it.
//
//   E2E=1 [AINB_E2E_JUPYTER=<path to jupyter executable>] pnpm --filter @ainb/extension exec vitest run test/e2e.test.ts
//
// Running cells on Colab needs a signed-in runtime, so Colab covers editing and
// review; Jupyter covers running. The terminal tools need a Linux or macOS
// kernel machine (like Colab's and Kaggle's); on Windows, point the test at a
// Jupyter in a Linux container instead (token "e2e", app exposed in the browser):
//
//   docker run -d --rm --name ainb-jnb -p 8899:8888 python:3.12-slim bash -c \
//     "pip install -q 'notebook>=7,<8' && jupyter notebook --ip=0.0.0.0 --allow-root --no-browser \
//      --IdentityProvider.token=e2e --JupyterNotebookApp.expose_app_in_browser=True"
//   E2E=1 AINB_E2E_JUPYTER_URL=http://localhost:8899 pnpm --filter @ainb/extension exec vitest run test/e2e.test.ts

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { formatLaunchCommand } from "@ainb/protocol";
import { openPanel as openChatPanel, pickNotebook } from "./panel-harness.js";

const RUN = !!process.env.E2E;
const JUPYTER = process.env.AINB_E2E_JUPYTER;
/** A Jupyter server already running (token "e2e"); the test notebook is uploaded to it. */
const JUPYTER_URL = process.env.AINB_E2E_JUPYTER_URL?.replace(/\/$/, "");
const ROOT = resolve(__dirname, "../../..");
const EXT = resolve(__dirname, "../dist");
const CLI = resolve(ROOT, "packages/bridge/dist/cli.js");
const FAKE_AGENT = resolve(ROOT, "packages/bridge/test/fixtures/fake-agent.mjs");
const TOKEN = "e2e-token-0123456789abcdef";
const PORT = 47900 + Math.floor(Math.random() * 90);
const JUPYTER_PORT = 8890 + Math.floor(Math.random() * 9);
const JUPYTER_BASE = JUPYTER_URL ?? `http://localhost:${JUPYTER_PORT}`;
const TEST_NOTEBOOK = {
  cells: [
    { cell_type: "markdown", id: "intro", metadata: {}, source: ["# E2E"] },
    { cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["x = 41\n", "print(x + 1)"] },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
};
const COLAB = "https://colab.research.google.com/github/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb";

let bridge: ChildProcess | null = null;
let jupyter: ChildProcess | null = null;
let ctx: BrowserContext;

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

  if (JUPYTER_URL) {
    await waitHttp(`${JUPYTER_URL}/api/status?token=e2e`, 180_000);
    // A fresh copy of the test notebook, and no kernel left from an earlier run.
    const kernels = (await (await fetch(`${JUPYTER_URL}/api/sessions?token=e2e`)).json()) as { id: string }[];
    for (const k of kernels) await fetch(`${JUPYTER_URL}/api/sessions/${k.id}?token=e2e`, { method: "DELETE" });
    const put = await fetch(`${JUPYTER_URL}/api/contents/e2e.ipynb?token=e2e`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "notebook", format: "json", content: TEST_NOTEBOOK }),
    });
    if (!put.ok) throw new Error(`could not upload the test notebook: HTTP ${put.status}`);
  } else if (JUPYTER) {
    const work = mkdtempSync(join(tmpdir(), "ainb-jnb-"));
    writeFileSync(join(work, "e2e.ipynb"), JSON.stringify(TEST_NOTEBOOK));
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
  // Pair by hand with this test's bridge, before any notebook opens: a native host
  // registered on this machine (`ainb install`) would start and pair with the user's own.
  await sw.evaluate(([port, token]) => chrome.storage.local.set({ config: { port, token, source: "manual" } }), [PORT, TOKEN] as const);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
  bridge?.kill();
  if (jupyter?.pid) {
    // Synchronously: the worker exits right after afterAll, which would leave the server and its kernel running.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(jupyter.pid), "/T", "/F"], { stdio: "ignore" });
    else jupyter.kill();
  }
});

/** The chat panel, about the notebook titled `title` that is open in a Chrome tab. */
async function openPanel(title: string): Promise<Page> {
  const panel = await openChatPanel(ctx, PORT, TOKEN);
  await panel.locator(".setup, .app").first().waitFor({ timeout: 30_000 });
  await panel.locator(".app").waitFor({ timeout: 30_000 });
  await pickNotebook(panel, title);
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
    panel = await openPanel("colab-github-demo.ipynb");
    await expect.poll(() => panel.locator(".top-title").textContent(), { timeout: 60_000 }).toContain("Colab");
    await expect.poll(() => panel.locator(".top-title").textContent()).toContain("colab-github-demo.ipynb");
  }, 300_000);

  it("lets the agent read and write cells", async () => {
    dumpOnFailure("write");
    const before = await nb.evaluate(() => (window as any).colab.global.notebook.cells.length);
    const first = await nb.evaluate(() => (window as any).colab.global.notebook.cells[0].getId());
    await panel.getByRole("radio", { name: "Write" }).click();
    await panel.getByLabel("Review").uncheck();
    // No runtime is connected: the notebook is still worked on as its file.
    await send(
      panel,
      script([
        { tool: "Read", args: { file_path: "colab-github-demo.ipynb" } },
        { tool: "NotebookEdit", args: { notebook_path: "colab-github-demo.ipynb", cell_id: first, edit_mode: "insert", cell_type: "code", new_source: "print('from agent')" } },
        { tool: "NotebookEdit", args: { notebook_path: "colab-github-demo.ipynb", cell_id: first, edit_mode: "insert", cell_type: "markdown", new_source: "## Added by the agent" } },
      ]),
    );
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 60_000 }).toContain("RESULT NotebookEdit: Applied: new markdown cell");
    expect(await panel.locator(".msg.agent").last().textContent()).toContain("RESULT Read: /content/colab-github-demo.ipynb: the notebook open in the browser");
    const cells = await nb.evaluate(() => (window as any).colab.global.notebook.cells.map((c: any) => [c.getType(), c.getText()]));
    expect(cells.length).toBe(before + 2);
    expect(cells[1]).toEqual(["text", "## Added by the agent"]);
    expect(cells[2]).toEqual(["code", "print('from agent')"]);
    // The fake agent writes a line after each call, so no two calls are adjacent and none are grouped.
    await expect.poll(() => panel.locator(".tool-title").first().textContent()).toBe("notebook · Read");
  }, 120_000);

  it("inserts a code block from the transcript as a cell below the selected one", async () => {
    dumpOnFailure("insert");
    const before = await nb.evaluate(() => (window as any).colab.global.notebook.cells.length);
    await send(panel, script([{ say: "Try this:\n\n```python\nprint('from the panel')\n```\n" }]));
    const block = panel.locator(".msg.agent").filter({ hasText: "Try this:" }).last().locator(".code");
    await block.waitFor({ timeout: 30_000 });
    expect(await block.locator(".code-lang").textContent()).toBe("python");
    await block.getByRole("button", { name: "Insert as cell" }).click();
    await expect.poll(() => nb.evaluate(() => (window as any).colab.global.notebook.cells.length), { timeout: 30_000 }).toBe(before + 1);
    const texts = await nb.evaluate(() => (window as any).colab.global.notebook.cells.map((c: any) => c.getText()));
    expect(texts).toContain("print('from the panel')");
  }, 120_000);

  it("undoes the agent's changes to the notebook from the chat", async () => {
    dumpOnFailure("undo");
    const texts = () => nb.evaluate(() => (window as any).colab.global.notebook.cells.map((c: any) => c.getText()));
    const before = await texts();
    const cellId = await nb.evaluate(() => (window as any).colab.global.notebook.cells[1].getId());
    await send(
      panel,
      script([
        { tool: "NotebookEdit", args: { notebook_path: "colab-github-demo.ipynb", cell_id: cellId, new_source: "print('to be undone')" } },
        { tool: "NotebookEdit", args: { notebook_path: "colab-github-demo.ipynb", edit_mode: "insert", cell_type: "markdown", new_source: "## temporary" } },
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

  it("shows a change in Colab's inline diff and applies it from the chat", async () => {
    await panel.getByLabel("Review").check();
    const cellId = await nb.evaluate(() => (window as any).colab.global.notebook.cells[2].getId());
    await send(panel, script([{ tool: "NotebookEdit", args: { notebook_path: "colab-github-demo.ipynb", cell_id: cellId, new_source: "print('reviewed')" } }]));
    // Colab's own Accept / Reject UI appears in the cell...
    await nb.locator("colab-inline-cell-diff").waitFor({ timeout: 30_000 });
    // ...and the same review appears in the chat.
    const card = panel.locator(".card.review.pending");
    await card.waitFor({ timeout: 30_000 });
    expect(await card.locator(".row.a").first().textContent()).toContain("print('reviewed')");
    await card.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => panel.locator(".msg.agent").last().textContent(), { timeout: 30_000 }).toContain("the user accepted it");
    expect(await nb.locator("colab-inline-cell-diff").count()).toBe(0);
    expect(await nb.evaluate((id) => (window as any).colab.global.notebook.cells.find((c: any) => c.getId() === id).getText(), cellId)).toBe("print('reviewed')");
    await expect.poll(() => panel.locator(".badge.accepted").count()).toBe(1);
  }, 120_000);

  it("rejects from Colab's own buttons and removes a rejected new cell", async () => {
    const count = await nb.evaluate(() => (window as any).colab.global.notebook.cells.length);
    await send(panel, script([{ tool: "NotebookEdit", args: { notebook_path: "colab-github-demo.ipynb", edit_mode: "insert", cell_type: "code", new_source: "rejected = True" } }]));
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

describe.skipIf(!RUN || !(JUPYTER || JUPYTER_URL))("Jupyter (Kaggle's editor)", () => {
  let nb: Page;
  let panel: Page;

  it("attaches, edits, runs, and reviews with the inline card", async () => {
    nb = await ctx.newPage();
    await nb.goto(`${JUPYTER_BASE}/notebooks/e2e.ipynb?token=e2e`, { waitUntil: "domcontentloaded" });
    panel = await openPanel("e2e.ipynb");
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
        { tool: "notebook_info", args: {} },
        { tool: "Edit", args: { file_path: "e2e.agent.ipynb", old_string: "41", new_string: "99" } },
        { tool: "run_cells", args: { cell_ids: ["calc"] } },
        { tool: "NotebookEdit", args: { notebook_path: "e2e.agent.ipynb", cell_id: "calc", edit_mode: "insert", cell_type: "code", new_source: "raise ValueError('nope')" } },
        { tool: "run_all", args: {} },
      ]),
    );
    const last = () => panel.locator(".msg.agent").last().textContent();
    await expect.poll(last, { timeout: 90_000 }).toContain("RESULT run_all");
    const text = (await last())!;
    expect(text).toContain("[model smart]");
    // The server's own copy of the notebook is left alone; the agent's file has another name.
    expect(text).toMatch(/Notebook file: \S*e2e\.agent\.ipynb/);
    expect(text).toMatch(/RESULT run_cells: cell calc: ok \(exec 1\)\s*100/);
    expect(text).toContain("[error] ValueError: nope");
    const src = await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets.map((w: any) => w.model.sharedModel.getSource()));
    expect(src).toEqual(["# E2E", "x = 99\nprint(x + 1)", "raise ValueError('nope')"]);

    // Review: our card appears in the cell; accepting in the page applies it.
    await panel.getByLabel("Review").check();
    await send(panel, script([{ tool: "NotebookEdit", args: { notebook_path: "e2e.agent.ipynb", cell_id: "calc", new_source: "x = 1\nprint(x)" } }]));
    const card = nb.locator(".ainb-review");
    await card.waitFor({ timeout: 30_000 });
    expect(await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets[1].model.sharedModel.getSource())).toBe("x = 99\nprint(x + 1)");
    await card.getByRole("button", { name: "Accept" }).click();
    await expect.poll(last, { timeout: 30_000 }).toContain("the user accepted it");
    expect(await nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets[1].model.sharedModel.getSource())).toBe("x = 1\nprint(x)");
    expect(await card.count()).toBe(0);

    // Editing a cell while a review waits must preserve the user's new source.
    await send(panel, script([{ tool: "NotebookEdit", args: { notebook_path: "e2e.agent.ipynb", cell_id: "calc", new_source: "x = 2\nprint(x)" } }]));
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

  it("works a terminal on the kernel's machine and runs code without adding a cell", async () => {
    const widgets = () => nb.evaluate(() => (window as any).jupyterapp.shell.currentWidget.content.widgets.map((w: any) => [w.model.id, w.model.sharedModel.getSource()]));
    const before = await widgets();
    const last = () => panel.locator(".msg.agent").last().textContent();

    // Review is still on: the approval shows the exact command.
    await send(panel, script([{ tool: "Bash", args: { command: "echo should-not-run" } }]));
    const prompt = panel.locator(".card.prompt.waiting");
    await prompt.waitFor({ timeout: 30_000 });
    expect(await prompt.locator(".card-detail").textContent()).toBe("echo should-not-run");
    await prompt.getByRole("button", { name: "Don't run", exact: true }).click();
    await expect.poll(last, { timeout: 30_000 }).toContain("The user declined to run this command");

    await panel.getByLabel("Review").uncheck();
    if (!JUPYTER_URL) {
      // This Jupyter runs here; on Windows the kernel's machine has no terminal sessions to offer.
      if (process.platform !== "win32") return;
      await send(panel, script([{ tool: "Bash", args: { command: "echo hi" } }]));
      await expect.poll(last, { timeout: 60_000 }).toContain("need a Linux or macOS machine");
      return;
    }
    await send(
      panel,
      script([
        { tool: "Bash", args: { command: "cd /tmp && export GREETING=hi && echo ready" } },
        { tool: "Bash", args: { command: 'pwd; echo "$GREETING"; exit_code_test() { return 3; }; exit_code_test' } },
        { tool: "Bash", args: { command: "sleep 3; echo late", wait_seconds: 1 } },
        { tool: "shell_wait", args: {} },
        { tool: "Bash", args: { command: "cd - >/dev/null && python3 -c \"import json; p='e2e.agent.ipynb'; nb=json.load(open(p)); nb['cells'][0]['source']=['# E2E (from a command)']; json.dump(nb, open(p, 'w'))\"" } },
        { tool: "run_code", args: { code: "x * 3" } },
        { tool: "run_code", args: { code: "import time\ntime.sleep(3)\nprint('woke')", wait_seconds: 1 }, capture: { id: "run id (exec-\\d+)" } },
        { tool: "wait_for_code", args: { run_id: "{{id}}" } },
      ]),
    );
    await expect.poll(last, { timeout: 120_000 }).toContain("RESULT wait_for_code");
    const text = (await last())!;
    expect(text).toMatch(/RESULT Bash: exit code 0 · \d+\.\d s\s*ready/);
    expect(text).toMatch(/The notebook file \S*e2e\.agent\.ipynb changed on the machine; this reached the notebook in the browser:\s*Applied: cell intro changed\./);
    expect(text).toMatch(/RESULT Bash \(error\): exit code 3 · [^\n]*\s*\/tmp\s*hi/);
    expect(text).toMatch(/RESULT Bash: still running after/);
    expect(text).toMatch(/RESULT shell_wait: exit code 0 · [3-9]\.\d s\s*late/);
    expect(text).toMatch(/RESULT run_code: ok\s*21/);
    expect(text).toMatch(/RESULT run_code: still running after [^\n]*\(run id exec-\d+\)/);
    expect(text).toMatch(/RESULT wait_for_code: ok\s*woke/);
    // The command's change reached the editor; nothing else changed, and no cell was added.
    const after = await widgets();
    expect(after[0]).toEqual(["intro", "# E2E (from a command)"]);
    expect(after.slice(1)).toEqual(before.slice(1));

    // While a cell keeps the kernel busy, the machine is still reached, through the server's terminal.
    await send(
      panel,
      script([
        {
          tool: "NotebookEdit",
          args: { notebook_path: "e2e.agent.ipynb", cell_id: "calc", edit_mode: "insert", cell_type: "code", new_source: "import time\ntime.sleep(25)\nprint('slept')" },
          capture: { cell: "new code cell ([\\w-]+) inserted" },
        },
        { tool: "run_cells", args: { cell_ids: ["{{cell}}"], timeout_seconds: 2 } },
        { tool: "Bash", args: { command: "echo while the cell runs" } },
        { tool: "Write", args: { file_path: "/tmp/during.txt", content: "written during the cell" } },
        { tool: "Read", args: { file_path: "/tmp/during.txt" } },
        { tool: "wait_for_cells", args: { cell_ids: ["{{cell}}"], timeout_seconds: 60 } },
      ]),
    );
    await expect.poll(last, { timeout: 120_000 }).toContain("RESULT wait_for_cells");
    const during = (await last())!;
    expect(during).toContain("Some cells are still running");
    expect(during).toMatch(/RESULT Bash: exit code 0 · [^\n]*\s*while the cell runs/);
    expect(during).toContain("RESULT Write: Wrote /tmp/during.txt (23 bytes).");
    expect(during).toMatch(/RESULT Read:\s*1\twritten during the cell/);
    expect(during).toMatch(/RESULT wait_for_cells: ### cell \[\d+\] id=[\w-]+ code exec=\d+\s*import time/);
    expect(during).toContain("slept");
    expect(during).not.toContain("kernel is busy");
  }, 300_000);

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
