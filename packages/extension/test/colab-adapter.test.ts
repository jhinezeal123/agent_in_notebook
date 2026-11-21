// Colab adapter pieces that do not need a real Colab (A4.2): the id index in
// getCells, the selection listener with its fallback poll, and dispose.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColabAdapter } from "../src/page/colab.js";

type FakeCell = {
  id: string;
  type: string;
  text: string;
  count: number | null;
  running: boolean;
  selected: boolean;
};

function fakeCell(id: string, over: Partial<FakeCell> = {}) {
  const c: FakeCell = { id, type: "code", text: `# ${id}`, count: null, running: false, selected: false, ...over };
  return {
    raw: c,
    getId: () => c.id,
    getType: () => c.type,
    getText: () => c.text,
    isRunning: () => c.running,
    isSelected: () => c.selected,
    getModel: () => ({ toJson: () => ({ execution_count: c.count, outputs: [] }) }),
  };
}

function setup(getElement?: () => unknown) {
  const cells = [fakeCell("a"), fakeCell("b", { count: 2 }), fakeCell("m", { type: "markdown" })];
  const nb = {
    cells,
    getCells: () => cells,
    focusedCell: null as unknown,
    getElement: getElement ?? (() => { throw new Error("no element"); }),
  };
  vi.stubGlobal("window", { colab: { global: { notebook: nb } } });
  vi.stubGlobal("location", { hostname: "colab.research.google.com", href: "https://colab.research.google.com/x", origin: "https://colab.research.google.com" });
  vi.stubGlobal("document", { title: "My notebook - Colab" });
  return { nb, cells, adapter: new ColabAdapter() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ColabAdapter.getCells", () => {
  it("looks cells up through one index, in the asked order, skipping unknown ids", () => {
    const { adapter } = setup();
    const cells = adapter.getCells({ cellIds: ["b", "zz", "a"] });
    expect(cells.map((c) => [c.id, c.index])).toEqual([["b", 1], ["a", 0]]);
    expect(cells[0]!.executionCount).toBe(2);
    expect(cells[0]!.source).toBe("# b");
  });

  it("still reads every cell without cellIds, with running state from isRunning", () => {
    const { adapter, cells } = setup();
    cells[0]!.raw.running = true;
    const all = adapter.getCells({});
    expect(all.map((c) => c.id)).toEqual(["a", "b", "m"]);
    expect(all[0]!.running).toBe(true);
    expect(all[2]!.type).toBe("markdown");
    expect(all[2]!.executionCount).toBeUndefined();
  });
});

describe("ColabAdapter selection", () => {
  it("polls at 1s when the focusChanged listener cannot be attached, and dispose stops it", () => {
    const { adapter } = setup(); // getElement throws
    const cb = vi.fn();
    adapter.onSelectionChange(cb);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    adapter.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("verifies a attached listener slowly, then stops polling once it really fires", () => {
    let listener: (() => void) | null = null;
    const el = {
      addEventListener: vi.fn((name: string, cb: () => void) => { if (name === "focusChanged") listener = cb; }),
      removeEventListener: vi.fn(),
    };
    const { adapter, nb } = setup(() => el);
    const cb = vi.fn();
    adapter.onSelectionChange(cb);
    expect(el.addEventListener).toHaveBeenCalledWith("focusChanged", expect.any(Function));
    // Attached, but not proven yet: a slow verification poll, not the old 1s one.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(cb).toHaveBeenCalledTimes(1);
    // The listener fires: the poll is gone for good.
    nb.focusedCell = { getId: () => "b", isInNotebook: () => true };
    listener!();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(2);
    adapter.dispose();
    expect(el.removeEventListener).toHaveBeenCalledWith("focusChanged", expect.any(Function));
  });

  it("falls back to the 1s poll when the element has no addEventListener", () => {
    const { adapter } = setup(() => ({}));
    const cb = vi.fn();
    adapter.onSelectionChange(cb);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});
