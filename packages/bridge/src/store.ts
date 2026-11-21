// Transcripts saved per notebook, so a chat survives a closed tab or a bridge
// restart. The bridge's transcript is the record; a restored chat hands the
// agent a recap of it, as after a crash.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppliedChange, ChatMessage, ChatSearchHit, Part, Platform } from "@ainb/protocol";

/** Older messages are dropped past this; the recap only uses the tail anyway. */
export const MAX_MESSAGES = 200;
/** Hard cap on pinned messages per chat so pins never grow unbounded. */
export const MAX_PINS = 30;

/**
 * Trim a transcript to at most MAX_MESSAGES unpinned tail messages while always
 * keeping pinned messages in their original chronological order.
 */
export function trimMessages(messages: ChatMessage[], limit = MAX_MESSAGES): { kept: ChatMessage[]; dropped: ChatMessage[] } {
  if (messages.length <= limit) return { kept: messages, dropped: [] };
  const tailStart = messages.length - limit;
  const kept: ChatMessage[] = [];
  const dropped: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (i >= tailStart || m.pinned) kept.push(m);
    else dropped.push(m);
  }
  return { kept, dropped };
}

export interface StoredChat {
  version: 1;
  key: string;
  agentId: string;
  title?: string;
  updatedAt: number;
  messages: ChatMessage[];
  /** Undo journal, by agent message id. */
  journal?: Record<string, AppliedChange[]>;
}

/**
 * What the bridge knows of a notebook apart from its conversation: the
 * OpenResearch project it belongs to. Kept in its own file, so "New chat"
 * (which forgets the conversation) leaves the notebook in its project.
 */
/** What a notebook keeps of its OpenResearch project. */
export interface ProjectCache {
  id: string;
  name: string;
  repoPath: string;
  githubUrl: string | null;
  artifactsDir: string;
}

export interface NotebookMeta {
  version: 1;
  key: string;
  /** Unset: never linked (an older bridge's notebook); it goes to Scratch. */
  projectId?: string;
  /** The project's name when last seen, to show while OpenResearch is down. */
  projectName?: string;
  title?: string;
  url?: string;
  platform?: Platform;
  agentId?: string;
  /** The project as last seen, so the chat's code and artifacts work while OpenResearch is not running. */
  cache?: ProjectCache;
  /** Where the project lives: unset for this computer (remote workspaces later). */
  workspace?: string;
  /** The notebook machine's boot id and when it was last seen. */
  machine?: { boot: string; seenAt: number };
  updatedAt: number;
}

const META_SUFFIX = ".meta.json";

/** Short, filesystem-safe name for a notebook key. */
export function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export class ChatStore {
  /** Bumped by every save of a key; a background write that finds a newer one discards itself. */
  private generation = new Map<string, number>();
  private writing = new Map<string, Promise<void>>();
  /**
   * Notebook metas by their file path, so the machine poll and the project list
   * do not read and parse the same small file every few seconds. The bridge is
   * the only writer of these files (saveMeta/move/remove/prune below keep the
   * cache in step with the disk), so a cached meta is as current as the file;
   * callers treat what they get as read-only.
   */
  private metaCache = new Map<string, NotebookMeta>();

  constructor(readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `${keyHash(key)}.json`);
  }

  load(key: string): StoredChat | null {
    const file = this.file(key);
    if (!existsSync(file)) return null;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as StoredChat;
      if (data?.version !== 1 || data.key !== key || !Array.isArray(data.messages)) return null;
      return { ...data, messages: data.messages.map(settle) };
    } catch {
      return null;
    }
  }

  private serialize(chat: Omit<StoredChat, "version" | "updatedAt">): string {
    const { kept: messages } = trimMessages(chat.messages);
    const kept = new Set(messages.map((m) => m.id));
    const journal = Object.fromEntries(Object.entries(chat.journal ?? {}).filter(([id]) => kept.has(id)));
    const data: StoredChat = { version: 1, ...chat, updatedAt: Date.now(), messages, journal };
    return JSON.stringify(data);
  }

  private bump(key: string): number {
    const n = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, n);
    return n;
  }

  save(chat: Omit<StoredChat, "version" | "updatedAt">): void {
    mkdirSync(this.dir, { recursive: true });
    this.bump(chat.key);
    const file = this.file(chat.key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, this.serialize(chat), { mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /**
   * Save without blocking the event loop on the disk (the bridge keeps
   * streaming meanwhile). Writes of one key run one at a time, and a write
   * overtaken by a newer save of the key is dropped.
   */
  saveAsync(chat: Omit<StoredChat, "version" | "updatedAt">): Promise<void> {
    const generation = this.bump(chat.key);
    const text = this.serialize(chat);
    const file = this.file(chat.key);
    const previous = this.writing.get(chat.key) ?? Promise.resolve();
    const write = previous.then(async () => {
      if (this.generation.get(chat.key) !== generation) return;
      mkdirSync(this.dir, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600 });
        if (this.generation.get(chat.key) === generation) await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    const settled = write.catch(() => {});
    this.writing.set(chat.key, settled);
    void settled.then(() => {
      if (this.writing.get(chat.key) === settled) this.writing.delete(chat.key);
    });
    return write;
  }

  /** Forget the conversation; the notebook's meta (its project) stays, so its cached meta stays valid too. */
  remove(key: string): void {
    this.bump(key);
    rmSync(this.file(key), { force: true });
  }

  /**
   * A notebook now known by another key (renamed): its conversation and meta
   * (project, machine) go to the new key; the address and title it has now stay.
   */
  move(from: string, to: string): void {
    const chat = this.load(from);
    const meta = this.loadMeta(from);
    const now = this.loadMeta(to);
    if (chat) this.save({ key: to, agentId: chat.agentId, title: now?.title ?? chat.title, messages: chat.messages, journal: chat.journal });
    else this.remove(to);
    if (meta) {
      const { version: _v, key: _k, updatedAt: _u, ...rest } = meta;
      this.saveMeta(to, { ...rest, title: now?.title ?? rest.title, url: now?.url ?? rest.url });
    }
    this.remove(from);
    rmSync(this.metaFile(from), { force: true });
    this.metaCache.delete(this.metaFile(from));
  }

  /** Whether a conversation is saved for this notebook. */
  hasTranscript(key: string): boolean {
    return existsSync(this.file(key));
  }

  private metaFile(key: string): string {
    return join(this.dir, `${keyHash(key)}${META_SUFFIX}`);
  }

  loadMeta(key: string): NotebookMeta | null {
    const file = this.metaFile(key);
    const cached = this.metaCache.get(file);
    if (cached) return cached;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as NotebookMeta;
      if (data?.version !== 1 || data.key !== key) return null;
      this.metaCache.set(file, data);
      return data;
    } catch {
      return null;
    }
  }

  /** Merge `patch` into the notebook's meta (unknown fields a newer bridge wrote are kept). */
  saveMeta(key: string, patch: Partial<Omit<NotebookMeta, "version" | "key" | "updatedAt">>): NotebookMeta {
    mkdirSync(this.dir, { recursive: true });
    const file = this.metaFile(key);
    let old: Record<string, unknown> = {};
    const cached = this.metaCache.get(file);
    if (cached) old = { ...cached };
    else {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        if (raw?.key === key) old = raw;
      } catch {
        // none yet
      }
    }
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const data = { ...old, ...defined, version: 1, key, updatedAt: Date.now() } as NotebookMeta;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.metaCache.set(file, data);
    return data;
  }

  /** Every notebook's meta (the notebook chats of all projects). Files already cached are not read again. */
  listMeta(): NotebookMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: NotebookMeta[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const file = join(this.dir, name);
      const cached = this.metaCache.get(file);
      if (cached) {
        out.push(cached);
        continue;
      }
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as NotebookMeta;
        if (data?.version === 1 && typeof data.key === "string") {
          this.metaCache.set(file, data);
          out.push(data);
        }
      } catch {
        // unreadable: skip it
      }
    }
    return out;
  }

  /** Search saved transcripts on this machine (case-insensitive substring match). */
  search(query: string, limit = 30): ChatSearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q || !existsSync(this.dir)) return [];
    const cap = Math.max(1, Math.min(100, limit));
    const metas = new Map(this.listMeta().map((m) => [m.key, m]));
    const hits: ChatSearchHit[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json") || name.endsWith(META_SUFFIX)) continue;
      let data: StoredChat;
      try {
        data = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as StoredChat;
        if (data?.version !== 1 || !Array.isArray(data.messages)) continue;
      } catch {
        continue;
      }
      const meta = metas.get(data.key);
      for (const m of data.messages) {
        const text = searchableText(m.parts);
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const start = Math.max(0, at - 48);
        const end = Math.min(text.length, at + q.length + 72);
        const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
        hits.push({
          notebookKey: data.key,
          title: meta?.title ?? data.title,
          url: meta?.url,
          platform: meta?.platform,
          messageId: m.id,
          role: m.role,
          createdAt: m.createdAt,
          snippet,
        });
      }
    }
    hits.sort((a, b) => b.createdAt - a.createdAt);
    return hits.slice(0, cap);
  }

  /** Delete transcripts nobody has touched for `maxAgeMs`, and notebook metas for `metaMaxAgeMs`. */
  prune(maxAgeMs: number, metaMaxAgeMs = maxAgeMs): void {
    pruneDir(this.dir, maxAgeMs, (name) => name.endsWith(META_SUFFIX));
    pruneDir(this.dir, metaMaxAgeMs, (name) => !name.endsWith(META_SUFFIX));
    // A pruned meta file must not linger in the cache.
    for (const file of [...this.metaCache.keys()]) if (!existsSync(file)) this.metaCache.delete(file);
  }
}

function searchableText(parts: Part[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text" || p.type === "thought") chunks.push(p.text);
    else if (p.type === "notice") chunks.push(p.text);
    else if (p.type === "tool") chunks.push(p.title, p.detail ?? "");
    else if (p.type === "card") chunks.push(p.card.title, p.card.detail ?? "");
  }
  return chunks.filter(Boolean).join(" ");
}

/**
 * A saved transcript can hold things that were waiting when it was written; none
 * of them can be answered any more.
 */
function settle(m: ChatMessage): ChatMessage {
  return {
    ...m,
    parts: m.parts.map((p) => {
      if (p.type === "prompt" && p.answer === undefined) return { ...p, answer: "cancelled" };
      if (p.type === "review" && p.status === "pending") return { ...p, status: "discarded" as const };
      if (p.type === "tool" && (p.status === "pending" || p.status === "in_progress")) return { ...p, status: "failed" as const };
      if (p.type === "card" && p.card.state === "open") return { ...p, card: { ...p.card, state: "stale" as const, actions: [] } };
      return p;
    }),
  };
}

/** Remove the entries of `dir` (files or directories) last modified more than `maxAgeMs` ago. */
export function pruneDir(dir: string, maxAgeMs: number, keep: (name: string) => boolean = () => false): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (keep(name)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true, maxRetries: 3 });
        removed++;
      }
    } catch {
      // in use or already gone; try again next start
    }
  }
  return removed;
}
