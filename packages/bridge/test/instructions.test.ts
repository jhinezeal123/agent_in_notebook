import { describe, expect, it } from "vitest";
import type { CellInfo, MachineStats } from "@ainb/protocol";
import { machineLine, runState } from "../src/instructions.js";

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
