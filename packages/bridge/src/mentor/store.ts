// Mentor's files in ~/.agent-in-notebook/mentor: profile.json (settings),
// events.jsonl (the append-only log every number is recomputed from), the
// learner's work of attempts taken out of a notebook (attempts/), the
// notebooks an exercise replaced (backups/), and the learner's passing
// solutions that later exercises build on (solutions/).

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MentorEvent } from "./model.js";
import type { LearnerWork } from "./notebook.js";

export type MentorProfile = Record<string, unknown>;

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
    const next = { ...this.profile(), ...patch };
    this.writeAtomic(this.profileFile, JSON.stringify(next, null, 2));
    return next;
  }

  private writeAtomic(file: string, text: string): void {
    mkdirSync(join(file, ".."), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text);
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }

  private workFile(attemptId: string): string {
    return join(this.dir, "attempts", `${attemptId.replace(/[^\w-]/g, "")}.json`);
  }

  /** The learner's work in an attempt, kept when its notebook took another exercise. */
  saveWork(attemptId: string, work: LearnerWork): void {
    this.writeAtomic(this.workFile(attemptId), JSON.stringify(work, null, 2));
  }

  work(attemptId: string): LearnerWork | null {
    try {
      const raw = JSON.parse(readFileSync(this.workFile(attemptId), "utf8"));
      return raw && Array.isArray(raw.solution) ? raw : null;
    } catch {
      return null;
    }
  }

  private solutionFile(exerciseId: string): string {
    return join(this.dir, "solutions", `${exerciseId.replace(/[^\w-]/g, "")}.py`);
  }

  /** The learner's latest passing solution of an exercise: later exercises build on it. */
  saveSolution(exerciseId: string, source: string): void {
    this.writeAtomic(this.solutionFile(exerciseId), source);
  }

  /** The exercise was written again: what passed its old version is nothing to build on. */
  removeSolution(exerciseId: string): void {
    rmSync(this.solutionFile(exerciseId), { force: true });
  }

  solution(exerciseId: string): string | null {
    try {
      return readFileSync(this.solutionFile(exerciseId), "utf8");
    } catch {
      return null;
    }
  }

  /** A notebook's own content, saved before an exercise replaces it; returns the file. */
  backup(name: string, ipynb: string): string {
    const safe = name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 60) || "notebook";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = join(this.dir, "backups", `${stamp} ${safe}.ipynb`);
    this.writeAtomic(file, ipynb);
    return file;
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
