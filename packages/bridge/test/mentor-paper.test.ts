// A paper the learner brings, end to end through the real bridge: its
// workshop in a notebook open in Chrome, the plan the mentor proposes (a bad
// one refused), the learner's approval, the exercises written by a hidden
// chat and checked on the notebook's machine (this computer's Python stands
// in for Kaggle's), then the learner doing them in another notebook: the
// paper's given code and their own earlier solution carried into the next
// exercise, the paper as the focus of "today", and a report that voids an
// attempt. Nothing the author writes reaches the editor.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    write("double", "meta.json", JSON.stringify({ functions: ["double"], requires: ["numpy"], probes: 2 })),
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
    { tool: "paper_exercise_check", args: { component: "fit" } },
  ],
};

let bridge: Bridge;
let browser: FakeExtension;
let editor: FakeExtension;
const nbW = kaggle(new FakeNotebook([]), "workshop", "Workshop");
const nbL = kaggle(new FakeNotebook([]), "learn", "Learn");

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
  browser.rpc.emit("notebook.attached", { tabId: TAB_W, info: nbW.info() });
  browser.rpc.emit("notebook.attached", { tabId: TAB_L, info: nbL.info() });
  for (let i = 0; i < 100 && (await editor.request<{ notebooks: unknown[] }>("browser.notebooks", {})).notebooks.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
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
    expect(bridge.mentor.catalog.exercise(`${PAPER}--double`)).toMatchObject({ author: "ai", paper: PAPER, uses: [] });
    expect(bridge.mentor.catalog.exercise(`${PAPER}--fit`)).toMatchObject({ role: "experiment", judge: "kernel", uses: [`${PAPER}--double`] });
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
    bridge.mentor.record({ t: "done", attemptId: a.attemptId });
    const after = bridge.mentor.attempt(a.attemptId)!;
    expect(after.voided).toMatch(/target là 6/);
    expect(after.result?.deltas).toEqual([]);
  });
});
