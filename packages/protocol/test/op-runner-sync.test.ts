// Đợt 2 protocol: sourceHash, image budget + get_output_image, compare-and-set,
// apply_cells, review index/label, one info() per pulse and adapter dispose.

import { describe, expect, it, vi } from "vitest";
import { OpError, OpRunner, OutputCollector, type Execution, type NotebookAdapter } from "../src/adapter.js";
import { textHash } from "../src/text.js";
import type { CellInfo, CellOutput, CellType, KernelState, NotebookEvent, NotebookInfo, NotebookOp, ReviewInfo, RunResult } from "../src/notebook.js";

interface FakeCell {
  id: string;
  type: CellType;
  source: string;
  outputs?: CellOutput[];
  executionCount?: number | null;
}

class FakeAdapter implements NotebookAdapter {
  readonly platform = "jupyter" as const;
  kernel: KernelState = "idle";
  disposed = 0;
  infoCalls = 0;
  infoBroken = false;
  shown: { review: ReviewInfo; decide: (accept: boolean) => void }[] = [];
  private seq = 0;
  private exec = 0;

  constructor(public cells: FakeCell[]) {}

  info(): NotebookInfo {
    this.infoCalls++;
    if (this.infoBroken) throw new Error("notebook is reloading");
    return { platform: "jupyter", title: "t", url: "u", cellCount: this.cells.length, activeCellId: null, selectedCellIds: [], kernel: this.kernel, language: "python" };
  }
  getCells(opts: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[] {
    let all: CellInfo[] = this.cells.map((c, index) => ({ ...c, index, outputs: opts.includeOutputs ? c.outputs : undefined }));
    if (opts.cellIds) all = all.filter((c) => opts.cellIds!.includes(c.id));
    else if (opts.start !== undefined || opts.end !== undefined) all = all.slice(opts.start ?? 0, (opts.end ?? all.length - 1) + 1);
    return all;
  }
  runStates() {
    return this.cells.filter((c) => c.type === "code").map((c) => ({ cellId: c.id, running: false, executionCount: c.executionCount ?? null }));
  }
  setSource(id: string, source: string) {
    const c = this.cells.find((x) => x.id === id)!;
    if (c.source === source) return false;
    c.source = source;
    return true;
  }
  async insertCell(index: number, type: CellType, source: string) {
    const id = `n${++this.seq}`;
    this.cells.splice(index, 0, { id, type, source });
    return id;
  }
  deleteCell(id: string) {
    this.cells = this.cells.filter((c) => c.id !== id);
  }
  moveCell(id: string, index: number) {
    const from = this.cells.findIndex((c) => c.id === id);
    const [c] = this.cells.splice(from, 1);
    const to = Math.max(0, Math.min(index, this.cells.length));
    this.cells.splice(to, 0, c!);
    return to;
  }
  async runCell(id: string, _timeoutMs: number): Promise<RunResult> {
    const c = this.cells.find((x) => x.id === id)!;
    c.executionCount = ++this.exec;
    return { cellId: id, status: "ok", executionCount: c.executionCount, outputs: c.outputs ?? [] };
  }
  async startExecution(_code: string): Promise<Execution> {
    return { reply: Promise.resolve({ status: "ok" }), collected: new OutputCollector() };
  }
  interrupt() {
    return true;
  }
  focusCell() {
    return true;
  }
  showReview(review: ReviewInfo) {
    let decide!: (accept: boolean) => void;
    const decided = new Promise<boolean>((r) => (decide = r)).then((accept) => {
      if (accept && review.kind === "update") this.setSource(review.cellId, review.after);
      if (accept && review.kind === "insert") this.setSource(review.cellId, review.after);
      if (accept && review.kind === "delete") this.deleteCell(review.cellId);
      if (!accept && review.kind === "insert") this.deleteCell(review.cellId);
      return accept;
    });
    this.shown.push({ review, decide });
    return { decided, resolve: decide };
  }
  onSelectionChange() {}
  dispose() {
    this.disposed++;
  }
}

function setup(cells?: FakeCell[]) {
  const adapter = new FakeAdapter(cells ?? [
    { id: "a", type: "code", source: "x = 1\nprint(x)" },
    { id: "b", type: "code", source: "y = 2" },
    { id: "m", type: "markdown", source: "# Title\n\nbody" },
  ]);
  const events: NotebookEvent[] = [];
  const runner = new OpRunner(adapter, (e) => events.push(e), { pollMs: null });
  return { adapter, events, runner };
}

const read = (runner: OpRunner, op: Record<string, unknown>) => runner.run({ op: "get_cells", ...op } as NotebookOp) as Promise<{ cells: CellInfo[] }>;
const changes = (events: NotebookEvent[]) => events.flatMap((e) => (e.type === "change_applied" ? [e.change] : []));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("get_cells sourceHash", () => {
  it("cuts every source to a hash plus lineCount, including empty and markdown cells", async () => {
    const { adapter, runner } = setup([
      { id: "a", type: "code", source: "x = 1\nprint(x)" },
      { id: "m", type: "markdown", source: "# Title\n\nbody" },
      { id: "e", type: "code", source: "" },
    ]);
    const { cells } = await read(runner, { sourceHash: true });
    expect(cells.map((c) => c.source)).toEqual(["", "", ""]);
    expect(cells[0]).toMatchObject({ sourceHash: textHash("x = 1\nprint(x)"), lineCount: 2 });
    expect(cells[1]).toMatchObject({ sourceHash: textHash("# Title\n\nbody"), lineCount: 3 });
    expect(cells[2]).toMatchObject({ sourceHash: textHash(""), lineCount: 0 });
    expect(cells.every((c) => c.outputs === undefined)).toBe(true);
    // The adapter's own cells are untouched.
    expect(adapter.cells[0]!.source).toBe("x = 1\nprint(x)");
  });

  it("combines with outputsHash: both digests, no payload", async () => {
    const { runner } = setup([
      { id: "a", type: "code", source: "x = 1", outputs: [{ kind: "stream", name: "stdout", text: "1\n" }] },
    ]);
    const { cells } = await read(runner, { sourceHash: true, outputsHash: true });
    expect(cells[0]!.source).toBe("");
    expect(cells[0]!.sourceHash).toBe(textHash("x = 1"));
    expect(cells[0]!.outputsHash).toBeTruthy();
    expect(cells[0]!.outputs).toBeUndefined();
  });

  it("wins over summary when both are set, and keeps outputs when asked", async () => {
    const { runner } = setup([
      { id: "a", type: "code", source: "first line\nsecond line", outputs: [{ kind: "stream", name: "stdout", text: "out" }] },
    ]);
    const both = await read(runner, { sourceHash: true, summary: true });
    expect(both.cells[0]).toMatchObject({ source: "", lineCount: 2, sourceHash: textHash("first line\nsecond line") });
    const without = await read(runner, { summary: true });
    expect(without.cells[0]).toMatchObject({ source: "first line", lineCount: 2 });
    expect(without.cells[0]!.sourceHash).toBeUndefined();
    const withOutputs = await read(runner, { sourceHash: true, includeOutputs: true });
    expect(withOutputs.cells[0]!.source).toBe("");
    expect(withOutputs.cells[0]!.outputs).toEqual([{ kind: "stream", name: "stdout", text: "out" }]);
  });

  it("still marks stale cells correctly when the source is cut", async () => {
    const { adapter, runner } = setup();
    await runner.run({ op: "run_cells", cellIds: ["a"], timeoutMs: 5000, stopOnError: true });
    adapter.cells[0]!.source = "x = 99";
    const hashed = await read(runner, { sourceHash: true });
    expect(hashed.cells.find((c) => c.id === "a")!.stale).toBe(true);
    expect(hashed.cells.find((c) => c.id === "b")!.stale).toBeUndefined();
    const full = await read(runner, {});
    expect(full.cells.find((c) => c.id === "a")!.stale).toBe(true);
    await runner.run({ op: "run_cells", cellIds: ["a"], timeoutMs: 5000, stopOnError: true });
    const after = await read(runner, { sourceHash: true });
    expect(after.cells.find((c) => c.id === "a")!.stale).toBeUndefined();
  });

  it("leaves a plain read exactly as before", async () => {
    const { runner } = setup();
    const { cells } = await read(runner, {});
    expect(cells[0]).toMatchObject({ id: "a", source: "x = 1\nprint(x)" });
    expect(cells[0]!.sourceHash).toBeUndefined();
    expect(cells[0]!.lineCount).toBeUndefined();
  });
});

describe("image budget", () => {
  const png = (n: number) => ({ mime: "image/png" as const, data: "A".repeat(n) });
  const jpeg = (n: number) => ({ mime: "image/jpeg" as const, data: "B".repeat(n) });
  const plotCells = (): FakeCell[] => [
    { id: "a", type: "code", source: "plot()", outputs: [
      { kind: "display", text: "p1", image: png(100) },
      { kind: "display", text: "p2", image: jpeg(100) },
    ] },
    { id: "b", type: "code", source: "plot()", outputs: [
      { kind: "display", text: "p3", image: png(50), mimes: ["text/html"] },
    ] },
  ];

  it("keeps the first maxImages images in cell/output order and leaves a mime trace", async () => {
    const { adapter, runner } = setup(plotCells());
    const { cells } = await read(runner, { includeOutputs: true, maxImages: 2 });
    expect(cells[0]!.outputs![0]!.image).toEqual(png(100));
    expect(cells[0]!.outputs![1]!.image).toEqual(jpeg(100));
    expect(cells[1]!.outputs![0]!.image).toBeUndefined();
    expect(cells[1]!.outputs![0]!.mimes).toEqual(["text/html", "image/png"]);
    expect(cells[1]!.outputs![0]!.text).toBe("p3");
    // The page's own outputs are not mutated.
    expect(adapter.cells[1]!.outputs![0]!.image).toEqual(png(50));
  });

  it("counts base64 bytes across the whole call and skips what does not fit", async () => {
    const { runner } = setup(plotCells());
    const { cells } = await read(runner, { includeOutputs: true, maxImageBytes: 150 });
    expect(cells[0]!.outputs![0]!.image).toEqual(png(100)); // 100 used
    expect(cells[0]!.outputs![1]!.image).toBeUndefined(); // 100 + 100 > 150
    expect(cells[0]!.outputs![1]!.mimes).toEqual(["image/jpeg"]);
    expect(cells[1]!.outputs![0]!.image).toEqual(png(50)); // 100 + 50 fits
  });

  it("maxImages 0 strips every image; no budget keeps them all", async () => {
    const { runner } = setup(plotCells());
    const none = await read(runner, { includeOutputs: true, maxImages: 0 });
    expect(none.cells.flatMap((c) => c.outputs ?? []).every((o) => o.image === undefined)).toBe(true);
    const all = await read(runner, { includeOutputs: true });
    expect(all.cells.flatMap((c) => c.outputs ?? []).filter((o) => o.image)).toHaveLength(3);
  });

  it("hashes the real outputs, not the budgeted view", async () => {
    const { runner } = setup(plotCells());
    const full = await read(runner, { outputsHash: true });
    const budgeted = await read(runner, { outputsHash: true, includeOutputs: true, maxImages: 1 });
    expect(budgeted.cells[0]!.outputsHash).toBe(full.cells[0]!.outputsHash);
    expect(budgeted.cells[1]!.outputsHash).toBe(full.cells[1]!.outputsHash);
    expect(budgeted.cells[1]!.outputs![0]!.image).toBeUndefined();
  });

  it("shares one budget across run_cells results", async () => {
    const { runner } = setup(plotCells());
    const r = (await runner.run({ op: "run_cells", cellIds: ["a", "b"], timeoutMs: 5000, stopOnError: true, maxImages: 1 })) as { results: RunResult[] };
    expect(r.results[0]!.outputs[0]!.image).toEqual(png(100));
    expect(r.results[0]!.outputs[1]!.image).toBeUndefined();
    expect(r.results[1]!.outputs[0]!.image).toBeUndefined();
    expect(r.results[1]!.outputs[0]!.mimes).toEqual(["text/html", "image/png"]);
    const plain = (await runner.run({ op: "run_cells", cellIds: ["a"], timeoutMs: 5000, stopOnError: true })) as { results: RunResult[] };
    expect(plain.results[0]!.outputs.filter((o) => o.image)).toHaveLength(2);
  });

  it("get_output_image fetches the real image a budget stripped", async () => {
    const { runner } = setup(plotCells());
    await read(runner, { includeOutputs: true, maxImages: 0 });
    expect(await runner.run({ op: "get_output_image", cellId: "b", outputIndex: 0 })).toEqual({ image: png(50) });
    expect(await runner.run({ op: "get_output_image", cellId: "a", outputIndex: 1 })).toEqual({ image: jpeg(100) });
    expect(await runner.run({ op: "get_output_image", cellId: "a", outputIndex: 9 })).toEqual({});
    await expect(runner.run({ op: "get_output_image", cellId: "zz", outputIndex: 0 })).rejects.toThrow('No cell with id "zz".');
  });
});

describe("update_cell compare-and-set", () => {
  it("applies when the expected source matches, and journals it", async () => {
    const { adapter, events, runner } = setup();
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false, expectedSource: "x = 1\nprint(x)" })).toEqual({ applied: true });
    expect(adapter.cells[0]!.source).toBe("x = 5");
    expect(changes(events)).toEqual([{ kind: "update", cellId: "a", cellType: "code", index: 0, before: "x = 1\nprint(x)", after: "x = 5" }]);
  });

  it("conflicts without applying, journaling or reviewing when the cell moved on", async () => {
    const { adapter, events, runner } = setup();
    adapter.cells[0]!.source = "user edited";
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false, expectedSource: "x = 1\nprint(x)" })).toEqual({ applied: false, conflict: true });
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: true, expectedSource: "x = 1\nprint(x)" })).toEqual({ applied: false, conflict: true });
    expect(adapter.cells[0]!.source).toBe("user edited");
    expect(events).toEqual([]);
  });

  it("keeps the old behavior without expectedSource, including the equal-source no-op", async () => {
    const { runner } = setup();
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 1\nprint(x)", review: false })).toEqual({ applied: false });
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false })).toEqual({ applied: true });
    // expectedSource matching, target equal to current: the old no-op, not a conflict.
    expect(await runner.run({ op: "update_cell", cellId: "a", source: "x = 5", review: false, expectedSource: "x = 5" })).toEqual({ applied: false });
  });

  it("treats an empty expected source as a version like any other", async () => {
    const { runner } = setup([{ id: "e", type: "code", source: "" }]);
    expect(await runner.run({ op: "update_cell", cellId: "e", source: "new", review: false, expectedSource: "" })).toEqual({ applied: true });
    expect(await runner.run({ op: "update_cell", cellId: "e", source: "newer", review: false, expectedSource: "" })).toEqual({ applied: false, conflict: true });
  });
});

describe("apply_cells", () => {
  it("runs the steps in order, one result and one journal entry each", async () => {
    const { adapter, events, runner } = setup();
    const res = (await runner.run({ op: "apply_cells", steps: [
      { op: "update_cell", cellId: "a", source: "x = 5", review: false },
      { op: "insert_cell", index: 1, cellType: "markdown", source: "# hi", review: false },
      { op: "delete_cell", cellId: "b", review: false },
      { op: "move_cell", cellId: "a", index: 1 },
    ] })) as { results: unknown[] };
    expect(res.results[0]).toEqual({ applied: true });
    const inserted = (res.results[1] as { applied: boolean; cellId: string }).cellId;
    expect(res.results[1]).toEqual({ applied: true, cellId: inserted });
    expect(res.results[2]).toEqual({ applied: true });
    expect(res.results[3]).toEqual({ index: 1 });
    expect(adapter.cells.map((c) => c.id)).toEqual([inserted, "a", "m"]);
    expect(changes(events).map((c) => [c.kind, c.cellId])).toEqual([
      ["update", "a"], ["insert", inserted], ["delete", "b"], ["move", "a"],
    ]);
  });

  it("keeps review semantics per step: reviewId now, change_applied before review_closed", async () => {
    const { adapter, events, runner } = setup();
    const res = (await runner.run({ op: "apply_cells", steps: [
      { op: "update_cell", cellId: "a", source: "x = 9", review: true },
      { op: "update_cell", cellId: "b", source: "y = 9", review: false },
    ] })) as { results: { reviewId?: string; applied: boolean }[] };
    expect(res.results[0]!.applied).toBe(false);
    expect(res.results[0]!.reviewId).toBeTruthy();
    expect(res.results[1]).toEqual({ applied: true });
    adapter.shown[0]!.decide(true);
    await tick();
    const order = events.map((e) => e.type).filter((t) => t === "change_applied" || t === "review_closed");
    expect(order).toEqual(["change_applied", "change_applied", "review_closed"]);
    expect(changes(events).at(-1)).toMatchObject({ cellId: "a", reviewId: res.results[0]!.reviewId });
  });

  it("rejects a non-mutating step with OpError before applying anything", async () => {
    const { adapter, events, runner } = setup();
    await expect(runner.run({ op: "apply_cells", steps: [
      { op: "update_cell", cellId: "a", source: "x = 5", review: false },
      { op: "run_cells", cellIds: ["a"], timeoutMs: 1000, stopOnError: true },
    ] })).rejects.toThrow(OpError);
    expect(adapter.cells[0]!.source).toBe("x = 1\nprint(x)");
    expect(events).toEqual([]);
    await expect(runner.run({ op: "apply_cells", steps: [{ op: "get_cells" }] })).rejects.toThrow(/apply_cells steps must be/);
    expect(await runner.run({ op: "apply_cells", steps: [] })).toEqual({ results: [] });
  });

  it("does not journal a byUser step", async () => {
    const { events, runner } = setup();
    await runner.run({ op: "apply_cells", steps: [{ op: "update_cell", cellId: "a", source: "mine", review: false, byUser: true }] });
    expect(changes(events)).toEqual([]);
  });
});

describe("review index and label", () => {
  it("carries the cell's position and a short first-line label", async () => {
    const { events, runner } = setup();
    await runner.run({ op: "update_cell", cellId: "b", source: "\ny = 3\nprint(y)", review: true });
    const review = (events.find((e) => e.type === "review_opened") as { review: ReviewInfo }).review;
    expect(review.index).toBe(1);
    expect(review.label).toBe("y = 3");
  });

  it("cuts a long label at 60 characters and falls back to before for a delete", async () => {
    const { events, runner } = setup([{ id: "a", type: "code", source: "z".repeat(100) }]);
    await runner.run({ op: "update_cell", cellId: "a", source: "w".repeat(100), review: true });
    const update = (events.find((e) => e.type === "review_opened") as { review: ReviewInfo }).review;
    expect(update.label).toBe(`${"w".repeat(59)}…`);
    await runner.run({ op: "resolve_review", reviewId: update.reviewId, accept: false });
    await tick();
    await runner.run({ op: "delete_cell", cellId: "a", review: true });
    const del = (events.filter((e) => e.type === "review_opened").at(-1) as { review: ReviewInfo }).review;
    expect(del.label).toBe(`${"z".repeat(59)}…`);
    expect(del.index).toBe(0);
  });
});

describe("pulse and dispose", () => {
  it("reads info once per timer beat and keeps kernel_changed behavior", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter([{ id: "a", type: "code", source: "x = 1" }]);
      const events: NotebookEvent[] = [];
      const runner = new OpRunner(adapter, (e) => events.push(e), { pollMs: 10 });
      adapter.infoCalls = 0;
      await vi.advanceTimersByTimeAsync(35);
      expect(adapter.infoCalls).toBe(3);
      adapter.kernel = "busy";
      await vi.advanceTimersByTimeAsync(10);
      expect(events.filter((e) => e.type === "kernel_changed")).toEqual([{ type: "kernel_changed", kernel: "busy" }]);
      runner.dispose();
      adapter.infoCalls = 0;
      await vi.advanceTimersByTimeAsync(50);
      expect(adapter.infoCalls).toBe(0);
      expect(adapter.disposed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reprimes the watcher when the kernel reconnects, without extra events", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter([{ id: "a", type: "code", source: "x = 1" }]);
      const events: NotebookEvent[] = [];
      const runner = new OpRunner(adapter, (e) => events.push(e), { pollMs: 10 });
      await runner.run({ op: "run_cells", cellIds: ["a"], timeoutMs: 5000, stopOnError: true });
      adapter.cells[0]!.source = "edited";
      expect((await read(runner, {})).cells[0]!.stale).toBe(true);
      adapter.kernel = "disconnected";
      await vi.advanceTimersByTimeAsync(10);
      adapter.kernel = "idle";
      await vi.advanceTimersByTimeAsync(10);
      expect(events.filter((e) => e.type === "kernel_changed").map((e) => e.kernel)).toEqual(["disconnected", "idle"]);
      // ranHash was cleared by the reprime: the old run no longer marks the cell stale.
      expect((await read(runner, {})).cells[0]!.stale).toBeUndefined();
      runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives an info() failure during a beat, keeping the previous kernel state", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter([{ id: "a", type: "code", source: "x = 1" }]);
      const events: NotebookEvent[] = [];
      const runner = new OpRunner(adapter, (e) => events.push(e), { pollMs: 10 });
      adapter.infoBroken = true;
      await vi.advanceTimersByTimeAsync(30);
      adapter.infoBroken = false;
      adapter.kernel = "busy";
      await vi.advanceTimersByTimeAsync(10);
      expect(events.filter((e) => e.type === "kernel_changed")).toEqual([{ type: "kernel_changed", kernel: "busy" }]);
      runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});