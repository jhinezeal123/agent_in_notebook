import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/mentor/catalog.js";
import { Mentor } from "../src/mentor/index.js";
import { attemptScore, dayOf, expected, fold, heatmap, pickToday, START_RATING, streakOf, type MentorEvent } from "../src/mentor/model.js";
import { MentorSession, StageRefused } from "../src/mentor/session.js";
import { fileId, vscodeKey } from "../src/mentor/store.js";

const catalog = loadCatalog();
const DAY = 86_400_000;
/** Noon, local time, on a fixed date. */
const T0 = new Date(2026, 10, 2, 12, 0, 0).getTime();

function mentorAt(clock: { now: number }) {
  return new Mentor({ dir: mkdtempSync(join(tmpdir(), "ainb-mentor-")), catalog, now: () => clock.now });
}

/** Run an attempt to the end: pass the judge, answer the probes. */
function finish(m: Mentor, opts: { hints?: number; fails?: number; grades?: (0 | 1 | 2)[] } = {}) {
  const { attemptId } = m.start();
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
    const base = { passed: true, hintLevel: 0, revealed: false, failedBeforePass: 0, probes: [{ grade: 2 as const, question: "" }] };
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
    const { attemptId } = m.start();
    expect(pickToday(m.state(), catalog, clock.now)).toMatchObject({ reason: "continue", attemptId });
    // Starting it again reopens the same attempt and notebook.
    expect(m.start()).toMatchObject({ attemptId, resumed: true });
  });

  it("finds the attempt by VS Code's notebook key", () => {
    const m = mentorAt({ now: T0 });
    const { attemptId, file } = m.start();
    expect(m.attemptForFile(vscodeKey(file))?.attemptId).toBe(attemptId);
    expect(fileId("vscode:file:///d%3A/Docs/ml-mentor/x.ipynb")).toBe(fileId("D:\\Docs\\ml-mentor\\x.ipynb"));
  });
});

describe("steps", () => {
  it("refuses the defence before a passing verdict, and done before the probes", () => {
    const m = mentorAt({ now: T0 });
    const s = new MentorSession(m, m.start().attemptId);
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
