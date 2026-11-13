// Transcripts saved per notebook, so a chat survives a closed tab or a bridge
// restart. The bridge's transcript is the record; a restored chat hands the
// agent a recap of it, as after a crash.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "@ainb/protocol";

/** Older messages are dropped past this; the recap only uses the tail anyway. */
const MAX_MESSAGES = 200;

export interface StoredChat {
  version: 1;
  key: string;
  agentId: string;
  title?: string;
  updatedAt: number;
  messages: ChatMessage[];
}

/** Short, filesystem-safe name for a notebook key. */
export function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export class ChatStore {
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

  save(chat: Omit<StoredChat, "version" | "updatedAt">): void {
    mkdirSync(this.dir, { recursive: true });
    const data: StoredChat = { version: 1, ...chat, updatedAt: Date.now(), messages: chat.messages.slice(-MAX_MESSAGES) };
    const file = this.file(chat.key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  remove(key: string): void {
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
