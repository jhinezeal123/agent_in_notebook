// Tool results stay small and correct: shortened outputs, run budgets,
// read_output, data URIs kept through edits, and parallel edits serialized.

import { describe, expect, it } from "vitest";
import type { NotebookOp } from "@ainb/protocol";
import { callTool, RUN_BUDGET } from "../src/notebook/tools.js";
import { FakeNotebook } from "./fixtures/fake-extension.js";
import { context } from "./fixtures/tool-context.js";

function noisyLog(lines: number, tag = "") {
  return Array.from({ length: lines }, (_, i) => `${tag}step ${i + 1}/${lines} loss=${(1 / (i + 1)).toFixed(5)}`).join("\n") + "\n";
}

describe("long outputs", () => {
  it("shortens a long output, points to read_output, which pages and searches it", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "train()" }]);
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: noisyLog(3000) }];
    const ctx = context(nb);
    const read = await callTool(ctx, "Read", { file_path: "test.ipynb" });
    expect(read.text.length).toBeLessThan(7000);
    expect(read.text).toContain("read_output with this cell id");

    const page = await callTool(ctx, "read_output", { cell_id: "c1", start_line: 1500, line_count: 3 });
    expect(page.text).toBe("Lines 1500-1502 of 3000. Continue with start_line=1503.\n1500: step 1500/3000 loss=0.00067\n1501: step 1501/3000 loss=0.00067\n1502: step 1502/3000 loss=0.00067");

    const found = await callTool(ctx, "read_output", { cell_id: "c1", pattern: "step 2222/", context_lines: 1 });
    expect(found.text).toBe("1 matching line of 3000.\n2221: step 2221/3000 loss=0.00045\n2222: step 2222/3000 loss=0.00045\n2223: step 2223/3000 loss=0.00045");

    // An invalid regular expression is searched for literally.
    expect((await callTool(ctx, "read_output", { cell_id: "c1", pattern: "loss=(" })).text).toMatch(/^No line/);
  });

  it("keeps a run of many noisy cells within the run budget", async () => {
    const nb = new FakeNotebook(Array.from({ length: 40 }, (_, i) => ({ type: "code" as const, source: `cell${i}` })));
    // Every cell prints a long log when it runs.
    const handle = nb.handle.bind(nb);
    nb.handle = (op: NotebookOp) => {
      const r = handle(op) as any;
      if (op.op === "run_cells") for (const res of r.results) res.outputs = [{ kind: "stream", name: "stdout", text: noisyLog(400, `${res.cellId} `) }];
      return r;
    };
    const res = await callTool(context(nb), "run_all", {});
    expect(res.text.length).toBeLessThan(RUN_BUDGET + 8000);
    // Every cell is still reported.
    for (let i = 1; i <= 40; i++) expect(res.text).toContain(`cell c${i}: ok`);
  });
});

describe("edits", () => {
  it("shows pasted images as marks and keeps them through Edit and NotebookEdit", async () => {
    const b64 = "iVBORw0KGgo".repeat(500);
    const nb = new FakeNotebook([{ type: "markdown", source: `# Plot\n![p](data:image/png;base64,${b64})\nold words` }]);
    const ctx = context(nb);
    const read = await callTool(ctx, "Read", { file_path: "/content/test.ipynb" });
    expect(read.text).not.toContain(b64.slice(0, 50));
    expect(read.text).toContain("[[ainb:data-1 4 KB hidden]]");

    await callTool(ctx, "Edit", { file_path: "test.ipynb", old_string: "old words", new_string: "new words" });
    expect(nb.cells[0]!.source).toBe(`# Plot\n![p](data:image/png;base64,${b64})\nnew words`);

    await callTool(ctx, "NotebookEdit", { notebook_path: "test.ipynb", cell_id: "c1", new_source: "# Plot (v2)\n![p](data:image/png;base64,[[ainb:data-1 4 KB hidden]])" });
    expect(nb.cells[0]!.source).toBe(`# Plot (v2)\n![p](data:image/png;base64,${b64})`);
  });

  it("applies parallel edits of one cell one after another, so none is lost", async () => {
    const run = async (locks: boolean) => {
      const nb = new FakeNotebook([{ type: "code", source: "a = 1\nb = 2\nc = 3" }]);
      const ctx = context(nb, { latency: 5, locks });
      await Promise.all([
        callTool(ctx, "Edit", { file_path: "test.ipynb", old_string: "a = 1", new_string: "a = 10" }),
        callTool(ctx, "Edit", { file_path: "test.ipynb", old_string: "b = 2", new_string: "b = 20" }),
        callTool(ctx, "Edit", { file_path: "test.ipynb", old_string: "c = 3", new_string: "c = 30" }),
      ]);
      return nb.cells[0]!.source;
    };
    // Without the lock, each edit reads the original source and the last write wins.
    expect(await run(false)).not.toBe("a = 10\nb = 20\nc = 30");
    expect(await run(true)).toBe("a = 10\nb = 20\nc = 30");
  });
});

describe("the terminal on the notebook's machine", () => {
  const long = { waitMs: 60_000 };

  it("runs commands in one persistent session and reports exit codes, adding no cell", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    const ctx = context(nb, { overrides: long });
    const first = await callTool(ctx, "Bash", { command: "echo hello" });
    expect(first.isError).toBeUndefined();
    expect(first.text).toMatch(/^exit code 0 · \d+\.\d s\nhello$/);
    const failed = await callTool(ctx, "Bash", { command: "fail" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/^exit code 1 · .*\nboom$/);
    // One shell for both: opened once, the setup typed once.
    expect(nb.vm.ops.filter((o) => o === "open")).toEqual(["open"]);
    expect(nb.vm.commands).toEqual(["echo hello", "fail"]);
    expect(nb.cells).toHaveLength(1);
  });

  it("shows what the screen shows: a progress bar in its final state", async () => {
    const nb = new FakeNotebook([]);
    const res = await callTool(context(nb, { overrides: long }), "Bash", { command: "progress" });
    expect(res.text).toMatch(/^exit code 0 · .*\n100%\|##########\| 100\/100\nDone$/);
  });

  it("lets a long command keep running: wait, answer a prompt, interrupt", async () => {
    const nb = new FakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const started = await callTool(ctx, "Bash", { command: "forever", wait_seconds: 1 });
    expect(started.isError).toBeUndefined();
    expect(started.text).toMatch(/^still running after \d+\.\d s\. It keeps running: shell_wait.*\nworking\.\.\.$/);
    // The session is busy; another one is free.
    const busy = await callTool(ctx, "Bash", { command: "echo hi" });
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/Session "main" is still running `forever`/);
    expect((await callTool(ctx, "Bash", { command: "echo side", session: "other" })).text).toMatch(/^exit code 0 · .* · session other\nside$/);
    // Waiting again shows only the line still being written, not the whole output again.
    expect((await callTool(ctx, "shell_wait", { wait_seconds: 1 })).text).toMatch(/^still running after .*\n\(no output\)$/);
    const stopped = await callTool(ctx, "shell_interrupt", {});
    expect(stopped.text).toMatch(/^exit code 130 \(interrupted\) · .*\n\^C$/);

    const asked = await callTool(ctx, "Bash", { command: "ask", wait_seconds: 1 });
    expect(asked.text).toMatch(/still running.*\nContinue\? \[y\/N\]$/);
    const answered = await callTool(ctx, "shell_input", { text: "y" });
    // The answer shows as typed, the way a terminal echoes it.
    expect(answered.text).toMatch(/^exit code 0 · .*\nContinue\? \[y\/N\] y\nok$/);
    expect((await callTool(ctx, "shell_input", { text: "y" })).text).toMatch(/Nothing is running in session "main"/);
  });

  it("reports what background jobs printed between commands", async () => {
    const nb = new FakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "Bash", { command: "echo started" });
    nb.vm.background("main", "server listening on :8000\r\n");
    const res = await callTool(ctx, "Bash", { command: "echo next" });
    expect(res.text).toMatch(/^exit code 0 · .*\n\(printed in the terminal before this command, by background jobs:\)\nserver listening on :8000\n\(the command's output:\)\nnext$/);
    nb.vm.background("main", "GET / 200\r\n");
    expect((await callTool(ctx, "shell_wait", {})).text).toBe("idle\n(printed in the terminal before this command, by background jobs:)\nGET / 200\n(the command's output:)");
  });

  it("keeps a long output for read_output", async () => {
    const nb = new FakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const res = await callTool(ctx, "Bash", { command: "lines 3000" });
    expect(res.text.length).toBeLessThan(10_300);
    expect(res.text).toContain("line 3000");
    expect(res.text).toContain('read_output with cell_id "run-1"');
    expect((await callTool(ctx, "read_output", { cell_id: "run-1", pattern: "^line 1234$", context_lines: 0 })).text).toBe("1 matching line of 3000.\n1234: line 1234");
  });

  it("notices when the shell exits and starts a new one next time", async () => {
    const nb = new FakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    expect((await callTool(ctx, "Bash", { command: "exit 3" })).text).toMatch(/^the shell exited \(exit code 3\); the next Bash call starts a new one/);
    expect((await callTool(ctx, "Bash", { command: "echo again" })).text).toMatch(/^exit code 0 · .*\nagain$/);
    expect(nb.vm.ops.filter((o) => o === "open")).toHaveLength(2);
  });

  it("picks up a session that runs from before the bridge restarted", async () => {
    const nb = new FakeNotebook([]);
    await callTool(context(nb, { overrides: long }), "Bash", { command: "forever", wait_seconds: 1 });
    // A new bridge: no sessions in memory, the shell still runs on the machine.
    const fresh = context(nb, { overrides: long });
    const waited = await callTool(fresh, "shell_wait", { wait_seconds: 1 });
    expect(waited.text).toMatch(/^still running after .*\nworking\.\.\.$/);
    expect((await callTool(fresh, "shell_interrupt", {})).text).toMatch(/^exit code 130/);
  });

  it("is refused outside Autonomous mode, and asks first with review on", async () => {
    const nb = new FakeNotebook([]);
    for (const [tool, args] of [["Bash", { command: "ls" }], ["run_code", { code: "1" }], ["shell_input", { text: "y" }], ["Write", { file_path: "a.txt", content: "x" }]] as const) {
      const res = await callTool(context(nb, { settings: { scope: "write" } }), tool, args);
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/commands, code and changes to files on the notebook's machine are not allowed/);
    }
    const asked: [string, string | undefined][] = [];
    const ctx = context(nb, {
      settings: { review: true },
      overrides: { ...long, confirmRun: async (summary, detail) => (asked.push([summary, detail]), false) },
    });
    expect((await callTool(ctx, "Bash", { command: "rm -rf /content/tmp" })).text).toMatch(/declined/);
    expect(asked).toEqual([["Run in the notebook machine's terminal", "rm -rf /content/tmp"]]);
    expect(nb.vm.commands).toHaveLength(0);
  });

  it("needs a Python kernel to reach the machine", async () => {
    const nb = new FakeNotebook([]);
    nb.language = "R";
    expect((await callTool(context(nb, { overrides: long }), "Bash", { command: "ls" })).text).toMatch(/Python kernel.*system\(\) in R/);
  });
});

describe("run_code", () => {
  const long = { waitMs: 60_000 };

  it("runs a snippet in the kernel's namespace", async () => {
    const nb = new FakeNotebook([]);
    const res = await callTool(context(nb, { overrides: long }), "run_code", { code: "df.shape" });
    expect(res.text).toBe("ok\n42");
    expect(nb.executed[0]!.code).toBe("df.shape");
    nb.execResult = () => ({ status: "error", outputs: [{ kind: "error", ename: "NameError", evalue: "name 'df' is not defined", traceback: "NameError: name 'df' is not defined" }] });
    const failed = await callTool(context(nb, { overrides: long }), "run_code", { code: "df.shape" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("[error] NameError: name 'df' is not defined");
  });

  it("never stops code that runs long: it hands out a run id to wait on", async () => {
    const nb = new FakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    nb.execResult = () => ({ status: "running", execId: "exec-7", outputs: [{ kind: "stream", name: "stdout", text: "epoch 1\n" }] });
    nb.execWaits.set("exec-7", [
      { status: "running", execId: "exec-7", outputs: [{ kind: "stream", name: "stdout", text: "epoch 1\nepoch 2\n" }] },
      { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: "epoch 1\nepoch 2\ndone\n" }] },
    ]);
    const res = await callTool(ctx, "run_code", { code: "train()", wait_seconds: 5 });
    expect(res.text).toMatch(/^still running after .* \(run id exec-7\)\. The kernel stays busy until it ends: wait_for_code.*\nepoch 1$/);
    expect(nb.executed[0]!.waitMs).toBe(5000);
    expect((await callTool(ctx, "wait_for_code", { run_id: "exec-7" })).text).toMatch(/^still running.*\nepoch 1\nepoch 2$/);
    expect((await callTool(ctx, "wait_for_code", { run_id: "exec-7" })).text).toBe("ok\nepoch 1\nepoch 2\ndone");
  });

  it("is refused while the kernel is busy", async () => {
    const nb = new FakeNotebook([]);
    nb.busy = true;
    const busy = await callTool(context(nb, { overrides: long }), "run_code", { code: "1" });
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/kernel is busy/);
  });
});

describe("playbook", () => {
  it("tells the agent up front that on Colab the machine waits for a running cell, and not on Kaggle", async () => {
    const { playbook } = await import("../src/instructions.js");
    const nb = new FakeNotebook([]);
    const note = "while a cell runs they wait for it";
    expect(playbook(nb.info())).toContain(note);
    nb.platform = "kaggle";
    nb.serverTerminals = true;
    expect(playbook(nb.info())).not.toContain(note);
  });
});
