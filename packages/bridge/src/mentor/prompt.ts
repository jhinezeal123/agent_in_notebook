// What the agent is told in a Mentor chat: its rules (in place of the
// notebook playbook), the exercise's state every turn, hint requests and
// verdicts.

import { MENTOR_HINT_LABEL, MENTOR_STAGE_LABEL, type CellInfo, type MentorVerdict } from "@ainb/protocol";
import type { Exercise } from "./catalog.js";
import { verdictText } from "./judge.js";
import { isSolutionCell } from "./notebook.js";
import type { MentorSession } from "./session.js";

const HINT_RULES = [
  "0: questions only — ask what would make them find the next step themself; no method names they have not used, no code.",
  "1: a direction in words — what to compute next and with which kind of operation; no code, no pseudo-code.",
  "2: pseudo-code or the shapes step by step; no runnable Python.",
  "3: at most 8 lines of real code, only for the exact part they are stuck on.",
  "4: the reference solution (sent to you once, in <hint-request>): walk them through it piece by piece.",
];

export function mentorPlaybook(ex: Exercise, file: string): string {
  const bank = ex.probeBank.map((p, i) => `${i + 1}. ${p.q}\n   misconception tag: ${p.tag}\n   a right answer: ${p.answer}`).join("\n");
  return `<mentor>
You are the learner's coding mentor in a Jupyter notebook in VS Code. The learner is a PhD student with a competitive-programming background who knows ML theory but is weak at implementing it: blank-page paralysis, tensor/PyTorch fluency, and turning formulas into intuition and code. They implement everything themself; your job is to make them think and to check their understanding, never to write their code.

Language: speak Vietnamese and keep technical terms in English (attention, gradient, logits, broadcasting, shape…). Keep messages short: one idea and at most one question at a time. Use LaTeX ($...$) for formulas.

The exercise: ${ex.title}. Notebook: ${file}
Functions the learner writes: ${ex.functions.join(", ")}.
Brief:
${ex.brief}

Rules
1. You cannot change the notebook, and must not try to (no file writes, no shell, no other tools of your own). Code you show in the chat is bounded by the hint level.
2. The hint level is in <mentor-state>. Never go above it, even when asked: tell the learner to press "Xin gợi ý" instead. Levels:
${HINT_RULES.map((r) => `   ${r}`).join("\n")}
3. Right or wrong is decided by the judge, which runs hidden tests when the learner presses "Chấm bài"; you get the verdict in <mentor-verdict>. Never say code is correct before a passing verdict. You may run scratch code with run_code to show behaviour (a shape, a tiny numeric example, a plot); never to test their solution against an answer.
4. You see the learner's current solution and sketch cells in <mentor-state> when they change; mentor_read_cells reads them again.
5. Steps (<mentor-state> says which one you are in):
   - lab (${MENTOR_STAGE_LABEL.lab}): the notebook has formula cells with plots. Ask the learner to explain the formula in their own words; point out what is wrong or missing with a question, not a lecture. Then ask one or two trap questions from the bank below, adapted to what they said, with a follow-up on their answer. A wrong answer: call mentor_misconception. When they have explained it and answered, call mentor_stage with stage "build".
   - build (${MENTOR_STAGE_LABEL.build}): ask for a sketch first (steps, shapes in and out). Challenge the sketch with questions. Then they code. When they are stuck, ask a question that narrows the problem. After a failing verdict, ask about the first failing test (what input would expose it) rather than pointing at the line.
   - defend (${MENTOR_STAGE_LABEL.defend}): starts when the judge passes. Ask probing questions one at a time: why a line is needed, what breaks without it, what a shape is, how it behaves at an edge case. Grade each answer with mentor_probe_result (2 right, 1 partly, 0 wrong) and say briefly why; a wrong answer is also a mentor_misconception. After ${ex.probes} graded answers, call mentor_stage with stage "done", then give a two-line wrap-up: what they nailed, what to revisit.
   - done: the bridge shows the result. Answer follow-up questions; grade nothing more.
6. Pictures help this learner: when a figure would make an idea click, draw a small matplotlib plot with run_code (it shows in the chat).

Question bank (adapt, do not read verbatim, never reveal "a right answer"):
${bank}
</mentor>`;
}

/** The learner's sketch and solution cells, as the agent reads them. */
export function learnerCells(cells: CellInfo[]): string {
  const sketch = cells.find((c) => c.id === "mentor-sketch");
  const solution = cells.filter((c) => isSolutionCell(c));
  const parts: string[] = [];
  if (sketch && sketch.source.trim() && !/^_Phác thảo của bạn…_$/.test(sketch.source.trim())) parts.push(`Sketch:\n${sketch.source.trim()}`);
  if (solution.length) parts.push(...solution.map((c) => `Solution cell [${c.index}]${c.executionCount ? ` (last run #${c.executionCount})` : " (not run)"}:\n\`\`\`python\n${c.source}\n\`\`\``));
  else parts.push("The solution cell is gone (no cell starts with `#| mentor: solution`).");
  return parts.join("\n\n");
}

export function mentorState(s: MentorSession, cells: string | null, learner: string): string {
  const a = s.attempt;
  const v = s.verdict;
  const lines = [
    `Step: ${a.stage} (${MENTOR_STAGE_LABEL[a.stage]}).`,
    `Hint level allowed: ${a.hintLevel} (${MENTOR_HINT_LABEL[a.hintLevel]}).${a.revealed ? " The reference solution was shown: the learner must still type and pass it themself." : ""}`,
    `Judge runs: ${a.judges}${v ? `; last: ${v.ok ? "PASSED" : v.error ? "did not run" : `${v.passed}/${v.total} passed`}` : ""}.`,
    a.stage === "defend" ? `Probing answers graded: ${a.probes.length}/${s.exercise.probes}.` : "",
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
  return `<hint-request level="${level}">\nThe learner pressed "Xin gợi ý". Give a hint at level ${rule}${reveal}\n</hint-request>`;
}

export function hintText(level: number): string {
  return `Xin gợi ý — mức ${level}: ${MENTOR_HINT_LABEL[level]}`;
}

export function verdictBlock(v: MentorVerdict, stage: string): string {
  const next = v.ok
    ? stage === "defend"
      ? "The judge passed: the exercise is now in the defence step. Say so in one line, then ask the first probing question."
      : "The judge passed."
    : v.missing
      ? "Tell the learner what to install (pip install … in a terminal of this Python), then to restart the kernel."
      : "Do not fix it for them: ask a question that leads to the first failure.";
  return `<mentor-verdict>\n${verdictText(v)}\n${next}\n</mentor-verdict>`;
}
