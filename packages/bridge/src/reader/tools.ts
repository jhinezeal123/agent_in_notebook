// The tutor's tools (E.5): read the paper by section, find in it, look at a
// figure or a PDF page. Nothing here changes anything: the tutor reads.

import { z } from "zod";
import type { OutputImage } from "@ainb/protocol";
import { tool, type ToolContext, type ToolDef, type ToolResult } from "../notebook/tools.js";
import { descendants, type ReaderBlock, type ReaderDoc } from "./doc.js";
import type { ReaderHub } from "./index.js";

/** What the tools need of the chat they run in. */
export interface ReaderToolHost {
  readonly hub: ReaderHub;
  readonly paperId: string;
}

export type ReaderToolContext = ToolContext & { reader: ReaderToolHost };

/** One paper_read page. */
export const READ_PAGE = 40_000;
const FIND_HITS = 8;
const IMAGES_MAX = 4;
const IMAGES_BYTES_MAX = 3_000_000;

const notYet = (ctx: ReaderToolContext): ToolResult | null =>
  ctx.reader.hub.meta(ctx.reader.paperId).needsText
    ? { text: "The PDF's text is not taken out yet: the reading tab does it when it opens the paper (a few seconds). Ask the reader to keep the paper's tab open, then try again; paper_page shows a page meanwhile.", isError: true }
    : null;

function page(text: string, offset: number, what: string): string {
  if (offset >= text.length && text.length) return `${what} has ${text.length} characters; offset ${offset} is past the end.`;
  const slice = text.slice(offset, offset + READ_PAGE);
  const rest = text.length - offset - slice.length;
  return rest > 0 ? `${slice}\n\n[… ${rest} more characters: paper_read again with offset=${offset + slice.length}]` : slice;
}

/** The section of an id: a section, a block, an equation. */
export function sectionOf(doc: ReaderDoc, id: string): string | undefined {
  if (doc.sections.some((s) => s.id === id)) return id;
  const block = doc.blocks.find((b) => b.id === id) ?? doc.blocks.find((b) => b.id === doc.equations.find((e) => e.id === id)?.block);
  return block?.section ?? doc.sections.find((s) => id.startsWith(`${s.id}.`))?.id;
}

function outline(doc: ReaderDoc): string {
  return doc.sections.map((s) => `${"  ".repeat(s.level - 1)}[[${s.id}]] ${s.number ? `${s.number} ` : ""}${s.title}`).join("\n");
}

const paperRead = tool({
  name: "paper_read",
  description:
    "Read the paper being read: one section (its id, as in the outline: \"S4.SS1\", \"A2\", \"abstract\", \"page-3\" for a PDF; subsections included), or the whole paper from `offset`, " +
    `${READ_PAGE} characters at a time. Formulas are TeX between $…$ / $$…$$; every paragraph, equation, figure and table starts with its anchor id in brackets, which you cite as [[id]]. ` +
    "`latex: true` reads the authors' LaTeX instead, when the paper is shown as a PDF and arXiv has its source. With no argument and an offset of 0, the outline comes first.",
  schema: z.object({
    section: z.string().max(120).optional().describe("A section id, or the id of anything in it (a paragraph, an equation)"),
    offset: z.number().int().min(0).default(0),
    latex: z.boolean().optional(),
  }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    const { hub, paperId } = ctx.reader;
    if (args.latex) {
      const tex = hub.latex(paperId);
      if (!tex) return { text: "There is no LaTeX source for this paper; read its text with paper_read (no latex).", isError: true };
      return { text: page(tex, args.offset, "The LaTeX") };
    }
    const waiting = notYet(ctx);
    if (waiting) return waiting;
    const doc = hub.doc(paperId);
    if (args.section) {
      const id = sectionOf(doc, args.section.trim());
      if (!id) return { text: `No section "${args.section}". The sections are:\n${outline(doc)}`, isError: true };
      return { text: page(hub.text(paperId, id), args.offset, `Section ${id}`) };
    }
    const all = hub.text(paperId);
    const head = args.offset === 0 ? `Outline:\n${outline(doc)}\n\n` : "";
    return { text: head + page(all, args.offset, "The paper") };
  },
});

/** Words of a query, lowercased; short ones dropped unless the query is only those. */
function terms(query: string): string[] {
  const all = query.toLowerCase().split(/[^\p{L}\p{N}\\_^]+/u).filter(Boolean);
  const long = all.filter((t) => t.length > 2);
  return long.length ? long : all;
}

export function findInDoc(doc: ReaderDoc, query: string, limit = FIND_HITS): { block: ReaderBlock; score: number; at: number }[] {
  const q = query.trim().toLowerCase();
  const words = terms(q);
  if (!words.length) return [];
  const hits: { block: ReaderBlock; score: number; at: number }[] = [];
  for (const block of doc.blocks) {
    const text = block.text.toLowerCase();
    let score = 0;
    let at = -1;
    const phrase = text.indexOf(q);
    if (phrase >= 0) {
      score += 10 + words.length;
      at = phrase;
    }
    for (const w of words) {
      const i = text.indexOf(w);
      if (i < 0) continue;
      score += 1 + Math.min(3, text.split(w).length - 2) * 0.25;
      if (at < 0) at = i;
    }
    // Most words of the query, not one of them many times.
    const found = words.filter((w) => text.includes(w)).length;
    if (found < Math.ceil(words.length / 2) && phrase < 0) continue;
    if (score > 0) hits.push({ block, score: score + found * 2, at: Math.max(0, at) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

const paperFind = tool({
  name: "paper_find",
  description: "Find words or a phrase in the paper being read. Returns the best passages with their anchor ids (cite them as [[id]]) and the section they are in.",
  schema: z.object({ query: z.string().min(1).max(300) }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    const waiting = notYet(ctx);
    if (waiting) return waiting;
    const doc = ctx.reader.hub.doc(ctx.reader.paperId);
    const hits = findInDoc(doc, args.query);
    if (!hits.length) return { text: `Nothing in the paper matches "${args.query}". Try other words, or paper_read a section.` };
    const lines = hits.map(({ block, at }) => {
      const sec = doc.sections.find((s) => s.id === block.section);
      const from = Math.max(0, at - 220);
      const snippet = `${from > 0 ? "…" : ""}${block.text.slice(from, from + 600).replace(/\s+/g, " ")}${from + 600 < block.text.length ? "…" : ""}`;
      return `[${block.id}] in ${sec ? `${sec.number ? `${sec.number} ` : ""}${sec.title} [[${sec.id}]]` : block.section}${block.kind !== "p" ? ` (${block.kind})` : ""}\n${snippet}`;
    });
    return { text: lines.join("\n\n") };
  },
});

/** A figure or table by id ("S1.F1"), or by how the paper calls it ("Figure 2", "Table 3"). */
export function findFigure(doc: ReaderDoc, ref: string): ReaderBlock | undefined {
  const r = ref.trim();
  const byId = doc.blocks.find((b) => b.id === r && b.kind !== "p");
  if (byId) return byId;
  const m = r.match(/^(fig(?:ure)?|tab(?:le)?|alg(?:orithm)?)\.?\s*([A-Z]?\d+)$/i);
  if (!m) return undefined;
  const kind = /^fig/i.test(m[1]!) ? "fig" : /^tab/i.test(m[1]!) ? "table" : "alg";
  const word = kind === "fig" ? "figure" : kind === "table" ? "table" : "algorithm";
  return doc.blocks.find((b) => b.kind === kind && new RegExp(`^${word}\\s*${m[2]}\\b`, "i").test(b.caption ?? b.text));
}

const MIME: Record<string, OutputImage["mime"]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

const paperFigure = tool({
  name: "paper_figure",
  description: "Look at a figure or table of the paper: its caption, and its images attached to the result. Give its anchor id (\"S1.F1\", \"S3.T1\") or how the paper calls it (\"Figure 2\", \"Table 3\").",
  schema: z.object({ id: z.string().min(1).max(120) }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    const { hub, paperId } = ctx.reader;
    const doc = hub.doc(paperId);
    if (doc.view === "pdf") return { text: "This paper is a PDF: look at the page the figure is on with paper_page.", isError: true };
    const block = findFigure(doc, args.id);
    if (!block) {
      const known = doc.blocks.filter((b) => b.kind !== "p" && b.kind !== "list").map((b) => `${b.id}: ${(b.caption ?? b.text).slice(0, 60)}`);
      return { text: `No figure or table "${args.id}". The paper has:\n${known.join("\n") || "(none)"}`, isError: true };
    }
    const lines = [`[${block.id}] ${block.caption ?? ""}`.trim()];
    if (block.kind === "table" || block.kind === "alg") {
      // The block's text starts with its caption: not twice.
      const body = block.caption && block.text.startsWith(block.caption) ? block.text.slice(block.caption.length).trim() : block.text;
      if (body) lines.push(body);
    }
    const images: OutputImage[] = [];
    let bytes = 0;
    for (const src of block.imgs ?? []) {
      if (!ctx.images) {
        lines.push(`[image ${src}: not attached, this agent does not read images]`);
        continue;
      }
      if (images.length >= IMAGES_MAX) {
        lines.push(`[image ${src}: not attached, ${IMAGES_MAX} already]`);
        continue;
      }
      const ext = src.split(".").pop()?.toLowerCase() ?? "";
      try {
        const data = MIME[ext] ? hub.store.read(paperId, src) : await hub.render(paperId, { asset: src });
        if (!data) throw new Error("the file is missing");
        if (bytes + data.length > IMAGES_BYTES_MAX) {
          lines.push(`[image ${src}: not attached, too big for one result]`);
          continue;
        }
        images.push({ mime: MIME[ext] ?? "image/jpeg", data: data.toString("base64") });
        bytes += data.length;
        lines.push(`[image ${images.length} attached: ${src}]`);
      } catch (e) {
        lines.push(`[image ${src}: ${(e as Error).message}]`);
      }
    }
    return { text: lines.join("\n"), ...(images.length ? { images } : {}) };
  },
});

const paperPage = tool({
  name: "paper_page",
  description: "Look at a page of the paper's PDF, as an image (to read formulas and tables that came out garbled in the PDF's text). Pages count from 1.",
  schema: z.object({ page: z.number().int().min(1).max(2000) }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    const { hub, paperId } = ctx.reader;
    const meta = hub.meta(paperId);
    if (meta.view !== "pdf") return { text: "This paper is shown from arXiv's HTML: its formulas are exact TeX in paper_read, and figures are in paper_figure. There are no pages.", isError: true };
    const doc = hub.doc(paperId);
    if (doc.pages && args.page > doc.pages) return { text: `The PDF has ${doc.pages} pages.`, isError: true };
    if (!ctx.images) return { text: "This agent does not read images, so it cannot look at the page.", isError: true };
    const data = await hub.render(paperId, { page: args.page });
    return { text: `Page ${args.page} of the PDF (cite it as [[page-${args.page}]] or [[p${args.page}: "exact words"]]).`, images: [{ mime: "image/jpeg", data: data.toString("base64") }] };
  },
});

export const READER_TOOLS: readonly ToolDef<any, ReaderToolContext>[] = [paperRead, paperFind, paperFigure, paperPage];

/** Sections and their subsections, for a `paper_read` of one (exported for tests). */
export { descendants };
