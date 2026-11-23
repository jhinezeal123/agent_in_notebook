// Places in the paper (docs/easy-read.md, E.10 anchors.ts): which anchor a
// selection is in, the selection's words as the tutor should read them
// (formulas as TeX), and where the words a citation quotes are. The matching
// is pure (text segments in, positions out) so it is tested without a page.

import type { ReaderAnchor } from "@ainb/protocol";

/** LaTeXML elements a citation can point at, by their class. */
const ANCHOR_CLASSES = [
  "ltx_para", "ltx_equation", "ltx_equationgroup", "ltx_figure", "ltx_table", "ltx_float", "ltx_abstract",
  "ltx_theorem", "ltx_proof", "ltx_listing", "ltx_algorithm", "ltx_section", "ltx_subsection", "ltx_subsubsection",
  "ltx_paragraph", "ltx_appendix", "ltx_bibitem",
];

/** The anchor of a node: its PDF page, or the nearest LaTeXML element with an id that a citation can name. */
export function anchorOf(node: Node | null): { id?: string; page?: number } {
  for (let n: Node | null = node; n; n = n.parentNode) {
    if (n.nodeType !== 1) continue;
    const el = n as HTMLElement;
    const page = Number(el.dataset?.page);
    if (Number.isSafeInteger(page) && page > 0) return { id: `page-${page}`, page };
    if (el.id && (el.tagName === "SECTION" || ANCHOR_CLASSES.some((c) => el.classList.contains(c)))) return { id: el.id };
    if (el.tagName === "TBODY" && /\.E\d+$/.test(el.id)) return { id: el.id };
    if (el.classList.contains("er-doc")) break;
  }
  return {};
}

/**
 * The words of a selection for the tutor: a formula as its TeX ($…$), not as
 * the glyphs KaTeX drew (which would come out twice, and garbled).
 */
export function selectionText(range: Range): string {
  const box = document.createElement("div");
  box.append(range.cloneContents());
  for (const math of box.querySelectorAll<HTMLElement>(".er-math[data-tex]")) {
    const tex = math.dataset.tex ?? "";
    math.replaceWith(math.dataset.display === "block" ? `\n$$${tex}$$\n` : `$${tex}$`);
  }
  for (const math of box.querySelectorAll("math[alttext]")) math.replaceWith(`$${math.getAttribute("alttext")}$`);
  // A part of a KaTeX formula selected on its own: its visible glyphs only.
  for (const hidden of box.querySelectorAll(".katex-mathml, annotation")) hidden.remove();
  return (box.textContent ?? "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

// ------------------------------------------------------------------ finding a quote

/** Characters that differ between the paper and how a quote is typed. */
const SAME: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-", " ": " ",
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
};

/**
 * Text made comparable, with where each of its characters came from.
 * `loose`: without spaces and hyphens too (a PDF's text layer splits
 * words at line ends, "adap-" "tation", and drops spaces between runs).
 */
export function comparable(text: string, loose = false): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "­") continue;
    const mapped = (SAME[ch] ?? ch).toLowerCase();
    if (/\s/.test(mapped)) {
      if (loose || space) continue;
      out += " ";
      from.push(i);
      space = true;
      continue;
    }
    if (loose && mapped === "-") continue;
    for (const c of mapped) {
      out += c;
      from.push(i);
    }
    space = false;
  }
  if (!loose && out.endsWith(" ")) {
    out = out.slice(0, -1);
    from.pop();
  }
  return { text: out, from };
}

export interface QuoteSpan {
  start: { segment: number; offset: number };
  end: { segment: number; offset: number };
}

/**
 * Where `quote` is in a run of text segments (a page's text nodes, in order):
 * first as written (spaces collapsed, quotes and dashes alike), then loosely.
 * `end` is exclusive. Null when it is not there.
 */
export function findQuote(segments: string[], quote: string): QuoteSpan | null {
  const whole = segments.join("");
  if (!quote.trim() || !whole) return null;
  const starts: number[] = [];
  let at = 0;
  for (const s of segments) {
    starts.push(at);
    at += s.length;
  }
  const locate = (index: number) => {
    let segment = 0;
    while (segment + 1 < starts.length && starts[segment + 1]! <= index) segment++;
    return { segment, offset: index - starts[segment]! };
  };
  for (const loose of [false, true]) {
    const hay = comparable(whole, loose);
    const needle = comparable(quote, loose).text;
    if (!needle) continue;
    const i = hay.text.indexOf(needle);
    if (i < 0) continue;
    const first = hay.from[i]!;
    const last = hay.from[i + needle.length - 1]!;
    return { start: locate(first), end: locate(last + 1) };
  }
  return null;
}

/** Text nodes under `root` a reader sees (not the MathML copy KaTeX keeps for screen readers). */
export function visibleTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest(".katex-mathml, annotation, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

/** The range of a quote under `root`, or null. */
export function quoteRange(root: Node, quote: string): Range | null {
  const nodes = visibleTextNodes(root);
  const span = findQuote(nodes.map((n) => n.data), quote);
  if (!span) return null;
  const range = document.createRange();
  const startNode = nodes[span.start.segment]!;
  const endNode = nodes[span.end.segment]!;
  range.setStart(startNode, Math.min(span.start.offset, startNode.length));
  range.setEnd(endNode, Math.min(span.end.offset, endNode.length));
  return range;
}

/** A short, readable anchor for a note: its id and a few words. */
export function anchorFor(range: Range, quote: string): ReaderAnchor {
  const where = anchorOf(range.commonAncestorContainer);
  const q = quote.replace(/\s+/g, " ").trim();
  return { ...where, ...(q ? { quote: q.slice(0, 1000) } : {}) };
}
