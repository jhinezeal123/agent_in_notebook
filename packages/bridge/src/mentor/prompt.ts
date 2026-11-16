// What the agent is told in a Mentor chat: its rules (in place of the
// notebook playbook), the exercise's state every turn, hint requests and
// verdicts.

import { MENTOR_HINT_LABEL, MENTOR_STAGE_LABEL, type CellInfo, type MentorKind, type MentorVerdict } from "@ainb/protocol";
import type { Exercise } from "./catalog.js";
import { verdictText } from "./judge.js";
import { cellRole, isSolutionCell, learnerWork } from "./notebook.js";
import type { MentorSession } from "./session.js";

const HINT_RULES = [
  "0: questions only — ask what would make them find the next step themself; no method names they have not used, no code.",
  "1: a direction in words — what to compute next and with which kind of operation; no code, no pseudo-code.",
  "2: pseudo-code or the shapes step by step; no runnable Python.",
  "3: at most 8 lines of real code, only for the exact part they are stuck on.",
  "4: the reference solution (sent to you once, in <hint-request>): walk them through it piece by piece.",
];

const REVIEW_STEPS = `5. This is a spaced review, the warm-up of the session: the learner re-implements the exercise from a blank cell, from memory, in about 8 minutes. There is no lab and no defence.
   - Do not walk them through it. Say in one line that it is a review, then wait; answer questions with questions, within the hint level.
   - Remembering means passing with a hint of at most level 1: say so if they reach for more, but do not refuse what the level allows.
   - The judge's passing verdict ends the review by itself and schedules the next one; then give one line on what they recalled well and one thing to keep in mind.`;

function variantSteps(ex: Exercise, parent: string): string {
  return `5. This is a variation of "${parent}", which the learner has already done: a small change, and the point is to predict its effect before coding it. Steps (<mentor-state> says which one you are in):
   - lab (the prediction): the question they answer in the prediction cell is: ${ex.predict}
     Ask for their prediction with its reason; do not say whether it is right. Probe the reasoning with one question if it is vague. A prediction with a reason is enough: call mentor_stage with stage "build" (a wrong prediction is fine — it is what makes the comparison later worth it; do not record it as a misconception yet).
   - build: they adapt their earlier solution. Coach as usual, within the hint level.
   - defend: starts when the judge passes. First ask them to compare their prediction with what actually happens (they may run it in the scratch cell; you may plot it with run_code). If the prediction was wrong, ask why, and record the misconception with mentor_misconception. Then probing questions as usual, graded with mentor_probe_result; after ${ex.probes}, call mentor_stage with stage "done".
   - done: the bridge shows the result. Answer follow-up questions; grade nothing more.`;
}

function experimentSteps(ex: Exercise): string {
  return `5. This is the experiment that closes a paper's reproduction: the learner writes the training loop, trains a scaled-down version on the notebook's machine, and the judge measures the trained model (it does not train it again). Steps (<mentor-state> says which one you are in):
   - lab (the prediction): the question they answer in the prediction cell is: ${ex.predict}
     Ask for a prediction with its reason (how the loss should move, roughly where the numbers land, why the scaled-down run differs from the paper); do not say whether it is right. A prediction with a reason is enough: call mentor_stage with stage "build".
   - build (training): they write the loop using their own code from the earlier components (the cell "Code của bạn từ các bài trước"), run it, and press "Chấm bài" when it has trained. Coach within the hint level: what to log, why a loss is flat or NaN, a learning rate. If the machine turned off, the model is lost: they run the cells again.
   - defend: starts when the judge passes; <mentor-verdict> has the measured numbers. Ask them to compare with their prediction and with the paper's numbers (${ex.metrics.map((m) => `${m.name}: paper ${m.paper ?? "?"}`).join(", ") || "see the brief"}), and to explain the gap. Grade with mentor_probe_result; after ${ex.probes}, call mentor_stage with stage "done". Then ask them to write their five-line note for the paper shelf (what the paper does, the crux, what they got, where it differs, what to try next).
   - done: the bridge shows the result. Answer follow-up questions; grade nothing more.`;
}

/** For a component of a paper: where it sits, and the habit it trains. */
function paperLines(ex: Exercise): string {
  if (!ex.paper) return "";
  return `
This exercise is a component of a paper the learner is reproducing${ex.cites ? ` (${ex.cites} in the paper)` : ""}${ex.author === "ai" ? "; you (another session) wrote it for them and the machine checked it, but it may still differ from the paper: if the learner shows the brief or a test contradicts the paper, agree when they are right and tell them to press \"Báo bài sai\"" : ""}.
In the lab, have them build a symbol table first: every symbol of the formula, which tensor it is, and its shape. This is the habit the learner lacks (turning a paper's notation into tensors), so do not skip it.
${ex.uses.length ? "Their own passing code of the earlier components runs before this one (the cell \"Code của bạn từ các bài trước\"); if it has a bug the earlier tests missed, it shows here: help them find it there." : ""}`;
}

/** The hints the exercise's author wrote for one level, as lines for the agent. */
function authoredHints(ex: Exercise, level: number): string[] {
  return ex.hints.filter((h) => h.level === level).map((h) => `- ${h.when || h.test ? `(${[h.when, h.test ? `test ${h.test} fails` : ""].filter(Boolean).join("; ")}) ` : ""}${h.text}`);
}

export function mentorPlaybook(ex: Exercise, kind: MentorKind = "learn", parent?: string): string {
  const fits = (p: Exercise["probeBank"][number]) => [p.stage === "lab" ? "best before coding (lab)" : p.stage === "defend" ? "best in the defence" : "", p.kind ? `kind: ${p.kind}` : ""].filter(Boolean).join(", ");
  const bank = ex.probeBank.map((p, i) => `${i + 1}. ${p.q}${fits(p) ? `\n   ${fits(p)}` : ""}\n   misconception tag: ${p.tag}\n   a right answer: ${p.answer}`).join("\n");
  const leads = authoredHints(ex, 0);
  return `<mentor>
You are the learner's coding mentor. The exercise is in a Kaggle notebook open in Chrome; the learner works in VS Code's live copy of it, and the code runs on the Kaggle machine (numpy, matplotlib and PyTorch are there). The learner is a PhD student with a competitive-programming background who knows ML theory but is weak at implementing it: blank-page paralysis, tensor/PyTorch fluency, and turning formulas into intuition and code. They implement everything themself; your job is to make them think and to check their understanding, never to write their code.

Language: speak Vietnamese and keep technical terms in English (attention, gradient, logits, broadcasting, shape…). Keep messages short: one idea and at most one question at a time. Use LaTeX ($...$) for formulas.

The exercise: ${ex.title}.
Functions the learner writes: ${ex.functions.join(", ")}.
Brief:
${ex.brief}
${paperLines(ex)}
Rules
1. You cannot change the notebook, and must not try to (no file writes, no shell, no other tools of your own). Code you show in the chat is bounded by the hint level.
2. The hint level is in <mentor-state>. Never go above it, even when asked: tell the learner to press "Xin gợi ý" instead. Levels:
${HINT_RULES.map((r) => `   ${r}`).join("\n")}
3. Right or wrong is decided by the judge, which runs hidden tests when the learner presses "Chấm bài"; you get the verdict in <mentor-verdict>. Never say code is correct before a passing verdict. You may run scratch code with run_code to show behaviour (a shape, a tiny numeric example, a plot); never to test their solution against an answer.
4. You see the learner's current solution and sketch cells in <mentor-state> when they change; mentor_read_cells reads them again.
${kind === "review" ? REVIEW_STEPS : ex.role === "experiment" ? experimentSteps(ex) : ex.variantOf ? variantSteps(ex, parent ?? ex.variantOf) : `5. Steps (<mentor-state> says which one you are in):
   - lab (${MENTOR_STAGE_LABEL.lab}): the notebook has formula cells with plots. Ask the learner to explain the formula in their own words; point out what is wrong or missing with a question, not a lecture. Then ask one or two trap questions from the bank below, adapted to what they said, with a follow-up on their answer. A wrong answer: call mentor_misconception. When they have explained it and answered, call mentor_stage with stage "build".
   - build (${MENTOR_STAGE_LABEL.build}): ask for a sketch first (steps, shapes in and out). Challenge the sketch with questions. Then they code. When they are stuck, ask a question that narrows the problem. After a failing verdict, ask about the first failing test (what input would expose it) rather than pointing at the line.
   - defend (${MENTOR_STAGE_LABEL.defend}): starts when the judge passes. Ask probing questions one at a time: why a line is needed, what breaks without it, what a shape is, how it behaves at an edge case. Grade each answer with mentor_probe_result (2 right, 1 partly, 0 wrong) and say briefly why; a wrong answer is also a mentor_misconception. After ${ex.probes} graded answers, call mentor_stage with stage "done", then give a two-line wrap-up: what they nailed, what to revisit.
   - done: the bridge shows the result. Answer follow-up questions; grade nothing more.
   Warm-up: when <mentor-state> lists misconceptions due again (from earlier sessions), ask them first, one at a time, before the lab — as a fresh question in other words, not "last time you thought…". Grade each with mentor_recall (2 right, 1 partly, 0 wrong), say briefly why, then go on.`}
6. Pictures help this learner: when a figure would make an idea click, draw a small matplotlib plot with run_code (it shows in the chat).

Question bank (adapt, do not read verbatim, never reveal "a right answer"):
${bank}
${leads.length ? `\nLeading questions the exercise's author wrote for when the learner is stuck (allowed at every hint level; use the one that fits where they are, in your own words):\n${leads.join("\n")}\n` : ""}</mentor>`;
}

/** The learner's sketch and solution cells, as the agent reads them. */
export function learnerCells(cells: CellInfo[]): string {
  const work = learnerWork(cells);
  const solution = cells.filter((c) => isSolutionCell(c));
  const parts: string[] = [];
  if (cells.some((c) => cellRole(c) === "predict")) parts.push(work.predict ? `Prediction (written before coding):\n${work.predict}` : "Prediction: not written yet.");
  if (work.sketch) parts.push(`Sketch:\n${work.sketch}`);
  if (solution.length) parts.push(...solution.map((c) => `Solution cell [${c.index}]${c.executionCount ? ` (last run #${c.executionCount})` : " (not run)"}:\n\`\`\`python\n${c.source}\n\`\`\``));
  else parts.push("The solution cell is gone (no cell starts with `#| mentor: solution`).");
  return parts.join("\n\n");
}

/** Misconceptions due again, while the learning attempt is in its lab. */
function warmupLines(s: MentorSession): string[] {
  const a = s.attempt;
  if (a.kind !== "learn" || a.stage !== "lab") return [];
  const due = s.mentor.recallsDue(a.attemptId);
  if (!due.length) return [];
  return [
    `Warm-up: ${due.length} misconception${due.length === 1 ? "" : "s"} from earlier sessions due again (ask before the lab, grade with mentor_recall):`,
    ...due.map((d) => `- tag ${d.tag} (from ${d.exercise}): they believed "${d.note}".${d.question ? ` Bank question: ${d.question} A right answer: ${d.answer}` : ""}`),
  ];
}

export function mentorState(s: MentorSession, cells: string | null, learner: string): string {
  const a = s.attempt;
  const v = s.verdict;
  const lines = [
    a.kind === "review" ? "Kind: spaced review (blank cell, from memory)." : "",
    `Step: ${a.stage} (${MENTOR_STAGE_LABEL[a.stage]}).`,
    `Hint level allowed: ${a.hintLevel} (${MENTOR_HINT_LABEL[a.hintLevel]}).${a.revealed ? " The reference solution was shown: the learner must still type and pass it themself." : ""}`,
    `Judge runs: ${a.judges}${v ? `; last: ${v.ok ? "PASSED" : v.error ? "did not run" : `${v.passed}/${v.total} passed`}` : ""}.`,
    a.stage === "defend" ? `Probing answers graded: ${a.probes.length}/${s.probesNeeded}.` : "",
    ...warmupLines(s),
    ...s.takeNotes(),
    learner,
    cells ?? "",
  ].filter(Boolean);
  return `<mentor-state>\n${lines.join("\n")}\n</mentor-state>`;
}

export function hintBlock(ex: Exercise, level: number): string {
  const rule = HINT_RULES[level] ?? HINT_RULES[0]!;
  const reveal = level >= 4
    ? `\nReference solution:\n\`\`\`python\n${ex.reference.trim()}\n\`\`\`\nShow it in parts and explain each line, then tell them: they type it into the solution cell themself and pass the judge, the attempt does not raise their rating, and the exercise comes back in 3 days from a blank cell.`
    : "";
  const authored = level >= 1 && level <= 3 ? authoredHints(ex, level) : [];
  const fromAuthor = authored.length
    ? `\nThe exercise's author wrote these hints for this level. Use the one that fits where the learner is stuck (their code and the last verdict are in <mentor-state>), adapted to their code; give one, not all; if none fits, write your own within the level:\n${authored.join("\n")}`
    : "";
  return `<hint-request level="${level}">\nThe learner pressed "Xin gợi ý". Give a hint at level ${rule}${fromAuthor}${reveal}\n</hint-request>`;
}

export function hintText(level: number): string {
  return `Xin gợi ý — mức ${level}: ${MENTOR_HINT_LABEL[level]}`;
}

/** "Nhận xét code": a review of the finished solution, like a senior's, with no effect on the rating. */
export function codeReviewBlock(ex: Exercise): string {
  return `<code-review-request>
The learner finished the exercise and asks for a code review of their solution cells (in <mentor-state>; mentor_read_cells reads them again). Review it like a senior colleague would, in Vietnamese, short:
- what is clumsy or longer than it needs to be, and the idiomatic NumPy (and the PyTorch equivalent, since they are learning PyTorch) for it;
- latent bugs: dtype, shapes that only work by accident of broadcasting, numerical stability, in-place changes of inputs, edge cases the tests did not cover;
- at most one thing they did well.
Show short snippets for the idioms (the exercise is done, so this is allowed), at most 3 points ranked by importance. This has no effect on their rating. Compare with the reference solution only where it teaches something:
\`\`\`python
${ex.reference.trim()}
\`\`\`
</code-review-request>`;
}

export function verdictBlock(v: MentorVerdict, stage: string, ex?: Exercise): string {
  // The author's question for the first failing test, if they wrote one.
  const failing = v.ok || v.error || v.missing ? undefined : v.tests.find((t) => !t.ok);
  const lead = failing?.id ? ex?.hints.find((h) => h.level === 0 && h.test === failing.id) : undefined;
  const next = v.ok
    ? stage === "done"
      ? "The judge passed and the review is done (the bridge shows the result and when the next review is)."
      : stage === "defend"
      ? "The judge passed: the exercise is now in the defence step. Say so in one line, then ask the first probing question."
      : "The judge passed."
    : v.missing
      ? "Tell the learner what to install: a cell with `!pip install …` in the notebook, then restart the kernel."
      : `Do not fix it for them: ask a question that leads to the first failure.${lead ? ` The exercise's author suggests asking (in your own words): ${lead.text}` : ""}`;
  return `<mentor-verdict>\n${verdictText(v)}\n${next}\n</mentor-verdict>`;
}
