// Jupyter editor signals (A4.3), the runToken generation (A4.4), the
// cellsChange-driven insertCell, and the source-signal review guard — against
// a fake JupyterLab panel with lumino-style signals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewInfo } from "@ainb/protocol";
import { JupyterAdapter } from "../src/page/jupyter.js";

vi.mock("../src/page/review-widget.js", () => ({
  createReviewCard: () => ({ remove: vi.fn() }),
}));

function signal() {
  const slots: ((...args: unknown[]) => void)[] = [];
  return {
    connect: (cb: (...args: unknown[]) => void) => { slots.push(cb); },
    disconnect: (cb: (...args: unknown[]) => void) => { const i = slots.indexOf(cb); if (i >= 0) slots.splice(i, 1); },
    fire: (...args: unknown[]) => { for (const cb of [...slots]) cb(...args); },
    get size() { return slots.length; },
  };
}

function codeCell(id: string) {
  let source = "x = 1";
  const sharedModel = {
    getSource: () => source,
    setSource: (s: string) => { source = s; },
    sourceChange: signal(),
  };
  return {
    model: { id, type: "code", executionCount: null as number | null, sharedModel, outputs: { changed: signal() } },
    outputArea: { future: null as unknown },
    promptNode: { textContent: "In [ ]:" },
    node: {
      querySelector: () => null,
      firstChild: null,
      insertBefore: vi.fn(),
      contains: () => true,
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    },
    sharedModel,
  };
}

function setup() {
  const cell = codeCell("c1");
  const kernel = { status: "idle" as string, statusChanged: signal(), connectionStatusChanged: signal() };
  const sharedModel = { changed: signal(), cellsChange: signal() as ReturnType<typeof signal> | undefined, insertCell: vi.fn(), deleteCell: vi.fn() };
  const panel = {
    isDisposed: false,
    content: { widgets: [cell] as unknown[], model: { sharedModel }, activeCellChanged: signal(), selectionChanged: signal() },
    sessionContext: { kernelChanged: signal(), session: { kernel } as { kernel: unknown } },
    title: { label: "nb" },
  };
  vi.stubGlobal("window", { jupyterapp: { shell: { currentWidget: panel } } });
  vi.stubGlobal("location", { hostname: "localhost", href: "http://localhost/nb" });
  vi.stubGlobal("document", { referrer: "", getElementById: () => ({}) });
  const nudge = vi.fn();
  const adapter = new JupyterAdapter(nudge);
  return { cell, kernel, sharedModel, panel, nudge, adapter };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Jupyter run signals", () => {
  it("debounces kernel status bursts into one early beat", () => {
    const { kernel, nudge } = setup();
    kernel.statusChanged.fire();
    kernel.statusChanged.fire();
    kernel.statusChanged.fire();
    vi.advanceTimersByTime(59);
    expect(nudge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("nudges on connection status, notebook model changes, cell list changes and outputs", () => {
    const { kernel, sharedModel, cell, nudge } = setup();
    kernel.connectionStatusChanged.fire();
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(1);
    sharedModel.changed.fire();
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(2);
    sharedModel.cellsChange!.fire();
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(3);
    cell.model.outputs.changed.fire();
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(4);
  });

  it("re-hooks the new kernel on kernelChanged and leaves the old one alone", () => {
    const { kernel, panel, nudge } = setup();
    const kernel2 = { status: "idle", statusChanged: signal(), connectionStatusChanged: signal() };
    panel.sessionContext.session.kernel = kernel2;
    panel.sessionContext.kernelChanged.fire();
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(1); // the kernel change itself
    kernel2.statusChanged.fire();
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(2);
    kernel.statusChanged.fire(); // the old kernel is unhooked
    vi.advanceTimersByTime(60);
    expect(nudge).toHaveBeenCalledTimes(2);
  });

  it("dispose clears the debounce and unhooks the panel", () => {
    const { kernel, panel, nudge, adapter } = setup();
    adapter.onSelectionChange(() => {});
    kernel.statusChanged.fire(); // a beat is pending
    adapter.dispose();
    vi.advanceTimersByTime(200);
    expect(nudge).not.toHaveBeenCalled();
    expect(panel.sessionContext.kernelChanged.size).toBe(0);
    expect(kernel.statusChanged.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Jupyter runToken", () => {
  it("gives a token only once a future was witnessed, and bumps it per new future", async () => {
    const { cell, kernel, adapter } = setup();
    // No future yet: no token.
    expect(adapter.runStates()).toEqual([{ cellId: "c1", running: false, executionCount: null }]);

    const f1 = { isDisposed: false, done: Promise.resolve() };
    cell.outputArea.future = f1;
    kernel.status = "busy";
    expect(adapter.runStates()).toEqual([{ cellId: "c1", running: true, executionCount: null, runToken: "1" }]);

    await Promise.resolve(); // f1.done settles
    kernel.status = "idle";
    expect(adapter.runStates()).toEqual([{ cellId: "c1", running: false, executionCount: null, runToken: "1" }]);

    // A new future is a new run, even if the count repeats after a restart.
    cell.model.executionCount = 1;
    const f2 = { isDisposed: false, done: new Promise(() => {}) };
    cell.outputArea.future = f2;
    kernel.status = "busy";
    expect(adapter.runStates()).toEqual([{ cellId: "c1", running: true, executionCount: 1, runToken: "2" }]);
  });
});

describe("Jupyter insertCell", () => {
  it("resolves as soon as cellsChange brings the widget, without the 1s loop", async () => {
    const { panel, sharedModel, adapter } = setup();
    sharedModel.insertCell.mockReturnValue({ id: "new1" });
    let done = false;
    const inserting = adapter.insertCell(1, "code", "y = 2").then((id) => { done = true; return id; });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false); // the widget is not there yet
    panel.content.widgets.push({ model: { id: "new1" } });
    sharedModel.cellsChange!.fire();
    expect(await inserting).toBe("new1");
    expect(done).toBe(true);
    expect(sharedModel.cellsChange!.size).toBe(1); // only the adapter's own hook remains
  });

  it("still falls back to the 20ms loop when the signal is absent", async () => {
    const { panel, sharedModel, adapter } = setup();
    sharedModel.cellsChange = undefined;
    sharedModel.insertCell.mockReturnValue({ id: "new2" });
    setTimeout(() => panel.content.widgets.push({ model: { id: "new2" } }), 40);
    const inserting = adapter.insertCell(1, "code", "y = 2");
    await vi.advanceTimersByTimeAsync(60);
    expect(await inserting).toBe("new2");
  });
});

describe("Jupyter review source guard", () => {
  const review: ReviewInfo = { reviewId: "r1", cellId: "c1", cellType: "code", kind: "update", before: "x = 1", after: "x = 2" };

  it("closes the review the moment the sharedModel source signal fires", async () => {
    const { cell, adapter } = setup();
    const shown = adapter.showReview(review);
    cell.sharedModel.setSource("user edits");
    cell.sharedModel.sourceChange.fire();
    // No timer advance: the signal, not the slow interval, noticed the edit.
    expect(await shown.decided).toBe(false);
    expect(cell.sharedModel.getSource()).toBe("user edits");
  });

  it("unhooks the source signal when the review settles", async () => {
    const { cell, adapter } = setup();
    const shown = adapter.showReview(review);
    expect(cell.sharedModel.sourceChange.size).toBe(1);
    shown.resolve(true);
    expect(await shown.decided).toBe(true);
    expect(cell.sharedModel.sourceChange.size).toBe(0);
    expect(cell.sharedModel.getSource()).toBe("x = 2");
  });
});
