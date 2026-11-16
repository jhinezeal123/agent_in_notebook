// The judge: runs an exercise's hidden tests on the learner's solution cells,
// in the notebook's kernel (so it sees the same Python and packages), inside
// one function so nothing is left in the learner's namespace. The learner's
// cells run from their source in a fresh namespace, never from the kernel's
// variables, so a stale cell or the agent's own experiments cannot pass a test.

import { randomBytes } from "node:crypto";
import type { ExecResult, MentorVerdict } from "@ainb/protocol";
import type { Exercise } from "./catalog.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * The helpers every test file gets as `t` (never in the learner's notebook):
 * seeding, comparisons with a message in Vietnamese, gradients, copying a
 * module's weights, and reporting an experiment's numbers. numpy and torch
 * are imported only when used.
 */
export const TEST_LIB = String.raw`
class _MentorT:
    def __init__(self, out):
        self._out = out
    def seed(self, n=0):
        import random
        random.seed(n)
        try:
            import numpy
            numpy.random.seed(n)
        except ImportError:
            pass
        try:
            import torch
            torch.manual_seed(n)
        except ImportError:
            pass
    def array(self, x):
        import numpy
        if hasattr(x, "detach") and hasattr(x, "cpu"):
            x = x.detach().cpu()
            x = x.double() if x.is_floating_point() else x
            return x.numpy()
        return numpy.asarray(x)
    def shape(self, x, expected, what="kết quả"):
        got = tuple(getattr(x, "shape", ()))
        assert got == tuple(expected), f"Shape của {what} là {got}, cần {tuple(expected)}."
    def close(self, got, want, tol=1e-5, what="kết quả"):
        import numpy
        g, w = self.array(got).astype(float), self.array(want).astype(float)
        assert g.shape == w.shape, f"Shape của {what} là {g.shape}, cần {w.shape}."
        assert numpy.all(numpy.isfinite(g)) or not numpy.all(numpy.isfinite(w)), f"{what} có NaN hoặc inf."
        if not numpy.allclose(g, w, atol=tol, rtol=tol, equal_nan=True):
            err = float(numpy.nanmax(numpy.abs(g - w))) if g.size else 0.0
            raise AssertionError(f"{what} chưa đúng (lệch lớn nhất {err:.2e}).")
    def grads(self, f, *inputs, seed=0):
        """Gradients of a random weighting of f(*inputs) with respect to its float tensor inputs."""
        import torch
        xs = [x.detach().clone().requires_grad_(True) if isinstance(x, torch.Tensor) and x.is_floating_point() else x for x in inputs]
        out = f(*xs)
        g = torch.Generator().manual_seed(seed)
        w = torch.randn(out.shape, generator=g, dtype=out.dtype)
        (out * w).sum().backward()
        return [x.grad for x in xs if isinstance(x, torch.Tensor) and x.requires_grad]
    def grad_close(self, f_user, f_ref, *inputs, tol=1e-4, what="gradient"):
        gu, gr = self.grads(f_user, *inputs), self.grads(f_ref, *inputs)
        for i, (a, b) in enumerate(zip(gu, gr)):
            assert a is not None, f"{what}: đầu vào thứ {i + 1} không nhận được gradient (bị detach?)."
            self.close(a, b, tol=tol, what=f"{what} theo đầu vào thứ {i + 1}")
    def load_into(self, module, ref_module):
        """Copy the reference module's weights into the learner's (same parameter names)."""
        mine, theirs = module.state_dict(), ref_module.state_dict()
        missing = sorted(set(theirs) - set(mine))
        extra = sorted(set(mine) - set(theirs))
        assert not missing and not extra, f"Tham số của module chưa khớp đề: thiếu {missing[:4]}, thừa {extra[:4]}."
        for k, v in theirs.items():
            assert tuple(mine[k].shape) == tuple(v.shape), f"Tham số {k} có shape {tuple(mine[k].shape)}, cần {tuple(v.shape)}."
        module.load_state_dict(theirs)
    def report(self, name, value):
        """An experiment's number, shown to the learner next to the paper's."""
        self._out.setdefault("metrics", []).append({"name": str(name), "value": float(value)})
`;

export interface JudgeContext {
  /** Code run before the learner's cells: what the exercises it uses left (theirs, passed). */
  before?: string;
  /** The same for the reference: the reference solutions of those exercises. */
  beforeRef?: string;
  /** "kernel": test what the kernel holds now (an experiment's trained model), not the cells run afresh. */
  mode?: "source" | "kernel";
}

type Judged = Pick<Exercise, "prelude" | "reference" | "tests" | "requires"> & { given?: string; metrics?: Exercise["metrics"] };

/** Python that judges `source` (the learner's cells joined) and prints one marked JSON line. */
export function judgeCode(ex: Judged, source: string, nonce: string, ctx: JudgeContext = {}): string {
  const kernel = ctx.mode === "kernel";
  // An experiment's pass marks: checked here, not left to its tests.
  const targets = (ex.metrics ?? []).filter((m) => m.target).map((m) => ({ name: m.name, op: m.target!.op, value: m.target!.value }));
  return String.raw`
${TEST_LIB}
def _ainb_mentor_judge():
    import base64, contextlib, importlib.util, io, json, traceback
    def text(s):
        return base64.b64decode(s).decode("utf-8")
    out = {"nonce": "${nonce}", "tests": []}
    missing = [m for m in json.loads(text("${b64(JSON.stringify(ex.requires))}")) if importlib.util.find_spec(m) is None]
    if missing:
        out["missing"] = missing
        print("\n<<MENTOR " + json.dumps(out, ensure_ascii=False) + " MENTOR>>")
        return
    quiet = lambda: (contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()))
    prelude = text("${b64(ex.prelude)}")
    given = text("${b64(ex.given ?? "")}")
    ${kernel ? "user = globals()" : `user = {"__name__": "__mentor__"}
    try:
        a, b = quiet()
        with a, b:
            exec(compile(prelude, "<prelude>", "exec"), user)
            exec(compile(text("${b64(ctx.before ?? "")}"), "<bai-truoc>", "exec"), user)
            exec(compile(given, "<cho-san>", "exec"), user)
            exec(compile(text("${b64(source)}"), "<bai-lam>", "exec"), user)
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        if isinstance(e, SyntaxError):
            tb = [e]
        mine = [f for f in tb if f.filename == "<bai-lam>"]
        earlier = [f for f in tb if f.filename == "<bai-truoc>"]
        where = f" (dòng {mine[-1].lineno} của phần bài làm)" if mine else " (trong code của bạn từ các bài trước)" if earlier else ""
        out["error"] = f"{type(e).__name__}: {str(e)[:300]}{where}"
        print("\\n<<MENTOR " + json.dumps(out, ensure_ascii=False) + " MENTOR>>")
        return`}
    ref = {"__name__": "__mentor_ref__"}
    a, b = quiet()
    with a, b:
        exec(compile(prelude, "<prelude>", "exec"), ref)
        exec(compile(text("${b64(ctx.beforeRef ?? "")}"), "<reference-truoc>", "exec"), ref)
        exec(compile(given, "<cho-san>", "exec"), ref)
        exec(compile(text("${b64(kernel ? "" : ex.reference)}"), "<reference>", "exec"), ref)
    def need(ns, name):
        if not callable(ns.get(name)):
            raise AssertionError(f"Chưa thấy hàm \x60{name}\x60 trong cell bài làm.")
        return ns[name]
    tests = {"__name__": "__mentor_tests__", "need": need, "t": _MentorT(out)}
    exec(compile(prelude, "<prelude>", "exec"), tests)
    exec(compile(text("${b64(ex.tests)}"), "<tests>", "exec"), tests)
    for name, fn in list(tests.items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        label = ((fn.__doc__ or "").strip().splitlines() or [name[5:].replace("_", " ")])[0]
        try:
            a, b = quiet()
            with a, b:
                fn(user, ref)
            out["tests"].append({"id": name, "name": label, "ok": True})
        except AssertionError as e:
            out["tests"].append({"id": name, "name": label, "ok": False, "message": (str(e) or "Kết quả chưa đúng.")[:300]})
        except Exception as e:
            out["tests"].append({"id": name, "name": label, "ok": False, "message": f"{type(e).__name__}: {str(e)[:250]}"})
    reported = {m["name"]: m["value"] for m in out.get("metrics", [])}
    for tg in json.loads(text("${b64(JSON.stringify(targets))}")):
        entry = {"id": "target_" + tg["name"], "name": f'{tg["name"]} đạt ngưỡng ({tg["op"]} {tg["value"]:g})', "ok": False}
        if tg["name"] not in reported:
            entry["message"] = f'Chưa đo được "{tg["name"]}" (một test ở trên phải qua trước).'
        else:
            value = reported[tg["name"]]
            entry["ok"] = bool(value >= tg["value"] if tg["op"] == ">=" else value <= tg["value"])
            if not entry["ok"]:
                entry["message"] = f'Đo được {value:.4g}, cần {tg["op"]} {tg["value"]:g}.'
        out["tests"].append(entry)
    print("\n<<MENTOR " + json.dumps(out, ensure_ascii=False) + " MENTOR>>")
try:
    _ainb_mentor_judge()
finally:
    del _ainb_mentor_judge, _MentorT
`.trimStart();
}

export function newNonce(): string {
  return randomBytes(9).toString("base64url");
}

/** The verdict in a judge run's output, or why there is none. */
export function parseVerdict(res: Pick<ExecResult, "status" | "outputs" | "message">, nonce: string, at = Date.now()): MentorVerdict {
  const text = res.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
  const matches = [...text.matchAll(/<<MENTOR (\{.*\}) MENTOR>>/g)];
  for (const m of matches.reverse()) {
    let raw: { nonce?: unknown; tests?: unknown; error?: unknown; missing?: unknown; metrics?: unknown };
    try {
      raw = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    if (raw.nonce !== nonce) continue;
    const tests = Array.isArray(raw.tests)
      ? raw.tests.filter((t): t is { id?: string; name: string; ok: boolean; message?: string } => !!t && typeof t.name === "string" && typeof t.ok === "boolean")
        .map((t) => ({ ...(typeof t.id === "string" ? { id: t.id } : {}), name: t.name, ok: t.ok, ...(typeof t.message === "string" && !t.ok ? { message: t.message } : {}) }))
      : [];
    const passed = tests.filter((t) => t.ok).length;
    const verdict: MentorVerdict = { at, ok: false, passed, total: tests.length, tests };
    if (typeof raw.error === "string") verdict.error = raw.error;
    if (Array.isArray(raw.missing) && raw.missing.length) verdict.missing = raw.missing.map(String);
    const metrics = Array.isArray(raw.metrics)
      ? raw.metrics.filter((m): m is { name: string; value: number } => !!m && typeof m.name === "string" && typeof m.value === "number" && Number.isFinite(m.value))
      : [];
    if (metrics.length) verdict.metrics = metrics.map((m) => ({ name: m.name, value: m.value }));
    verdict.ok = !verdict.error && !verdict.missing && tests.length > 0 && passed === tests.length;
    return verdict;
  }
  if (res.status === "running") return { at, ok: false, passed: 0, total: 0, tests: [], error: "Bài làm chạy quá lâu (có thể bị lặp vô hạn), máy chấm đã dừng nó." };
  const err = res.outputs.find((o) => o.kind === "error");
  const why = err ? `${err.ename ?? "Error"}: ${err.evalue ?? ""}` : res.message ?? "không có kết quả";
  return { at, ok: false, passed: 0, total: 0, tests: [], error: `Máy chấm không chạy được (${why.trim()}).` };
}

/** One line per test, for the agent. */
export function verdictText(v: MentorVerdict): string {
  if (v.missing) return `The kernel lacks Python modules the tests need: ${v.missing.join(", ")}. Nothing was judged.`;
  if (v.error) return `The learner's code did not run: ${v.error}`;
  const lines = v.tests.map((t) => `- ${t.ok ? "PASS" : "FAIL"} ${t.name}${t.message ? ` — ${t.message}` : ""}`);
  const metrics = v.metrics?.length ? `\nMeasured: ${v.metrics.map((m) => `${m.name} = ${m.value}`).join(", ")}.` : "";
  return `${v.passed}/${v.total} tests passed.\n${lines.join("\n")}${metrics}`;
}
