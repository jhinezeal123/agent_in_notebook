// The image budget at the source (A2.3): reads and runs the agent sees ask
// the page for at most what Attachments keeps, so images past it never cross
// the wire; an agent that cannot read images asks for none. The chat preview
// still shows plots (fetching them one by one, within its own cap), and
// Attachments stays as the safety net for a page that sends every image.
// wait_for_cells polls summaries only (A4.6) and fetches outputs once.

import { describe, expect, it } from "vitest";
import type { CellOutput, NotebookOp, OutputImage, RunResult } from "@ainb/protocol";
import { callTool } from "../src/notebook/tools.js";
import { FakeNotebook, TINY_PNG } from "./fixtures/fake-extension.js";
import { context } from "./fixtures/tool-context.js";

const long = { waitMs: 60_000 };
const plots = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "code" as const, source: `plot(${i})` }));

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

/** A FakeNotebook that applies the image budget and answers get_output_image. */
class BudgetFakeNotebook extends FakeNotebook {
  ops: NotebookOp[] = [];
  /** Summary reads that still report the cells as running, for wait_for_cells. */
  runningReads = 0;

  override handle(op: NotebookOp): unknown {
    this.ops.push(op);
    switch (op.op) {
      case "get_cells": {
        let { cells } = super.handle(op) as { cells: import("@ainb/protocol").CellInfo[] };
        if (op.summary && this.runningReads > 0) {
          this.runningReads--;
          cells = cells.map((c) => ({ ...c, running: true }));
        }
        if (op.maxImages !== undefined || op.maxImageBytes !== undefined) {
          const budget = makeBudget(op.maxImages, op.maxImageBytes);
          cells = cells.map((c) => (c.outputs ? { ...c, outputs: budget(c.outputs) } : c));
        }
        return { cells };
      }
      case "run_cells": {
        const r = super.handle(op) as { results: RunResult[] };
        if (op.maxImages === undefined && op.maxImageBytes === undefined) return r;
        const budget = makeBudget(op.maxImages, op.maxImageBytes);
        return { results: r.results.map((res) => ({ ...res, outputs: budget(res.outputs) })) };
      }
      case "get_output_image": {
        const c = this.cells.find((x) => x.id === op.cellId);
        return { image: c?.outputs[op.outputIndex]?.image };
      }
      default:
        return super.handle(op);
    }
  }

  ofKind<N extends NotebookOp["op"]>(name: N): Extract<NotebookOp, { op: N }>[] {
    return this.ops.filter((o): o is Extract<NotebookOp, { op: N }> => o.op === name);
  }
}

describe("the image budget at the source", () => {
  it("run_all asks for the Attachments limits; images past them are named with how to see them", async () => {
    const nb = new BudgetFakeNotebook(plots(6));
    const ctx = context(nb, { overrides: { ...long, images: true } });
    const res = await callTool(ctx, "run_all", {});
    expect(nb.ofKind("run_cells")[0]).toMatchObject({ maxImages: 4, maxImageBytes: 3_000_000 });
    expect(res.images).toHaveLength(4);
    expect(res.text.match(/image \d attached to this result/g)).toHaveLength(4);
    // The two images the page kept out: the agent is told they are there, and how to see them.
    expect(res.text.match(/\[image\/png output not attached: read this cell on its own to see it\]/g)).toHaveLength(2);
    expect(res.text).not.toContain("image 5 attached");
    // The preview had its four from the result itself: nothing fetched lazily.
    expect(nb.ofKind("get_output_image")).toEqual([]);
  });

  it("an agent that cannot read images asks for none, and the chat preview fetches them lazily", async () => {
    const nb = new BudgetFakeNotebook(plots(1));
    const shown: OutputImage[] = [];
    const ctx = context(nb, { overrides: { ...long, images: false, showOutputImage: (img) => shown.push(img) } });
    const res = await callTool(ctx, "run_cells", { cell_ids: ["c1"] });
    expect(nb.ofKind("run_cells")[0]!.maxImages).toBe(0);
    expect(res.images).toBeUndefined();
    expect(res.text).toContain("[image/png output not shown]");
    expect(res.text).not.toContain(TINY_PNG);
    // The user still sees the plot in the chat, fetched for the preview only.
    expect(nb.ofKind("get_output_image")).toEqual([{ op: "get_output_image", cellId: "c1", outputIndex: 1 }]);
    expect(shown).toEqual([{ mime: "image/png", data: TINY_PNG }]);
  });

  it("the lazy preview fetches no more than the chat keeps", async () => {
    const nb = new BudgetFakeNotebook(plots(6));
    const shown: OutputImage[] = [];
    const ctx = context(nb, { overrides: { ...long, images: false, showOutputImage: (img) => shown.push(img) } });
    await callTool(ctx, "run_all", {});
    expect(nb.ofKind("get_output_image")).toHaveLength(4);
    expect(shown).toHaveLength(4);
  });

  it("Read of the notebook asks for the budget too", async () => {
    const nb = new BudgetFakeNotebook(plots(1));
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "ran\n" }, { kind: "display", text: "<Figure>", image: { mime: "image/png", data: TINY_PNG } }];
    nb.cells[0]!.executionCount = 1;
    const ctx = context(nb, { overrides: { ...long, images: true } });
    const res = await callTool(ctx, "Read", { file_path: "test.ipynb" });
    expect(nb.ofKind("get_cells").find((o) => o.includeOutputs)).toMatchObject({ includeOutputs: true, maxImages: 4, maxImageBytes: 3_000_000 });
    expect(res.text).toContain("image 1 attached to this result");
    expect(res.images).toHaveLength(1);

    const nb2 = new BudgetFakeNotebook(plots(1));
    nb2.cells[0]!.outputs = [{ kind: "display", text: "<Figure>", image: { mime: "image/png", data: TINY_PNG } }];
    const ctx2 = context(nb2, { overrides: { ...long, images: false } });
    const res2 = await callTool(ctx2, "Read", { file_path: "test.ipynb" });
    expect(nb2.ofKind("get_cells").find((o) => o.includeOutputs)!.maxImages).toBe(0);
    expect(res2.text).toContain("[image/png output not shown]");
    expect(res2.images).toBeUndefined();
  });

  it("read_output is text only: it asks for no images", async () => {
    const nb = new BudgetFakeNotebook(plots(1));
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "ran\n" }, { kind: "display", text: "<Figure>", image: { mime: "image/png", data: TINY_PNG } }];
    const ctx = context(nb, { overrides: { ...long, images: true } });
    const res = await callTool(ctx, "read_output", { cell_id: "c1" });
    expect(nb.ofKind("get_cells")[0]).toMatchObject({ cellIds: ["c1"], includeOutputs: true, maxImages: 0 });
    expect(res.text).toContain("[image/png output not shown]");
    expect(res.text).not.toContain(TINY_PNG);
  });

  it("the byte budget keeps the first images that fit and names the rest", async () => {
    const nb = new BudgetFakeNotebook([{ type: "code", source: "plot()" }]);
    const handle = nb.handle.bind(nb);
    nb.handle = (op: NotebookOp) => {
      const r = handle(op) as any;
      if (op.op === "run_cells") {
        r.results[0].outputs = [
          { kind: "display", text: "big", image: { mime: "image/png", data: "A".repeat(2_500_000) } },
          { kind: "display", text: "small", image: { mime: "image/png", data: "B".repeat(1_000_000) } },
        ];
        // Re-apply the budget the bridge asked for, over the outputs just set.
        const budget = makeBudget(op.maxImages, op.maxImageBytes);
        r.results[0].outputs = budget(r.results[0].outputs);
      }
      return r;
    };
    const ctx = context(nb, { overrides: { ...long, images: true } });
    const res = await callTool(ctx, "run_cells", { cell_ids: ["c1"] });
    expect(res.images).toHaveLength(1);
    expect(res.images![0]!.data).toHaveLength(2_500_000);
    expect(res.text).toContain("image 1 attached to this result");
    expect(res.text).toContain("[image/png output not attached: read this cell on its own to see it]");
  });

  it("Attachments still caps a page that sends every image (the safety net)", async () => {
    const nb = new FakeNotebook(plots(6));
    const ctx = context(nb, { overrides: { ...long, images: true } });
    const res = await callTool(ctx, "run_all", {});
    expect(res.images).toHaveLength(4);
    expect(res.text).toContain("this result already carries 4 images; read this cell on its own to see it");
  });
});

describe("wait_for_cells polls summaries", () => {
  it("polls the running state without source or outputs, and fetches outputs once at the end", async () => {
    const nb = new BudgetFakeNotebook([{ type: "code", source: "train()" }]);
    nb.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "done\n" }, { kind: "display", text: "<Figure>", image: { mime: "image/png", data: TINY_PNG } }];
    nb.runningReads = 2;
    const ctx = context(nb, { overrides: { ...long, images: true } });
    const res = await callTool(ctx, "wait_for_cells", { cell_ids: ["c1"] });
    const summaries = nb.ofKind("get_cells").filter((o) => o.summary);
    expect(summaries).toHaveLength(3);
    for (const s of summaries) expect(s.includeOutputs).toBeUndefined();
    const full = nb.ofKind("get_cells").filter((o) => o.includeOutputs);
    expect(full).toEqual([{ op: "get_cells", cellIds: ["c1"], includeOutputs: true, maxImages: 4, maxImageBytes: 3_000_000 }]);
    expect(res.text).toContain("done");
    expect(res.text).toContain("image 1 attached to this result");
    expect(res.images).toHaveLength(1);
  });
});
