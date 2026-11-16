// `ainb mentor check`: check Mentor content against the content protocol
// (mentor-catalog/PROTOCOL.md) on this computer. For each exercise: the
// protocol's static rules (lint.ts), the syntax of its Python files, and,
// when this computer's Python has the modules it needs, the full check of
// verify.ts (the reference passes twice, the starter and every broken
// solution fail, the lab runs). Exercises that need a module this computer
// lacks (PyTorch) are told apart: they are checked on Kaggle (`ainb mentor
// verify`).
// `ainb mentor reload`: tell the running bridge to read the catalog again.

import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { catalogDir, loadCatalog, needsKaggleCheck, problemText, type Catalog, type Exercise } from "./catalog.js";
import { lintExercise, type LintIssue } from "./lint.js";
import { referenceContext, reportText, verifyExercise, type Exec, type VerifyReport } from "./verify.js";
import { readVerified } from "./verify-cli.js";

export function findPython(): string[] | null {
  const candidates = process.platform === "win32" ? [["python"], ["py", "-3"]] : [["python3"], ["python"]];
  for (const c of candidates) {
    const r = spawnSync(c[0]!, [...c.slice(1), "-c", "print(1)"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

/** A kernel call as a fresh Python on this computer. */
export function localExec(python: string[]): Exec {
  return async (code, waitMs) => {
    const r = spawnSync(python[0]!, [...python.slice(1), "-X", "utf8", "-"], {
      input: code, encoding: "utf8", timeout: waitMs, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" },
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return { status: timedOut ? "running" : r.status === 0 ? "ok" : "error", outputs: [{ kind: "stream", name: "stdout", text: r.stdout ?? "" }], message: r.stderr ?? "" };
  };
}

/** Syntax errors in an exercise's Python files (compiled, not run). */
export function syntaxErrors(ex: Exercise, python: string[]): string[] {
  const files: Record<string, string> = {
    "prelude (meta.json)": ex.prelude, "starter.py": ex.starter, "given.py": ex.given, "reference.py": ex.reference, "tests.py": ex.tests,
    ...Object.fromEntries(ex.mutants.map((m) => [`mutants/${m.name}.py`, m.source])),
    ...Object.fromEntries(ex.lab.filter((c) => c.type === "code").map((c, i) => [`lab.py (cell code ${i + 1})`, c.source])),
  };
  const code = [
    "import json, sys",
    "files = json.loads(sys.stdin.read())",
    "errors = []",
    "for name, source in files.items():",
    "    try:",
    "        compile(source, name, 'exec')",
    "    except SyntaxError as e:",
    "        errors.append(f'{name}, dòng {e.lineno}: {e.msg}')",
    "print(json.dumps(errors, ensure_ascii=False))",
  ].join("\n");
  const r = spawnSync(python[0]!, [...python.slice(1), "-X", "utf8", "-c", code], { input: JSON.stringify(files), encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  try {
    return JSON.parse(r.stdout) as string[];
  } catch {
    return [`không kiểm được cú pháp (${(r.stderr ?? "").trim().split("\n").pop() ?? "Python không chạy"})`];
  }
}

export interface CheckResult {
  exercise: Exercise;
  issues: LintIssue[];
  syntax: string[];
  /** The full check, when it ran here. */
  report?: VerifyReport;
  /** Modules this computer lacks: the exercise is checked on Kaggle instead. */
  missing?: string[];
  /** Verified on Kaggle as it is now (for an exercise that has to be). */
  verified?: boolean;
  ok: boolean;
}

/** Check one exercise on this computer. */
export async function checkExercise(catalog: Catalog, ex: Exercise, python: string[] | null, onStep?: (text: string) => void): Promise<CheckResult> {
  const issues = lintExercise(ex);
  const syntax = python ? syntaxErrors(ex, python) : [];
  const result: CheckResult = { exercise: ex, issues, syntax, ok: false };
  const sound = !issues.some((i) => i.level === "error") && !syntax.length;
  if (python && !syntax.length) {
    const report = await verifyExercise(ex, localExec(python), { context: referenceContext(catalog, ex), onStep });
    const modules = report.checks.find((c) => c.id === "modules");
    if (modules && !modules.ok && /^thiếu /.test(modules.note ?? "")) result.missing = modules.note!.replace(/^thiếu /, "").split(", ");
    else result.report = report;
  }
  if (needsKaggleCheck(ex)) result.verified = readVerified(catalog.dir)[ex.id]?.hash === ex.hash;
  result.ok = sound && (result.report ? result.report.ok : true);
  return result;
}

export function checkText(r: CheckResult): string {
  const ex = r.exercise;
  const pending = !!r.missing && r.ok;
  const lines = [`${!r.ok ? "✗" : pending ? "…" : "✓"} ${ex.id}  (${ex.pack ? `gói ${ex.pack} · ` : ""}sao ${ex.star} · độ khó ${ex.difficulty})`];
  const errors = r.issues.filter((i) => i.level === "error");
  lines.push(`  ${errors.length ? "✗" : "✓"} đúng giao thức${errors.length ? `: ${errors.length} lỗi` : ""}`);
  for (const i of r.issues) lines.push(`      ${i.level === "error" ? "lỗi" : "nên sửa"}: ${i.text}`);
  if (r.syntax.length) lines.push("  ✗ cú pháp Python", ...r.syntax.map((s) => `      ${s}`));
  if (r.report) lines.push(...reportText(r.report).split("\n").slice(1));
  if (r.missing) {
    lines.push(`  … máy này thiếu ${r.missing.join(", ")}: chưa chạy được ở đây.`);
    lines.push(r.verified === undefined
      ? `      Kiểm trên Kaggle: ainb mentor verify ${ex.id}`
      : r.verified
        ? "      Đã kiểm trên Kaggle, đúng với các file hiện tại."
        : `      CHƯA kiểm trên Kaggle (người học chưa thấy bài này): ainb mentor verify ${ex.id}`);
  }
  return lines.join("\n");
}

export async function mentorCheck(args: string[]): Promise<number> {
  const dirAt = args.indexOf("--catalog");
  const dir = dirAt >= 0 ? args[dirAt + 1] : undefined;
  const all = args.includes("--all");
  const names = args.filter((a, i) => !a.startsWith("--") && !(dirAt >= 0 && i === dirAt + 1));
  let catalog: Catalog;
  try {
    catalog = loadCatalog(dir ?? catalogDir(), { unverified: true });
  } catch (e) {
    console.error(`The catalog does not load: ${problemText(e)}`);
    return 1;
  }
  // What to check: the packs or exercises named; else every pack; with --all, the original set too.
  const wanted = new Map<string, Exercise>();
  const unknown: string[] = [];
  for (const name of names) {
    const pack = catalog.packs.find((p) => p.id === name);
    const ex = catalog.exercise(name);
    if (pack) for (const id of pack.exercises) wanted.set(id, catalog.exercise(id)!);
    else if (ex) wanted.set(ex.id, ex);
    else unknown.push(name);
  }
  if (!names.length) for (const e of catalog.exercises) if (!e.paper && (all || e.pack)) wanted.set(e.id, e);
  const packs = names.length ? catalog.packs.filter((p) => names.includes(p.id) || p.exercises.some((id) => wanted.has(id))) : catalog.packs;
  const problems = catalog.problems.filter((p) => !names.length || packs.some((k) => p.where === k.id || p.where.startsWith(`${k.id}/`)) || names.some((n) => p.where === n || p.where.endsWith(`/${n}`)));

  const python = findPython();
  if (!python) console.log("No Python on this computer: only the protocol's static rules are checked.");
  for (const p of packs) {
    console.log(`Pack ${p.id} "${p.name}": ${p.stars.length} star(s), ${p.exercises.length} exercise(s)${p.constellation ? `, its own constellation ${p.constellation}` : ""}.`);
    if (p.unfinished.length) console.log(`  Unfinished (no meta.json yet, not loaded): ${p.unfinished.join(", ")}`);
  }
  for (const p of problems) console.log(`✗ ${p.where}: ${p.message}`);
  for (const name of unknown) console.log(`✗ ${name}: no such pack or exercise (a folder without meta.json or pack.json is not loaded; see the lines above).`);

  const results: CheckResult[] = [];
  for (const ex of wanted.values()) {
    const r = await checkExercise(catalog, ex, python);
    results.push(r);
    console.log(checkText(r));
  }
  const failed = results.filter((r) => !r.ok);
  const remote = results.filter((r) => r.ok && r.missing);
  const unverified = remote.filter((r) => r.verified === false);
  console.log(`\n${results.length} exercise(s): ${results.length - failed.length - remote.length} pass here, ${remote.length} need Kaggle${unverified.length ? ` (${unverified.length} not verified yet)` : ""}, ${failed.length} fail. ${problems.length + unknown.length} problem(s) in the packs.`);
  if (unverified.length) console.log(`Verify on Kaggle (a Kaggle notebook open in Chrome, its machine on): ainb mentor verify ${unverified.map((r) => r.exercise.id).join(" ")}`);
  const bad = failed.length + problems.length + unknown.length;
  if (!bad) console.log("Then: ainb mentor reload (the running Mentor reads the catalog again).");
  return bad ? 1 : 0;
}

export async function mentorReload(): Promise<number> {
  const cfg = loadConfig();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/mentor/reload`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: "{}" });
  } catch {
    console.log("The bridge is not running: Mentor reads the catalog when it starts, so there is nothing to reload.");
    return 0;
  }
  const body = await res.json().catch(() => ({})) as { exercises?: number; packs?: { id: string; exercises: number }[]; problems?: { where: string; message: string }[]; error?: string };
  if (!res.ok) {
    console.error(`The bridge could not reload the catalog: ${body.error ?? res.status}`);
    return 1;
  }
  console.log(`Mentor now has ${body.exercises} exercise(s)${body.packs?.length ? `; packs: ${body.packs.map((p) => `${p.id} (${p.exercises})`).join(", ")}` : ""}.`);
  for (const p of body.problems ?? []) console.log(`✗ ${p.where}: ${p.message}`);
  return 0;
}
