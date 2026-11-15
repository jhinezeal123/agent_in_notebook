import { describe, expect, it } from "vitest";
import type { CellInfo, MachineStats } from "@ainb/protocol";
import { attachedCellsBlock, machineLine, recap, runState } from "../src/instructions.js";

const cell = (index: number, over: Partial<CellInfo> = {}): CellInfo => ({ id: `c${index}`, index, type: "code", source: `x = ${index}`, executionCount: null, ...over });

describe("machineLine", () => {
  it("shows machine resources and warns about low memory, disk and GPU memory", () => {
    const machine: MachineStats = {
      at: 1_000_000,
      memTotal: 12_700_000_000,
      memAvailable: 1_000_000_000,
      diskTotal: 108_000_000_000,
      diskFree: 4_000_000_000,
      gpus: [{ name: "Tesla T4", memUsed: 14_000_000_000, memTotal: 15_000_000_000, util: 8 }],
    };
    const line = machineLine(machine, 1_120_000)!;
    expect(line).toContain("Machine: RAM");
    expect(line).toContain("LOW MEMORY");
    expect(line).toContain("DISK NEARLY FULL");
    expect(line).toContain("GPU MEMORY NEARLY FULL");
    expect(line).toContain("(read 2 min ago)");
  });

  it("returns null when there are no usable stats", () => {
    expect(machineLine({ at: 1 }, 2)).toBeNull();
  });
});

describe("runState", () => {
  it("describes running, stale, out-of-order and unrun cells", () => {
    const lines = runState([
      cell(0, { running: true, stale: true }),
      cell(1, { executionCount: 5, stale: true }),
      cell(2, { executionCount: 2 }),
      cell(3),
      cell(4, { executionCount: 9 }),
    ]);
    expect(lines).toEqual([
      "Running now: [0] c0",
      "Edited since they last ran (what they define may be out of date): [0] c0, [1] c1",
      "Executed out of top-to-bottom order: [2] ran before [1].",
      "Not run, above cells that ran: [0] c0, [3] c3",
    ]);
  });

  it("returns nothing for a clean top-to-bottom notebook", () => {
    expect(runState([cell(0, { executionCount: 1 }), cell(1, { executionCount: 2 })])).toEqual([]);
  });

  it("caps the unrun list at ten cells", () => {
    const cells = [...Array.from({ length: 12 }, (_, i) => cell(i)), cell(12, { executionCount: 1 })];
    expect(runState(cells).at(-1)).toContain("… 2 more");
  });
});

describe("attachedCellsBlock", () => {
  const attach = (c: CellInfo) => ({ cellId: c.id, index: c.index, label: c.source });
  const render = (c: CellInfo) => `### cell [${c.index}] id=${c.id}\n${c.source}`;

  it("shows every attached cell within the budget, in the order attached", () => {
    const block = attachedCellsBlock([attach(cell(2)), attach(cell(0))], [cell(0), cell(2)], render);
    expect(block.startsWith("<attached-cells>\n")).toBe(true);
    expect(block.endsWith("\n</attached-cells>")).toBe(true);
    expect(block.indexOf("id=c2")).toBeLessThan(block.indexOf("id=c0"));
  });

  it("names the cells past the budget instead of showing them, but always shows the first", () => {
    const big = cell(0, { source: "a".repeat(500) });
    const block = attachedCellsBlock([attach(big), attach(cell(1)), attach(cell(2))], [big, cell(1), cell(2)], render, 100);
    expect(block).toContain("a".repeat(500));
    expect(block).toContain("not shown here to save space (Read them): [1] c1, [2] c2.");
  });

  it("asks the agent to read them when the notebook could not be read", () => {
    const block = attachedCellsBlock([attach(cell(4))], null, render);
    expect(block).toContain("could not be read now; Read them in the notebook: [4] c4.");
  });
});

describe("recap", () => {
  it("names the cells attached to a user message", () => {
    const text = recap([{ id: "m", role: "user", createdAt: 0, parts: [{ type: "text", text: "why?" }, { type: "cells", cells: [{ cellId: "c3", index: 3, label: "x = 3" }] }] }]);
    expect(text).toContain("User: why?\n[attached cells: [3] c3]");
  });
});
