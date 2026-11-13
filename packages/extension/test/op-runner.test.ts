// OpRunner with an in-memory adapter: review bookkeeping, run sequencing, guards.

import { describe, expect, it } from "vitest";
import type { CellInfo, CellType, NotebookEvent, NotebookInfo, ReviewInfo, RunResult } from "@ainb/protocol";
import { OpRunner, OutputCollector, type Execution, type NotebookAdapter } from "../src/page/adapter.js";

class MemoryAdapter implements NotebookAdapter {
  readonly platform = "jupyter" as const;
  cells: { id: string; type: CellType; source: string }[] = [
    { id: "a", type: "code", source: "x = 1" },
    { id: "b", type: "code", source: "raise ValueError()" },
    { id: "c", type: "code", source: "y = 2" },
  ];
  shown: { review: ReviewInfo; decide: (accept: boolean) => void }[] = [];
  ran: string[] = [];
  slow = new Set<string>();
  private n = 0;

  info(): NotebookInfo {
    return { platform: "jupyter", title: "t", url: "u", cellCount: this.cells.length, activeCellId: "a", selectedCellIds: ["a"], kernel: "idle", language: "python" };
  }
  getCells(opts: { cellIds?: string[] }): CellInfo[] {
    const all = this.cells.map((c, index) => ({ ...c, index }));
    return opts.cellIds ? all.filter((c) => opts.cellIds!.includes(c.id)) : all;
  }
  setSource(id: string, source: string) {
    const c = this.cells.find((x) => x.id === id)!;
    c.source = source;
    return true;
  }
  async insertCell(index: number, type: CellType, source: string) {
    const id = `new${++this.n}`;
    this.cells.splice(index, 0, { id, type, source });
    return id;
  }
  deleteCell(id: string) {
    this.cells = this.cells.filter((c) => c.id !== id);
  }
  moveCell(_id: string, index: number) {
    return index;
  }
  async runCell(id: string, timeoutMs: number): Promise<RunResult> {
    this.ran.push(id);
    if (this.slow.has(id)) {
      await new Promise((r) => setTimeout(r, timeoutMs + 5));
      return { cellId: id, status: "timeout", outputs: [] };
    }
    const c = this.cells.find((x) => x.id === id)!;
    return c.source.startsWith("raise") ? { cellId: id, status: "error", outputs: [{ kind: "error", ename: "ValueError", evalue: "" }] } : { cellId: id, status: "ok", outputs: [] };
  }
  executed: string[] = [];
  /** Code containing "slow" ends only when `finish` is called. */
  finish: (r: { status: string; ename?: string; evalue?: string }) => void = () => {};
  async startExecution(code: string): Promise<Execution> {
    this.executed.push(code);
    const collected = new OutputCollector();
    collected.add({ output_type: "execute_result", data: { "text/plain": code } });
    const reply = code.includes("slow") ? new Promise<{ status: string }>((r) => (this.finish = r)) : Promise.resolve({ status: "ok" });
    return { reply, collected };
  }
  interrupt() {
    return false;
  }
  focusCell() {
    return true;
  }
  showReview(review: ReviewInfo) {
    let decide!: (accept: boolean) => void;
    const decided = new Promise<boolean>((r) => (decide = r)).then((accept) => {
      if (review.kind === "update" && accept) this.setSource(review.cellId, review.after);
      if (review.kind === "insert" && !accept) this.deleteCell(review.cellId);
      if (review.kind === "insert" && accept) this.setSource(review.cellId, review.after);
      if (review.kind === "delete" && accept) this.deleteCell(review.cellId);
      return accept;
    });
    this.shown.push({ review, decide });
    return { decided, resolve: decide };
  }
  onSelectionChange() {}
}

function setup() {
  const adapter = new MemoryAdapter();
  const events: NotebookEvent[] = [];
  const runner = new OpRunner(adapter, (e) => events.push(e));
  return { adapter, events, runner };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("OpRunner", () => {
  it("applies edits directly without review", async () => {
    const { adapter, runner } = setup();
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false })).toEqual({ applied: true });
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false })).toEqual({ applied: false });
    expect(adapter.cells[0]!.source).toBe("x = 5");
    await expect(runner.run({ op: "update_cell", cellId: "zz", source: "", review: false })).rejects.toThrow('No cell with id "zz"');
  });

  it("opens a review, blocks further edits to that cell, and reports the decision", async () => {
    const { adapter, events, runner } = setup();
    const res = (await runner.run({ op: "update_cell", cellId: "a", source: "x = 9", review: true })) as { reviewId: string; applied: boolean };
    expect(res.applied).toBe(false);
    expect(adapter.cells[0]!.source).toBe("x = 1");
    expect(events[0]).toMatchObject({ type: "review_opened", review: { reviewId: res.reviewId, cellId: "a", before: "x = 1", after: "x = 9" } });

    const { cells } = (await runner.run({ op: "get_cells" })) as { cells: CellInfo[] };
    expect(cells.find((c) => c.id === "a")?.pendingReview).toBe(true);
    await expect(runner.run({ op: "update_cell", cellId: "a", source: "x = 10", review: true })).rejects.toThrow("awaiting the user's review");
    await expect(runner.run({ op: "delete_cell", cellId: "a", review: false })).rejects.toThrow("awaiting the user's review");

    expect(await runner.run({ op: "resolve_review", reviewId: res.reviewId, accept: true })).toEqual({ resolved: true });
    await tick();
    expect(events.at(-1)).toEqual({ type: "review_closed", reviewId: res.reviewId, accepted: true });
    expect(adapter.cells[0]!.source).toBe("x = 9");
    expect(await runner.run({ op: "resolve_review", reviewId: res.reviewId, accept: true })).toEqual({ resolved: false });
  });

  it("inserts an empty cell under review and removes it when rejected", async () => {
    const { adapter, runner } = setup();
    const res = (await runner.run({ op: "insert_cell", index: 99, cellType: "markdown", source: "# hi", review: true })) as { cellId: string; reviewId: string };
    expect(adapter.cells.at(-1)).toEqual({ id: res.cellId, type: "markdown", source: "" });
    adapter.shown.at(-1)!.decide(false);
    await tick();
    expect(adapter.cells.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("runs in order, stops at the first error and skips cells under review", async () => {
    const { adapter, runner } = setup();
    let r = (await runner.run({ op: "run_cells", cellIds: ["a", "b", "c"], timeoutMs: 5000, stopOnError: true })) as { results: RunResult[] };
    expect(r.results.map((x) => x.status)).toEqual(["ok", "error", "skipped"]);
    expect(adapter.ran).toEqual(["a", "b"]);

    await runner.run({ op: "update_cell", cellId: "c", source: "y = 3", review: true });
    r = (await runner.run({ op: "run_cells", cellIds: ["a", "c"], timeoutMs: 5000, stopOnError: true })) as { results: RunResult[] };
    expect(r.results[1]).toMatchObject({ status: "skipped", message: expect.stringContaining("awaits review") });
  });

  it("stops waiting when the time budget runs out", async () => {
    const { adapter, runner } = setup();
    adapter.slow.add("a");
    const r = (await runner.run({ op: "run_cells", cellIds: ["a", "c"], timeoutMs: 30, stopOnError: true })) as { results: RunResult[] };
    expect(r.results.map((x) => x.status)).toEqual(["timeout", "skipped"]);
  });

  it("journals the agent's applied changes for undo, but not the user's own", async () => {
    const { events, runner, adapter } = setup();
    const changes = () => events.flatMap((e) => (e.type === "change_applied" ? [e.change] : []));
    await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false });
    await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false }); // no-op: not journaled
    const ins = (await runner.run({ op: "insert_cell", index: 1, cellType: "markdown", source: "# hi", review: false })) as { cellId: string };
    await runner.run({ op: "delete_cell", cellId: "c", review: false });
    await runner.run({ op: "move_cell", cellId: "a", index: 1 });
    await runner.run({ op: "insert_cell", index: 0, cellType: "code", source: "mine", review: false, byUser: true });
    await runner.run({ op: "update_cell", cellId: "b", source: "undo", review: false, byUser: true });
    expect(changes()).toEqual([
      { kind: "update", cellId: "a", cellType: "code", index: 0, before: "x = 1", after: "x = 5" },
      { kind: "insert", cellId: ins.cellId, cellType: "markdown", index: 1, before: "", after: "# hi" },
      { kind: "delete", cellId: "c", cellType: "code", index: 3, before: "y = 2", after: "" },
      { kind: "move", cellId: "a", cellType: "code", index: 0, toIndex: 1, before: "", after: "" },
    ]);

    // A review is journaled when accepted (before it closes), with the cell's place when it opened.
    const del = (await runner.run({ op: "delete_cell", cellId: "b", review: true })) as { reviewId: string };
    const rej = (await runner.run({ op: "update_cell", cellId: ins.cellId, source: "# no", review: true })) as { reviewId: string };
    const bIndex = adapter.cells.findIndex((c) => c.id === "b");
    adapter.shown.find((s) => s.review.reviewId === del.reviewId)!.decide(true);
    adapter.shown.find((s) => s.review.reviewId === rej.reviewId)!.decide(false);
    await tick();
    await tick();
    expect(changes().slice(4)).toEqual([{ kind: "delete", cellId: "b", cellType: "code", index: bIndex, before: "undo", after: "", reviewId: del.reviewId }]);
    const order = events.map((e) => e.type).filter((t) => t === "change_applied" || t === "review_closed");
    expect(order.slice(-3)).toEqual(["change_applied", "review_closed", "review_closed"]);
  });
});

describe("running code without a cell", () => {
  it("passes execute to the adapter and leaves the notebook alone", async () => {
    const { adapter, runner, events } = setup();
    expect(await runner.run({ op: "execute", code: "1 + 1", waitMs: 1000 })).toEqual({ status: "ok", outputs: [{ kind: "result", text: "1 + 1", mimes: undefined }] });
    expect(adapter.executed).toEqual(["1 + 1"]);
    expect(adapter.cells).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it("never stops code that outlasts the wait: it can be waited on again by id", async () => {
    const { adapter, runner } = setup();
    const first = (await runner.run({ op: "execute", code: "slow()", waitMs: 20 })) as { status: string; execId?: string; outputs: unknown[] };
    expect(first.status).toBe("running");
    expect(first.execId).toMatch(/^exec-\d+$/);
    expect(first.outputs).toHaveLength(1);
    expect(await runner.run({ op: "execute_wait", execId: first.execId!, waitMs: 20 })).toMatchObject({ status: "running", execId: first.execId });
    adapter.finish({ status: "error", ename: "KeyboardInterrupt", evalue: "" });
    expect(await runner.run({ op: "execute_wait", execId: first.execId!, waitMs: 1000 })).toEqual({
      status: "error",
      outputs: [{ kind: "result", text: "slow()", mimes: undefined }],
      message: "KeyboardInterrupt: ",
    });
    // Collected: it is gone now.
    await expect(runner.run({ op: "execute_wait", execId: first.execId!, waitMs: 10 })).rejects.toThrow(/No execution/);
  });

  it("collects outputs: joins stream chunks, applies clear_output, bounds what it keeps", () => {
    const c = new OutputCollector();
    c.add({ output_type: "stream", name: "stdout", text: "a\n" });
    c.add({ output_type: "stream", name: "stdout", text: "b\n" });
    c.add({ output_type: "stream", name: "stderr", text: "warn\n" });
    c.add({ output_type: "execute_result", data: { "text/plain": "3" } });
    expect(c.outputs).toEqual([
      { kind: "stream", name: "stdout", text: "a\nb\n" },
      { kind: "stream", name: "stderr", text: "warn\n" },
      { kind: "result", text: "3", mimes: undefined },
    ]);
    c.clear(true);
    expect(c.outputs).toHaveLength(3);
    c.add({ output_type: "stream", name: "stdout", text: "fresh" });
    expect(c.outputs).toEqual([{ kind: "stream", name: "stdout", text: "fresh" }]);
    c.clear();
    expect(c.outputs).toEqual([]);

    const big = "x".repeat(99_999) + "\n";
    for (let i = 0; i < 30; i++) c.add({ output_type: "stream", name: "stdout", text: big });
    const text = c.outputs[0]!.text!;
    expect(text.length).toBeLessThan(1_100_000);
    expect(text).toMatch(/\n… \[\d+ characters omitted\] …\n/);
    expect(text.endsWith(big)).toBe(true);
  });
});
