// Easy-read (ER-1): arXiv's HTML (LaTeXML) → the page the reader sees and the
// text the tutor reads, with the same anchors. The fixture is a cut-down LoRA
// page with the markup arXiv really serves (checked against 2106.09685 and
// 2501.12948): sections with number tags, an abstract, a run-in \paragraph,
// an equation and an aligned group, an SVG figure as <object>, a table, a
// footnote, an itemize, LaTeXML error marks, page chrome and scripts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arxivIdInPdf, docFromPages, docText, isConvertedPaper, minutesFor, parseArxivHtml, textOf } from "../src/reader/doc.js";
import { parseDocument } from "htmlparser2";

const PAGE = readFileSync(join(__dirname, "fixtures", "reader", "latexml-mini.html"), "utf8");
const BASE = "https://arxiv.org/html/2106.09685";

describe("parseArxivHtml: the text for the tutor", () => {
  const p = parseArxivHtml(PAGE, BASE);

  it("reads the title (formulas as TeX) and the authors without their notes", () => {
    expect(p.title).toBe("LoRA: Low-Rank Adaptation of LLMs");
    expect(p.authors).toBe("Edward Hu, Yelong Shen");
  });

  it("makes the outline: abstract, numbered sections, subsections, appendices; not the bibliography", () => {
    expect(p.sections.map((s) => [s.id, s.number ?? "", s.title, s.level, s.parent ?? ""])).toEqual([
      ["abstract", "", "Abstract", 1, ""],
      ["S1", "1", "Introduction", 1, ""],
      ["S2", "2", "Problem Statement", 1, ""],
      ["S4", "4", "Our Method", 1, ""],
      ["S4.SS1", "4.1", "Low-Rank-Parametrized Update Matrices", 2, "S4"],
      ["A1", "A", "Large Language Models Still Need Parameter Updates", 1, ""],
    ]);
    expect(p.sections.every((s) => s.minutes >= 1)).toBe(true);
  });

  it("keeps formulas as the authors' TeX, inline and displayed, with the equation's number and anchor", () => {
    const para = p.blocks.find((b) => b.id === "S4.SS1.p1")!;
    expect(para.text).toContain("$W_{0}\\in\\mathbb{R}^{d\\times k}$");
    expect(para.text).toContain("$$h=W_{0}x+\\Delta Wx=W_{0}x+BAx$$ (3) [S4.E3]");
    expect(p.equations).toContainEqual({ id: "S4.E3", tag: "3", tex: "h=W_{0}x+\\Delta Wx=W_{0}x+BAx", block: "S4.SS1.p1" });
    // An aligned group: its rows' cells joined, \displaystyle dropped, ids on the tbody.
    const group = p.equations.find((e) => e.id === "S2.E1")!;
    expect(group).toMatchObject({ tag: "1", block: "S2.p1" });
    expect(group.tex).toBe("\\max_{\\Phi}\\sum_{(x,y)} \\log P_{\\Phi}(y_{t}|x,y_{<t})");
  });

  it("gives figures and tables their captions and local images, tables their rows", () => {
    const fig = p.blocks.find((b) => b.id === "S1.F1")!;
    expect(fig).toMatchObject({ kind: "fig", section: "S1", caption: "Figure 1: Our reparametrization. We only train $A$ and $B$.", imgs: ["assets/1-figure1.svg"] });
    const table = p.blocks.find((b) => b.id === "S4.T1")!;
    expect(table.kind).toBe("table");
    expect(table.text).toContain("Method | Params");
    expect(table.text).toContain("LoRA | 4.7M");
    expect(p.blocks.find((b) => b.id === "S4.F2")?.imgs).toEqual(["assets/2-qv8_qv64.png"]);
  });

  it("puts footnotes in line, lists as items, and a run-in paragraph title before its text", () => {
    expect(p.blocks.find((b) => b.id === "S1.p1")!.text).toContain("[footnote: Fine-tuning boosts GPT-3 significantly.]");
    const list = p.blocks.find((b) => b.id === "S1.p2")!.text;
    expect(list).toContain("- A shared model with many small LoRA modules.");
    expect(list).toContain("- No additional inference latency.");
    expect(p.blocks.find((b) => b.id === "S1.SS0.SSS0.Px1.p1")!.text).toBe("**Terminologies and Conventions** We call the input dimension $d_{model}$.");
  });

  it("reads the references, with their arXiv id or DOI", () => {
    expect(p.refs).toEqual([
      expect.objectContaining({ id: "bib.bib1", arxiv: "2012.13255" }),
      expect.objectContaining({ id: "bib.bib2", doi: "10.1000/xyz123" }),
    ]);
  });

  it("counts LaTeXML's error marks as a warning", () => {
    expect(p.warnings).toEqual([expect.stringContaining("1 chỗ LaTeXML")]);
  });

  it("docText: every section with its anchor, every block with its id; one section with its subsections", () => {
    const all = docText(p);
    expect(all).toContain("## 4 Our Method  [[S4]]");
    expect(all).toContain("### 4.1 Low-Rank-Parametrized Update Matrices  [[S4.SS1]]");
    expect(all).toContain("[S4.T1] (Table) Table 1: Trainable parameters.");
    const one = docText(p, "S4");
    expect(one).toContain("[[S4.SS1]]");
    expect(one).not.toContain("[[S1]]");
  });
});

describe("parseArxivHtml: the page the reader sees", () => {
  const p = parseArxivHtml(PAGE, BASE);

  it("keeps only the article: no page chrome, scripts, styles, buttons or the arXiv logo", () => {
    expect(p.html.startsWith("<article")).toBe(true);
    expect(p.html).not.toMatch(/<script|<style|<button|<header|ltx_page_footer|arxiv-logo|onclick|onmouseover/i);
  });

  it("drops javascript: links and CSS that loads from outside; keeps outside links, opened apart", () => {
    expect(p.html).not.toContain("javascript:");
    expect(p.html).not.toContain("evil.example");
    expect(p.html).toMatch(/<a href="https:\/\/github.com\/microsoft\/LoRA"[^>]*rel="noopener noreferrer"/);
    expect(p.html).toContain('href="#bib.bib2"');
  });

  it("shows an SVG <object> as an image, and points every image at its local copy", () => {
    expect(p.html).not.toContain("<object");
    expect(p.html).toContain('src="assets/1-figure1.svg"');
    expect(p.html).toContain('src="assets/2-qv8_qv64.png"');
    expect(p.assets).toEqual([
      { url: "https://arxiv.org/html/2106.09685v2/figure1.svg", local: "assets/1-figure1.svg" },
      { url: "https://arxiv.org/html/2106.09685v2/qv8_qv64.png", local: "assets/2-qv8_qv64.png" },
    ]);
  });

  it("keeps the MathML (the webview draws it) with its TeX, without the annotation copy", () => {
    expect(p.html).toContain('alttext="h=W_{0}x+\\Delta Wx=W_{0}x+BAx"');
    expect(p.html).toContain("<semantics>");
    expect(p.html).not.toContain("<annotation");
  });

  it("gives the abstract a stable anchor", () => {
    expect(p.html).toContain('id="abstract"');
  });
});

describe("pages that are not a converted paper", () => {
  it("knows arXiv's failed conversions (both answer 200)", () => {
    expect(isConvertedPaper(PAGE)).toBe(true);
    expect(isConvertedPaper('<html><body><div class="ltx_page_main"><article class="ltx_document"><h1>Untitled Document</h1></article></div></body></html>')).toBe(false);
    // ar5iv's image-per-page version: paragraphs, but no section and no formula.
    const pages = `<article class="ltx_document">${'<div class="ltx_para"><img src="x.png"></div>'.repeat(12)}</article>`;
    expect(isConvertedPaper(pages)).toBe(false);
    expect(isConvertedPaper("<html><body>Not found</body></html>")).toBe(false);
  });

  it("refuses a page with no document", () => {
    expect(() => parseArxivHtml("<html><body><p>hi</p></body></html>", BASE)).toThrow(/ltx_document/);
  });
});

describe("a PDF's text", () => {
  it("is a section per page, titled by its first line", () => {
    const d = docFromPages(["Attention Is All You Need\nAshish Vaswani", "", "3 Model Architecture\nMost competitive models"]);
    expect(d.pages).toBe(3);
    expect(d.sections.map((s) => [s.id, s.title, s.blocks])).toEqual([
      ["page-1", "Trang 1 · Attention Is All You Need", ["page-1"]],
      ["page-2", "Trang 2", []],
      ["page-3", "Trang 3 · 3 Model Architecture", ["page-3"]],
    ]);
    expect(d.blocks[1]).toMatchObject({ id: "page-3", kind: "page", page: 3 });
  });

  it("finds the arXiv id stamped on the first page", () => {
    expect(arxivIdInPdf("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023")).toBe("1706.03762v7");
    expect(arxivIdInPdf("Published as a conference paper")).toBeNull();
  });
});

describe("textOf and minutesFor", () => {
  it("turns a table into rows and a <br> into a line break", () => {
    const dom = parseDocument("<div><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>x<br>y</div>");
    expect(textOf(dom.children[0]!)).toBe("a | b\nc | d\nx\ny");
  });

  it("estimates ~200 words a minute, at least one", () => {
    expect(minutesFor(["word ".repeat(400)])).toBe(2);
    expect(minutesFor([""])).toBe(1);
    expect(minutesFor(["word ".repeat(200)], 2)).toBe(2);
  });
});
