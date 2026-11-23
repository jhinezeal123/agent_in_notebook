// Papers on the shelf. A paper package is a folder: paper.json (who wrote it,
// the reproduction plan, where it is), given.py (code given with the paper),
// and exercises/ in the same format as the curated ones. Landmark papers ship
// in mentor-catalog/papers and close a constellation of the map; papers the
// learner brings live in ~/.agent-in-notebook/mentor/papers, with the paper's
// text (source.md), the learner's notes, the exercises the mentor is writing
// (drafts/, never loaded) and the machine's verification of each (verify/):
// only verified exercises, unchanged since, are loaded.

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MENTOR_SKILLS, type MentorPaperPlan, type MentorSkill } from "@ainb/protocol";
import { loadExercise, type Exercise, type StarDef } from "./catalog.js";
import type { VerifyReport } from "./verify.js";

const Skill = z.enum(MENTOR_SKILLS as [MentorSkill, ...MentorSkill[]]);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "slug: chữ thường, số, gạch ngang");

/** The plan as the agent gives it (paper_plan); checked further by checkPlan. */
export const PlanSchema = z.object({
  title: z.string().min(1).max(300),
  authors: z.string().max(300).optional(),
  year: z.number().int().min(1950).max(2100).optional(),
  goal: z.string().min(1).max(600),
  requires: z.array(z.string()).default([]),
  components: z.array(z.object({
    slug: Slug,
    title: z.string().min(1).max(120),
    role: z.enum(["formula", "component", "experiment"]),
    mode: z.enum(["build", "given"]),
    cites: z.string().min(1).max(120),
    why: z.string().min(1).max(400),
    functions: z.array(z.string().min(1).max(300)).max(8).default([]),
    uses: z.array(z.string()).default([]),
    minutes: z.number().int().min(5).max(60),
    difficulty: z.number().int().min(800).max(2400),
    skills: z.array(Skill).min(1).max(3),
  })).min(2).max(10),
  experiment: z.object({
    dataset: z.string().min(1).max(200),
    device: z.enum(["cpu", "gpu"]),
    trainMinutes: z.number().min(0.5).max(60),
    metrics: z.array(z.object({
      name: z.string().min(1).max(40),
      paper: z.string().max(120),
      where: z.string().max(120),
      target: z.object({ op: z.enum([">=", "<="]), value: z.number() }),
    })).min(1).max(5),
  }),
  machine: z.object({ gpu: z.boolean(), internet: z.boolean(), torch: z.string().nullable().optional() }).optional(),
  sessions: z.number().int().min(1).max(20).optional(),
});

/** Most minutes an experiment may train: it has to fit a session, and a Kaggle machine that turns off loses the model. */
export const TRAIN_MINUTES_MAX = 15;

/**
 * What is wrong with a plan, for the agent to fix (empty when it is fine).
 * Difficulties are clamped around the learner's rating rather than refused.
 */
export function checkPlan(plan: MentorPaperPlan, opts: { stars: Set<string>; rating: number }): { problems: string[]; plan: MentorPaperPlan } {
  const problems: string[] = [];
  const slugs = new Set<string>();
  const build = new Set<string>();
  plan.components.forEach((c, i) => {
    if (slugs.has(c.slug)) problems.push(`Component ${c.slug} appears twice.`);
    for (const u of c.uses) {
      if (!slugs.has(u)) problems.push(`Component ${c.slug} uses "${u}", which is not an earlier component.`);
      else if (!build.has(u)) problems.push(`Component ${c.slug} uses "${u}", which is given code: given code is available to every component, list only built ones in uses.`);
    }
    if (c.role === "experiment" && i !== plan.components.length - 1) problems.push(`The experiment (${c.slug}) must be the last component.`);
    if (c.mode === "build" && !c.functions.length && c.role !== "experiment") problems.push(`Component ${c.slug} names no function: give each built component its signatures with shapes.`);
    slugs.add(c.slug);
    if (c.mode === "build") build.add(c.slug);
  });
  const last = plan.components[plan.components.length - 1];
  if (!last || last.role !== "experiment" || last.mode !== "build") problems.push("The last component must be the experiment, built by the learner (their training loop).");
  if (plan.components.filter((c) => c.role === "experiment").length > 1) problems.push("Only one experiment.");
  if (plan.components.filter((c) => c.mode === "build").length < 2) problems.push("At least two components must be built by the learner.");
  if (plan.experiment.trainMinutes > TRAIN_MINUTES_MAX) problems.push(`Training takes at most ${TRAIN_MINUTES_MAX} minutes on the notebook's machine: shrink the model, the data or the steps.`);
  const unknown = plan.requires.filter((r) => !opts.stars.has(r));
  if (unknown.length) problems.push(`Unknown star ids in requires: ${unknown.join(", ")}.`);
  const lo = Math.max(800, Math.round(opts.rating - 300));
  const hi = Math.min(2400, Math.round(opts.rating + 500));
  const clamped = { ...plan, components: plan.components.map((c) => ({ ...c, difficulty: Math.min(hi, Math.max(lo, c.difficulty)) })) };
  return { problems, plan: clamped };
}

const PaperFile = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  authors: z.string().optional(),
  year: z.number().int().optional(),
  url: z.string().optional(),
  arxiv: z.string().optional(),
  /** A landmark paper: the map constellation it closes. */
  closes: z.string().optional(),
  goal: z.string().optional(),
  /** shelved: on the shelf (opened to read, easy-read), no workshop yet; reading: the workshop's first step. */
  status: z.enum(["shelved", "reading", "planning", "authoring", "ready"]).default("ready"),
  plan: PlanSchema.optional(),
  approved: z.boolean().default(false),
  /** The learner approved a plan at least once (a changed plan waits for their approval again). */
  approvedOnce: z.boolean().default(false),
  /** Components the author could not write, with why (by slug). */
  failed: z.record(z.string(), z.string()).default({}),
  /** Exercises the learner reported as wrong, with what they said (by slug): each waits to be written again. */
  reports: z.record(z.string(), z.string()).default({}),
  archived: z.boolean().default(false),
  /** Where its text came from, and how much of it there is. */
  source: z.object({ kind: z.enum(["latex", "alphaxiv", "pdf"]), chars: z.number() }).optional(),
  addedAt: z.number().optional(),
});

export type PaperInfo = z.infer<typeof PaperFile> & { origin: "curated" | "yours"; dir: string; given: string };

export interface PaperPackage {
  info: PaperInfo;
  exercises: Exercise[];
}

/** An exercise of a paper the learner brought: `<paperId>--<slug>`. */
export function paperExerciseId(paperId: string, slug: string): string {
  return `${paperId}--${slug}`;
}

export function slugOf(paperId: string, exerciseId: string): string {
  return exerciseId.startsWith(`${paperId}--`) ? exerciseId.slice(paperId.length + 2) : exerciseId;
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

export function readPaperInfo(dir: string, origin: PaperInfo["origin"]): PaperInfo {
  const raw = PaperFile.parse(JSON.parse(readText(join(dir, "paper.json"))));
  return { ...raw, origin, dir, given: readText(join(dir, "given.py")).trim() };
}

/** The verification record of a paper exercise the mentor wrote, if it passed. */
export function verifiedReport(dir: string, exerciseId: string): VerifyReport | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, "verify", `${exerciseId}.json`), "utf8")) as VerifyReport;
    return r && r.ok ? r : null;
  } catch {
    return null;
  }
}

/**
 * The paper packages under a folder. Every exercise is tied to its paper (its
 * star is itself, on the paper's own constellation); exercises of the
 * learner's papers count only when verified as they are.
 */
export function loadPapers(root: string, origin: PaperInfo["origin"], log: (m: string) => void = () => {}): PaperPackage[] {
  const out: PaperPackage[] = [];
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "paper.json"))) continue;
    let info: PaperInfo;
    try {
      info = readPaperInfo(dir, origin);
    } catch (e) {
      log(`Mentor: the paper in ${dir} is unreadable: ${(e as Error).message}`);
      continue;
    }
    const exercises: Exercise[] = [];
    const exRoot = join(dir, "exercises");
    for (const exName of existsSync(exRoot) ? readdirSync(exRoot).sort() : []) {
      const at = join(exRoot, exName);
      if (!existsSync(join(at, "meta.json"))) continue;
      try {
        const ex = loadExercise(at, exName);
        if (origin === "yours" && verifiedReport(dir, ex.id)?.hash !== ex.hash) {
          log(`Mentor: ${ex.id} changed since it was verified; it is left out until verified again.`);
          continue;
        }
        exercises.push({ ...ex, paper: info.id, star: ex.id, ...(origin === "yours" ? { author: "ai" as const } : {}) });
      } catch (e) {
        log(`Mentor: the exercise ${exName} of ${info.id} is unreadable: ${(e as Error).message}`);
      }
    }
    out.push({ info, exercises });
  }
  return out;
}

/** A paper's own small constellation: a star per exercise, left to right in the order they build on each other. */
export function paperStars(pkg: PaperPackage): StarDef[] {
  const ids = new Set(pkg.exercises.map((e) => e.id));
  const depth = new Map<string, number>();
  const depthOf = (e: Exercise, seen = new Set<string>()): number => {
    const known = depth.get(e.id);
    if (known !== undefined) return known;
    if (seen.has(e.id)) return 0;
    seen.add(e.id);
    const d = Math.max(-1, ...e.uses.filter((u) => ids.has(u)).map((u) => depthOf(pkg.exercises.find((x) => x.id === u)!, seen))) + 1;
    depth.set(e.id, d);
    return d;
  };
  for (const e of pkg.exercises) depthOf(e);
  const deepest = Math.max(1, ...depth.values());
  const columns = new Map<number, Exercise[]>();
  for (const e of pkg.exercises) columns.set(depth.get(e.id)!, [...(columns.get(depth.get(e.id)!) ?? []), e]);
  return pkg.exercises.map((e) => {
    const d = depth.get(e.id)!;
    const column = columns.get(d)!;
    const row = column.indexOf(e);
    return {
      id: e.id,
      name: e.title,
      constellation: `paper:${pkg.info.id}`,
      x: Math.round(8 + (84 * d) / deepest),
      y: Math.round(column.length === 1 ? 50 : 15 + (70 * row) / (column.length - 1)),
      after: e.uses.filter((u) => ids.has(u)),
    };
  });
}

/** The learner's papers: their folders, plans and texts. */
export class PaperShelf {
  constructor(readonly root: string) {}

  dir(paperId: string): string {
    return join(this.root, paperId.replace(/[^a-z0-9-]/g, ""));
  }

  ids(): string[] {
    return existsSync(this.root) ? readdirSync(this.root).filter((n) => existsSync(join(this.root, n, "paper.json"))).sort() : [];
  }

  has(paperId: string): boolean {
    return existsSync(join(this.dir(paperId), "paper.json"));
  }

  read(paperId: string): PaperInfo {
    return readPaperInfo(this.dir(paperId), "yours");
  }

  /** A new paper, with its text; returns its id. */
  create(p: { id?: string; title: string; authors?: string; year?: number; url?: string; arxiv?: string; source: string; kind: "latex" | "alphaxiv" | "pdf"; status?: "shelved" | "reading" }): string {
    let id = p.id ?? `p-${randomBytes(3).toString("hex")}`;
    while (this.has(id)) id = `${id}-${randomBytes(2).toString("hex")}`;
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "source.md"), p.source);
    this.write(id, {
      id, title: p.title, ...(p.authors ? { authors: p.authors } : {}), ...(p.year ? { year: p.year } : {}),
      ...(p.url ? { url: p.url } : {}), ...(p.arxiv ? { arxiv: p.arxiv } : {}),
      status: p.status ?? "reading", approved: false, failed: {}, archived: false, source: { kind: p.kind, chars: p.source.length }, addedAt: Date.now(),
    });
    return id;
  }

  /** Change paper.json (validated). */
  write(paperId: string, patch: Partial<z.infer<typeof PaperFile>>): PaperInfo {
    const dir = this.dir(paperId);
    const before = existsSync(join(dir, "paper.json")) ? JSON.parse(readText(join(dir, "paper.json"))) : {};
    const next = PaperFile.parse({ ...before, ...patch });
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `paper.json.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, join(dir, "paper.json"));
    return this.read(paperId);
  }

  source(paperId: string): string {
    return readText(join(this.dir(paperId), "source.md"));
  }

  notes(paperId: string): string {
    return readText(join(this.dir(paperId), "notes.md"));
  }

  saveNotes(paperId: string, notes: string): void {
    mkdirSync(this.dir(paperId), { recursive: true });
    writeFileSync(join(this.dir(paperId), "notes.md"), notes.slice(0, 20_000));
  }

  /** The given code shared by the paper's exercises. */
  saveGiven(paperId: string, code: string): void {
    writeFileSync(join(this.dir(paperId), "given.py"), code);
  }

  // ---------------------------------------------------------------- drafts

  draftDir(paperId: string, slug: string): string {
    return join(this.dir(paperId), "drafts", paperExerciseId(paperId, slug));
  }

  /** Files a draft may have (the exercise format). */
  static readonly DRAFT_FILES = /^(meta\.json|brief\.md|lab\.py|starter\.py|given\.py|reference\.py|tests\.py|probes\.json|mutants\/[a-z0-9_-]{1,40}\.py)$/;

  writeDraft(paperId: string, slug: string, file: string, content: string): void {
    if (!PaperShelf.DRAFT_FILES.test(file)) throw new Error(`Not a file of an exercise: ${file}. Allowed: meta.json, brief.md, lab.py, starter.py, given.py, reference.py, tests.py, probes.json, mutants/<name>.py.`);
    const full = join(this.draftDir(paperId, slug), file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  readDraft(paperId: string, slug: string): Record<string, string> {
    const dir = this.draftDir(paperId, slug);
    const out: Record<string, string> = {};
    const walk = (at: string, rel: string) => {
      for (const name of existsSync(at) ? readdirSync(at).sort() : []) {
        const full = join(at, name);
        if (statSync(full).isDirectory()) walk(full, `${rel}${name}/`);
        else out[`${rel}${name}`] = readText(full);
      }
    };
    walk(dir, "");
    return out;
  }

  /** An exercise's files as its draft again, to be fixed (the exercise stays on the shelf until the fixed one passes). */
  seedDraft(paperId: string, slug: string): void {
    const from = join(this.dir(paperId), "exercises", paperExerciseId(paperId, slug));
    if (!existsSync(from)) return;
    rmSync(this.draftDir(paperId, slug), { recursive: true, force: true });
    cpSync(from, this.draftDir(paperId, slug), { recursive: true });
  }

  removeDraft(paperId: string, slug: string): void {
    rmSync(this.draftDir(paperId, slug), { recursive: true, force: true });
  }

  /** A verified draft becomes an exercise, with its record. */
  publish(paperId: string, slug: string, report: VerifyReport): void {
    const id = paperExerciseId(paperId, slug);
    const target = join(this.dir(paperId), "exercises", id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(target, ".."), { recursive: true });
    renameSync(this.draftDir(paperId, slug), target);
    mkdirSync(join(this.dir(paperId), "verify"), { recursive: true });
    writeFileSync(join(this.dir(paperId), "verify", `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }

  /** Take an exercise out (to write it again). */
  unpublish(paperId: string, slug: string): void {
    const id = paperExerciseId(paperId, slug);
    rmSync(join(this.dir(paperId), "exercises", id), { recursive: true, force: true });
    rmSync(join(this.dir(paperId), "verify", `${id}.json`), { force: true });
  }
}
