// Mentor: the learner implements ML building blocks themself in a local
// notebook; the bridge judges the code, the agent coaches and asks questions.
// These are the shapes the bridge, the chat panel and the Mentor home share.

/** The three steps of an exercise, then done. */
export type MentorStage = "lab" | "build" | "defend" | "done";
export const MENTOR_STAGES: readonly MentorStage[] = ["lab", "build", "defend", "done"];

/** What a rating measures. */
export type MentorSkill = "tensor" | "formula" | "blank" | "train" | "theory";
export const MENTOR_SKILLS: readonly MentorSkill[] = ["tensor", "formula", "blank", "train", "theory"];

export const MENTOR_SKILL_LABEL: Record<MentorSkill, string> = {
  tensor: "Tensor & PyTorch",
  formula: "Công thức → code",
  blank: "Dựng từ trang trắng",
  train: "Train & debug",
  theory: "Lý thuyết sâu",
};

export const MENTOR_STAGE_LABEL: Record<MentorStage, string> = {
  lab: "Phòng công thức",
  build: "Dựng",
  defend: "Bảo vệ",
  done: "Xong",
};

/** Hint levels: 0 questions only, 1 direction, 2 pseudo-code, 3 a short snippet, 4 the reference solution. */
export const MENTOR_HINT_MAX = 4;
export const MENTOR_HINT_LABEL = ["Chỉ hỏi ngược", "Hướng đi", "Pseudo-code", "Đoạn code nhỏ", "Lời giải mẫu"] as const;

/** One run of the exercise's hidden tests on the learner's code. */
export interface MentorVerdict {
  at: number;
  /** Every test passed. */
  ok: boolean;
  passed: number;
  total: number;
  tests: { name: string; ok: boolean; message?: string }[];
  /** The learner's cells did not run (a syntax error, an exception at import time), or the judge could not run. */
  error?: string;
  /** Python modules the exercise needs that the kernel does not have. */
  missing?: string[];
}

/** An exercise in a chat: where the learner is, for the panel's stepper and buttons. */
export interface MentorChat {
  attemptId: string;
  exerciseId: string;
  title: string;
  star: string;
  stage: MentorStage;
  hintLevel: number;
  /** The reference solution was shown: the attempt cannot raise a rating, and comes back in three days. */
  revealed: boolean;
  /** Runs of the judge so far, and the last verdict. */
  judges: number;
  verdict?: MentorVerdict;
  /** Probing questions graded in the defence, and how many finish it. */
  probes: { done: number; needed: number };
  /** Set once the attempt is done. */
  result?: MentorResult;
}

export interface MentorResult {
  /** 0..1, as the rating sees the attempt. */
  score: number;
  deltas: { skill: MentorSkill; before: number; after: number }[];
  revealed: boolean;
}

export type MentorCardBody =
  | { type: "verdict"; verdict: MentorVerdict }
  | { type: "result"; result: MentorResult; streak: number };

export interface MentorRank {
  name: string;
  /** A CSS colour token name the UI maps to a colour. */
  tone: "gray" | "green" | "cyan" | "blue" | "violet" | "gold" | "red";
  min: number;
}

/** Codeforces-like tiers, named after stars. */
export const MENTOR_RANKS: readonly MentorRank[] = [
  { name: "Bụi sao", tone: "gray", min: 0 },
  { name: "Tinh vân", tone: "green", min: 1200 },
  { name: "Sao lùn", tone: "cyan", min: 1400 },
  { name: "Sao chính", tone: "blue", min: 1600 },
  { name: "Sao khổng lồ", tone: "violet", min: 1900 },
  { name: "Siêu khổng lồ", tone: "gold", min: 2100 },
  { name: "Siêu tân tinh", tone: "red", min: 2400 },
];

export function mentorRank(rating: number): MentorRank {
  let rank = MENTOR_RANKS[0]!;
  for (const r of MENTOR_RANKS) if (rating >= r.min) rank = r;
  return rank;
}

export type MentorStarState = "locked" | "open" | "learning" | "mastered";

export interface MentorStarView {
  id: string;
  name: string;
  constellation: string;
  /** Position on the map, 0..100 on both axes. */
  x: number;
  y: number;
  /** Stars to learn first (lines on the map). */
  after: string[];
  state: MentorStarState;
  exercises: { id: string; title: string; difficulty: number; minutes: number; done: boolean }[];
}

export interface MentorConstellation {
  id: string;
  name: string;
  /** The paper that closes it (reproduced in a later phase). */
  paper?: string;
  stars: string[];
  mastered: number;
}

export interface MentorToday {
  exerciseId: string;
  title: string;
  star: string;
  minutes: number;
  difficulty: number;
  /** Why this one: a diagnostic session, an exercise to redo after seeing the solution, one left unfinished, or the next on the map. */
  reason: "diagnostic" | "redo" | "continue" | "next";
  /** For `continue`: the open attempt. */
  attemptId?: string;
}

export interface MentorEnv {
  python?: { path: string; version: string };
  modules: Record<string, boolean>;
  /** Why Python could not be checked. */
  error?: string;
  /** A command that installs what is missing. */
  install?: string;
}

export interface MentorHome {
  workDir: string;
  today: MentorToday | null;
  streak: { current: number; best: number; freezes: number; doneToday: boolean };
  /** Active days of the last 16 weeks, oldest first ("YYYY-MM-DD"). */
  heatmap: { day: string; count: number }[];
  skills: { skill: MentorSkill; label: string; rating: number | null; games: number }[];
  overall: number | null;
  stars: MentorStarView[];
  constellations: MentorConstellation[];
  diagnostic: { done: number; total: number; weakest: MentorSkill[] };
  recent: { attemptId: string; exerciseId: string; title: string; at: number; stage: MentorStage; score?: number; revealed: boolean }[];
  /** Rating after each finished attempt, oldest first. */
  history: { at: number; overall: number }[];
}
