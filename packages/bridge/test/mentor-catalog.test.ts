// The curated Mentor exercises check themselves: each reference solution
// passes its hidden tests, and each deliberately broken solution (and the
// empty starter) fails them. Runs the judge's real Python harness, so it
// needs Python with numpy; skipped without it. Exercises that need a module
// this machine lacks (PyTorch) are checked on Kaggle instead (`ainb mentor
// verify`): they need a record in verified.json matching their files.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/mentor/catalog.js";
import { judgeCode, newNonce, parseVerdict } from "../src/mentor/judge.js";
import { leakedLines, referenceContext } from "../src/mentor/verify.js";
import { readVerified } from "../src/mentor/verify-cli.js";
import { exerciseNotebook, isSolutionCell } from "../src/mentor/notebook.js";
import { parseIpynb } from "../src/notebook/ipynb.js";
import type { Exercise } from "../src/mentor/catalog.js";

function findPython(): string[] | null {
  const candidates = process.platform === "win32" ? [["python"], ["py", "-3"]] : [["python3"], ["python"]];
  for (const c of candidates) {
    const r = spawnSync(c[0]!, [...c.slice(1), "-c", "import numpy"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

const python = findPython();
const catalog = loadCatalog(undefined, { unverified: true });
const modules = new Set<string>();
if (python) {
  const wanted = [...new Set(catalog.exercises.flatMap((e) => e.requires))];
  const r = spawnSync(python[0]!, [...python.slice(1), "-c", `import importlib.util,json;print(json.dumps([m for m in ${JSON.stringify(wanted)} if importlib.util.find_spec(m)]))`], { encoding: "utf8" });
  for (const m of JSON.parse(r.stdout || "[]") as string[]) modules.add(m);
}
/** Checked here, with this machine's Python. */
const local = catalog.exercises.filter((e) => e.requires.every((m) => modules.has(m)));
/** Checked on Kaggle (verified.json). */
const remote = catalog.exercises.filter((e) => e.requires.includes("torch"));
const verified = readVerified(catalog.dir);

function judge(ex: Exercise, source: string) {
  const nonce = newNonce();
  const r = spawnSync(python![0]!, [...python!.slice(1), "-X", "utf8", "-"], { input: judgeCode(ex, source, nonce, referenceContext(catalog, ex)), encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" } });
  return parseVerdict({ status: r.status === 0 ? "ok" : "error", outputs: [{ kind: "stream", name: "stdout", text: r.stdout ?? "" }], message: r.stderr }, nonce);
}

describe("mentor catalog", () => {
  it("has a valid map and a three-session diagnostic", () => {
    expect(catalog.exercises.length).toBeGreaterThanOrEqual(8);
    const sessions = new Set(catalog.exercises.filter((e) => e.diagnostic).map((e) => e.diagnostic));
    expect([...sessions].sort()).toEqual([1, 2, 3]);
    for (const ex of catalog.exercises) {
      expect(catalog.stars.some((s) => s.id === ex.star)).toBe(true);
      expect(ex.probeBank.length).toBeGreaterThanOrEqual(ex.probes);
      expect(ex.mutants.length).toBeGreaterThan(0);
    }
  });

  it("never writes the reference or the tests into the learner's notebook", () => {
    for (const ex of catalog.exercises) {
      expect(leakedLines(ex), ex.id).toEqual([]);
      const { cells } = parseIpynb(exerciseNotebook(ex));
      const solution = cells.filter((c) => isSolutionCell({ id: c.id ?? "", type: c.type, source: c.source }));
      expect(solution.length, ex.id).toBe(1);
    }
  });

  it("has the PyTorch exercises checked on Kaggle, as they are now", () => {
    const stale = remote.filter((e) => verified[e.id]?.hash !== e.hash).map((e) => e.id);
    expect(stale, "run `node packages/bridge/dist/cli.js mentor verify <id…>` with a Kaggle notebook open").toEqual([]);
  });
});

describe.skipIf(!python)("mentor exercises judge themselves", () => {
  for (const ex of local) {
    it(`${ex.id}: the reference passes`, () => {
      const v = judge(ex, ex.reference);
      expect(v.error, JSON.stringify(v)).toBeUndefined();
      expect(v.tests.filter((t) => !t.ok), JSON.stringify(v.tests)).toEqual([]);
      expect(v.ok).toBe(true);
    });
    it(`${ex.id}: the starter fails`, () => {
      expect(judge(ex, ex.starter).ok).toBe(false);
    });
    for (const m of ex.mutants) {
      it(`${ex.id}: catches ${m.name}`, () => {
        const v = judge(ex, m.source);
        expect(v.ok, `${m.name} passed: ${JSON.stringify(v.tests)}`).toBe(false);
        expect(v.missing).toBeUndefined();
      });
    }
  }
});
