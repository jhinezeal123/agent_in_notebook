// The judge's new parts (code of earlier exercises, the `t` helpers, judging
// what the kernel holds, measured numbers) and the exercise check, on this
// machine's Python with numpy standing in for a Kaggle kernel.

import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ExecResult } from "@ainb/protocol";
import { usesOrder, type Exercise } from "../src/mentor/catalog.js";
import { judgeCode, newNonce, parseVerdict } from "../src/mentor/judge.js";
import { KernelPool } from "../src/mentor/pool.js";
import { leakedLines, trainsOnGpu, verifyExercise, type Exec } from "../src/mentor/verify.js";

function findPython(): string[] | null {
  for (const c of process.platform === "win32" ? [["python"], ["py", "-3"]] : [["python3"], ["python"]]) {
    if (spawnSync(c[0]!, [...c.slice(1), "-c", "import numpy"], { encoding: "utf8" }).status === 0) return c;
  }
  return null;
}
const python = findPython();

/** One kernel call: a fresh Python, so `globals()` is its __main__. */
function run(code: string, prefix = ""): Pick<ExecResult, "status" | "outputs" | "message"> {
  const r = spawnSync(python![0]!, [...python!.slice(1), "-X", "utf8", "-"], { input: `${prefix}\n${code}`, encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" } });
  return { status: r.status === 0 ? "ok" : "error", outputs: [{ kind: "stream", name: "stdout", text: r.stdout ?? "" }], message: r.stderr };
}

function exercise(over: Partial<Exercise>): Exercise {
  return {
    id: "scale", title: "Scale", star: "broadcasting", skills: ["tensor"], difficulty: 1000, minutes: 10, requires: ["numpy"], order: 0,
    functions: ["scale"], prelude: "import numpy as np", probes: 1, role: "component", uses: [], judge: "source", judgeSeconds: 60,
    author: "curated", metrics: [], hints: [], brief: "Nhân x với 2.", given: "", hash: "h", lab: [{ type: "code", source: "x = np.arange(3)\nprint(x * 2)" }],
    starter: "def scale(x):\n    raise NotImplementedError", reference: "def scale(x):\n    return x * 2.0\n",
    tests: [
      "def test_values(user, ref):\n    t.seed(0)\n    x = np.random.randn(5)\n    t.close(need(user, 'scale')(x), ref['scale'](x))",
      "def test_shape(user, ref):\n    t.shape(need(user, 'scale')(np.zeros((2, 3))), (2, 3))",
      "def test_int(user, ref):\n    t.close(need(user, 'scale')(np.arange(4)), np.arange(4) * 2)",
      "def test_zero(user, ref):\n    t.close(need(user, 'scale')(np.zeros(1)), np.zeros(1))",
    ].join("\n\n"),
    probeBank: [{ q: "Vì sao?", tag: "t", answer: "a" }],
    mutants: [{ name: "times3", source: "def scale(x):\n    return x * 3.0\n" }, { name: "plus", source: "def scale(x):\n    return x + 2.0\n" }],
    ...over,
  };
}

describe.skipIf(!python)("the judge", () => {
  it("runs earlier exercises' code before the learner's, and says when it breaks", () => {
    const ex = exercise({ reference: "def scale(x):\n    return double(x)\n" });
    const ctx = { before: "def double(x):\n    return x * 2.0", beforeRef: "def double(x):\n    return x * 2.0" };
    let nonce = newNonce();
    expect(parseVerdict(run(judgeCode(ex, "def scale(x):\n    return double(x)", nonce, ctx)), nonce).ok).toBe(true);
    nonce = newNonce();
    const broken = parseVerdict(run(judgeCode(ex, "def scale(x):\n    return x * 2.0", nonce, { ...ctx, before: "def double(x) return" })), nonce);
    expect(broken.error).toMatch(/từ các bài trước/);
  });

  it("judges what the kernel holds, and reports measured numbers", () => {
    const ex = exercise({
      role: "experiment", judge: "kernel", reference: "",
      tests: "def test_trained(user, ref):\n    w = user.get('w')\n    assert w is not None, 'Chưa train.'\n    t.report('loss', abs(w - 3.0))\n    assert abs(w - 3.0) < 0.1, 'Loss còn cao.'",
    });
    let nonce = newNonce();
    const good = parseVerdict(run(judgeCode(ex, "train()", nonce, { mode: "kernel" }), "w = 2.98"), nonce);
    expect(good.ok).toBe(true);
    expect(good.metrics?.[0]?.name).toBe("loss");
    expect(good.metrics?.[0]?.value).toBeCloseTo(0.02);
    nonce = newNonce();
    const untrained = parseVerdict(run(judgeCode(ex, "train()", nonce, { mode: "kernel" }), "w = 0.0"), nonce);
    expect(untrained.ok).toBe(false);
    expect(untrained.tests[0]?.message).toBe("Loss còn cao.");
  });

  it("explains a wrong value or shape in Vietnamese", () => {
    const nonce = newNonce();
    const v = parseVerdict(run(judgeCode(exercise({}), "def scale(x):\n    return (x * 2.0).reshape(-1)", nonce)), nonce);
    expect(v.tests.find((t) => t.name === "shape")?.message).toMatch(/Shape của kết quả là \(6,\), cần \(2, 3\)/);
  });
});

describe.skipIf(!python)("checking an exercise", () => {
  const exec = async (code: string) => run(code);

  it("passes a consistent exercise", async () => {
    const r = await verifyExercise(exercise({}), exec);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.python).toMatch(/^3\./);
  });

  it("catches a broken solution that slips through, one that does not run, and a lab that fails", async () => {
    const r = await verifyExercise(exercise({
      mutants: [{ name: "same", source: "def scale(x):\n    return 2.0 * x\n" }, { name: "syntax", source: "def scale(x) return" }],
      lab: [{ type: "code", source: "undefined_name + 1" }],
    }), exec);
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.id, c.note]));
    expect(failed.mutants).toMatch(/same lọt qua test/);
    expect(failed.mutants).toMatch(/syntax không chạy được/);
    expect(failed.lab).toMatch(/NameError/);
    expect(r.ok).toBe(false);
  });

  it("catches a flaky test, a starter that passes, and too few tests", async () => {
    const r = await verifyExercise(exercise({
      starter: "def scale(x):\n    return x * 2.0",
      tests: "import random\ndef test_flaky(user, ref):\n    assert random.random() < 2 and need(user, 'scale')(np.ones(1))[0] == 2.0",
    }), exec);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toContain("starter");
    expect(failed).toContain("files");
  });

  it("refuses to certify a starter whose worker died before judging", async () => {
    const ex = exercise({});
    let step = "";
    const result = await verifyExercise({ ...ex, starter: ex.reference }, async (code) =>
      step === "chấm starter" ? { status: "error", outputs: [], message: "worker exited" } : exec(code),
    { onStep: (message) => { step = message; } });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "starter")).toMatchObject({ ok: false, note: expect.stringContaining("worker exited") });
  });

  it("stops at a missing module", async () => {
    const r = await verifyExercise(exercise({ requires: ["numpy", "no_such_module_xyz"] }), exec);
    expect(r.checks.find((c) => c.id === "modules")).toMatchObject({ ok: false, note: "thiếu no_such_module_xyz" });
    expect(r.checks.some((c) => c.id === "reference")).toBe(false);
  });
});

describe("exercise order and leaks", () => {
  it("orders the exercises one builds on, and refuses a circle", () => {
    const uses: Record<string, string[]> = { loss: ["schedule", "sample"], sample: ["schedule"], schedule: [] };
    expect(usesOrder(["loss"], (id) => uses[id] ?? [])).toEqual(["schedule", "sample", "loss"]);
    expect(() => usesOrder(["a"], (id) => (id === "a" ? ["b"] : ["a"]))).toThrow(/circle/);
  });

  it("finds reference lines in the notebook", () => {
    const line = "return np.sqrt(np.mean(x ** 2, axis=-1, keepdims=True))";
    expect(leakedLines(exercise({ reference: `def f(x):\n    ${line}\n`, brief: `Gợi ý: ${line}` }))).toEqual([line]);
  });
});

/** A kernel that keeps its globals between calls, like a notebook's: one Python process, one call at a time. */
function persistentKernel(): { exec: Exec; close: () => void } {
  const loop = [
    "import sys, base64",
    "G = {'__name__': '__main__'}",
    "for line in sys.stdin:",
    "    try:",
    "        exec(compile(base64.b64decode(line).decode('utf-8'), '<cell>', 'exec'), G)",
    "    except BaseException as e:",
    "        print('ERR', repr(e))",
    "    print('<<DONE>>', flush=True)",
  ].join("\n");
  const child = spawn(python![0]!, [...python!.slice(1), "-X", "utf8", "-u", "-c", loop], { env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" } });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let waiting: ((text: string) => void) | null = null;
  child.stdout.on("data", (d: string) => {
    buffer += d;
    const at = buffer.indexOf("<<DONE>>");
    if (at >= 0 && waiting) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + "<<DONE>>".length);
      const w = waiting;
      waiting = null;
      w(text);
    }
  });
  let chain: Promise<unknown> = Promise.resolve();
  const exec: Exec = (code) => {
    const call = chain.then(() => new Promise<string>((resolve) => {
      waiting = resolve;
      child.stdin.write(`${Buffer.from(code, "utf8").toString("base64")}\n`);
    })).then((text) => ({ status: "ok" as const, outputs: [{ kind: "stream" as const, name: "stdout" as const, text }] }));
    chain = call;
    return call;
  };
  return { exec, close: () => child.kill() };
}

describe.skipIf(!python)("checking many exercises through a pool", () => {
  it("keeps ownership across a competing start and reports errors preparing a job", async () => {
    const kernel = persistentKernel();
    const first = new KernelPool(kernel.exec, 10);
    const other = new KernelPool(kernel.exec, 10);
    try {
      await kernel.exec("import tempfile, os\n_scratch = tempfile.TemporaryDirectory()\ntempfile.tempdir = _scratch.name\nos.mkdir(os.path.join(tempfile.tempdir, 'ainb-verify'))\nopen(os.path.join(tempfile.tempdir, 'ainb-verify', 'blocked'), 'w').close()", 1000);
      await first.start();
      await expect(other.start()).rejects.toThrow();
      await other.close();
      expect(await first.exec("blocked")("print(1)", 2000)).toMatchObject({ status: "error", message: expect.stringContaining("FileExistsError") });
      expect(await first.exec("valid")("print(2)", 2000)).toMatchObject({ status: "ok", outputs: [{ text: "2\n" }] });
    } finally {
      await first.close();
      await kernel.exec("_scratch.cleanup()", 1000);
      kernel.close();
    }
  });

  it("checks them side by side, each check in its own process, and says which gave no result", async () => {
    const kernel = persistentKernel();
    const pool = new KernelPool(kernel.exec, 100);
    try {
      const info = await pool.start();
      expect(info.slots).toBeGreaterThanOrEqual(1);
      const experiment = exercise({
        id: "exp", role: "experiment", judge: "kernel", reference: "w = 2.98\n", starter: "w = None\n", lab: [],
        metrics: [{ name: "loss", target: { op: "<=", value: 0.1 } }],
        tests: "def test_trained(user, ref):\n    t.report('loss', abs(user['w'] - 3.0))",
        mutants: [
          { name: "untrained", source: "w = 0.0\n" },
          { name: "close-enough", source: "w = 2.95\n" },
          { name: "dies", source: "raise SystemExit(3)\n" },
        ],
      });
      const [plain, exp] = await Promise.all([
        verifyExercise(exercise({}), pool.exec("scale"), { concurrent: true }),
        verifyExercise(experiment, pool.exec("exp"), { concurrent: true }),
      ]);
      expect(plain.checks.filter((c) => !c.ok)).toEqual([]);
      expect(plain.checks.map((c) => c.id)).toEqual(["files", "leak", "modules", "reference", "speed", "starter", "mutants", "lab"]);
      const mutants = exp.checks.find((c) => c.id === "mutants");
      expect(exp.checks.find((c) => c.id === "reference")?.ok).toBe(true);
      expect(mutants?.note).toMatch(/close-enough lọt qua test/);
      expect(mutants?.note).toMatch(/dies không có kết quả \(exit 3/);
      expect(mutants?.note).not.toMatch(/untrained/);
    } finally {
      await pool.close();
      kernel.close();
    }
  }, 120_000);
});

describe("which checks wait for a GPU", () => {
  it("is an experiment whose reference or given code asks for cuda", () => {
    const exp = exercise({ role: "experiment", reference: "device = 'cuda' if torch.cuda.is_available() else 'cpu'" });
    expect(trainsOnGpu(exp)).toBe(true);
    expect(trainsOnGpu(exercise({ role: "experiment", reference: "train()" }), { beforeRef: "x.to('cuda')" })).toBe(true);
    expect(trainsOnGpu(exercise({ role: "experiment", reference: "train()" }))).toBe(false);
    expect(trainsOnGpu(exercise({ reference: "x.cuda()" }))).toBe(false);
  });
});
