// One exercise in one chat: its step, hint level and verdicts, read from and
// written to the Mentor log, with the rules for moving between steps.

import { MENTOR_HINT_MAX, MENTOR_STAGE_LABEL, type MentorChat, type MentorResult, type MentorStage, type MentorVerdict } from "@ainb/protocol";
import type { Exercise } from "./catalog.js";
import type { Mentor } from "./index.js";
import type { AttemptState } from "./model.js";

/** A step change the rules do not allow; its message is for the learner or the agent. */
export class StageRefused extends Error {}

export class MentorSession {
  readonly exercise: Exercise;
  /** The last verdict in full (the log keeps only its counts). */
  verdict: MentorVerdict | undefined;
  private notes: string[] = [];

  constructor(readonly mentor: Mentor, readonly attemptId: string) {
    const a = mentor.attempt(attemptId);
    if (!a) throw new Error(`No Mentor attempt ${attemptId}.`);
    this.exercise = mentor.exercise(a.exerciseId);
  }

  get attempt(): AttemptState {
    return this.mentor.attempt(this.attemptId)!;
  }

  get stage(): MentorStage {
    return this.attempt.stage;
  }

  view(): MentorChat {
    const a = this.attempt;
    const last = a.lastJudge;
    const verdict = this.verdict ?? (last ? { at: last.at, ok: last.ok, passed: last.passed, total: last.total, tests: [], ...(last.error ? { error: last.error } : {}) } : undefined);
    return {
      attemptId: a.attemptId,
      exerciseId: a.exerciseId,
      title: this.exercise.title,
      star: this.exercise.star,
      kind: a.kind,
      ...(this.exercise.variantOf ? { variantOf: this.mentor.catalog.exercise(this.exercise.variantOf)?.title ?? this.exercise.variantOf } : {}),
      stage: a.stage,
      hintLevel: a.hintLevel,
      revealed: a.revealed,
      judges: a.judges,
      ...(verdict ? { verdict } : {}),
      probes: { done: a.probes.length, needed: this.probesNeeded },
      ...(a.result ? { result: a.result } : {}),
      ...(this.paperView() ? { paper: this.paperView()! } : {}),
    };
  }

  /** Where the exercise sits in its paper, when it is a component of one. */
  private paperView(): MentorChat["paper"] | undefined {
    const ex = this.exercise;
    if (!ex.paper) return undefined;
    const pkg = this.mentor.paperPackage(ex.paper);
    if (!pkg) return undefined;
    const view = this.mentor.paperView(pkg);
    const built = view.components.filter((c) => c.mode === "build");
    const index = built.findIndex((c) => c.exerciseId === ex.id);
    return { paperId: ex.paper, title: pkg.info.title, index: index + 1, total: built.length, ...(ex.cites ? { cites: ex.cites } : {}), role: ex.role, ai: ex.author === "ai" };
  }

  /** "Báo bài sai": the attempt no longer counts. */
  report(reason: string): void {
    this.mentor.record({ t: "void", attemptId: this.attemptId, reason: reason.slice(0, 500) });
  }

  /** Probing answers that finish the defence (a review has none). */
  get probesNeeded(): number {
    return this.attempt.kind === "review" ? 0 : this.exercise.probes;
  }

  /** Notes for the agent's next turn (the learner moved a step themself). */
  takeNotes(): string[] {
    const n = this.notes;
    this.notes = [];
    return n;
  }

  /**
   * Move to a later step. Past the build needs a passing verdict (or the
   * revealed solution, judged); done needs the probing questions graded.
   */
  setStage(stage: MentorStage, by: "agent" | "user" | "judge"): MentorResult | undefined {
    const a = this.attempt;
    const order: MentorStage[] = ["lab", "build", "defend", "done"];
    const from = order.indexOf(a.stage);
    const to = order.indexOf(stage);
    if (to < 0) throw new StageRefused(`Unknown step ${stage}.`);
    if (to <= from) throw new StageRefused(`The exercise is already at ${MENTOR_STAGE_LABEL[a.stage]} (${a.stage}).`);
    if (a.kind === "review" && stage !== "done") throw new StageRefused("A review has no lab or defence: it ends when the judge passes.");
    if (to >= 2 && !a.passed) {
      throw new StageRefused(by === "user"
        ? "Bài cần qua máy chấm (bấm Chấm bài) trước khi sang chặng Bảo vệ."
        : "The judge has not passed the learner's code yet: the defence starts after a passing verdict. Keep coaching the build.");
    }
    if (to === 3 && a.probes.length < this.probesNeeded) {
      const left = this.probesNeeded - a.probes.length;
      throw new StageRefused(by === "user"
        ? `Còn ${left} câu hỏi bảo vệ cần trả lời trước khi xong bài.`
        : `Grade ${left} more probing question${left === 1 ? "" : "s"} with mentor_probe_result before finishing.`);
    }
    // Skipping a step still records the steps in between, in order.
    for (let i = a.kind === "review" ? to : from + 1; i <= to; i++) {
      const s = order[i]!;
      if (s === "done") this.mentor.record({ t: "done", attemptId: this.attemptId });
      else this.mentor.record({ t: "stage", attemptId: this.attemptId, stage: s, by });
    }
    if (by === "user") this.notes.push(`The learner moved the exercise to ${MENTOR_STAGE_LABEL[stage]} (${stage}) themself.`);
    return stage === "done" ? this.attempt.result : undefined;
  }

  /** A verdict: passing moves to the defence (a review is then done, and its result returned). */
  judged(verdict: MentorVerdict): MentorResult | undefined {
    this.verdict = verdict;
    this.mentor.record({
      t: "judge", attemptId: this.attemptId, ok: verdict.ok, passed: verdict.passed, total: verdict.total,
      ...(verdict.error ? { error: verdict.error } : {}), ...(verdict.metrics?.length ? { metrics: verdict.metrics } : {}),
    });
    if (!verdict.ok || (this.stage !== "lab" && this.stage !== "build")) return undefined;
    return this.setStage(this.attempt.kind === "review" ? "done" : "defend", "judge");
  }

  /** The learner pressed "Xin gợi ý": one level up, to the reference solution at most. */
  raiseHint(): number {
    const level = Math.min(MENTOR_HINT_MAX, this.attempt.hintLevel + 1);
    if (level === this.attempt.hintLevel) return level;
    this.mentor.record({ t: "hint", attemptId: this.attemptId, level });
    return level;
  }

  probe(grade: 0 | 1 | 2, question: string, tag?: string): void {
    if (this.attempt.kind === "review") throw new StageRefused("A review has no defence: nothing to grade (use mentor_recall for the warm-up questions).");
    if (this.stage !== "defend") throw new StageRefused("Probing questions are graded in the defence step only (after the judge passes).");
    this.mentor.record({ t: "probe", attemptId: this.attemptId, grade, question: question.slice(0, 500), ...(tag ? { tag } : {}) });
  }

  /** A misconception from the book, asked again: how the learner answered now. */
  recall(tag: string, grade: 0 | 1 | 2): void {
    const due = this.mentor.recallsDue(this.attemptId);
    if (!due.some((d) => d.tag.toLowerCase() === tag.trim().toLowerCase())) {
      throw new StageRefused(`"${tag}" is not one of the warm-up questions due in this session${due.length ? ` (due: ${due.map((d) => d.tag).join(", ")})` : " (none are left)"}.`);
    }
    this.mentor.record({ t: "recall", attemptId: this.attemptId, tag: tag.trim().slice(0, 80), grade });
  }

  misconception(tag: string, note: string): void {
    this.mentor.record({ t: "misconception", attemptId: this.attemptId, tag: tag.slice(0, 80), note: note.slice(0, 400) });
  }
}
