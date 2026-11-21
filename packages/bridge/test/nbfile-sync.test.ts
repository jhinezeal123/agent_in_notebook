// The two-tier sync (A2.1) and the batched apply (A2.5): a sync that changes
// nothing pulls no outputs, a sync that changes one cell pulls only that
// cell's outputs, and a notebook edit goes to the page as one apply_cells op
// whose steps keep the order (and the journal) of the single ops.
//
// The fake here speaks the WIRE_VERSION 6 contract the shared FakeNotebook
// does not implement yet: outputsHash, apply_cells, the image budget and
// get_output_image. The bridge also works against a page without them (the
// shared fixtures' tests cover that path).

import { describe, expect, it } from "vitest";
import { outputsFingerprint, type CellInfo, type CellOutput, type NotebookOp, type RunResult } from "@ainb/protocol";
import { applyCells, syncOut } from "../src/notebook/nbfile.js";
import { fromCellInfo } from "../src/notebook/ipynb.js";
import { callTool } from "../src/notebook/tools.js";
import { FakeNotebook, TINY_PNG } from "./fixtures/fake-extension.js";
import { context } from "./fixtures/tool-context.js";

const long = { waitMs: 60_000 };
const file = "/content/test.ipynb";
const fileCells = (nb: FakeNotebook, path = file) => JSON.parse(nb.vm.read(path)!).cells as any[];
const writes = (nb: FakeNotebook) => nb.vm.ops.filter((o) => o === "fs:write").length;

/** One image budget for a whole op call, as the page's OpRunner applies it. */
function makeBudget(maxImages?: number, maxBytes?: number): (outputs: CellOutput[]) => CellOutput[] {
  let kept = 0;
  let bytes = 0;
  return (outputs) =>
    outputs.map((o) => {
      if (!o.image) return o;
      const size = o.image.data.length;
      if ((maxImages !== undefined && kept >= maxImages) || (maxBytes !== undefined && bytes + size > maxBytes)) {
        const { image, ...rest } = o;
        const mimes = [...(rest.mimes ?? [])];
        if (!mimes.includes(image.mime)) mimes.push(image.mime);
        return { ...rest, mimes };
      }
      kept++;
      bytes += size;
      return o;
    });
}

/** A FakeNotebook that answers the WIRE_VERSION 6 ops, recording every op it sees. */
export class SyncFakeNotebook extends FakeNotebook {
  ops: NotebookOp[] = [];

  override handle(op: NotebookOp): unknown {
    this.ops.push(op);
    switch (op.op) {
      case "get_cells": {
        const { cells } = super.handle(op) as { cells: CellInfo[] };
        let out = cells;
        if (op.outputsHash) {
          out = out.map((c) => {
            if (c.type !== "code") return c;
            const real = this.cells.find((x) => x.id === c.id)!;
            const { outputs, ...rest } = c;
            const hash = outputsFingerprint(real.outputs);
            return op.includeOutputs ? { ...rest, outputs: real.outputs.map((o) => ({ ...o })), outputsHash: hash } : { ...rest, outputsHash: hash };
          });
        }
        if (op.maxImages !== undefined || op.maxImageBytes !== undefined) {
          const budget = makeBudget(op.maxImages, op.maxImageBytes);
          out = out.map((c) => (c.outputs ? { ...c, outputs: budget(c.outputs) } : c));
        }
        return { cells: out };
      }
      case "run_cells": {
        const r = super.handle(op) as { results: RunResult[] };
        if (op.maxImages === undefined && op.maxImageBytes === undefined) return r;
        const budget = makeBudget(op.maxImages, op.maxImageBytes);
        return { results: r.results.map((res) => ({ ...res, outputs: budget(res.outputs) })) };
      }
      case "apply_cells": {
        const results: unknown[] = [];
        for (const step of op.steps) results.push(super.handle(step));
        return { results };
      }
      case "get_output_image": {
        const c = this.cells.find((x) => x.id === op.cellId);
        return { image: c?.outputs[op.outputIndex]?.image };
      }
      default:
        return super.handle(op);
    }
  }

  /** The get_cells ops since `from`, by kind. */
  reads(from = 0): { outline: NotebookOp[]; outputs: NotebookOp[] } {
    const gets = this.ops.slice(from).filter((o): o is Extract<NotebookOp, { op: "get_cells" }> => o.op === "get_cells");
    return { outline: gets.filter((o) => !o.includeOutputs), outputs: gets.filter((o) => !!o.includeOutputs) };
  }
}

const plotOutputs = (): CellOutput[] => [
  { kind: "stream", name: "stdout", text: "ran\n" },
  { kind: "display", text: "<Figure>", image: { mime: "image/png", data: TINY_PNG } },
];

describe("syncOut in two tiers", () => {
  it("pulls no outputs at all when nothing changed", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "plot()" }, { type: "markdown", source: "# notes" }]);
    nb.cells[0]!.outputs = plotOutputs();
    nb.cells[0]!.executionCount = 1;
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "Glob", { pattern: "*.ipynb" });
    const before = writes(nb);
    const mark = nb.ops.length;
    await callTool(ctx, "Glob", { pattern: "*.ipynb" });
    const { outline, outputs } = nb.reads(mark);
    expect(outputs).toEqual([]);
    expect(outline).toEqual([{ op: "get_cells", outputsHash: true }]);
    expect(writes(nb)).toBe(before);
    // The file still holds the outputs, from the cache of the first write.
    expect(fileCells(nb)[0].outputs).toHaveLength(2);
  });

  it("fetches the outputs of only the cell whose outputs changed", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "a()" }, { type: "code", source: "b()" }]);
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "a\n" }];
    nb.cells[1]!.outputs = plotOutputs();
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "Glob", { pattern: "*" });
    const before = writes(nb);
    const mark = nb.ops.length;
    nb.cells[1]!.outputs = [...nb.cells[1]!.outputs, { kind: "stream", name: "stdout", text: "more\n" }];
    await callTool(ctx, "Glob", { pattern: "*" });
    const { outputs } = nb.reads(mark);
    expect(outputs).toEqual([{ op: "get_cells", cellIds: ["c2"], includeOutputs: true, outputsHash: true }]);
    expect(writes(nb)).toBe(before + 1);
    const cells = fileCells(nb);
    expect(cells[0].outputs).toEqual([{ name: "stdout", output_type: "stream", text: ["a\n"] }]);
    expect(cells[1].outputs).toHaveLength(3);
    // The next sync is quiet again: the fresh fingerprint was cached.
    const mark2 = nb.ops.length;
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.reads(mark2).outputs).toEqual([]);
    expect(writes(nb)).toBe(before + 1);
  });

  it("writes a source, order or execution-count change without fetching outputs", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "a()" }, { type: "code", source: "b()" }]);
    nb.cells[0]!.outputs = plotOutputs();
    nb.cells[1]!.outputs = plotOutputs();
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "Glob", { pattern: "*" });
    const before = writes(nb);

    let mark = nb.ops.length;
    nb.cells[0]!.source = "a(2)";
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.reads(mark).outputs).toEqual([]);
    expect(writes(nb)).toBe(before + 1);
    expect(fileCells(nb)[0].source).toEqual(["a(2)"]);

    mark = nb.ops.length;
    nb.cells.reverse();
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.reads(mark).outputs).toEqual([]);
    expect(writes(nb)).toBe(before + 2);
    expect(fileCells(nb).map((c) => c.id)).toEqual(["c2", "c1"]);

    mark = nb.ops.length;
    nb.cells[0]!.executionCount = 9;
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.reads(mark).outputs).toEqual([]);
    expect(writes(nb)).toBe(before + 3);
    expect(fileCells(nb)[0].execution_count).toBe(9);
  });

  it("refreshes the cache without writing when outputs changed past what the file holds", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "train()" }]);
    // One long line: the file keeps its head and tail, not the middle.
    const text = (middle: string) => "H".repeat(12_000) + middle + "T".repeat(12_000);
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: text("one") }];
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "Glob", { pattern: "*" });
    const before = writes(nb);
    const mark = nb.ops.length;
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: text("two") }];
    await callTool(ctx, "Glob", { pattern: "*" });
    // The hash changed, so the outputs were fetched; the file reads the same.
    expect(nb.reads(mark).outputs).toHaveLength(1);
    expect(writes(nb)).toBe(before);
    const mark2 = nb.ops.length;
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.reads(mark2).outputs).toEqual([]);
  });

  it("still tells when a command changed the file's outputs, and keeps the syncIn path working", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "a = 1" }, { type: "code", source: "b = 2" }]);
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "1\n" }];
    nb.vm.scripts.set("edit", (vm) => {
      const doc = JSON.parse(vm.read(file)!);
      doc.cells[0].outputs = [{ output_type: "stream", name: "stdout", text: ["fake\n"] }];
      doc.cells[1].source = ["b = 20"];
      vm.write(file, JSON.stringify(doc));
      return "";
    });
    const ctx = context(nb, { overrides: long });
    const res = await callTool(ctx, "Bash", { command: "script edit" });
    expect(res.text).toContain("Applied: cell c2 changed.");
    expect(res.text).toContain("Outputs and execution counts in the notebook file come from running cells; changes to them were not applied.");
    expect(nb.cells[1]!.source).toBe("b = 20");
    // The file holds the notebook again, with the editor's real outputs.
    expect(fileCells(nb)[0].outputs).toEqual([{ name: "stdout", output_type: "stream", text: ["1\n"] }]);
    // And a sync afterwards is quiet: the write-back cached fresh fingerprints.
    const mark = nb.ops.length;
    await callTool(ctx, "Glob", { pattern: "*" });
    expect(nb.reads(mark).outputs).toEqual([]);
  });
});

describe("applyCells as one batch", () => {
  it("sends one apply_cells whose steps keep the single ops' order, and the journal follows", async () => {
    const nb = new SyncFakeNotebook([
      { type: "code", source: "a = 1" },
      { type: "code", source: "b = 2" },
      { type: "markdown", source: "notes" },
    ]);
    const journal: string[] = [];
    nb.onEvent = (e) => {
      const ev = e as { type: string; change?: { kind: string; cellId: string } };
      if (ev.type === "change_applied") journal.push(`${ev.change!.kind} ${ev.change!.cellId}`);
    };
    const ctx = context(nb, { overrides: long });
    const target = [
      { id: "c3", type: "markdown" as const, source: "notes" },
      { id: "c1", type: "code" as const, source: "a = 10" },
      { type: "code" as const, source: "c = 3" },
    ];
    const applied = await applyCells(ctx, fromCellInfo((nb.handle({ op: "get_cells" }) as any).cells), target, { concurrent: false });
    const batches = nb.ops.filter((o) => o.op === "apply_cells");
    expect(batches).toHaveLength(1);
    expect((batches[0] as Extract<NotebookOp, { op: "apply_cells" }>).steps).toEqual([
      { op: "update_cell", cellId: "c1", source: "a = 10", review: false },
      { op: "delete_cell", cellId: "c2", review: false },
      { op: "move_cell", cellId: "c3", index: 0 },
      { op: "insert_cell", index: 2, cellType: "code", source: "c = 3", review: false },
    ]);
    expect(journal).toEqual(["update c1", "delete c2", "move c3", "insert c4"]);
    expect(applied.done).toEqual(["cell c1 changed", "cell c2 deleted", "cell c3 moved to index 0", "new code cell c4 inserted at index 2"]);
    expect(nb.cells.map((c) => [c.id, c.source])).toEqual([
      ["c3", "notes"],
      ["c1", "a = 10"],
      ["c4", "c = 3"],
    ]);
  });

  it("changeNotebook passes its first read in: one plain get_cells for an Edit", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "x = 1" }]);
    const ctx = context(nb, { overrides: long });
    const res = await callTool(ctx, "Edit", { file_path: file, old_string: "x = 1", new_string: "x = 2" });
    expect(res.text).toBe("Applied: cell c1 changed.");
    const plain = nb.ops.filter((o) => o.op === "get_cells" && !o.includeOutputs && !o.outputsHash && !o.summary);
    expect(plain).toHaveLength(1);
    expect(nb.ops.filter((o) => o.op === "apply_cells")).toHaveLength(1);
    expect(nb.cells[0]!.source).toBe("x = 2");
  });

  it("a reviewed delete stays in the notebook while later steps' indexes are computed", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "a = 1" }, { type: "code", source: "b = 2" }]);
    const ctx = context(nb, { settings: { review: true }, overrides: long });
    const target = [{ id: "c2", type: "code" as const, source: "b = 2" }, { type: "code" as const, source: "c = 3" }];
    const applied = await applyCells(ctx, fromCellInfo((nb.handle({ op: "get_cells" }) as any).cells), target, { concurrent: false });
    const batch = nb.ops.find((o) => o.op === "apply_cells") as Extract<NotebookOp, { op: "apply_cells" }>;
    expect(batch.steps).toEqual([
      { op: "delete_cell", cellId: "c1", review: true },
      // c1 is still there until the user decides, so the new cell goes after c2, at 2.
      { op: "insert_cell", index: 2, cellType: "code", source: "c = 3", review: true },
    ]);
    expect(applied.reviews.map((r) => r.what)).toEqual(["Deleting cell c1", "New code cell after cell c2 (id c3)"]);
    expect(nb.cells.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    for (const id of [...nb.reviews.keys()]) nb.resolve(id, true);
    expect(nb.cells.map((c) => c.id)).toEqual(["c2", "c3"]);
  });

  it("two new cells in a row: the second names the first once its id is back", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "a = 1" }]);
    const ctx = context(nb, { overrides: long });
    const target = [
      { id: "c1", type: "code" as const, source: "a = 1" },
      { type: "code" as const, source: "b = 2" },
      { type: "markdown" as const, source: "after b" },
    ];
    const applied = await applyCells(ctx, fromCellInfo((nb.handle({ op: "get_cells" }) as any).cells), target, { concurrent: false });
    expect(applied.done).toEqual(["new code cell c2 inserted at index 1", "new markdown cell c3 inserted at index 2"]);
    const batch = nb.ops.find((o) => o.op === "apply_cells") as Extract<NotebookOp, { op: "apply_cells" }>;
    expect(batch.steps.map((s) => (s as { index: number }).index)).toEqual([1, 2]);
  });

  it("falls back to single ops only for a page that does not know apply_cells", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    const seen: NotebookOp[] = [];
    const handle = nb.handle.bind(nb);
    nb.handle = (op: NotebookOp) => {
      seen.push(op);
      return handle(op);
    };
    const ctx = context(nb, { overrides: long });
    const res = await callTool(ctx, "Edit", { file_path: file, old_string: "x = 1", new_string: "x = 2" });
    expect(res.text).toBe("Applied: cell c1 changed.");
    expect(seen.some((o) => o.op === "apply_cells")).toBe(true);
    expect(seen.filter((o) => o.op === "update_cell")).toHaveLength(1);
    expect(nb.cells[0]!.source).toBe("x = 2");
  });

  it("a batch that fails mid-way propagates: the steps before it stay applied, nothing is re-run", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "a = 1" }, { type: "code", source: "b = 2" }]);
    const sent: NotebookOp[] = [];
    const handle = nb.handle.bind(nb);
    nb.handle = (op: NotebookOp) => {
      sent.push(op);
      if (op.op === "apply_cells") {
        // Like OpRunner: steps run in order; the second one throws after the first applied.
        handle(op.steps[0]!);
        throw new Error('No cell with id "c2".');
      }
      return handle(op);
    };
    const ctx = context(nb, { overrides: long });
    const target = [
      { id: "c1", type: "code" as const, source: "a = 10" },
      { id: "c2", type: "code" as const, source: "b = 20" },
    ];
    await expect(applyCells(ctx, fromCellInfo((handle({ op: "get_cells" }) as any).cells), target, { concurrent: false })).rejects.toThrow(
      'No cell with id "c2".',
    );
    expect(nb.cells[0]!.source).toBe("a = 10");
    expect(nb.cells[1]!.source).toBe("b = 2");
    // No single-op retry of the batch: that would apply the first step twice.
    expect(sent.filter((o) => o.op === "update_cell")).toEqual([]);
  });

  it("syncOut itself still writes the file after a batched change", async () => {
    const nb = new SyncFakeNotebook([{ type: "code", source: "x = 1" }]);
    const ctx = context(nb, { overrides: long });
    await callTool(ctx, "Edit", { file_path: file, old_string: "x = 1", new_string: "x = 2" });
    expect(fileCells(nb)[0].source).toEqual(["x = 2"]);
    const mark = nb.ops.length;
    await syncOut(ctx);
    expect(nb.reads(mark).outputs).toEqual([]);
  });
});
