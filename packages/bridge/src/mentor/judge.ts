// The judge: runs an exercise's hidden tests on the learner's solution cells,
// in the notebook's kernel (so it sees the same Python and packages), inside
// one function so nothing is left in the learner's namespace. The learner's
// cells run from their source in a fresh namespace, never from the kernel's
// variables, so a stale cell or the agent's own experiments cannot pass a test.

import { randomBytes } from "node:crypto";
import type { ExecResult, MentorVerdict } from "@ainb/protocol";
import type { Exercise } from "./catalog.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Python that judges `source` (the learner's cells joined) and prints one marked JSON line. */
export function judgeCode(ex: Pick<Exercise, "prelude" | "reference" | "tests" | "requires">, source: string, nonce: string): string {
  return String.raw`
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
    user = {"__name__": "__mentor__"}
    try:
        a, b = quiet()
        with a, b:
            exec(compile(prelude, "<prelude>", "exec"), user)
            exec(compile(text("${b64(source)}"), "<bai-lam>", "exec"), user)
    except Exception as e:
        frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == "<bai-lam>"]
        where = f" (dòng {frames[-1].lineno} của phần bài làm)" if frames else ""
        out["error"] = f"{type(e).__name__}: {str(e)[:300]}{where}"
        print("\n<<MENTOR " + json.dumps(out, ensure_ascii=False) + " MENTOR>>")
        return
    ref = {"__name__": "__mentor_ref__"}
    exec(compile(prelude, "<prelude>", "exec"), ref)
    exec(compile(text("${b64(ex.reference)}"), "<reference>", "exec"), ref)
    def need(ns, name):
        if not callable(ns.get(name)):
            raise AssertionError(f"Chưa thấy hàm \x60{name}\x60 trong cell bài làm.")
        return ns[name]
    tests = {"__name__": "__mentor_tests__", "need": need}
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
            out["tests"].append({"name": label, "ok": True})
        except AssertionError as e:
            out["tests"].append({"name": label, "ok": False, "message": (str(e) or "Kết quả chưa đúng.")[:300]})
        except Exception as e:
            out["tests"].append({"name": label, "ok": False, "message": f"{type(e).__name__}: {str(e)[:250]}"})
    print("\n<<MENTOR " + json.dumps(out, ensure_ascii=False) + " MENTOR>>")
try:
    _ainb_mentor_judge()
finally:
    del _ainb_mentor_judge
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
    let raw: { nonce?: unknown; tests?: unknown; error?: unknown; missing?: unknown };
    try {
      raw = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    if (raw.nonce !== nonce) continue;
    const tests = Array.isArray(raw.tests)
      ? raw.tests.filter((t): t is { name: string; ok: boolean; message?: string } => !!t && typeof t.name === "string" && typeof t.ok === "boolean")
        .map((t) => ({ name: t.name, ok: t.ok, ...(typeof t.message === "string" && !t.ok ? { message: t.message } : {}) }))
      : [];
    const passed = tests.filter((t) => t.ok).length;
    const verdict: MentorVerdict = { at, ok: false, passed, total: tests.length, tests };
    if (typeof raw.error === "string") verdict.error = raw.error;
    if (Array.isArray(raw.missing) && raw.missing.length) verdict.missing = raw.missing.map(String);
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
  return `${v.passed}/${v.total} tests passed.\n${lines.join("\n")}`;
}
