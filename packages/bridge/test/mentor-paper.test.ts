// A paper the learner brings, end to end through the real bridge: its
// workshop in a notebook open in Chrome, the plan the mentor proposes (a bad
// one refused), the learner's approval, the exercises written by a hidden
// chat and checked on the notebook's machine (this computer's Python stands
// in for Kaggle's), then the learner doing them in another notebook: the
// paper's given code and their own earlier solution carried into the next
// exercise, the paper as the focus of "today", and a report that voids an
// attempt. Nothing the author writes reaches the editor.
// Then what goes wrong: an exercise the learner reports is written again with
// what they said (and what was built on it is checked again); a component the
// author cannot write holds back the ones built on it, and is tried again on
// request; a machine that is off stops the writing without blaming anything;
// a plan changed after approval waits for approval again.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSnapshot, ExecResult, MentorHome, MentorPlace, MentorWorkshop, NotebookInfo } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { cellRole } from "../src/mentor/notebook.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";

const TOKEN = "test-token-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
const NO_ORX = { knownPorts: [], locate: () => ({ missing: "OpenResearch is not used in these tests." }) };
const SETTINGS = { scope: "write", review: true, targetCellIds: [], notebookOnly: false };
const TAB_W = 21;
const TAB_L = 22;
const TAB_W2 = 23;
const KEY_W2 = "kaggle:/code/me/workshop-two";
const PAPER2 = "p-chain";
const KEY_W = "kaggle:/code/me/workshop";
const KEY_L = "kaggle:/code/me/learn";
const PAPER = "p-double";
const SECRET = "SECRET_REFERENCE_LINE_doubling_by_addition";

function findPython(): string[] | null {
  for (const c of process.platform === "win32" ? [["python"], ["py", "-3"]] : [["python3"], ["python"]]) {
    if (spawnSync(c[0]!, [...c.slice(1), "-c", "import numpy"], { encoding: "utf8" }).status === 0) return c;
  }
  return null;
}
const python = findPython();

/** This computer's Python as the workshop's kernel (each call fresh). */
function pythonKernel(code: string): ExecResult {
  const r = spawnSync(python![0]!, [...python!.slice(1), "-X", "utf8", "-"], { input: code, encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" } });
  return { status: r.status === 0 ? "ok" : "error", outputs: [{ kind: "stream", name: "stdout", text: r.stdout ?? "" }, ...(r.status === 0 ? [] : [{ kind: "error" as const, ename: "Error", evalue: (r.stderr ?? "").slice(-300) }])] };
}

function kaggle(nb: FakeNotebook, slug: string, title: string): FakeNotebook {
  nb.platform = "kaggle";
  const base = nb.info.bind(nb);
  nb.info = (): NotebookInfo => ({ ...base(), title, url: `https://www.kaggle.com/code/me/${slug}/edit`, key: `kaggle:/code/me/${slug}` });
  return nb;
}

const PLAN = {
  title: "Doubling, the paper",
  authors: "A. Author",
  year: 2024,
  goal: "Hiểu phép nhân đôi và train một tham số.",
  requires: ["broadcasting"],
  components: [
    { slug: "data", title: "Dữ liệu", role: "component", mode: "given", cites: "§2", why: "Không phải ý tưởng của paper.", functions: [], uses: [], minutes: 10, difficulty: 1000, skills: ["tensor"] },
    { slug: "double", title: "Nhân đôi", role: "formula", mode: "build", cites: "Eq. 1", why: "Ý chính.", functions: ["double(x: ndarray) -> ndarray"], uses: [], minutes: 15, difficulty: 1100, skills: ["formula"] },
    { slug: "fit", title: "Thí nghiệm", role: "experiment", mode: "build", cites: "Table 1", why: "Kết quả chính.", functions: [], uses: ["double"], minutes: 20, difficulty: 1200, skills: ["train"] },
  ],
  experiment: { dataset: "data generated in given.py", device: "cpu", trainMinutes: 1, metrics: [{ name: "err", paper: "0.0", where: "Table 1", target: { op: "<=", value: 0.01 } }] },
};

const write = (component: string, file: string, content: string) => ({ tool: "paper_exercise_write", args: { component, file, content } });
const AUTHOR = {
  given: [{ tool: "paper_given_write", args: { code: "def target():\n    return 6.0" } }],
  double: [
    // The title and the difficulty are the plan's: what the author says of them is dropped.
    write("double", "meta.json", JSON.stringify({ functions: ["double"], requires: ["numpy"], probes: 2, title: "Hacked", difficulty: 2400, diagnostic: 1 })),
    write("double", "brief.md", "Viết `double(x)` trả về 2x (Eq. 1)."),
    write("double", "starter.py", "def double(x):\n    raise NotImplementedError"),
    write("double", "reference.py", `def double(x):\n    return x + x  # ${SECRET}\n`),
    write("double", "tests.py", [1, 2, 3, 4].map((i) => `def test_case_${i}(user, ref):\n    """trường hợp ${i}"""\n    t.seed(${i})\n    x = np.random.randn(${i}, 3)\n    t.close(need(user, "double")(x), ref["double"](x))`).join("\n\n")),
    write("double", "probes.json", JSON.stringify([1, 2, 3].map((i) => ({ q: `Câu ${i}?`, tag: `tag-${i}`, answer: "đúng" })))),
    write("double", "mutants/triple.py", "def double(x):\n    return 3 * x\n"),
    write("double", "mutants/same.py", "def double(x):\n    return x\n"),
    write("double", "mutants/plus.py", "def double(x):\n    return x + 2\n"),
    { tool: "paper_exercise_check", args: { component: "double" } },
  ],
  fit: [
    write("fit", "meta.json", JSON.stringify({ functions: ["double"], requires: ["numpy"], predict: "w hội tụ về đâu, vì sao?", judgeSeconds: 60 })),
    write("fit", "brief.md", "Train w sao cho double(w) = target()."),
    write("fit", "starter.py", "# vòng lặp train của bạn"),
    write("fit", "reference.py", "w = 0.0\nfor _ in range(200):\n    w -= 0.1 * (double(w) - target())\nmodel = {'w': w}\n"),
    write("fit", "tests.py", 'def test_fit(user, ref):\n    """mô hình khớp"""\n    m = user.get("model")\n    assert m is not None, "Chưa có model."\n    err = abs(m["w"] - 3.0)\n    t.report("err", err)\n    assert err < 0.01, "Chưa khớp."'),
    write("fit", "probes.json", JSON.stringify([1, 2, 3].map((i) => ({ q: `Câu ${i}?`, tag: `fit-${i}`, answer: "đúng" })))),
    write("fit", "mutants/untrained.py", "model = {'w': 0.0}\n"),
    // The paper's given code is fixed once an exercise is verified against it.
    { tool: "paper_given_write", args: { code: "def target():\n    return 7.0" } },
    { tool: "paper_exercise_check", args: { component: "fit" } },
  ],
};

/** A second paper: three components in a chain. */
const PLAN2 = {
  title: "Chain, the paper",
  goal: "Một chuỗi ba thành phần.",
  requires: [],
  components: [
    { slug: "base", title: "Base", role: "formula", mode: "build", cites: "Eq. 1", why: "Nền.", functions: ["base_fn(x: float) -> float"], uses: [], minutes: 10, difficulty: 1000, skills: ["formula"] },
    { slug: "top", title: "Top", role: "component", mode: "build", cites: "Eq. 2", why: "Dựng trên Base.", functions: ["top_fn(x: float) -> float"], uses: ["base"], minutes: 10, difficulty: 1000, skills: ["formula"] },
    { slug: "exp2", title: "Thí nghiệm 2", role: "experiment", mode: "build", cites: "Table 1", why: "Kết quả.", functions: [], uses: ["top"], minutes: 10, difficulty: 1000, skills: ["train"] },
  ],
  experiment: { dataset: "data generated in given.py", device: "cpu", trainMinutes: 1, metrics: [{ name: "val", paper: "4", where: "Table 1", target: { op: ">=", value: 3.9 } }] },
};

function simple(slug: string, fn: string, body: string, mutants: string[]) {
  return [
    write(slug, "meta.json", JSON.stringify({ functions: [fn], requires: ["numpy"] })),
    write(slug, "brief.md", `Viết \`${fn}(x)\`.`),
    write(slug, "starter.py", `def ${fn}(x):\n    raise NotImplementedError`),
    write(slug, "reference.py", `def ${fn}(x):\n    return ${body}\n`),
    write(slug, "tests.py", [1, 2, 3, 4].map((i) => `def test_case_${i}(user, ref):\n    """trường hợp ${i}"""\n    t.close(need(user, "${fn}")(${i}.0), ref["${fn}"](${i}.0))`).join("\n\n")),
    write(slug, "probes.json", JSON.stringify([1, 2, 3].map((i) => ({ q: `Câu ${i}?`, tag: `${slug}-${i}`, answer: "đúng" })))),
    ...mutants.map((m, i) => write(slug, `mutants/m${i}.py`, `def ${fn}(x):\n    return ${m}\n`)),
    { tool: "paper_exercise_check", args: { component: slug } },
  ];
}
const CHAIN = {
  base: simple("base", "base_fn", "x + 1", ["x", "x + 2", "x - 1"]),
  top: simple("top", "top_fn", "base_fn(x) * 2", ["base_fn(x)", "base_fn(x) * 3", "x * 2"]),
  exp2: [
    write("exp2", "meta.json", JSON.stringify({ functions: ["top_fn"], requires: ["numpy"], predict: "val bằng bao nhiêu?" })),
    write("exp2", "brief.md", "Tính model."),
    write("exp2", "starter.py", "# của bạn"),
    write("exp2", "reference.py", "model = {'v': top_fn(1.0)}\n"),
    write("exp2", "tests.py", 'def test_measure(user, ref):\n    """đo val"""\n    m = user.get("model")\n    assert m is not None, "Chưa có model."\n    t.report("val", m["v"])'),
    write("exp2", "probes.json", JSON.stringify([1, 2, 3].map((i) => ({ q: `Câu ${i}?`, tag: `exp2-${i}`, answer: "đúng" })))),
    write("exp2", "mutants/untrained.py", "model = {'v': 0.0}\n"),
    { tool: "paper_exercise_check", args: { component: "exp2" } },
  ],
};
/** Base as the author cannot get it right: its reference does not even run. */
const BROKEN_BASE = [write("base", "reference.py", "def base_fn(x):\n    return x +\n"), ...CHAIN.base.filter((step) => !("args" in step && (step.args as { file?: string }).file === "reference.py"))];

let bridge: Bridge;
let browser: FakeExtension;
let editor: FakeExtension;
const nbW = kaggle(new FakeNotebook([]), "workshop", "Workshop");
const nbL = kaggle(new FakeNotebook([]), "learn", "Learn");
const nbW2 = kaggle(new FakeNotebook([]), "workshop-two", "Workshop two");
const scripts = (author: Record<string, unknown>) => writeFileSync(process.env.FAKE_AUTHOR!, JSON.stringify(author));

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "ainb-mentor-paper-"));
  process.env.AINB_HOME = home;
  process.env.FAKE_AUTHOR = join(home, "author.json");
  writeFileSync(process.env.FAKE_AUTHOR, JSON.stringify(AUTHOR));
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 3 }]));
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: NO_ORX, log: () => {} });
  const port = await bridge.listen();
  editor = new FakeExtension(new FakeNotebook([]), 400);
  await editor.connect(port, TOKEN);
  nbW.execResult = pythonKernel;
  browser = new FakeExtension(nbW, TAB_W);
  await browser.connect(port, TOKEN, "chrome-extension://abcdef");
  browser.attachNotebook(TAB_L, nbL);
  nbW2.execResult = pythonKernel;
  browser.attachNotebook(TAB_W2, nbW2);
  browser.rpc.emit("notebook.attached", { tabId: TAB_W, info: nbW.info() });
  browser.rpc.emit("notebook.attached", { tabId: TAB_L, info: nbL.info() });
  browser.rpc.emit("notebook.attached", { tabId: TAB_W2, info: nbW2.info() });
  for (let i = 0; i < 100 && (await editor.request<{ notebooks: unknown[] }>("browser.notebooks", {})).notebooks.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
  delete process.env.FAKE_AUTHOR;
  editor?.close();
  browser?.close();
  await bridge?.close();
});

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

async function turn(chatId: string, text: string) {
  const before = editor.statuses.length;
  await editor.request("chat.send", { chatId, text });
  await editor.waitFor(() => editor.statuses.slice(before).includes("idle") || editor.statuses.slice(before).includes("error"), 60_000, "turn end");
  return editor.agentText();
}

async function openOn(tabId: number, key: string) {
  const idle = editor.statuses.filter((s) => s === "idle").length;
  const snap = await editor.request<ChatSnapshot>("chat.open", { tabId: -tabId, browserTab: tabId, agentId: "fake", platform: "kaggle", notebookKey: key, settings: SETTINGS });
  await editor.waitFor(() => editor.statuses.filter((s) => s === "idle").length > idle, 30_000, "agent start");
  return snap;
}

const home = () => editor.request<MentorHome>("mentor.home", {});
const paper = async (id: string) => (await home()).papers.find((x) => x.id === id)!;
/** The author is done with a paper (it was seen at work, or what it had to do is there). */
const authored = (id: string, until: () => boolean, what: string) => editor.waitFor(() => until() && !bridge.workshops.running(id), 180_000, what);

describe.skipIf(!python)("a paper brought by the learner", () => {
  let workshopChat = "";

  it("becomes a workshop in a notebook, with its chat", async () => {
    bridge.mentor.shelf.create({ id: PAPER, title: "Doubling", source: "# Doubling\n\nEq. 1: y = 2x.", kind: "latex" });
    bridge.mentor.reloadCatalog();
    await editor.request("mentor.paper.open", { paperId: PAPER, tabId: TAB_W });
    expect(nbW.cells[0]?.source).toMatch(/^<!-- mentor: paper p-double -->/);
    const p = (await editor.request<MentorPlace[]>("mentor.places", {})).find((x) => x.tabId === TAB_W);
    expect(p).toMatchObject({ workshop: { paperId: PAPER }, foreignCells: 0 });
    const snap = await openOn(TAB_W, KEY_W);
    workshopChat = snap.chatId;
    expect(snap.workshop).toMatchObject({ paperId: PAPER, status: "reading", approved: false });
    expect((await home()).papers.find((x) => x.id === PAPER)).toMatchObject({ origin: "yours", status: "reading", place: { tabId: TAB_W } });
  });

  it("refuses a plan that breaks a rule, keeps a good one", async () => {
    const bad = { ...PLAN, components: [PLAN.components[2], PLAN.components[1]] };
    let text = await turn(workshopChat, script([{ tool: "paper_plan", args: bad }]));
    expect(text).toMatch(/\[saw paper playbook\]/);
    expect(text).toMatch(/was not saved/);
    text = await turn(workshopChat, script([{ tool: "paper_plan", args: PLAN }]));
    expect(text).toMatch(/saved and shown to the learner/);
    const view = await editor.request<ChatSnapshot>("chat.snapshot", { chatId: workshopChat }).catch(() => null);
    const shelf = (await home()).papers.find((x) => x.id === PAPER)!;
    expect(shelf.status).toBe("planning");
    expect(shelf.components.map((c) => [c.slug, c.mode, c.status])).toEqual([["data", "given", "ready"], ["double", "build", "planned"], ["fit", "build", "planned"]]);
    expect(view === null || view.workshop?.plan?.title === "Doubling, the paper").toBe(true);
  });

  it("writes the exercises after approval, checked by the machine, unseen by the learner", async () => {
    const view = await editor.request<MentorWorkshop>("mentor.paper.approve", { chatId: workshopChat });
    expect(view.approved).toBe(true);
    await editor.waitFor(() => {
      const papers = bridge.mentor.papers();
      return papers.find((x) => x.id === PAPER)?.status === "ready";
    }, 120_000, "exercises written");
    const shelf = (await home()).papers.find((x) => x.id === PAPER)!;
    expect(shelf.components.filter((c) => c.mode === "build").map((c) => c.status)).toEqual(["ready", "ready"]);
    expect(bridge.mentor.catalog.exercise(`${PAPER}--double`)).toMatchObject({ author: "ai", paper: PAPER, uses: [], title: "Nhân đôi", difficulty: 1100 });
    expect(bridge.mentor.catalog.exercise(`${PAPER}--double`)!.diagnostic).toBeUndefined();
    // The experiment's pass mark is the plan's, and the judge holds it.
    expect(bridge.mentor.catalog.exercise(`${PAPER}--fit`)).toMatchObject({ role: "experiment", judge: "kernel", uses: [`${PAPER}--double`], metrics: [{ name: "err", paper: "0.0", target: { op: "<=", value: 0.01 } }] });
    expect(bridge.mentor.catalog.paperGiven(PAPER)).toContain("return 6.0");
    // The hidden chat never reached the editor.
    const seen = JSON.stringify(editor.parts());
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain("[saw author playbook]");
    expect(shelf.results).toEqual([{ name: "err", paper: "0.0" }]);
  });

  it("is today's exercise when it is the focus, one component after another", async () => {
    // Past the diagnostic (which comes first).
    for (const e of bridge.mentor.catalog.exercises.filter((x) => x.diagnostic)) {
      bridge.mentor.record({ t: "start", attemptId: `diag-${e.id}`, exerciseId: e.id });
      bridge.mentor.record({ t: "done", attemptId: `diag-${e.id}` });
    }
    await editor.request("mentor.focus", { focus: { kind: "paper", id: PAPER } });
    const h = await home();
    expect(h.focus).toMatchObject({ kind: "paper", id: PAPER });
    expect(h.today).toMatchObject({ exerciseId: `${PAPER}--double`, reason: "paper" });
    await expect(editor.request("mentor.start", { exerciseId: `${PAPER}--fit`, tabId: TAB_L })).rejects.toThrow(/Nhân đôi/);
  });

  it("carries the paper's given code and the learner's own solution into the next exercise", async () => {
    await editor.request("mentor.start", { exerciseId: `${PAPER}--double`, tabId: TAB_L });
    expect(nbL.cells.some((c) => c.source.includes("def target()"))).toBe(true);
    expect(nbL.cells.map((c) => c.source).join("\n")).not.toContain(SECRET);
    const snap = await openOn(TAB_L, KEY_L);
    expect(snap.mentor?.paper).toMatchObject({ paperId: PAPER, index: 1, total: 2, ai: true, cites: "Eq. 1" });
    const solution = nbL.cells.find((c) => cellRole(c) === "solution")!;
    solution.source = "#| mentor: solution\nimport numpy as np\n\ndef double(x):\n    return 2 * x  # MINE";
    nbL.execResult = (code) => {
      const nonce = code.match(/"nonce": "([^"]+)"/)?.[1];
      return { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\n<<MENTOR ${JSON.stringify({ nonce, tests: [{ name: "a", ok: true }] })} MENTOR>>\n` }] };
    };
    await editor.request("mentor.judge", { chatId: snap.chatId });
    await editor.waitFor(() => bridge.mentor.store.solution(`${PAPER}--double`) !== null, 20_000, "solution saved");
    await editor.request("mentor.stage", { chatId: snap.chatId, stage: "done" }).catch(() => {});
    // Finish the defence the way the agent would.
    const s = [...bridge.mentor.state().attempts.values()].find((a) => a.exerciseId === `${PAPER}--double`)!;
    bridge.mentor.record({ t: "probe", attemptId: s.attemptId, grade: 2, question: "q1" });
    bridge.mentor.record({ t: "probe", attemptId: s.attemptId, grade: 2, question: "q2" });
    bridge.mentor.record({ t: "done", attemptId: s.attemptId });
    expect((await home()).today).toMatchObject({ exerciseId: `${PAPER}--fit`, reason: "paper" });

    await editor.request("mentor.start", { exerciseId: `${PAPER}--fit`, tabId: TAB_L });
    const carried = nbL.cells.find((c) => cellRole(c) === "carried")!;
    expect(carried.source).toContain("# MINE");
    expect(carried.source).toContain("def target()");
    expect(carried.source).not.toContain("#| mentor: solution\n");
    expect(nbL.cells.some((c) => c.source.includes("Dự đoán trước"))).toBe(true);
  });

  it("voids an attempt the learner reports as wrong", async () => {
    const snap = await openOn(TAB_L, KEY_L);
    expect(snap.mentor?.exerciseId).toBe(`${PAPER}--fit`);
    await editor.request("mentor.report", { chatId: snap.chatId, reason: "Test đòi w = 3 nhưng target là 6." });
    const a = [...bridge.mentor.state().attempts.values()].find((x) => x.exerciseId === `${PAPER}--fit`)!;
    // It is not taken up again, and the paper's workshop knows what to write again.
    expect(bridge.mentor.attempt(a.attemptId)!.voided).toMatch(/target là 6/);
    expect((await home()).today).toMatchObject({ exerciseId: `${PAPER}--fit`, reason: "paper" });
    expect(bridge.mentor.openAttempt(`${PAPER}--fit`, "learn")).toBeUndefined();
    expect(bridge.workshops.view(PAPER).reported).toEqual([{ slug: "fit", title: "Thí nghiệm", reason: "Test đòi w = 3 nhưng target là 6." }]);
    expect((await paper(PAPER)).components.find((c) => c.slug === "fit")).toMatchObject({ reported: true });
    bridge.mentor.record({ t: "done", attemptId: a.attemptId });
    const after = bridge.mentor.attempt(a.attemptId)!;
    expect(after.voided).toMatch(/target là 6/);
    expect(after.result?.deltas).toEqual([]);
  });

  it("writes a reported exercise again with what the learner said, and checks what was built on it", async () => {
    const id = `${PAPER}--double`;
    expect((await paper(PAPER)).components.find((c) => c.slug === "double")!.status).toBe("done");
    bridge.workshops.report(PAPER, id, "Paper nói nhân ba, không phải nhân đôi.");
    scripts({
      ...AUTHOR,
      "double:rewrite": [
        write("double", "brief.md", "Viết `double(x)` trả về 3x. Sửa theo: {{reported}}"),
        write("double", "reference.py", "def double(x):\n    return 3 * x\n"),
        write("double", "mutants/triple.py", "def double(x):\n    return 2 * x\n"),
        { tool: "paper_exercise_check", args: { component: "double" } },
      ],
    });
    await editor.request("mentor.paper.author", { chatId: workshopChat, slug: "double" });
    await authored(PAPER, () => !!bridge.mentor.catalog.exercise(id)?.brief.includes("3x"), "double written again");
    const ex = bridge.mentor.catalog.exercise(id)!;
    expect(ex.brief).toContain("Sửa theo: Paper nói nhân ba, không phải nhân đôi.");
    expect(ex.reference).toContain("3 * x");
    // The files the author did not touch are the old ones.
    expect(ex.tests).toContain("test_case_4");
    // What was done on the old version no longer counts, and nothing builds on it.
    expect([...bridge.mentor.state().attempts.values()].filter((a) => a.exerciseId === id).every((a) => a.voided !== undefined)).toBe(true);
    expect(bridge.mentor.store.solution(id)).toBeNull();
    expect((await paper(PAPER)).components.find((c) => c.slug === "double")).toMatchObject({ status: "ready" });
    await expect(editor.request("mentor.start", { exerciseId: `${PAPER}--fit`, tabId: TAB_L })).rejects.toThrow(/Nhân đôi/);
    // The experiment built on it no longer passes its check: it waits to be written again too.
    const reported = bridge.workshops.view(PAPER).reported;
    expect(reported.map((r) => r.slug)).toEqual(["fit"]);
    expect(reported[0]!.reason).toMatch(/target là 6[\s\S]*không còn qua kiểm chứng/);
    expect(bridge.mentor.catalog.paperGiven(PAPER)).toContain("return 6.0");
  });

  it("keeps the old exercise when the rewrite does not pass, then replaces it by one that does", async () => {
    const id = `${PAPER}--fit`;
    const before = bridge.mentor.catalog.exercise(id)!.hash;
    scripts({ ...AUTHOR, "fit:rewrite": [write("fit", "tests.py", "def test_fit(user, ref):\n    assert False\n"), { tool: "paper_exercise_check", args: { component: "fit" } }] });
    const seen = editor.parts().length;
    await editor.request("mentor.paper.author", { chatId: workshopChat, slug: "fit" });
    await authored(PAPER, () => JSON.stringify(editor.parts().slice(seen)).includes("chưa soạn lại được"), "the failed rewrite");
    expect(bridge.mentor.catalog.exercise(id)!.hash).toBe(before);
    expect(bridge.workshops.view(PAPER).reported.map((r) => r.slug)).toEqual(["fit"]);
    expect((await paper(PAPER)).components.find((c) => c.slug === "fit")!.status).not.toBe("failed");

    scripts({
      ...AUTHOR,
      "fit:rewrite": [
        write("fit", "tests.py", 'def test_fit(user, ref):\n    """đo sai số"""\n    m = user.get("model")\n    assert m is not None, "Chưa có model."\n    t.report("err", abs(m["w"] - 2.0))'),
        { tool: "paper_exercise_check", args: { component: "fit" } },
      ],
    });
    await editor.request("mentor.paper.author", { chatId: workshopChat, slug: "fit" });
    await authored(PAPER, () => bridge.mentor.catalog.exercise(id)?.hash !== before, "fit written again");
    expect(bridge.mentor.catalog.exercise(id)!.tests).toContain("2.0");
    expect(bridge.workshops.view(PAPER).reported).toEqual([]);
    expect(bridge.workshops.view(PAPER)).toMatchObject({ status: "ready", authoring: { done: 2, total: 2, failed: 0, running: false } });
  });
});

describe.skipIf(!python)("writing a paper's exercises when things go wrong", () => {
  let chat = "";
  const view = () => bridge.workshops.view(PAPER2);
  const statuses = async () => (await paper(PAPER2)).components.map((c) => c.status);

  it("holds back what is built on a component that could not be written", async () => {
    bridge.mentor.shelf.create({ id: PAPER2, title: "Chain", source: "# Chain\n\nEq. 1.", kind: "latex" });
    bridge.mentor.reloadCatalog();
    await editor.request("mentor.paper.open", { paperId: PAPER2, tabId: TAB_W2 });
    chat = (await openOn(TAB_W2, KEY_W2)).chatId;
    expect(await turn(chat, script([{ tool: "paper_plan", args: PLAN2 }]))).toMatch(/saved and shown to the learner/);
    scripts({ ...CHAIN, base: BROKEN_BASE });
    await editor.request("mentor.paper.approve", { chatId: chat });
    await authored(PAPER2, () => view().authoring?.failed === 3, "base given up");
    const p = await paper(PAPER2);
    expect(p.components.map((c) => c.status)).toEqual(["failed", "failed", "failed"]);
    expect(p.components[0]!.note).toMatch(/reference/);
    // The two above it cost nothing: they wait for it.
    expect(p.components[1]!.note).toMatch(/chờ bài “Base”/);
    expect(p.components[2]!.note).toMatch(/chờ bài “Top”/);
    expect(bridge.mentor.shelf.readDraft(PAPER2, "top")).toEqual({});
    expect(p.status).toBe("authoring");
  });

  it("asks for approval again when the plan changes, and says why nothing is written meanwhile", async () => {
    expect(await turn(chat, script([{ tool: "paper_plan", args: PLAN2 }]))).toMatch(/saved and shown/);
    expect(view().approved).toBe(true);
    expect(await turn(chat, script([{ tool: "paper_plan", args: { ...PLAN2, goal: "Mục tiêu khác." } }]))).toMatch(/saved and shown/);
    expect(view()).toMatchObject({ approved: false, status: "planning" });
    const seen = editor.parts().length;
    await editor.request("mentor.paper.author", { chatId: chat, retry: true });
    await editor.waitFor(() => JSON.stringify(editor.parts().slice(seen)).includes("Chưa soạn được bài: Duyệt kế hoạch trước"), 20_000, "the reason, in the chat");
    await new Promise((r) => setTimeout(r, 300));
  });

  it("stops without blaming the exercises when the notebook's machine is off", async () => {
    scripts(CHAIN);
    nbW2.connected = false;
    // Approving starts the writing: the machine does not answer.
    const seen = editor.parts().length;
    await editor.request("mentor.paper.approve", { chatId: chat });
    await authored(PAPER2, () => /đã dừng/.test(view().authoring?.note ?? ""), "the writing stopped");
    await editor.waitFor(() => /Mentor dừng soạn bài[^"]*Bật máy của notebook xưởng/.test(JSON.stringify(editor.parts().slice(seen))), 20_000, "the reason, in the chat");
    expect(view().authoring).toMatchObject({ done: 0, failed: 3, running: false });
    // Tried again on request, still off: what could not be written before is not blamed either.
    await editor.request("mentor.paper.author", { chatId: chat, retry: true });
    await authored(PAPER2, () => view().authoring?.failed === 0 && /đã dừng/.test(view().authoring?.note ?? ""), "stopped again");
    expect(await statuses()).toEqual(["planned", "planned", "planned"]);
    expect(view().status).toBe("authoring");
  });

  it("writes them once the machine is back", async () => {
    nbW2.connected = true;
    await editor.request("mentor.paper.author", { chatId: chat });
    await authored(PAPER2, () => view().status === "ready", "the chain written");
    expect(await statuses()).toEqual(["ready", "ready", "ready"]);
    expect(view().authoring).toMatchObject({ done: 3, total: 3, failed: 0, running: false });
    expect(bridge.mentor.catalog.exercise(`${PAPER2}--exp2`)!.metrics).toEqual([{ name: "val", paper: "4", target: { op: ">=", value: 3.9 } }]);
    // What is written keeps its interface, and a written experiment its pass marks.
    expect(await turn(chat, script([{ tool: "paper_plan", args: { ...PLAN2, goal: "Mục tiêu khác.", components: PLAN2.components.map((c) => (c.slug === "base" ? { ...c, functions: ["other(x)"] } : c)) } }]))).toMatch(/base is already written/);
    expect(await turn(chat, script([{ tool: "paper_plan", args: { ...PLAN2, goal: "Mục tiêu khác.", experiment: { ...PLAN2.experiment, metrics: [{ ...PLAN2.experiment.metrics[0], target: { op: ">=", value: 1 } }] } } }]))).toMatch(/keep its metrics and pass marks/);
    expect(readFileSync(process.env.FAKE_AUTHOR!, "utf8")).toContain("exp2");
  }, 240_000);
});
