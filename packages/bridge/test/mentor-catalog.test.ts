// The curated Mentor exercises check themselves: each reference solution
// passes its hidden tests, and each deliberately broken solution (and the
// empty starter) fails them. Runs the judge's real Python harness, so it
// needs Python with numpy; skipped without it.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/mentor/catalog.js";
import { judgeCode, newNonce, parseVerdict } from "../src/mentor/judge.js";
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
const catalog = loadCatalog();

function judge(ex: Exercise, source: string) {
  const nonce = newNonce();
  const r = spawnSync(python![0]!, [...python!.slice(1), "-X", "utf8", "-"], { input: judgeCode(ex, source, nonce), encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" } });
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
      const { cells } = parseIpynb(exerciseNotebook(ex));
      const text = cells.map((c) => c.source).join("\n");
      // Lines the lab shows on purpose (making data, say) may also be in the tests; the solution's lines never are.
      const shown = [ex.starter, ...ex.lab.map((c) => c.source)].join("\n");
      const hidden = ex.reference.split("\n").map((l) => l.trim()).filter((l) => l.length > 25 && !shown.includes(l));
      for (const line of hidden) expect(text, `${ex.id}: ${line}`).not.toContain(line);
      const solution = cells.filter((c) => isSolutionCell({ id: c.id ?? "", type: c.type, source: c.source }));
      expect(solution.length, ex.id).toBe(1);
    }
  });
});

describe.skipIf(!python)("mentor exercises judge themselves", () => {
  for (const ex of catalog.exercises) {
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
