// Getting a paper to read (E.2). arXiv: its HTML (arxiv.org/html, else
// ar5iv) with the images downloaded; when arXiv could not convert it, its PDF
// (with the LaTeX kept for the agent when there is one). A PDF on this
// computer: copied, and its text taken out later by the reading tab (pdf.js).
//
// Polite with arXiv: requests one after the other, a second apart (three for
// the API); everything is kept on disk so a paper is fetched once. Personal
// use only: nothing fetched is served to anyone else.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { latexFromEprint, parseArxivAtom } from "../mentor/fetch.js";
import { isConvertedPaper, parseArxivHtml, type ReaderDoc } from "./doc.js";
import type { ReaderMeta, ReaderStore } from "./store.js";

export interface IngestDeps {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** Wait between two requests to arXiv (tests: 0). */
  spacingMs?: number;
}

const UA = { "user-agent": "agent-in-notebook easy-read (personal reading)" };
const PDF_MAX = 60 * 1024 * 1024;
const ASSET_MAX = 10 * 1024 * 1024;
const ASSETS_MAX = 80;

let lastRequest = 0;
let lastApi = 0;
let queue: Promise<unknown> = Promise.resolve();

/** A request to arXiv, after the ones before it, spaced out. */
function politeFetch(url: string, deps: IngestDeps, timeoutMs = 60_000): Promise<Response> {
  const get = deps.fetch ?? fetch;
  const spacing = deps.spacingMs ?? 1000;
  const api = url.includes("export.arxiv.org/api");
  const run = queue.then(async () => {
    const wait = Math.max(lastRequest + spacing, api ? lastApi + spacing * 3 : 0) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    if (api) lastApi = lastRequest;
    return get(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  });
  queue = run.catch(() => undefined);
  return run;
}

async function body(r: Response, max: number): Promise<Buffer> {
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > max) throw new Error(`quá lớn (${Math.round(len / 1e6)} MB)`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw new Error(`quá lớn (${Math.round(buf.length / 1e6)} MB)`);
  return buf;
}

export interface Ingested {
  meta: ReaderMeta;
  doc: ReaderDoc;
}

/** Fetch an arXiv paper into the store under `paperId`. */
export async function ingestArxiv(arxiv: string, paperId: string, store: ReaderStore, deps: IngestDeps = {}): Promise<Ingested> {
  const log = deps.log ?? (() => {});
  let info: ReturnType<typeof parseArxivAtom> = {};
  try {
    const r = await politeFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv)}`, deps, 20_000);
    if (r.ok) info = parseArxivAtom(await r.text());
  } catch (e) {
    log(`Reader: arXiv metadata for ${arxiv}: ${(e as Error).message}`);
  }
  const base = { paperId, arxiv, url: `https://arxiv.org/abs/${arxiv}`, ...(info.authors ? { authors: info.authors } : {}), ...(info.year ? { year: info.year } : {}) };

  for (const page of [`https://arxiv.org/html/${arxiv}`, `https://ar5iv.labs.arxiv.org/html/${arxiv}`]) {
    let html: string;
    let at: string;
    try {
      const r = await politeFetch(page, deps);
      if (!r.ok) continue;
      html = await r.text();
      at = r.url || page;
    } catch (e) {
      log(`Reader: ${page}: ${(e as Error).message}`);
      continue;
    }
    if (!isConvertedPaper(html)) continue;
    const parsed = parseArxivHtml(html, at);
    const warnings = [...parsed.warnings];
    let missing = 0;
    for (const a of parsed.assets.slice(0, ASSETS_MAX)) {
      try {
        const r = await politeFetch(a.url, { ...deps, spacingMs: Math.min(deps.spacingMs ?? 250, 250) }, 30_000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        store.write(paperId, a.local, await body(r, ASSET_MAX));
      } catch (e) {
        missing++;
        log(`Reader: image ${a.url}: ${(e as Error).message}`);
      }
    }
    missing += Math.max(0, parsed.assets.length - ASSETS_MAX);
    if (missing) warnings.push(`${missing} hình không tải được.`);
    const title = info.title ?? parsed.title;
    store.write(paperId, "doc.html", parsed.html);
    const doc: ReaderDoc = {
      ...base, title, ...(!info.authors && parsed.authors ? { authors: parsed.authors } : {}),
      view: "html", text: "html", sections: parsed.sections, blocks: parsed.blocks, equations: parsed.equations, refs: parsed.refs, warnings,
    };
    const meta: ReaderMeta = { ...base, title, ...(doc.authors ? { authors: doc.authors } : {}), view: "html", text: "html", file: "doc.html", warnings, openedAt: Date.now() };
    store.writeDoc(doc);
    store.writeMeta(meta);
    return { meta, doc };
  }

  // No HTML: the PDF, read with pdf.js in the tab; the LaTeX for the agent when arXiv has it.
  let pdf: Buffer;
  try {
    const r = await politeFetch(`https://arxiv.org/pdf/${encodeURIComponent(arxiv)}`, deps, 120_000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    pdf = await body(r, PDF_MAX);
    if (pdf.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("không phải PDF");
  } catch (e) {
    throw new Error(`Không lấy được arXiv ${arxiv}: không có bản HTML, và PDF ${(e as Error).message}.`);
  }
  store.write(paperId, "paper.pdf", pdf);
  let latex: string | null = null;
  try {
    const r = await politeFetch(`https://arxiv.org/e-print/${encodeURIComponent(arxiv)}`, deps, 60_000);
    if (r.ok) latex = latexFromEprint(await body(r, PDF_MAX));
  } catch (e) {
    log(`Reader: arXiv source of ${arxiv}: ${(e as Error).message}`);
  }
  // A source that only wraps a PDF (\includepdf) has no text worth reading.
  const hasLatex = !!latex && latex.length > 2000;
  if (hasLatex) store.write(paperId, "source.tex", latex!);
  const title = info.title ?? `arXiv ${arxiv}`;
  const warnings = ["arXiv chưa chuyển được paper này sang HTML: đang hiện bản PDF."];
  const doc: ReaderDoc = { ...base, title, view: "pdf", text: hasLatex ? "latex" : "pdf", sections: [], blocks: [], equations: [], refs: [], warnings };
  const meta: ReaderMeta = { ...base, title, view: "pdf", text: doc.text, file: "paper.pdf", needsText: true, ...(hasLatex ? { latex: true } : {}), warnings, openedAt: Date.now() };
  store.writeDoc(doc);
  store.writeMeta(meta);
  return { meta, doc };
}

/** A PDF's id: the same file gives the same paper (its reading resumes). */
export function pdfPaperId(data: Buffer): string {
  return `pdf-${createHash("sha256").update(data).digest("hex").slice(0, 12)}`;
}

/** A PDF on this computer, copied into the store (once); its text comes later from the tab. */
export function ingestPdf(path: string, store: ReaderStore): Ingested & { paperId: string } {
  const size = statSync(path).size;
  if (size > PDF_MAX) throw new Error(`File PDF lớn quá (tối đa ${PDF_MAX / 1024 / 1024} MB).`);
  const data = readFileSync(path);
  if (data.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("File này không phải PDF.");
  const paperId = pdfPaperId(data);
  // The same file again: its reading resumes.
  if (store.has(paperId)) return { paperId, meta: store.meta(paperId), doc: store.doc(paperId) };
  const title = basename(path).replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim() || "PDF";
  store.write(paperId, "paper.pdf", data);
  const warnings = ["Chữ rút từ PDF: công thức có thể bị dẹt (gia sư xem ảnh trang khi cần)."];
  const doc: ReaderDoc = { paperId, title, view: "pdf", text: "pdf", sections: [], blocks: [], equations: [], refs: [], warnings };
  const meta: ReaderMeta = { paperId, title, view: "pdf", text: "pdf", file: "paper.pdf", needsText: true, warnings, openedAt: Date.now() };
  store.writeDoc(doc);
  store.writeMeta(meta);
  return { paperId, meta, doc };
}
