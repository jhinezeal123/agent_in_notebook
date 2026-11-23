// Easy-read: the citations the tutor writes ([[S4.SS1]], [[p4: "words"]]) and
// how their chips read in the chat.

import { describe, expect, it } from "vitest";
import { parseReaderCite, readerChatKey, readerCiteLabel, readerPaperOf } from "../src/reader.js";

describe("parseReaderCite", () => {
  it("reads the ids of the HTML: sections, paragraphs, equations, figures, tables, appendices, references", () => {
    for (const id of ["S4", "S4.SS1", "S4.SS1.p2", "S2.E1", "S1.F1", "S3.T1", "A1", "A2.SS3", "bib.bib12", "abstract", "S1.SS0.SSS0.Px1.p1"]) {
      expect(parseReaderCite(id)).toEqual({ id });
    }
    expect(parseReaderCite("  S4.SS1 ")).toEqual({ id: "S4.SS1" });
  });

  it("reads a phrase in a paragraph, and in a PDF's page", () => {
    expect(parseReaderCite('S4.SS1.p2: "zero for B"')).toEqual({ id: "S4.SS1.p2", quote: "zero for B" });
    expect(parseReaderCite("S4.SS1.p2: “zero for B”")).toEqual({ id: "S4.SS1.p2", quote: "zero for B" });
    expect(parseReaderCite('p4: "scaled dot-product attention"')).toEqual({ page: 4, quote: "scaled dot-product attention", id: "page-4" });
    expect(parseReaderCite('"only the words"')).toEqual({ quote: "only the words" });
  });

  it("reads a PDF page", () => {
    expect(parseReaderCite("page-4")).toEqual({ id: "page-4", page: 4 });
    expect(parseReaderCite("p12")).toEqual({ id: "page-12", page: 12 });
  });

  it("is not fooled by ordinary [[ ]] text", () => {
    for (const s of ["Figure 1", "foo bar", "", "x", "see §4"]) expect(parseReaderCite(s)).toBeNull();
  });
});

describe("readerCiteLabel", () => {
  const sections = [{ id: "S4", number: "4", title: "Our Method" }, { id: "S4.SS1", number: "4.1", title: "Low-Rank Updates" }, { id: "abstract", title: "Abstract" }];

  it("names sections, paragraphs, equations, figures and tables as a reader would", () => {
    expect(readerCiteLabel({ id: "S4.SS1" }, sections)).toBe("§4.1");
    expect(readerCiteLabel({ id: "S4.SS1.p2" }, sections)).toBe("§4.1 ¶2");
    expect(readerCiteLabel({ id: "S2.E1" })).toBe("Eq. 1");
    expect(readerCiteLabel({ id: "S1.F1" })).toBe("Fig. 1");
    expect(readerCiteLabel({ id: "S3.T2" })).toBe("Table 2");
    expect(readerCiteLabel({ id: "bib.bib7" })).toBe("[7]");
    expect(readerCiteLabel({ id: "abstract" })).toBe("Abstract");
  });

  it("works out numbers without the outline, appendices as letters", () => {
    expect(readerCiteLabel({ id: "S5.SS2" })).toBe("§5.2");
    expect(readerCiteLabel({ id: "A2" })).toBe("App. B");
    expect(readerCiteLabel({ id: "A1.SS3" })).toBe("App. A.3");
    expect(readerCiteLabel({ id: "S5.SS2.p3" })).toBe("§5.2 ¶3");
  });

  it("names pages and phrases", () => {
    expect(readerCiteLabel({ id: "page-4", page: 4 })).toBe("tr. 4");
    expect(readerCiteLabel({ id: "page-4", page: 4, quote: "scaled dot-product attention is fast" })).toBe("tr. 4: “scaled dot-product attentio…”");
    expect(readerCiteLabel({ quote: "only the words" })).toBe("“only the words”");
  });
});

describe("the tutor chat's key", () => {
  it("follows the paper", () => {
    expect(readerChatKey("arxiv-2106-09685")).toBe("reader:arxiv-2106-09685");
    expect(readerPaperOf("reader:arxiv-2106-09685")).toBe("arxiv-2106-09685");
    expect(readerPaperOf("file:///x.ipynb")).toBeNull();
    expect(readerPaperOf(undefined)).toBeNull();
  });
});
