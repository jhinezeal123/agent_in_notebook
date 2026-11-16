// A Mentor exercise end to end through the real bridge, as it runs for the
// learner: notebooks open in Chrome (Kaggle) that the bridge fills with an
// exercise, a chat in VS Code that coaches without editing, the judge on the
// notebook's machine, hints, the defence and the rating. Then the notebooks
// change hands: another exercise takes one, the first comes back in another,
// and a renamed notebook keeps its exercise.

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSnapshot, MentorHome, MentorPlace, NotebookInfo, Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { cellRole, exerciseIn } from "../src/mentor/notebook.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";

const TOKEN = "test-token-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
/** How many times the bridge went looking for OpenResearch. */
let orxAsked = 0;
const NO_ORX = { knownPorts: [], locate: () => (orxAsked++, { missing: "OpenResearch is not used in these tests." }) };
const SETTINGS = { scope: "write", review: true, targetCellIds: [], notebookOnly: false };

const TAB_A = 11;
const TAB_B = 12;
const KEY_A = "kaggle:/code/me/mentor-one";
const KEY_B = "kaggle:/code/me/mentor-two";

let bridge: Bridge;
let port: number;
let home: string;
let browser: FakeExtension;
let editor: FakeExtension;
let updates = 0;
const nbA = kaggle(new FakeNotebook([]), "mentor-one", "Mentor one");
const nbB = kaggle(new FakeNotebook([{ type: "code", source: "my_own = 1" }, { type: "markdown", source: "# Notes" }]), "mentor-two", "Mentor two");

/** A notebook as the Kaggle adapter describes it: its address gives its key. */
function kaggle(nb: FakeNotebook, slug: string, title: string): FakeNotebook {
  nb.platform = "kaggle";
  const base = nb.info.bind(nb);
  const where = { slug, title };
  nb.info = (): NotebookInfo => ({ ...base(), title: where.title, url: `https://www.kaggle.com/code/me/${where.slug}/edit`, key: `kaggle:/code/me/${where.slug}` });
  (nb as FakeNotebook & { rename(slug: string, title: string): void }).rename = (s, t) => Object.assign(where, { slug: s, title: t });
  return nb;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ainb-mentor-chat-"));
  process.env.AINB_HOME = home;
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 3 }]));
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: NO_ORX, log: () => {} });
  port = await bridge.listen();
  // VS Code: the chat panel (its own notebook is not used here).
  editor = new FakeExtension(new FakeNotebook([]), 400);
  await editor.connect(port, TOKEN);
  editor.rpc.on("mentor.updated", () => updates++);
  // Chrome: two Kaggle notebooks open in two tabs.
  browser = new FakeExtension(nbA, TAB_A);
  await browser.connect(port, TOKEN, "chrome-extension://abcdef");
  browser.attachNotebook(TAB_B, nbB);
  browser.rpc.emit("notebook.attached", { tabId: TAB_A, info: nbA.info() });
  browser.rpc.emit("notebook.attached", { tabId: TAB_B, info: nbB.info() });
  for (let i = 0; i < 100 && (await editor.request<{ notebooks: unknown[] }>("browser.notebooks", {})).notebooks.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
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

const cards = () =>
  editor.parts().filter((p): p is Extract<Part, { type: "card" }> => p.type === "card" && p.card.kind === "mentor").map((p) => p.card);

/** The judge's harness, answered like the kernel would: a marked line with its nonce. */
function verdictFor(tests: { name: string; ok: boolean; message?: string }[]) {
  return (code: string) => {
    const nonce = code.match(/"nonce": "([^"]+)"/)?.[1];
    if (!code.includes("_ainb_mentor_judge") || !nonce) return { status: "ok" as const, outputs: [{ kind: "result" as const, text: "42" }] };
    return { status: "ok" as const, outputs: [{ kind: "stream" as const, name: "stdout", text: `\n<<MENTOR ${JSON.stringify({ nonce, tests })} MENTOR>>\n` }] };
  };
}

const places = async () => (await editor.request<MentorPlace[]>("mentor.places", {}));
const place = async (tabId: number) => (await places()).find((p) => p.tabId === tabId);

/** The chat VS Code opens beside the copy of a Chrome tab's notebook. */
async function openOn(tabId: number, key: string) {
  const idle = editor.statuses.filter((s) => s === "idle").length;
  const snap = await editor.request<ChatSnapshot>("chat.open", { tabId: -tabId, browserTab: tabId, agentId: "fake", platform: "kaggle", notebookKey: key, settings: SETTINGS });
  await editor.waitFor(() => editor.statuses.filter((s) => s === "idle").length > idle, 30_000, "agent start");
  return snap;
}

const solutionOf = (nb: FakeNotebook) => nb.cells.find((c) => cellRole({ id: c.id, type: c.type, source: c.source }) === "solution")!;

describe("a Mentor exercise in a Kaggle notebook", () => {
  let first: string;

  it("lists the notebooks open in Chrome, and leaves the learner's own until they say yes", async () => {
    const start = await editor.request<MentorHome>("mentor.home", {});
    expect(start.today).toMatchObject({ reason: "diagnostic", exerciseId: "broadcast-pairwise" });
    expect(await places()).toEqual([
      expect.objectContaining({ tabId: TAB_A, key: KEY_A, title: "Mentor one", platform: "kaggle", foreignCells: 0 }),
      expect.objectContaining({ tabId: TAB_B, key: KEY_B, title: "Mentor two", foreignCells: 2 }),
    ]);
    expect((await place(TAB_A))?.holds).toBeUndefined();
    await expect(editor.request("mentor.start", { tabId: TAB_B })).rejects.toThrow(/2 cell của bạn/);
    expect(nbB.cells.map((c) => c.source)).toEqual(["my_own = 1", "# Notes"]);
    await expect(editor.request("mentor.start", {})).rejects.toThrow(/Chọn một notebook/);
  });

  it("runs from the home page to a rating", async () => {
    // The bridge writes the exercise into the notebook: brief, lab, sketch, an empty solution cell; no reference, no tests.
    const started = await editor.request<{ attemptId: string; exerciseId: string; tabId: number; resumed: boolean }>("mentor.start", { tabId: TAB_A });
    expect(started).toMatchObject({ exerciseId: "broadcast-pairwise", tabId: TAB_A, resumed: false });
    first = started.attemptId;
    expect(exerciseIn(nbA.cells)).toBe("broadcast-pairwise");
    expect(nbA.cells.map((c) => c.source).join("\n")).not.toContain("diff ** 2");
    expect(nbA.cells.some((c) => cellRole(c) === "sketch")).toBe(true);
    // Written as the learner's own edits: no change for the agent to review or undo.
    expect(nbA.reviews.size).toBe(0);
    expect((await place(TAB_A))?.holds).toMatchObject({ attemptId: first, exerciseId: "broadcast-pairwise", kind: "learn", done: false });
    // Starting it again leaves the notebook as it is.
    const count = nbA.cells.length;
    expect(await editor.request("mentor.start", { tabId: TAB_A })).toMatchObject({ attemptId: first, resumed: true });
    expect(nbA.cells.length).toBe(count);

    const snap = await openOn(TAB_A, KEY_A);
    expect(snap.mentor).toMatchObject({ attemptId: first, stage: "lab", hintLevel: 0 });
    // The chat's mode is fixed: the agent runs scratch code but has no tool that edits cells.
    expect(snap.settings).toMatchObject({ scope: "auto", review: false, notebookOnly: true });
    expect(snap.project).toBeUndefined();
    const chatId = snap.chatId;

    let out = await turn(chatId, script([
      { tool: "NotebookEdit", args: { cell_id: "c1", new_source: "x" } },
      { tool: "Write", args: { file_path: "a.txt", content: "x" } },
      { tool: "mentor_stage", args: { stage: "done" } },
      { tool: "mentor_stage", args: { stage: "build" } },
    ]));
    expect(out).toContain("[saw mentor playbook]");
    expect(out).toContain("RESULT NotebookEdit (error): Unknown tool NotebookEdit.");
    expect(out).toContain("RESULT Write (error): Unknown tool Write.");
    expect(out).toMatch(/RESULT mentor_stage \(error\): The judge has not passed/);
    expect(out).toContain("RESULT mentor_stage: The exercise is now at Dựng (build).");

    // The learner's cells come with the state when they change, and only then.
    out = await turn(chatId, "ECHO_MENTOR");
    expect(out).toContain("Step: build");
    expect(out).toContain("unchanged since your last turn");
    solutionOf(nbA).source = "#| mentor: solution\nimport numpy as np\n\ndef pairwise_sqdist(X, Y):\n    return 0  # my attempt";
    out = await turn(chatId, "ECHO_MENTOR again");
    expect(out).toContain("return 0  # my attempt");

    // A hint: one level up, and the agent is told the level.
    const hint = await editor.request<{ level: number }>("mentor.hint", { chatId });
    expect(hint.level).toBe(1);
    await editor.waitFor(() => editor.agentText().includes("[saw hint 1]"), 30_000, "hint turn");
    await editor.waitFor(() => editor.statuses.at(-1) === "idle", 30_000, "hint turn end");

    // A failing verdict, then a passing one that opens the defence: both run on the notebook's machine.
    nbA.execResult = verdictFor([{ name: "Kết quả có shape (n, m)", ok: true }, { name: "Đúng giá trị", ok: false, message: "Giá trị chưa đúng." }]);
    await editor.request("mentor.judge", { chatId });
    await editor.waitFor(() => cards().some((c) => c.mentor?.type === "verdict"), 30_000, "first verdict");
    expect(cards().find((c) => c.mentor?.type === "verdict")).toMatchObject({ title: "Đạt 1/2 test", tone: "error" });
    await editor.waitFor(() => (editor.agentText().match(/\[saw verdict\]/g) ?? []).length === 1 && editor.statuses.at(-1) === "idle", 30_000, "verdict turn");

    nbA.execResult = verdictFor([{ name: "Kết quả có shape (n, m)", ok: true }, { name: "Đúng giá trị", ok: true }]);
    await editor.request("mentor.judge", { chatId });
    await editor.waitFor(() => cards().filter((c) => c.mentor?.type === "verdict").length === 2, 30_000, "second verdict");
    await editor.waitFor(() => (editor.agentText().match(/\[saw verdict\]/g) ?? []).length === 2 && editor.statuses.at(-1) === "idle", 30_000, "second verdict turn");
    expect(nbA.executed.filter((e) => e.code.includes("_ainb_mentor_judge"))).toHaveLength(2);
    const mid = (await editor.request<ChatSnapshot>("chat.get", { tabId: -TAB_A })).mentor!;
    expect(mid).toMatchObject({ stage: "defend", judges: 2, hintLevel: 1 });

    // The defence: graded answers, then done, and the result card.
    out = await turn(chatId, script([
      { tool: "mentor_probe_result", args: { question: "Vì sao chia √d?", grade: 2 } },
      { tool: "mentor_stage", args: { stage: "done" } },
      { tool: "mentor_misconception", args: { tag: "broadcast-memory", note: "Nghĩ là broadcasting không tốn bộ nhớ." } },
      { tool: "mentor_probe_result", args: { question: "Shape trung gian?", grade: 1, tag: "broadcast-memory" } },
      { tool: "mentor_stage", args: { stage: "done" } },
    ]));
    expect(out).toMatch(/RESULT mentor_stage \(error\): Grade 1 more probing question/);
    expect(out).toContain("RESULT mentor_stage: The exercise is now at Xong (done).");
    await editor.waitFor(() => cards().some((c) => c.mentor?.type === "result"), 30_000, "result card");
    expect(cards().find((c) => c.mentor?.type === "result")!.mentor).toMatchObject({ type: "result", streak: 1 });

    const after = await editor.request<MentorHome>("mentor.home", {});
    expect(after.streak).toMatchObject({ current: 1, doneToday: true });
    expect(after.skills.find((s) => s.skill === "tensor")?.rating).toBeGreaterThan(1000);
    expect(after.stars.find((s) => s.id === "broadcasting")?.state).toBe("mastered");
    expect(after.today).toMatchObject({ reason: "diagnostic", exerciseId: "gather-mask-nll" });
    expect(after.recent[0]).toMatchObject({ attemptId: first, stage: "done" });
    expect(after.reviews.upcoming[0]).toMatchObject({ exerciseId: "broadcast-pairwise" });
    expect(after.mistakes[0]).toMatchObject({ tag: "broadcast-memory", status: "waiting" });

    // Once done, a code review: the mentor gets the request (with the reference to compare).
    await editor.waitFor(() => editor.statuses.at(-1) === "idle", 30_000, "wrap-up turn end");
    await editor.request("mentor.codeReview", { chatId });
    await editor.waitFor(() => editor.agentText().includes("[saw code review with reference]"), 30_000, "code review turn");
    await editor.waitFor(() => editor.statuses.at(-1) === "idle", 30_000, "code review turn end");
  });

  it("keeps the work and the conversation when another exercise takes the notebook, and brings them back in another", async () => {
    // Today's exercise into the notebook that holds the finished one: no question asked.
    const started = await editor.request<{ attemptId: string; exerciseId: string }>("mentor.start", { tabId: TAB_A });
    expect(started.exerciseId).toBe("gather-mask-nll");
    const gather = started.attemptId;
    expect(exerciseIn(nbA.cells)).toBe("gather-mask-nll");
    const snap = await openOn(TAB_A, KEY_A);
    expect(snap.mentor).toMatchObject({ attemptId: gather });
    // The finished exercise's conversation went away with it.
    expect(snap.messages.some((m) => m.role === "user")).toBe(false);
    await turn(snap.chatId, "Mình bắt đầu bài gather");
    solutionOf(nbA).source = `${solutionOf(nbA).source}\n# my gather work`;

    // Another exercise into the same notebook: gather's work is kept, its chat closes.
    await editor.request("mentor.start", { tabId: TAB_A, exerciseId: "layernorm" });
    expect(exerciseIn(nbA.cells)).toBe("layernorm");
    expect(editor.snapshots.some((s) => s.chatId === snap.chatId && s.status === "closed")).toBe(true);
    expect(existsSync(join(home, "mentor", "attempts", `${gather}.json`))).toBe(true);

    // Gather again, in the notebook with the learner's own cells: they say yes, the old content is backed up.
    const resumed = await editor.request<{ attemptId: string; resumed: boolean }>("mentor.start", { tabId: TAB_B, exerciseId: "gather-mask-nll", replace: true });
    expect(resumed).toMatchObject({ attemptId: gather, resumed: true });
    expect(readdirSync(join(home, "mentor", "backups")).some((f) => f.endsWith("Mentor two.ipynb"))).toBe(true);
    expect(exerciseIn(nbB.cells)).toBe("gather-mask-nll");
    expect(solutionOf(nbB).source).toContain("# my gather work");
    expect(nbB.cells.some((c) => c.source === "my_own = 1")).toBe(false);
    const back = await openOn(TAB_B, KEY_B);
    expect(back.mentor).toMatchObject({ attemptId: gather });
    expect(back.messages.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text.includes("Mình bắt đầu bài gather")))).toBe(true);

    expect(await place(TAB_A)).toMatchObject({ holds: { exerciseId: "layernorm" } });
    expect(await place(TAB_B)).toMatchObject({ holds: { attemptId: gather, exerciseId: "gather-mask-nll" } });

    // The home page says where the exercise to continue is.
    const now = await editor.request<MentorHome>("mentor.home", {});
    expect(now.today?.reason).toBe("continue");
    const holder = (await places()).find((x) => x.holds?.attemptId === now.today?.attemptId)!;
    expect(now.today?.place).toEqual({ tabId: holder.tabId, title: holder.title });
    // Starting it without naming a notebook opens the one that holds it, as it is.
    const count = nbB.cells.length;
    expect(await editor.request("mentor.start", { exerciseId: "gather-mask-nll" })).toMatchObject({ attemptId: gather, tabId: TAB_B, resumed: true });
    expect(nbB.cells.length).toBe(count);
    await expect(editor.request("mentor.start", { exerciseId: "einsum-scores" })).rejects.toThrow(/Chọn một notebook/);
  });

  it("follows a notebook renamed on Kaggle", async () => {
    (nbB as FakeNotebook & { rename(slug: string, title: string): void }).rename("mentor-two-renamed", "Mentor two (renamed)");
    browser.rpc.emit("notebook.attached", { tabId: TAB_B, info: nbB.info() });
    await expect.poll(async () => (await place(TAB_B))?.holds?.exerciseId, { timeout: 10_000 }).toBe("gather-mask-nll");
    expect(await place(TAB_B)).toMatchObject({ key: "kaggle:/code/me/mentor-two-renamed" });
    const snap = await openOn(TAB_B, "kaggle:/code/me/mentor-two-renamed");
    expect(snap.mentor).toMatchObject({ exerciseId: "gather-mask-nll" });
    expect(snap.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("runs a spaced review: a blank cell, no lab, done when the judge passes", async () => {
    const started = await editor.request<{ attemptId: string }>("mentor.start", { tabId: TAB_A, exerciseId: "broadcast-pairwise", kind: "review" });
    const brief = nbA.cells[0]!.source.split("\n");
    expect(brief[0]).toBe("<!-- mentor: exercise broadcast-pairwise -->");
    expect(brief[1]).toMatch(/^# Ôn lại:/);
    expect(nbA.cells.some((c) => cellRole(c) === "sketch" || c.source.includes("mentor: lab"))).toBe(false);
    const solution = solutionOf(nbA);
    expect(solution.source).toContain("# Viết pairwise_sqdist(...) ở đây.");
    expect(solution.source).not.toContain("def ");
    const snap = await openOn(TAB_A, KEY_A);
    expect(snap.mentor).toMatchObject({ kind: "review", stage: "build", probes: { needed: 0 } });
    const out = await turn(snap.chatId, "ECHO_MENTOR");
    expect(out).toContain("Kind: spaced review");

    const results = cards().filter((c) => c.mentor?.type === "result").length;
    nbA.execResult = verdictFor([{ name: "Đúng giá trị", ok: true }]);
    await editor.request("mentor.judge", { chatId: snap.chatId });
    await editor.waitFor(() => cards().filter((c) => c.mentor?.type === "result").length > results, 30_000, "review result");
    const result = cards().filter((c) => c.mentor?.type === "result").at(-1)!;
    expect(result.title).toMatch(/^Ôn xong/);
    expect(result.mentor).toMatchObject({ type: "result", result: { nextReview: 10 } });
    const after = await editor.request<MentorHome>("mentor.home", {});
    expect(after.recent[0]).toMatchObject({ attemptId: started.attemptId, kind: "review", stage: "done" });
    await editor.waitFor(() => editor.statuses.at(-1) === "idle", 30_000, "verdict turn end");
  });

  it("tells the home page when a notebook holding an exercise closes", async () => {
    const before = updates;
    browser.rpc.emit("notebook.detached", { tabId: TAB_B });
    await editor.waitFor(() => updates > before, 10_000, "mentor.updated");
    expect(await place(TAB_B)).toBeUndefined();
  });

  it("never looks for OpenResearch: Mentor chats have no research project", () => {
    expect(orxAsked).toBe(0);
  });

  it("leaves other notebooks' chats as they were", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    const ext = new FakeExtension(nb, 310);
    await ext.connect(port, TOKEN);
    const snap = await ext.request<ChatSnapshot>("chat.open", { tabId: 310, agentId: "fake", platform: "colab", settings: { scope: "write", review: false, targetCellIds: [] } });
    expect(snap.mentor).toBeUndefined();
    expect(snap.settings.scope).toBe("write");
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
    const before = ext.statuses.length;
    await ext.request("chat.send", { chatId: snap.chatId, text: script([{ tool: "mentor_stage", args: { stage: "build" } }]) });
    await ext.waitFor(() => ext.statuses.slice(before).includes("idle"), 60_000, "turn end");
    const out = ext.agentText();
    expect(out).toContain("[saw playbook]");
    expect(out).toContain("Unknown tool mentor_stage.");
    await expect(ext.request("mentor.hint", { chatId: snap.chatId })).rejects.toThrow(/không phải một bài Mentor/);
    ext.close();
  });
});
