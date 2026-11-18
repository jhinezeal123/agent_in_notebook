// Papers without a bridge: reading arXiv's source, checking a plan, laying a
// paper's stars out, and what the log makes of papers (voided attempts, the
// half rating of exercises the mentor wrote, experiments without reviews, a
// notebook that is a workshop).

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { MentorPaperPlan } from "@ainb/protocol";
import { loadCatalog, type Exercise } from "../src/mentor/catalog.js";
import { flattenLatex, latexFromEprint, paperIdFor, parseArxivAtom, parseArxivId } from "../src/mentor/fetch.js";
import { fold, type MentorEvent } from "../src/mentor/model.js";
import { checkPlan, paperStars, type PaperPackage } from "../src/mentor/papers.js";

function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text, "utf8");
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write(body.length.toString(8).padStart(11, "0"), 124, "latin1");
    h.write("0", 156, "latin1");
    h.write("ustar", 257, "latin1");
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("arXiv", () => {
  it("reads ids from what people paste", () => {
    expect(parseArxivId("2006.11239")).toBe("2006.11239");
    expect(parseArxivId("https://arxiv.org/abs/2006.11239v2")).toBe("2006.11239v2");
    expect(parseArxivId("https://arxiv.org/pdf/1706.03762.pdf")).toBe("1706.03762");
    expect(parseArxivId("arXiv:hep-th/9901001")).toBe("hep-th/9901001");
    expect(parseArxivId("not a paper")).toBeNull();
    expect(paperIdFor("2006.11239v2")).toBe("arxiv-2006-11239");
  });

  it("flattens a source tree: inputs in place, comments out, macros kept", () => {
    const main = "\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\usepackage{x}\n\\begin{document}\nIntro % a comment\n\\input{sections/method}\n50\\% off\n\\end{document}";
    const files = new Map([["main.tex", main], ["sections/method.tex", "Method: $x \\in \\R$."]]);
    const out = flattenLatex(files)!;
    expect(out).toContain("\\newcommand{\\R}{\\mathbb{R}}");
    expect(out).not.toContain("\\usepackage");
    expect(out).toContain("Method: $x \\in \\R$.");
    expect(out).not.toContain("a comment");
    expect(out).toContain("50\\% off");
  });

  it("reads a gzip'd tar e-print, and gives up on a PDF", () => {
    const body = "x".repeat(3000);
    const eprint = gzipSync(tar({ "paper.tex": `\\documentclass{article}\\begin{document}${body}\\end{document}`, "fig.png": "PNG" }));
    expect(latexFromEprint(eprint)).toContain(body);
    expect(latexFromEprint(Buffer.from("%PDF-1.5 ..."))).toBeNull();
  });

  it("reads title, authors and year from the API", () => {
    const xml = "<feed><entry><published>2020-06-19T00:00:00Z</published><title>Denoising  Diffusion\n Probabilistic Models</title><author><name>Jonathan Ho</name></author><author><name>Ajay Jain</name></author></entry></feed>";
    expect(parseArxivAtom(xml)).toEqual({ title: "Denoising Diffusion Probabilistic Models", authors: "Jonathan Ho, Ajay Jain", year: 2020 });
  });
});

const PLAN: MentorPaperPlan = {
  title: "P", goal: "g", requires: ["broadcasting"],
  components: [
    { slug: "a", title: "A", role: "formula", mode: "build", cites: "Eq. 1", why: "w", functions: ["a(x)"], uses: [], minutes: 15, difficulty: 2400, skills: ["formula"] },
    { slug: "b", title: "B", role: "component", mode: "build", cites: "Eq. 2", why: "w", functions: ["b(x)"], uses: ["a"], minutes: 15, difficulty: 900, skills: ["tensor"] },
    { slug: "e", title: "E", role: "experiment", mode: "build", cites: "Table 1", why: "w", functions: [], uses: ["b"], minutes: 30, difficulty: 1500, skills: ["train"] },
  ],
  experiment: { dataset: "toy", device: "cpu", trainMinutes: 5, metrics: [{ name: "acc", paper: "0.9", where: "Table 1", target: { op: ">=", value: 0.8 } }] },
};

describe("a reproduction plan", () => {
  const stars = new Set(["broadcasting"]);

  it("is fine, with difficulties kept within reach of the rating", () => {
    const { problems, plan } = checkPlan(PLAN, { stars, rating: 1200 });
    expect(problems).toEqual([]);
    expect(plan.components.map((c) => c.difficulty)).toEqual([1700, 900, 1500]);
  });

  it("says what breaks the rules", () => {
    const bad: MentorPaperPlan = {
      ...PLAN,
      requires: ["nope"],
      components: [{ ...PLAN.components[1]!, uses: ["zz"] }, { ...PLAN.components[2]!, mode: "given" }],
      experiment: { ...PLAN.experiment, trainMinutes: 40 },
    };
    const text = checkPlan(bad, { stars, rating: 1200 }).problems.join("\n");
    expect(text).toMatch(/uses "zz"/);
    expect(text).toMatch(/last component must be the experiment, built/);
    expect(text).toMatch(/at most 15 minutes/);
    expect(text).toMatch(/Unknown star ids in requires: nope/);
    expect(text).toMatch(/At least two components/);
  });
});

describe("a paper's stars", () => {
  it("go left to right in the order the exercises build on each other", () => {
    const ex = (id: string, uses: string[] = []) => ({ id, title: id, uses } as unknown as Exercise);
    const pkg = { info: { id: "p" }, exercises: [ex("p--a"), ex("p--b", ["p--a"]), ex("p--c", ["p--a"]), ex("p--e", ["p--b", "p--c"])] } as unknown as PaperPackage;
    const stars = paperStars(pkg);
    const x = Object.fromEntries(stars.map((s) => [s.id, s.x]));
    expect(x["p--a"]).toBeLessThan(x["p--b"]!);
    expect(x["p--b"]).toBe(x["p--c"]);
    expect(x["p--e"]).toBe(92);
    expect(stars.find((s) => s.id === "p--e")).toMatchObject({ constellation: "paper:p", after: ["p--b", "p--c"] });
  });
});

describe("papers in the log", () => {
  const base = loadCatalog();
  const own: Exercise = { ...base.exercise("layernorm")!, id: "p--x", paper: "p", author: "ai" };
  const exp: Exercise = { ...base.exercise("layernorm")!, id: "p--e", paper: "p", role: "experiment", author: "curated" };
  const catalog = { exercise: (id: string) => (id === own.id ? own : id === exp.id ? exp : base.exercise(id)) };
  let t = Date.UTC(2026, 10, 10, 12);
  const ev = (e: Record<string, unknown>) => ({ at: (t += 60_000), day: "2026-11-10", ...e }) as MentorEvent;
  const passed = (attemptId: string, exerciseId: string) => [
    ev({ t: "start", attemptId, exerciseId }),
    ev({ t: "judge", attemptId, ok: true, passed: 4, total: 4, metrics: [{ name: "acc", value: 0.93 }] }),
    ev({ t: "probe", attemptId, grade: 2, question: "q" }),
    ev({ t: "done", attemptId }),
  ];

  it("moves the rating half as much for an exercise the mentor wrote", () => {
    const curated = fold(passed("a1", "layernorm"), catalog).attempts.get("a1")!.result!;
    const ai = fold([...passed("a1", "p--x")], catalog).attempts.get("a1")!.result!;
    const gain = (r: typeof ai) => r.deltas.reduce((s, d) => s + d.after - d.before, 0);
    expect(Math.abs(gain(ai) - gain(curated) / 2)).toBeLessThanOrEqual(1);
  });

  it("does not count an attempt reported as wrong, even after it is done", () => {
    const state = fold([...passed("a1", "layernorm"), ev({ t: "void", attemptId: "a1", reason: "test sai" })], catalog);
    expect(state.attempts.get("a1")).toMatchObject({ voided: "test sai", result: { deltas: [] } });
    expect(state.ratings.size).toBe(0);
    expect(state.reviews.size).toBe(0);
  });

  it("keeps an experiment's numbers and schedules no review for it", () => {
    const state = fold(passed("a1", "p--e"), catalog);
    expect(state.attempts.get("a1")!.metrics).toEqual([{ name: "acc", value: 0.93 }]);
    expect(state.reviews.has("p--e")).toBe(false);
  });

  it("knows which notebook is a workshop, until an exercise takes it", () => {
    let state = fold([ev({ t: "workshop", attemptId: "paper:p", paperId: "p", notebook: "k1" }), ev({ t: "paper", attemptId: "paper:p", paperId: "p", what: "planned" })], catalog);
    expect(state.workshops.get("k1")).toBe("p");
    expect(state.days.get("2026-11-10")).toBe(1);
    state = fold([ev({ t: "workshop", attemptId: "paper:p", paperId: "p", notebook: "k1" }), ev({ t: "start", attemptId: "a1", exerciseId: "layernorm" }), ev({ t: "load", attemptId: "a1", notebook: "k1" })], catalog);
    expect(state.workshops.size).toBe(0);
    expect(state.places.get("k1")).toBe("a1");
  });
});

describe("PyTorch exercises not verified on Kaggle", () => {
  it("invalidates a Kaggle record when shared paper code or a transitive reference changes", async () => {
    const { mkdtempSync, cpSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const src = loadCatalog().dir;
    const dir = mkdtempSync(join(tmpdir(), "ainb-hashes-"));
    const paper = join(dir, "papers", "resnet");
    cpSync(join(src, "map.json"), join(dir, "map.json"));
    cpSync(join(src, "papers", "resnet"), paper, { recursive: true });
    const packPath = join("packs", "branch-vision");
    cpSync(join(src, packPath, "pack.json"), join(dir, packPath, "pack.json"));
    const base = join(packPath, "exercises", "residual-block");
    cpSync(join(src, base), join(dir, base), { recursive: true });
    const id = "resnet--experiment";
    const recordAll = () => {
      const all = loadCatalog(dir, { unverified: true });
      writeFileSync(join(dir, "verified.json"), JSON.stringify(Object.fromEntries(all.exercises.map((e) => [e.id, { hash: e.hash }]))));
      return all.exercise(id)!.hash;
    };
    const first = recordAll();
    expect(loadCatalog(dir).exercise(id)?.hash).toBe(first);
    appendFileSync(join(paper, "given.py"), "\nSHARED = 1\n");
    expect(loadCatalog(dir).exercise(id)).toBeUndefined();
    const second = recordAll();
    expect(second).not.toBe(first);
    appendFileSync(join(dir, base, "reference.py"), "\nNEW_BASE = 1\n");
    expect(loadCatalog(dir, { unverified: true }).exercise(id)?.hash).not.toBe(second);
    expect(loadCatalog(dir).exercise(id)).toBeUndefined();
  });

  it("never reach the learner, nor do the exercises built on them", async () => {
    const { mkdtempSync, cpSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const src = loadCatalog().dir;
    const dir = mkdtempSync(join(tmpdir(), "ainb-catalog-"));
    cpSync(join(src, "map.json"), join(dir, "map.json"));
    const torchy = join(dir, "exercises", "torchy");
    cpSync(join(src, "exercises", "layernorm"), torchy, { recursive: true });
    const meta = JSON.parse(readFileSync(join(torchy, "meta.json"), "utf8"));
    writeFileSync(join(torchy, "meta.json"), JSON.stringify({ ...meta, id: "torchy", requires: ["numpy", "torch"] }));
    const after = join(dir, "exercises", "after-torchy");
    cpSync(join(src, "exercises", "layernorm"), after, { recursive: true });
    writeFileSync(join(after, "meta.json"), JSON.stringify({ ...meta, id: "after-torchy", uses: ["torchy"] }));

    expect(loadCatalog(dir).exercises.map((e) => e.id)).toEqual([]);
    const all = loadCatalog(dir, { unverified: true });
    expect(all.exercises.map((e) => e.id).sort()).toEqual(["after-torchy", "torchy"]);
    writeFileSync(join(dir, "verified.json"), JSON.stringify({ torchy: { hash: all.exercise("torchy")!.hash } }));
    expect(loadCatalog(dir).exercises.map((e) => e.id).sort()).toEqual(["after-torchy", "torchy"]);
    writeFileSync(join(torchy, "tests.py"), "def test_changed(user, ref):\n    pass\n");
    expect(loadCatalog(dir).exercises.map((e) => e.id)).toEqual([]);
  });
});
