// The pulse a page can measure and adapt: one info() per beat, a changeable interval.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpRunner, type NotebookAdapter } from "../src/adapter.js";
import type { CellInfo, NotebookInfo } from "../src/notebook.js";

function fakeAdapter(counts: { info: number }): NotebookAdapter {
  const info: NotebookInfo = {
    platform: "jupyter", title: "t", url: "http://x", cellCount: 1,
    activeCellId: "c1", selectedCellIds: [], kernel: "idle", language: "python",
  };
  const cell: CellInfo = { id: "c1", index: 0, type: "code", source: "x = 1", executionCount: null, running: false };
  const nope = () => { throw new Error("not used in this test"); };
  return {
    platform: "jupyter",
    info: () => { counts.info++; return info; },
    getCells: () => [cell],
    runStates: () => [{ cellId: "c1", running: false, executionCount: null }],
    setSource: nope, insertCell: nope, deleteCell: nope, moveCell: nope, runCell: nope,
    startExecution: nope, interrupt: nope, focusCell: nope, showReview: nope,
    onSelectionChange: () => {},
  };
}

afterEach(() => vi.useRealTimers());

describe("OpRunner pulse", () => {
  it("reads info once per beat, and setPollMs changes or stops the beat", () => {
    vi.useFakeTimers();
    const counts = { info: 0 };
    const runner = new OpRunner(fakeAdapter(counts), () => {}, { pollMs: 1000 });
    expect(counts.info).toBe(1); // primed in the constructor
    vi.advanceTimersByTime(3000);
    expect(counts.info).toBe(4); // one info per pulse, shared with the kernel check
    runner.setPollMs(2000);
    vi.advanceTimersByTime(2000);
    expect(counts.info).toBe(5);
    vi.advanceTimersByTime(2000);
    expect(counts.info).toBe(6);
    runner.setPollMs(null);
    vi.advanceTimersByTime(10_000);
    expect(counts.info).toBe(6);
    expect(runner.pulseMs).toBeGreaterThanOrEqual(0);
    runner.dispose();
  });

  it("dispose releases the adapter's own holds", () => {
    vi.useFakeTimers();
    const counts = { info: 0 };
    let disposed = 0;
    const adapter = { ...fakeAdapter(counts), dispose: () => { disposed++; } };
    const runner = new OpRunner(adapter, () => {}, { pollMs: 1000 });
    runner.dispose();
    expect(disposed).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(counts.info).toBe(1);
  });
});
