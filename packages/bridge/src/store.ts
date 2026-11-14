// Transcripts saved per notebook, so a chat survives a closed tab or a bridge
// restart. The bridge's transcript is the record; a restored chat hands the
// agent a recap of it, as after a crash.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppliedChange, ChatMessage, Platform } from "@ainb/protocol";

/** Older messages are dropped past this; the recap only uses the tail anyway. */
const MAX_MESSAGES = 200;

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
    const messages = chat.messages.slice(-MAX_MESSAGES);
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

  /** Forget the conversation; the notebook's meta (its project) stays. */
  remove(key: string): void {
    this.bump(key);
    rmSync(this.file(key), { force: true });
  }

  /** Whether a conversation is saved for this notebook. */
  hasTranscript(key: string): boolean {
    return existsSync(this.file(key));
  }

  private metaFile(key: string): string {
    return join(this.dir, `${keyHash(key)}${META_SUFFIX}`);
  }

  loadMeta(key: string): NotebookMeta | null {
    try {
      const data = JSON.parse(readFileSync(this.metaFile(key), "utf8")) as NotebookMeta;
      if (data?.version !== 1 || data.key !== key) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Merge `patch` into the notebook's meta (unknown fields a newer bridge wrote are kept). */
  saveMeta(key: string, patch: Partial<Omit<NotebookMeta, "version" | "key" | "updatedAt">>): NotebookMeta {
    mkdirSync(this.dir, { recursive: true });
    let old: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(this.metaFile(key), "utf8"));
      if (raw?.key === key) old = raw;
    } catch {
      // none yet
    }
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const data = { ...old, ...defined, version: 1, key, updatedAt: Date.now() } as NotebookMeta;
    const file = this.metaFile(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return data;
  }

  /** Every notebook's meta (the notebook chats of all projects). */
  listMeta(): NotebookMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: NotebookMeta[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(META_SUFFIX)) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as NotebookMeta;
        if (data?.version === 1 && typeof data.key === "string") out.push(data);
      } catch {
        // unreadable: skip it
      }
    }
    return out;
  }

  /** Delete transcripts nobody has touched for `maxAgeMs`, and notebook metas for `metaMaxAgeMs`. */
  prune(maxAgeMs: number, metaMaxAgeMs = maxAgeMs): void {
    pruneDir(this.dir, maxAgeMs, (name) => name.endsWith(META_SUFFIX));
    pruneDir(this.dir, metaMaxAgeMs, (name) => !name.endsWith(META_SUFFIX));
  }
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
