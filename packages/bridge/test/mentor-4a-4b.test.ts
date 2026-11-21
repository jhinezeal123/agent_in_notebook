// Tests for Đợt 4a + 4b: Mentor engine optimizations (A7.1, A7.2, A7.3) and features (C2, C5, C6, C7, C9).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog, type Exercise } from "../src/mentor/catalog.js";
import { Mentor } from "../src/mentor/index.js";
import { judgeCode } from "../src/mentor/judge.js";
import {
  applyEvent,
  dayOf,
  emptyState,
  exerciseAnalytics,
  fold,
  foldFromSnapshot,
  scaffoldFor,
  serializeState,
  type MentorEvent,
} from "../src/mentor/model.js";
import { exerciseCells } from "../src/mentor/notebook.js";
import { mentorPlaybook, mentorState } from "../src/mentor/prompt.js";
import { MentorSession, StageRefused } from "../src/mentor/session.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ainb-mentor-4-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp cleanup race
    }
  }
});

describe("Đợt 4a — Mentor engine optimizations (A7.1, A7.2, A7.3)", () => {
  it("A7.1: incremental applyEvent + snapshot round-trip match full fold() identically", () => {
    const catalog = loadCatalog();
    const ex = catalog.exercises[0]!;
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const day0 = dayOf(t0);
    const events: MentorEvent[] = [
      { t: "start", attemptId: "a1", exerciseId: ex.id, kind: "learn", scaffold: "full", at: t0, day: day0 },
      { t: "load", attemptId: "a1", notebook: "nb-1", at: t0 + 1000, day: day0 },
      { t: "stage", attemptId: "a1", stage: "build", by: "agent", at: t0 + 2 * 60_000, day: day0 },
      { t: "hint", attemptId: "a1", level: 1, at: t0 + 4 * 60_000, day: day0 },
      { t: "judge", attemptId: "a1", ok: false, passed: 2, total: 4, at: t0 + 6 * 60_000, day: day0 },
      { t: "judge", attemptId: "a1", ok: true, passed: 4, total: 4, at: t0 + 8 * 60_000, day: day0 },
      { t: "stage", attemptId: "a1", stage: "defend", by: "judge", at: t0 + 8 * 60_000 + 100, day: day0 },
      { t: "misconception", attemptId: "a1", tag: "axis-bug", note: "nhầm trục", at: t0 + 9 * 60_000, day: day0 },
      { t: "probe", attemptId: "a1", grade: 2, question: "q1", tag: "axis-bug", at: t0 + 10 * 60_000, day: day0 },
      { t: "probe", attemptId: "a1", grade: 2, question: "q2", at: t0 + 11 * 60_000, day: day0 },
      { t: "done", attemptId: "a1", at: t0 + 12 * 60_000, day: day0 },
      // Second attempt on next day
      { t: "start", attemptId: "a2", exerciseId: ex.id, kind: "review", scaffold: "blank", at: t0 + 86_400_000, day: dayOf(t0 + 86_400_000) },
      { t: "judge", attemptId: "a2", ok: true, passed: 4, total: 4, at: t0 + 86_400_000 + 60_000, day: dayOf(t0 + 86_400_000) },
      { t: "done", attemptId: "a2", at: t0 + 86_400_000 + 61_000, day: dayOf(t0 + 86_400_000) },
    ];

    const full = fold(events, catalog);

    // Incremental applyEvent
    const inc = emptyState();
    for (const ev of events) applyEvent(inc, ev, catalog);
    expect(serializeState(inc)).toEqual(serializeState(full));

    // Snapshot halfway + tail fold
    const firstHalf = fold(events.slice(0, 7), catalog);
    const snap = serializeState(firstHalf);
    const resumed = foldFromSnapshot(snap, events.slice(7), catalog);
    expect(serializeState(resumed)).toEqual(serializeState(full));
  });

  it("A7.1: mentor.status() matches home() streak/overall/due without computing full home()", () => {
    const dir = tempDir();
    const clock = Date.UTC(2026, 4, 10, 10, 0, 0);
    const mentor = new Mentor({ dir, now: () => clock });
    const ex = mentor.catalog.exercises[0]!;
    const { attemptId } = mentor.begin(ex.id, "learn");
    mentor.record({ t: "stage", attemptId, stage: "build", by: "agent" });
    mentor.record({ t: "judge", attemptId, ok: true, passed: 4, total: 4 });
    mentor.record({ t: "stage", attemptId, stage: "defend", by: "judge" });
    mentor.record({ t: "probe", attemptId, grade: 2, question: "q1" });
    mentor.record({ t: "probe", attemptId, grade: 2, question: "q2" });
    mentor.record({ t: "done", attemptId });

    const s = mentor.status();
    const h = mentor.home();
    expect(s.overall).toBe(h.overall);
    expect(s.streak).toBe(h.streak.current);
    expect(s.dueReviews).toBe(h.reviews.due);
    expect(s.activeToday).toBe(true);
  });

  it("A7.2: reloadPapers() preserves curated catalog exercises & updates exercisesByStar", () => {
    const dir = tempDir();
    const mentor = new Mentor({ dir });
    const countBefore = mentor.catalog.exercises.length;
    const firstStar = mentor.catalog.stars[0]!.id;
    const starCountBefore = mentor.catalog.exercisesByStar?.(firstStar).length ?? 0;

    mentor.reloadPapers();

    expect(mentor.catalog.exercises.length).toBe(countBefore);
    expect(mentor.catalog.exercisesByStar?.(firstStar).length).toBe(starCountBefore);
  });

  it("A7.3: judgeCode enables _ainb_mentor_ref_cache in source mode and disables it for kernel/noCache", () => {
    const catalog = loadCatalog();
    const ex = catalog.exercises[0]!;
    const cached = judgeCode(ex, "def f(): pass", "nonce1");
    expect(cached).toContain('if True and isinstance(_ref_cache, dict)');

    const noCache = judgeCode(ex, "def f(): pass", "nonce2", { noCache: true });
    expect(noCache).toContain('if False and isinstance(_ref_cache, dict)');

    const kernelMode = judgeCode(ex, "", "nonce3", { mode: "kernel" });
    expect(kernelMode).toContain('if False and isinstance(_ref_cache, dict)');
  });
});

describe("Đợt 4b — Mentor features (C2, C5, C6, C7, C9)", () => {
  it("C2: scaffoldFor keeps 'full' when scaffoldFixed is true even at high rating", () => {
    const catalog = loadCatalog();
    const baseEx = catalog.exercises.find((e) => !e.diagnostic && !e.scaffoldFixed)!;
    const debugEx: Exercise = { ...baseEx, scaffoldFixed: true };
    const state = emptyState();
    for (const sk of debugEx.skills) state.ratings.set(sk, { r: 2200, n: 20 });

    expect(scaffoldFor(state, debugEx, "learn")).toBe("full");
    expect(scaffoldFor(state, baseEx, "learn")).toBe("blank");
    expect(scaffoldFor(state, debugEx, "interview")).toBe("blank");
  });

  it("C5: attemptHistory hides referenceCode while in progress and includes it + snapshot after done", () => {
    const dir = tempDir();
    const mentor = new Mentor({ dir });
    const ex = mentor.catalog.exercises[0]!;
    const { attemptId } = mentor.begin(ex.id, "learn");

    const during = mentor.attemptHistory({ exerciseId: ex.id });
    expect(during.length).toBe(1);
    expect(during[0]!.referenceCode).toBeUndefined();

    mentor.record({ t: "stage", attemptId, stage: "build", by: "agent" });
    mentor.record({ t: "judge", attemptId, ok: true, passed: 4, total: 4 });
    mentor.record({ t: "stage", attemptId, stage: "defend", by: "judge" });
    mentor.record({ t: "probe", attemptId, grade: 2, question: "q1" });
    mentor.record({ t: "probe", attemptId, grade: 2, question: "q2" });
    mentor.record({ t: "done", attemptId });
    mentor.store.saveAttemptSnapshot(attemptId, {
      learnerCode: "# learner solution",
      verdict: { ok: true, passed: 4, total: 4, tests: [], at: Date.now() },
      savedAt: Date.now(),
    });

    const after = mentor.attemptHistory({ exerciseId: ex.id });
    expect(after[0]!.referenceCode).toBe(ex.reference);
    expect(after[0]!.learnerCode).toBe("# learner solution");
    expect(after[0]!.verdict?.ok).toBe(true);
  });

  it("C6: history records per-skill ratings and export/import round-trips without duplicates", () => {
    const dir1 = tempDir();
    const m1 = new Mentor({ dir: dir1 });
    const ex = m1.catalog.exercises[0]!;
    const { attemptId } = m1.begin(ex.id, "learn");
    m1.record({ t: "stage", attemptId, stage: "build", by: "agent" });
    m1.record({ t: "judge", attemptId, ok: true, passed: 4, total: 4 });
    m1.record({ t: "stage", attemptId, stage: "defend", by: "judge" });
    m1.record({ t: "probe", attemptId, grade: 2, question: "q1" });
    m1.record({ t: "probe", attemptId, grade: 2, question: "q2" });
    m1.record({ t: "done", attemptId });

    const h1 = m1.home();
    expect(h1.history.length).toBe(1);
    expect(h1.history[0]!.skills).toBeDefined();
    expect(Object.keys(h1.history[0]!.skills!).length).toBeGreaterThan(0);

    const md = m1.exportProfile({ format: "markdown" });
    expect(md.filename).toMatch(/\.md$/);
    expect(md.content).toContain("# Hồ sơ học tập Mentor");

    const json = m1.exportProfile({ format: "json" });
    expect(json.filename).toMatch(/\.json$/);

    const dir2 = tempDir();
    const m2 = new Mentor({ dir: dir2 });
    const res1 = m2.importProfile(json.content);
    expect(res1.importedEvents).toBeGreaterThan(0);
    expect(m2.home().overall).toBe(h1.overall);

    const res2 = m2.importProfile(json.content);
    expect(res2.importedEvents).toBe(0);
  });

  it("C7: interview mode starts blank at build, refuses hints, allows probes during build, no spaced review", () => {
    const dir = tempDir();
    const mentor = new Mentor({ dir });
    const ex = mentor.catalog.exercises[0]!;
    const { attemptId } = mentor.begin(ex.id, "interview");
    const session = new MentorSession(mentor, attemptId);

    expect(session.attempt.kind).toBe("interview");
    expect(session.attempt.stage).toBe("build");
    expect(session.attempt.scaffold).toBe("blank");
    expect(session.probesNeeded).toBeGreaterThanOrEqual(2);

    expect(() => session.raiseHint()).toThrow(StageRefused);
    expect(() => session.probe(2, "Edge case?")).not.toThrow();

    const playbook = mentorPlaybook(ex, "interview");
    expect(playbook).toContain("mock ML interview");
    const st = mentorState(session, null, "");
    expect(st).toContain("mock interview");
    const cells = exerciseCells(ex, { kind: "interview" });
    expect(cells[0]!.source).toContain("Phỏng vấn thử");

    session.judged({ ok: true, passed: 4, total: 4, tests: [], at: Date.now() });
    session.probe(2, "Complexity?");
    session.setStage("done", "agent");
    expect(session.attempt.stage).toBe("done");
    expect(session.attempt.result?.nextReview).toBeUndefined();
  });

  it("C9: activeMs caps inter-event gaps at 10m and exerciseAnalytics computes stats", () => {
    const catalog = loadCatalog();
    const ex = catalog.exercises[0]!;
    const t0 = Date.UTC(2026, 4, 1, 9, 0, 0);
    const day0 = dayOf(t0);
    const events: MentorEvent[] = [
      { t: "start", attemptId: "a1", exerciseId: ex.id, kind: "learn", scaffold: "full", at: t0, day: day0 },
      { t: "stage", attemptId: "a1", stage: "build", by: "agent", at: t0 + 3 * 60_000, day: day0 },
      { t: "judge", attemptId: "a1", ok: true, passed: 4, total: 4, at: t0 + 123 * 60_000, day: day0 },
      { t: "stage", attemptId: "a1", stage: "defend", by: "judge", at: t0 + 123 * 60_000 + 1000, day: day0 },
      { t: "done", attemptId: "a1", at: t0 + 125 * 60_000 + 1000, day: day0 },
    ];
    const state = fold(events, catalog);
    const a = state.attempts.get("a1")!;
    expect(Math.round(a.activeMs / 60_000)).toBe(15);

    const stats = exerciseAnalytics(state, catalog);
    expect(stats.length).toBe(1);
    expect(stats[0]!.exerciseId).toBe(ex.id);
    expect(stats[0]!.passRate).toBe(1);
    expect(stats[0]!.avgActiveMinutes).toBeCloseTo(15, 0);
  });
});
