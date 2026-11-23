// Easy-read's model (E.8): the reading folded from the paper's log — the
// goal and passes, answers with how sure the reader was (Gardner-Medwin),
// writes and their grades, the questions that come back until right, how
// solid each concept is; and a paper's misconception in Mentor's book.

import { describe, expect, it } from "vitest";
import { readerPoints } from "@ainb/protocol";
import { fold, mistakeBook, paperEventId, type MentorEvent } from "../src/mentor/model.js";
import { conceptMastery, foldReader, isAgain, latestWrite, scoreOf, type ReaderEvent } from "../src/reader/model.js";

const answer = (at: number, item: string, correct: boolean, confidence: 1 | 2 | 3, concept = "c1", bloom: "remember" | "apply" = "remember"): ReaderEvent =>
  ({ t: "r.answer", at, item, unit: "S4", concept, bloom, correct, confidence, choice: { options: [0] } });

describe("points by how sure the reader was (Gardner-Medwin)", () => {
  it("1: +1 / 0 · 2: +2 / −2 · 3: +3 / −6, so saying more than you know never pays", () => {
    expect([1, 2, 3].map((c) => readerPoints(true, c as 1 | 2 | 3))).toEqual([1, 2, 3]);
    expect([1, 2, 3].map((c) => readerPoints(false, c as 1 | 2 | 3))).toEqual([0, -2, -6]);
    // At a 50 % chance of being right, "sure" (3) expects −1.5 and "a guess" (1) +0.5.
    expect(0.5 * readerPoints(true, 3) + 0.5 * readerPoints(false, 3)).toBeLessThan(0.5 * readerPoints(true, 1) + 0.5 * readerPoints(false, 1));
  });
});

describe("the reading, folded", () => {
  it("keeps the goal, the pass, what was finished", () => {
    const s = foldReader([
      { t: "r.goal", at: 1, goal: "use" },
      { t: "r.pass", at: 2, pass: 1, what: "start" },
      { t: "r.pass", at: 3, pass: 1, what: "done" },
      { t: "r.pass", at: 4, pass: 2, what: "start" },
      { t: "r.goal", at: 5, goal: "nonsense" } as unknown as ReaderEvent,
    ]);
    expect([s.goal, s.pass, [...s.passed]]).toEqual(["use", 2, [1]]);
  });

  it("scores answers: right the first time, points, sure-and-wrong, lucky guesses; a wrong one comes back until right", () => {
    const s = foldReader([
      answer(1, "q1", true, 3),
      answer(2, "q2", false, 3),
      answer(3, "q3", true, 1),
      answer(4, "q2", true, 2),
      answer(5, "q4", false, 1),
    ]);
    expect(scoreOf(s, ["q1", "q2", "q3", "q4", "q5"])).toEqual({ answered: 4, total: 5, firstRight: 2, points: 3 - 6 + 1 + 2 + 0, max: 15, sureWrong: 1, luckyRight: 1 });
    expect(["q1", "q2", "q3", "q4", "q5"].filter((q) => isAgain(s.answers.get(q)))).toEqual(["q4"]);
  });

  it("weighs a concept's answers by their level, a lucky guess by half; withdrawn questions do not count", () => {
    const s = foldReader([
      answer(1, "low", true, 3, "c1", "remember"),
      answer(2, "high", false, 3, "c1", "apply"),
      answer(3, "guess", true, 1, "c2", "apply"),
      answer(4, "bad", false, 3, "c2", "remember"),
      { t: "r.report", at: 5, item: "bad", reason: "hai đáp án đúng" },
    ]);
    const m = conceptMastery(s);
    // c1: remember (1) right, apply (2) wrong → 1/3.
    expect(m.get("c1")!.mastery).toBeCloseTo(1 / 3);
    expect(m.get("c2")!.mastery).toBeCloseTo(0.5);
    expect(m.get("c2")!.answers).toBe(1);
  });

  it("keeps writes with their grade (graded again on a dispute), skips, reports, misconceptions; skips what it cannot read", () => {
    const s = foldReader([
      { t: "r.write", at: 1, id: "w1", kind: "recall", unit: "S4", text: "BA hạng thấp", sent: true },
      { t: "r.grade", at: 2, write: "w1", grade: 1, missing: ["bằng chứng"], feedback: "Thiếu chứng cứ" },
      { t: "r.grade", at: 3, write: "w1", grade: 2, feedback: "Đủ" },
      { t: "r.grade", at: 4, write: "nope", grade: 2 },
      { t: "r.write", at: 5, id: "w2", kind: "poem", text: "x" } as unknown as ReaderEvent,
      { t: "r.skip", at: 6, task: "S4:explain" },
      { t: "r.miss", at: 7, concept: "zero-init", note: "Nghĩ A = 0", item: "q1" },
      { t: "r.pre", at: 8, item: "pre-1", option: 2 },
    ]);
    expect(latestWrite(s, "recall", "S4")).toMatchObject({ id: "w1", grade: 2, feedback: "Đủ", sent: true });
    expect(latestWrite(s, "recall", "S4")!.missing).toBeUndefined();
    expect(s.writes.size).toBe(1);
    expect([...s.skipped]).toEqual(["S4:explain"]);
    expect(s.misses).toEqual([{ concept: "zero-init", note: "Nghĩ A = 0", item: "q1", at: 7 }]);
    expect(s.pre.get("pre-1")).toEqual({ option: 2, at: 8 });
  });
});

describe("a paper's misconception in Mentor's book", () => {
  it("goes in with the paper's title, though no exercise is open, and is asked again in two days", () => {
    const at = Date.UTC(2026, 10, 23, 9);
    const day = "2026-11-23";
    const events: MentorEvent[] = [
      { t: "misconception", attemptId: paperEventId("arxiv-2106-09685"), tag: "paper:arxiv-2106-09685:zero-init", note: "Nghĩ A được khởi tạo bằng 0", title: "LoRA", at, day },
    ];
    const book = mistakeBook(fold(events, { exercise: () => undefined }), { exercise: () => undefined }, day);
    expect(book).toEqual([expect.objectContaining({ tag: "paper:arxiv-2106-09685:zero-init", title: "LoRA", exerciseId: "paper:arxiv-2106-09685", status: "waiting", due: "2026-11-25" })]);
  });
});
