// The checker (E.4.3, E.6 checks 3 and 4): a fresh hidden chat that never
// sees the answers. It gets a batch of questions with the paper's passages
// their evidence is in, solves them blind, says how high on Bloom's scale each
// one is and whether another option could also be right. A question it
// answers otherwise goes back to the author; its level replaces the author's.

import { z } from "zod";
import { READER_BLOOMS, type ReaderBloom, type ReaderChoice } from "@ainb/protocol";
import type { ChatPort, ChatRole, RoleTurn } from "../chat-role.js";
import { callTool, tool, type ToolContext, type ToolDef, type ToolResult } from "../notebook/tools.js";
import { READER_SETTINGS } from "./chat.js";
import type { ReaderHub } from "./index.js";
import { gradeChoice, itemView, type ReaderItem } from "./items.js";
import { READER_TOOLS, type ReaderToolContext, type ReaderToolHost } from "./tools.js";

export interface CheckAnswer {
  id: string;
  options?: string[];
  reason?: string;
  value?: number;
  steps?: number[];
  pairs?: string[];
  bloom: ReaderBloom;
  alsoRight?: string[];
  note: string;
}

export interface CheckVerdict {
  ok: boolean;
  bloom: ReaderBloom;
  /** What the checker answered and said, for the author. */
  said: string;
}

const LETTERS = "ABCDEFGH";
const PASSAGE_MAX = 1800;

/** The checker's answer as a choice the question can grade (letters and 1-based steps to shown indices). */
export function choiceOf(item: ReaderItem, a: CheckAnswer): ReaderChoice {
  const letter = (s: string | undefined) => (s ? LETTERS.indexOf(s.trim().toUpperCase().slice(0, 1)) : -1);
  switch (item.kind) {
    case "mcq":
    case "multi":
      return { options: (a.options ?? []).map(letter).filter((i) => i >= 0) };
    case "twotier":
      return { options: (a.options ?? []).map(letter).filter((i) => i >= 0).slice(0, 1), ...(a.reason !== undefined ? { reason: letter(a.reason) } : {}) };
    case "numeric":
      return a.value !== undefined ? { value: a.value } : {};
    case "order":
      return { steps: (a.steps ?? []).map((n) => n - 1) };
    case "match":
      return { pairs: (a.pairs ?? []).map(letter) };
  }
}

/** Whether the checker, blind, agrees with the author: the same answer, and no other option also right. */
export function verdictOf(item: ReaderItem, a: CheckAnswer | undefined): CheckVerdict {
  if (!a) return { ok: false, bloom: item.bloom, said: "the checker gave no answer to it" };
  const { correct } = gradeChoice(item, choiceOf(item, a));
  const also = (a.alsoRight ?? []).filter((l) => LETTERS.includes(l.trim().toUpperCase().slice(0, 1)));
  const answered = item.kind === "numeric" ? String(a.value) : item.kind === "order" ? (a.steps ?? []).join("→") : [...(a.options ?? []), ...(a.reason ? [`reason ${a.reason}`] : []), ...(a.pairs ?? [])].join(", ");
  return {
    ok: correct && !also.length,
    bloom: READER_BLOOMS.includes(a.bloom) ? a.bloom : item.bloom,
    said: `the checker answered ${answered || "nothing"}${also.length ? `, and said ${also.join(", ")} could also be right` : ""}${a.note ? `: “${a.note.slice(0, 400)}”` : ""}`,
  };
}

/** A batch for the checker: each question as the reader would see it, with the passages of its evidence (never which option is right). */
export function checkerTask(hub: ReaderHub, paperId: string, items: ReaderItem[], withPassages = true): string {
  const doc = withPassages ? hub.doc(paperId) : null;
  const out = ["<reader-check>", withPassages
    ? "Solve each question blind, from its passages (paper_read or paper_find if a symbol needs its definition). Then write all your answers in one reader_check_write call."
    : "Study the provided lesson. Solve each question from the lesson alone; write your answers in one reader_check_write call.", ""];
  for (const item of items) {
    const v = itemView(item);
    out.push(`## ${item.id} (${item.kind})`, v.stem);
    v.options?.forEach((o, i) => out.push(`${LETTERS[i]}. ${o}`));
    if (v.reasons) {
      out.push("Because:");
      v.reasons.forEach((r, i) => out.push(`${LETTERS[i]}. ${r}`));
    }
    v.steps?.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    if (v.lefts) {
      v.lefts.forEach((l, i) => out.push(`${i + 1}. ${l}`));
      v.rights!.forEach((r, i) => out.push(`${LETTERS[i]}. ${r}`));
    }
    if (v.measure) out.push(`(answer in ${v.measure})`);
    if (doc) {
      const blocks = [...new Set(item.evidence.map((e) => e.anchor))].map((id) => doc.blocks.find((b) => b.id === id) ?? doc.blocks.find((b) => b.id === doc.equations.find((q) => q.id === id)?.block)).filter((b) => !!b);
      out.push("Passages:");
      for (const b of blocks) out.push(`[${b!.id}] ${b!.text.length > PASSAGE_MAX ? `${b!.text.slice(0, PASSAGE_MAX)}…` : b!.text}`);
    }
    out.push("");
  }
  out.push("</reader-check>");
  return out.join("\n");
}

function checkerPlaybook(title: string): string {
  return `<reader-checker>
You check questions written about the paper "${title}", for a reader who studies it. You do not know the intended answers. For each question:
1. Solve it yourself from its passages, step by step. Use only what the passages (and the paper) say.
2. Give your answer: options by letter (mcq: one; multi: all that are right; twotier: one option and one reason), a number (numeric), the step numbers in order (order), a letter for each numbered left (match).
3. alsoRight: letters of any other option a careful reader could defend as right from the passages (ambiguity is a defect). Empty when there is none.
4. bloom: the level the question really asks for — remember (recall a fact as stated), understand (explain, compare, restate in other terms), apply (use the idea on a new case: compute, predict), analyze (take apart: why this part, what if it were removed), evaluate (judge a choice or claim with evidence), create (design something new).
5. note: one or two sentences on your reasoning, and anything wrong with the question (two right answers, an answer the passages do not support, a cue that gives it away).
Write every answer in one reader_check_write call. You do not edit anything else.
</reader-checker>`;
}

/** What the checker's tool reaches: its batch's answers are kept here. */
export interface CheckerHost extends ReaderToolHost {
  readonly batch: ReaderItem[];
  record(answers: CheckAnswer[]): void;
}

const checkWrite = tool({
  name: "reader_check_write",
  description: "Write your blind answers to the batch of questions, one entry per question id.",
  schema: z.object({
    answers: z.array(z.object({
      id: z.string().min(1).max(40),
      options: z.array(z.string().max(2)).max(6).optional().describe("Letters of the options you choose"),
      reason: z.string().max(2).optional().describe("twotier: the letter of the reason"),
      value: z.number().finite().optional().describe("numeric"),
      steps: z.array(z.number().int().min(1).max(10)).max(10).optional().describe("order: the step numbers, in the right order"),
      pairs: z.array(z.string().max(2)).max(8).optional().describe("match: a letter for each numbered left, in order"),
      bloom: z.enum(READER_BLOOMS as unknown as [ReaderBloom, ...ReaderBloom[]]),
      alsoRight: z.array(z.string().max(2)).max(6).optional(),
      note: z.string().max(1000).default(""),
    })).min(1).max(12),
  }),
  async run(ctx: ReaderToolContext & { reader: CheckerHost }, args): Promise<ToolResult> {
    const host = ctx.reader;
    const ids = new Set(host.batch.map((i) => i.id));
    const unknown = args.answers.filter((a) => !ids.has(a.id)).map((a) => a.id);
    const missing = [...ids].filter((id) => !args.answers.some((a) => a.id === id));
    host.record(args.answers.filter((a) => ids.has(a.id)) as CheckAnswer[]);
    return { text: `Recorded ${args.answers.length - unknown.length} answer(s).${unknown.length ? ` Not in the batch: ${unknown.join(", ")}.` : ""}${missing.length ? ` Still to answer: ${missing.join(", ")}.` : " That is all; you are done."}` };
  },
});

const CHECKER_TOOLS: readonly ToolDef<any, any>[] = [READER_TOOLS.find((t) => t.name === "paper_read")!, READER_TOOLS.find((t) => t.name === "paper_find")!, checkWrite];

/** The checker's role in its hidden chat: one batch, then closed. */
export class ReaderCheckerRole implements ChatRole, CheckerHost {
  readonly settings = READER_SETTINGS;
  readonly answers = new Map<string, CheckAnswer>();

  constructor(readonly hub: ReaderHub, readonly paperId: string, readonly batch: ReaderItem[], private readonly lessonOnly = false) {}

  attach(_port: ChatPort): () => void {
    return () => {};
  }

  snapshot() {
    return {};
  }

  async prompt(turn: RoleTurn): Promise<string> {
    if (this.lessonOnly) return ["Answer only from the lesson. Use reader_check_write with the displayed option letters, reason letter, number, order, or matches. Do not use outside knowledge.", turn.context, turn.text].filter(Boolean).join("\n\n");
    return [turn.rules ? checkerPlaybook(this.hub.meta(this.paperId).title) : "", turn.recap, turn.context ?? "", turn.text].filter(Boolean).join("\n\n");
  }

  tools(): readonly ToolDef<any, any>[] {
    return this.lessonOnly ? [checkWrite] : CHECKER_TOOLS;
  }

  runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
    return callTool(Object.assign(ctx, { reader: this as CheckerHost }), name, args, this.tools());
  }

  record(answers: CheckAnswer[]): void {
    for (const a of answers) this.answers.set(a.id, a);
  }
}
