// What a reading is, folded from the paper's log (reader/events.jsonl, E.3,
// E.8): time per section, marks and notes (ER-1); the goal, the passes, what
// the reader wrote and how the tutor graded it, the checkpoint answers, the
// paper's misconception book (ER-2). Pure: the store keeps the log.

import {
  READER_BLOOMS,
  readerPoints,
  type ReaderBloom,
  type ReaderChoice,
  type ReaderGoal,
  type ReaderGrade,
  type ReaderNote,
  type ReaderPass,
  type ReaderScore,
  type ReaderWriteKind,
} from "@ainb/protocol";

export type ReaderEvent =
  | { t: "r.open"; at: number }
  | { t: "r.section"; at: number; section: string; ms: number }
  | { t: "r.mark"; at: number; section: string; read: boolean }
  | { t: "r.note"; at: number; note: ReaderNote }
  | { t: "r.noteRemove"; at: number; id: string }
  /** Why the reader reads the paper. */
  | { t: "r.goal"; at: number; goal: ReaderGoal }
  /** A pass started, or was finished. */
  | { t: "r.pass"; at: number; pass: ReaderPass; what: "start" | "done" }
  /** A checkpoint answer; the question's unit, concept and level are kept with it (the log alone says how the concepts stand). */
  | { t: "r.answer"; at: number; item: string; unit: string; concept: string; bloom: ReaderBloom; correct: boolean; partly?: boolean; confidence: 1 | 2 | 3; choice: ReaderChoice }
  /** A pretest guess. */
  | { t: "r.pre"; at: number; item: string; option?: number; text?: string }
  /** Something the reader wrote. */
  | { t: "r.write"; at: number; id: string; kind: ReaderWriteKind; unit?: string; key?: string; text: string; fields?: Record<string, string>; sent?: boolean }
  /** The tutor's grade of a write. */
  | { t: "r.grade"; at: number; write: string; grade: ReaderGrade; parts?: { key: string; grade: ReaderGrade; note?: string }[]; missing?: string[]; feedback?: string }
  /** "Cho xem luôn": a pending task's answer shown without doing it. */
  | { t: "r.skip"; at: number; task: string }
  /** "Báo câu sai". */
  | { t: "r.report"; at: number; item: string; reason: string }
  /** A misconception the reader showed (the tutor saw it, or a sure answer was wrong). */
  | { t: "r.miss"; at: number; concept: string; note: string; item?: string };

export interface ReaderAnswer {
  at: number;
  unit: string;
  concept: string;
  bloom: ReaderBloom;
  correct: boolean;
  partly?: boolean;
  confidence: 1 | 2 | 3;
  choice: ReaderChoice;
}

export interface ReaderWrite {
  id: string;
  kind: ReaderWriteKind;
  unit?: string;
  key?: string;
  text: string;
  fields?: Record<string, string>;
  at: number;
  /** Sent to the tutor to grade. */
  sent?: boolean;
  grade?: ReaderGrade;
  parts?: { key: string; grade: ReaderGrade; note?: string }[];
  missing?: string[];
  feedback?: string;
  gradedAt?: number;
}

export interface ReaderState {
  readMs: Map<string, number>;
  marked: Map<string, boolean>;
  notes: Map<string, ReaderNote>;
  at?: string;
  lastAt: number;
  goal?: ReaderGoal;
  pass: ReaderPass;
  passed: Set<ReaderPass>;
  /** Each question's answers, in order. */
  answers: Map<string, ReaderAnswer[]>;
  pre: Map<string, { option?: number; text?: string; at: number }>;
  writes: Map<string, ReaderWrite>;
  skipped: Set<string>;
  reports: Map<string, string>;
  misses: { concept: string; note: string; item?: string; at: number }[];
}

export function emptyReaderState(): ReaderState {
  return {
    readMs: new Map(), marked: new Map(), notes: new Map(), lastAt: 0, pass: 1, passed: new Set(),
    answers: new Map(), pre: new Map(), writes: new Map(), skipped: new Set(), reports: new Map(), misses: [],
  };
}

const PASSES = new Set([1, 2, 3, 4]);
const GOALS = new Set(["gist", "use", "deep"]);
const WRITE_KINDS = new Set(["5c", "recall", "explain", "qalmri", "summary", "figure", "predict"]);

/** The reading so far, from its log. Unknown events, and events missing what they need, are skipped (a later version's, a torn line). */
export function foldReader(events: Iterable<ReaderEvent>, into: ReaderState = emptyReaderState()): ReaderState {
  const s = into;
  for (const e of events) {
    if (!e || typeof e !== "object" || typeof e.at !== "number") continue;
    s.lastAt = Math.max(s.lastAt, e.at);
    switch (e.t) {
      case "r.section":
        if (typeof e.section === "string" && Number.isFinite(e.ms) && e.ms > 0) {
          s.readMs.set(e.section, (s.readMs.get(e.section) ?? 0) + Math.min(e.ms, 10 * 60_000));
          s.at = e.section;
        }
        break;
      case "r.mark":
        if (typeof e.section === "string") s.marked.set(e.section, !!e.read);
        break;
      case "r.note":
        if (e.note?.id) s.notes.set(e.note.id, e.note);
        break;
      case "r.noteRemove":
        s.notes.delete(e.id);
        break;
      case "r.goal":
        if (GOALS.has(e.goal)) s.goal = e.goal;
        break;
      case "r.pass":
        if (!PASSES.has(e.pass)) break;
        if (e.what === "done") s.passed.add(e.pass);
        else s.pass = e.pass;
        break;
      case "r.answer": {
        if (typeof e.item !== "string" || ![1, 2, 3].includes(e.confidence)) break;
        const list = s.answers.get(e.item) ?? [];
        list.push({ at: e.at, unit: String(e.unit ?? ""), concept: String(e.concept ?? ""), bloom: READER_BLOOMS.includes(e.bloom) ? e.bloom : "understand", correct: !!e.correct, ...(e.partly ? { partly: true } : {}), confidence: e.confidence, choice: e.choice ?? {} });
        s.answers.set(e.item, list);
        break;
      }
      case "r.pre":
        if (typeof e.item === "string") s.pre.set(e.item, { ...(Number.isInteger(e.option) ? { option: e.option } : {}), ...(typeof e.text === "string" ? { text: e.text } : {}), at: e.at });
        break;
      case "r.write":
        if (typeof e.id !== "string" || !WRITE_KINDS.has(e.kind) || typeof e.text !== "string") break;
        s.writes.set(e.id, { id: e.id, kind: e.kind, ...(e.unit ? { unit: e.unit } : {}), ...(e.key ? { key: e.key } : {}), text: e.text, ...(e.fields ? { fields: e.fields } : {}), ...(e.sent ? { sent: true } : {}), at: e.at });
        break;
      case "r.grade": {
        const w = s.writes.get(e.write);
        if (!w || ![0, 1, 2].includes(e.grade)) break;
        w.grade = e.grade;
        w.gradedAt = e.at;
        if (e.parts) w.parts = e.parts;
        else delete w.parts;
        if (e.missing) w.missing = e.missing;
        else delete w.missing;
        if (e.feedback) w.feedback = e.feedback;
        else delete w.feedback;
        break;
      }
      case "r.skip":
        if (typeof e.task === "string") s.skipped.add(e.task);
        break;
      case "r.report":
        if (typeof e.item === "string") s.reports.set(e.item, String(e.reason ?? ""));
        break;
      case "r.miss":
        if (typeof e.concept === "string" && typeof e.note === "string") s.misses.push({ concept: e.concept, note: e.note, ...(e.item ? { item: e.item } : {}), at: e.at });
        break;
    }
  }
  return s;
}

/** The reader's latest write of a kind (for a unit, a key). */
export function latestWrite(s: ReaderState, kind: ReaderWriteKind, unit?: string, key?: string): ReaderWrite | undefined {
  let last: ReaderWrite | undefined;
  for (const w of s.writes.values()) {
    if (w.kind !== kind || (unit !== undefined && w.unit !== unit) || (key !== undefined && w.key !== key)) continue;
    if (!last || w.at >= last.at) last = w;
  }
  return last;
}

/** Answered wrong, and not right since: it comes back (Dunlosky: until right once). */
export function isAgain(answers: ReaderAnswer[] | undefined): boolean {
  return !!answers?.length && !answers[answers.length - 1]!.correct;
}

/** The score of some questions: first answers for "right the first time", every answer for points. */
export function scoreOf(s: ReaderState, items: string[]): ReaderScore {
  const score: ReaderScore = { answered: 0, total: items.length, firstRight: 0, points: 0, max: 0, sureWrong: 0, luckyRight: 0 };
  for (const id of items) {
    const list = s.answers.get(id);
    if (!list?.length) continue;
    score.answered++;
    if (list[0]!.correct) score.firstRight++;
    for (const a of list) {
      score.points += readerPoints(a.correct, a.confidence);
      score.max += 3;
      if (!a.correct && a.confidence === 3) score.sureWrong++;
      if (a.correct && a.confidence === 1) score.luckyRight++;
    }
  }
  return score;
}

/** How much an answer counts toward a concept: more the higher it is on Bloom's scale. */
export function bloomWeight(bloom: ReaderBloom): number {
  return 1 + READER_BLOOMS.indexOf(bloom) * 0.5;
}

/**
 * How solid each concept is, 0–1: each question's latest answer, weighted by
 * its level (a sure right answer counts fully, a guess half). Concepts with no
 * answer are not in the map.
 */
export function conceptMastery(s: ReaderState): Map<string, { mastery: number; answers: number }> {
  const sums = new Map<string, { got: number; of: number; answers: number }>();
  for (const [item, list] of s.answers) {
    if (s.reports.has(item) || !list.length) continue;
    const last = list[list.length - 1]!;
    if (!last.concept) continue;
    const w = bloomWeight(last.bloom);
    const sum = sums.get(last.concept) ?? { got: 0, of: 0, answers: 0 };
    sum.of += w;
    sum.got += last.correct ? w * (last.confidence === 1 ? 0.5 : 1) : 0;
    sum.answers += list.length;
    sums.set(last.concept, sum);
  }
  return new Map([...sums].map(([k, v]) => [k, { mastery: v.of ? v.got / v.of : 0, answers: v.answers }]));
}
