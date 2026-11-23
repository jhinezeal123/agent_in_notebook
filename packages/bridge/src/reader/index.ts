// Easy-read in the bridge: the papers being read, their reading progress and
// notes, and what the reading tab and the tutor ask of them. Like Mentor, it
// stands apart from the chat: the chat knows it only as a role (chat.ts here).

import type { ReaderAnchor, ReaderLibraryItem, ReaderNote, ReaderSectionView, ReaderView } from "@ainb/protocol";
import { parseArxivId, paperIdFor } from "../mentor/fetch.js";
import { arxivIdInPdf, docFromPages, docText, type ReaderDoc } from "./doc.js";
import { ReaderAuthor, type ReaderAuthorHost } from "./author.js";
import { ingestArxiv, ingestPdf, type IngestDeps } from "./ingest.js";
import { ReaderPasses, type ReaderPassesHost } from "./passes.js";
import { cleanNote, ReaderStore, type ReaderMeta } from "./store.js";

/** What the reader needs of Mentor's shelf (the paper's folder is shared with it). */
export interface ReaderShelf {
  /** A paper already on the shelf (landmark or the learner's) with this arXiv id. */
  paperFor(arxiv: string): string | undefined;
  /** The arXiv id of a paper on the shelf. */
  arxivOf(paperId: string): string | undefined;
  /** Put a paper opened here on the shelf, not yet a workshop; nothing when it is there already. */
  shelve(p: { id: string; title: string; authors?: string; year?: number; url?: string; arxiv?: string; source: string; kind: "latex" | "pdf" }): void;
}

export interface ReaderHubOptions extends IngestDeps {
  /** The shelf's folder (mentor/papers). */
  root: string;
  shelf: ReaderShelf;
  /** An event to the editor. */
  emit(event: "reader.updated" | "reader.render", params: unknown): void;
  /** How long the tutor waits for the tab to draw a page or figure. */
  renderWaitMs?: number;
  /** The hidden author's chats (ER-2); none: nothing is prepared. */
  author?: () => ReaderAuthorHost | undefined;
  /** Misconceptions into Mentor's book. */
  misconception?: ReaderPassesHost["misconception"];
}

/** A section counts as read once this share of its estimated time was spent in it. */
const READ_SHARE = 0.4;
/** An image of the paper, as the parser names them (doc.ts: assets/<n>-<file>). */
const SAFE_ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/** Most of the paper's text the agent's Mentor copy keeps (as Mentor's own). */
const SOURCE_MAX = 600_000;

export class ReaderHub {
  readonly store: ReaderStore;
  /** Passes 1–2: the goal, the map and checkpoints, answers and writes (ER-2). */
  readonly passes: ReaderPasses;
  /** The hidden author that prepares them. */
  readonly author: ReaderAuthor;
  private readonly opening = new Map<string, Promise<ReaderView>>();
  private readonly renders = new Map<string, { resolve: (jpeg: Buffer) => void; reject: (e: Error) => void }[]>();
  /** Per paper, bumped whenever its guide changes (the tab asks for it again). */
  private readonly revs = new Map<string, number>();
  private readonly touched = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: ReaderHubOptions) {
    this.store = new ReaderStore(opts.root);
    this.author = new ReaderAuthor(this, () => opts.author?.());
    this.passes = new ReaderPasses(this, this.author, { misconception: opts.misconception });
    this.author.passes = this.passes;
  }

  /** Open a paper: fetched and converted the first time, as it was after that. */
  async open(source: { arxiv: string } | { pdfPath: string } | { paperId: string }): Promise<ReaderView> {
    if ("pdfPath" in source) return this.opened(ingestPdf(String(source.pdfPath), this.store).paperId);
    let arxiv: string | null;
    let paperId: string;
    if ("paperId" in source) {
      paperId = String(source.paperId);
      if (this.store.has(paperId)) return this.opened(paperId);
      arxiv = this.opts.shelf.arxivOf(paperId) ?? null;
      if (!arxiv) throw new Error(`Không có paper ${paperId} để đọc.`);
    } else {
      arxiv = parseArxivId(String(source.arxiv));
      if (!arxiv) throw new Error(`"${source.arxiv}" không phải link hay id arXiv (ví dụ 2106.09685 hoặc https://arxiv.org/abs/2106.09685).`);
      paperId = this.opts.shelf.paperFor(arxiv) ?? paperIdFor(arxiv);
      if (this.store.has(paperId)) return this.opened(paperId);
    }
    let running = this.opening.get(paperId);
    if (!running) {
      const id = paperId;
      const from = arxiv;
      running = (async () => {
        try {
          const { meta, doc } = await ingestArxiv(from, id, this.store, this.opts);
          this.shelve(meta, doc);
          return this.view(id);
        } finally {
          this.opening.delete(id);
        }
      })();
      this.opening.set(paperId, running);
    }
    await running;
    return this.opened(paperId);
  }

  private opened(paperId: string): ReaderView {
    this.store.append(paperId, { t: "r.open", at: Date.now() });
    return this.view(paperId);
  }

  has(paperId: string): boolean {
    return this.store.has(paperId);
  }

  meta(paperId: string): ReaderMeta {
    if (!this.store.has(paperId)) throw new Error(`Không có paper ${paperId} để đọc.`);
    return this.store.meta(paperId);
  }

  doc(paperId: string): ReaderDoc {
    this.meta(paperId);
    return this.store.doc(paperId);
  }

  view(paperId: string): ReaderView {
    const meta = this.meta(paperId);
    const doc = this.store.doc(paperId);
    const state = this.store.state(paperId);
    const own = (id: string): ReaderSectionView => {
      const s = doc.sections.find((x) => x.id === id)!;
      const readMs = state.readMs.get(s.id) ?? 0;
      return {
        id: s.id, ...(s.number ? { number: s.number } : {}), title: s.title, level: s.level, ...(s.parent ? { parent: s.parent } : {}),
        minutes: s.minutes, readMs, read: state.marked.get(s.id) ?? (s.blocks.length > 0 && readMs >= s.minutes * 60_000 * READ_SHARE),
        ...(s.blocks.length ? {} : { empty: true as const }),
      };
    };
    const sections = doc.sections.map((s) => own(s.id));
    // A section with no text of its own (only subsections) is read when they all are.
    for (const s of [...sections].reverse()) {
      const src = doc.sections.find((x) => x.id === s.id)!;
      const kids = sections.filter((k) => k.parent === s.id);
      if (!src.blocks.length && kids.length && !state.marked.has(s.id)) s.read = kids.every((k) => k.read);
    }
    const notes = [...state.notes.values()].sort((a, b) => a.at - b.at);
    return {
      paperId, title: meta.title, ...(meta.authors ? { authors: meta.authors } : {}), ...(meta.year ? { year: meta.year } : {}),
      ...(meta.arxiv ? { arxiv: meta.arxiv } : {}), ...(meta.url ? { url: meta.url } : {}),
      view: meta.view, text: meta.text, ...(meta.needsText ? { needsText: true } : {}),
      dir: this.store.dir(paperId), file: meta.file, sections, notes, ...(state.at ? { at: state.at } : {}),
      warnings: meta.warnings, ...(meta.arxivHint ? { arxivHint: meta.arxivHint } : {}),
      openedAt: meta.openedAt, lastAt: Math.max(state.lastAt, meta.openedAt),
      ...(state.goal ? { goal: state.goal } : {}), pass: state.pass, guideRev: this.revs.get(paperId) ?? 0,
    };
  }

  /**
   * The paper's guide changed (an answer, a write, the author's work): its
   * revision goes up, and the tab hears it once for a burst of changes.
   */
  touch(paperId: string): void {
    this.revs.set(paperId, (this.revs.get(paperId) ?? 0) + 1);
    if (this.touched.has(paperId)) return;
    this.touched.set(paperId, setTimeout(() => {
      this.touched.delete(paperId);
      try {
        this.changed(paperId);
      } catch {
        // The paper went away meanwhile.
      }
    }, 50));
  }

  list(): ReaderLibraryItem[] {
    const out: ReaderLibraryItem[] = [];
    for (const id of this.store.ids()) {
      try {
        const v = this.view(id);
        const own = v.sections.filter((s) => !s.empty);
        out.push({ paperId: id, title: v.title, ...(v.authors ? { authors: v.authors } : {}), ...(v.year ? { year: v.year } : {}), view: v.view, lastAt: v.lastAt, read: own.filter((s) => s.read).length, total: own.length });
      } catch {
        // A folder half written (a fetch that failed): not listed.
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /** Time spent in a section, in slices from the tab. */
  progress(paperId: string, section: string, ms: number): void {
    const doc = this.doc(paperId);
    if (!doc.sections.some((s) => s.id === section)) return;
    const before = this.view(paperId).sections.find((s) => s.id === section)?.read;
    const at = this.store.state(paperId).at;
    this.store.append(paperId, { t: "r.section", at: Date.now(), section, ms: Math.max(0, Math.min(Number(ms) || 0, 10 * 60_000)) });
    // In pass 2, a new place: its unit and the next one get their checkpoints.
    if (at !== section) this.passes.sectionEntered(paperId, section);
    // Tell the tab only when a section became read (each slice would be noise).
    if (!before && this.view(paperId).sections.find((s) => s.id === section)?.read) this.changed(paperId);
  }

  mark(paperId: string, section: string, read: boolean): ReaderView {
    if (!this.doc(paperId).sections.some((s) => s.id === section)) throw new Error(`Paper không có mục ${section}.`);
    this.store.append(paperId, { t: "r.mark", at: Date.now(), section, read: !!read });
    return this.changed(paperId);
  }

  note(paperId: string, p: { note?: { id?: string; kind: ReaderNote["kind"]; text: string; anchor?: ReaderAnchor; done?: boolean }; remove?: string }): ReaderView {
    this.meta(paperId);
    const state = this.store.state(paperId);
    if (p.remove) {
      if (!state.notes.has(p.remove)) throw new Error("Không còn ghi chú đó.");
      this.store.append(paperId, { t: "r.noteRemove", at: Date.now(), id: p.remove });
    } else if (p.note) {
      const before = p.note.id ? state.notes.get(p.note.id) : undefined;
      if (p.note.id && !before) throw new Error("Không còn ghi chú đó.");
      this.store.append(paperId, { t: "r.note", at: Date.now(), note: cleanNote(p.note, before) });
    }
    return this.changed(paperId);
  }

  /** A PDF's text from the tab: the agent can read it now, and the paper goes on the shelf. */
  pdfText(paperId: string, pages: unknown, title?: unknown): ReaderView {
    const meta = this.meta(paperId);
    if (meta.view !== "pdf") throw new Error("Paper này không phải PDF.");
    if (!Array.isArray(pages) || pages.length > 2000) throw new Error("Chữ của PDF không đọc được.");
    const texts = pages.map((p) => String(p ?? "").slice(0, 100_000));
    const parts = docFromPages(texts);
    if (!parts.blocks.length) throw new Error("PDF này không có chữ (chỉ có ảnh?): gia sư chỉ xem được ảnh trang.");
    const doc: ReaderDoc = { ...this.store.doc(paperId), ...parts };
    const named = typeof title === "string" && title.trim().length > 3 && !/^(untitled\b|microsoft word\b|\S+\.(pdf|docx?|tex)$)/i.test(title.trim()) ? title.trim().slice(0, 300) : undefined;
    const hint = meta.arxiv ? undefined : arxivIdInPdf(texts.slice(0, 2).join("\n")) ?? undefined;
    const next: ReaderMeta = { ...meta, ...(named && !meta.arxiv ? { title: named } : {}), needsText: false, ...(hint ? { arxivHint: hint } : {}) };
    delete next.needsText;
    doc.title = next.title;
    this.store.writeDoc(doc);
    this.store.writeMeta(next);
    this.shelve(next, doc);
    // A goal chosen before the text was there: the author can read now.
    this.passes.prepareMap(paperId);
    return this.changed(paperId);
  }

  /** The agent's text of the paper: by section, or all of it. */
  text(paperId: string, section?: string): string {
    return docText(this.doc(paperId), section);
  }

  latex(paperId: string): string | null {
    return this.store.read(paperId, "source.tex")?.toString("utf8") ?? null;
  }

  // ------------------------------------------------------------ drawn pages and figures

  /** A PDF page, or a figure the agent cannot read as it is (SVG), as JPEG: kept, else drawn by the tab. */
  async render(paperId: string, what: { page: number } | { asset: string }): Promise<Buffer> {
    const file = "page" in what ? `pages/${what.page}.jpg` : `${what.asset}.jpg`;
    const kept = this.store.read(paperId, file);
    if (kept) return kept;
    const key = renderKey(paperId, what);
    const waiting = this.renders.get(key);
    const done = new Promise<Buffer>((resolve, reject) => {
      if (waiting) waiting.push({ resolve, reject });
      else this.renders.set(key, [{ resolve, reject }]);
    });
    if (!waiting) this.opts.emit("reader.render", { paperId, ...what });
    const ms = this.opts.renderWaitMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.renders.delete(key);
        reject(new Error("Tab đọc của paper không trả ảnh về (tab đang đóng?). Mở paper trong tab đọc rồi thử lại."));
      }, ms);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The tab drew what `render` asked for. */
  rendered(paperId: string, p: { page?: unknown; asset?: unknown; jpeg?: unknown; error?: unknown }): void {
    // Only what `render` can ask for: a page, or an image under assets/ (the name becomes a file path).
    const what = Number.isSafeInteger(p.page) && (p.page as number) > 0 && (p.page as number) <= 2000
      ? { page: p.page as number }
      : typeof p.asset === "string" && SAFE_ASSET.test(p.asset) ? { asset: p.asset } : null;
    if (!what) return;
    const key = renderKey(paperId, what);
    const waiting = this.renders.get(key);
    this.renders.delete(key);
    if (typeof p.jpeg !== "string" || !p.jpeg) {
      for (const w of waiting ?? []) w.reject(new Error(typeof p.error === "string" ? p.error : "Tab không vẽ được."));
      return;
    }
    const data = Buffer.from(p.jpeg, "base64");
    if (data.length > 4_000_000 || data[0] !== 0xff || data[1] !== 0xd8) {
      for (const w of waiting ?? []) w.reject(new Error("Ảnh tab gửi về không phải JPEG."));
      return;
    }
    this.store.write(paperId, "page" in what ? `pages/${what.page}.jpg` : `${what.asset}.jpg`, data);
    for (const w of waiting ?? []) w.resolve(data);
  }

  private changed(paperId: string): ReaderView {
    // What is read opens pretest answers and checkpoints: the guide changes with it.
    this.revs.set(paperId, (this.revs.get(paperId) ?? 0) + 1);
    const view = this.view(paperId);
    this.opts.emit("reader.updated", { paperId, view });
    return view;
  }


  /** On Mentor's shelf, with the text the workshop would read. */
  private shelve(meta: ReaderMeta, doc: ReaderDoc): void {
    try {
      const latex = meta.latex ? this.latex(meta.paperId) : null;
      const text = latex ?? docText(doc);
      if (!text.trim()) return;
      const head = latex
        ? `<!-- source: arXiv LaTeX of ${meta.arxiv}; the formulas are the authors' own -->`
        : meta.text === "html"
          ? `<!-- source: arXiv HTML (LaTeXML) of ${meta.arxiv}; formulas are the TeX of the authors' source; [[ids]] are the reader's anchors -->`
          : `<!-- source: text taken out of the PDF by pdf.js; formulas may be garbled: check them against the PDF -->`;
      const source = `${head}\n# ${meta.title}\n\n${text}`.slice(0, SOURCE_MAX);
      this.opts.shelf.shelve({
        id: meta.paperId, title: meta.title, ...(meta.authors ? { authors: meta.authors } : {}), ...(meta.year ? { year: meta.year } : {}),
        ...(meta.url ? { url: meta.url } : {}), ...(meta.arxiv ? { arxiv: meta.arxiv } : {}), source, kind: latex || meta.text === "html" ? "latex" : "pdf",
      });
    } catch (e) {
      this.opts.log?.(`Reader: could not put ${meta.paperId} on the shelf: ${(e as Error).message}`);
    }
  }
}

function renderKey(paperId: string, what: { page: number } | { asset: string }): string {
  return `${paperId}\u0000${"page" in what ? `p${what.page}` : `a${what.asset}`}`;
}
