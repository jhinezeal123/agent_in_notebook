import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/mentor/catalog.js";
import { Mentor } from "../src/mentor/index.js";
import { attemptScore, dayOf, expected, fold, heatmap, pickToday, START_RATING, streakOf, type MentorEvent } from "../src/mentor/model.js";
import { MentorSession, StageRefused } from "../src/mentor/session.js";
import { cellRole, exerciseCells, exerciseIn, foreignCells, learnerWork, withWork } from "../src/mentor/notebook.js";

const catalog = loadCatalog();
const DAY = 86_400_000;
/** Noon, local time, on a fixed date. */
const T0 = new Date(2026, 10, 2, 12, 0, 0).getTime();

function mentorAt(clock: { now: number }) {
  return new Mentor({ dir: mkdtempSync(join(tmpdir(), "ainb-mentor-")), catalog, now: () => clock.now });
}

/** Run an attempt to the end: pass the judge, answer the probes. */
function finish(m: Mentor, opts: { hints?: number; fails?: number; grades?: (0 | 1 | 2)[]; exerciseId?: string } = {}) {
  const { attemptId } = m.begin(opts.exerciseId);
  const s = new MentorSession(m, attemptId);
  s.setStage("build", "agent");
  for (let i = 0; i < (opts.hints ?? 0); i++) s.raiseHint();
  for (let i = 0; i < (opts.fails ?? 0); i++) s.judged({ at: 0, ok: false, passed: 1, total: 3, tests: [] });
  s.judged({ at: 0, ok: true, passed: 3, total: 3, tests: [] });
  for (const g of opts.grades ?? new Array(s.exercise.probes).fill(2)) s.probe(g, "q");
  return { s, result: s.setStage("done", "agent")! };
}

describe("days and streaks", () => {
  it("counts a late night for the day before (the day starts at 4 a.m.)", () => {
    expect(dayOf(new Date(2026, 10, 3, 2, 30).getTime())).toBe("2026-11-02");
    expect(dayOf(new Date(2026, 10, 3, 4, 30).getTime())).toBe("2026-11-03");
  });

  it("keeps the streak through today until the day is over", () => {
    const days = new Map([["2026-11-01", 1], ["2026-11-02", 1]]);
    expect(streakOf(days, "2026-11-03")).toMatchObject({ current: 2, doneToday: false });
    expect(streakOf(days, "2026-11-04").current).toBe(0);
  });

  it("earns a freeze every 7 days and spends it on a missed day", () => {
    const days = new Map<string, number>();
    for (let i = 1; i <= 7; i++) days.set(`2026-11-0${i}`, 1);
    days.set("2026-11-09", 1);
    const s = streakOf(days, "2026-11-09");
    expect(s.current).toBe(8);
    expect(s.freezes).toBe(0);
    // Today (the 9th) is still open: the 8th was covered by the freeze.
    expect(streakOf(new Map([...days].filter(([d]) => d !== "2026-11-09")), "2026-11-09")).toMatchObject({ current: 7, freezes: 0 });
    // Without a freeze a missed day ends it.
    expect(streakOf(new Map([["2026-11-01", 1], ["2026-11-02", 1]]), "2026-11-04").current).toBe(0);
  });

  it("lays the heatmap out over 16 weeks ending today", () => {
    const h = heatmap(new Map([["2026-11-02", 3]]), "2026-11-02");
    expect(h).toHaveLength(112);
    expect(h.at(-1)).toEqual({ day: "2026-11-02", count: 3 });
  });
});

describe("ratings", () => {
  it("expects a win against an easier exercise", () => {
    expect(expected(1200, 1000)).toBeGreaterThan(0.5);
    expect(expected(1000, 1000)).toBeCloseTo(0.5);
  });

  it("scores hints, failed verdicts and wrong answers lower", () => {
    const base = { kind: "learn" as const, passed: true, hintLevel: 0, revealed: false, failedBeforePass: 0, probes: [{ grade: 2 as const, question: "" }] };
    const clean = attemptScore(base, "tensor");
    expect(attemptScore({ ...base, hintLevel: 2 }, "tensor")).toBeLessThan(clean);
    expect(attemptScore({ ...base, failedBeforePass: 3 }, "tensor")).toBeLessThan(clean);
    expect(attemptScore({ ...base, probes: [{ grade: 0, question: "" }] }, "theory")).toBeLessThan(attemptScore(base, "theory") - 0.5);
  });

  it("raises a clean pass and lowers a pass that leaned on hints", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const { result } = finish(m);
    expect(result.deltas[0]!.before).toBe(START_RATING);
    expect(result.deltas.every((d) => d.after > d.before)).toBe(true);
    clock.now += DAY;
    const leaned = finish(m, { hints: 3, fails: 4, grades: [0, 0] }).result;
    expect(leaned.deltas.every((d) => d.after < d.before)).toBe(true);
  });

  it("never raises a rating after the reference solution was shown, and brings the exercise back in 3 days", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const { result, s } = finish(m, { hints: 4 });
    expect(result.revealed).toBe(true);
    expect(result.deltas.every((d) => d.after <= d.before)).toBe(true);
    // Finish the rest of the diagnostic so "redo" is not hidden behind it.
    clock.now += DAY;
    while (pickToday(m.state(), catalog, clock.now)?.reason === "diagnostic") finish(m);
    expect(pickToday(m.state(), catalog, clock.now + 3 * DAY)).toMatchObject({ reason: "redo", exerciseId: s.exercise.id });
  });
});

describe("today's exercise", () => {
  it("starts with the diagnostic in order, then continues an unfinished attempt", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const first = pickToday(m.state(), catalog, clock.now)!;
    expect(first).toMatchObject({ reason: "diagnostic", exerciseId: "broadcast-pairwise" });
    const { attemptId } = m.begin();
    expect(pickToday(m.state(), catalog, clock.now)).toMatchObject({ reason: "continue", attemptId });
    // Starting it again reopens the same attempt.
    expect(m.begin()).toMatchObject({ attemptId, resumed: true });
  });

});

describe("notebooks holding attempts", () => {
  const A = "kaggle:/code/me/one";
  const B = "kaggle:/code/me/two";

  it("follows the latest load: a notebook holds one attempt, an attempt sits in one notebook", () => {
    const m = mentorAt({ now: T0 });
    const first = m.begin("broadcast-pairwise").attemptId;
    const second = m.begin("layernorm").attemptId;
    m.record({ t: "load", attemptId: first, notebook: A });
    expect(m.attemptIn(A)?.attemptId).toBe(first);
    // Another exercise into the same notebook: the first one leaves it.
    m.record({ t: "load", attemptId: second, notebook: A });
    expect(m.attemptIn(A)?.attemptId).toBe(second);
    expect(m.attempt(first)?.notebook).toBeUndefined();
    // The first one again, in another notebook.
    m.record({ t: "load", attemptId: first, notebook: B });
    expect(m.attemptIn(B)?.attemptId).toBe(first);
    expect(m.attemptIn(A)?.attemptId).toBe(second);
    // Moved on (a renamed notebook): the old key no longer holds it.
    m.record({ t: "load", attemptId: first, notebook: "kaggle:/code/me/three" });
    expect(m.attemptIn(B)).toBeUndefined();
    expect(m.attempt(first)?.notebook).toBe("kaggle:/code/me/three");
  });

  it("still reads an old attempt that was a local file", () => {
    const events = [
      { t: "start", attemptId: "a1", exerciseId: "broadcast-pairwise", file: "D:\\Docs\\ml-mentor\\x.ipynb", at: T0, day: "2026-11-02" },
      { t: "verdict", attemptId: "a1", ok: true, passed: 3, total: 3, at: T0 + 1, day: "2026-11-02" },
    ] as unknown as MentorEvent[];
    const state = fold(events, catalog);
    expect(state.attempts.get("a1")).toMatchObject({ exerciseId: "broadcast-pairwise", file: "D:\\Docs\\ml-mentor\\x.ipynb" });
    expect(state.places.size).toBe(0);
  });

  it("restores the learner's work into a fresh copy of the exercise", () => {
    const m = mentorAt({ now: T0 });
    const { attemptId } = m.begin("broadcast-pairwise");
    const cells = m.cellsFor(attemptId);
    expect(exerciseIn(cells)).toBe("broadcast-pairwise");
    expect(foreignCells(cells)).toBe(0);
    const written = cells.map((c) => (cellRole(c) === "solution" ? { ...c, source: `${c.source}\nreturn 42` } : cellRole(c) === "sketch" ? { ...c, source: `${c.source.split("\n")[0]}\nchia hàm` } : c));
    const work = learnerWork(written);
    expect(work.sketch).toBe("chia hàm");
    expect(work.solution.join("\n")).toContain("return 42");
    m.store.saveWork(attemptId, work);
    const again = m.cellsFor(attemptId);
    expect(learnerWork(again)).toEqual(work);
    // Without saved work, the copy is the plain exercise.
    expect(withWork(exerciseCells(m.exercise("broadcast-pairwise")), null).length).toBe(exerciseCells(m.exercise("broadcast-pairwise")).length);
  });

  it("counts the cells of a notebook that holds no exercise", () => {
    expect(foreignCells([{ id: "x", type: "code", source: "print(1)" }, { id: "y", type: "code", source: "  " }])).toBe(1);
  });
});

describe("steps", () => {
  it("refuses the defence before a passing verdict, and done before the probes", () => {
    const m = mentorAt({ now: T0 });
    const s = new MentorSession(m, m.begin().attemptId);
    expect(() => s.setStage("defend", "user")).toThrow(StageRefused);
    s.judged({ at: 0, ok: true, passed: 2, total: 2, tests: [] });
    expect(s.stage).toBe("defend");
    expect(() => s.setStage("done", "agent")).toThrow(/Grade/);
    expect(s.view().probes).toEqual({ done: 0, needed: s.exercise.probes });
  });

  it("recomputes everything from the log", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    finish(m);
    const events = m.store.events() as MentorEvent[];
    const again = fold(events, catalog);
    expect([...again.ratings.values()][0]!.n).toBe(1);
    expect(m.home().streak.current).toBe(1);
  });
});

/** A review of the exercise: re-implement it, pass the judge (or not) with some hints. */
function review(m: Mentor, exerciseId: string, opts: { pass?: boolean; hints?: number } = {}) {
  const { attemptId } = m.begin(exerciseId, "review");
  const s = new MentorSession(m, attemptId);
  for (let i = 0; i < (opts.hints ?? 0); i++) s.raiseHint();
  if (opts.pass === false) {
    s.judged({ at: 0, ok: false, passed: 0, total: 3, tests: [] });
    return { s, result: undefined };
  }
  return { s, result: s.judged({ at: 0, ok: true, passed: 3, total: 3, tests: [] }) };
}

describe("spaced reviews", () => {
  it("schedules a review 3 days after learning, then 10 and 30 days, then the exercise is learnt", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const { s, result } = finish(m);
    const id = s.exercise.id;
    expect(result.nextReview).toBe(3);
    expect(m.home().warmup).toBeNull();
    clock.now += 3 * DAY;
    expect(m.home().warmup).toMatchObject({ reason: "review", kind: "review", exerciseId: id, overdue: 0 });
    // The review starts at the build, with a blank cell, and the judge's pass ends it.
    const r1 = review(m, id);
    expect(r1.s.view()).toMatchObject({ kind: "review", stage: "done", probes: { needed: 0 } });
    expect(r1.result?.nextReview).toBe(10);
    clock.now += 10 * DAY;
    expect(review(m, id).result?.nextReview).toBe(30);
    clock.now += 30 * DAY;
    expect(review(m, id).result?.nextReview).toBeNull();
    clock.now += 60 * DAY;
    expect(m.home().warmup).toBeNull();
  });

  it("starts the intervals over when the review leaned on hints, and moves the rating half as much", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const id = finish(m).s.exercise.id;
    clock.now += 3 * DAY;
    const leaned = review(m, id, { hints: 2 }).result!;
    expect(leaned.nextReview).toBe(3);
    expect(leaned.deltas.every((d) => d.after < d.before)).toBe(true);
    clock.now += 3 * DAY;
    const clean = review(m, id).result!;
    expect(clean.nextReview).toBe(10);
  });

  it("keeps an unfinished review as the warm-up, not as today's exercise", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const id = finish(m).s.exercise.id;
    clock.now += 4 * DAY;
    const { s } = review(m, id, { pass: false });
    const home = m.home();
    expect(home.warmup).toMatchObject({ reason: "continue", attemptId: s.attemptId });
    expect(home.today?.attemptId).not.toBe(s.attemptId);
    expect(m.begin(id, "review")).toMatchObject({ attemptId: s.attemptId, resumed: true });
  });

  it("dims the star as its review goes overdue", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const star = finish(m).s.exercise.star;
    const fade = () => m.home().stars.find((x) => x.id === star)!.fade;
    expect(fade()).toBe(0);
    clock.now += 3 * DAY;
    const dueToday = fade();
    expect(dueToday).toBeGreaterThan(0);
    clock.now += 7 * DAY;
    expect(fade()).toBeGreaterThan(dueToday);
    clock.now += 30 * DAY;
    expect(fade()).toBe(1);
  });

  it("refuses the lab and the defence in a review", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const id = finish(m).s.exercise.id;
    const s = new MentorSession(m, m.begin(id, "review").attemptId);
    expect(s.stage).toBe("build");
    expect(() => s.setStage("defend", "agent")).toThrow(StageRefused);
    expect(() => s.probe(2, "q")).toThrow(StageRefused);
  });
});

describe("misconception book", () => {
  it("asks a misconception again two days later, and two right answers make it solid", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const first = new MentorSession(m, m.begin().attemptId);
    first.misconception("broadcast-axis", "Nghĩ rằng broadcasting ghép trục từ trái sang.");
    expect(m.recallsDue(first.attemptId)).toEqual([]);
    expect(m.home().mistakes[0]).toMatchObject({ tag: "broadcast-axis", status: "waiting", due: "2026-11-04" });
    clock.now += 2 * DAY;
    const next = new MentorSession(m, m.begin("layernorm").attemptId);
    expect(m.recallsDue(next.attemptId).map((d) => d.tag)).toEqual(["broadcast-axis"]);
    next.recall("broadcast-axis", 2);
    expect(m.recallsDue(next.attemptId)).toEqual([]);
    expect(m.home().mistakes[0]).toMatchObject({ status: "waiting", streak: 1 });
    clock.now += 7 * DAY;
    const later = new MentorSession(m, m.begin("einsum-scores").attemptId);
    later.recall("broadcast-axis", 2);
    expect(m.home().mistakes[0]).toMatchObject({ status: "solid", streak: 2 });
    expect(() => later.recall("broadcast-axis", 2)).toThrow(StageRefused);
  });

  it("starts over after a wrong answer, and gives the bank's question when the tag comes from it", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    const s = new MentorSession(m, m.begin("layernorm").attemptId);
    s.misconception("eps-placement", "Đặt ε ngoài căn.");
    clock.now += 2 * DAY;
    const again = new MentorSession(m, m.begin("einsum-scores").attemptId);
    const due = m.recallsDue(again.attemptId);
    expect(due[0]).toMatchObject({ tag: "eps-placement", exercise: s.exercise.title });
    expect(due[0]!.question).toMatch(/ε/);
    again.recall("eps-placement", 0);
    expect(m.home().mistakes[0]).toMatchObject({ status: "waiting", streak: 0, seen: 2, due: "2026-11-06" });
  });
});

describe("scaffold", () => {
  it("gives the full starter in the diagnostic and a blank cell in a review", async () => {
    const { scaffoldFor } = await import("../src/mentor/model.js");
    const m = mentorAt({ now: T0 });
    const diag = catalog.exercises.find((e) => e.diagnostic)!;
    expect(scaffoldFor(m.state(), diag, "learn")).toBe("full");
    expect(scaffoldFor(m.state(), diag, "review")).toBe("blank");
  });

  it("keeps only the signatures, or nothing but the names", async () => {
    const { scaffoldStarter } = await import("../src/mentor/notebook.js");
    const ex = { starter: 'def f(x, y):\n    """doc\n    more"""\n    ...\n\n\ndef g(a,\n      b=1):\n    """doc"""\n    ...', functions: ["f", "g"] };
    expect(scaffoldStarter(ex, "signature")).toBe("def f(x, y):\n    ...\n\ndef g(a,\n      b=1):\n    ...");
    expect(scaffoldStarter(ex, "blank")).toBe("# Viết f(...), g(...) ở đây.");
    expect(scaffoldStarter(ex, "full")).toBe(ex.starter);
  });
});

describe("variations", () => {
  const variant = catalog.exercises.find((e) => e.variantOf && !catalog.exercise(e.variantOf)!.diagnostic);

  it.skipIf(!variant)("offers a variation right after its exercise is learnt, never before", () => {
    const clock = { now: T0 };
    const m = mentorAt(clock);
    while (pickToday(m.state(), catalog, clock.now)?.reason === "diagnostic") finish(m);
    const parent = variant!.variantOf!;
    expect(pickToday(m.state(), catalog, clock.now)?.exerciseId).not.toBe(variant!.id);
    finish(m, { exerciseId: parent });
    expect(pickToday(m.state(), catalog, clock.now)).toMatchObject({ reason: "variant", exerciseId: variant!.id });
    const s = new MentorSession(m, m.begin(variant!.id).attemptId);
    expect(s.view().variantOf).toBe(catalog.exercise(parent)!.title);
    expect(m.home().stars.find((x) => x.id === variant!.star)!.exercises.find((x) => x.id === variant!.id)).toMatchObject({ variant: true });
  });

  it.skipIf(!variant)("writes the prediction cell, and the agent reads it", async () => {
    const { exerciseCells, PREDICT_ID } = await import("../src/mentor/notebook.js");
    const { learnerCells } = await import("../src/mentor/prompt.js");
    const cells = exerciseCells(variant!);
    expect(cells.some((c) => c.id === PREDICT_ID)).toBe(true);
    expect(cells.find((c) => c.id === "mentor-lab")!.source).toContain(variant!.predict!.slice(0, 20));
    const written = cells.map((c) => (c.id === PREDICT_ID ? { ...c, source: "Mình đoán loss nhỏ nhất không còn bằng 0." } : c));
    expect(learnerCells(written)).toContain("Prediction (written before coding):\nMình đoán");
    expect(learnerCells(cells)).toContain("Prediction: not written yet.");
  });
});
