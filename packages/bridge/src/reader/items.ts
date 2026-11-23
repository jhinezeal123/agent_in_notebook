// What the hidden author writes for a paper (E.4.2, E.6): the paper's map
// (map.json: paragraph roles, the reference 5C, concepts, notation,
// background, pretest, and for a PDF the units of pass 2), and a unit's
// checkpoint (items/<unit>.json: the question to read it for, its key points,
// a place to explain, figures, tables to guess, a QALMRI sheet, questions).
// The schemas the author's tools check against, the questions as the tab sees
// them (options shuffled, no answer until answered), and the grading of an
// answer. Pure.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  READER_BLOOMS,
  readerPoints,
  type ReaderAnswerResult,
  type ReaderBloom,
  type ReaderChoice,
  type ReaderFiveC,
  type ReaderItemView,
  type ReaderPretestView,
  type ReaderQalmriKey,
  type ReaderRole,
} from "@ainb/protocol";
import type { ReaderAnswer } from "./model.js";

const text = (max: number) => z.string().trim().min(1).max(max);

export const EvidenceSchema = z.object({
  anchor: text(120).describe("The id of the paragraph, equation, figure or table the words are in, as paper_read shows them in brackets (\"S4.SS1.p2\")"),
  quote: z.string().trim().min(12).max(600).describe("The paper's exact words (one sentence or a clause, ≥ 5 words), copied from paper_read"),
});

const OptionSchema = z.object({
  text: text(400),
  correct: z.boolean(),
  why: z.string().trim().max(500).default("").describe("For a wrong option: the misconception it stands for (why someone would pick it). For the right one: why it is right."),
});

export const ITEM_KINDS = ["mcq", "multi", "twotier", "numeric", "order", "match"] as const;

export const ItemSchema = z.object({
  concept: text(60).describe("The id of the concept it checks (from the map's concepts)"),
  bloom: z.enum(READER_BLOOMS as unknown as [ReaderBloom, ...ReaderBloom[]]),
  kind: z.enum(ITEM_KINDS),
  stem: text(1500).describe("The question, in Vietnamese (terms in English), Markdown with $TeX$; positive, holding the main idea"),
  options: z.array(OptionSchema).max(6).optional().describe("mcq, twotier: 3 (at most 4), exactly one right. multi: 3–5, at least one right and one wrong"),
  reasons: z.array(OptionSchema).max(4).optional().describe("twotier: why the answer is right: 3–4 reasons, exactly one right, the others common misconceptions"),
  numeric: z.object({ value: z.number().finite(), tolerance: z.number().min(0).finite(), measure: z.string().trim().max(30).optional() }).optional().describe("numeric: the value and how far off still counts"),
  steps: z.array(text(300)).max(7).optional().describe("order: 3–7 steps, in the right order (the tab shuffles them)"),
  pairs: z.array(z.object({ left: text(200), right: text(200) })).max(6).optional().describe("match: 3–6 pairs (symbol ↔ meaning), the right one of each"),
  evidence: z.array(EvidenceSchema).min(1).max(4),
  explain: text(1500).describe("Shown after the answer: why the right one is right, with [[anchor]] citations"),
  difficulty: z.number().int().min(1).max(5).default(3),
});

export type ItemInput = z.infer<typeof ItemSchema>;

/** A question as kept: the author's, with its id and unit, and the checker's word on it. */
export interface ReaderItem extends ItemInput {
  id: string;
  unit: string;
  /** The author's level, when the checker put it elsewhere (bloom is the checker's). */
  authorBloom?: ReaderBloom;
  /** Not solved blind by the checker (it could not run). */
  unchecked?: true;
}

export const PretestSchema = z.object({
  section: text(120).describe("The section whose reading answers it (its id)"),
  stem: text(800),
  options: z.array(OptionSchema).max(4).optional().describe("For one of the questions: 3 options whose wrong ones are other ideas from the paper itself"),
  answer: text(800).describe("The answer, shown once the section is read"),
  explain: text(1200),
  evidence: z.array(EvidenceSchema).min(1).max(3),
});

export type PretestInput = z.infer<typeof PretestSchema>;
export type ReaderPretest = PretestInput & { id: string };

const ROLES = ["objective", "contribution", "method", "result", "limitation"] as const satisfies readonly ReaderRole[];
const fiveC = { category: text(600), context: text(600), correctness: text(600), contributions: text(600), clarity: text(600) } satisfies Record<ReaderFiveC, unknown>;
const qalmri = { question: text(500), alternatives: text(500), logic: text(500), method: text(500), result: text(500), inference: text(500) } satisfies Record<ReaderQalmriKey, unknown>;

/** The map's parts: each can be written on its own (the tab shows what is done). */
export const MapSchema = z.object({
  roles: z.array(z.object({ anchor: text(120).describe("A paragraph id"), role: z.enum(ROLES) })).min(3).max(60).optional()
    .describe("The paragraphs that state the paper's objective, contributions, method, results and limitations (not every paragraph: the ones worth reading when skimming)"),
  fivec: z.object(fiveC).optional().describe("The reference five Cs, 1–3 sentences each, in Vietnamese with [[anchors]]"),
  concepts: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).describe("kebab-case"), name: text(80), anchor: z.string().trim().max(120).optional() })).min(3).max(20).optional()
    .describe("The paper's key concepts, each where the paper defines or introduces it"),
  notation: z.array(z.object({ symbol: text(80).describe("TeX"), meaning: text(300).describe("Vietnamese, short"), shape: z.string().trim().max(80).optional(), anchor: z.string().trim().max(120).optional() })).min(1).max(50).optional()
    .describe("The symbols and terms the reader meets, in the order they come"),
  background: z.array(z.object({ name: text(100), why: text(300), explain: text(1200), link: z.string().trim().url().max(400).optional() })).max(10).optional()
    .describe("What the reader should know before (\"rank of a matrix\"): why it is needed here, a short explanation, and an easier source than the paper when there is one"),
  pretest: z.array(PretestSchema).min(2).max(4).optional().describe("3 questions on the ideas the paper is about to make, asked before reading"),
  units: z.array(z.object({ title: text(200), sections: z.array(text(120)).min(1).max(80) })).min(1).max(20).optional()
    .describe("A PDF only: the paper's sections as page ranges (\"page-3\"…), in order, to read and check one by one"),
});

export type MapInput = z.infer<typeof MapSchema>;
export type ReaderMapPartName = keyof MapInput;

export interface ReaderUnitDef {
  id: string;
  title: string;
  number?: string;
  /** Its sections, subsections included. */
  sections: string[];
}

export interface ReaderMap {
  roles?: MapInput["roles"];
  fivec?: MapInput["fivec"];
  concepts?: MapInput["concepts"];
  notation?: MapInput["notation"];
  background?: MapInput["background"];
  pretest?: ReaderPretest[];
  units?: ReaderUnitDef[];
  at: number;
}

export const PackSchema = z.object({
  unit: text(120).describe("The unit's id"),
  guide: text(400).describe("One question to read the unit for (\"Đọc mục này để trả lời: vì sao B được khởi tạo bằng 0?\")"),
  points: z.array(z.object({ text: text(500), anchor: text(120) })).min(2).max(6).describe("The unit's key points, each with where the paper says it (to grade the reader's recall)"),
  explain: z.object({
    anchor: text(120).describe("An equation or paragraph id"),
    prompt: text(500).describe("\"Dòng này làm gì, vì sao cần?\" about one key line or step"),
    rubric: z.array(text(300)).min(1).max(5).describe("What a good explanation says (the why, not a restatement)"),
    misconceptions: z.array(text(300)).max(5).optional(),
  }).optional(),
  figures: z.array(z.object({ id: text(120), questions: z.array(text(300)).max(3).default([]), message: text(500).describe("The figure's main message in one sentence") })).max(6).default([]),
  predicts: z.array(z.object({ id: text(120).describe("A results table's id"), question: text(400).describe("What to guess before its numbers are shown"), answer: text(600) })).max(3).default([]),
  qalmri: z.object(qalmri).optional().describe("A unit that reports an experiment: the reference QALMRI sheet"),
  light: z.string().trim().max(300).optional().describe("A unit with no checkpoint questions (related work, conclusion): why"),
  items: z.array(ItemSchema).max(8),
});

export type PackInput = z.infer<typeof PackSchema>;

export interface ReaderPack extends Omit<PackInput, "items"> {
  items: ReaderItem[];
  /** The checker solved its questions blind. */
  checked: boolean;
  at: number;
}

/** A question's id: from its unit and words, so the same question keeps its answers. */
export function itemId(unit: string, item: Pick<ItemInput, "kind" | "stem">): string {
  return `q-${createHash("sha1").update(`${unit}\u0000${item.kind}\u0000${item.stem.replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 10)}`;
}

export function pretestId(p: Pick<PretestInput, "stem">): string {
  return `pre-${createHash("sha1").update(p.stem.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 10)}`;
}

/** A fixed shuffle for an id: shown index → the author's index. Never the author's order when there is another. */
export function shuffled(id: string, n: number, salt = ""): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = createHash("sha1").update(`${id}\u0000${salt}`).digest().readUInt32LE(0);
  const next = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  if (n > 1 && order.every((v, i) => v === i)) order.push(order.shift()!);
  return order;
}

interface Shown {
  options?: number[];
  reasons?: number[];
  steps?: number[];
  rights?: number[];
}

function shownOrder(item: ReaderItem): Shown {
  return {
    ...(item.options ? { options: shuffled(item.id, item.options.length, "o") } : {}),
    ...(item.reasons ? { reasons: shuffled(item.id, item.reasons.length, "r") } : {}),
    ...(item.steps ? { steps: shuffled(item.id, item.steps.length, "s") } : {}),
    ...(item.pairs ? { rights: shuffled(item.id, item.pairs.length, "m") } : {}),
  };
}

/** A question as the tab shows it, before it is answered. */
export function itemView(item: ReaderItem): ReaderItemView {
  const o = shownOrder(item);
  return {
    id: item.id, unit: item.unit, concept: item.concept, bloom: item.bloom, kind: item.kind, stem: item.stem, difficulty: item.difficulty,
    ...(o.options ? { options: o.options.map((i) => item.options![i]!.text) } : {}),
    ...(o.reasons ? { reasons: o.reasons.map((i) => item.reasons![i]!.text) } : {}),
    ...(o.steps ? { steps: o.steps.map((i) => item.steps![i]!) } : {}),
    ...(item.pairs ? { lefts: item.pairs.map((p) => p.left), rights: o.rights!.map((i) => item.pairs![i]!.right) } : {}),
    ...(item.kind === "numeric" && item.numeric?.measure ? { measure: item.numeric.measure } : {}),
  };
}

/** The right answer, as indices into what the tab shows. */
export function rightChoice(item: ReaderItem): ReaderAnswerResult["right"] {
  const o = shownOrder(item);
  switch (item.kind) {
    case "mcq":
    case "multi":
      return { options: o.options!.flatMap((orig, shown) => (item.options![orig]!.correct ? [shown] : [])) };
    case "twotier":
      return {
        options: o.options!.flatMap((orig, shown) => (item.options![orig]!.correct ? [shown] : [])),
        reason: o.reasons!.findIndex((orig) => item.reasons![orig]!.correct),
      };
    case "numeric":
      return { value: item.numeric!.value, tolerance: item.numeric!.tolerance };
    case "order":
      return { steps: item.steps!.map((_, k) => o.steps!.indexOf(k)) };
    case "match":
      return { pairs: item.pairs!.map((_, i) => o.rights!.indexOf(i)) };
  }
}

/** Whether a choice is right (a twotier: both tiers; `partly` when one of them is). */
export function gradeChoice(item: ReaderItem, choice: ReaderChoice): { correct: boolean; partly?: boolean } {
  const right = rightChoice(item);
  const same = (a: number[] | undefined, b: number[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  const set = (a: number[] | undefined) => [...new Set(a ?? [])].sort((x, y) => x - y);
  switch (item.kind) {
    case "mcq":
      return { correct: choice.options?.length === 1 && right.options!.includes(choice.options[0]!) };
    case "multi":
      return { correct: same(set(choice.options), right.options) };
    case "twotier": {
      const answer = choice.options?.length === 1 && right.options!.includes(choice.options[0]!);
      const reason = choice.reason === right.reason;
      return answer && reason ? { correct: true } : { correct: false, ...(answer || reason ? { partly: true } : {}) };
    }
    case "numeric": {
      const v = Number(choice.value);
      return { correct: Number.isFinite(v) && Math.abs(v - right.value!) <= right.tolerance! + 1e-12 };
    }
    case "order":
      return { correct: same(choice.steps, right.steps) };
    case "match":
      return { correct: same(choice.pairs, right.pairs) };
  }
}

/** What an answer showed, for the tab (and the tutor, once answered). */
export function answerResult(item: ReaderItem, a: Pick<ReaderAnswer, "correct" | "partly" | "confidence" | "choice" | "at">): ReaderAnswerResult {
  const o = shownOrder(item);
  return {
    correct: a.correct, ...(a.partly ? { partly: true } : {}), confidence: a.confidence, points: readerPoints(a.correct, a.confidence),
    choice: a.choice, right: rightChoice(item),
    ...(o.options ? { why: o.options.map((i) => item.options![i]!.why) } : {}),
    ...(o.reasons ? { reasonsWhy: o.reasons.map((i) => item.reasons![i]!.why) } : {}),
    explain: item.explain, evidence: item.evidence, at: a.at,
  };
}

/** The misconception a wrong answer shows: the why of the wrong option (or reason) picked. */
export function misconceptionOf(item: ReaderItem, choice: ReaderChoice): string | null {
  const o = shownOrder(item);
  const picked: string[] = [];
  for (const shown of choice.options ?? []) {
    const opt = o.options && item.options![o.options[shown] ?? -1];
    if (opt && !opt.correct && opt.why) picked.push(opt.why);
  }
  if (choice.reason !== undefined && o.reasons) {
    const r = item.reasons![o.reasons[choice.reason] ?? -1];
    if (r && !r.correct && r.why) picked.push(r.why);
  }
  return picked.length ? picked.join(" · ").slice(0, 400) : null;
}

/** A pretest question for the tab: the answer only once it is open. */
export function pretestView(p: ReaderPretest, guess: { option?: number; text?: string } | undefined, open: boolean): ReaderPretestView {
  const order = p.options ? shuffled(p.id, p.options.length, "o") : undefined;
  return {
    id: p.id, section: p.section, stem: p.stem,
    ...(order ? { options: order.map((i) => p.options![i]!.text) } : {}),
    ...(guess ? { guess: { ...(guess.option !== undefined ? { option: guess.option } : {}), ...(guess.text ? { text: guess.text } : {}) } } : {}),
    ...(open ? { answer: { ...(order ? { right: order.findIndex((i) => p.options![i]!.correct) } : {}), text: p.answer, explain: p.explain, evidence: p.evidence } } : {}),
  };
}
