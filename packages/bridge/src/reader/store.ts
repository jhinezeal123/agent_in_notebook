// Where a paper's reading lives: the paper's folder on Mentor's shelf
// (~/.agent-in-notebook/mentor/papers/<paperId>/), in reader/ (E.3):
//
//   reader.json   what the paper is and how it is shown (ReaderMeta)
//   doc.json      the paper as text for the agent (ReaderDoc)
//   doc.html      the reader's HTML (arXiv) · paper.pdf (a PDF)
//   assets/       the paper's images, and figures drawn as JPEG for the agent
//   pages/        PDF pages drawn as JPEG for the agent
//   source.tex    the arXiv LaTeX of a paper shown as a PDF, when there is one
//   events.jsonl  what the reader did (time per section, marks, notes, the
//                 passes, answers, what they wrote); the rest is folded from
//                 it (model.ts). Its own log, not Mentor's: Mentor compacts
//                 its log into a snapshot that knows nothing of these.
//   map.json      the paper's map, by the hidden author (ER-2, items.ts)
//   items/<unit>.json  a unit's checkpoint, checked (items.ts, lint.ts)

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReaderAnchor, ReaderNote } from "@ainb/protocol";
import type { ReaderDoc } from "./doc.js";
import { foldReader, type ReaderEvent, type ReaderState } from "./model.js";

export interface ReaderMeta {
  paperId: string;
  title: string;
  authors?: string;
  year?: number;
  arxiv?: string;
  url?: string;
  view: "html" | "pdf";
  text: "html" | "latex" | "pdf";
  /** What the tab shows, in the reader folder. */
  file: "doc.html" | "paper.pdf";
  /** A PDF whose text the tab has not taken out yet. */
  needsText?: boolean;
  /** The arXiv LaTeX is kept beside it (source.tex). */
  latex?: boolean;
  warnings: string[];
  arxivHint?: string;
  openedAt: number;
}

export { foldReader, type ReaderEvent, type ReaderState } from "./model.js";

const NOTE_MAX = 4000;
const NOTES_MAX = 500;

/** A note as the tab sent it, checked: kind, text, anchor. */
export function cleanNote(input: { id?: unknown; kind?: unknown; text?: unknown; anchor?: unknown; done?: unknown }, before?: ReaderNote): ReaderNote {
  const text = typeof input.text === "string" ? input.text.trim().slice(0, NOTE_MAX) : "";
  if (!text) throw new Error("Ghi chú trống.");
  const kind = input.kind === "question" ? "question" : "note";
  const a = input.anchor as ReaderAnchor | undefined;
  const anchor: ReaderAnchor | undefined = a && typeof a === "object"
    ? Object.fromEntries(Object.entries({
        id: typeof a.id === "string" ? a.id.slice(0, 120) : undefined,
        quote: typeof a.quote === "string" ? a.quote.slice(0, 1000) : undefined,
        prefix: typeof a.prefix === "string" ? a.prefix.slice(0, 64) : undefined,
        suffix: typeof a.suffix === "string" ? a.suffix.slice(0, 64) : undefined,
        page: Number.isSafeInteger(a.page) && a.page! > 0 ? a.page : undefined,
      }).filter(([, v]) => v !== undefined)) as ReaderAnchor
    : before?.anchor;
  return {
    id: before?.id ?? `n-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    kind,
    text,
    ...(anchor && Object.keys(anchor).length ? { anchor } : {}),
    at: before?.at ?? Date.now(),
    ...(input.done === true ? { done: true } : {}),
  };
}

export class ReaderStore {
  private readonly states = new Map<string, ReaderState>();
  private readonly docs = new Map<string, ReaderDoc>();

  /** `root`: the shelf's folder (mentor/papers). */
  constructor(readonly root: string) {}

  paperDir(paperId: string): string {
    return join(this.root, safeId(paperId));
  }

  dir(paperId: string): string {
    return join(this.paperDir(paperId), "reader");
  }

  has(paperId: string): boolean {
    return existsSync(join(this.dir(paperId), "reader.json"));
  }

  /** Papers that have been opened to read. */
  ids(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((n) => existsSync(join(this.root, n, "reader", "reader.json")));
  }

  meta(paperId: string): ReaderMeta {
    return JSON.parse(readFileSync(join(this.dir(paperId), "reader.json"), "utf8")) as ReaderMeta;
  }

  writeMeta(meta: ReaderMeta): void {
    this.writeJson(meta.paperId, "reader.json", meta);
  }

  doc(paperId: string): ReaderDoc {
    let doc = this.docs.get(paperId);
    if (!doc) {
      doc = JSON.parse(readFileSync(join(this.dir(paperId), "doc.json"), "utf8")) as ReaderDoc;
      this.docs.set(paperId, doc);
    }
    return doc;
  }

  writeDoc(doc: ReaderDoc): void {
    this.writeJson(doc.paperId, "doc.json", doc);
    this.docs.set(doc.paperId, doc);
  }

  write(paperId: string, file: string, data: string | Buffer): void {
    const full = join(this.dir(paperId), file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, data);
  }

  read(paperId: string, file: string): Buffer | null {
    try {
      return readFileSync(join(this.dir(paperId), file));
    } catch {
      return null;
    }
  }

  append(paperId: string, event: ReaderEvent): ReaderState {
    const state = this.state(paperId);
    if (event.t === "r.note" && !state.notes.has(event.note.id) && state.notes.size >= NOTES_MAX) throw new Error(`Đã có ${NOTES_MAX} ghi chú cho paper này.`);
    mkdirSync(this.dir(paperId), { recursive: true });
    appendFileSync(join(this.dir(paperId), "events.jsonl"), `${JSON.stringify(event)}
`);
    // The one event folded into what is known: the same as folding the whole log again.
    return foldReader([event], state);
  }

  /** A file of the reader folder as JSON, or null when it is not there (or not JSON). */
  readJson<T>(paperId: string, file: string): T | null {
    const raw = this.read(paperId, file);
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  writeJsonFile(paperId: string, file: string, data: unknown): void {
    this.writeJson(paperId, file, data);
  }

  state(paperId: string): ReaderState {
    let s = this.states.get(paperId);
    if (!s) {
      const events: ReaderEvent[] = [];
      const raw = this.read(paperId, "events.jsonl")?.toString("utf8") ?? "";
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as ReaderEvent);
        } catch {
          // A line cut short by a crash: the rest of the log still counts.
        }
      }
      s = foldReader(events);
      this.states.set(paperId, s);
    }
    return s;
  }

  private writeJson(paperId: string, file: string, data: unknown): void {
    const full = join(this.dir(paperId), file);
    mkdirSync(join(full, ".."), { recursive: true });
    const tmp = `${full}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, full);
  }
}

/** A paper id as a folder name. */
export function safeId(paperId: string): string {
  const id = paperId.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!id) throw new Error("Paper id trống.");
  return id;
}
