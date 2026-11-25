// The Vietnamese translation of a paper (docs/easy-read.md, "Dịch paper"):
// the reader's HTML (doc.html) cut into units an agent translates — the
// paragraphs, headings, captions and footnotes — and each translation put
// back in place. What must not change is never in the agent's hands: a
// formula, a citation, a reference, an image, code or a section number is a
// marker ⟦k⟧ in the text it gets, and the original HTML goes back in its
// place; words in bold or italics are wrapped in ⟦k⟧…⟦/k⟧. Tables of numbers,
// algorithms, the authors and the references are not translated.
// Pure: no network, no files.

import { createHash } from "node:crypto";
import { DomUtils, parseDocument } from "htmlparser2";
import type { AnyNode, Element } from "domhandler";
import { textOf } from "./doc.js";

export type TranslationUnitKind = "title" | "heading" | "p" | "caption" | "note";

export interface TranslationUnit {
  /** The number its element carries (data-er-u), from 1 in the order of the page. */
  n: number;
  kind: TranslationUnitKind;
  /** What the agent translates: text with markers ⟦k⟧ (kept as they are) and ⟦k⟧…⟦/k⟧ (formatting around words). */
  text: string;
  /** What each atomic marker stands for, for the agent to read the sentence (a formula's TeX, a citation's words). */
  refs: Record<string, string>;
  /** Atomic markers: the HTML put back. */
  atoms: Record<string, string>;
  /** Paired markers: the tags put back around the translated words. */
  pairs: Record<string, { open: string; close: string }>;
}

export interface TranslationSource {
  /** doc.html with data-er-u on each unit's element: what the tab shows the translation on. */
  html: string;
  units: TranslationUnit[];
  /** Of doc.html: a translation is for this version of the page only. */
  hash: string;
}

const isElement = (n: AnyNode): n is Element => n.type === "tag" || n.type === "script" || n.type === "style";
const classesOf = (el: Element): string[] => (el.attribs.class ?? "").split(/\s+/).filter(Boolean);
const hasClass = (el: Element, c: string) => classesOf(el).includes(c);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Containers whose text stays as it is: numbers, code, names, the references. */
const KEEP_CLASSES = ["ltx_bibliography", "ltx_authors", "ltx_tabular", "ltx_listing", "ltx_algorithmic", "ltx_ERROR", "ltx_dates"];
/** Inline elements that are one piece: the agent moves them, never changes them. */
const ATOM_TAGS = new Set(["math", "svg", "img", "br", "cite", "table", "figure", "object", "code", "kbd", "pre", "tt", "var", "samp", "input", "video", "audio", "canvas"]);
const ATOM_CLASSES = ["ltx_tag", "ltx_ref", "ltx_note", "ltx_note_mark", "ltx_ERROR", "ltx_font_typewriter", "ltx_cite", "ltx_bibref", "ltx_equation", "ltx_equationgroup", "ltx_graphics", "ltx_picture", "ltx_inline-block", "ltx_inline-logical-block", "ltx_parbox"];
/** Inline elements whose words are translated, the tags kept around them. */
const PAIR_TAGS = new Set(["span", "em", "i", "b", "strong", "a", "sub", "sup", "small", "big", "u", "s", "mark", "q", "abbr", "dfn", "del", "ins"]);

/** Most characters of one unit sent to the agent; a longer one is left in English. */
export const UNIT_MAX = 12_000;

function isUnit(el: Element): TranslationUnitKind | null {
  if (el.name === "p" && hasClass(el, "ltx_p")) return "p";
  if (el.name === "figcaption") return "caption";
  if (/^h[1-6]$/.test(el.name) && hasClass(el, "ltx_title")) return hasClass(el, "ltx_title_document") ? "title" : "heading";
  if (hasClass(el, "ltx_note_content")) return "note";
  return null;
}

const keeps = (el: Element) => KEEP_CLASSES.some((c) => hasClass(el, c)) || el.name === "math" || el.name === "svg" || el.name === "pre" || el.name === "code";

const html = (el: AnyNode) => DomUtils.getOuterHTML(el, { decodeEntities: true, encodeEntities: "utf8" });

/** The opening tag of an element as it is serialized (its attributes kept). */
function openTag(el: Element): string {
  const outer = html(el);
  const inner = DomUtils.getInnerHTML(el, { decodeEntities: true, encodeEntities: "utf8" });
  const close = `</${el.name}>`;
  return outer.endsWith(close) ? outer.slice(0, outer.length - close.length - inner.length) : outer;
}

/** Whether an element has words of its own outside the pieces that stay as they are. */
function hasWords(node: AnyNode, units: Set<Element>): boolean {
  if (node.type === "text") return /\p{L}/u.test((node as unknown as { data: string }).data);
  if (!isElement(node)) return false;
  if (units.has(node) || atomic(node, units)) return false;
  return node.children.some((c) => hasWords(c, units));
}

function containsUnit(el: Element, units: Set<Element>): boolean {
  return !!DomUtils.findOne((x) => units.has(x), el.children, true);
}

function atomic(el: Element, units: Set<Element>): boolean {
  if (ATOM_TAGS.has(el.name) || ATOM_CLASSES.some((c) => hasClass(el, c))) return true;
  // A link inside the paper (to a figure, a section) is a reference: kept whole.
  if (el.name === "a" && (el.attribs.href ?? "").startsWith("#")) return true;
  if (!PAIR_TAGS.has(el.name)) return true;
  return containsUnit(el, units);
}

/** What an atomic piece is, for the agent: a formula's TeX, a citation's words, "image". */
function refOf(el: Element): string {
  if (el.name === "img" || el.name === "object" || hasClass(el, "ltx_graphics")) return "[image]";
  if (el.name === "br") return "[line break]";
  if (hasClass(el, "ltx_note")) return "[footnote, translated on its own]";
  if (el.name === "figure" || el.name === "table" && !hasClass(el, "ltx_equation") && !hasClass(el, "ltx_equationgroup")) return "[figure or table]";
  const text = squash(textOf(el)) || squash(DomUtils.textContent(el));
  return text.length > 160 ? `${text.slice(0, 159)}…` : text || "[piece]";
}

/**
 * doc.html → the units to translate, and the page with each unit's element
 * numbered (data-er-u). The same page always gives the same units.
 */
export function translationSource(page: string): TranslationSource {
  const hash = createHash("sha256").update(page).digest("hex").slice(0, 16);
  const dom = parseDocument(page, { decodeEntities: true });
  const found: { el: Element; kind: TranslationUnitKind }[] = [];
  const walk = (el: Element): void => {
    if (keeps(el)) return;
    const kind = isUnit(el);
    if (kind) found.push({ el, kind });
    for (const c of el.children) if (isElement(c)) walk(c);
  };
  for (const c of dom.children) if (isElement(c)) walk(c);
  const all = new Set(found.map((f) => f.el));
  // Only units with words of their own (a paragraph that is only a formula has nothing to translate).
  const kept = found.filter((f) => f.el.children.some((c) => hasWords(c, all)));
  const units = new Set(kept.map((f) => f.el));
  kept.forEach((f, i) => { f.el.attribs["data-er-u"] = String(i + 1); });
  // The pieces are taken after the numbering, so a footnote kept whole in its paragraph still carries its own number.
  const out: TranslationUnit[] = kept.map((f, i) => ({ n: i + 1, kind: f.kind, ...piecesOf(f.el, units) }));
  return { html: DomUtils.getOuterHTML(dom, { decodeEntities: true, encodeEntities: "utf8" }), units: out.filter((u) => u.text.length <= UNIT_MAX), hash };
}

function piecesOf(unit: Element, units: Set<Element>): Pick<TranslationUnit, "text" | "refs" | "atoms" | "pairs"> {
  const refs: Record<string, string> = {};
  const atoms: Record<string, string> = {};
  const pairs: Record<string, { open: string; close: string }> = {};
  let k = 0;
  const walk = (node: AnyNode): string => {
    if (node.type === "text") return (node as unknown as { data: string }).data.replace(/\s+/g, " ");
    if (!isElement(node)) return "";
    if (units.has(node) || atomic(node, units) || !hasWords(node, units)) {
      const key = String(++k);
      atoms[key] = html(node);
      refs[key] = refOf(node);
      return `⟦${key}⟧`;
    }
    const key = String(++k);
    pairs[key] = { open: openTag(node), close: `</${node.name}>` };
    return `⟦${key}⟧${node.children.map(walk).join("")}⟦/${key}⟧`;
  };
  const text = unit.children.map(walk).join("").replace(/\s+/g, " ").trim();
  return { text, refs, atoms, pairs };
}

const MARKER = /⟦(\/?)(\d+)⟧/g;

/** The inner HTML of a unit from its translation; throws, saying what to fix, when a piece is lost or added. */
export function assemble(unit: TranslationUnit, translated: string): string {
  const vi = translated.replace(/\s+/g, " ").trim();
  if (!vi) throw new Error("bản dịch trống");
  const letters = (s: string) => (s.replace(MARKER, "").match(/\p{L}/gu) ?? []).length;
  const src = letters(unit.text);
  if (src >= 60 && letters(vi) < src * 0.35) throw new Error("bản dịch ngắn hơn hẳn bản gốc: dịch đủ cả đoạn, không tóm tắt");
  const seen = new Map<string, number>();
  for (const m of vi.matchAll(MARKER)) {
    const key = m[2]!;
    if (!(key in unit.atoms) && !(key in unit.pairs)) throw new Error(`có ⟦${m[1]}${key}⟧ mà bản gốc không có`);
    if (key in unit.atoms) {
      if (m[1]) throw new Error(`⟦${key}⟧ là một mảnh giữ nguyên, không có ⟦/${key}⟧`);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const missing = Object.keys(unit.atoms).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`thiếu ${missing.map((k) => `⟦${k}⟧ (${unit.refs[k]})`).join(", ")}: giữ mỗi mốc đúng một lần`);
  const twice = [...seen].filter(([, n]) => n > 1).map(([k]) => `⟦${k}⟧`);
  if (twice.length) throw new Error(`${twice.join(", ")} xuất hiện hơn một lần: giữ mỗi mốc đúng một lần`);
  // Formatting markers: kept when they nest properly, else dropped (the words matter, their bold does not).
  const stack: string[] = [];
  let paired = true;
  const opened = new Set<string>();
  for (const m of vi.matchAll(MARKER)) {
    const key = m[2]!;
    if (!(key in unit.pairs)) continue;
    if (!m[1]) {
      if (opened.has(key)) paired = false;
      opened.add(key);
      stack.push(key);
    } else if (stack.pop() !== key) paired = false;
  }
  if (stack.length) paired = false;
  let out = "";
  let last = 0;
  for (const m of vi.matchAll(MARKER)) {
    out += escapeText(vi.slice(last, m.index));
    last = m.index! + m[0].length;
    const key = m[2]!;
    if (key in unit.atoms) out += unit.atoms[key];
    else if (paired) out += m[1] ? unit.pairs[key]!.close : unit.pairs[key]!.open;
  }
  out += escapeText(vi.slice(last));
  return out;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Units in batches of about `chars` characters (one turn of the agent each). */
export function batches<T extends { text: string }>(units: T[], chars: number, most: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const u of units) {
    if (cur.length && (size + u.text.length > chars || cur.length >= most)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += u.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}
