// Mentor's numbers, all recomputed from the event log: ratings per skill
// (Elo against the exercise's difficulty), the streak with freeze days, the
// activity heatmap, the state of each star, and which exercise is next.
// Nothing here reads files or the clock; callers pass `now`.

import {
  MENTOR_REVIEW_DAYS,
  MENTOR_SKILL_LABEL,
  MENTOR_SKILLS,
  type MentorConstellation,
  type MentorHome,
  type MentorKind,
  type MentorMistake,
  type MentorScaffold,
  type MentorResult,
  type MentorSkill,
  type MentorStage,
  type MentorStarState,
  type MentorStarView,
  type MentorToday,
} from "@ainb/protocol";
import type { Catalog, Exercise } from "./catalog.js";

interface Base {
  at: number;
  /** The learner's day (see dayOf), fixed when the event is written. */
  day: string;
  attemptId: string;
}

export type MentorEvent =
  /** `file`: where an attempt of the local-notebook days was written (no longer used). */
  | (Base & { t: "start"; exerciseId: string; file?: string; kind?: MentorKind; scaffold?: MentorScaffold })
  /** The exercise was written into this notebook (its key); the notebook holds it until another one is. */
  | (Base & { t: "load"; notebook: string })
  | (Base & { t: "stage"; stage: MentorStage; by: "agent" | "user" | "judge" })
  | (Base & { t: "judge"; ok: boolean; passed: number; total: number; error?: string; metrics?: { name: string; value: number }[] })
  | (Base & { t: "hint"; level: number })
  | (Base & { t: "probe"; grade: 0 | 1 | 2; question: string; tag?: string })
  | (Base & { t: "misconception"; tag: string; note: string })
  /** A misconception from the book, asked again at the start of a session. */
  | (Base & { t: "recall"; tag: string; grade: 0 | 1 | 2 })
  | (Base & { t: "done" })
  /** The learner reported the exercise as wrong: the attempt does not count (no rating, no review). */
  | (Base & { t: "void"; reason: string })
  /** A paper's milestones (attemptId "paper:<id>"): its plan approved, or the paper reproduced. Each is a learning day. */
  | (Base & { t: "paper"; paperId: string; what: "planned" | "done" })
  /** The notebook (its key) became the paper's workshop (attemptId "paper:<id>"). */
  | (Base & { t: "workshop"; paperId: string; notebook: string });

/** The attemptId of events about a paper, not an attempt. */
export function paperEventId(paperId: string): string {
  return `paper:${paperId}`;
}

export interface AttemptState {
  attemptId: string;
  exerciseId: string;
  file?: string;
  /** The notebook it is in now (its key). */
  notebook?: string;
  kind: MentorKind;
  scaffold: MentorScaffold;
  startedAt: number;
  stage: MentorStage;
  hintLevel: number;
  revealed: boolean;
  judges: number;
  /** Failed verdicts before the first passing one. */
  failedBeforePass: number;
  passed: boolean;
  lastJudge?: { ok: boolean; passed: number; total: number; error?: string; at: number };
  /** What the last passing judge measured (an experiment). */
  metrics?: { name: string; value: number }[];
  /** Reported as a wrong exercise: it does not count. */
  voided?: string;
  probes: { grade: 0 | 1 | 2; question: string; tag?: string }[];
  misconceptions: { tag: string; note: string; at: number }[];
  recalls: { tag: string; grade: 0 | 1 | 2 }[];
  doneAt?: number;
  result?: MentorResult;
}

export interface Rating {
  r: number;
  n: number;
}

export interface MentorState {
  attempts: Map<string, AttemptState>;
  /** Attempts in the order they started. */
  order: string[];
  ratings: Map<MentorSkill, Rating>;
  history: { at: number; overall: number }[];
  /** Steps finished per day. */
  days: Map<string, number>;
  /** Which attempt each notebook holds (by notebook key). */
  places: Map<string, string>;
  /** Which paper each notebook is the workshop of (by notebook key). */
  workshops: Map<string, string>;
  /** Spaced reviews per exercise learnt on the learner's own. */
  reviews: Map<string, ReviewState>;
  /** The misconception book, by tag. */
  mistakes: Map<string, MistakeState>;
}

export interface ReviewState {
  /** Reviews passed in a row (an index into MENTOR_REVIEW_DAYS). */
  step: number;
  /** The day the next review is due; null once learnt. */
  due: string | null;
}

export interface MistakeState {
  tag: string;
  note: string;
  exerciseId: string;
  firstAt: number;
  seen: number;
  streak: number;
  /** null once solid. */
  due: string | null;
  /** Attempts it was recorded or asked in (not asked again there). */
  attempts: Set<string>;
}

export const START_RATING = 1000;
/** A day starts at 4 a.m., so a late night still counts for the day before. */
const DAY_START_HOURS = 4;
const HEATMAP_DAYS = 16 * 7;
const FREEZE_EVERY = 7;
const FREEZE_MAX = 2;
/** What each hint level costs the code part of the score (level 4 is the reveal). */
const HINT_COST = [0, 0.1, 0.25, 0.45, 0.8];
/** Days after seeing the reference solution before the exercise comes back. */
export const REDO_AFTER_DAYS = 3;
/** An attempt left unfinished this long is no longer offered to continue. */
const CONTINUE_DAYS = 7;
/** A review counts as remembered with at most this hint level (a direction in words). */
const REVIEW_HINT_OK = 1;
/** A review moves the rating half as much as learning the exercise. */
const REVIEW_K = 0.5;
/** Days before a misconception is asked again, and after a right answer. */
const MISTAKE_AGAIN_DAYS = 2;
const MISTAKE_RIGHT_DAYS = 7;
/** Right answers in a row that make a misconception solid. */
const MISTAKE_SOLID = 2;
/** Days overdue at which a star is fully dimmed. */
const FADE_DAYS = 14;
/** Misconceptions asked at the start of one session at most. */
export const RECALLS_PER_SESSION = 3;
/** An exercise the mentor wrote moves the rating half as much (its difficulty is the mentor's guess). */
const AI_K = 0.5;

/** The learner's day for a time: local date, shifted so it starts at 4 a.m. */
export function dayOf(ms: number): string {
  const d = new Date(ms - DAY_START_HOURS * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function expected(rating: number, difficulty: number): number {
  return 1 / (1 + 10 ** ((difficulty - rating) / 400));
}

/** Larger steps while a skill has few results, so the diagnostic places it quickly. */
export function kFactor(games: number): number {
  return games < 5 ? 120 : games < 10 ? 80 : 40;
}

/** How well an attempt went for one skill, 0..1. */
export function attemptScore(a: Pick<AttemptState, "kind" | "passed" | "hintLevel" | "revealed" | "failedBeforePass" | "probes">, skill: MentorSkill): number {
  let code = a.revealed ? 0.2 : a.passed ? 1 : 0;
  if (!a.revealed) code -= HINT_COST[Math.min(a.hintLevel, HINT_COST.length - 1)]!;
  code -= Math.min(0.2, 0.05 * a.failedBeforePass);
  code = Math.max(0, Math.min(1, code));
  // A review is the code from memory, nothing else; leaning on more than a direction means it was forgotten.
  if (a.kind === "review") return a.hintLevel > REVIEW_HINT_OK ? Math.min(code, 0.3) : code;
  const probe = a.probes.length ? a.probes.reduce((s, p) => s + p.grade / 2, 0) / a.probes.length : 0.5;
  return skill === "theory" ? 0.3 * code + 0.7 * probe : 0.75 * code + 0.25 * probe;
}

export function overallOf(ratings: Map<MentorSkill, Rating>): number | null {
  const rated = [...ratings.values()].filter((x) => x.n > 0);
  return rated.length ? Math.round(rated.reduce((s, x) => s + x.r, 0) / rated.length) : null;
}

/** Fold the log into the current state. Events of unknown exercises still count for the streak. */
export function fold(events: readonly MentorEvent[], catalog: Pick<Catalog, "exercise">): MentorState {
  const state: MentorState = { attempts: new Map(), order: [], ratings: new Map(), history: [], days: new Map(), places: new Map(), workshops: new Map(), reviews: new Map(), mistakes: new Map() };
  const active = (day: string) => state.days.set(day, (state.days.get(day) ?? 0) + 1);
  // A report can come after the attempt is done: it still undoes its rating.
  const voided = new Map<string, string>();
  for (const e of events) if (e.t === "void") voided.set(e.attemptId, e.reason);
  for (const e of events) {
    if (e.t === "paper") {
      active(e.day);
      continue;
    }
    if (e.t === "workshop") {
      const held = state.places.get(e.notebook);
      if (held) {
        state.places.delete(e.notebook);
        const a = state.attempts.get(held);
        if (a) a.notebook = undefined;
      }
      for (const [k, v] of state.workshops) if (v === e.paperId) state.workshops.delete(k);
      state.workshops.set(e.notebook, e.paperId);
      continue;
    }
    if (e.t === "start") {
      if (state.attempts.has(e.attemptId)) continue;
      const kind = e.kind ?? "learn";
      state.attempts.set(e.attemptId, {
        attemptId: e.attemptId, exerciseId: e.exerciseId, ...(e.file ? { file: e.file } : {}), kind, scaffold: e.scaffold ?? (kind === "review" ? "blank" : "full"),
        startedAt: e.at, stage: kind === "review" ? "build" : "lab", hintLevel: 0, revealed: false,
        judges: 0, failedBeforePass: 0, passed: false, probes: [], misconceptions: [], recalls: [],
        // Reported as wrong: it never counts, and is not taken up again.
        ...(voided.has(e.attemptId) ? { voided: voided.get(e.attemptId)! } : {}),
      });
      state.order.push(e.attemptId);
      continue;
    }
    const a = state.attempts.get(e.attemptId);
    if (a && e.t === "load") {
      state.workshops.delete(e.notebook);
      if (a.notebook && state.places.get(a.notebook) === a.attemptId) state.places.delete(a.notebook);
      const before = state.places.get(e.notebook);
      if (before) state.attempts.get(before)!.notebook = undefined;
      state.places.set(e.notebook, a.attemptId);
      a.notebook = e.notebook;
      continue;
    }
    if (!a || a.doneAt) continue;
    switch (e.t) {
      case "stage":
        if (stageIndex(e.stage) > stageIndex(a.stage)) {
          a.stage = e.stage;
          active(e.day);
        }
        break;
      case "judge":
        a.judges++;
        a.lastJudge = { ok: e.ok, passed: e.passed, total: e.total, error: e.error, at: e.at };
        if (e.ok && e.metrics?.length) a.metrics = e.metrics;
        if (e.ok) a.passed = true;
        else if (!a.passed) a.failedBeforePass++;
        break;
      case "hint":
        a.hintLevel = Math.max(a.hintLevel, e.level);
        if (e.level >= HINT_COST.length - 1) a.revealed = true;
        break;
      case "probe":
        a.probes.push({ grade: e.grade, question: e.question, tag: e.tag });
        break;
      case "misconception":
        a.misconceptions.push({ tag: e.tag, note: e.note, at: e.at });
        noteMistake(state, a, e.tag, e.note, e.at, e.day);
        break;
      case "recall":
        a.recalls.push({ tag: e.tag, grade: e.grade });
        recallMistake(state, a, e.tag, e.grade, e.day);
        break;
      case "done": {
        a.doneAt = e.at;
        a.stage = "done";
        active(e.day);
        const ex = catalog.exercise(a.exerciseId);
        const why = voided.get(a.attemptId);
        if (why !== undefined) {
          a.voided = why;
          a.result = { score: 0, deltas: [], revealed: a.revealed };
          break;
        }
        if (!ex) break;
        const deltas: MentorResult["deltas"] = [];
        for (const skill of ex.skills) {
          const now = state.ratings.get(skill) ?? { r: START_RATING, n: 0 };
          const score = attemptScore(a, skill);
          let delta = kFactor(now.n) * (a.kind === "review" ? REVIEW_K : 1) * (ex.author === "ai" ? AI_K : 1) * (score - expected(now.r, ex.difficulty));
          // Seeing the solution can only cost rating.
          if (a.revealed) delta = Math.min(0, delta);
          const after = Math.round(now.r + delta);
          deltas.push({ skill, before: Math.round(now.r), after });
          state.ratings.set(skill, { r: now.r + delta, n: now.n + 1 });
        }
        const mean = ex.skills.reduce((s, k) => s + attemptScore(a, k), 0) / ex.skills.length;
        a.result = { score: Math.round(mean * 100) / 100, deltas, revealed: a.revealed };
        // An experiment is trained once; there is nothing to re-implement from memory.
        const next = ex.role === "experiment" ? undefined : scheduleReview(state, a, e.day);
        if (next !== undefined) a.result.nextReview = next;
        const overall = overallOf(state.ratings);
        if (overall !== null) state.history.push({ at: e.at, overall });
        break;
      }
    }
  }
  return state;
}

/**
 * The next review of the attempt's exercise, once the attempt is done: three
 * days after learning it on one's own; after a review, the next interval when
 * it was remembered (passed, at most a direction as a hint), else three days
 * again. Returns the days to the next review (null once learnt, undefined
 * when none is scheduled).
 */
function scheduleReview(state: MentorState, a: AttemptState, day: string): number | null | undefined {
  const own = a.passed && !a.revealed;
  if (a.kind === "learn") {
    if (!own) return undefined;
    state.reviews.set(a.exerciseId, { step: 0, due: addDays(day, MENTOR_REVIEW_DAYS[0]!) });
    return MENTOR_REVIEW_DAYS[0]!;
  }
  const prev = state.reviews.get(a.exerciseId) ?? { step: 0, due: null };
  if (own && a.hintLevel <= REVIEW_HINT_OK) {
    const step = prev.step + 1;
    if (step >= MENTOR_REVIEW_DAYS.length) {
      state.reviews.set(a.exerciseId, { step, due: null });
      return null;
    }
    state.reviews.set(a.exerciseId, { step, due: addDays(day, MENTOR_REVIEW_DAYS[step]!) });
    return MENTOR_REVIEW_DAYS[step]!;
  }
  state.reviews.set(a.exerciseId, { step: 0, due: addDays(day, MENTOR_REVIEW_DAYS[0]!) });
  return MENTOR_REVIEW_DAYS[0]!;
}

function mistakeKey(tag: string): string {
  return tag.trim().toLowerCase();
}

/** A misconception showed: in the book, asked again in two days (and it is no longer solid). */
function noteMistake(state: MentorState, a: AttemptState, tag: string, note: string, at: number, day: string): void {
  const key = mistakeKey(tag);
  const m = state.mistakes.get(key);
  if (!m) {
    state.mistakes.set(key, { tag: tag.trim(), note, exerciseId: a.exerciseId, firstAt: at, seen: 1, streak: 0, due: addDays(day, MISTAKE_AGAIN_DAYS), attempts: new Set([a.attemptId]) });
    return;
  }
  m.note = note;
  m.seen++;
  m.streak = 0;
  m.due = addDays(day, MISTAKE_AGAIN_DAYS);
  m.attempts.add(a.attemptId);
}

/** A misconception asked again: two right answers in a row make it solid; a wrong one starts over. */
function recallMistake(state: MentorState, a: AttemptState, tag: string, grade: 0 | 1 | 2, day: string): void {
  const m = state.mistakes.get(mistakeKey(tag));
  if (!m) return;
  m.attempts.add(a.attemptId);
  if (grade === 2) {
    m.streak++;
    m.due = m.streak >= MISTAKE_SOLID ? null : addDays(day, MISTAKE_RIGHT_DAYS);
  } else {
    if (grade === 0) m.seen++;
    m.streak = 0;
    m.due = addDays(day, MISTAKE_AGAIN_DAYS);
  }
}

/** Misconceptions to ask again in this attempt: due, not from it, oldest due first. */
export function dueMistakes(state: MentorState, attemptId: string, today: string): MistakeState[] {
  const a = state.attempts.get(attemptId);
  const left = RECALLS_PER_SESSION - (a ? a.recalls.length : 0);
  if (left <= 0) return [];
  return [...state.mistakes.values()]
    .filter((m) => m.due !== null && m.due <= today && !m.attempts.has(attemptId))
    .sort((x, y) => x.due!.localeCompare(y.due!) || x.firstAt - y.firstAt)
    .slice(0, left);
}

/** The book as the home page shows it: due first, then waiting, then solid. */
export function mistakeBook(state: MentorState, catalog: Pick<Catalog, "exercise">, today: string): MentorMistake[] {
  const rank = { due: 0, waiting: 1, solid: 2 } as const;
  return [...state.mistakes.values()]
    .map((m): MentorMistake => {
      const status = m.due === null ? "solid" : m.due <= today ? "due" : "waiting";
      return {
        tag: m.tag, note: m.note, exerciseId: m.exerciseId, title: catalog.exercise(m.exerciseId)?.title ?? m.exerciseId,
        seen: m.seen, streak: m.streak, status, ...(m.due ? { due: m.due } : {}),
      };
    })
    .sort((x, y) => rank[x.status] - rank[y.status] || (x.due ?? "").localeCompare(y.due ?? "") || y.seen - x.seen);
}

/** Exercises whose review is due by today, most overdue first. */
export function dueReviews(state: MentorState, today: string): { exerciseId: string; due: string; overdue: number }[] {
  return [...state.reviews]
    .filter(([, r]) => r.due !== null && r.due <= today)
    .map(([exerciseId, r]) => ({ exerciseId, due: r.due!, overdue: daysBetween(r.due!, today) }))
    .sort((x, y) => y.overdue - x.overdue || x.exerciseId.localeCompare(y.exerciseId));
}

function stageIndex(s: MentorStage): number {
  return ["lab", "build", "defend", "done"].indexOf(s);
}

export interface Streak {
  current: number;
  best: number;
  freezes: number;
  doneToday: boolean;
}

/**
 * Consecutive active days up to today (today still open does not break it).
 * Every 7 active days in a row earn a freeze day (2 at most), spent by
 * itself on a missed day so the streak survives it.
 */
export function streakOf(days: ReadonlyMap<string, number>, today: string): Streak {
  const active = [...days.keys()].filter((d) => d <= today).sort();
  if (!active.length) return { current: 0, best: 0, freezes: 0, doneToday: false };
  let current = 0;
  let best = 0;
  let freezes = 0;
  let run = 0;
  for (let d = active[0]!; d <= today; d = addDays(d, 1)) {
    if (days.has(d)) {
      current++;
      run++;
      if (run % FREEZE_EVERY === 0) freezes = Math.min(FREEZE_MAX, freezes + 1);
    } else if (d === today) {
      // The day is not over.
    } else if (freezes > 0 && current > 0) {
      freezes--;
      run = 0;
    } else {
      current = 0;
      run = 0;
    }
    best = Math.max(best, current);
  }
  return { current, best, freezes, doneToday: days.has(today) };
}

export function heatmap(days: ReadonlyMap<string, number>, today: string): { day: string; count: number }[] {
  const out: { day: string; count: number }[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    out.push({ day, count: days.get(day) ?? 0 });
  }
  return out;
}

/** Exercises the learner has finished on their own (not after seeing the solution). */
export function masteredExercises(state: MentorState): Set<string> {
  const out = new Set<string>();
  for (const a of state.attempts.values()) if (a.doneAt && a.passed && !a.revealed && !a.voided) out.add(a.exerciseId);
  return out;
}

/** Exercises with a passing, finished attempt (seen the solution or not): what later exercises can build on. */
export function passedExercises(state: MentorState): Set<string> {
  const out = new Set<string>();
  for (const a of state.attempts.values()) if (a.doneAt && a.passed && !a.voided) out.add(a.exerciseId);
  return out;
}

export function starStates(state: MentorState, catalog: Catalog): Map<string, MentorStarState> {
  const mastered = masteredExercises(state);
  const tried = new Set([...state.attempts.values()].map((a) => a.exerciseId));
  const out = new Map<string, MentorStarState>();
  for (const star of catalog.stars) {
    const exercises = catalog.exercises.filter((e) => e.star === star.id);
    if (exercises.some((e) => mastered.has(e.id))) out.set(star.id, "mastered");
    else if (exercises.some((e) => tried.has(e.id))) out.set(star.id, "learning");
    else out.set(star.id, "locked");
  }
  // A star with exercises opens once the stars before it are started (the map is a guide, not a gate).
  for (const star of catalog.stars) {
    if (out.get(star.id) !== "locked" || !catalog.exercises.some((e) => e.star === star.id)) continue;
    if (star.after.every((a) => out.get(a) === "mastered" || out.get(a) === "learning")) out.set(star.id, "open");
  }
  return out;
}

/**
 * How much code a new attempt starts with: a review starts blank; the
 * diagnostic gives the full starter; afterwards the starter thins out as the
 * learner's rating on the exercise's skills grows.
 */
export function scaffoldFor(state: MentorState, ex: Exercise, kind: MentorKind): MentorScaffold {
  if (kind === "review") return "blank";
  if (ex.diagnostic) return "full";
  const rated = ex.skills.map((s) => state.ratings.get(s)).filter((r): r is Rating => !!r && r.n > 0);
  if (!rated.length) return "full";
  const low = Math.min(...rated.map((r) => r.r));
  return low < 1250 ? "full" : low < 1500 ? "signature" : "blank";
}

/** Diagnostic exercises in the order they are taken. */
export function diagnosticExercises(catalog: Catalog): Exercise[] {
  return catalog.exercises.filter((e) => e.diagnostic).sort((a, b) => a.diagnostic! - b.diagnostic! || a.order - b.order);
}

export interface FocusRef {
  kind: "paper" | "constellation";
  id: string;
}

/**
 * The next exercise of what the learner focuses on: a paper's next component
 * (its exercises in the order they build on each other), or the easiest
 * exercise not learnt in a constellation and the stars before it.
 */
export function focusNext(state: MentorState, catalog: Catalog, focus: FocusRef): Exercise | null {
  const mastered = masteredExercises(state);
  const passed = passedExercises(state);
  if (focus.kind === "paper") {
    const own = catalog.exercises.filter((e) => e.paper === focus.id);
    const ids = new Set(own.map((e) => e.id));
    // Topological: an exercise comes after those it uses.
    const done = new Set<string>();
    const ordered: Exercise[] = [];
    while (ordered.length < own.length) {
      const next = own.find((e) => !done.has(e.id) && e.uses.every((u) => !ids.has(u) || done.has(u)));
      if (!next) break;
      done.add(next.id);
      ordered.push(next);
    }
    return ordered.find((e) => !passed.has(e.id) && e.uses.every((u) => passed.has(u))) ?? null;
  }
  const stars = new Set<string>();
  const add = (id: string) => {
    if (stars.has(id)) return;
    stars.add(id);
    for (const a of catalog.stars.find((s) => s.id === id)?.after ?? []) add(a);
  };
  for (const s of catalog.stars) if (s.constellation === focus.id) add(s.id);
  return catalog.exercises.find((e) => !e.paper && stars.has(e.star) && !mastered.has(e.id) && (!e.variantOf || mastered.has(e.variantOf)) && e.uses.every((u) => passed.has(u))) ?? null;
}

export function pickToday(state: MentorState, catalog: Catalog, now: number, focus: FocusRef | null = null): MentorToday | null {
  const view = (e: Exercise, reason: MentorToday["reason"], attemptId?: string): MentorToday => todayView(e, reason, "learn", attemptId);
  const today = dayOf(now);
  // An exercise left half way, recently (reviews are the warm-up).
  for (const id of [...state.order].reverse()) {
    const a = state.attempts.get(id)!;
    const ex = catalog.exercise(a.exerciseId);
    if (a.kind === "learn" && !a.doneAt && a.voided === undefined && ex && daysBetween(dayOf(a.startedAt), today) <= CONTINUE_DAYS) return view(ex, "continue", a.attemptId);
  }
  const finished = new Set([...state.attempts.values()].filter((a) => a.doneAt).map((a) => a.exerciseId));
  const diagnostic = diagnosticExercises(catalog).find((e) => !finished.has(e.id));
  if (diagnostic) return view(diagnostic, "diagnostic");
  const mastered = masteredExercises(state);
  for (const a of state.attempts.values()) {
    if (a.kind !== "learn" || !a.revealed || !a.doneAt || mastered.has(a.exerciseId)) continue;
    const ex = catalog.exercise(a.exerciseId);
    if (ex && daysBetween(dayOf(a.doneAt), today) >= REDO_AFTER_DAYS) return view(ex, "redo");
  }
  if (focus) {
    const next = focusNext(state, catalog, focus);
    if (next) return view(next, focus.kind === "paper" ? "paper" : "focus");
  }
  // A variation of an exercise just learnt comes next, while it is fresh.
  for (const id of [...state.order].reverse()) {
    const a = state.attempts.get(id)!;
    if (a.kind !== "learn" || !a.doneAt || !mastered.has(a.exerciseId)) continue;
    const variant = catalog.exercises.find((e) => e.variantOf === a.exerciseId && !mastered.has(e.id) && !state.order.some((o) => state.attempts.get(o)!.exerciseId === e.id));
    if (variant) return view(variant, "variant");
    break;
  }
  const stars = starStates(state, catalog);
  const overall = overallOf(state.ratings) ?? START_RATING;
  // A variation waits for its exercise.
  // Paper components are taken from the shelf (or a focus), not from the map.
  // Nor are the exercises of a topic that asked to be left out of the daily pick.
  const passed = passedExercises(state);
  const aside = new Set(catalog.constellations.filter((c) => c.daily === false).map((c) => c.id));
  const offered = new Set(catalog.stars.filter((s) => !aside.has(s.constellation)).map((s) => s.id));
  const candidates = catalog.exercises.filter((e) => !e.paper && offered.has(e.star) && !mastered.has(e.id) && stars.get(e.star) !== "locked" && (!e.variantOf || mastered.has(e.variantOf)) && e.uses.every((u) => passed.has(u)));
  const fitting = candidates.filter((e) => e.difficulty >= overall - 200);
  const pick = (fitting.length ? fitting : candidates)[0];
  return pick ? view(pick, "next") : null;
}

/** How far a star has dimmed: its most overdue review, over two weeks (a due review already dims it a little). */
export function starFade(state: MentorState, catalog: Catalog, star: string, today: string): number {
  let fade = 0;
  for (const e of catalog.exercises) {
    if (e.star !== star) continue;
    const r = state.reviews.get(e.id);
    if (!r?.due || r.due > today) continue;
    fade = Math.max(fade, Math.min(1, (daysBetween(r.due, today) + 1) / FADE_DAYS));
  }
  return Math.round(fade * 100) / 100;
}

/** The warm-up: a review left half way, else the most overdue one. */
export function pickWarmup(state: MentorState, catalog: Catalog, now: number): MentorToday | null {
  const today = dayOf(now);
  for (const id of [...state.order].reverse()) {
    const a = state.attempts.get(id)!;
    const ex = catalog.exercise(a.exerciseId);
    if (a.kind === "review" && !a.doneAt && a.voided === undefined && ex && daysBetween(dayOf(a.startedAt), today) <= CONTINUE_DAYS) {
      const r = state.reviews.get(ex.id);
      return { ...todayView(ex, "continue", "review", a.attemptId), overdue: r?.due ? Math.max(0, daysBetween(r.due, today)) : 0 };
    }
  }
  for (const r of dueReviews(state, today)) {
    const ex = catalog.exercise(r.exerciseId);
    if (ex) return { ...todayView(ex, "review", "review"), overdue: r.overdue };
  }
  return null;
}

function todayView(e: Exercise, reason: MentorToday["reason"], kind: MentorKind, attemptId?: string): MentorToday {
  return {
    exerciseId: e.id, title: e.title, star: e.star, minutes: kind === "review" ? Math.min(10, Math.ceil(e.minutes / 2)) : e.minutes,
    difficulty: e.difficulty, reason, kind, ...(attemptId ? { attemptId } : {}),
  };
}

export function home(state: MentorState, catalog: Catalog, now: number, focus: FocusRef | null = null): Omit<MentorHome, "papers" | "focus"> {
  const today = dayOf(now);
  const states = starStates(state, catalog);
  const mastered = masteredExercises(state);
  const stars: MentorStarView[] = catalog.stars.map((s) => ({
    id: s.id,
    name: s.name,
    constellation: s.constellation,
    x: s.x,
    y: s.y,
    after: s.after,
    state: states.get(s.id) ?? "locked",
    fade: starFade(state, catalog, s.id, today),
    exercises: catalog.exercises
      .filter((e) => e.star === s.id)
      .map((e) => ({ id: e.id, title: e.title, difficulty: e.difficulty, minutes: e.minutes, done: mastered.has(e.id), ...(e.variantOf ? { variant: true } : {}) })),
  }));
  const constellations: MentorConstellation[] = catalog.constellations.map((c) => {
    const own = catalog.stars.filter((s) => s.constellation === c.id).map((s) => s.id);
    return {
      id: c.id, name: c.name, kind: c.kind,
      ...(c.paper ? { paper: c.paper } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...(c.daily === false ? { daily: false } : {}),
      stars: own, mastered: own.filter((id) => states.get(id) === "mastered").length,
    };
  });
  const diag = diagnosticExercises(catalog);
  const finished = new Set([...state.attempts.values()].filter((a) => a.doneAt).map((a) => a.exerciseId));
  const diagDone = diag.filter((e) => finished.has(e.id)).length;
  const skills = MENTOR_SKILLS.map((skill) => {
    const r = state.ratings.get(skill);
    return { skill, label: MENTOR_SKILL_LABEL[skill], rating: r && r.n ? Math.round(r.r) : null, games: r?.n ?? 0 };
  });
  const weakest = diag.length && diagDone === diag.length
    ? skills.filter((s) => s.rating !== null).sort((a, b) => a.rating! - b.rating!).slice(0, 3).map((s) => s.skill)
    : [];
  const recent = [...state.order].reverse().slice(0, 8).map((id) => {
    const a = state.attempts.get(id)!;
    return {
      attemptId: a.attemptId,
      exerciseId: a.exerciseId,
      title: catalog.exercise(a.exerciseId)?.title ?? a.exerciseId,
      kind: a.kind,
      at: a.doneAt ?? a.startedAt,
      stage: a.stage,
      ...(a.result ? { score: a.result.score } : {}),
      revealed: a.revealed,
    };
  });
  return {
    today: pickToday(state, catalog, now, focus),
    warmup: pickWarmup(state, catalog, now),
    reviews: {
      due: dueReviews(state, today).length,
      upcoming: [...state.reviews]
        .filter(([, r]) => r.due !== null && r.due > today)
        .sort(([, x], [, y]) => x.due!.localeCompare(y.due!))
        .slice(0, 5)
        .map(([exerciseId, r]) => ({ exerciseId, title: catalog.exercise(exerciseId)?.title ?? exerciseId, day: r.due! })),
    },
    mistakes: mistakeBook(state, catalog, today),
    streak: streakOf(state.days, today),
    heatmap: heatmap(state.days, today),
    skills,
    overall: overallOf(state.ratings),
    stars,
    constellations,
    diagnostic: { done: diagDone, total: diag.length, weakest },
    recent,
    history: state.history,
  };
}
