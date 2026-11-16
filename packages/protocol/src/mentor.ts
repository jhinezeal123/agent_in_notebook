// Mentor: the learner implements ML building blocks themself in a local
// notebook; the bridge judges the code, the agent coaches and asks questions.
// These are the shapes the bridge, the chat panel and the Mentor home share.

/** The three steps of an exercise, then done. */
export type MentorStage = "lab" | "build" | "defend" | "done";
export const MENTOR_STAGES: readonly MentorStage[] = ["lab", "build", "defend", "done"];

/**
 * What an attempt is: learning the exercise (lab, build, defend), or a spaced
 * review that re-implements it from a blank cell.
 */
export type MentorKind = "learn" | "review";

/** How much of the code the notebook gives: the starter with its docstring, the signatures only, or a blank cell. */
export type MentorScaffold = "full" | "signature" | "blank";

/** Days between spaced reviews: 3, then 10, then 30; after the third the exercise is learnt. */
export const MENTOR_REVIEW_DAYS: readonly number[] = [3, 10, 30];

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
  /** `id`: the test function's name (hints written for a test name it); `name`: what the learner reads. */
  tests: { id?: string; name: string; ok: boolean; message?: string }[];
  /** The learner's cells did not run (a syntax error, an exception at import time), or the judge could not run. */
  error?: string;
  /** Python modules the exercise needs that the kernel does not have. */
  missing?: string[];
  /** What an experiment measured (its tests' t.report). */
  metrics?: { name: string; value: number }[];
}

/** An exercise in a chat: where the learner is, for the panel's stepper and buttons. */
export interface MentorChat {
  attemptId: string;
  exerciseId: string;
  title: string;
  star: string;
  kind: MentorKind;
  /** A variation: the title of the exercise it changes (the lab is a written prediction). */
  variantOf?: string;
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
  /** A component of a paper: which, where in the paper, and whether the mentor wrote it. */
  paper?: { paperId: string; title: string; index: number; total: number; cites?: string; role: "formula" | "component" | "experiment"; ai: boolean };
}

export interface MentorResult {
  /** 0..1, as the rating sees the attempt. */
  score: number;
  deltas: { skill: MentorSkill; before: number; after: number }[];
  revealed: boolean;
  /** For a review: days to the next one, or null once the exercise is learnt. */
  nextReview?: number | null;
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
  /** 0 while its reviews are on time, up to 1 as one goes overdue: the star dims. */
  fade: number;
  exercises: { id: string; title: string; difficulty: number; minutes: number; done: boolean; variant?: boolean }[];
}

export interface MentorConstellation {
  id: string;
  name: string;
  /** map: on the star map; paper: a paper's own small constellation (on the paper shelf); topic: a topic pack's own small map, under the star map. */
  kind: "map" | "paper" | "topic";
  /** A topic's line of description. */
  description?: string;
  /** false: its exercises are not offered as today's exercise unless it is the focus. */
  daily?: boolean;
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
  /** Why this one: a diagnostic session, an exercise to redo after seeing the solution, one left unfinished, the next on the map, or a spaced review. */
  reason: "diagnostic" | "redo" | "continue" | "next" | "review" | "variant" | "paper" | "focus";
  kind: MentorKind;
  /** For a review: days past its due day (0 = due today). */
  overdue?: number;
  /** For `continue`: the open attempt. */
  attemptId?: string;
  /** The notebook open in Chrome that holds the open attempt now. */
  place?: { tabId: number; title: string };
}

/** A misconception the learner showed, in the "Sổ lỗi sai", and when it is asked again. */
export interface MentorMistake {
  tag: string;
  note: string;
  exerciseId: string;
  title: string;
  /** Times it showed (in answers or in recalls). */
  seen: number;
  /** Right answers in a row when asked again; two make it solid. */
  streak: number;
  status: "due" | "waiting" | "solid";
  /** The day it is asked again ("YYYY-MM-DD"); absent once solid. */
  due?: string;
}

/**
 * A notebook open in Chrome (Kaggle, Colab) that an exercise can be put in:
 * the bridge writes the exercise's cells into it, and the learner works in
 * VS Code's copy of it.
 */
export interface MentorPlace {
  /** The Chrome tab. */
  tabId: number;
  title: string;
  platform: string;
  kernel: string;
  key: string;
  /** The Mentor exercise it holds now. */
  holds?: { attemptId: string; exerciseId: string; title: string; kind: MentorKind; done: boolean };
  /** Non-empty cells that are not a Mentor exercise's (the learner's own work): replacing them needs a yes. */
  foreignCells: number;
  /** The paper it is the workshop of. */
  workshop?: { paperId: string; title: string };
}

/** What Mentor follows for "today's exercise", besides the map. */
export interface MentorFocus {
  kind: "paper" | "constellation";
  id: string;
  title: string;
}

export type MentorPaperStatus = "reading" | "planning" | "authoring" | "ready" | "learning" | "done" | "archived";
export type MentorComponentStatus = "planned" | "authoring" | "failed" | "ready" | "learning" | "done";

/** One part of a paper's reproduction plan. */
export interface MentorPaperComponent {
  /** The exercise, once there is one. */
  exerciseId?: string;
  slug: string;
  title: string;
  role: "formula" | "component" | "experiment";
  /** build: the learner writes it; given: code given with the paper. */
  mode: "build" | "given";
  cites?: string;
  minutes?: number;
  difficulty?: number;
  status: MentorComponentStatus;
  /** Why it failed to be written, or what the author is doing. */
  note?: string;
  uses: string[];
}

/** A paper on the shelf: a landmark that closes a constellation, or one the learner brought. */
export interface MentorPaper {
  id: string;
  title: string;
  authors?: string;
  year?: number;
  url?: string;
  origin: "curated" | "yours";
  /** The map constellation a landmark paper closes. */
  closes?: string;
  status: MentorPaperStatus;
  goal?: string;
  components: MentorPaperComponent[];
  /** The paper's numbers next to the learner's (an experiment's measured ones). */
  results: { name: string; paper?: string; yours?: number; unit?: string }[];
  notes?: string;
  /** The notebook open in Chrome that is its workshop. */
  place?: { tabId: number; title: string };
}

/** The reproduction plan the mentor proposes for a paper, and the learner approves. */
export interface MentorPaperPlan {
  title: string;
  authors?: string;
  year?: number;
  goal: string;
  /** Star ids worth knowing first. */
  requires: string[];
  components: {
    slug: string;
    title: string;
    role: "formula" | "component" | "experiment";
    mode: "build" | "given";
    cites: string;
    why: string;
    /** Signatures with shapes: the interface the whole chain keeps. */
    functions: string[];
    uses: string[];
    minutes: number;
    difficulty: number;
    skills: MentorSkill[];
  }[];
  experiment: {
    dataset: string;
    device: "cpu" | "gpu";
    trainMinutes: number;
    metrics: { name: string; paper: string; where: string; target: { op: ">=" | "<="; value: number } }[];
  };
  /** What the workshop's machine has (checked when the plan was given). */
  machine?: { gpu: boolean; internet: boolean; torch?: string | null };
  /** Learning sessions the plan takes. */
  sessions?: number;
}

/** A paper's workshop: the chat that reads it, plans it, and has its exercises written. */
export interface MentorWorkshop {
  paperId: string;
  title: string;
  status: "reading" | "planning" | "authoring" | "ready";
  plan?: MentorPaperPlan;
  approved: boolean;
  authoring?: { done: number; total: number; failed: number; current?: string; note?: string; running: boolean };
}

export interface MentorHome {
  today: MentorToday | null;
  /** A spaced review to do first (a short warm-up), when one is due. */
  warmup: MentorToday | null;
  /** Reviews due today or overdue, and the next ones. */
  reviews: { due: number; upcoming: { exerciseId: string; title: string; day: string }[] };
  /** The misconception book, the ones to ask again first. */
  mistakes: MentorMistake[];
  streak: { current: number; best: number; freezes: number; doneToday: boolean };
  /** Active days of the last 16 weeks, oldest first ("YYYY-MM-DD"). */
  heatmap: { day: string; count: number }[];
  skills: { skill: MentorSkill; label: string; rating: number | null; games: number }[];
  overall: number | null;
  stars: MentorStarView[];
  constellations: MentorConstellation[];
  diagnostic: { done: number; total: number; weakest: MentorSkill[] };
  recent: { attemptId: string; exerciseId: string; title: string; kind: MentorKind; at: number; stage: MentorStage; score?: number; revealed: boolean }[];
  /** Rating after each finished attempt, oldest first. */
  history: { at: number; overall: number }[];
  /** The paper shelf. */
  papers: MentorPaper[];
  focus: MentorFocus | null;
}
