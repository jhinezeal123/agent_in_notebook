// Mentor as the bridge runs it: the catalog, the learner's log, and the
// exercises in progress. One instance per bridge. Exercises live in notebooks
// open in Chrome (place.ts writes them there); this keeps which one holds what.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  MENTOR_HINT_MAX,
  type CellInfo,
  type MentorComponentStatus,
  type MentorFocus,
  type MentorHome,
  type MentorKind,
  type MentorPaper,
  type MentorPaperComponent,
  type MentorStage,
} from "@ainb/protocol";
import { checkExercises, loadCatalog, usesOrder, type Catalog, type Exercise } from "./catalog.js";
import type { JudgeContext } from "./judge.js";
import { dayOf, dueMistakes, fold, home, overallOf, passedExercises, pickToday, pickWarmup, scaffoldFor, START_RATING, type AttemptState, type FocusRef, type MentorEvent, type MentorState } from "./model.js";
import { loadPapers, PaperShelf, paperExerciseId, paperStars, slugOf, type PaperPackage } from "./papers.js";
import { exerciseCells, unmarkedCode, withWork } from "./notebook.js";
import { MentorStore } from "./store.js";

/** Events without what the store adds. */
export type NewEvent = MentorEvent extends infer E ? (E extends MentorEvent ? Omit<E, "at" | "day"> : never) : never;

export interface MentorOptions {
  dir: string;
  catalog?: Catalog;
  now?: () => number;
  /** Something changed (an attempt, a verdict, a rating). */
  onChange?: (attemptId: string) => void;
  log?: (message: string) => void;
}

export class Mentor {
  readonly store: MentorStore;
  /** The papers the learner brought. */
  readonly shelf: PaperShelf;
  private catalogCache: Catalog | null;
  private readonly fixedCatalog: boolean;
  private cached: MentorState | null = null;
  private readonly now: () => number;
  private readonly listeners = new Set<(attemptId: string) => void>();

  constructor(private readonly opts: MentorOptions) {
    this.store = new MentorStore(opts.dir);
    this.shelf = new PaperShelf(join(opts.dir, "papers"));
    this.catalogCache = opts.catalog ?? null;
    this.fixedCatalog = !!opts.catalog;
    this.now = opts.now ?? Date.now;
  }

  /** Loaded on first use, so a broken catalog only breaks Mentor. */
  get catalog(): Catalog {
    return (this.catalogCache ??= loadCatalog(undefined, { papersDir: this.shelf.root, log: this.opts.log }));
  }

  /** The learner's papers changed (an exercise was written, a plan approved): read the catalog again. */
  reloadCatalog(): void {
    if (this.fixedCatalog) {
      // A catalog given in tests: only its papers' part is read again.
      const c = this.catalogCache!;
      this.catalogCache = loadCatalogFor(c, this.shelf.root, this.opts.log);
    } else this.catalogCache = null;
    this.cached = null;
    this.opts.onChange?.("");
    for (const l of this.listeners) l("");
  }

  state(): MentorState {
    return (this.cached ??= fold(this.store.events(), this.catalog));
  }

  home(): MentorHome {
    const focus = this.focus();
    return { ...home(this.state(), this.catalog, this.now(), focus), papers: this.papers(), focus: focus ? this.focusView(focus) : null };
  }

  /** What "today's exercise" follows, if not the map. */
  focus(): FocusRef | null {
    const f = this.store.profile().focus as FocusRef | null | undefined;
    if (!f || (f.kind !== "paper" && f.kind !== "constellation") || typeof f.id !== "string") return null;
    if (f.kind === "paper" && !this.catalog.papers.some((p) => p.info.id === f.id)) return null;
    if (f.kind === "constellation" && !this.catalog.constellations.some((c) => c.id === f.id)) return null;
    return f;
  }

  setFocus(focus: FocusRef | null): void {
    if (focus) {
      const ok = focus.kind === "paper" ? this.catalog.papers.some((p) => p.info.id === focus.id) : this.catalog.constellations.some((c) => c.id === focus.id && c.kind === "map");
      if (!ok) throw new Error(`Không có ${focus.kind === "paper" ? "paper" : "chòm sao"} ${focus.id}.`);
    }
    this.store.saveProfile({ focus });
    this.cached = null;
    this.opts.onChange?.("");
    for (const l of this.listeners) l("");
  }

  private focusView(f: FocusRef): MentorFocus {
    const title = f.kind === "paper" ? this.catalog.papers.find((p) => p.info.id === f.id)?.info.title : this.catalog.constellations.find((c) => c.id === f.id)?.name;
    return { ...f, title: title ?? f.id };
  }

  /** The overall rating, or the starting one. */
  rating(): number {
    return overallOf(this.state().ratings) ?? START_RATING;
  }

  paperPackage(paperId: string): PaperPackage | undefined {
    return this.catalog.papers.find((p) => p.info.id === paperId);
  }

  /** The shelf, landmark papers first, then the learner's newest first. */
  papers(): MentorPaper[] {
    return this.catalog.papers
      .map((p) => this.paperView(p))
      .sort((a, b) => Number(a.origin === "yours") - Number(b.origin === "yours") || (a.origin === "yours" ? b.id.localeCompare(a.id) : 0));
  }

  paperView(pkg: PaperPackage): MentorPaper {
    const { info } = pkg;
    const state = this.state();
    const passed = passedExercises(state);
    const tried = new Set([...state.attempts.values()].filter((a) => !a.voided).map((a) => a.exerciseId));
    const exStatus = (id: string): MentorComponentStatus => (passed.has(id) ? "done" : tried.has(id) ? "learning" : "ready");
    let components: MentorPaperComponent[];
    if (info.plan) {
      components = info.plan.components.map((c) => {
        const exerciseId = paperExerciseId(info.id, c.slug);
        const ex = this.catalog.exercise(exerciseId);
        const status: MentorComponentStatus = c.mode === "given" ? "ready" : ex ? exStatus(exerciseId) : info.failed[c.slug] ? "failed" : "planned";
        return {
          ...(ex ? { exerciseId } : {}), slug: c.slug, title: c.title, role: c.role, mode: c.mode, cites: c.cites,
          minutes: c.minutes, difficulty: ex?.difficulty ?? c.difficulty, status, uses: c.uses,
          ...(info.failed[c.slug] && !ex ? { note: info.failed[c.slug] } : {}),
        };
      });
    } else {
      components = pkg.exercises.map((e) => ({
        exerciseId: e.id, slug: slugOf(info.id, e.id), title: e.title, role: e.role, mode: "build" as const, ...(e.cites ? { cites: e.cites } : {}),
        minutes: e.minutes, difficulty: e.difficulty, status: exStatus(e.id), uses: e.uses.map((u) => slugOf(info.id, u)),
      }));
    }
    const built = components.filter((c) => c.mode === "build");
    const status: MentorPaper["status"] = info.archived ? "archived"
      : info.status !== "ready" ? info.status
      : built.length && built.every((c) => c.status === "done") ? "done"
      : built.some((c) => c.status === "learning" || c.status === "done") ? "learning" : "ready";
    // The numbers: the experiment's, with what the learner's last passing run measured.
    const results: MentorPaper["results"] = [];
    for (const e of pkg.exercises.filter((x) => x.role === "experiment")) {
      const measured = [...state.order].reverse().map((id) => state.attempts.get(id)!).find((a) => a.exerciseId === e.id && a.metrics?.length && !a.voided)?.metrics ?? [];
      for (const m of e.metrics) {
        const yours = measured.find((x) => x.name === m.name)?.value;
        results.push({ name: m.name, ...(m.paper ? { paper: m.paper } : {}), ...(yours !== undefined ? { yours } : {}), ...(m.unit ? { unit: m.unit } : {}) });
      }
    }
    if (!results.length && info.plan) for (const m of info.plan.experiment.metrics) results.push({ name: m.name, paper: m.paper });
    const notes = this.shelf.notes(info.id);
    return {
      id: info.id, title: info.title, ...(info.authors ? { authors: info.authors } : {}), ...(info.year ? { year: info.year } : {}),
      ...(info.url ? { url: info.url } : {}), origin: info.origin, ...(info.closes ? { closes: info.closes } : {}), status,
      ...(info.plan?.goal ?? info.goal ? { goal: info.plan?.goal ?? info.goal } : {}), components, results, ...(notes ? { notes } : {}),
    };
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

  /** The paper whose workshop the notebook with this key is. */
  workshopIn(notebookKey: string): string | undefined {
    return this.state().workshops.get(notebookKey);
  }

  /** The notebook key of a paper's workshop. */
  workshopOf(paperId: string): string | undefined {
    for (const [key, id] of this.state().workshops) if (id === paperId) return key;
    return undefined;
  }

  /** The attempt the notebook with this key holds. */
  attemptIn(notebookKey: string): AttemptState | undefined {
    const id = this.state().places.get(notebookKey);
    return id ? this.attempt(id) : undefined;
  }

  exercise(id: string): Exercise {
    const ex = this.catalog.exercise(id);
    if (!ex) throw new Error(`Không có bài ${id}.`);
    return ex;
  }

  /**
   * The attempt to work on: the unfinished one of this exercise and kind, or
   * a new one (today's exercise, or today's review, when none is named).
   */
  begin(exerciseId?: string, kind: MentorKind = "learn"): { attemptId: string; exerciseId: string; resumed: boolean } {
    const state = this.state();
    const id = this.exerciseFor(exerciseId, kind);
    const ex = this.exercise(id);
    const open = this.openAttempt(id, kind);
    if (open) return { attemptId: open.attemptId, exerciseId: id, resumed: true };
    const missing = this.missingUses(ex);
    if (missing.length) throw new Error(`Bài này dựng tiếp trên code của bạn ở bài ${missing.map((m) => `"${m.title}"`).join(", ")}: làm (và qua máy chấm) bài đó trước.`);
    const attemptId = `a${this.now().toString(36)}${randomBytes(3).toString("hex")}`;
    this.record({ t: "start", attemptId, exerciseId: ex.id, ...(kind === "review" ? { kind } : {}), scaffold: scaffoldFor(state, ex, kind) });
    return { attemptId, exerciseId: ex.id, resumed: false };
  }

  /** The exercise named, or today's (today's review) when none is. */
  exerciseFor(exerciseId: string | undefined, kind: MentorKind): string {
    if (exerciseId) return exerciseId;
    const state = this.state();
    const today = kind === "review" ? pickWarmup(state, this.catalog, this.now()) : pickToday(state, this.catalog, this.now());
    if (!today) throw new Error(kind === "review" ? "Hôm nay không có bài nào đến hạn ôn." : "Bạn đã làm hết các bài hiện có. Bài mới sẽ được bổ sung.");
    return today.exerciseId;
  }

  /** The unfinished attempt of an exercise, of this kind (the latest). */
  openAttempt(exerciseId: string, kind: MentorKind): AttemptState | undefined {
    const state = this.state();
    return [...state.order].reverse().map((a) => state.attempts.get(a)!).find((a) => a.exerciseId === exerciseId && a.kind === kind && !a.doneAt);
  }

  /** The cells to write for an attempt: the exercise, with the learner's saved work back in place. */
  cellsFor(attemptId: string): CellInfo[] {
    const a = this.attempt(attemptId);
    if (!a) throw new Error(`No Mentor attempt ${attemptId}.`);
    const ex = this.exercise(a.exerciseId);
    return withWork(exerciseCells(ex, { kind: a.kind, scaffold: a.scaffold, carried: this.carriedCode(ex) ?? undefined }), this.store.work(attemptId));
  }

  /** The exercises an exercise builds on, deepest first. */
  usedBy(ex: Exercise): Exercise[] {
    return usesOrder(ex.uses, (id) => this.catalog.exercise(id)?.uses ?? []).map((id) => this.exercise(id));
  }

  /** Exercises it builds on that the learner has not passed yet. */
  missingUses(ex: Exercise): Exercise[] {
    return this.usedBy(ex).filter((u) => this.store.solution(u.id) === null);
  }

  /** What runs before the learner's code (and the reference) in the judge. */
  judgeContext(ex: Exercise): JudgeContext {
    const paper = ex.paper ? this.catalog.paperGiven(ex.paper) : "";
    const used = this.usedBy(ex);
    const join = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
    return {
      before: join([paper, ...used.flatMap((u) => [u.given, unmarkedCode(this.store.solution(u.id) ?? "")])]),
      beforeRef: join([paper, ...used.flatMap((u) => [u.given, u.reference])]),
      mode: ex.judge,
    };
  }

  /** The code shown in the exercise's notebook as "from earlier exercises" (null when none). */
  carriedCode(ex: Exercise): string | null {
    const paper = ex.paper ? this.catalog.paperGiven(ex.paper).trim() : "";
    const parts = paper ? [`# ── Cho sẵn của paper ──\n${paper}`] : [];
    for (const u of this.usedBy(ex)) {
      const mine = unmarkedCode(this.store.solution(u.id) ?? "");
      parts.push([`# ── ${u.title} (của bạn) ──`, u.given.trim(), mine].filter(Boolean).join("\n"));
    }
    return parts.length ? parts.join("\n\n") : null;
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

/** A catalog given in tests, with the learner's papers read again. */
function loadCatalogFor(base: Catalog, papersDir: string, log?: (m: string) => void): Catalog {
  const own = base.papers.filter((p) => p.info.origin === "curated");
  const ownIds = new Set(own.flatMap((p) => p.exercises.map((e) => e.id)));
  const fixed = base.exercises.filter((e) => !e.paper || ownIds.has(e.id));
  const fresh = loadPapers(papersDir, "yours", log).filter((p) => !own.some((o) => o.info.id === p.info.id));
  const exercises = checkExercises([...fixed, ...fresh.flatMap((p) => p.exercises)]);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const papers = [...own, ...fresh];
  return {
    ...base,
    constellations: [...base.constellations.filter((c) => c.kind !== "paper" || own.some((o) => `paper:${o.info.id}` === c.id)), ...fresh.map((p) => ({ id: `paper:${p.info.id}`, name: p.info.title, kind: "paper" as const }))],
    stars: [...base.stars.filter((s) => !s.constellation.startsWith("paper:") || own.some((o) => `paper:${o.info.id}` === s.constellation)), ...fresh.flatMap((p) => paperStars(p))],
    exercises, exercise: (id) => byId.get(id), papers, paperGiven: (id) => papers.find((p) => p.info.id === id)?.info.given ?? "",
  };
}

export function nextHint(level: number): number {
  return Math.min(MENTOR_HINT_MAX, level + 1);
}

export type { MentorStage };
