// Transcripts saved per notebook, so a chat survives a closed tab or a bridge
// restart. The bridge's transcript is the record; a restored chat hands the
// agent a recap of it, as after a crash.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppliedChange, ChatMessage } from "@ainb/protocol";

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

  remove(key: string): void {
    this.bump(key);
    rmSync(this.file(key), { force: true });
  }

  /** Delete transcripts nobody has touched for `maxAgeMs`. */
  prune(maxAgeMs: number): void {
    pruneDir(this.dir, maxAgeMs);
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
