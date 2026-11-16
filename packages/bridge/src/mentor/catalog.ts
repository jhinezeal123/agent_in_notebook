// The curated exercises shipped with the bridge (packages/bridge/mentor-catalog):
// the star map, and for each exercise its brief, formula-lab cells, starter,
// reference solution, hidden tests and probing questions. The reference and
// the tests never go into the learner's notebook.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MENTOR_SKILLS, type MentorSkill } from "@ainb/protocol";

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
});

const Probe = z.object({
  q: z.string().min(1),
  /** The misconception a wrong answer shows. */
  tag: z.string().min(1),
  /** What a right answer says, for grading (never shown to the learner as is). */
  answer: z.string().min(1),
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
export type StarDef = z.infer<typeof Star>;

export interface LabCell {
  type: "code" | "markdown";
  source: string;
}

export interface Exercise extends ExerciseMeta {
  brief: string;
  lab: LabCell[];
  starter: string;
  reference: string;
  tests: string;
  probeBank: ProbeDef[];
  /** Deliberately broken solutions the tests must catch (the catalog's self-check). */
  mutants: { name: string; source: string }[];
}

export interface Catalog {
  dir: string;
  constellations: z.infer<typeof MapFile>["constellations"];
  stars: StarDef[];
  exercises: Exercise[];
  exercise(id: string): Exercise | undefined;
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

export function loadCatalog(dir = catalogDir()): Catalog {
  const map = MapFile.parse(JSON.parse(read(join(dir, "map.json"))));
  const starIds = new Set(map.stars.map((s) => s.id));
  for (const s of map.stars) {
    for (const a of s.after) if (!starIds.has(a)) throw new Error(`Star ${s.id} comes after an unknown star ${a}.`);
    if (!map.constellations.some((c) => c.id === s.constellation)) throw new Error(`Star ${s.id} is in an unknown constellation ${s.constellation}.`);
  }
  const root = join(dir, "exercises");
  const exercises: Exercise[] = [];
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    const at = join(root, name);
    if (!existsSync(join(at, "meta.json"))) continue;
    const meta = Meta.parse(JSON.parse(read(join(at, "meta.json"))));
    if (meta.id !== name) throw new Error(`Exercise folder ${name} holds the exercise ${meta.id}.`);
    if (!starIds.has(meta.star)) throw new Error(`Exercise ${meta.id} is on an unknown star ${meta.star}.`);
    const mutantsDir = join(at, "mutants");
    exercises.push({
      ...meta,
      brief: read(join(at, "brief.md")).trim(),
      lab: existsSync(join(at, "lab.py")) ? parseCells(read(join(at, "lab.py"))) : [],
      starter: existsSync(join(at, "starter.py")) ? read(join(at, "starter.py")).trim() : "",
      reference: read(join(at, "reference.py")),
      tests: read(join(at, "tests.py")),
      probeBank: z.array(Probe).min(1).parse(JSON.parse(read(join(at, "probes.json")))),
      mutants: existsSync(mutantsDir)
        ? readdirSync(mutantsDir).filter((f) => f.endsWith(".py")).sort().map((f) => ({ name: f.replace(/\.py$/, ""), source: read(join(mutantsDir, f)) }))
        : [],
    });
  }
  exercises.sort((a, b) => a.difficulty - b.difficulty || a.order - b.order || a.id.localeCompare(b.id));
  const byId = new Map(exercises.map((e) => [e.id, e]));
  return { dir, constellations: map.constellations, stars: map.stars, exercises, exercise: (id) => byId.get(id) };
}
