// Mentor as the bridge runs it: the catalog, the learner's log, and the
// exercises in progress. One instance per bridge.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MENTOR_HINT_MAX, type MentorHome, type MentorKind, type MentorScaffold, type MentorStage } from "@ainb/protocol";
import { loadCatalog, type Catalog, type Exercise } from "./catalog.js";
import { dayOf, dueMistakes, fold, home, pickToday, pickWarmup, scaffoldFor, type AttemptState, type MentorEvent, type MentorState } from "./model.js";
import { exerciseNotebook } from "./notebook.js";
import { fileId, MentorStore } from "./store.js";

/** Events without what the store adds. */
export type NewEvent = MentorEvent extends infer E ? (E extends MentorEvent ? Omit<E, "at" | "day"> : never) : never;

export interface MentorOptions {
  dir: string;
  catalog?: Catalog;
  now?: () => number;
  /** Something changed (an attempt, a verdict, a rating). */
  onChange?: (attemptId: string) => void;
}

export class Mentor {
  readonly store: MentorStore;
  private catalogCache: Catalog | null;
  private cached: MentorState | null = null;
  private readonly now: () => number;
  private readonly listeners = new Set<(attemptId: string) => void>();

  constructor(private readonly opts: MentorOptions) {
    this.store = new MentorStore(opts.dir);
    this.catalogCache = opts.catalog ?? null;
    this.now = opts.now ?? Date.now;
  }

  /** Loaded on first use, so a broken catalog only breaks Mentor. */
  get catalog(): Catalog {
    return (this.catalogCache ??= loadCatalog());
  }

  state(): MentorState {
    return (this.cached ??= fold(this.store.events(), this.catalog));
  }

  workDir(): string {
    return this.store.profile().workDir || join(homedir(), "Documents", "ml-mentor");
  }

  setWorkDir(dir: string): void {
    this.store.saveProfile({ workDir: dir });
  }

  home(): MentorHome {
    return home(this.state(), this.catalog, this.now(), this.workDir());
  }

  record(event: NewEvent): void {
    const at = this.now();
    this.store.append({ ...event, at, day: dayOf(at) } as MentorEvent);
    this.cached = null;
    this.opts.onChange?.(event.attemptId);
    for (const l of this.listeners) l(event.attemptId);
  }

  /** Called on every recorded event (the chats of an attempt follow it). */
  subscribe(listener: (attemptId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attempt(attemptId: string): AttemptState | undefined {
    return this.state().attempts.get(attemptId);
  }

  /** The attempt whose notebook this is (by the editor's notebook key or a path), newest first. */
  attemptForFile(keyOrPath: string): AttemptState | undefined {
    const id = fileId(keyOrPath);
    const state = this.state();
    for (const attemptId of [...state.order].reverse()) {
      const a = state.attempts.get(attemptId)!;
      if (fileId(a.file) === id) return a;
    }
    return undefined;
  }

  exercise(id: string): Exercise {
    const ex = this.catalog.exercise(id);
    if (!ex) throw new Error(`Không có bài ${id}.`);
    return ex;
  }

  /**
   * Start an exercise (today's, or today's review, when none is named), or
   * reopen its unfinished attempt of that kind; the notebook is written again
   * if its file is gone.
   */
  start(exerciseId?: string, kind: MentorKind = "learn"): { attemptId: string; exerciseId: string; file: string; resumed: boolean } {
    const state = this.state();
    const today = kind === "review" ? pickWarmup(state, this.catalog, this.now()) : pickToday(state, this.catalog, this.now());
    const id = exerciseId ?? today?.exerciseId;
    if (!id) throw new Error(kind === "review" ? "Hôm nay không có bài nào đến hạn ôn." : "Bạn đã làm hết các bài hiện có. Bài mới sẽ được bổ sung.");
    const ex = this.exercise(id);
    const open = [...state.order].reverse().map((a) => state.attempts.get(a)!).find((a) => a.exerciseId === id && a.kind === kind && !a.doneAt);
    if (open) {
      if (!existsSync(open.file)) this.writeNotebook(ex, open.file, open.kind, open.scaffold);
      return { attemptId: open.attemptId, exerciseId: id, file: open.file, resumed: true };
    }
    const dir = this.workDir();
    mkdirSync(dir, { recursive: true });
    const stem = `${dayOf(this.now())}-${ex.id}${kind === "review" ? "-on-tap" : ""}`;
    let file = join(dir, `${stem}.ipynb`);
    for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.ipynb`);
    const scaffold = scaffoldFor(state, ex, kind);
    this.writeNotebook(ex, file, kind, scaffold);
    const attemptId = `a${this.now().toString(36)}${randomBytes(3).toString("hex")}`;
    this.record({ t: "start", attemptId, exerciseId: ex.id, file, ...(kind === "review" ? { kind } : {}), scaffold });
    return { attemptId, exerciseId: ex.id, file, resumed: false };
  }

  private writeNotebook(ex: Exercise, file: string, kind: MentorKind, scaffold: MentorScaffold): void {
    writeFileSync(file, exerciseNotebook(ex, { kind, scaffold }), { flag: existsSync(file) ? "w" : "wx" });
  }

  /**
   * Misconceptions from the book to ask again in this attempt, with the
   * question bank's question and right answer when the tag comes from one.
   */
  recallsDue(attemptId: string): { tag: string; note: string; exercise: string; question?: string; answer?: string }[] {
    return dueMistakes(this.state(), attemptId, dayOf(this.now())).map((m) => {
      const ex = this.catalog.exercise(m.exerciseId);
      const probe = ex?.probeBank.find((p) => p.tag.toLowerCase() === m.tag.toLowerCase());
      return { tag: m.tag, note: m.note, exercise: ex?.title ?? m.exerciseId, ...(probe ? { question: probe.q, answer: probe.answer } : {}) };
    });
  }

  /** Learner-wide context for the agent: ratings and recent misconceptions. */
  learnerSummary(exceptAttempt?: string): string {
    const state = this.state();
    const ratings = [...state.ratings].filter(([, r]) => r.n > 0).map(([skill, r]) => `${skill} ${Math.round(r.r)} (${r.n})`);
    const recent = [...state.attempts.values()]
      .filter((a) => a.attemptId !== exceptAttempt)
      .flatMap((a) => a.misconceptions)
      .sort((a, b) => b.at - a.at)
      .slice(0, 6)
      .map((m) => `${m.tag}: ${m.note}`);
    const done = [...state.attempts.values()].filter((a) => a.doneAt).length;
    return [
      `Exercises finished: ${done}.`,
      ratings.length ? `Ratings (results): ${ratings.join(", ")}.` : "No ratings yet (the first exercises are the diagnostic).",
      recent.length ? `Recent misconceptions:\n${recent.map((r) => `- ${r}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
  }
}

export function nextHint(level: number): number {
  return Math.min(MENTOR_HINT_MAX, level + 1);
}

export type { MentorStage };
