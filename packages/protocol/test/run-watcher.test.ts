import { describe, expect, it } from "vitest";
import { RunWatcher } from "../src/run-watcher.js";
import type { CellInfo, CellOutput, CellRun, CellRunState } from "../src/notebook.js";

const state = (running: boolean, executionCount: number | null, lastDurationMs?: number): CellRunState => ({ cellId: "c1", running, executionCount, lastDurationMs });
const cell = (outputs: CellOutput[] = []): CellInfo => ({ id: "c1", index: 7, type: "code", source: "\nmodel.fit(X_train, y_train)", outputs });

function setup(initial: CellRunState[] = [state(false, null)], outputs: CellOutput[] = []) {
  let states = initial;
  let now = 1_000;
  let broken = false;
  let cellBroken = false;
  let currentCell: CellInfo | undefined = cell(outputs);
  const runs: CellRun[] = [];
  const watcher = new RunWatcher({
    states: () => {
      if (broken) throw new Error("notebook is reloading");
      return states;
    },
    cell: () => {
      if (cellBroken) throw new Error("outputs are reloading");
      return currentCell;
    },
    emit: (run) => runs.push(run),
    now: () => now,
  });
  return {
    runs,
    watcher,
    tick: () => watcher.tick(),
    setStates: (next: CellRunState[]) => { states = next; },
    setNow: (next: number) => { now = next; },
    setBroken: (next: boolean) => { broken = next; },
    setCellBroken: (next: boolean) => { cellBroken = next; },
    setSource: (source: string) => { if (currentCell) currentCell.source = source; },
    removeCell: () => { currentCell = undefined; },
  };
}

describe("RunWatcher", () => {
  it("primes without reporting runs from before the page loaded", () => {
    const t = setup([state(false, 12)]);
    t.tick();
    expect(t.runs).toEqual([]);
  });

  it("reports a running-to-idle transition once, with wall time and the source head", () => {
    const t = setup([state(true, null)]);
    t.tick();
    t.setNow(4_500);
    t.setStates([state(false, 1)]);
    t.tick();
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({
      cellId: "c1", index: 7, status: "ok", executionCount: 1, by: "user",
      durationMs: 3_500, head: "model.fit(X_train, y_train)",
    });
  });

  it("catches a run shorter than one tick by its execution count", () => {
    const t = setup([state(false, 3)]);
    t.tick();
    t.setStates([state(false, 4, 1_250)]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ status: "ok", executionCount: 4, durationMs: 1_250 });
  });

  it("has no wall time when a short run was not seen starting", () => {
    const t = setup([state(false, null)]);
    t.tick();
    t.setStates([state(false, 1)]);
    t.tick();
    expect(t.runs[0]?.durationMs).toBeUndefined();
  });

  it("uses the last error output and recognizes KeyboardInterrupt", () => {
    const errors: CellOutput[] = [
      { kind: "error", ename: "ValueError", evalue: "first" },
      { kind: "error", ename: "TypeError", evalue: "last" },
    ];
    const t = setup([state(false, null)], errors);
    t.tick();
    t.setStates([state(false, 1)]);
    t.tick();
    expect(t.runs[0]).toMatchObject({ status: "error", ename: "TypeError", evalue: "last" });

    const interrupted = setup([state(false, null)], [{ kind: "error", ename: "KeyboardInterrupt", evalue: "stopped" }]);
    interrupted.tick();
    interrupted.setStates([state(false, 1)]);
    interrupted.tick();
    expect(interrupted.runs[0]).toMatchObject({ status: "interrupted", ename: "KeyboardInterrupt", evalue: "stopped" });
  });

  it("marks only the run started through run_cells as the agent's", () => {
    const t = setup();
    t.tick();
    t.watcher.agentRuns.add("c1");
    t.setStates([state(false, 1)]);
    t.tick();
    t.setStates([state(false, 2)]);
    t.tick();
    expect(t.runs.map((run) => run.by)).toEqual(["agent", "user"]);
    expect(t.watcher.agentRuns.size).toBe(0);
  });

  it("keeps the source from the run start when it is edited while running", () => {
    const t = setup([state(true, null)]);
    t.tick();
    t.setSource("edited = true");
    t.setStates([state(false, 1)]);
    t.tick();
    expect(t.watcher.isStale("c1", "edited = true")).toBe(true);
    expect(t.watcher.isStale("c1", "\nmodel.fit(X_train, y_train)")).toBe(false);
  });

  it("uses the last seen source for a fast user run edited before the same tick", () => {
    const t = setup([state(false, null)]);
    t.tick();
    t.setStates([state(false, 1)]);
    t.setSource("edited = true");
    t.tick();
    expect(t.watcher.isStale("c1", "edited = true")).toBe(true);
  });

  it("does not report a cell deleted while it was running", () => {
    const t = setup([state(true, null)]);
    t.tick();
    t.watcher.agentRuns.add("c1");
    t.removeCell();
    t.setStates([]);
    expect(t.tick).not.toThrow();
    expect(t.runs).toEqual([]);
    expect(t.watcher.agentRuns.size).toBe(0);
  });

  it("keeps its previous states when reading them fails", () => {
    const t = setup([state(true, null)]);
    t.tick();
    t.setBroken(true);
    t.setStates([state(false, 1)]);
    expect(t.tick).not.toThrow();
    expect(t.runs).toEqual([]);
    t.setBroken(false);
    t.tick();
    expect(t.runs).toHaveLength(1);
  });

  it("ignores an output read failure and settles the agent marker", () => {
    const t = setup();
    t.tick();
    t.watcher.agentRuns.add("c1");
    t.setCellBroken(true);
    t.setStates([state(false, 1)]);
    expect(t.tick).not.toThrow();
    expect(t.runs).toEqual([]);
    expect(t.watcher.agentRuns.size).toBe(0);

    t.setCellBroken(false);
    t.setStates([state(false, 2)]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.by).toBe("user");
  });

  it("reports a user run once it ends when the count only shows after the run (VS Code)", () => {
    // VS Code's adapter reports no count while a user's run is in progress.
    const t = setup([state(false, 5, 1_000)], [{ kind: "error", ename: "ValueError", evalue: "bad shape" }]);
    t.tick();
    t.setStates([state(false, null)]);
    t.tick();
    expect(t.runs).toEqual([]);
    t.setStates([state(false, 6, 90_000)]);
    t.tick();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ status: "error", executionCount: 6, durationMs: 90_000, ename: "ValueError" });
  });

  it("hashes sources through `source` without reading outputs", () => {
    let outputReads = 0;
    const watcher = new RunWatcher({
      states: () => [state(true, null)],
      cell: () => { outputReads++; return cell(); },
      source: () => "x = 1",
      emit: () => {},
    });
    watcher.tick();
    expect(outputReads).toBe(0);
  });
});
