// A Mentor exercise end to end through the real bridge: the home page, the
// notebook it writes, a chat that coaches without editing, the judge, hints,
// the defence and the rating.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSnapshot, MentorHome, Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { vscodeKey } from "../src/mentor/store.js";
import { parseIpynb } from "../src/notebook/ipynb.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";

const TOKEN = "test-token-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
const NO_ORX = { knownPorts: [], locate: () => ({ missing: "OpenResearch is not used in these tests." }) };

let bridge: Bridge;
let port: number;
let work: string;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "ainb-mentor-chat-"));
  process.env.AINB_HOME = home;
  work = join(home, "work");
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 3 }]));
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: NO_ORX, log: () => {} });
  port = await bridge.listen();
});

afterAll(async () => {
  await bridge?.close();
});

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

async function turn(ext: FakeExtension, chatId: string, text: string) {
  const before = ext.statuses.length;
  await ext.request("chat.send", { chatId, text });
  await ext.waitFor(() => ext.statuses.slice(before).includes("idle") || ext.statuses.slice(before).includes("error"), 60_000, "turn end");
  return ext.agentText();
}

const cards = (ext: FakeExtension) =>
  ext.parts().filter((p): p is Extract<Part, { type: "card" }> => p.type === "card" && p.card.kind === "mentor").map((p) => p.card);

/** The judge's harness, answered like the kernel would: a marked line with its nonce. */
function verdictFor(tests: { name: string; ok: boolean; message?: string }[]) {
  return (code: string) => {
    const nonce = code.match(/"nonce": "([^"]+)"/)?.[1];
    if (!code.includes("_ainb_mentor_judge") || !nonce) return { status: "ok" as const, outputs: [{ kind: "result" as const, text: "42" }] };
    return { status: "ok" as const, outputs: [{ kind: "stream" as const, name: "stdout", text: `\n<<MENTOR ${JSON.stringify({ nonce, tests })} MENTOR>>\n` }] };
  };
}

describe("a Mentor exercise", () => {
  it("runs from the home page to a rating", async () => {
    const ext = new FakeExtension(new FakeNotebook([]), 300);
    await ext.connect(port, TOKEN);
    const settled = await ext.request<MentorHome>("mentor.settings", { workDir: work });
    expect(settled.workDir).toBe(work);
    expect(settled.today).toMatchObject({ reason: "diagnostic", exerciseId: "broadcast-pairwise" });
    expect(settled.stars.find((s) => s.id === "broadcasting")?.state).toBe("open");

    // The bridge writes the notebook: brief, lab, sketch, an empty solution cell; no reference, no tests.
    const started = await ext.request<{ attemptId: string; file: string; resumed: boolean }>("mentor.start", {});
    expect(started.file.startsWith(work)).toBe(true);
    const text = readFileSync(started.file, "utf8");
    expect(text).not.toContain("diff ** 2");
    const { cells } = parseIpynb(text);
    const nb = new FakeNotebook(cells.map((c) => ({ type: c.type, source: c.source })));
    nb.platform = "vscode";
    ext.attachNotebook(301, nb);

    const snap = await ext.request<ChatSnapshot>("chat.open", {
      tabId: 301, agentId: "fake", platform: "vscode", notebookKey: vscodeKey(started.file),
      settings: { scope: "write", review: true, targetCellIds: [], notebookOnly: false },
    });
    expect(snap.mentor).toMatchObject({ attemptId: started.attemptId, stage: "lab", hintLevel: 0 });
    // The chat's mode is fixed: the agent runs scratch code but has no tool that edits cells.
    expect(snap.settings).toMatchObject({ scope: "auto", review: false, notebookOnly: true });
    expect(snap.project).toBeUndefined();
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
    const chatId = snap.chatId;

    let out = await turn(ext, chatId, script([
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
    out = await turn(ext, chatId, "ECHO_MENTOR");
    expect(out).toContain("Step: build");
    expect(out).toContain("unchanged since your last turn");
    const solution = nb.cells.find((c) => c.source.startsWith("#| mentor: solution"))!;
    solution.source = "#| mentor: solution\nimport numpy as np\n\ndef pairwise_sqdist(X, Y):\n    return 0  # my attempt";
    out = await turn(ext, chatId, "ECHO_MENTOR again");
    expect(out).toContain("return 0  # my attempt");

    // A hint: one level up, and the agent is told the level.
    const hint = await ext.request<{ level: number }>("mentor.hint", { chatId });
    expect(hint.level).toBe(1);
    await ext.waitFor(() => ext.agentText().includes("[saw hint 1]"), 30_000, "hint turn");
    await ext.waitFor(() => ext.statuses.at(-1) === "idle", 30_000, "hint turn end");

    // A failing verdict, then a passing one that opens the defence.
    nb.execResult = verdictFor([{ name: "Kết quả có shape (n, m)", ok: true }, { name: "Đúng giá trị", ok: false, message: "Giá trị chưa đúng." }]);
    await ext.request("mentor.judge", { chatId });
    await ext.waitFor(() => cards(ext).some((c) => c.mentor?.type === "verdict"), 30_000, "first verdict");
    expect(cards(ext).find((c) => c.mentor?.type === "verdict")).toMatchObject({ title: "Đạt 1/2 test", tone: "error" });
    await ext.waitFor(() => (ext.agentText().match(/\[saw verdict\]/g) ?? []).length === 1 && ext.statuses.at(-1) === "idle", 30_000, "verdict turn");

    nb.execResult = verdictFor([{ name: "Kết quả có shape (n, m)", ok: true }, { name: "Đúng giá trị", ok: true }]);
    await ext.request("mentor.judge", { chatId });
    await ext.waitFor(() => cards(ext).filter((c) => c.mentor?.type === "verdict").length === 2, 30_000, "second verdict");
    await ext.waitFor(() => (ext.agentText().match(/\[saw verdict\]/g) ?? []).length === 2 && ext.statuses.at(-1) === "idle", 30_000, "second verdict turn");
    // The judge ran in the kernel from the cells' source, not from its variables.
    const judged = nb.executed.filter((e) => e.code.includes("_ainb_mentor_judge"));
    expect(judged).toHaveLength(2);
    const mid = (await ext.request<ChatSnapshot>("chat.get", { tabId: 301 })).mentor!;
    expect(mid).toMatchObject({ stage: "defend", judges: 2, hintLevel: 1 });

    // The defence: graded answers, then done, and the result card.
    out = await turn(ext, chatId, script([
      { tool: "mentor_probe_result", args: { question: "Vì sao chia √d?", grade: 2 } },
      { tool: "mentor_stage", args: { stage: "done" } },
      { tool: "mentor_misconception", args: { tag: "broadcast-memory", note: "Nghĩ là broadcasting không tốn bộ nhớ." } },
      { tool: "mentor_probe_result", args: { question: "Shape trung gian?", grade: 1, tag: "broadcast-memory" } },
      { tool: "mentor_stage", args: { stage: "done" } },
    ]));
    expect(out).toMatch(/RESULT mentor_stage \(error\): Grade 1 more probing question/);
    expect(out).toContain("RESULT mentor_stage: The exercise is now at Xong (done).");
    await ext.waitFor(() => cards(ext).some((c) => c.mentor?.type === "result"), 30_000, "result card");
    const result = cards(ext).find((c) => c.mentor?.type === "result")!;
    expect(result.mentor).toMatchObject({ type: "result", streak: 1 });

    const after = await ext.request<MentorHome>("mentor.home", {});
    expect(after.streak).toMatchObject({ current: 1, doneToday: true });
    expect(after.skills.find((s) => s.skill === "tensor")?.rating).toBeGreaterThan(1000);
    expect(after.stars.find((s) => s.id === "broadcasting")?.state).toBe("mastered");
    expect(after.today).toMatchObject({ reason: "diagnostic", exerciseId: "gather-mask-nll" });
    expect(after.recent[0]).toMatchObject({ attemptId: started.attemptId, stage: "done" });
    ext.close();
  });

  it("leaves other notebooks' chats as they were", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    const ext = new FakeExtension(nb, 310);
    await ext.connect(port, TOKEN);
    const snap = await ext.request<ChatSnapshot>("chat.open", { tabId: 310, agentId: "fake", platform: "colab", settings: { scope: "write", review: false, targetCellIds: [] } });
    expect(snap.mentor).toBeUndefined();
    expect(snap.settings.scope).toBe("write");
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
    const out = await turn(ext, snap.chatId, script([{ tool: "mentor_stage", args: { stage: "build" } }]));
    expect(out).toContain("[saw playbook]");
    expect(out).toContain("Unknown tool mentor_stage.");
    await expect(ext.request("mentor.hint", { chatId: snap.chatId })).rejects.toThrow(/không phải một bài Mentor/);
    ext.close();
  });
});
