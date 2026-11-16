// The curated exercises shipped with the bridge (packages/bridge/mentor-catalog):
// the star map, topic packs (packs/<id>: more stars and exercises, added
// without touching the map), and for each exercise its brief, formula-lab
// cells, starter, reference solution, hidden tests, probing questions and
// hints. The reference and the tests never go into the learner's notebook.
// The format, for people and agents who add content: mentor-catalog/PROTOCOL.md.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MENTOR_SKILLS, type MentorSkill } from "@ainb/protocol";
import { loadPapers, paperStars, type PaperPackage } from "./papers.js";

const Skill = z.enum(MENTOR_SKILLS as [MentorSkill, ...MentorSkill[]]);

const Meta = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  star: z.string().min(1),
  skills: z.array(Skill).min(1).max(3),
  difficulty: z.number().int().min(800).max(2400),
  minutes: z.number().int().min(5).max(60),
  /** Python modules the tests import. */
  requires: z.array(z.string()).default(["numpy"]),
  /** Diagnostic session (1..3) the exercise belongs to. */
  diagnostic: z.number().int().min(1).max(3).optional(),
  /** Order on its star and in the diagnostic. */
  order: z.number().int().default(0),
  /** Names the learner's cells must define; the tests call them. */
  functions: z.array(z.string().regex(/^[A-Za-z_]\w*$/)).min(1),
  /** Run before the learner's cells in the judge (imports the starter assumes). */
  prelude: z.string().default("import numpy as np"),
  /** How many probing questions finish the defence. */
  probes: z.number().int().min(1).max(5).default(2),
  /** A variation of another exercise: offered once that one is learnt. */
  variantOf: z.string().optional(),
  /** For a variation: what the learner predicts (in writing) before coding it. */
  predict: z.string().min(1).optional(),
  /** The paper the exercise is a component of (its package id). */
  paper: z.string().optional(),
  /** formula and component: an exercise like any other; experiment: train and measure (judged on what the kernel holds). */
  role: z.enum(["formula", "component", "experiment"]).default("component"),
  /** Where in the paper (an equation, a section, an algorithm). */
  cites: z.string().optional(),
  /** Exercises whose code this one builds on: the learner's own passed solutions run before theirs. */
  uses: z.array(z.string()).default([]),
  /** source: run the solution cells afresh; kernel: test what the kernel holds (an experiment's trained model). */
  judge: z.enum(["source", "kernel"]).default("source"),
  /** Longest a judge run may take. */
  judgeSeconds: z.number().int().min(10).max(900).default(60),
  /** curated: written and checked by hand; ai: written by the mentor for a paper, checked by the machine. */
  author: z.enum(["curated", "ai"]).default("curated"),
  /** The numbers an experiment reports (t.report), with the paper's for comparison. */
  metrics: z.array(z.object({
    name: z.string().min(1),
    paper: z.string().optional(),
    unit: z.string().optional(),
    /** The pass mark: the judge itself fails the experiment when the reported number misses it. */
    target: z.object({ op: z.enum([">=", "<="]), value: z.number() }).optional(),
  })).default([]),
});

const Probe = z.object({
  q: z.string().min(1),
  /** The misconception a wrong answer shows. */
  tag: z.string().min(1),
  /** What a right answer says, for grading (never shown to the learner as is). */
  answer: z.string().min(1),
  /** What the question is after: why a line is there, what breaks without it, a shape, an edge case, two things compared, a trap. */
  kind: z.enum(["why", "break", "shape", "edge", "compare", "trap"]).optional(),
  /** Where it fits best: before coding (the formula lab) or after passing (the defence). Unset: either. */
  stage: z.enum(["lab", "defend"]).optional(),
});

/**
 * A hint its author wrote, for one level of the ladder: 0 a question back,
 * 1 a direction in words, 2 pseudo-code or shapes step by step, 3 at most 8
 * lines of code. (Level 4 is the reference solution.) The mentor adapts it to
 * where the learner is; it is never shown above the level the learner asked for.
 */
const Hint = z.object({
  level: z.number().int().min(0).max(3),
  text: z.string().min(1),
  /** Where the learner is stuck, so the mentor picks the right one. */
  when: z.string().min(1).optional(),
  /** The test function whose failure it is for. */
  test: z.string().regex(/^test_\w+$/).optional(),
});

/** The version of the content format (PROTOCOL.md) this bridge reads. */
export const CONTENT_PROTOCOL = 1;

const Id = z.string().regex(/^[a-z0-9-]+$/);

const PackFile = z.object({
  protocol: z.number().int().min(1),
  id: Id,
  name: z.string().min(1),
  description: z.string().optional(),
  /** A constellation of the pack's own: a small map under the star map. */
  constellation: z.object({
    id: Id,
    name: z.string().min(1),
    description: z.string().optional(),
    /** false: its exercises are never "today's exercise" unless the learner focuses on it. */
    daily: z.boolean().default(true),
  }).optional(),
  stars: z.array(z.object({
    id: Id,
    name: z.string().min(1),
    /** Default: the pack's own constellation. */
    constellation: z.string().optional(),
    /** Unset: placed automatically. */
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    after: z.array(z.string()).default([]),
  })).default([]),
});

const Star = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  constellation: z.string().min(1),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  after: z.array(z.string()).default([]),
});

const MapFile = z.object({
  constellations: z.array(z.object({ id: z.string(), name: z.string(), paper: z.string().optional() })),
  stars: z.array(Star),
});

export type ExerciseMeta = z.infer<typeof Meta>;
export type ProbeDef = z.infer<typeof Probe>;
export type HintDef = z.infer<typeof Hint>;
export type StarDef = z.infer<typeof Star>;

export interface LabCell {
  type: "code" | "markdown";
  source: string;
}

export interface Exercise extends ExerciseMeta {
  brief: string;
  /** Code given with the exercise (data, plotting, boilerplate): shown in the notebook, run before the learner's. */
  given: string;
  /** Of every file of the exercise: what a verification record is for. */
  hash: string;
  lab: LabCell[];
  starter: string;
  reference: string;
  tests: string;
  probeBank: ProbeDef[];
  /** Hints written with the exercise (hints.json); the mentor makes its own where there are none. */
  hints: HintDef[];
  /** The topic pack it came with (unset: the original set, or a paper). */
  pack?: string;
  /** Deliberately broken solutions the tests must catch (the catalog's self-check). */
  mutants: { name: string; source: string }[];
}

/** A topic pack as loaded. */
export interface PackInfo {
  id: string;
  name: string;
  description?: string;
  dir: string;
  /** Its own constellation, if it has one. */
  constellation?: string;
  stars: string[];
  exercises: string[];
  /** Exercise folders without a meta.json yet (being written). */
  unfinished: string[];
}

/** Something in a pack that was left out, and why (packs never break the catalog). */
export interface CatalogProblem {
  /** pack, or pack/exercise. */
  where: string;
  message: string;
}

export interface CatalogConstellation {
  id: string;
  name: string;
  /** map: on the star map; paper: a paper's own; topic: a pack's own small map. */
  kind: "map" | "paper" | "topic";
  paper?: string;
  description?: string;
  /** false: not offered as today's exercise unless focused on. */
  daily?: boolean;
}

export interface Catalog {
  dir: string;
  constellations: CatalogConstellation[];
  stars: StarDef[];
  exercises: Exercise[];
  exercise(id: string): Exercise | undefined;
  /** The papers on the shelf, with their exercises. */
  papers: PaperPackage[];
  /** A paper package's given code (shared by its exercises); "" when none. */
  paperGiven(paperId: string): string;
  /** The topic packs read (mentor-catalog/packs). */
  packs: PackInfo[];
  /** What was left out of the packs, and why. */
  problems: CatalogProblem[];
}

/** Where the catalog is: next to the bridge's sources or its build, or AINB_MENTOR_CATALOG. */
export function catalogDir(): string {
  if (process.env.AINB_MENTOR_CATALOG) return process.env.AINB_MENTOR_CATALOG;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "mentor-catalog");
    if (existsSync(join(candidate, "map.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("The Mentor exercises (mentor-catalog) are missing from this install of the bridge.");
}

/**
 * Cells of a percent-format script: `# %%` starts a code cell, `# %% [markdown]`
 * a markdown cell whose lines are comments.
 */
export function parseCells(text: string): LabCell[] {
  const cells: LabCell[] = [];
  let current: LabCell | null = null;
  const lines: string[] = [];
  const close = () => {
    if (!current) return;
    current.source = lines.join("\n").replace(/^\n+|\s+$/g, "");
    if (current.source) cells.push(current);
    lines.length = 0;
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const marker = line.match(/^# %%(.*)$/);
    if (marker) {
      close();
      current = { type: /\[markdown\]/.test(marker[1] ?? "") ? "markdown" : "code", source: "" };
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      current = { type: "code", source: "" };
    }
    lines.push(current.type === "markdown" ? line.replace(/^# ?/, "") : line);
  }
  close();
  return cells;
}

function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** Files the machine check does not depend on: questions and hints can be added without checking the exercise again. */
const UNHASHED = new Set(["probes.json", "hints.json"]);

/** A hash of the files under an exercise's folder that its check depends on (line endings normalised). */
export function exerciseHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full, `${rel}${name}/`);
      else if (rel || !UNHASHED.has(name)) h.update(`${rel}${name}\0${read(full)}\0`);
    }
  };
  walk(dir, "");
  return h.digest("hex").slice(0, 16);
}

/** One exercise's folder. */
export function loadExercise(at: string, name: string): Exercise {
  const meta = Meta.parse(JSON.parse(read(join(at, "meta.json"))));
  if (meta.id !== name) throw new Error(`Exercise folder ${name} holds the exercise ${meta.id}.`);
  if (meta.role === "experiment" && !meta.predict) throw new Error(`Experiment ${meta.id} has no "predict" question.`);
  const mutantsDir = join(at, "mutants");
  return {
    ...meta,
    brief: read(join(at, "brief.md")).trim(),
    given: existsSync(join(at, "given.py")) ? read(join(at, "given.py")).trim() : "",
    hash: exerciseHash(at),
    lab: existsSync(join(at, "lab.py")) ? parseCells(read(join(at, "lab.py"))) : [],
    starter: existsSync(join(at, "starter.py")) ? read(join(at, "starter.py")).trim() : "",
    reference: read(join(at, "reference.py")),
    tests: read(join(at, "tests.py")),
    probeBank: z.array(Probe).min(1).parse(JSON.parse(read(join(at, "probes.json")))),
    hints: existsSync(join(at, "hints.json")) ? z.array(Hint).parse(JSON.parse(read(join(at, "hints.json")))) : [],
    mutants: existsSync(mutantsDir)
      ? readdirSync(mutantsDir).filter((f) => f.endsWith(".py")).sort().map((f) => ({ name: f.replace(/\.py$/, ""), source: read(join(mutantsDir, f)) }))
      : [],
  };
}

/** What is wrong with an exercise among the others (the exercises it uses or varies), or null. */
function linkProblem(e: Exercise, byId: ReadonlyMap<string, Exercise>): string | null {
  for (const u of e.uses) if (!byId.has(u)) return `Exercise ${e.id} uses an unknown exercise ${u}.`;
  if (!e.variantOf) return null;
  const parent = byId.get(e.variantOf);
  if (!parent) return `Exercise ${e.id} is a variation of an unknown exercise ${e.variantOf}.`;
  if (parent.variantOf) return `Exercise ${e.id} is a variation of a variation (${e.variantOf}).`;
  if (!e.predict) return `Variation ${e.id} has no "predict" question.`;
  return null;
}

/** Exercises in the order they are offered; their variations and the exercises they use must exist. */
export function checkExercises(exercises: Exercise[]): Exercise[] {
  exercises.sort((a, b) => a.difficulty - b.difficulty || a.order - b.order || a.id.localeCompare(b.id));
  const byId = new Map(exercises.map((e) => [e.id, e]));
  for (const e of exercises) {
    const problem = linkProblem(e, byId);
    if (problem) throw new Error(problem);
  }
  usesOrder(exercises.map((e) => e.id), (id) => byId.get(id)?.uses ?? []);
  return exercises;
}

/**
 * The exercises some exercises build on, deepest first (each once), ending
 * with the ones named. Throws on a circle.
 */
export function usesOrder(ids: string[], usesOf: (id: string) => string[]): string[] {
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`Exercises use each other in a circle: ${[...path, id].join(" → ")}.`);
    state.set(id, "visiting");
    for (const u of usesOf(id)) visit(u, [...path, id]);
    state.set(id, "done");
    out.push(id);
  };
  for (const id of ids) visit(id, []);
  return out;
}

export interface CatalogOptions {
  /** The learner's own papers (~/.agent-in-notebook/mentor/papers). */
  papersDir?: string;
  log?: (message: string) => void;
  /**
   * Load curated exercises that need a module the dev machine lacks (PyTorch)
   * even when verified.json has no record of them as they are (for checking
   * them; the learner never gets them).
   */
  unverified?: boolean;
}

/** Curated exercises checked on a real machine (Kaggle): id → the hash of their files then. */
function verifiedHashes(dir: string): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "verified.json"), "utf8")) as Record<string, { hash?: unknown }>;
    return new Map(Object.entries(raw).filter(([, r]) => typeof r?.hash === "string").map(([id, r]) => [id, r.hash as string]));
  } catch {
    return new Map();
  }
}

/** Exercises the dev machine cannot judge (PyTorch): they must be verified on Kaggle before a learner gets them. */
export function needsKaggleCheck(ex: Pick<Exercise, "requires">): boolean {
  return ex.requires.includes("torch");
}

export function loadCatalog(dir = catalogDir(), opts: CatalogOptions = {}): Catalog {
  const map = MapFile.parse(JSON.parse(read(join(dir, "map.json"))));
  const starIds = new Set(map.stars.map((s) => s.id));
  for (const s of map.stars) {
    for (const a of s.after) if (!starIds.has(a)) throw new Error(`Star ${s.id} comes after an unknown star ${a}.`);
    if (!map.constellations.some((c) => c.id === s.constellation)) throw new Error(`Star ${s.id} is in an unknown constellation ${s.constellation}.`);
  }
  const root = join(dir, "exercises");
  const exercises: Exercise[] = [];
  const verified = verifiedHashes(dir);
  const checked = (ex: Exercise) => opts.unverified || !needsKaggleCheck(ex) || verified.get(ex.id) === ex.hash;
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    const at = join(root, name);
    if (!existsSync(join(at, "meta.json"))) continue;
    const ex = loadExercise(at, name);
    if (!starIds.has(ex.star)) throw new Error(`Exercise ${ex.id} is on an unknown star ${ex.star}.`);
    if (!checked(ex)) {
      opts.log?.(`Mentor: ${ex.id} is not verified on Kaggle as it is now; it is left out.`);
      continue;
    }
    exercises.push(ex);
  }
  const constellations: Catalog["constellations"] = map.constellations.map((c) => ({ ...c, kind: "map" as const }));
  const stars = [...map.stars];
  // Topic packs: more stars and exercises. A pack's mistakes leave its own parts out, nothing else.
  const problems: CatalogProblem[] = [];
  const packs = loadPacks(join(dir, "packs"), { constellations, stars, exercises, checked, problems });
  for (const p of problems) opts.log?.(`Mentor: ${p.where}: ${p.message}`);
  // Papers: the landmark ones shipped here, then the learner's.
  const papers = new Map<string, PaperPackage>();
  const curatedPapers = loadPapers(join(dir, "papers"), "curated", opts.log).map((p) => ({ ...p, exercises: p.exercises.filter(checked) }));
  for (const pkg of [...curatedPapers, ...(opts.papersDir ? loadPapers(opts.papersDir, "yours", opts.log) : [])]) {
    if (papers.has(pkg.info.id)) continue;
    papers.set(pkg.info.id, pkg);
    constellations.push({ id: `paper:${pkg.info.id}`, name: pkg.info.title, kind: "paper" });
    stars.push(...paperStars(pkg));
    exercises.push(...pkg.exercises.filter((e) => !exercises.some((x) => x.id === e.id)));
  }
  // An exercise that builds on (or varies) one left out is left out too.
  for (let changed = true; changed;) {
    changed = false;
    const ids = new Set(exercises.map((e) => e.id));
    for (let i = exercises.length - 1; i >= 0; i--) {
      const e = exercises[i]!;
      if (e.uses.every((u) => ids.has(u)) && (!e.variantOf || ids.has(e.variantOf))) continue;
      opts.log?.(`Mentor: ${e.id} builds on an exercise that is left out; it is left out too.`);
      exercises.splice(i, 1);
      changed = true;
    }
  }
  for (const pkg of papers.values()) pkg.exercises = pkg.exercises.filter((e) => exercises.includes(e));
  checkExercises(exercises);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  return {
    dir, constellations, stars, exercises, exercise: (id) => byId.get(id),
    papers: [...papers.values()],
    paperGiven: (id) => papers.get(id)?.info.given ?? "",
    packs: packs.map((p) => ({ ...p, exercises: p.exercises.filter((id) => byId.has(id)) })),
    problems,
  };
}

/** Where a star goes on a small map of its own: columns by how deep it is in the "after" links, rows within a column. */
export function autoLayout(ids: string[], afterOf: (id: string) => string[]): Map<string, { x: number; y: number }> {
  const own = new Set(ids);
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...afterOf(id).filter((a) => own.has(a)).map((a) => depthOf(a, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id, new Set());
  const deepest = Math.max(0, ...depth.values());
  const out = new Map<string, { x: number; y: number }>();
  if (deepest === 0) {
    // No links among them: a row, staggered so the names do not run into each other.
    ids.forEach((id, i) => out.set(id, { x: ids.length === 1 ? 50 : Math.round(8 + (84 * i) / (ids.length - 1)), y: ids.length === 1 ? 50 : i % 2 ? 68 : 36 }));
    return out;
  }
  const columns = new Map<number, string[]>();
  for (const id of ids) columns.set(depth.get(id)!, [...(columns.get(depth.get(id)!) ?? []), id]);
  for (const [d, column] of columns) {
    column.forEach((id, row) => out.set(id, {
      x: Math.round(8 + (84 * d) / deepest),
      y: Math.round(column.length === 1 ? 50 : 18 + (64 * row) / (column.length - 1)),
    }));
  }
  return out;
}

/** The star map's size on screen per unit of x and y (ui: constellation.ts), to keep star names apart. */
const MAP_PX = { x: 9.08, y: 4.8 };

/** A free place on the star map, as near the target as the stars already there allow. */
export function freeSpot(taken: { x: number; y: number }[], target: { x: number; y: number }): { x: number; y: number } {
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  for (let x = 4; x <= 96; x += 2) {
    for (let y = 8; y <= 94; y += 2) {
      if (!taken.every((t) => Math.abs(t.x - x) * MAP_PX.x >= 70 || Math.abs(t.y - y) * MAP_PX.y >= 40)) continue;
      const score = Math.hypot((x - target.x) * MAP_PX.x, (y - target.y) * MAP_PX.y);
      if (score < bestScore) {
        best = { x, y };
        bestScore = score;
      }
    }
  }
  return best ?? { x: Math.min(96, Math.max(4, Math.round(target.x))), y: Math.min(94, Math.max(8, Math.round(target.y))) };
}

interface PackTarget {
  constellations: CatalogConstellation[];
  stars: StarDef[];
  exercises: Exercise[];
  /** Verified on Kaggle where it has to be. */
  checked: (ex: Exercise) => boolean;
  problems: CatalogProblem[];
}

/**
 * Read the topic packs into the catalog being built. Whatever is wrong in a
 * pack (a bad file, a taken id, a missing link) is left out and noted in
 * `problems`; nothing is thrown.
 */
function loadPacks(root: string, into: PackTarget): PackInfo[] {
  const packs: PackInfo[] = [];
  const found: { info: PackInfo; file: z.infer<typeof PackFile> }[] = [];
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    const at = join(root, name);
    if (!existsSync(join(at, "pack.json"))) continue;
    const note = (message: string) => into.problems.push({ where: name, message });
    let file: z.infer<typeof PackFile>;
    try {
      file = PackFile.parse(JSON.parse(read(join(at, "pack.json"))));
    } catch (e) {
      note(`pack.json is not valid: ${problemText(e)}`);
      continue;
    }
    if (file.protocol > CONTENT_PROTOCOL) {
      note(`It is written for protocol ${file.protocol}; this bridge reads up to ${CONTENT_PROTOCOL}.`);
      continue;
    }
    if (file.id !== name) {
      note(`The folder ${name} holds the pack ${file.id}: the two must be the same.`);
      continue;
    }
    const info: PackInfo = { id: file.id, name: file.name, ...(file.description ? { description: file.description } : {}), dir: at, stars: [], exercises: [], unfinished: [] };
    if (file.constellation) {
      const c = file.constellation;
      if (into.constellations.some((x) => x.id === c.id)) note(`The constellation ${c.id} already exists; the pack's stars may join it, but it is not defined again.`);
      else {
        into.constellations.push({ id: c.id, name: c.name, kind: "topic", ...(c.description ? { description: c.description } : {}), daily: c.daily });
        info.constellation = c.id;
      }
    }
    packs.push(info);
    found.push({ info, file });
  }

  // Stars, once every pack's constellation is known (a pack may add to another's).
  const fresh: { star: StarDef; placed: boolean; pack: string }[] = [];
  for (const { info, file } of found) {
    for (const s of file.stars) {
      const note = (message: string) => into.problems.push({ where: info.id, message });
      const constellation = s.constellation ?? file.constellation?.id;
      const home = into.constellations.find((c) => c.id === constellation);
      if (!constellation || !home) {
        note(`Star ${s.id} is in ${constellation ? `an unknown constellation ${constellation}` : "no constellation (the pack has none of its own)"}; it is left out.`);
        continue;
      }
      if (home.kind === "paper") {
        note(`Star ${s.id} cannot join a paper's constellation; it is left out.`);
        continue;
      }
      if (into.stars.some((x) => x.id === s.id) || fresh.some((x) => x.star.id === s.id)) {
        note(`A star ${s.id} already exists; the pack's is left out (exercises may still sit on the existing one).`);
        continue;
      }
      fresh.push({ star: { id: s.id, name: s.name, constellation, x: s.x ?? 0, y: s.y ?? 0, after: s.after }, placed: s.x !== undefined && s.y !== undefined, pack: info.id });
      info.stars.push(s.id);
    }
  }
  const starIds = new Set([...into.stars.map((s) => s.id), ...fresh.map((f) => f.star.id)]);
  for (const f of fresh) {
    const unknown = f.star.after.filter((a) => !starIds.has(a));
    if (!unknown.length) continue;
    into.problems.push({ where: f.pack, message: `Star ${f.star.id} comes after unknown star(s) ${unknown.join(", ")}; those links are dropped.` });
    f.star.after = f.star.after.filter((a) => starIds.has(a));
  }
  // Places: a topic constellation is laid out as a whole unless every star of it has a place; on the star map, a free spot near the stars before.
  for (const c of into.constellations) {
    const own = fresh.filter((f) => f.star.constellation === c.id);
    if (!own.length) continue;
    if (c.kind === "topic") {
      if (own.every((f) => f.placed)) continue;
      const at = autoLayout(own.map((f) => f.star.id), (id) => own.find((f) => f.star.id === id)?.star.after ?? []);
      for (const f of own) Object.assign(f.star, at.get(f.star.id));
      continue;
    }
    for (const f of own) {
      if (f.placed) continue;
      const known = [...into.stars, ...fresh.filter((x) => x.placed).map((x) => x.star)];
      const before = known.filter((s) => f.star.after.includes(s.id));
      const around = before.length ? before : known.filter((s) => s.constellation === c.id);
      const target = around.length
        ? { x: around.reduce((n, s) => n + s.x, 0) / around.length + (before.length ? 8 : 0), y: around.reduce((n, s) => n + s.y, 0) / around.length }
        : { x: 50, y: 50 };
      Object.assign(f.star, freeSpot(known, target));
      f.placed = true;
    }
  }
  into.stars.push(...fresh.map((f) => f.star));

  // Exercises, pack by pack: each may build on the original set and on the packs before it.
  for (const info of packs) {
    const root = join(info.dir, "exercises");
    const own: Exercise[] = [];
    for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
      const at = join(root, name);
      if (!statSync(at).isDirectory()) continue;
      const note = (message: string) => into.problems.push({ where: `${info.id}/${name}`, message });
      if (!existsSync(join(at, "meta.json"))) {
        info.unfinished.push(name);
        continue;
      }
      let ex: Exercise;
      try {
        ex = { ...loadExercise(at, name), pack: info.id };
      } catch (e) {
        note(problemText(e));
        continue;
      }
      if (ex.paper) note("A pack's exercise cannot belong to a paper (papers have their own folder); it is left out.");
      else if (ex.diagnostic) note("A pack's exercise cannot be part of the diagnostic; it is left out.");
      else if (!starIds.has(ex.star)) note(`It is on an unknown star ${ex.star}; it is left out.`);
      else if (into.exercises.some((x) => x.id === ex.id) || own.some((x) => x.id === ex.id)) note(`An exercise ${ex.id} already exists; this one is left out.`);
      else if (!into.checked(ex)) note("It needs PyTorch and is not verified on Kaggle as it is now (ainb mentor verify); it is left out until then.");
      else own.push(ex);
    }
    // Links: to exercises that exist, with no circle.
    for (let changed = true; changed;) {
      changed = false;
      const byId = new Map([...into.exercises, ...own].map((e) => [e.id, e]));
      for (let i = own.length - 1; i >= 0; i--) {
        const problem = linkProblem(own[i]!, byId);
        if (!problem) continue;
        into.problems.push({ where: `${info.id}/${own[i]!.id}`, message: `${problem} It is left out.` });
        own.splice(i, 1);
        changed = true;
      }
    }
    try {
      const byId = new Map([...into.exercises, ...own].map((e) => [e.id, e]));
      usesOrder([...byId.keys()], (id) => byId.get(id)?.uses ?? []);
    } catch (e) {
      into.problems.push({ where: info.id, message: `${(e as Error).message} The pack's exercises are left out.` });
      continue;
    }
    into.exercises.push(...own);
    info.exercises.push(...own.map((e) => e.id));
  }
  return packs;
}

/** An error as one line: zod's issues with their paths, or the message. */
export function problemText(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ");
  return (e as Error).message.split("\n")[0] ?? String(e);
}
