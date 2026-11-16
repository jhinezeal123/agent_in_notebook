// The content protocol (mentor-catalog/PROTOCOL.md): topic packs that add
// stars and exercises without touching the map, hints written with an
// exercise, the static rules, and `ainb mentor check`. A pack's mistakes
// leave its own parts out and never break the catalog.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { autoLayout, freeSpot, loadCatalog, type Exercise } from "../src/mentor/catalog.js";
import { findPython, mentorCheck } from "../src/mentor/check-cli.js";
import { lintExercise } from "../src/mentor/lint.js";
import { Mentor } from "../src/mentor/index.js";
import { fold, pickToday, type MentorEvent } from "../src/mentor/model.js";
import { hintBlock, mentorPlaybook, verdictBlock } from "../src/mentor/prompt.js";

const SRC = loadCatalog().dir;
const LAYERNORM = join(SRC, "exercises", "layernorm");

const HINTS = [
  { level: 0, test: "test_eps_inside_sqrt", text: "Khi phương sai gần 0, mẫu số của bạn bằng bao nhiêu?" },
  { level: 1, text: "Tính trung bình và phương sai theo trục cuối, giữ chiều để broadcast." },
  { level: 2, when: "chưa biết thứ tự các bước", text: "mu = mean theo trục cuối (giữ chiều)\nvar = phương sai theo trục cuối (giữ chiều)\ny = (x - mu) / căn(var + eps), rồi nhân gamma, cộng beta" },
  { level: 3, when: "kẹt ở keepdims", text: "```python\nmu = x.mean(axis=-1, keepdims=True)\n```" },
];

function write(file: string, value: unknown): void {
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** A copy of the layernorm exercise under another id, with its meta changed. */
function exercise(root: string, id: string, meta: Record<string, unknown> = {}, hints: unknown = HINTS): string {
  const at = join(root, id);
  cpSync(LAYERNORM, at, { recursive: true });
  const { diagnostic: _diagnostic, ...base } = JSON.parse(readFileSync(join(LAYERNORM, "meta.json"), "utf8"));
  write(join(at, "meta.json"), { ...base, id, ...meta });
  if (hints) write(join(at, "hints.json"), hints);
  return at;
}

/** A catalog with the real map, one original exercise, and the pack "classic-ml". */
function catalogDir(opts: { daily?: boolean; messy?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ainb-packs-"));
  cpSync(join(SRC, "map.json"), join(dir, "map.json"));
  cpSync(LAYERNORM, join(dir, "exercises", "layernorm"), { recursive: true });
  const pack = join(dir, "packs", "classic-ml");
  mkdirSync(join(pack, "exercises"), { recursive: true });
  write(join(pack, "pack.json"), {
    protocol: 1, id: "classic-ml", name: "ML cổ điển", description: "Các thuật toán trước deep learning.",
    constellation: { id: "classic-ml", name: "ML cổ điển", description: "Hồi quy, phân cụm.", ...(opts.daily === false ? { daily: false } : {}) },
    stars: [
      { id: "linreg", name: "Linear regression" },
      { id: "logreg", name: "Logistic regression", after: opts.messy ? ["linreg", "softmax-x"] : ["linreg"] },
      { id: "kmeans", name: "k-means", after: ["linreg"] },
      { id: "batchnorm", name: "BatchNorm", constellation: "foundation", after: ["norm"] },
      ...(opts.messy ? [{ id: "norm", name: "LayerNorm lần nữa" }] : []),
    ],
  });
  exercise(join(pack, "exercises"), "linreg-fit", { star: "linreg", title: "Linear regression" });
  if (opts.messy) {
    exercise(join(pack, "exercises"), "bad-meta", { star: "linreg", difficulty: 50 });
    exercise(join(pack, "exercises"), "lost-star", { star: "nowhere" });
    exercise(join(pack, "exercises"), "layernorm", {});
    exercise(join(pack, "exercises"), "torchy", { star: "kmeans", requires: ["numpy", "torch"] });
    exercise(join(pack, "exercises"), "after-torchy", { star: "kmeans", uses: ["torchy"] });
    mkdirSync(join(pack, "exercises", "half-done"));
    write(join(pack, "exercises", "half-done", "brief.md"), "Đang viết.");
    for (const [name, file] of [["future", { protocol: 2, id: "future", name: "Mai sau" }], ["misnamed", { protocol: 1, id: "other", name: "Lạc tên" }]] as const) {
      mkdirSync(join(dir, "packs", name));
      write(join(dir, "packs", name, "pack.json"), file);
    }
    mkdirSync(join(dir, "packs", "broken-json"));
    write(join(dir, "packs", "broken-json", "pack.json"), "{ not json");
  }
  return dir;
}

describe("a topic pack", () => {
  const catalog = loadCatalog(catalogDir());

  it("adds a constellation of its own, laid out by what comes after what", () => {
    expect(catalog.problems).toEqual([]);
    expect(catalog.constellations.find((c) => c.id === "classic-ml")).toMatchObject({ kind: "topic", name: "ML cổ điển", daily: true });
    const at = (id: string) => catalog.stars.find((s) => s.id === id)!;
    expect(at("linreg")).toMatchObject({ constellation: "classic-ml", x: 8, y: 50 });
    expect(at("logreg").x).toBe(92);
    expect(at("kmeans").x).toBe(92);
    expect(at("logreg").y).not.toBe(at("kmeans").y);
    expect(catalog.packs).toMatchObject([{ id: "classic-ml", constellation: "classic-ml", stars: ["linreg", "logreg", "kmeans", "batchnorm"], exercises: ["linreg-fit"], unfinished: [] }]);
    expect(catalog.exercise("linreg-fit")).toMatchObject({ pack: "classic-ml", star: "linreg" });
    expect(catalog.exercise("layernorm")!.pack).toBeUndefined();
  });

  it("puts a star it adds to the star map in a free place near the stars before it", () => {
    const star = catalog.stars.find((s) => s.id === "batchnorm")!;
    const norm = catalog.stars.find((s) => s.id === "norm")!;
    expect(star.constellation).toBe("foundation");
    expect(Math.hypot(star.x - norm.x, star.y - norm.y)).toBeLessThan(30);
    for (const other of catalog.stars.filter((s) => s.id !== "batchnorm" && !["classic-ml"].includes(s.constellation))) {
      expect(Math.abs(other.x - star.x) * 9.08 >= 70 || Math.abs(other.y - star.y) * 4.8 >= 40, other.id).toBe(true);
    }
  });

  it("lays out stars with no links in a row, and finds a place on a crowded map", () => {
    const row = autoLayout(["a", "b", "c"], () => []);
    expect([...row.values()].map((p) => p.x)).toEqual([8, 50, 92]);
    expect(new Set([...row.values()].map((p) => p.y)).size).toBe(2);
    expect(autoLayout(["a"], () => []).get("a")).toEqual({ x: 50, y: 50 });
    expect(freeSpot([{ x: 50, y: 50 }], { x: 50, y: 50 })).not.toEqual({ x: 50, y: 50 });
  });

  it("leaves out what is wrong in it, says why, and breaks nothing else", () => {
    const messy = loadCatalog(catalogDir({ messy: true }));
    expect(messy.exercises.map((e) => e.id).sort()).toEqual(["layernorm", "linreg-fit"]);
    expect(messy.exercise("layernorm")!.pack).toBeUndefined();
    expect(messy.packs.map((p) => p.id)).toEqual(["classic-ml"]);
    expect(messy.packs[0]).toMatchObject({ exercises: ["linreg-fit"], unfinished: ["half-done"] });
    expect(messy.stars.filter((s) => s.id === "norm")).toHaveLength(1);
    expect(messy.stars.find((s) => s.id === "logreg")!.after).toEqual(["linreg"]);
    const said = (where: string) => messy.problems.filter((p) => p.where === where).map((p) => p.message).join(" | ");
    expect(said("future")).toMatch(/protocol 2/);
    expect(said("misnamed")).toMatch(/holds the pack other/);
    expect(said("broken-json")).toMatch(/pack\.json is not valid/);
    expect(said("classic-ml")).toMatch(/softmax-x/);
    expect(said("classic-ml")).toMatch(/A star norm already exists/);
    expect(said("classic-ml/bad-meta")).toMatch(/difficulty/);
    expect(said("classic-ml/lost-star")).toMatch(/unknown star nowhere/);
    expect(said("classic-ml/layernorm")).toMatch(/already exists/);
    expect(said("classic-ml/torchy")).toMatch(/not verified on Kaggle/);
    expect(said("classic-ml/after-torchy")).toMatch(/uses an unknown exercise torchy/);
    // For checking them, the unverified ones load too.
    expect(loadCatalog(messy.dir, { unverified: true }).exercises.map((e) => e.id)).toContain("after-torchy");
  });

  it("can keep out of the daily pick until the learner focuses on it", () => {
    let t = Date.UTC(2026, 10, 10, 12);
    const ev = (e: Record<string, unknown>) => ({ at: (t += 60_000), day: "2026-11-10", ...e }) as MentorEvent;
    const done = [
      ev({ t: "start", attemptId: "a1", exerciseId: "layernorm" }),
      ev({ t: "judge", attemptId: "a1", ok: true, passed: 6, total: 6 }),
      ev({ t: "probe", attemptId: "a1", grade: 2, question: "q" }),
      ev({ t: "probe", attemptId: "a1", grade: 2, question: "q" }),
      ev({ t: "done", attemptId: "a1" }),
    ];
    const aside = loadCatalog(catalogDir({ daily: false }));
    expect(pickToday(fold(done, aside), aside, t)).toBeNull();
    expect(pickToday(fold(done, aside), aside, t, { kind: "constellation", id: "classic-ml" })).toMatchObject({ exerciseId: "linreg-fit", reason: "focus" });
    expect(pickToday(fold(done, catalog), catalog, t)).toMatchObject({ exerciseId: "linreg-fit", reason: "next" });
    // The learner can make it the focus (as any constellation that is not a paper's).
    const mentor = new Mentor({ dir: mkdtempSync(join(tmpdir(), "ainb-packs-home-")), catalog: aside });
    mentor.setFocus({ kind: "constellation", id: "classic-ml" });
    expect(mentor.home().focus).toEqual({ kind: "constellation", id: "classic-ml", title: "ML cổ điển" });
    expect(() => mentor.setFocus({ kind: "constellation", id: "nowhere" })).toThrow(/Không có chòm sao/);
  });

  it("does not need checking again when only questions or hints change", () => {
    const dir = catalogDir();
    const at = join(dir, "packs", "classic-ml", "exercises", "linreg-fit");
    const before = loadCatalog(dir).exercise("linreg-fit")!.hash;
    const probes = JSON.parse(readFileSync(join(at, "probes.json"), "utf8"));
    write(join(at, "probes.json"), [...probes, { q: "Câu mới?", tag: "new-one", answer: "Đáp.", kind: "trap", stage: "lab" }]);
    write(join(at, "hints.json"), HINTS.slice(0, 3).concat({ level: 3, text: "```python\nvar = x.var(axis=-1, keepdims=True)\n```" } as never));
    const after = loadCatalog(dir).exercise("linreg-fit")!;
    expect(after.hash).toBe(before);
    expect(after.probeBank.at(-1)).toMatchObject({ kind: "trap", stage: "lab" });
    write(join(at, "tests.py"), `${readFileSync(join(at, "tests.py"), "utf8")}\n# changed\n`);
    expect(loadCatalog(dir).exercise("linreg-fit")!.hash).not.toBe(before);
  });
});

describe("hints written with an exercise", () => {
  const ex = loadCatalog(catalogDir()).exercise("linreg-fit")!;

  it("reach the mentor at the level asked for, and no higher", () => {
    const two = hintBlock(ex, 2);
    expect(two).toContain("chưa biết thứ tự các bước");
    expect(two).not.toContain("keepdims=True");
    expect(hintBlock(ex, 3)).toContain("keepdims=True");
    expect(hintBlock(ex, 4)).not.toContain("exercise's author");
    expect(hintBlock(loadCatalog().exercise("layernorm")!, 2)).not.toContain("exercise's author");
  });

  it("give the mentor a question to ask when the test it is for fails", () => {
    expect(mentorPlaybook(ex)).toMatch(/Leading questions[\s\S]*test test_eps_inside_sqrt fails[\s\S]*mẫu số/);
    const failing = { at: 0, ok: false, passed: 1, total: 2, tests: [{ id: "test_shape", name: "Giữ nguyên shape", ok: true }, { id: "test_eps_inside_sqrt", name: "ε nằm trong căn", ok: false, message: "Sai." }] };
    expect(verdictBlock(failing, "build", ex)).toContain("mẫu số của bạn");
    expect(verdictBlock({ ...failing, tests: [{ id: "test_shape", name: "Giữ nguyên shape", ok: false }] }, "build", ex)).not.toContain("mẫu số");
  });
});

describe("the protocol's static rules", () => {
  const ex = loadCatalog(catalogDir()).exercise("linreg-fit")!;
  const errors = (e: Exercise) => lintExercise(e).filter((i) => i.level === "error").map((i) => i.text).join(" | ");

  it("pass an exercise written to the protocol", () => {
    expect(errors(ex)).toBe("");
  });

  it("hold a pack's exercise to hints at every level, within their level", () => {
    expect(errors({ ...ex, hints: ex.hints.filter((h) => h.level !== 3) })).toMatch(/thiếu hint mức 3/);
    expect(errors({ ...ex, hints: [...ex.hints, { level: 0, test: "test_nope", text: "Vì sao?" }] })).toMatch(/test không có: test_nope/);
    expect(errors({ ...ex, hints: [...ex.hints, { level: 1, text: "Viết:\n```python\nx = 1\n```" }] })).toMatch(/mức 0 và 1 chỉ là lời/);
    expect(errors({ ...ex, hints: [...ex.hints, { level: 2, text: "return gamma * (x - mu) / np.sqrt(var + eps) + beta" }] })).toMatch(/nguyên một dòng của lời giải/);
    expect(errors({ ...ex, hints: [...ex.hints, { level: 3, text: `\`\`\`python\n${"a = 1\n".repeat(9)}\`\`\`` }] })).toMatch(/9 dòng code \(tối đa 8\)/);
  });

  it("catch too few tests, mutants and questions, a missing function, and undeclared PyTorch", () => {
    expect(errors({ ...ex, tests: "def test_one(user, ref):\n    assert True\n" })).toMatch(/1 test \(cần ≥ 4\).*chưa có docstring/);
    expect(errors({ ...ex, tests: ex.tests.replace("def test_shape(user, ref)", "def test_shape(user)") })).toMatch(/test_shape phải có chữ ký/);
    expect(errors({ ...ex, mutants: ex.mutants.slice(0, 2) })).toMatch(/giao thức cần ≥ 3/);
    expect(errors({ ...ex, probeBank: ex.probeBank.slice(0, 2) })).toMatch(/cần ≥ "probes" \+ 1/);
    expect(errors({ ...ex, functions: ["layer_norm", "rms_norm"] })).toMatch(/starter\.py chưa khai rms_norm.*reference\.py chưa định nghĩa rms_norm/);
    expect(errors({ ...ex, prelude: "import numpy as np\nimport torch" })).toMatch(/"requires" chưa có "torch"/);
  });

  it("only warn the original exercises about what the protocol added later", () => {
    const original = loadCatalog().exercise("layernorm")!;
    expect(errors(original)).toBe("");
    expect(errors({ ...original, mutants: original.mutants.slice(0, 2) })).toBe("");
  });
});

const python = findPython();
const numpy = !!python && spawnSync(python[0]!, [...python.slice(1), "-c", "import numpy"]).status === 0;

describe.skipIf(!numpy)("ainb mentor check", () => {
  it("passes a pack written to the protocol and fails one with problems", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await mentorCheck(["--catalog", catalogDir()])).toBe(0);
      const text = () => log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text()).toMatch(/✓ linreg-fit/);
      expect(text()).toMatch(/✓ lời giải chuẩn qua mọi test/);
      expect(text()).toMatch(/1 pass here, 0 need Kaggle, 0 fail/);
      log.mockClear();
      expect(await mentorCheck(["classic-ml", "--catalog", catalogDir({ messy: true })])).toBe(1);
      expect(text()).toMatch(/Unfinished[^\n]*half-done/);
      expect(text()).toMatch(/✗ classic-ml\/lost-star/);
      expect(text()).toMatch(/… torchy[\s\S]*CHƯA kiểm trên Kaggle/);
    } finally {
      log.mockRestore();
    }
  }, 240_000);
});
