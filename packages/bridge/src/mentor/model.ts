// Mentor's numbers, all recomputed from the event log: ratings per skill
// (Elo against the exercise's difficulty), the streak with freeze days, the
// activity heatmap, the state of each star, and which exercise is next.
// Nothing here reads files or the clock; callers pass `now`.

import {
  MENTOR_SKILL_LABEL,
  MENTOR_SKILLS,
  type MentorConstellation,
  type MentorHome,
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
  | (Base & { t: "start"; exerciseId: string; file: string })
  | (Base & { t: "stage"; stage: MentorStage; by: "agent" | "user" | "judge" })
  | (Base & { t: "judge"; ok: boolean; passed: number; total: number; error?: string })
  | (Base & { t: "hint"; level: number })
  | (Base & { t: "probe"; grade: 0 | 1 | 2; question: string; tag?: string })
  | (Base & { t: "misconception"; tag: string; note: string })
  | (Base & { t: "done" });

export interface AttemptState {
  attemptId: string;
  exerciseId: string;
  file: string;
  startedAt: number;
  stage: MentorStage;
  hintLevel: number;
  revealed: boolean;
  judges: number;
  /** Failed verdicts before the first passing one. */
  failedBeforePass: number;
  passed: boolean;
  lastJudge?: { ok: boolean; passed: number; total: number; error?: string; at: number };
  probes: { grade: 0 | 1 | 2; question: string; tag?: string }[];
  misconceptions: { tag: string; note: string; at: number }[];
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

/** The learner's day for a time: local date, shifted so it starts at 4 a.m. */
export function dayOf(ms: number): string {
  const d = new Date(ms - DAY_START_HOURS * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
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
export function attemptScore(a: Pick<AttemptState, "passed" | "hintLevel" | "revealed" | "failedBeforePass" | "probes">, skill: MentorSkill): number {
  let code = a.revealed ? 0.2 : a.passed ? 1 : 0;
  if (!a.revealed) code -= HINT_COST[Math.min(a.hintLevel, HINT_COST.length - 1)]!;
  code -= Math.min(0.2, 0.05 * a.failedBeforePass);
  code = Math.max(0, Math.min(1, code));
  const probe = a.probes.length ? a.probes.reduce((s, p) => s + p.grade / 2, 0) / a.probes.length : 0.5;
  return skill === "theory" ? 0.3 * code + 0.7 * probe : 0.75 * code + 0.25 * probe;
}

export function overallOf(ratings: Map<MentorSkill, Rating>): number | null {
  const rated = [...ratings.values()].filter((x) => x.n > 0);
  return rated.length ? Math.round(rated.reduce((s, x) => s + x.r, 0) / rated.length) : null;
}

/** Fold the log into the current state. Events of unknown exercises still count for the streak. */
export function fold(events: readonly MentorEvent[], catalog: Pick<Catalog, "exercise">): MentorState {
  const state: MentorState = { attempts: new Map(), order: [], ratings: new Map(), history: [], days: new Map() };
  const active = (day: string) => state.days.set(day, (state.days.get(day) ?? 0) + 1);
  for (const e of events) {
    if (e.t === "start") {
      if (state.attempts.has(e.attemptId)) continue;
      state.attempts.set(e.attemptId, {
        attemptId: e.attemptId, exerciseId: e.exerciseId, file: e.file, startedAt: e.at, stage: "lab", hintLevel: 0, revealed: false,
        judges: 0, failedBeforePass: 0, passed: false, probes: [], misconceptions: [],
      });
      state.order.push(e.attemptId);
      continue;
    }
    const a = state.attempts.get(e.attemptId);
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
        break;
      case "done": {
        a.doneAt = e.at;
        a.stage = "done";
        active(e.day);
        const ex = catalog.exercise(a.exerciseId);
        if (!ex) break;
        const deltas: MentorResult["deltas"] = [];
        for (const skill of ex.skills) {
          const now = state.ratings.get(skill) ?? { r: START_RATING, n: 0 };
          const score = attemptScore(a, skill);
          let delta = kFactor(now.n) * (score - expected(now.r, ex.difficulty));
          // Seeing the solution can only cost rating.
          if (a.revealed) delta = Math.min(0, delta);
          const after = Math.round(now.r + delta);
          deltas.push({ skill, before: Math.round(now.r), after });
          state.ratings.set(skill, { r: now.r + delta, n: now.n + 1 });
        }
        const mean = ex.skills.reduce((s, k) => s + attemptScore(a, k), 0) / ex.skills.length;
        a.result = { score: Math.round(mean * 100) / 100, deltas, revealed: a.revealed };
        const overall = overallOf(state.ratings);
        if (overall !== null) state.history.push({ at: e.at, overall });
        break;
      }
    }
  }
  return state;
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
function masteredExercises(state: MentorState): Set<string> {
  const out = new Set<string>();
  for (const a of state.attempts.values()) if (a.doneAt && a.passed && !a.revealed) out.add(a.exerciseId);
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

/** Diagnostic exercises in the order they are taken. */
export function diagnosticExercises(catalog: Catalog): Exercise[] {
  return catalog.exercises.filter((e) => e.diagnostic).sort((a, b) => a.diagnostic! - b.diagnostic! || a.order - b.order);
}

export function pickToday(state: MentorState, catalog: Catalog, now: number): MentorToday | null {
  const view = (e: Exercise, reason: MentorToday["reason"], attemptId?: string): MentorToday => ({
    exerciseId: e.id, title: e.title, star: e.star, minutes: e.minutes, difficulty: e.difficulty, reason, ...(attemptId ? { attemptId } : {}),
  });
  const today = dayOf(now);
  // An exercise left half way, recently.
  for (const id of [...state.order].reverse()) {
    const a = state.attempts.get(id)!;
    const ex = catalog.exercise(a.exerciseId);
    if (!a.doneAt && ex && daysBetween(dayOf(a.startedAt), today) <= CONTINUE_DAYS) return view(ex, "continue", a.attemptId);
  }
  const finished = new Set([...state.attempts.values()].filter((a) => a.doneAt).map((a) => a.exerciseId));
  const diagnostic = diagnosticExercises(catalog).find((e) => !finished.has(e.id));
  if (diagnostic) return view(diagnostic, "diagnostic");
  const mastered = masteredExercises(state);
  for (const a of state.attempts.values()) {
    if (!a.revealed || !a.doneAt || mastered.has(a.exerciseId)) continue;
    const ex = catalog.exercise(a.exerciseId);
    if (ex && daysBetween(dayOf(a.doneAt), today) >= REDO_AFTER_DAYS) return view(ex, "redo");
  }
  const stars = starStates(state, catalog);
  const overall = overallOf(state.ratings) ?? START_RATING;
  const candidates = catalog.exercises.filter((e) => !mastered.has(e.id) && stars.get(e.star) !== "locked");
  const fitting = candidates.filter((e) => e.difficulty >= overall - 200);
  const pick = (fitting.length ? fitting : candidates)[0];
  return pick ? view(pick, "next") : null;
}

export function home(state: MentorState, catalog: Catalog, now: number, workDir: string): MentorHome {
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
    exercises: catalog.exercises
      .filter((e) => e.star === s.id)
      .map((e) => ({ id: e.id, title: e.title, difficulty: e.difficulty, minutes: e.minutes, done: mastered.has(e.id) })),
  }));
  const constellations: MentorConstellation[] = catalog.constellations.map((c) => {
    const own = catalog.stars.filter((s) => s.constellation === c.id).map((s) => s.id);
    return { id: c.id, name: c.name, ...(c.paper ? { paper: c.paper } : {}), stars: own, mastered: own.filter((id) => states.get(id) === "mastered").length };
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
      at: a.doneAt ?? a.startedAt,
      stage: a.stage,
      ...(a.result ? { score: a.result.score } : {}),
      revealed: a.revealed,
    };
  });
  return {
    workDir,
    today: pickToday(state, catalog, now),
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
