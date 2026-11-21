// Đợt 2 protocol: runToken (a run witnessed by the adapter, independent of the
// execution count) and reprime on kernel reconnect. Adapters without tokens
// keep the old behavior — the existing run-watcher tests pin that.

import { describe, expect, it } from "vitest";
import { RunWatcher } from "../src/run-watcher.js";
import { textHash } from "../src/text.js";
import type { CellInfo, CellRun, CellRunState } from "../src/notebook.js";

const st = (cellId: string, running: boolean, executionCount: number | null, runToken?: string): CellRunState => ({ cellId, running, executionCount, runToken });

function setup(initial: CellRunState[]) {
  let states = initial;
  let now = 1_000;
  let broken = false;
  const cells = new Map<string, CellInfo>();
  for (const s of initial) cells.set(s.cellId, { id: s.cellId, index: 0, type: "code", source: "x = 1", outputs: [] });
  const runs: CellRun[] = [];
  const watcher = new RunWatcher({
    states: () => {
      if (broken) throw new Error("notebook is reloading");
      return states;
    },
    cell: (id) => cells.get(id),
    source: (id) => cells.get(id)?.source,
    emit: (run) => runs.push(run),
    now: () => now,
  });
  return {
    runs,
    watcher,
    cells,
    tick: () => watcher.tick(),
    setStates: (next: CellRunState[]) => { states = next; },
    setNow: (next: number) => { now = next; },
    setBroken: (next: boolean) => { broken = next; },
    addCell: (s: CellRunState, index = 0) => { cells.set(s.cellId, { id: s.cellId, index, type: "code", source: "x = 1", outputs: [] }); },
  };
}

describe("RunWatcher runToken", () => {
  it("sees a new run by its token even when the execution count repeats after a restart", () => {
    const t = setup([st("c1", false, 3, "g1")]);
    t.tick();
    t.setStates([st("c1", false, 3, "g2")]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ cellId: "c1", status: "ok", executionCount: 3, by: "user" });
    t.tick();
    expect(t.runs).toHaveLength(1); // once only
  });

  it("without tokens a repeated count is still missed (the old behavior)", () => {
    const t = setup([st("c1", false, 3)]);
    t.tick();
    t.setStates([st("c1", false, 3)]);
    t.tick();
    expect(t.runs).toEqual([]);
  });

  it("a token change while running is one normal start-to-finish run", () => {
    const t = setup([st("c1", false, 3, "g1")]);
    t.tick();
    t.setStates([st("c1", true, 3, "g2")]);
    t.tick();
    expect(t.runs).toEqual([]);
    t.setNow(4_000);
    t.setStates([st("c1", false, 4, "g2")]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ executionCount: 4, durationMs: 3_000 });
  });

  it("emits for a cell that appears already finished with a token (fast run within one tick)", () => {
    const t = setup([st("c1", false, null)]);
    t.tick();
    const fresh = st("c2", false, 1, "g1");
    t.addCell(fresh, 4);
    t.setStates([st("c1", false, null), fresh]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ cellId: "c2", index: 4, executionCount: 1, by: "user" });
  });

  it("stays quiet for a new cell without a token (a paste or undo of an old cell)", () => {
    const t = setup([st("c1", false, null)]);
    t.tick();
    const pasted = st("c2", false, 12);
    t.addCell(pasted);
    t.setStates([st("c1", false, null), pasted]);
    t.tick();
    expect(t.runs).toEqual([]);
  });

  it("waits for the finish when the new cell is still running, and needs a count to call it finished", () => {
    const t = setup([st("c1", false, null)]);
    t.tick();
    const running = st("c2", true, null, "g1");
    t.addCell(running);
    t.setStates([st("c1", false, null), running]);
    t.tick();
    expect(t.runs).toEqual([]);
    t.setStates([st("c1", false, null), st("c2", false, 1, "g1")]);
    t.tick();
    expect(t.runs).toHaveLength(1);

    const u = setup([st("c1", false, null)]);
    u.tick();
    const noCount = st("c2", false, null, "g1");
    u.addCell(noCount);
    u.setStates([st("c1", false, null), noCount]);
    u.tick();
    expect(u.runs).toEqual([]);
  });

  it("marks a token run started through run_cells as the agent's", () => {
    const t = setup([st("c1", false, 3, "g1")]);
    t.tick();
    t.watcher.agentRuns.add("c1");
    t.setStates([st("c1", false, 3, "g2")]);
    t.tick();
    expect(t.runs[0]?.by).toBe("agent");
    expect(t.watcher.agentRuns.size).toBe(0);
  });

  it("keeps the fast run's source for stale marking", () => {
    const t = setup([st("c1", false, null)]);
    t.tick();
    const fresh = st("c2", false, 1, "g1");
    t.addCell(fresh);
    t.setStates([st("c1", false, null), fresh]);
    t.tick();
    expect(t.watcher.isStale("c2", "x = 1")).toBe(false);
    t.cells.get("c2")!.source = "edited";
    expect(t.watcher.isStale("c2", "edited")).toBe(true);
  });
});

describe("RunWatcher reprime", () => {
  it("clears stale marks and emits nothing, then catches later runs", () => {
    const t = setup([st("c1", false, null)]);
    t.tick();
    t.setStates([st("c1", false, 1)]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    t.cells.get("c1")!.source = "edited";
    expect(t.watcher.isStale("c1", "edited")).toBe(true);

    t.watcher.reprime();
    expect(t.runs).toHaveLength(1); // no emit
    expect(t.watcher.isStale("c1", "edited")).toBe(false); // ranHash cleared
    t.tick();
    expect(t.runs).toHaveLength(1); // same count after reprime: no phantom run
    t.setStates([st("c1", false, 2)]);
    t.tick();
    expect(t.runs).toHaveLength(2);
  });

  it("keeps its knowledge when the states read fails during reprime", () => {
    const t = setup([st("c1", false, 1)]);
    t.tick();
    t.setBroken(true);
    expect(() => t.watcher.reprime()).not.toThrow();
    t.setBroken(false);
    t.tick();
    expect(t.runs).toEqual([]); // count 1 still known
    t.setStates([st("c1", false, 2)]);
    t.tick();
    expect(t.runs).toHaveLength(1);
  });
});

describe("RunWatcher isStaleHash", () => {
  it("answers like isStale for a precomputed hash", () => {
    const t = setup([st("c1", false, null)]);
    t.tick();
    t.setStates([st("c1", false, 1)]);
    t.tick();
    expect(t.watcher.isStaleHash("c1", textHash("x = 1"))).toBe(false);
    expect(t.watcher.isStaleHash("c1", textHash("edited"))).toBe(true);
    expect(t.watcher.isStaleHash("c1", textHash("edited"))).toBe(t.watcher.isStale("c1", "edited"));
    expect(t.watcher.isStaleHash("unknown", textHash("x"))).toBe(false);
  });
});