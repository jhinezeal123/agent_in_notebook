// Easy-read: finding the words a citation quotes, in the paper's HTML and in a
// PDF's text layer (segments are the page's text nodes, in order).

import { describe, expect, it } from "vitest";
import { comparable, findQuote } from "../src/reader/anchors.js";

describe("findQuote", () => {
  it("finds a quote across text nodes, with spaces, quotes and dashes as the paper has them", () => {
    const segments = ["We use a random ", "Gaussian", " initialization for ", "A", " and zero for B, so ΔW = BA is zero."];
    expect(findQuote(segments, "random Gaussian initialization")).toEqual({ start: { segment: 0, offset: 9 }, end: { segment: 2, offset: 15 } });
    expect(findQuote(segments, "  ZERO for   b ")).toEqual({ start: { segment: 4, offset: 5 }, end: { segment: 4, offset: 15 } });
    expect(findQuote(["the “best” model — ours"], '"best" model - ours')).toEqual({ start: { segment: 0, offset: 4 }, end: { segment: 0, offset: 23 } });
  });

  it("finds words a PDF split at a line end, or ran together", () => {
    const pdf = ["We propose Low-Rank Adap-", "tation, or LoRA, which", "freezes the pre-trained", "model weights"];
    const span = findQuote(pdf, "Low-Rank Adaptation, or LoRA");
    expect(span).toEqual({ start: { segment: 0, offset: 11 }, end: { segment: 1, offset: 15 } });
    expect(findQuote(pdf, "which freezes the pre-trained model")).toEqual({ start: { segment: 1, offset: 17 }, end: { segment: 3, offset: 5 } });
  });

  it("reads ligatures as their letters", () => {
    expect(findQuote(["eﬃcient ﬁne-tuning"], "efficient fine-tuning")).toEqual({ start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 18 } });
  });

  it("says when the words are not there", () => {
    expect(findQuote(["nothing like it"], "zero for B")).toBeNull();
    expect(findQuote(["x"], "   ")).toBeNull();
    expect(findQuote([], "x")).toBeNull();
  });
});

describe("comparable", () => {
  it("keeps where each character came from", () => {
    const c = comparable("A  “b”");
    expect(c.text).toBe('a "b"');
    expect(c.from).toEqual([0, 1, 3, 4, 5]);
    expect(comparable(" a-b c ", true).text).toBe("abc");
  });
});
