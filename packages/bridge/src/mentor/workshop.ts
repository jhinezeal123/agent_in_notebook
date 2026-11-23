// A paper's workshop: a notebook open in Chrome where the mentor reads the
// paper, plans its reproduction with the learner, and has its exercises
// written. Two chats work on it. The workshop chat (shown) plans: it asks the
// learner what they want, reads the paper, proposes a plan (paper_plan) the
// learner approves. The author chat (never shown, same notebook) then writes
// each component as an exercise in drafts/, and the machine checks it
// (verify.ts) before it goes on the shelf: the learner never sees a reference
// solution, a test or a broken solution.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ExecResult, MentorPaperPlan, MentorWorkshop } from "@ainb/protocol";
import { Denied, TOOLS, tool, type ToolContext, type ToolDef } from "../notebook/tools.js";
import { loadExercise, type Exercise } from "./catalog.js";
import type { Mentor } from "./index.js";
import { paperEventId } from "./model.js";
import { starStates, overallOf } from "./model.js";
import { checkPlan, paperExerciseId, PaperShelf, PlanSchema, slugOf } from "./papers.js";
import { KernelPool } from "./pool.js";
import { referenceContext, reportText, trainsOnGpu, verifyExercise, type VerifyReport } from "./verify.js";

/** Checks the author may run on one component before it is given up. */
export const CHECKS_PER_COMPONENT = 4;
/** Author turns on one component before it is given up. */
const TURNS_PER_COMPONENT = 3;
const SOURCE_PAGE = 40_000;
/** What the author sets in a draft's meta.json; everything else comes from the plan the learner approved. */
const AUTHOR_META = ["requires", "functions", "prelude", "probes", "judgeSeconds", "predict"] as const;

type Exec = (code: string, waitMs: number) => Promise<Pick<ExecResult, "status" | "outputs" | "message">>;

export interface AuthorChat {
  send(text: string, context: string): void;
  /** Resolves when the turn (and any queued) is over. */
  whenIdle(signal: AbortSignal): Promise<void>;
  close(): void;
}

export interface WorkshopHost {
  /** The hidden chat that writes the exercises, on the workshop's tab. */
  authorChat(paperId: string, tabId: number): AuthorChat;
  /** Run code on the workshop notebook's machine (throws when it cannot: the machine is off, the tab is gone). */
  exec(tabId: number, code: string, waitMs: number): Promise<Pick<ExecResult, "status" | "outputs" | "message">>;
  /** A line for the learner, in the workshop's chat. */
  say(paperId: string, text: string): void;
  /** The workshop (or the shelf) changed. */
  changed(paperId: string): void;
  log(message: string): void;
}

type Progress = NonNullable<MentorWorkshop["authoring"]>;

/** The plan without what may change without the learner's say: difficulties follow their rating, the machine is probed each time. */
function planKey(plan: MentorPaperPlan): string {
  return JSON.stringify({ goal: plan.goal, components: plan.components.map(({ difficulty: _difficulty, ...c }) => c), experiment: plan.experiment });
}

/** Workshops of all papers: plans, and the exercises being written. */
export class WorkshopHub {
  private readonly progress = new Map<string, Progress>();
  private readonly checks = new Map<string, number>();
  private readonly lastReport = new Map<string, VerifyReport>();
  /** Drafts that passed and went on the shelf during the run in progress (paper/slug). */
  private readonly fresh = new Set<string>();
  /** Shared KernelPool per active authoring paper on persistent kernels (A7.3). */
  private readonly pools = new Map<string, KernelPool>();
  /** Why the run in progress cannot go on (the machine is off), by paper: it stops without blaming the exercises. */
  private readonly halted = new Map<string, { why: string; advice: string }>();
  private readonly listeners = new Set<(paperId: string) => void>();

  constructor(readonly mentor: Mentor, private readonly host: WorkshopHost) {}

  get shelf(): PaperShelf {
    return this.mentor.shelf;
  }

  subscribe(listener: (paperId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(paperId: string): void {
    for (const l of this.listeners) l(paperId);
    this.host.changed(paperId);
  }

  private written(paperId: string, slug: string): boolean {
    return !!this.mentor.catalog.exercise(paperExerciseId(paperId, slug));
  }

  /** How far the writing is, from what is on the shelf. */
  private counts(paperId: string): Pick<Progress, "done" | "total" | "failed"> {
    const info = this.shelf.read(paperId);
    const built = info.plan?.components.filter((c) => c.mode === "build") ?? [];
    return {
      done: built.filter((c) => this.written(paperId, c.slug)).length,
      total: built.length,
      failed: built.filter((c) => info.failed[c.slug] && !this.written(paperId, c.slug)).length,
    };
  }

  view(paperId: string): MentorWorkshop {
    const info = this.shelf.read(paperId);
    const progress = this.progress.get(paperId);
    const reported = Object.entries(info.reports).flatMap(([slug, reason]) => {
      const c = info.plan?.components.find((x) => x.slug === slug);
      return c && this.written(paperId, slug) ? [{ slug, title: c.title, reason }] : [];
    });
    return {
      paperId,
      title: info.title,
      // A shelved paper's workshop starts at reading it.
      status: info.status === "shelved" ? "reading" : info.status,
      ...(info.plan ? { plan: info.plan } : {}),
      approved: info.approved,
      ...(info.approved ? { authoring: progress ?? { ...this.counts(paperId), running: false } } : {}),
      reported,
    };
  }

  /** The agent's plan: checked, clamped, saved, shown. A plan that changes what the learner approved waits for their approval again. */
  setPlan(paperId: string, raw: MentorPaperPlan): string[] {
    const stars = new Set(this.mentor.catalog.stars.map((s) => s.id));
    const { problems, plan } = checkPlan(raw, { stars, rating: this.mentor.rating() });
    if (problems.length) return problems;
    const info = this.shelf.read(paperId);
    let approved = info.approved;
    if (info.plan) {
      // Components already written stay as they are: the learner may have done them, and later ones call their functions.
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      for (const old of info.plan.components) {
        if (old.mode !== "build" || !this.written(paperId, old.slug)) continue;
        const now = plan.components.find((c) => c.slug === old.slug);
        if (!now || now.mode !== "build" || now.title !== old.title || !same(now.uses, old.uses) || !same(now.functions, old.functions)) {
          return [`Component ${old.slug} is already written as an exercise: keep its slug, title, functions and uses. (When it is wrong, the learner reports it and it is written again.)`];
        }
      }
      // So do a written experiment's numbers: its pass marks are in the exercise.
      const experiment = info.plan.components.find((c) => c.role === "experiment");
      if (experiment && this.written(paperId, experiment.slug) && !same(plan.experiment.metrics, info.plan.experiment.metrics)) {
        return ["The experiment is already written as an exercise: keep its metrics and pass marks. (When they are wrong, the learner reports the experiment and it is written again.)"];
      }
      if (approved && planKey(plan) !== planKey(info.plan)) approved = false;
    }
    this.shelf.write(paperId, {
      plan, title: plan.title, ...(plan.authors ? { authors: plan.authors } : {}), ...(plan.year ? { year: plan.year } : {}), goal: plan.goal,
      approved, status: approved ? info.status : "planning",
    });
    this.mentor.reloadPapers();
    this.changed(paperId);
    return [];
  }

  approve(paperId: string): MentorWorkshop {
    const info = this.shelf.read(paperId);
    if (!info.plan) throw new Error("Mentor chưa đưa kế hoạch nào.");
    if (!info.approvedOnce) this.mentor.record({ t: "paper", attemptId: paperEventId(paperId), paperId, what: "planned" });
    this.shelf.write(paperId, { approved: true, approvedOnce: true, status: "authoring" });
    this.mentor.reloadPapers();
    this.changed(paperId);
    return this.view(paperId);
  }

  /** The learner reported an exercise of one of their papers as wrong: kept with the paper, to write it again. False when it is not such an exercise. */
  report(paperId: string, exerciseId: string, reason: string): boolean {
    if (!this.shelf.has(paperId)) return false;
    const info = this.shelf.read(paperId);
    const slug = slugOf(paperId, exerciseId);
    if (!info.plan?.components.some((c) => c.slug === slug && c.mode === "build")) return false;
    const all = [info.reports[slug], reason.trim()].filter(Boolean).join("\n").slice(-1500);
    this.shelf.write(paperId, { reports: { ...info.reports, [slug]: all } });
    // The shelf shows the paper as the catalog read it.
    this.mentor.reloadPapers();
    this.changed(paperId);
    return true;
  }

  /** Is the author at work on this paper? */
  running(paperId: string): boolean {
    return !!this.progress.get(paperId)?.running;
  }

  /** Why the workshop notebook's machine cannot run code now, or null when it can. */
  private async machineProblem(tabId: number): Promise<string | null> {
    try {
      const res = await this.host.exec(tabId, "print('ainb-ok')", 20_000);
      const text = res.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
      return text.includes("ainb-ok") ? null : "máy của notebook xưởng không trả lời (đang bận hoặc chưa bật).";
    } catch (e) {
      return `máy của notebook xưởng không chạy được code (${(e as Error).message.slice(0, 160)}).`;
    }
  }

  private halt(paperId: string, why: string, advice = "Bật máy của notebook xưởng (nút nguồn trên Kaggle), rồi bấm “Soạn tiếp”."): void {
    if (!this.halted.has(paperId)) this.halted.set(paperId, { why, advice });
  }

  /**
   * Write the plan's components that are not exercises yet, one at a time in
   * the order they build on each other, each checked by the machine.
   * `retry`: also the ones that could not be written before. `slug`: that one
   * only, again, even when it is on the shelf (the learner reported it as
   * wrong; what they said goes to the author). Stops when `signal` aborts, or
   * when the notebook's machine stops answering (nothing is blamed for that).
   */
  async author(paperId: string, tabId: number, opts: { slug?: string; retry?: boolean; signal: AbortSignal }): Promise<void> {
    if (this.running(paperId)) throw new Error("Mentor đang soạn bài cho paper này.");
    let info = this.shelf.read(paperId);
    if (!info.plan || !info.approved) throw new Error("Duyệt kế hoạch trước, rồi mentor mới soạn bài.");
    const plan = info.plan;
    const built = plan.components.filter((c) => c.mode === "build");
    if (opts.slug && !built.some((c) => c.slug === opts.slug)) throw new Error(`Kế hoạch không có thành phần "${opts.slug}".`);
    const exists = (slug: string) => this.written(paperId, slug);
    const key = (slug: string) => `${paperId}/${slug}`;
    /** The exercise written again while it stays on the shelf. */
    const rewrite = opts.slug && exists(opts.slug) ? opts.slug : undefined;
    const titleOf = (slug: string) => plan.components.find((c) => c.slug === slug)?.title ?? slug;

    // What could not be written is tried again when asked to.
    const failed = opts.slug ? Object.fromEntries(Object.entries(info.failed).filter(([slug]) => slug !== opts.slug)) : opts.retry ? {} : info.failed;
    info = this.shelf.write(paperId, { failed, status: "authoring" });
    const todo = built.filter((c) => (opts.slug ? c.slug === opts.slug : !exists(c.slug) && !info.failed[c.slug]));
    const progress: Progress = { ...this.counts(paperId), running: true };
    this.progress.set(paperId, progress);
    this.halted.delete(paperId);
    this.changed(paperId);
    const stopped = () => opts.signal.aborted || this.halted.has(paperId);
    let chat: AuthorChat | null = null;
    try {
      const down = await this.machineProblem(tabId);
      if (down) {
        this.halt(paperId, down);
        return;
      }
      await this.startPool(paperId, tabId);
      chat = this.host.authorChat(paperId, tabId);
      const givenNeeded = plan.components.some((c) => c.mode === "given") && !this.shelf.read(paperId).given.trim();
      if (givenNeeded && !stopped()) {
        progress.current = "Code cho sẵn";
        progress.note = "đang viết";
        this.changed(paperId);
        chat.send("Viết phần code cho sẵn của paper.", givenTask(plan));
        await chat.whenIdle(opts.signal);
        if (!stopped() && !this.shelf.read(paperId).given.trim()) {
          const off = await this.machineProblem(tabId);
          this.halt(paperId, off ?? "mentor chưa viết được phần code cho sẵn của paper, mà các bài đều cần nó.", off ? undefined : "Bấm “Soạn tiếp” để thử lại.");
        }
      }
      for (const c of todo) {
        if (stopped()) break;
        // A component whose base is not written cannot pass its check: it waits, at no cost.
        const waiting = c.uses.filter((u) => !exists(u));
        if (waiting.length) {
          this.shelf.write(paperId, { failed: { ...this.shelf.read(paperId).failed, [c.slug]: `chờ bài ${waiting.map((u) => `“${titleOf(u)}”`).join(", ")} (chưa soạn được)` } });
          progress.failed++;
          this.changed(paperId);
          continue;
        }
        progress.current = c.title;
        progress.note = rewrite === c.slug ? "đang soạn lại" : "đang soạn";
        this.checks.set(key(c.slug), 0);
        this.fresh.delete(key(c.slug));
        if (rewrite === c.slug) {
          this.shelf.seedDraft(paperId, c.slug);
          this.lastReport.delete(key(c.slug));
        }
        this.changed(paperId);
        const done = () => (rewrite === c.slug ? this.fresh.has(key(c.slug)) : exists(c.slug));
        for (let turn = 1; turn <= TURNS_PER_COMPONENT && !done() && !stopped(); turn++) {
          if ((this.checks.get(key(c.slug)) ?? 0) >= CHECKS_PER_COMPONENT) break;
          chat.send(`${rewrite === c.slug ? "Soạn lại bài" : "Soạn bài"}: ${c.title}`, authorTask(plan, c.slug, turn, {
            last: this.lastReport.get(key(c.slug)),
            ...(rewrite === c.slug ? { reported: info.reports[c.slug] ?? "" } : {}),
          }));
          await chat.whenIdle(opts.signal);
        }
        if (done()) {
          if (rewrite === c.slug) await this.rewritten(paperId, c.slug, tabId, progress);
          else progress.done++;
        } else if (!stopped()) {
          // Not written: the exercise's fault only when the machine is still there.
          const off = await this.machineProblem(tabId);
          if (off) {
            this.halt(paperId, off);
            break;
          }
          const why = this.lastReport.get(key(c.slug))?.checks.filter((x) => !x.ok).map((x) => `${x.id}: ${x.note ?? ""}`).join("; ") || "mentor không soạn xong";
          if (rewrite === c.slug) {
            this.host.say(paperId, `Mentor chưa soạn lại được bài “${c.title}” (${why.slice(0, 200)}). Bài cũ vẫn còn; bạn có thể bấm soạn lại lần nữa.`);
          } else {
            this.shelf.write(paperId, { failed: { ...this.shelf.read(paperId).failed, [c.slug]: why.slice(0, 300) } });
            progress.failed++;
          }
        }
        this.changed(paperId);
      }
    } finally {
      chat?.close();
      const pool = this.pools.get(paperId);
      this.pools.delete(paperId);
      await pool?.close().catch(() => {});
      const halted = this.halted.get(paperId);
      this.halted.delete(paperId);
      const now = this.shelf.read(paperId);
      // Ready once every component is an exercise: one that could not be written keeps the paper in the writing step.
      const left = built.filter((c) => !exists(c.slug)).length;
      this.shelf.write(paperId, { status: left ? "authoring" : "ready" });
      this.mentor.reloadPapers();
      this.progress.set(paperId, {
        ...this.counts(paperId), running: false,
        ...(halted ? { note: `đã dừng: ${halted.why}` } : opts.signal.aborted ? { note: "đã dừng" } : {}),
      });
      this.changed(paperId);
      if (halted) this.host.say(paperId, `Mentor dừng soạn bài: ${halted.why} ${halted.advice}`);
    }
  }

  /** Start a shared KernelPool for this authoring run when the workshop kernel persists globals (A7.3). */
  private async startPool(paperId: string, tabId: number): Promise<void> {
    try {
      await this.host.exec(tabId, 'globals()["_ainb_pool_probe"] = 1', 15_000);
      const check = await this.host.exec(tabId, 'print("<<POOL-PERSIST " + ("1" if globals().pop("_ainb_pool_probe", None) == 1 else "0") + ">>")', 15_000);
      const out = check.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
      if (!out.includes("<<POOL-PERSIST 1>>")) return;
      const pool = new KernelPool((code, waitMs) => this.host.exec(tabId, code, waitMs));
      await pool.start();
      this.pools.set(paperId, pool);
    } catch {
      // Non-persistent or busy kernel: fall back cleanly to sequential verification.
    }
  }

  private async verifyOnWorkshop(paperId: string, ex: Exercise, exec: Exec): Promise<VerifyReport> {
    const context = referenceContext(this.mentor.catalog, ex);
    const pool = this.pools.get(paperId);
    if (pool) {
      try {
        return await verifyExercise(ex, pool.exec(ex.id, trainsOnGpu(ex, context)), { context, concurrent: true });
      } catch {
        // Pool lost (e.g. kernel restarted): drop pool and fall back once to direct exec.
        this.pools.delete(paperId);
        await pool.close().catch(() => {});
      }
    }
    return verifyExercise(ex, exec, { context });
  }

  /**
   * An exercise was written again: the report is answered, what the learner
   * did on the old version no longer counts, and the exercises built on it
   * are checked against the new one (one that no longer passes is flagged to
   * be written again too).
   */
  private async rewritten(paperId: string, slug: string, tabId: number, progress: Progress): Promise<void> {
    const reports = { ...this.shelf.read(paperId).reports };
    delete reports[slug];
    this.shelf.write(paperId, { reports });
    const id = paperExerciseId(paperId, slug);
    this.mentor.voidExercise(id, "Bài đã được soạn lại.");
    const catalog = this.mentor.catalog;
    const builtOn = (ex: Exercise): boolean => ex.uses.some((u) => u === id || builtOn(catalog.exercise(u) ?? ({ uses: [] } as unknown as Exercise)));
    const deps = catalog.exercises.filter((e) => e.paper === paperId && e.id !== id && builtOn(e));
    const exec: Exec = (code, waitMs) => this.host.exec(tabId, code, waitMs);
    const recordFailure = (dep: Exercise, report: VerifyReport) => {
      if (report.ok) return;
      const depSlug = slugOf(paperId, dep.id);
      const why = report.checks.filter((x) => !x.ok).map((x) => `${x.id}: ${x.note ?? ""}`).join("; ");
      const now = this.shelf.read(paperId).reports;
      this.shelf.write(paperId, { reports: { ...now, [depSlug]: [now[depSlug], `Bài “${this.shelf.read(paperId).plan?.components.find((c) => c.slug === slug)?.title ?? slug}” mà nó dựng trên vừa được soạn lại, và bài này không còn qua kiểm chứng (${why.slice(0, 300)}).`].filter(Boolean).join("\n") } });
    };
    if (this.pools.has(paperId) && deps.length > 1) {
      progress.current = deps.map((d) => d.title).join(", ");
      progress.note = "kiểm lại song song vì bài dựng trên đã đổi";
      this.changed(paperId);
      await Promise.all(deps.map(async (dep) => {
        if (this.halted.has(paperId)) return;
        try {
          recordFailure(dep, await this.verifyOnWorkshop(paperId, dep, exec));
        } catch (e) {
          this.halt(paperId, `máy của notebook xưởng không chạy được code (${(e as Error).message.slice(0, 160)}).`);
        }
      }));
      return;
    }
    for (const dep of deps) {
      if (this.halted.has(paperId)) break;
      progress.current = dep.title;
      progress.note = "kiểm lại vì bài nó dựng trên đã đổi";
      this.changed(paperId);
      let report: VerifyReport;
      try {
        report = await this.verifyOnWorkshop(paperId, dep, exec);
      } catch (e) {
        this.halt(paperId, `máy của notebook xưởng không chạy được code (${(e as Error).message.slice(0, 160)}).`);
        break;
      }
      recordFailure(dep, report);
    }
  }

  // ------------------------------------------------------------ drafts

  component(paperId: string, slug: string): MentorPaperPlan["components"][number] {
    const c = this.shelf.read(paperId).plan?.components.find((x) => x.slug === slug);
    if (!c) throw new Denied(`No component "${slug}" in the plan.`);
    if (c.mode !== "build") throw new Denied(`Component "${slug}" is given code: write it with paper_given_write.`);
    return c;
  }

  /**
   * A draft file. meta.json keeps from the author only what the plan does not
   * decide (AUTHOR_META, and the metrics' units): the title, the skills, the
   * difficulty, the minutes, the links and an experiment's pass marks are the
   * plan's, as the learner approved it.
   */
  writeDraft(paperId: string, slug: string, file: string, content: string): string {
    const c = this.component(paperId, slug);
    if (file === "meta.json") {
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(content) as Record<string, unknown>;
      } catch (e) {
        throw new Denied(`meta.json is not JSON: ${(e as Error).message}`);
      }
      const plan = this.shelf.read(paperId).plan!;
      const id = paperExerciseId(paperId, slug);
      const own = Object.fromEntries(AUTHOR_META.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));
      const units = new Map<string, string>();
      for (const m of Array.isArray(meta.metrics) ? meta.metrics as { name?: unknown; unit?: unknown }[] : []) {
        if (m && typeof m.name === "string" && typeof m.unit === "string") units.set(m.name, m.unit);
      }
      const fixed = {
        requires: ["numpy"], probes: 2,
        ...own,
        id, star: id, title: c.title, skills: c.skills, difficulty: c.difficulty, minutes: c.minutes,
        paper: paperId, author: "ai", role: c.role, cites: c.cites,
        uses: c.uses.map((u) => paperExerciseId(paperId, u)),
        ...(c.role === "experiment" ? {
          judge: "kernel",
          metrics: plan.experiment.metrics.map((m) => ({ name: m.name, paper: m.paper, ...(units.has(m.name) ? { unit: units.get(m.name) } : {}), target: m.target })),
        } : {}),
      };
      content = `${JSON.stringify(fixed, null, 2)}\n`;
    }
    this.shelf.writeDraft(paperId, slug, file, content);
    return file === "meta.json" ? "meta.json saved (the bridge set id, star, title, skills, difficulty, minutes, paper, author, role, cites, uses and, for the experiment, the metrics with their pass marks, from the plan)." : `${file} saved.`;
  }

  /** Check a draft on the workshop's machine; a passing one goes on the shelf. */
  async check(paperId: string, slug: string, exec: Exec): Promise<VerifyReport> {
    this.component(paperId, slug);
    const key = `${paperId}/${slug}`;
    const n = (this.checks.get(key) ?? 0) + 1;
    if (n > CHECKS_PER_COMPONENT) throw new Denied(`This component was checked ${CHECKS_PER_COMPONENT} times already; stop and say what keeps failing.`);
    const id = paperExerciseId(paperId, slug);
    let ex: Exercise;
    try {
      ex = { ...loadExercise(this.shelf.draftDir(paperId, slug), id), paper: paperId, star: id, author: "ai" };
    } catch (e) {
      throw new Denied(`The draft does not load: ${(e as Error).message}`);
    }
    const progress = this.progress.get(paperId);
    if (progress) {
      progress.note = `đang kiểm chứng lần ${n}`;
      this.changed(paperId);
    }
    // A machine that does not answer is nobody's failed check: the writing stops until it is back.
    const machineDown = (why: string): never => {
      this.halt(paperId, why);
      throw new Denied("The notebook's machine cannot run code now, so nothing was checked. Stop here: the learner has to turn it on.");
    };
    let report: VerifyReport;
    try {
      report = await this.verifyOnWorkshop(paperId, ex, exec);
    } catch (e) {
      return machineDown(`máy của notebook xưởng không chạy được code (${(e as Error).message.slice(0, 160)}).`);
    }
    const modules = report.checks.find((c) => c.id === "modules");
    if (modules && !modules.ok && !/^thiếu /.test(modules.note ?? "")) return machineDown("máy của notebook xưởng không trả lời (đang bận hoặc chưa bật).");
    this.checks.set(key, n);
    this.lastReport.set(key, report);
    if (report.ok) {
      this.shelf.publish(paperId, slug, report);
      this.fresh.add(key);
      this.mentor.reloadPapers();
    } else if (progress) {
      progress.note = `lần ${n}: ${report.checks.find((c) => !c.ok)?.id ?? "hỏng"}`;
    }
    this.changed(paperId);
    return report;
  }

  /** The paper's shared given code: fixed once an exercise is verified against it. */
  saveGiven(paperId: string, code: string): void {
    if (this.mentor.catalog.exercises.some((e) => e.paper === paperId)) {
      throw new Denied("The paper's given code is fixed: exercises are already verified against it and the learner may have done them. Put what this exercise needs in its own given.py.");
    }
    this.shelf.saveGiven(paperId, code);
    this.mentor.reloadPapers();
    this.changed(paperId);
  }
}

/** One chat's side of a workshop: planning (shown) or writing exercises (hidden). */
export class WorkshopSession {
  constructor(readonly hub: WorkshopHub, readonly paperId: string, readonly role: "plan" | "author") {}

  view(): MentorWorkshop {
    return this.hub.view(this.paperId);
  }

  tools(): readonly ToolDef<z.ZodType, any>[] {
    return this.role === "author" ? AUTHOR_CHAT_TOOLS : PLAN_CHAT_TOOLS;
  }

  playbook(): string {
    return this.role === "author" ? authorPlaybook(this.hub.mentor, this.paperId) : planPlaybook(this.hub.mentor, this.paperId);
  }

  /** The workshop's state, every turn. */
  state(): string {
    const v = this.view();
    const lines = [`Paper: ${v.title} (id ${v.paperId}). Status: ${v.status}${v.approved ? ", plan approved" : v.plan ? ", plan proposed, not approved yet" : ", no plan yet"}.`];
    const info = this.hub.shelf.read(this.paperId);
    if (info.source) lines.push(`Its text: ${info.source.chars} characters, from ${info.source.kind === "latex" ? "the arXiv LaTeX source (formulas exact)" : info.source.kind === "alphaxiv" ? "alphaXiv's extracted text (formulas may be flattened)" : "a PDF (formulas may be garbled: ask the learner to check them against the PDF)"}; read it with paper_source.`);
    if (v.authoring) lines.push(`Exercises written: ${v.authoring.done}/${v.authoring.total}${v.authoring.failed ? `, ${v.authoring.failed} could not be written` : ""}${v.authoring.running ? " (writing now)" : ""}.`);
    if (this.role === "plan") {
      const m = this.hub.mentor;
      const st = m.state();
      const overall = overallOf(st.ratings);
      const stars = starStates(st, m.catalog);
      const learnt = [...stars.entries()].filter(([, v]) => v === "mastered").map(([id]) => id);
      lines.push(`The learner: overall rating ${overall ?? "none yet"}; stars learnt: ${learnt.join(", ") || "none"}.`);
    }
    return `<workshop-state>\n${lines.join("\n")}\n</workshop-state>`;
  }
}

// ------------------------------------------------------------ prompts

const DATASETS = [
  "data generated in given.py (random tensors, toy sequences such as reversing or copying strings, mixtures of Gaussians)",
  "sklearn.datasets bundled with sklearn (load_digits, make_moons, make_circles; no download)",
  "torchvision MNIST, FashionMNIST, CIFAR-10 (download: needs the notebook's Internet turned on)",
  "a small text embedded in given.py (a few KB)",
  "a pure-numpy environment written in given.py for RL (CartPole dynamics, a gridworld, bandits); no gym",
];

function planPlaybook(mentor: Mentor, paperId: string): string {
  const stars = mentor.catalog.stars.filter((s) => !s.constellation.startsWith("paper:")).map((s) => `${s.id} (${s.name})`).join(", ");
  return `<mentor-paper>
You are the learner's mentor, in the workshop of a paper they want to reproduce. The workshop is a Kaggle notebook open in Chrome (its machine has numpy, matplotlib, PyTorch; you may run scratch code there with run_code). The learner is a PhD student with a competitive-programming background, strong on theory, weak at turning papers into code. Speak Vietnamese, keep technical terms in English, keep messages short. Use LaTeX ($...$) for formulas.

Your job here is the plan, not the code:
1. First ask the learner two things, one message: what they want from the paper (understand the method / reproduce the main result at a small scale / build on it for their research), and how many sessions of 20–40 minutes they will give it (default 5–8).
2. Read the paper with paper_source (in pages; read what you need for the plan: method, algorithms, the main results table).
3. Propose a reproduction plan with paper_plan. Rules:
   - 3 to 10 components, in the order they build on each other; each one session or less (minutes 10–40). The last is the experiment: the learner writes the training loop, trains a scaled-down version on the notebook's machine in at most 15 minutes, and the judge measures it.
   - Every idea of the paper is "build" (the learner types it). Only what is not the paper's idea may be "given": data loading, plotting, boilerplate (a standard U-Net, a ResNet backbone the paper does not change). Say why in "why".
   - Each component cites where it is in the paper (an equation, a section, an algorithm, a figure), names its functions with signatures and shapes (the interface is fixed for the whole chain: later components call these functions), and lists in "uses" the earlier built components it calls.
   - difficulty: on the learner's scale (800–2400; LayerNorm is 1350, scaled dot-product attention 1550, a transformer block 1850); the bridge keeps it within reach of their rating.
   - The experiment: the dataset from this list only: ${DATASETS.join("; ")}. Metrics: the paper's number and where it is, and a target the scaled-down version should reach (the judge's pass mark).
   - requires: star ids from the map worth knowing first: ${stars}.
   paper_plan checks the machine (GPU, Internet) and refuses a plan that breaks a rule, saying why: fix it and call again.
4. The learner sees the plan as a card with an "Duyệt kế hoạch" button. Discuss changes they ask for and call paper_plan again with the whole updated plan. Once they approve, the exercises are written in the background (you do not write them, and never write solution code for the components here); the learner then does them from the paper shelf.
5. If the paper cannot be scaled down to 15 minutes of training, say so plainly and propose reproducing one part (one table, one figure, one ablation).
</mentor-paper>`;
}

function readExample(mentor: Mentor): string {
  const dir = join(mentor.catalog.dir, "exercises", "layernorm");
  const file = (f: string) => {
    try {
      return readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim();
    } catch {
      return "";
    }
  };
  const mutant = file("mutants/eps-outside.py");
  return [
    "meta.json:\n```json\n" + file("meta.json") + "\n```",
    "brief.md:\n```markdown\n" + file("brief.md") + "\n```",
    "starter.py:\n```python\n" + file("starter.py") + "\n```",
    "tests.py:\n```python\n" + file("tests.py") + "\n```",
    "probes.json:\n```json\n" + file("probes.json") + "\n```",
    mutant ? "mutants/eps-outside.py:\n```python\n" + mutant + "\n```" : "",
  ].filter(Boolean).join("\n\n");
}

function authorPlaybook(mentor: Mentor, paperId: string): string {
  const info = mentor.shelf.read(paperId);
  return `<mentor-author>
You write the exercises of a paper's reproduction plan, one component at a time, for a learner who will implement each one themself. The learner never sees what you write here except the brief, the lab, the starter and the given code; the reference solution, the tests and the broken solutions stay hidden. You work in the paper's workshop notebook on Kaggle (numpy, matplotlib, PyTorch); try code there with run_code before you save it.

The plan:
\`\`\`json
${JSON.stringify(info.plan, null, 2)}
\`\`\`

An exercise is a folder of files you write with paper_exercise_write (component = its slug):
- meta.json: {"requires" (Python modules the tests import, e.g. ["numpy","torch"]), "functions" (names the learner defines; the tests call them), "prelude" (imports run before the learner's code, e.g. "import numpy as np\\nimport torch"), "probes" (2), "judgeSeconds" (60; an experiment's reference trains, so up to 900), and for the experiment "predict" (the question the learner answers before training) and optionally "metrics" [{"name","unit"}] for the units}. Everything else is the plan's, as the learner approved it, and the bridge sets it: id, star, title, skills, difficulty, minutes, paper, author, role, cites, uses, and the experiment's metrics with their pass marks.
- brief.md: the task in Vietnamese (technical terms in English): what to implement, the signature with shapes, the formula quoted from the paper with where it is (${"`"}cites${"`"}), edge cases. Never the solution.
- lab.py (optional, for formula and component roles): "Phòng công thức" cells in percent format (${"`"}# %%${"`"} code, ${"`"}# %% [markdown]${"`"} markdown): a small runnable example and a matplotlib figure that builds intuition for the formula, without giving the code of the solution.
- starter.py: the functions' signatures with docstrings (shapes in and out) and ${"`"}raise NotImplementedError${"`"}.
- given.py (optional): code given with this exercise only (the paper's shared given code is separate, written once before the first exercise and fixed after that).
- reference.py: the reference solution. It may call the functions of the components in "uses" by name: their reference solutions run before it (and the learner's own passing solutions run before the learner's code).
- tests.py: at least 4 functions ${"`"}def test_<name>(user, ref):${"`"} with a one-line docstring in Vietnamese (shown to the learner as the test's name). ${"`"}user${"`"} and ${"`"}ref${"`"} are dicts of the learner's and the reference's namespaces; get a function with ${"`"}need(user, "name")${"`"}. Helpers in ${"`"}t${"`"}: t.seed(n), t.close(got, want, tol=1e-5, what=...), t.shape(x, shape, what=...), t.grad_close(f_user, f_ref, *inputs), t.load_into(module, ref_module) (copy weights by parameter name), t.report(name, value) (an experiment's measured number). Assertion messages in Vietnamese, without the answer. Compare with the reference on random inputs (CPU, float32, tol 1e-5; 1e-4 for long computations), check shapes, gradients when it matters, edge cases.
- probes.json: at least 3 probing questions [{"q","tag","answer"}] for the defence: why a line is needed, what breaks without it, a shape, an edge case — answer is what a right answer says.
- mutants/<name>.py: at least 3 deliberately broken solutions, each a plausible mistake (a wrong axis, a missing term, an off-by-one, a forgotten detach), each must run and fail at least one test.
The experiment: reference.py is the training loop that trains the model and leaves it in the namespace (for example as ${"`"}model${"`"}); its tests measure that model on data they make (they never train) and call t.report(name, value) for each metric of the plan, with exactly the plan's metric names. The judge itself compares each reported number with the plan's pass mark (do not assert the pass mark in a test: assert only what makes the measurement meaningful, such as the model being there). If the reference cannot reach a pass mark in the time allowed, do not weaken anything: stop and say so, the plan has to change. Its mutant is an untrained model (build it, skip training): it must fail. Keep training at most ${info.plan?.experiment.trainMinutes ?? 10} minutes.

When the files are written, call paper_exercise_check: the machine runs the reference twice, the starter, every broken solution and the lab, and checks nothing of the reference shows in the learner's notebook. A failing check says why: fix the files and check again. A passing one puts the exercise on the shelf; then stop and wait for the next task.

Never put the reference's lines in the brief, the lab, the starter or the given code. Do not use your own file or shell tools (they are refused): only the tools of this server.

Here is a curated exercise, as an example of the level of care (LayerNorm):
${readExample(mentor)}
</mentor-author>`;
}

function givenTask(plan: MentorPaperPlan): string {
  const given = plan.components.filter((c) => c.mode === "given");
  return `<author-task kind="given">
Write the paper's shared given code with paper_given_write: ${given.map((c) => `${c.title} (${c.cites}): ${c.why}`).join("; ")}. Also the experiment's data (${plan.experiment.dataset}) loading, as functions the exercises can call. It runs before every exercise of the paper (in the learner's notebook and in the judge), so keep it to definitions and cheap setup: no training, no downloads at import time (download inside a function). Run it once with run_code to make sure it works.
</author-task>`;
}

function authorTask(plan: MentorPaperPlan, slug: string, turn: number, opts: { last?: VerifyReport; reported?: string } = {}): string {
  const i = plan.components.findIndex((c) => c.slug === slug);
  const c = plan.components[i]!;
  const used = c.uses.map((u) => plan.components.find((x) => x.slug === u)).filter(Boolean).map((u) => `${u!.slug}: ${u!.functions.join("; ")}`);
  const again = opts.reported !== undefined;
  return `<author-task component="${slug}" turn="${turn}"${again ? ' kind="rewrite"' : ""}>
${again ? "Write again" : turn === 1 ? "Write" : "Finish"} the exercise for component ${i + 1}/${plan.components.length}: ${c.title} (${c.role}, ${c.cites}).
Why: ${c.why}
Functions: ${c.functions.join("; ") || "(the experiment: the training loop)"}
${used.length ? `It uses (their functions are defined before the learner's code): ${used.join(" | ")}` : "It uses no earlier component."}
${again ? `This exercise is on the learner's shelf, and they reported it as wrong:
"""
${opts.reported || "(no reason given)"}
"""
Its files are in the draft again (paper_exercise_read). Read the passage of the paper again with paper_source (${c.cites}), find what is actually wrong (the brief, a test, the reference solution), and fix it; keep the functions' names and signatures (other exercises call them). If the learner is mistaken and the exercise agrees with the paper, make the brief clear on that very point. Then check: only a passing check replaces the exercise.` : ""}
${opts.last && !opts.last.ok ? `The last check failed:\n${reportText(opts.last)}` : ""}
Write the files with paper_exercise_write (component "${slug}"), then call paper_exercise_check.
</author-task>`;
}

// ------------------------------------------------------------ tools

export interface WorkshopToolContext extends ToolContext {
  workshop: WorkshopSession;
}

const KEPT = new Set(["kernel_state", "read_output", "run_code", "wait_for_code", "interrupt_kernel"]);

const MACHINE_PROBE = String.raw`
def _ainb_probe():
    import importlib.util, json, socket
    gpu, torch = False, None
    if importlib.util.find_spec("torch") is not None:
        import torch as _t
        torch, gpu = _t.__version__, bool(_t.cuda.is_available())
    try:
        socket.create_connection(("pypi.org", 443), timeout=3).close()
        net = True
    except OSError:
        net = False
    print("<<MENTOR-PROBE " + json.dumps({"gpu": gpu, "internet": net, "torch": torch}) + " MENTOR-PROBE>>")
try:
    _ainb_probe()
finally:
    del _ainb_probe
`.trimStart();

const paperSource = tool<z.ZodObject<{ offset: z.ZodOptional<z.ZodNumber> }>, WorkshopToolContext>({
  name: "paper_source",
  description: "Read the paper's text (LaTeX when it came from arXiv), in pages of 40 000 characters; offset continues.",
  schema: z.object({ offset: z.number().int().min(0).optional() }),
  async run(ctx, a) {
    const text = ctx.workshop.hub.shelf.source(ctx.workshop.paperId);
    const start = Math.min(a.offset ?? 0, text.length);
    const end = Math.min(text.length, start + SOURCE_PAGE);
    const more = end < text.length ? `\n\n(characters ${start}-${end} of ${text.length}; continue with offset=${end})` : "";
    return { text: (text.slice(start, end) || "The paper's text is empty.") + more };
  },
});

export const PLAN_TOOLS = [
  paperSource,
  tool({
    name: "paper_plan",
    description: "Propose (or update) the reproduction plan: the learner sees it as a card to approve. Give the whole plan each time. Refused with reasons when it breaks a rule.",
    schema: PlanSchema,
    async run(ctx: WorkshopToolContext, plan) {
      let machine: MentorPaperPlan["machine"];
      try {
        const res = await ctx.call({ op: "execute", code: MACHINE_PROBE, waitMs: 20_000 }, 40_000);
        const text = res.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
        const m = text.match(/<<MENTOR-PROBE (\{.*\}) MENTOR-PROBE>>/);
        if (m) machine = JSON.parse(m[1]!);
      } catch {
        // The machine is off: the plan is checked without it.
      }
      const full = { ...plan, ...(machine ? { machine } : {}) } as MentorPaperPlan;
      const problems = ctx.workshop.hub.setPlan(ctx.workshop.paperId, full);
      if (problems.length) throw new Denied(`The plan was not saved:\n- ${problems.join("\n- ")}`);
      const notes = [
        machine && !machine.gpu && plan.experiment.device === "gpu" ? "The notebook has no GPU now: tell the learner to turn on a GPU accelerator in the notebook's settings before the experiment." : "",
        machine && !machine.internet && /torchvision|download|MNIST|CIFAR/i.test(plan.experiment.dataset) ? "The notebook has no Internet: the dataset cannot be downloaded. Tell the learner to turn Internet on (Kaggle: notebook settings; needs a phone-verified account), or change the dataset." : "",
        !machine ? "The notebook's machine did not answer (off?): GPU and Internet were not checked." : "",
      ].filter(Boolean);
      return { text: `The plan is saved and shown to the learner as a card with an "Duyệt kế hoạch" button.${notes.length ? `\n${notes.join("\n")}` : ""} Ask them to approve it or say what to change.` };
    },
  }),
] as unknown as ToolDef<z.ZodType, WorkshopToolContext>[];

export const AUTHOR_TOOLS = [
  paperSource,
  tool({
    name: "paper_given_write",
    description: "Write the paper's shared given code (given.py): runs before every exercise of the paper, in the learner's notebook and in the judge.",
    schema: z.object({ code: z.string().min(1).max(200_000) }),
    async run(ctx: WorkshopToolContext, a) {
      ctx.workshop.hub.saveGiven(ctx.workshop.paperId, a.code);
      return { text: "given.py saved." };
    },
  }),
  tool({
    name: "paper_exercise_write",
    description: "Write one file of a component's exercise draft: meta.json, brief.md, lab.py, starter.py, given.py, reference.py, tests.py, probes.json, or mutants/<name>.py.",
    schema: z.object({ component: z.string().min(1), file: z.string().min(1), content: z.string().max(200_000) }),
    async run(ctx: WorkshopToolContext, a) {
      try {
        return { text: ctx.workshop.hub.writeDraft(ctx.workshop.paperId, a.component, a.file, a.content) };
      } catch (e) {
        if (e instanceof Denied) throw e;
        throw new Denied((e as Error).message);
      }
    },
  }),
  tool({
    name: "paper_exercise_read",
    description: "Read back the files of a component's draft.",
    schema: z.object({ component: z.string().min(1) }),
    async run(ctx: WorkshopToolContext, a) {
      const files = ctx.workshop.hub.shelf.readDraft(ctx.workshop.paperId, a.component);
      const names = Object.keys(files);
      if (!names.length) return { text: `No draft for ${a.component} yet.` };
      return { text: names.map((n) => `--- ${n}\n${files[n]}`).join("\n\n").slice(0, 120_000) };
    },
  }),
  tool({
    name: "paper_exercise_check",
    description: "Check a component's draft on this notebook's machine (reference passes twice, starter and broken solutions fail, lab runs, nothing leaks). A passing draft goes on the learner's shelf.",
    schema: z.object({ component: z.string().min(1) }),
    async run(ctx: WorkshopToolContext, a) {
      const exec = async (code: string, waitMs: number) => {
        const res = await ctx.exclusive("run", () => ctx.call({ op: "execute", code, waitMs }, waitMs + 30_000));
        if (res.status === "running") await ctx.call({ op: "interrupt" }).catch(() => {});
        return res;
      };
      const report = await ctx.workshop.hub.check(ctx.workshop.paperId, a.component, exec);
      return { text: `${reportText(report)}\n${report.ok ? "Passed: the exercise is on the shelf. Stop here." : "Fix what failed, then check again."}`, ...(report.ok ? {} : { isError: true }) };
    },
  }),
] as unknown as ToolDef<z.ZodType, WorkshopToolContext>[];

export const PLAN_CHAT_TOOLS: readonly ToolDef<z.ZodType, any>[] = [...TOOLS.filter((t) => KEPT.has(t.name)), ...PLAN_TOOLS];
export const AUTHOR_CHAT_TOOLS: readonly ToolDef<z.ZodType, any>[] = [...TOOLS.filter((t) => KEPT.has(t.name)), ...AUTHOR_TOOLS];

/** The workshop's cells: what the learner sees in the notebook. */
export function workshopCells(info: { id: string; title: string; authors?: string; year?: number; url?: string }): { type: "markdown"; source: string }[] {
  return [{
    type: "markdown",
    source: [
      `<!-- mentor: paper ${info.id} -->`,
      `# 📜 ${info.title}`,
      "",
      [info.authors, info.year].filter(Boolean).join(" · ") + (info.url ? ` · [${info.url}](${info.url})` : ""),
      "",
      "**Xưởng của paper.** Mentor đọc paper và lập kế hoạch reproduce với bạn trong khung chat bên cạnh; sau khi bạn duyệt, mentor soạn từng bài và chạy thử chúng trên máy của notebook này. Trong lúc mentor soạn, đừng chạy code của bạn ở đây.",
      "",
      "Các bài làm ở notebook khác: mở từ Tủ paper trên trang Mentor.",
    ].join("\n"),
  }];
}
