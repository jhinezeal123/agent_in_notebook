// A paper as easy-read holds it (docs/easy-read.md, E.2): one HTML for the
// reader to look at, and the same paper as text for the agent (formulas as
// their TeX), both with the same anchors (LaTeXML's ids). This file turns
// arXiv's HTML (LaTeXML) into both, and a PDF's page texts into the second.
// Pure: no network, no files.

import { DomUtils, parseDocument } from "htmlparser2";
import type { AnyNode, Document, Element } from "domhandler";

export type ReaderBlockKind = "p" | "eq" | "fig" | "table" | "alg" | "list" | "page";

export interface ReaderSection {
  /** LaTeXML's id ("S4.SS1", "A1"), "abstract", "front", or "page-3" for a PDF. */
  id: string;
  number?: string;
  title: string;
  level: 1 | 2 | 3;
  parent?: string;
  blocks: string[];
  minutes: number;
}

export interface ReaderBlock {
  id: string;
  section: string;
  kind: ReaderBlockKind;
  /** For the agent: formulas as TeX between $…$ and $$…$$. */
  text: string;
  caption?: string;
  /** Images, relative to the paper's reading folder (assets/…). */
  imgs?: string[];
  page?: number;
}

export interface ReaderEquation {
  id: string;
  /** "3" for "(3)". */
  tag?: string;
  tex: string;
  /** The block it is in. */
  block: string;
}

export interface ReaderRef {
  id: string;
  text: string;
  arxiv?: string;
  doi?: string;
}

export interface ReaderDoc {
  paperId: string;
  title: string;
  authors?: string;
  year?: number;
  arxiv?: string;
  url?: string;
  view: "html" | "pdf";
  text: "html" | "latex" | "pdf";
  sections: ReaderSection[];
  blocks: ReaderBlock[];
  equations: ReaderEquation[];
  refs: ReaderRef[];
  pages?: number;
  warnings: string[];
}

/** An image of the paper to download: where it is, and the name it gets under assets/. */
export interface ReaderAsset {
  url: string;
  local: string;
}

export interface ParsedHtml {
  title: string;
  authors?: string;
  html: string;
  sections: ReaderSection[];
  blocks: ReaderBlock[];
  equations: ReaderEquation[];
  refs: ReaderRef[];
  assets: ReaderAsset[];
  warnings: string[];
}

/**
 * Whether a page from arxiv.org/html or ar5iv is a converted paper. A failed
 * conversion still answers 200: an empty "Untitled Document", or (ar5iv) one
 * image per PDF page. ER-0: real papers have a section, or at least 10 formulas.
 */
export function isConvertedPaper(html: string): boolean {
  if (!/class="ltx_page_main|class="ltx_document/.test(html)) return false;
  return /<section[^>]*class="ltx_section/.test(html) || (html.match(/<math\b/g) ?? []).length >= 10;
}

const isElement = (n: AnyNode): n is Element => n.type === "tag" || n.type === "script" || n.type === "style";
const classesOf = (el: Element): string[] => (el.attribs.class ?? "").split(/\s+/).filter(Boolean);
const hasClass = (el: Element, c: string) => classesOf(el).includes(c);
const children = (el: Element | Document): Element[] => el.children.filter(isElement);

/** Whether `el` has an ancestor named `name` below `root`. */
function hasAncestor(el: Element, root: Element, name: string): boolean {
  for (let p = el.parent; p && p !== root; p = p.parent) if (isElement(p as AnyNode) && (p as Element).name === name) return true;
  return false;
}

function findAll(root: Element | Document, test: (el: Element) => boolean): Element[] {
  return DomUtils.findAll(test, root.children);
}

function findOne(root: Element | Document, test: (el: Element) => boolean): Element | null {
  return DomUtils.findOne(test, root.children, true);
}

/** Elements dropped from the reader's HTML: page chrome, active content. */
const DROP_TAGS = new Set(["script", "style", "link", "meta", "iframe", "embed", "form", "input", "button", "textarea", "select", "dialog", "nav", "noscript", "template", "annotation", "annotation-xml", "base"]);
const DROP_CLASSES = ["ltx_page_logo", "ltx_page_footer", "ltx_page_navbar", "ltx_page_header", "ar5iv-footer", "ltx_dates"];
/** HTML attributes kept (SVG and MathML keep theirs, less event handlers and outside links). */
const KEEP_ATTRS = new Set(["id", "class", "colspan", "rowspan", "alt", "title", "href", "src", "width", "height", "style", "lang", "dir", "start", "type", "headers", "scope", "align", "valign"]);

/** "Aghajanyan et al. (2020)" … ; collapse the spaces of a text. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text of an element as the agent should read it: formulas as TeX, equations on their own line, tables as rows. */
export function textOf(node: AnyNode): string {
  const out: string[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === "text") {
      out.push((n as unknown as { data: string }).data.replace(/\s+/g, " "));
      return;
    }
    if (!isElement(n)) return;
    const el = n;
    const name = el.name;
    if (DROP_TAGS.has(name) || name === "svg" && !findOne(el, (x) => x.name === "foreignobject")) return;
    const cls = classesOf(el);
    if (cls.includes("ltx_note_mark") || cls.includes("ltx_tag_note") || cls.includes("ltx_note_type")) return;
    if (name === "math") {
      const tex = el.attribs.alttext ?? squash(DomUtils.textContent(el));
      out.push(el.attribs.display === "block" ? `\n$$${tex}$$\n` : `$${tex}$`);
      return;
    }
    if (name === "table" && (cls.includes("ltx_equation") || cls.includes("ltx_equationgroup"))) {
      const { tex, tags } = equationTex(el);
      const ids = equationsIn(el, "").map((e) => e.id);
      out.push(`\n$$${tex}$$${tags.length ? ` (${tags.join(", ")})` : ""}${ids.length ? ` [${ids.join(", ")}]` : ""}\n`);
      return;
    }
    if (cls.includes("ltx_note") && cls.some((c) => c.startsWith("ltx_role_footnote"))) {
      const content = findOne(el, (x) => hasClass(x, "ltx_note_content"));
      if (content) {
        out.push(" [footnote: ");
        content.children.forEach(walk);
        out.push("]");
      }
      return;
    }
    if (name === "table" || name === "tbody" || name === "thead") {
      const rows = findAll(el, (x) => x.name === "tr");
      if (rows.length) {
        out.push("\n");
        for (const tr of rows) {
          const cells = children(tr).filter((c) => c.name === "td" || c.name === "th").map((c) => squash(textOf(c)));
          out.push(`${cells.join(" | ")}\n`);
        }
        return;
      }
    }
    if (name === "br") {
      out.push("\n");
      return;
    }
    if (name === "li") {
      // One line per item: "- text", or "- 2. text" for a numbered one; LaTeXML puts the
      // item's text in a block (ltx_para) after the bullet, which would split them apart.
      const tag = children(el).find((c) => hasClass(c, "ltx_tag_item"));
      const mark = tag ? squash(DomUtils.textContent(tag)) : "";
      const start = out.length;
      for (const c of el.children) if (c !== tag) walk(c);
      const body = out.splice(start).join("").split("\n").map((l) => l.trim()).filter((l, i, all) => l || all[i - 1]).join("\n").trim();
      out.push(`\n- ${!mark || /^[•∙·◦▪‣–—*-]$/.test(mark) ? "" : `${mark} `}${body}\n`);
      return;
    }
    const block =name === "p" || name === "div" || name === "figcaption" || name === "ul" || name === "ol" || name === "h1" || name === "h2" || name === "h3" || name === "h4" || name === "h5" || name === "h6";
    if (block) out.push("\n");
    el.children.forEach(walk);
    if (block) out.push("\n");
  };
  walk(node);
  return out.join("")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The TeX of an equation table (one row, or the rows of an aligned group) and its numbers. */
function equationTex(table: Element): { tex: string; tags: string[] } {
  const rows = findAll(table, (x) => x.name === "tr" && hasClass(x, "ltx_equation") || x.name === "tr" && hasClass(x, "ltx_eqn_row"));
  const lines = (rows.length ? rows : [table]).map((row) => findAll(row, (x) => x.name === "math").map((m) => (m.attribs.alttext ?? squash(DomUtils.textContent(m))).replace(/^\\displaystyle\s*/, "")).join(" ")).filter(Boolean);
  const tags = findAll(table, (x) => hasClass(x, "ltx_tag_equation")).map((t) => squash(DomUtils.textContent(t)).replace(/^\(|\)$/g, "")).filter(Boolean);
  return { tex: lines.length > 1 ? `\\begin{aligned}${lines.join(" \\\\ ")}\\end{aligned}` : lines[0] ?? "", tags };
}

/** Numbered equations of a table: an `ltx_equation` table is one, a group has one per row (ids on tbody or tr). */
function equationsIn(table: Element, block: string): ReaderEquation[] {
  if (hasClass(table, "ltx_equation") && table.attribs.id) {
    const { tex, tags } = equationTex(table);
    return [{ id: table.attribs.id, ...(tags[0] ? { tag: tags[0] } : {}), tex, block }];
  }
  return findAll(table, (x) => (x.name === "tbody" || x.name === "tr") && /\.E\d+$|\.Ex\d+$/.test(x.attribs.id ?? "")).map((part) => {
    const { tex, tags } = equationTex(part);
    return { id: part.attribs.id!, ...(tags[0] ? { tag: tags[0] } : {}), tex, block };
  });
}

/** Reading time: ~200 words a minute, half a minute more per displayed formula, figure or table. */
export function minutesFor(texts: string[], extras = 0): number {
  const words = texts.join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200 + extras * 0.5));
}

const SECTION_LEVEL: Record<string, 1 | 2 | 3> = { ltx_section: 1, ltx_appendix: 1, ltx_chapter: 1, ltx_subsection: 2, ltx_subsubsection: 3 };

function sectionLevel(el: Element): 1 | 2 | 3 | null {
  if (el.name !== "section") return null;
  for (const c of classesOf(el)) if (SECTION_LEVEL[c]) return SECTION_LEVEL[c]!;
  return null;
}

/** A local name for an image: assets/<n>-<file>, safe on every system. */
function assetName(url: string, n: number): string {
  const file = (new URL(url).pathname.split("/").pop() ?? "img").replace(/[^A-Za-z0-9._-]/g, "_").slice(-60) || "img";
  return `assets/${n}-${file}`;
}

/**
 * arXiv's HTML (or ar5iv's) → the reader's HTML and the agent's text. `base`
 * is the page's address: images are relative to it. Images get local names
 * (assets/…) for the caller to download.
 */
export function parseArxivHtml(page: string, base: string): ParsedHtml {
  const dom = parseDocument(page, { decodeEntities: true });
  const article = findOne(dom, (el) => el.name === "article" && hasClass(el, "ltx_document"))
    ?? findOne(dom, (el) => hasClass(el, "ltx_document"));
  if (!article) throw new Error("Trang không có nội dung bài báo (không thấy ltx_document).");

  // ---- clean what the reader sees
  const assets: ReaderAsset[] = [];
  const byUrl = new Map<string, string>();
  const localFor = (src: string): string | null => {
    if (src.startsWith("data:image/")) return src;
    let url: string;
    try {
      url = new URL(src, base).href;
    } catch {
      return null;
    }
    if (!/^https?:/.test(url) || /arxiv-logo|\/static\//.test(url)) return null;
    let local = byUrl.get(url);
    if (!local) {
      local = assetName(url, assets.length + 1);
      byUrl.set(url, local);
      assets.push({ url, local });
    }
    return local;
  };
  const clean = (el: Element, inForeign: boolean): void => {
    for (const child of [...el.children]) {
      if (!isElement(child)) {
        if (child.type === "comment" || child.type === "directive" || child.type === "cdata") DomUtils.removeElement(child);
        continue;
      }
      const cls = classesOf(child);
      // An SVG figure as an <object>: shown as an image (an object needs object-src, and an image runs no script).
      if (child.name === "object" && /^image\//.test(child.attribs.type ?? "") && child.attribs.data) {
        child.name = "img";
        child.attribs = { ...child.attribs, src: child.attribs.data };
        delete child.attribs.data;
        delete child.attribs.type;
      } else if (DROP_TAGS.has(child.name) || child.name === "object" || DROP_CLASSES.some((c) => cls.includes(c))) {
        DomUtils.removeElement(child);
        continue;
      }
      const name = child.name;
      const foreign = inForeign || name === "svg" || name === "math";
      for (const [k, v] of Object.entries(child.attribs)) {
        const key = k.toLowerCase();
        const value = v ?? "";
        const keep = key.startsWith("on") ? false
          : key === "href" || key === "xlink:href" ? /^(#|https?:|mailto:)/i.test(value.trim())
          : key === "style" ? !/url\s*\(|expression\s*\(|@import/i.test(value)
          : key === "src" ? true
          : foreign || KEEP_ATTRS.has(key) || key === "alttext" || key === "display";
        if (!keep) delete child.attribs[k];
      }
      if (name === "img") {
        const local = child.attribs.src ? localFor(child.attribs.src) : null;
        if (!local) {
          DomUtils.removeElement(child);
          continue;
        }
        child.attribs.src = local;
        child.attribs.loading = "lazy";
      }
      if (name === "a" && /^https?:/i.test(child.attribs.href ?? "")) child.attribs.rel = "noopener noreferrer";
      clean(child, foreign);
    }
  };
  clean(article, false);

  // ---- the text for the agent, by section
  const title = squash(textOf(findOne(article, (el) => hasClass(el, "ltx_title_document")) ?? article).replace(/\$/g, "")) || "Untitled";
  const names = findAll(article, (el) => hasClass(el, "ltx_personname")).map((el) => {
    const copy = el.children.filter((c) => !(isElement(c) && (c.name === "sup" || hasClass(c, "ltx_note"))));
    return squash(copy.map((c) => DomUtils.textContent(c)).join(" ")).split(/\s{2,}|,|\n/)[0]!.trim();
  }).filter((n) => n && n.length < 80);
  const authors = names.length ? (names.length > 4 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ")) : undefined;

  const sections: ReaderSection[] = [];
  const blocks: ReaderBlock[] = [];
  const equations: ReaderEquation[] = [];
  const counts = new Map<string, { figs: number }>();
  let made = 0;

  const ensureId = (el: Element, section: string): string => {
    if (!el.attribs.id) el.attribs.id = `${section}.b${++made}`;
    return el.attribs.id;
  };
  const addBlock = (b: ReaderBlock) => {
    blocks.push(b);
    sections.find((s) => s.id === b.section)?.blocks.push(b.id);
    if (b.kind !== "p" && b.kind !== "list") counts.set(b.section, { figs: (counts.get(b.section)?.figs ?? 0) + 1 });
  };
  const figureBlock = (el: Element, section: string): ReaderBlock => {
    const cls = classesOf(el);
    const kind: ReaderBlockKind = cls.includes("ltx_table") ? "table" : cls.includes("ltx_algorithm") || cls.includes("ltx_listing") ? "alg" : "fig";
    const caption = squash(textOf(children(el).find((c) => c.name === "figcaption") ?? findOne(el, (x) => x.name === "figcaption") ?? { type: "text", data: "" } as unknown as AnyNode));
    const imgs = findAll(el, (x) => x.name === "img" && !!x.attribs.src && !x.attribs.src.startsWith("data:")).map((x) => x.attribs.src!);
    const body = kind === "fig" ? caption : textOf(el);
    return { id: ensureId(el, section), section, kind, text: body || caption, ...(caption ? { caption } : {}), ...(imgs.length ? { imgs } : {}) };
  };

  /** Blocks of a container, into `section`; `prefix` is a run-in heading (\paragraph{…}) for the next block. */
  const walkBlocks = (container: Element, section: string, parentLevel: number): void => {
    let prefix = "";
    for (const el of children(container)) {
      const cls = classesOf(el);
      const level = sectionLevel(el);
      if (level) {
        walkSection(el, level, section);
        continue;
      }
      if (el.name === "section" && hasClass(el, "ltx_bibliography")) continue;
      if (/^h[1-6]$/.test(el.name) && cls.includes("ltx_title")) {
        if (el.parent === container && (cls.includes("ltx_title_paragraph") || cls.includes("ltx_title_subparagraph"))) prefix = `**${squash(textOf(el))}** `;
        continue;
      }
      if (el.name === "section" && (cls.includes("ltx_paragraph") || cls.includes("ltx_subparagraph"))) {
        walkBlocks(el, section, parentLevel);
        continue;
      }
      if (cls.includes("ltx_para") || el.name === "p" && cls.includes("ltx_p")) {
        const id = ensureId(el, section);
        const text = textOf(el);
        if (text) {
          addBlock({ id, section, kind: "p", text: prefix + text });
          prefix = "";
        }
        for (const t of findAll(el, (x) => x.name === "table" && (hasClass(x, "ltx_equation") || hasClass(x, "ltx_equationgroup")))) equations.push(...equationsIn(t, id));
        // A float inside a paragraph is a block of its own too (outermost only: subfigures belong to their figure).
        for (const f of findAll(el, (x) => x.name === "figure" && !hasAncestor(x, el, "figure"))) addBlock(figureBlock(f, section));
        continue;
      }
      if (el.name === "figure" || cls.includes("ltx_listing") && el.name === "div") {
        addBlock(figureBlock(el, section));
        continue;
      }
      if (el.name === "table" && (cls.includes("ltx_equation") || cls.includes("ltx_equationgroup"))) {
        const id = ensureId(el, section);
        addBlock({ id, section, kind: "eq", text: textOf(el) });
        equations.push(...equationsIn(el, id));
        continue;
      }
      if (el.name === "ul" || el.name === "ol") {
        const text = textOf(el);
        if (text) addBlock({ id: ensureId(el, section), section, kind: "list", text });
        continue;
      }
      // Theorems, proofs, blocks: what is inside them.
      walkBlocks(el, section, parentLevel);
    }
  };

  const walkSection = (el: Element, level: 1 | 2 | 3, parent: string | undefined): void => {
    const heading = children(el).find((c) => /^h[1-6]$/.test(c.name));
    const tag = heading ? findOne(heading, (x) => hasClass(x, "ltx_tag")) : null;
    const tagText = tag ? squash(DomUtils.textContent(tag)) : "";
    const number = tagText.replace(/^Appendix\s+/i, "").replace(/[.:]$/, "") || undefined;
    const full = heading ? squash(textOf(heading)) : "";
    const titleText = tagText && full.startsWith(tagText) ? full.slice(tagText.length).trim() : full;
    const id = el.attribs.id ?? `sec${sections.length + 1}`;
    el.attribs.id = id;
    sections.push({ id, ...(number ? { number } : {}), title: titleText || (number ? `Mục ${number}` : "Mục"), level, ...(parent ? { parent } : {}), blocks: [], minutes: 1 });
    walkBlocks(el, id, level);
  };

  // The abstract, then text before the first section ("Mở đầu"), then the sections.
  const abstract = findOne(article, (el) => hasClass(el, "ltx_abstract"));
  if (abstract) {
    abstract.attribs.id = "abstract";
    sections.push({ id: "abstract", title: "Abstract", level: 1, blocks: [], minutes: 1 });
    for (const p of findAll(abstract, (x) => x.name === "p" || hasClass(x, "ltx_para") && !findOne(x, (y) => y.name === "p"))) {
      const text = textOf(p);
      if (text) addBlock({ id: ensureId(p, "abstract"), section: "abstract", kind: "p", text });
    }
  }
  const front: Element[] = [];
  const walkTop = (container: Element): void => {
    for (const el of children(container)) {
      const level = sectionLevel(el);
      if (level) walkSection(el, level, undefined);
      else if (el === abstract || hasClass(el, "ltx_authors") || hasClass(el, "ltx_title") || hasClass(el, "ltx_bibliography")) continue;
      else if (findOne(el, (x) => sectionLevel(x) !== null)) walkTop(el); // a wrapper around sections (some templates)
      else if (sections.every((s) => s.id === "abstract") && hasClass(el, "ltx_para") && textOf(el).length > 80) front.push(el);
    }
  };
  walkTop(article);
  if (front.length) {
    const at = sections.findIndex((s) => s.id !== "abstract");
    sections.splice(at < 0 ? sections.length : at, 0, { id: "front", title: "Mở đầu", level: 1, blocks: [], minutes: 1 });
    for (const el of front) addBlock({ id: ensureId(el, "front"), section: "front", kind: "p", text: textOf(el) });
  }

  for (const s of sections) {
    const texts = s.blocks.map((id) => blocks.find((b) => b.id === id)?.text ?? "");
    s.minutes = minutesFor(texts, (counts.get(s.id)?.figs ?? 0) + equations.filter((e) => s.blocks.includes(e.block)).length);
  }

  const refs: ReaderRef[] = findAll(article, (el) => el.name === "li" && hasClass(el, "ltx_bibitem")).map((li) => {
    const text = squash(textOf(li));
    const arxiv = text.match(/arxiv(?:\.org\/abs\/|:\s*|\s+preprint\s+arxiv:\s*)(\d{4}\.\d{4,5})/i)?.[1];
    const doi = text.match(/\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)])/)?.[1];
    return { id: li.attribs.id ?? "", text, ...(arxiv ? { arxiv } : {}), ...(doi ? { doi } : {}) };
  }).filter((r) => r.id);

  const errors = findAll(article, (el) => hasClass(el, "ltx_ERROR")).length;
  const warnings = errors ? [`${errors} chỗ LaTeXML chưa chuyển được (chữ đỏ trong bài); chỗ đó xem bản PDF nếu cần.`] : [];

  return {
    title,
    ...(authors ? { authors } : {}),
    html: DomUtils.getOuterHTML(article, { decodeEntities: true, encodeEntities: "utf8" }),
    sections,
    blocks,
    equations,
    refs,
    assets,
    warnings,
  };
}

/** A PDF's text, a section per page: what the agent reads when the paper is only a PDF. */
export function docFromPages(pages: string[]): Pick<ReaderDoc, "sections" | "blocks" | "equations" | "refs" | "pages"> {
  const sections: ReaderSection[] = [];
  const blocks: ReaderBlock[] = [];
  pages.forEach((raw, i) => {
    const n = i + 1;
    const text = raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const id = `page-${n}`;
    const first = text.split("\n").find((l) => l.trim().length > 3)?.trim() ?? "";
    // No `number`: the title says the page already ("Trang 2 · …"), and a page is not §2.
    sections.push({ id, title: `Trang ${n}${first ? ` · ${first.slice(0, 60)}` : ""}`, level: 1, blocks: text ? [id] : [], minutes: minutesFor([text]) });
    if (text) blocks.push({ id, section: id, kind: "page", text, page: n });
  });
  return { sections, blocks, equations: [], refs: [], pages: pages.length };
}

/** An arXiv id printed on a PDF's first page (arXiv stamps it down the left margin), or null. */
export function arxivIdInPdf(firstPages: string): string | null {
  const m = firstPages.match(/arXiv\s*:\s*(\d{4}\.\d{4,5})(v\d+)?/i);
  return m ? m[1]! + (m[2] ?? "") : null;
}

/** The whole paper as text for the agent: each section's heading with its anchor, each block with its own. */
export function docText(doc: Pick<ReaderDoc, "sections" | "blocks">, only?: string): string {
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const wanted = only ? new Set([only, ...descendants(doc.sections, only)]) : null;
  const out: string[] = [];
  for (const s of doc.sections) {
    if (wanted && !wanted.has(s.id)) continue;
    out.push(`${"#".repeat(s.level + 1)} ${s.number ? `${s.number} ` : ""}${s.title}  [[${s.id}]]`);
    for (const id of s.blocks) {
      const b = byId.get(id);
      if (!b) continue;
      const label = b.kind === "fig" ? "Figure" : b.kind === "table" ? "Table" : b.kind === "alg" ? "Algorithm" : "";
      out.push(`[${b.id}]${label ? ` (${label})` : ""} ${b.text}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** Ids of a section's subsections, all the way down. */
export function descendants(sections: { id: string; parent?: string }[], id: string): string[] {
  const out: string[] = [];
  for (const s of sections) if (s.parent === id) out.push(s.id, ...descendants(sections, s.id));
  return out;
}
