// Tool results stay small and correct: shortened outputs, run budgets,
// read_output, data URIs kept through edits, and parallel edits serialized.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ChatSettings, type NotebookOp } from "@ainb/protocol";
import { callTool, RUN_BUDGET, type ToolContext } from "../src/notebook/tools.js";
import { FakeNotebook } from "./fixtures/fake-extension.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tool context on a FakeNotebook; `latency` makes ops slow enough for calls to overlap. */
function context(nb: FakeNotebook, opts: { settings?: Partial<ChatSettings>; latency?: number; locks?: boolean } = {}): ToolContext {
  const settings: ChatSettings = { ...DEFAULT_SETTINGS, scope: "auto", review: false, ...opts.settings };
  const locks = new Map<string, Promise<unknown>>();
  return {
    settings: () => settings,
    targets: () => [],
    call: async (op) => {
      if (opts.latency) await sleep(opts.latency);
      const r = nb.handle(op as NotebookOp);
      if (opts.latency) await sleep(opts.latency);
      return r as never;
    },
    awaitReview: async () => "pending",
    confirmRun: async () => true,
    waitMs: 10_000,
    images: false,
    exclusive: (lock, fn) => {
      if (opts.locks === false) return fn();
      const run = (locks.get(lock) ?? Promise.resolve()).then(fn, fn);
      locks.set(lock, run.catch(() => {}));
      return run;
    },
  };
}

function noisyLog(lines: number, tag = "") {
  return Array.from({ length: lines }, (_, i) => `${tag}step ${i + 1}/${lines} loss=${(1 / (i + 1)).toFixed(5)}`).join("\n") + "\n";
}

describe("long outputs", () => {
  it("shortens a long output, points to read_output, which pages and searches it", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "train()" }]);
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: noisyLog(3000) }];
    const ctx = context(nb);
    const read = await callTool(ctx, "read_cells", {});
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
  it("shows pasted images as marks and keeps them through edit_cell and update_cell", async () => {
    const b64 = "iVBORw0KGgo".repeat(500);
    const nb = new FakeNotebook([{ type: "markdown", source: `# Plot\n![p](data:image/png;base64,${b64})\nold words` }]);
    const ctx = context(nb);
    const read = await callTool(ctx, "read_cells", {});
    expect(read.text).not.toContain(b64.slice(0, 50));
    expect(read.text).toContain("[[ainb:data-1 4 KB hidden]]");

    await callTool(ctx, "edit_cell", { cell_id: "c1", old_text: "old words", new_text: "new words" });
    expect(nb.cells[0]!.source).toBe(`# Plot\n![p](data:image/png;base64,${b64})\nnew words`);

    await callTool(ctx, "update_cell", { cell_id: "c1", source: "# Plot (v2)\n![p](data:image/png;base64,[[ainb:data-1 4 KB hidden]])" });
    expect(nb.cells[0]!.source).toBe(`# Plot (v2)\n![p](data:image/png;base64,${b64})`);
  });

  it("applies parallel edits of one cell one after another, so none is lost", async () => {
    const run = async (locks: boolean) => {
      const nb = new FakeNotebook([{ type: "code", source: "a = 1\nb = 2\nc = 3" }]);
      const ctx = context(nb, { latency: 5, locks });
      await Promise.all([
        callTool(ctx, "edit_cell", { cell_id: "c1", old_text: "a = 1", new_text: "a = 10" }),
        callTool(ctx, "edit_cell", { cell_id: "c1", old_text: "b = 2", new_text: "b = 20" }),
        callTool(ctx, "edit_cell", { cell_id: "c1", old_text: "c = 3", new_text: "c = 30" }),
      ]);
      return nb.cells[0]!.source;
    };
    // Without the lock, each edit reads the original source and the last write wins.
    expect(await run(false)).not.toBe("a = 10\nb = 20\nc = 30");
    expect(await run(true)).toBe("a = 10\nb = 20\nc = 30");
  });

  it("lists cells from summaries with their line counts", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "\nimport os\nx = 1\n" }]);
    const res = await callTool(context(nb), "list_cells", {});
    expect(res.text).toBe("[0] c1 code [ ] (4 lines): import os");
  });
});
