import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewInfo } from "@ainb/protocol";
import { JupyterAdapter } from "../src/page/jupyter.js";

vi.mock("../src/page/review-widget.js", () => ({
  createReviewCard: () => ({ remove: vi.fn() }),
}));

function panel(source = "x = 1") {
  const sharedCell = {
    getSource: () => source,
    setSource: (next: string) => { source = next; },
  };
  const node = {
    querySelector: () => null,
    firstChild: null,
    insertBefore: vi.fn(),
    contains: () => true,
    scrollIntoView: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  };
  const cell = { model: { id: "shared-id", sharedModel: sharedCell }, node };
  const widgets = [cell];
  const deleteCell = vi.fn((index: number) => { widgets.splice(index, 1); });
  return {
    isDisposed: false,
    content: { widgets, model: { sharedModel: { deleteCell } } },
    sessionContext: {},
    sharedCell,
    deleteCell,
  };
}

const review = (kind: ReviewInfo["kind"] = "update"): ReviewInfo => ({
  reviewId: "review-1", cellId: "shared-id", cellType: "code", kind,
  before: kind === "insert" ? "" : "x = 1", after: kind === "delete" ? "" : "x = 2",
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { hostname: "localhost" });
  vi.stubGlobal("document", { referrer: "", getElementById: () => ({}) });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const original = panel();
  const other = panel("other notebook");
  const shell = { currentWidget: original };
  vi.stubGlobal("window", { jupyterapp: { shell } });
  return { original, other, shell, adapter: new JupyterAdapter() };
}

describe("Jupyter review ownership", () => {
  it("applies an update to its original notebook after switching to a copy", async () => {
    const { original, other, shell, adapter } = setup();
    const shown = adapter.showReview(review());
    shell.currentWidget = other;
    await vi.advanceTimersByTimeAsync(1000);
    shown.resolve(true);
    expect(await shown.decided).toBe(true);
    expect(original.sharedCell.getSource()).toBe("x = 2");
    expect(other.sharedCell.getSource()).toBe("other notebook");
  });

  it.each(["delete", "insert"] as const)("resolves a %s review only in its original notebook", async (kind) => {
    const { original, other, shell, adapter } = setup();
    const shown = adapter.showReview(review(kind));
    shell.currentWidget = other;
    shown.resolve(kind === "delete");
    expect(await shown.decided).toBe(kind === "delete");
    expect(original.content.widgets).toHaveLength(0);
    expect(other.content.widgets).toHaveLength(1);
    expect(other.deleteCell).not.toHaveBeenCalled();
  });

  it("rejects a review when the original cell is deleted, even if another notebook has its ID", async () => {
    const { original, other, shell, adapter } = setup();
    const shown = adapter.showReview(review());
    original.content.widgets.splice(0, 1);
    shell.currentWidget = other;
    shown.resolve(true);
    expect(await shown.decided).toBe(false);
    expect(other.sharedCell.getSource()).toBe("other notebook");
  });

  it("rejects a review if its notebook was disposed", async () => {
    const { original, adapter } = setup();
    const shown = adapter.showReview(review());
    original.isDisposed = true;
    shown.resolve(true);
    expect(await shown.decided).toBe(false);
    expect(original.sharedCell.getSource()).toBe("x = 1");
  });
});

describe("Jupyter review conflicts", () => {
  it.each(["update", "delete", "insert"] as const)("preserves user edits when accepting a stale %s review", async (kind) => {
    const { original, adapter } = setup();
    const shown = adapter.showReview(review(kind));
    original.sharedCell.setSource("user edits made while waiting");
    shown.resolve(true);
    expect(await shown.decided).toBe(false);
    expect(original.sharedCell.getSource()).toBe("user edits made while waiting");
    expect(original.deleteCell).not.toHaveBeenCalled();
  });

  it("preserves user edits when rejecting a proposed insertion", async () => {
    const { original, adapter } = setup();
    const shown = adapter.showReview(review("insert"));
    original.sharedCell.setSource("user kept and edited this cell");
    shown.resolve(false);
    expect(await shown.decided).toBe(false);
    expect(original.content.widgets).toHaveLength(1);
    expect(original.sharedCell.getSource()).toBe("user kept and edited this cell");
  });

  it("automatically closes a review when its source changes", async () => {
    const { original, adapter } = setup();
    const shown = adapter.showReview(review());
    original.sharedCell.setSource("new source");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await shown.decided).toBe(false);
    shown.resolve(true);
    expect(original.sharedCell.getSource()).toBe("new source");
  });
});
