// Mentor's files in ~/.agent-in-notebook/mentor: profile.json (settings) and
// events.jsonl, the append-only log every number is recomputed from.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MentorEvent } from "./model.js";

export interface MentorProfile {
  /** Where exercise notebooks are written. */
  workDir?: string;
}

export class MentorStore {
  private cache: MentorEvent[] | null = null;

  constructor(readonly dir: string) {}

  private get eventsFile(): string {
    return join(this.dir, "events.jsonl");
  }

  private get profileFile(): string {
    return join(this.dir, "profile.json");
  }

  profile(): MentorProfile {
    try {
      const raw = JSON.parse(readFileSync(this.profileFile, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  saveProfile(patch: Partial<MentorProfile>): MentorProfile {
    mkdirSync(this.dir, { recursive: true });
    const next = { ...this.profile(), ...patch };
    const temporary = `${this.profileFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2));
      renameSync(temporary, this.profileFile);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
    return next;
  }

  /** Every event, oldest first. A line that does not parse (a write cut short) is skipped. */
  events(): readonly MentorEvent[] {
    if (this.cache) return this.cache;
    const out: MentorEvent[] = [];
    let text = "";
    try {
      text = readFileSync(this.eventsFile, "utf8");
    } catch {
      // No events yet.
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.t === "string" && typeof e.attemptId === "string" && typeof e.at === "number" && typeof e.day === "string") out.push(e);
      } catch {
        // skipped
      }
    }
    this.cache = out;
    return out;
  }

  append(event: MentorEvent): void {
    mkdirSync(this.dir, { recursive: true });
    const events = this.events() as MentorEvent[];
    appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`);
    events.push(event);
  }
}

/** A file's path or URL, compared without case or slash style (Windows paths, VS Code's file URIs). */
export function fileId(pathOrUrl: string): string {
  let p = pathOrUrl;
  if (p.startsWith("vscode:")) p = p.slice("vscode:".length);
  if (/^file:/i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return p.toLowerCase();
    }
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/** The notebook key VS Code gives the notebook at this path. */
export function vscodeKey(file: string): string {
  return `vscode:${pathToFileURL(file).href}`;
}
