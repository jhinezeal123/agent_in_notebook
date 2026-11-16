// The tools of a Mentor chat: a few of the notebook tools (run scratch code,
// look at the kernel) and mentor_* tools for what only the agent can judge.
// None of them changes the learner's notebook.

import { z } from "zod";
import { MENTOR_STAGE_LABEL } from "@ainb/protocol";
import { Denied, TOOLS, tool, type ToolContext, type ToolDef } from "../notebook/tools.js";
import { learnerCells } from "./prompt.js";
import { StageRefused, type MentorSession } from "./session.js";

export interface MentorToolContext extends ToolContext {
  mentor: MentorSession;
}

/** Notebook tools a Mentor chat keeps: none of them edits a cell or touches files. */
const KEPT = new Set(["kernel_state", "read_output", "run_code", "wait_for_code", "interrupt_kernel"]);

const refused = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StageRefused) throw new Denied(e.message);
    throw e;
  }
};

export const MENTOR_TOOLS = [
  tool<z.ZodObject<{}>, MentorToolContext>({
    name: "mentor_read_cells",
    description: "The learner's sketch and solution cells as they are now (the exercise's notebook).",
    schema: z.object({}),
    async run(ctx) {
      const { cells } = await ctx.call({ op: "get_cells" });
      return { text: learnerCells(cells) };
    },
  }),
  tool({
    name: "mentor_stage",
    description:
      'Move the exercise to its next step: "build" once the learner has explained the formula and answered the trap questions; ' +
      '"done" once enough probing answers are graded. The defence starts by itself when the judge passes.',
    schema: z.object({ stage: z.enum(["build", "done"]) }),
    async run(ctx: MentorToolContext, a) {
      refused(() => ctx.mentor.setStage(a.stage, "agent"));
      return { text: `The exercise is now at ${MENTOR_STAGE_LABEL[a.stage]} (${a.stage}).${a.stage === "done" ? " The learner sees their result; wrap up in two lines." : ""}` };
    },
  }),
  tool({
    name: "mentor_probe_result",
    description: "Grade the learner's answer to one probing question of the defence: 2 right, 1 partly right, 0 wrong.",
    schema: z.object({
      question: z.string().min(1).describe("The question you asked, short."),
      grade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      tag: z.string().optional().describe("The misconception tag from the question bank, when the answer shows one."),
    }),
    async run(ctx: MentorToolContext, a) {
      refused(() => ctx.mentor.probe(a.grade, a.question, a.tag));
      const s = ctx.mentor.attempt;
      const left = ctx.mentor.exercise.probes - s.probes.length;
      return { text: left > 0 ? `Recorded. ${left} more to grade before the exercise can be done.` : 'Recorded. Enough answers are graded: call mentor_stage with "done" when the defence is over.' };
    },
  }),
  tool({
    name: "mentor_misconception",
    description: "Record a misconception the learner showed, so it comes back in later sessions.",
    schema: z.object({ tag: z.string().min(1).describe("Short tag, from the question bank when one fits."), note: z.string().min(1).describe("What they believe, in one sentence.") }),
    async run(ctx: MentorToolContext, a) {
      ctx.mentor.misconception(a.tag, a.note);
      return { text: "Recorded." };
    },
  }),
] as unknown as ToolDef<z.ZodType, MentorToolContext>[];

export const MENTOR_CHAT_TOOLS: readonly ToolDef<z.ZodType, any>[] = [...TOOLS.filter((t) => KEPT.has(t.name)), ...MENTOR_TOOLS];
