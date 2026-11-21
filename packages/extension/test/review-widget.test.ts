// The review card's bounded first render and "Show all" expansion (A6.8),
// against a minimal fake DOM — no browser needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewInfo } from "@ainb/protocol";
import { createReviewCard } from "../src/page/review-widget.js";

class FakeText {
  constructor(public textContent: string) {}
}

class FakeElement {
  className = "";
  textContent = "";
  title = "";
  dataset: Record<string, string> = {};
  children: (FakeElement | FakeText)[] = [];
  parent: FakeElement | null = null;
  shadow: FakeElement | null = null;
  listeners = new Map<string, ((e: Record<string, unknown>) => void)[]>();

  constructor(public tagName: string) {}

  append(...nodes: (FakeElement | FakeText)[]) {
    for (const n of nodes) {
      if (n instanceof FakeElement) n.parent = this;
      this.children.push(n);
    }
  }

  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  addEventListener(type: string, cb: (e: Record<string, unknown>) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  /** Fire the listeners the way a press or a key would. */
  dispatch(type: string, props: Record<string, unknown> = {}) {
    for (const cb of this.listeners.get(type) ?? []) cb({ button: 0, preventDefault: () => {}, stopPropagation: () => {}, ...props });
  }

  attachShadow() {
    this.shadow = new FakeElement("shadow-root");
    return this.shadow;
  }

  get rows(): FakeElement[] {
    return this.children.filter((c): c is FakeElement => c instanceof FakeElement && c.className.startsWith("row"));
  }

  byClass(cls: string): FakeElement | undefined {
    return this.children.find((c): c is FakeElement => c instanceof FakeElement && c.className === cls);
  }
}

function cardOf(host: FakeElement) {
  const root = host.shadow!;
  const card = root.children.find((c): c is FakeElement => c instanceof FakeElement && c.className === "card")!;
  return { card, body: card.byClass("diff")!, more: card.byClass("show-all") };
}

const review = (kind: ReviewInfo["kind"], before: string, after: string): ReviewInfo => ({
  reviewId: "r1", cellId: "c1", cellType: "code", kind, before, after,
});

const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("review card bounded render", () => {
  it("renders a small diff fully, without a Show all button", () => {
    const decide = vi.fn();
    const host = createReviewCard(review("update", "a\nb\nc", "a\nB\nc"), decide) as unknown as FakeElement;
    const { body, more } = cardOf(host);
    expect(body.rows).toHaveLength(4);
    expect(more).toBeUndefined();
    // Accept is still a press, as before.
    const accept = cardOf(host).card.byClass("head")!.byClass("accept")!;
    accept.dispatch("pointerdown");
    expect(decide).toHaveBeenCalledWith(true);
  });

  it("caps the first render at 300 rows and offers the whole diff", () => {
    const host = createReviewCard(review("update", lines(600, "old"), lines(600, "new")), () => {}) as unknown as FakeElement;
    const { card, body, more } = cardOf(host);
    // 600×600 is past the display's LCS budget: replace-all, 1200 rows.
    expect(body.rows).toHaveLength(300);
    expect(more).toBeDefined();
    expect(more!.textContent).toBe("Show all 1200 lines");
    const stats = card.byClass("head")!.byClass("stats")!;
    expect(stats.children.map((c) => c.textContent).join("")).toBe("+600 −600");
  });

  it("builds the rest in chunks on Show all, then the button is gone", async () => {
    const host = createReviewCard(review("update", lines(600, "old"), lines(600, "new")), () => {}) as unknown as FakeElement;
    const { body, more } = cardOf(host);
    more!.dispatch("pointerdown");
    expect(more!.parent).toBeNull(); // removed at once
    expect(body.rows.length).toBeLessThan(1200); // not all in one go
    await vi.advanceTimersByTimeAsync(50);
    expect(body.rows).toHaveLength(1200);
    expect(cardOf(host).more).toBeUndefined();
    // The last row is really the last line of the diff.
    expect(body.rows.at(-1)!.byClass("text")!.textContent).toBe("new599");
  });

  it("expands from the keyboard too, and twice is harmless", async () => {
    const host = createReviewCard(review("insert", "", lines(400, "line")), () => {}) as unknown as FakeElement;
    const { body, more } = cardOf(host);
    expect(body.rows).toHaveLength(300);
    expect(more!.textContent).toBe("Show all 400 lines");
    more!.dispatch("click");
    more!.dispatch("pointerdown");
    await vi.advanceTimersByTimeAsync(50);
    expect(body.rows).toHaveLength(400);
  });

  it("still diffs precisely under the LCS budget", () => {
    const before = lines(100, "line");
    const after = before.replace("line50", "changed50");
    const host = createReviewCard(review("update", before, after), () => {}) as unknown as FakeElement;
    const { card, body, more } = cardOf(host);
    expect(more).toBeUndefined(); // small diff: everything at once
    const texts = body.rows.map((r) => r.byClass("text")?.textContent ?? r.textContent);
    expect(texts).toContain("line50");
    expect(texts).toContain("changed50");
    expect(body.rows.some((r) => r.className === "row s")).toBe(true); // collapsed unchanged runs
    const stats = card.byClass("head")!.byClass("stats")!;
    expect(stats.children.map((c) => c.textContent).join("")).toBe("+1 −1");
  });

  it("Accept and Reject work while the diff is still collapsed", () => {
    const decide = vi.fn();
    const host = createReviewCard(review("update", lines(600, "old"), lines(600, "new")), decide) as unknown as FakeElement;
    const head = cardOf(host).card.byClass("head")!;
    head.byClass("reject")!.dispatch("pointerdown");
    expect(decide).toHaveBeenCalledWith(false);
    head.byClass("accept")!.dispatch("click");
    expect(decide).toHaveBeenCalledWith(true);
  });
});
