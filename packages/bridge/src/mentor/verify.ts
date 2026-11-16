// Checking an exercise on a real machine: its reference solution passes its
// hidden tests (twice, so a flaky test shows), its starter and every
// deliberately broken solution fail, nothing of the solution leaks into the
// learner's notebook, the formula lab runs, and the judge is fast enough.
// Curated PyTorch exercises are checked this way on a Kaggle notebook (the
// learner's computer has no PyTorch); exercises the mentor writes for a paper
// must pass it before the learner sees them. It shows the exercise is
// consistent, not that it is faithful to the paper.

import type { ExecResult } from "@ainb/protocol";
import { usesOrder, type Catalog, type Exercise } from "./catalog.js";
import { judgeCode, newNonce, parseVerdict, type JudgeContext } from "./judge.js";
import { exerciseCells } from "./notebook.js";

export type Exec = (code: string, waitMs: number) => Promise<Pick<ExecResult, "status" | "outputs" | "message">>;

export interface VerifyCheck {
  id: string;
  ok: boolean;
  /** Why it failed (or a measurement), short. */
  note?: string;
}

export interface VerifyReport {
  exerciseId: string;
  /** Of the exercise's files when it was checked. */
  hash: string;
  ok: boolean;
  checks: VerifyCheck[];
  python?: string;
  torch?: string | null;
  at: number;
  seconds: number;
}

/** Labels of the checks, for people. */
export const CHECK_LABEL: Record<string, string> = {
  files: "đủ test, câu hỏi, bản sai",
  modules: "máy có đủ thư viện",
  reference: "lời giải chuẩn qua mọi test (2 lần)",
  starter: "starter trượt",
  mutants: "mọi bản cố tình sai đều chạy được và trượt",
  speed: "chấm đủ nhanh",
  lab: "các cell Phòng công thức chạy được",
  leak: "lời giải không lọt vào notebook",
  metrics: "thí nghiệm báo được con số",
};

/** What runs before an exercise when its reference is checked: the paper's given code, and the exercises it uses (their references). */
export function referenceContext(catalog: Pick<Catalog, "exercise" | "paperGiven">, ex: Exercise): JudgeContext {
  const used = usesOrder(ex.uses, (id) => catalog.exercise(id)?.uses ?? []).map((id) => catalog.exercise(id)).filter((u): u is Exercise => !!u);
  const code = [ex.paper ? catalog.paperGiven(ex.paper) : "", ...used.flatMap((u) => [u.given, u.reference])].map((c) => c.trim()).filter(Boolean).join("\n\n");
  return { before: code, beforeRef: code };
}

/** Lines of the reference solution that show up in the learner's notebook. */
export function leakedLines(ex: Exercise): string[] {
  const text = exerciseCells(ex).map((c) => c.source).join("\n");
  // Lines the lab, the starter or the given code show on purpose may also be in the reference.
  const shown = [ex.starter, ex.given, ...ex.lab.map((c) => c.source)].join("\n");
  return ex.reference.split("\n").map((l) => l.trim()).filter((l) => l.length > 25 && !shown.includes(l) && text.includes(l));
}

const MARK = /<<MENTOR-ENV (\{.*\}) MENTOR-ENV>>/;

function envCode(requires: string[]): string {
  return String.raw`
def _ainb_env():
    import importlib.util, json, sys
    torch = None
    if importlib.util.find_spec("torch") is not None:
        import torch as _t
        torch = _t.__version__
    missing = [m for m in json.loads('${JSON.stringify(requires)}') if importlib.util.find_spec(m) is None]
    print("<<MENTOR-ENV " + json.dumps({"python": sys.version.split()[0], "torch": torch, "missing": missing}) + " MENTOR-ENV>>")
try:
    _ainb_env()
finally:
    del _ainb_env
`.trimStart();
}

function labCode(cells: string[], prelude: string, before: string, given: string): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  return String.raw`
def _ainb_lab():
    import base64, contextlib, io, json, traceback
    ns = {"__name__": "__mentor_lab__"}
    errors = []
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        plt = None
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        for i, code in enumerate(json.loads(base64.b64decode("${b64(JSON.stringify([prelude, before, given, ...cells]))}").decode("utf-8"))):
            try:
                exec(compile(code, f"<lab-{i}>", "exec"), ns)
            except Exception as e:
                errors.append(f"cell {i - 2}: {type(e).__name__}: {str(e)[:200]}")
                break
    if plt is not None:
        plt.close("all")
    print("<<MENTOR-ENV " + json.dumps({"errors": errors}) + " MENTOR-ENV>>")
try:
    _ainb_lab()
finally:
    del _ainb_lab
`.trimStart();
}

function marked<T>(res: Pick<ExecResult, "outputs">): T | null {
  const text = res.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
  const m = text.match(MARK);
  try {
    return m ? JSON.parse(m[1]!) as T : null;
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** What runs before (the exercises it uses, the paper's given code). */
  context?: JudgeContext;
  now?: () => number;
  /** Progress, one line per step. */
  onStep?: (text: string) => void;
}

export async function verifyExercise(ex: Exercise, exec: Exec, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const checks: VerifyCheck[] = [];
  const add = (id: string, ok: boolean, note?: string) => checks.push({ id, ok, ...(note ? { note } : {}) });
  const ai = ex.author === "ai";
  const experiment = ex.role === "experiment";
  const ctx: JudgeContext = { ...opts.context, mode: "source" };
  const judgeWait = ex.judgeSeconds * 1000;

  // 1. The files, without running anything.
  const tests = (ex.tests.match(/^def test_\w+/gm) ?? []).length;
  const mutantsNeeded = experiment ? 1 : ai ? 3 : 2;
  const problems = [
    tests < (experiment ? 1 : 4) ? `${tests} test (cần ≥ ${experiment ? 1 : 4})` : "",
    ex.probeBank.length < ex.probes + (ai ? 1 : 0) ? `${ex.probeBank.length} câu hỏi (cần ≥ ${ex.probes + (ai ? 1 : 0)})` : "",
    ex.mutants.length < mutantsNeeded ? `${ex.mutants.length} bản sai (cần ≥ ${mutantsNeeded})` : "",
    experiment && !ex.metrics.length ? "thí nghiệm chưa khai metrics" : "",
  ].filter(Boolean);
  add("files", !problems.length, problems.join("; "));
  const leaks = leakedLines(ex);
  add("leak", !leaks.length, leaks[0]?.slice(0, 120));

  // 2. The machine.
  opts.onStep?.("kiểm tra thư viện");
  const env = marked<{ python: string; torch: string | null; missing: string[] }>(await exec(envCode(ex.requires), 60_000));
  if (!env) add("modules", false, "không đọc được Python của máy");
  else add("modules", !env.missing.length, env.missing.length ? `thiếu ${env.missing.join(", ")}` : undefined);
  const finish = (): VerifyReport => ({
    exerciseId: ex.id, hash: ex.hash, ok: checks.every((c) => c.ok), checks,
    ...(env ? { python: env.python, torch: env.torch } : {}), at: now(), seconds: Math.round((now() - started) / 1000),
  });
  if (!env || env.missing.length) return finish();

  const judge = async (source: string, waitMs = judgeWait) => {
    const nonce = newNonce();
    const t0 = now();
    const res = await exec(judgeCode(ex, source, nonce, ctx), waitMs);
    return { verdict: parseVerdict(res, nonce), ms: now() - t0 };
  };

  // 3. The reference passes, twice.
  opts.onStep?.("chấm lời giải chuẩn");
  const refWait = experiment ? Math.max(judgeWait, 15 * 60_000) : judgeWait;
  const first = await judge(ex.reference, refWait);
  const second = first.verdict.ok && !experiment ? await judge(ex.reference, refWait) : first;
  const failed = (v: typeof first.verdict) => v.error ?? v.tests.filter((t) => !t.ok).map((t) => `${t.name}: ${t.message ?? "trượt"}`)[0] ?? "không có test nào";
  if (!first.verdict.ok) add("reference", false, failed(first.verdict));
  else if (!second.verdict.ok) add("reference", false, `lần 2 trượt (test chập chờn?): ${failed(second.verdict)}`);
  else add("reference", true);
  const slowest = Math.max(first.ms, second.ms);
  const limit = experiment ? refWait : judgeWait / 3;
  add("speed", slowest <= limit, `${(slowest / 1000).toFixed(1)} s (giới hạn ${(limit / 1000).toFixed(0)} s)`);
  if (experiment) add("metrics", !!first.verdict.metrics?.length, first.verdict.metrics?.map((m) => `${m.name} = ${m.value.toPrecision(4)}`).join(", ") || "tests chưa gọi t.report");

  // 4. The starter and the broken solutions fail.
  if (!experiment) {
    opts.onStep?.("chấm starter");
    const starter = await judge(ex.starter);
    add("starter", !starter.verdict.ok, starter.verdict.ok ? "starter qua hết test: test quá lỏng" : undefined);
  }
  const caught: string[] = [];
  for (const m of ex.mutants) {
    opts.onStep?.(`chấm bản sai ${m.name}`);
    const { verdict } = await judge(m.source, refWait);
    if (verdict.ok) caught.push(`${m.name} lọt qua test`);
    else if (verdict.error && !experiment) caught.push(`${m.name} không chạy được (${verdict.error.slice(0, 80)})`);
  }
  add("mutants", !caught.length, caught.join("; "));

  // 5. The formula lab runs.
  const lab = ex.lab.filter((c) => c.type === "code").map((c) => c.source);
  if (lab.length) {
    opts.onStep?.("chạy Phòng công thức");
    const out = marked<{ errors: string[] }>(await exec(labCode(lab, ex.prelude, ctx.beforeRef ?? "", ex.given), 120_000));
    add("lab", !!out && !out.errors.length, out ? out.errors[0] : "không đọc được kết quả");
  }
  return finish();
}

/** One line per check, for a log or the agent. */
export function reportText(r: VerifyReport): string {
  const head = `${r.ok ? "✓" : "✗"} ${r.exerciseId} (${r.seconds} s${r.python ? `, Python ${r.python}` : ""}${r.torch ? `, torch ${r.torch}` : ""})`;
  return [head, ...r.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${CHECK_LABEL[c.id] ?? c.id}${c.note ? `: ${c.note}` : ""}`)].join("\n");
}
