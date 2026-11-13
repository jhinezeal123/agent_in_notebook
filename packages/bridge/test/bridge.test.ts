// End-to-end through the real bridge: fake extension (WebSocket) -> bridge ->
// scripted ACP agent (child process) -> `ainb mcp` relay (child process of the
// agent) -> bridge -> fake extension's notebook.

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatLaunchCommand, type AgentInfo, type ChatSettings, type ChatSnapshot, type Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { keyHash } from "../src/store.js";
import { FakeExtension, FakeNotebook, TINY_PNG } from "./fixtures/fake-extension.js";

const TOKEN = "test-token-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");

let bridge: Bridge;
let port: number;
let nextTab = 100;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "ainb-test-"));
  process.env.AINB_HOME = home;
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify([
      { id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 3 },
      { id: "fake2", name: "Fake Agent 2", command: process.execPath, args: [FAKE_AGENT], images: false },
    ]),
  );
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, log: () => {} });
  port = await bridge.listen();
});

afterAll(async () => {
  await bridge?.close();
});

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

async function setup(cells: { type: "code" | "markdown"; source: string }[], settings: Partial<ChatSettings> = {}) {
  const nb = new FakeNotebook(cells);
  const ext = new FakeExtension(nb, nextTab++);
  await ext.connect(port, TOKEN);
  const snap = await ext.request<ChatSnapshot>("chat.open", {
    tabId: ext.tabId,
    agentId: "fake",
    settings: { scope: "write", review: false, targetCellIds: [], ...settings },
    platform: "colab",
  });
  await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
  return { nb, ext, chatId: snap.chatId };
}

async function turn(ext: FakeExtension, chatId: string, text: string) {
  const before = ext.statuses.length;
  await ext.request("chat.send", { chatId, text });
  await ext.waitFor(() => ext.statuses.slice(before).includes("idle") || ext.statuses.slice(before).includes("error"), 60_000, "turn end");
  return ext.agentText();
}

describe("pairing", () => {
  it("rejects a wrong token", async () => {
    const ext = new FakeExtension(new FakeNotebook([]), 1);
    await expect(ext.connect(port, "wrong-token-wrong-token")).rejects.toThrow(/Pairing token/);
    ext.close();
  });

  it("rejects web origins", async () => {
    const ext = new FakeExtension(new FakeNotebook([]), 2);
    await expect(ext.connect(port, TOKEN, "https://evil.example")).rejects.toThrow(/403/);
  });

  it("requires a token on the VS Code endpoint and rejects browser origins there", async () => {
    const ext = new FakeExtension(new FakeNotebook([]));
    await expect(ext.connect(port, TOKEN, "https://example.com", "vscode")).rejects.toThrow(/403/);
    await expect(ext.connect(port, TOKEN, null)).rejects.toThrow(/403/);
    await expect(ext.connect(port, "wrong-token", null, "vscode")).rejects.toThrow(/Pairing token/);
    ext.close();
  });

  it("routes VS Code and browser chats with the same tab ID to their own notebook", async () => {
    const browser = await setup([{ type: "code", source: "browser_value = 1" }]);
    const editor = new FakeExtension(new FakeNotebook([{ type: "code", source: "editor_value = 2" }]), browser.ext.tabId);
    try {
      await editor.connect(port, TOKEN, null, "vscode");
      const snap = await editor.request<ChatSnapshot>("chat.open", {
        tabId: editor.tabId, agentId: "fake", settings: { scope: "write", review: false, targetCellIds: [] },
        platform: "vscode", notebookKey: "vscode:file:///sample.ipynb",
      });
      await editor.waitFor(() => editor.statuses.includes("idle"), 30_000, "editor agent start");
      const prompt = script([{ tool: "read_cells", args: {} }]);
      const [inBrowser, inEditor] = await Promise.all([turn(browser.ext, browser.chatId, prompt), turn(editor, snap.chatId, prompt)]);
      expect(inBrowser).toContain("browser_value = 1");
      expect(inBrowser).not.toContain("editor_value");
      expect(inEditor).toContain("editor_value = 2");
      await expect(editor.request("chat.send", { chatId: browser.chatId, text: "other client" })).rejects.toThrow(/no longer exists/);
    } finally {
      editor.close();
      browser.ext.close();
    }
  }, 60_000);

  it("refuses MCP relay calls without a chat token, or from a browser", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/list`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const res2 = await fetch(`http://127.0.0.1:${port}/mcp/list`, { method: "POST", body: "{}", headers: { origin: "https://evil.example" } });
    expect(res2.status).toBe(403);
  });

  it("lists agents including custom ones", async () => {
    const ext = new FakeExtension(new FakeNotebook([]), 3);
    const hello = (await ext.connect(port, TOKEN)) as { agents: { id: string; available: boolean }[] };
    expect(hello.agents.find((a) => a.id === "fake")?.available).toBe(true);
    expect(hello.agents.map((a) => a.id)).toEqual(expect.arrayContaining(["claude", "codex", "gemini", "opencode", "fake"]));
    ext.close();
  });
});

describe("chat with a notebook", () => {
  it("sets the model before the first prompt", async () => {
    const { ext, chatId } = await setup([]);
    try {
      const before = await ext.request<ChatSnapshot>("chat.get", { tabId: ext.tabId });
      expect(before.messages).toEqual([]);
      expect(before.options.find((o) => o.category === "model")?.choices?.some((c) => c.value === "smart")).toBe(true);
      const configured = await ext.request<ChatSnapshot>("chat.option", { chatId, optionId: "model", value: "smart" });
      expect(configured.messages).toEqual([]);
      expect(await turn(ext, chatId, "ECHO_MODEL first prompt")).toContain("[model smart]");
    } finally { ext.close(); }
  });

  it("accepts a message sent while the agent is still starting", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "a = 1" }]);
    const ext = new FakeExtension(nb, nextTab++);
    await ext.connect(port, TOKEN);
    const snap = await ext.request<ChatSnapshot>("chat.open", {
      tabId: ext.tabId,
      agentId: "fake",
      settings: { scope: "write", review: false, targetCellIds: [] },
      platform: "colab",
    });
    // No wait for "idle": the side panel opens the chat and sends at once.
    await ext.request("chat.send", { chatId: snap.chatId, text: "first words" });
    await ext.waitFor(() => ext.agentText().includes("echo: first words"), 30_000, "reply");
    expect(ext.agentText()).not.toContain("not running");
    ext.close();
  });

  it("gives the playbook once, the context every turn, and exposes agent options", async () => {
    const { ext, chatId } = await setup([{ type: "code", source: "import pandas as pd" }]);
    let text = await turn(ext, chatId, "ECHO_CONTEXT hello");
    expect(text).toContain("[saw playbook]");
    expect(text).toContain("<notebook-context>");
    expect(text).toContain("[0] c1 code: import pandas as pd");
    expect(text).toContain("Mode: Write");
    text = await turn(ext, chatId, "again");
    expect(text.match(/\[saw playbook\]/g)).toHaveLength(1);

    const snap = await ext.request<ChatSnapshot>("chat.get", { tabId: ext.tabId });
    expect(snap.options.find((o) => o.id === "model")).toMatchObject({ value: "fast", kind: "select" });
    const after = await ext.request<ChatSnapshot>("chat.option", { chatId, optionId: "model", value: "smart" });
    expect(after.options.find((o) => o.id === "model")?.value).toBe("smart");
    ext.close();
  });

  it("reads and edits cells through the MCP tools", async () => {
    const { nb, ext, chatId } = await setup([
      { type: "markdown", source: "# Title" },
      { type: "code", source: "x = 1\nprint(x)" },
    ]);
    const text = await turn(
      ext,
      chatId,
      script([
        { tool: "list_cells", args: {} },
        { tool: "edit_cell", args: { cell_id: "c2", old_text: "x = 1", new_text: "x = 2" } },
        { tool: "insert_cell", args: { cell_type: "markdown", source: "## Notes", after_cell_id: "c1" } },
        { tool: "read_cells", args: { cell_ids: ["c2"] } },
      ]),
    );
    expect(text).toContain("RESULT list_cells: [0] c1 markdown");
    expect(text).toContain("RESULT edit_cell: Updated cell c2.");
    expect(nb.cells.map((c) => c.source)).toEqual(["# Title", "## Notes", "x = 2\nprint(x)"]);
    expect(text).toContain("### cell [2] id=c2 code");
    const tools = ext.parts().filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool");
    expect(tools.every((t) => t.notebook && t.status === "completed")).toBe(true);
    // The bridge records which notebook tool each agent call reached.
    expect(tools.map((t) => t.notebookCalls)).toEqual([["list_cells"], ["edit_cell"], ["insert_cell"], ["read_cells"]]);
    ext.close();
  });

  it("reports bad edits and invalid arguments as tool errors", async () => {
    const { ext, chatId } = await setup([{ type: "code", source: "a = 1\na = 1" }]);
    const text = await turn(
      ext,
      chatId,
      script([
        { tool: "edit_cell", args: { cell_id: "c1", old_text: "zzz", new_text: "y" } },
        { tool: "edit_cell", args: { cell_id: "c1", old_text: "a = 1", new_text: "b" } },
        { tool: "update_cell", args: { cell_id: "c1" } },
        { tool: "read_cells", args: { cell_ids: ["nope"] } },
      ]),
    );
    expect(text).toContain("RESULT edit_cell (error): old_text was not found");
    expect(text).toContain("matches 2 places");
    expect(text).toContain("RESULT update_cell (error): Invalid arguments");
    expect(text).toContain("RESULT read_cells: No matching cells.");
    ext.close();
  });
});

describe("context compaction", () => {
  it("sends the playbook and the full outline again after the agent compacts its context", async () => {
    const { ext, chatId } = await setup([{ type: "code", source: "import pandas as pd" }]);
    expect(await turn(ext, chatId, "first")).toContain("[saw playbook]");
    let text = await turn(ext, chatId, `ECHO_CONTEXT ${script([{ compact: true }])}`);
    expect(text).not.toContain("not supported");
    expect(text).toContain("unchanged since your previous message");
    const notices = [...ext.messages.values()].flatMap((m) => m.parts).filter((p) => p.type === "notice").map((p) => (p as { text: string }).text);
    expect(notices).toContain("Fake Agent compacted its context. The notebook rules go with your next message again.");
    const before = (text.match(/\[saw playbook\]/g) ?? []).length;
    text = await turn(ext, chatId, "ECHO_CONTEXT after");
    expect((text.match(/\[saw playbook\]/g) ?? []).length).toBe(before + 1);
    expect(text).toContain("[0] c1 code: import pandas as pd");
    // Only once: the turn after is back to normal.
    text = await turn(ext, chatId, "later");
    expect((text.match(/\[saw playbook\]/g) ?? []).length).toBe(before + 1);
    ext.close();
  });
});

describe("agent management over the extension link", () => {
  it("adds, tests, edits and removes a launch command without reconnecting", async () => {
    const ext = new FakeExtension(new FakeNotebook([]), nextTab++);
    await ext.connect(port, TOKEN);
    try {
      const launchCommand = formatLaunchCommand(process.execPath, [FAKE_AGENT]);
      const added = await ext.request<{ agent: AgentInfo }>("agents.save", { name: "Custom ACP", launchCommand });
      expect(added.agent).toMatchObject({ name: "Custom ACP", available: true, builtin: false });
      const tested = await ext.request<{ options: unknown[] }>("agents.test", { launchCommand });
      expect(tested.options).not.toHaveLength(0);
      await ext.request("agents.save", { id: added.agent.id, name: "Renamed ACP", launchCommand });
      const listed = await ext.request<{ agents: AgentInfo[] }>("agents.list", {});
      expect(listed.agents.find((a) => a.id === added.agent.id)?.name).toBe("Renamed ACP");
      expect(await ext.request("agents.remove", { id: added.agent.id })).toEqual({ removed: true });
      expect((await ext.request<{ agents: AgentInfo[] }>("agents.list", {})).agents.some((a) => a.id === added.agent.id)).toBe(false);
    } finally { ext.close(); }
  });
});

describe("modes", () => {
  it("'cell' scope edits only the target cell", async () => {
    const { nb, ext, chatId } = await setup(
      [
        { type: "code", source: "a = 1" },
        { type: "code", source: "b = 2" },
      ],
      { scope: "cell" },
    );
    // No explicit target: the active cell (c1) is the target.
    const text = await turn(
      ext,
      chatId,
      script([
        { tool: "update_cell", args: { cell_id: "c2", source: "b = 3" } },
        { tool: "update_cell", args: { cell_id: "c1", source: "a = 10" } },
        { tool: "insert_cell", args: { cell_type: "code", source: "c = 3" } },
        { tool: "run_cells", args: { cell_ids: ["c1"] } },
      ]),
    );
    expect(text).toContain("RESULT update_cell (error): Mode is 'Edit cell': only cell(s) c1 may be edited.");
    expect(text).toContain("RESULT update_cell: Updated cell c1.");
    expect(text).toMatch(/RESULT insert_cell \(error\): Mode is 'Edit cell'/);
    expect(text).toMatch(/RESULT run_cells \(error\): Mode is 'Edit cell': running cells is not allowed/);
    expect(nb.cells.map((c) => c.source)).toEqual(["a = 10", "b = 2"]);
    expect(nb.ran).toEqual([]);

    // Explicit targets win over the active cell; the change applies to the next call.
    await ext.request("chat.settings", { chatId, settings: { scope: "cell", review: false, targetCellIds: ["c2"] } });
    await turn(ext, chatId, script([{ tool: "update_cell", args: { cell_id: "c2", source: "b = 20" } }]));
    expect(nb.cells[1]!.source).toBe("b = 20");
    ext.close();
  });

  it("'write' scope writes freely but never runs", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "a = 1" }], { scope: "write" });
    const text = await turn(
      ext,
      chatId,
      script([
        { tool: "insert_cell", args: { cell_type: "code", source: "print(a)" } },
        { tool: "delete_cell", args: { cell_id: "c1" } },
        { tool: "run_all", args: {} },
      ]),
    );
    expect(text).toContain("RESULT insert_cell: Inserted code cell c2 at index 1.");
    expect(text).toContain("RESULT delete_cell: Deleted cell c1.");
    expect(text).toMatch(/RESULT run_all \(error\): Mode is 'Write': running cells is not allowed/);
    expect(nb.cells.map((c) => c.source)).toEqual(["print(a)"]);
    expect(nb.ran).toEqual([]);
    ext.close();
  });

  it("'auto' scope runs cells and stops at the first error", async () => {
    const { nb, ext, chatId } = await setup(
      [
        { type: "code", source: "a = 1" },
        { type: "markdown", source: "text" },
        { type: "code", source: "raise ValueError('boom')" },
        { type: "code", source: "b = 2" },
      ],
      { scope: "auto" },
    );
    const text = await turn(ext, chatId, script([{ tool: "run_all", args: {} }]));
    expect(nb.ran).toEqual(["c1", "c3"]);
    expect(text).toContain("cell c1: ok (exec 1)\nran a = 1");
    expect(text).toContain("RESULT run_all (error): ");
    expect(text).toContain("[error] ValueError: boom");
    ext.close();
  });
});

describe("review", () => {
  it("applies accepted changes and reports rejected ones", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "x = 1" }], { review: true });
    ext.autoReview = true;
    let text = await turn(ext, chatId, script([{ tool: "update_cell", args: { cell_id: "c1", source: "x = 2" } }]));
    expect(text).toContain("RESULT update_cell: Change to cell c1: the user accepted the change");
    expect(nb.cells[0]!.source).toBe("x = 2");

    ext.autoReview = false;
    text = await turn(ext, chatId, script([{ tool: "insert_cell", args: { cell_type: "code", source: "y = 1" } }]));
    expect(text).toContain("the user REJECTED the change");
    expect(nb.cells).toHaveLength(1);

    const reviews = ext.parts().filter((p): p is Extract<Part, { type: "review" }> => p.type === "review");
    expect(reviews.map((r) => [r.review.kind, r.status])).toEqual([
      ["update", "accepted"],
      ["insert", "rejected"],
    ]);
    ext.close();
  });

  it("returns 'still pending' after the agent's wait budget, then await_review sees the decision", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "x = 1" }], { review: true });
    // The fake agent's budget is 3s; nobody answers in time.
    const before = ext.statuses.length;
    await ext.request("chat.send", {
      chatId,
      text: script([
        { tool: "update_cell", args: { cell_id: "c1", source: "x = 5" } },
        { say: "WAITING" },
        { tool: "await_review", args: { review_id: "__ID__" } },
      ]).replace("__ID__", "placeholder"),
    });
    await ext.waitFor(() => ext.agentText().includes("WAITING"), 20_000, "pending result");
    expect(ext.agentText()).toContain("still awaiting review");
    const review = ext.parts().find((p): p is Extract<Part, { type: "review" }> => p.type === "review")!;
    expect(review.status).toBe("pending");
    // Nothing is applied while the review waits.
    expect(nb.cells[0]!.source).toBe("x = 1");
    await ext.waitFor(() => ext.statuses.slice(before).includes("idle"), 20_000, "turn end");

    // The user decides from the side panel; the page applies it.
    const res = await ext.request<{ resolved: boolean }>("chat.review", { chatId, reviewId: review.review.reviewId, accept: true });
    expect(res.resolved).toBe(true);
    expect(nb.cells[0]!.source).toBe("x = 5");
    const text = await turn(ext, chatId, script([{ tool: "await_review", args: { review_id: review.review.reviewId } }]));
    expect(text).toContain(`Review ${review.review.reviewId}: the user accepted the change`);
    await ext.waitFor(
      () => ext.parts().some((p) => p.type === "review" && p.status === "accepted"),
      5_000,
      "review part update",
    );
    ext.close();
  });

  it("expires a run approval through MCP and refuses a late answer", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "a = 1" }], { scope: "auto", review: true });
    try {
      const text = await turn(ext, chatId, script([{ tool: "run_cells", args: { cell_ids: ["c1"] } }]));
      expect(text).toContain("RESULT run_cells (error): run_cells failed: Run approval expired");
      const prompt = ext.parts().find((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt")!;
      expect(prompt.answer).toBe("expired");
      expect(await ext.request("chat.answer", { chatId, promptId: prompt.promptId, optionId: "run" })).toEqual({ answered: false });
      expect(nb.ran).toEqual([]);
    } finally {
      ext.close();
    }
  });

  it("asks before running in autonomous review mode", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "a = 1" }], { scope: "auto", review: true });
    const before = ext.statuses.length;
    await ext.request("chat.send", {
      chatId,
      text: script([
        { tool: "run_cells", args: { cell_ids: ["c1"] } },
        { tool: "run_cells", args: { cell_ids: ["c1"] } },
      ]),
    });
    const prompts = () => ext.parts().filter((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt");
    await ext.waitFor(() => prompts().length === 1, 20_000, "run prompt");
    const first = prompts()[0]!.promptId;
    expect(await ext.request("chat.answer", { chatId, promptId: first, optionId: "skip" })).toEqual({ answered: true });
    // Answering twice is a no-op.
    expect(await ext.request("chat.answer", { chatId, promptId: first, optionId: "run" })).toEqual({ answered: false });
    await ext.waitFor(() => prompts().length === 2, 20_000, "second run prompt");
    await ext.request("chat.answer", { chatId, promptId: prompts()[1]!.promptId, optionId: "run" });
    await ext.waitFor(() => ext.statuses.slice(before).includes("idle"), 20_000, "turn end");
    const text = ext.agentText();
    expect(text).toContain("The user declined to run these cells");
    expect(text).toContain("cell c1: ok");
    expect(nb.ran).toEqual(["c1"]);
    ext.close();
  });
});

describe("chats follow the notebook", () => {
  async function openKeyed(target: Bridge, targetPort: number, key: string, cells: { type: "code" | "markdown"; source: string }[] = []) {
    const nb = new FakeNotebook(cells);
    const ext = new FakeExtension(nb, nextTab++);
    await ext.connect(targetPort, TOKEN);
    const snap = await ext.request<ChatSnapshot>("chat.open", {
      tabId: ext.tabId,
      agentId: "fake",
      settings: { scope: "write", review: false, targetCellIds: [] },
      platform: "colab",
      notebookKey: key,
    });
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
    return { nb, ext, snap };
  }

  it("saves the conversation and restores it after the bridge restarts", async () => {
    const key = `colab:/drive/restore-${Date.now()}`;
    const { ext, snap } = await openKeyed(bridge, port, key);
    await turn(ext, snap.chatId, "remember the word MANGO");
    // Saved shortly after it changes, without waiting for the chat to close.
    const file = join(process.env.AINB_HOME!, "chats", `${keyHash(key)}.json`);
    await ext.waitFor(() => existsSync(file), 5_000, "transcript saved");
    ext.close();

    const second = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, log: () => {} });
    const secondPort = await second.listen();
    try {
      const { ext: ext2, snap: restored } = await openKeyed(second, secondPort, key);
      expect(restored.chatId).not.toBe(snap.chatId);
      expect(JSON.stringify(restored.messages)).toContain("remember the word MANGO");
      expect(restored.messages.at(-1)?.role).toBe("system");
      const text = await turn(ext2, restored.chatId, "what was the word");
      expect(text).toContain("[saw recap]");
      ext2.close();
    } finally {
      await second.close();
    }
  });

  it("starts over on New chat, forgetting the saved conversation", async () => {
    const key = `colab:/drive/forget-${Date.now()}`;
    const { ext, snap } = await openKeyed(bridge, port, key);
    await turn(ext, snap.chatId, "something to forget");
    await ext.request("chat.close", { chatId: snap.chatId });
    const fresh = await ext.request<ChatSnapshot>("chat.open", {
      tabId: ext.tabId,
      agentId: "fake",
      settings: { scope: "write", review: false, targetCellIds: [] },
      platform: "colab",
      notebookKey: key,
    });
    expect(fresh.messages).toEqual([]);
    expect(existsSync(join(process.env.AINB_HOME!, "chats", `${keyHash(key)}.json`))).toBe(false);
    ext.close();
  });

  it("closes the chat when another notebook fills the tab", async () => {
    const key = `colab:/drive/first-${Date.now()}`;
    const { nb, ext, snap } = await openKeyed(bridge, port, key, [{ type: "code", source: "a = 1" }]);
    await turn(ext, snap.chatId, "about the first notebook");
    // Same notebook announced again (reload): the chat stays.
    ext.rpc.emit("notebook.attached", { tabId: ext.tabId, info: { ...nb.info(), key } });
    await new Promise((r) => setTimeout(r, 200));
    expect((await ext.request<ChatSnapshot>("chat.get", { tabId: ext.tabId }))?.status).toBe("idle");

    ext.rpc.emit("notebook.attached", { tabId: ext.tabId, info: { ...nb.info(), key: "colab:/drive/second" } });
    await ext.waitFor(() => ext.snapshots.some((s) => s.chatId === snap.chatId && s.status === "closed"), 5_000, "old chat closed");
    await expect(ext.request("chat.send", { chatId: snap.chatId, text: "hi" })).rejects.toThrow(/no longer exists/);
    const other = await ext.request<ChatSnapshot>("chat.open", {
      tabId: ext.tabId,
      agentId: "fake",
      settings: { scope: "write", review: false, targetCellIds: [] },
      platform: "colab",
      notebookKey: "colab:/drive/second",
    });
    expect(JSON.stringify(other.messages)).not.toContain("about the first notebook");
    ext.close();
  });

  it("discards a pending review when the page goes away", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "x = 1" }], { review: true });
    const before = ext.statuses.length;
    await ext.request("chat.send", { chatId, text: script([{ tool: "update_cell", args: { cell_id: "c1", source: "x = 9" } }]) });
    await ext.waitFor(() => ext.parts().some((p) => p.type === "review"), 20_000, "review opened");
    ext.rpc.emit("notebook.detached", { tabId: ext.tabId });
    await ext.waitFor(() => ext.statuses.slice(before).includes("idle"), 20_000, "turn end");
    expect(ext.agentText()).toContain("RESULT update_cell (error): Change to cell c1: the notebook page reloaded or navigated away");
    const review = ext.parts().find((p): p is Extract<Part, { type: "review" }> => p.type === "review")!;
    expect(review.status).toBe("discarded");
    expect(nb.cells[0]!.source).toBe("x = 1");
    ext.close();
  });

  it("keeps a read of a large notebook within budget and says how to get the rest", async () => {
    const big = "y = 0\n".repeat(1500); // ~9k characters per cell
    const { ext, chatId } = await setup([
      { type: "code", source: "z".repeat(50_000) },
      ...Array.from({ length: 12 }, () => ({ type: "code" as const, source: big })),
    ]);
    const text = await turn(ext, chatId, script([{ tool: "read_cells", args: {} }]));
    expect(text).toContain("shown shortened");
    expect(text).toMatch(/more cells not shown to keep this short \(\[\d+\]\.\.\[12\]\)\. Ask for them with read_cells using start_index=\d+/);
    expect(text.length).toBeLessThan(80_000);
    ext.close();
  });
});

describe("plots and notebook-only mode", () => {
  it("attaches plot images to run and read results", async () => {
    const { ext, chatId } = await setup([{ type: "code", source: "plot(x)" }], { scope: "auto" });
    let text = await turn(ext, chatId, script([{ tool: "run_cells", args: { cell_ids: ["c1"] } }]));
    expect(text).toContain("<Figure size 640x480>\n[image/png output: image 1 attached to this result]");
    expect(text).toContain(`IMAGES 1 image/png:${TINY_PNG.length}`);
    text = await turn(ext, chatId, script([{ tool: "read_cells", args: { cell_ids: ["c1"], include_images: false } }]));
    expect(text).toContain("[image/png output not shown]");
    expect(text.match(/IMAGES /g)).toHaveLength(1);
    ext.close();
  });

  it("caps images per result and keeps them away from agents that cannot read them", async () => {
    const { ext, chatId } = await setup(Array.from({ length: 6 }, (_, i) => ({ type: "code" as const, source: `plot(${i})` })), { scope: "auto" });
    const text = await turn(ext, chatId, script([{ tool: "run_all", args: {} }]));
    expect(text).toContain("IMAGES 4 ");
    expect(text).toContain("this result already carries 4 images; read this cell on its own to see it");
    ext.close();

    const nb = new FakeNotebook([{ type: "code", source: "plot(1)" }]);
    const ext2 = new FakeExtension(nb, nextTab++);
    await ext2.connect(port, TOKEN);
    const snap = await ext2.request<ChatSnapshot>("chat.open", {
      tabId: ext2.tabId,
      agentId: "fake2", // images: false in agents.json, overriding what it declares
      settings: { scope: "auto", review: false, targetCellIds: [] },
      platform: "colab",
    });
    await ext2.waitFor(() => ext2.statuses.includes("idle"), 30_000, "agent start");
    const text2 = await turn(ext2, snap.chatId, script([{ tool: "run_cells", args: { cell_ids: ["c1"] } }]));
    expect(text2).toContain("[image/png output not shown]");
    expect(text2).not.toContain("IMAGES");
    ext2.close();
  });

  it("refuses the agent's own tools in notebook-only mode but still asks about notebook tools", async () => {
    const { ext, chatId } = await setup([]); // notebookOnly defaults to on
    let text = await turn(ext, chatId, script([{ permission: "Run shell: rm -rf ~" }]));
    expect(text).toContain("PERMISSION: deny");
    expect(ext.parts().some((p) => p.type === "notice" && p.text.includes('Refused "Run shell: rm -rf ~": Notebook only is on'))).toBe(true);
    expect(ext.parts().some((p) => p.type === "prompt")).toBe(false);
    text = await turn(ext, chatId, "ECHO_CONTEXT hi");
    expect(text).toContain("Notebook only: requests to use your own tools");

    const before = ext.statuses.length;
    await ext.request("chat.send", { chatId, text: script([{ permission: "mcp__notebook__update_cell" }]) });
    const prompt = () => ext.parts().find((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt");
    await ext.waitFor(() => !!prompt(), 20_000, "notebook tool prompt");
    await ext.request("chat.answer", { chatId, promptId: prompt()!.promptId, optionId: "allow" });
    await ext.waitFor(() => ext.statuses.slice(before).includes("idle"), 20_000, "turn end");
    expect(ext.agentText()).toContain("PERMISSION: allow");
    ext.close();
  });
});

describe("undo", () => {
  /** The agent message that recorded notebook changes, newest first. */
  const changedMessage = (ext: FakeExtension) => [...ext.messages.values()].filter((m) => m.role === "agent" && m.changes?.count).at(-1)!;

  it("reverts a turn's changes newest first, and tells the agent next turn", async () => {
    const { nb, ext, chatId } = await setup([
      { type: "code", source: "x = 1" },
      { type: "code", source: "y = 2" },
      { type: "markdown", source: "# notes" },
    ]);
    await turn(
      ext,
      chatId,
      script([
        { tool: "update_cell", args: { cell_id: "c1", source: "x = 10" }, quiet: true },
        { tool: "insert_cell", args: { cell_type: "code", source: "new = True", after_cell_id: "c1" }, quiet: true },
        { tool: "update_cell", args: { cell_id: "c3", source: "# edited notes" }, quiet: true },
        { tool: "delete_cell", args: { cell_id: "c3" }, quiet: true },
        { tool: "move_cell", args: { cell_id: "c2", index: 0 }, quiet: true },
        { tool: "update_cell", args: { cell_id: "c1", source: "x = 11" }, quiet: true },
      ]),
    );
    expect(nb.cells.map((c) => c.source)).toEqual(["y = 2", "x = 11", "new = True"]);
    const msg = changedMessage(ext);
    expect(msg.changes).toEqual({ count: 6 });

    const res = await ext.request<{ undone: number; skipped: string[] }>("chat.undo", { chatId, messageId: msg.id });
    expect(res).toEqual({ undone: 6, skipped: [] });
    // Same sources, same order; the deleted cell is back (with a new id).
    expect(nb.cells.map((c) => c.source)).toEqual(["x = 1", "y = 2", "# notes"]);
    expect(nb.cells.map((c) => c.type)).toEqual(["code", "code", "markdown"]);
    await ext.waitFor(() => !!changedMessage(ext).changes?.undone, 5_000, "undone flag");
    expect(ext.parts().some((p) => p.type === "notice" && p.text === "Undid 6 changes.")).toBe(true);
    // Undo is not journaled itself, and cannot run twice.
    expect(changedMessage(ext).changes).toEqual({ count: 6, undone: true });
    await expect(ext.request("chat.undo", { chatId, messageId: msg.id })).rejects.toThrow(/already undone/);

    const text = await turn(ext, chatId, "what now");
    expect(text).toContain("[saw undo note]");
    expect((await turn(ext, chatId, "and now")).match(/\[saw undo note\]/g)).toHaveLength(1);
    ext.close();
  });

  it("never overwrites a cell the user edited since", async () => {
    const { nb, ext, chatId } = await setup([{ type: "code", source: "a = 1" }]);
    await turn(
      ext,
      chatId,
      script([
        { tool: "update_cell", args: { cell_id: "c1", source: "a = 2" }, quiet: true },
        { tool: "insert_cell", args: { cell_type: "code", source: "b = 1" }, quiet: true },
      ]),
    );
    nb.cells[0]!.source = "a = 2  # my edit";
    const res = await ext.request<{ undone: number; skipped: string[] }>("chat.undo", { chatId, messageId: changedMessage(ext).id });
    expect(res.undone).toBe(1);
    expect(res.skipped).toEqual(["change to cell c1: edited since, so it was kept"]);
    expect(nb.cells.map((c) => c.source)).toEqual(["a = 2  # my edit"]);
    ext.close();
  });

  it("undoes accepted reviews, and still can after the chat is restored", async () => {
    const key = `colab:/drive/undo-${Date.now()}`;
    const nb = new FakeNotebook([{ type: "code", source: "v = 1" }]);
    const ext = new FakeExtension(nb, nextTab++);
    await ext.connect(port, TOKEN);
    const open = () =>
      ext.request<ChatSnapshot>("chat.open", {
        tabId: ext.tabId,
        agentId: "fake",
        settings: { scope: "write", review: true, targetCellIds: [] },
        platform: "colab",
        notebookKey: key,
      });
    const snap = await open();
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
    ext.autoReview = true;
    await turn(ext, snap.chatId, script([{ tool: "update_cell", args: { cell_id: "c1", source: "v = 2" } }]));
    expect(nb.cells[0]!.source).toBe("v = 2");

    // Close the tab's chat (saved), then open it again: the journal comes back too.
    await ext.request("tab.closed", { tabId: ext.tabId });
    const restored = await open();
    const msg = restored.messages.filter((m) => m.changes?.count).at(-1)!;
    expect(msg.changes).toEqual({ count: 1 });
    const res = await ext.request<{ undone: number }>("chat.undo", { chatId: restored.chatId, messageId: msg.id });
    expect(res.undone).toBe(1);
    expect(nb.cells[0]!.source).toBe("v = 1");
    ext.close();
  });
});

describe("agent lifecycle", () => {
  it("relays the agent's own permission requests", async () => {
    const { ext, chatId } = await setup([], { notebookOnly: false });
    const before = ext.statuses.length;
    await ext.request("chat.send", { chatId, text: script([{ permission: "Run shell: ls" }]) });
    const prompt = () => ext.parts().find((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt");
    await ext.waitFor(() => !!prompt(), 20_000, "permission prompt");
    expect(prompt()!.title).toBe("Run shell: ls");
    expect(prompt()!.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    await ext.request("chat.answer", { chatId, promptId: prompt()!.promptId, optionId: "deny" });
    await ext.waitFor(() => ext.statuses.slice(before).includes("idle"), 20_000, "turn end");
    expect(ext.agentText()).toContain("PERMISSION: deny");
    ext.close();
  });

  it("stops a turn, queues messages sent while busy, and denies prompts on stop", async () => {
    const { ext, chatId } = await setup([]);
    await ext.request("chat.send", { chatId, text: script([{ say: "start" }, { sleep: 10_000 }, { say: "never" }]) });
    await ext.request("chat.send", { chatId, text: "queued one" });
    await ext.waitFor(() => ext.agentText().includes("start"), 20_000, "turn start");
    await ext.request("chat.cancel", { chatId });
    await ext.waitFor(() => ext.agentText().includes("Stopped."), 20_000, "stop");
    expect(ext.agentText()).not.toContain("never");
    // Stop clears the queue.
    await new Promise((r) => setTimeout(r, 300));
    expect(ext.agentText()).not.toContain("echo: queued one");

    await ext.request("chat.send", { chatId, text: script([{ sleep: 300 }, { say: "first" }]) });
    await ext.request("chat.send", { chatId, text: "second" });
    await ext.waitFor(() => ext.agentText().includes("echo: second"), 20_000, "queued turn");
    expect(ext.agentText().indexOf("first")).toBeLessThan(ext.agentText().indexOf("echo: second"));
    ext.close();
  });

  it("restarts a crashed agent with a recap, and hands the transcript to a new agent on switch", async () => {
    const { ext, chatId } = await setup([]);
    await turn(ext, chatId, "remember the word PINEAPPLE");
    await turn(ext, chatId, "CRASH");
    await ext.waitFor(() => ext.statuses.at(-1) === "error", 20_000, "crash");
    let text = await turn(ext, chatId, "are you back");
    expect(text).toContain("[saw recap]");
    expect(text).toContain("echo: are you back");

    const snap = await ext.request<ChatSnapshot>("chat.open", { tabId: ext.tabId, agentId: "fake2", settings: { scope: "write", review: false, targetCellIds: [] }, platform: "colab" });
    expect(snap.agentId).toBe("fake2");
    expect(snap.messages.some((m) => m.role === "system")).toBe(true);
    await ext.waitFor(() => ext.statuses.at(-1) === "idle", 30_000, "second agent");
    text = await turn(ext, snap.chatId, "hello new agent");
    expect(text).toContain("[saw recap]");
    await expect(ext.request("chat.send", { chatId, text: "old chat" })).rejects.toThrow(/no longer exists/);
    ext.close();
  });

  it("keeps chats across an extension reconnect and reports a missing notebook as a tool error", async () => {
    const { ext, chatId } = await setup([{ type: "code", source: "a" }]);
    // The service worker restarts: a new connection replaces the old one.
    const again = new FakeExtension(new FakeNotebook([]), 999);
    await again.connect(port, TOKEN);
    await ext.waitFor(() => ext.ws.readyState === ext.ws.CLOSED, 5_000, "old socket closed");
    const snap = await again.request<ChatSnapshot | null>("chat.get", { tabId: ext.tabId });
    expect(snap?.chatId).toBe(chatId);
    // The reconnected extension has no notebook in that tab any more.
    const before = again.statuses.length;
    await again.request("chat.send", { chatId, text: script([{ tool: "list_cells", args: {} }]) });
    await again.waitFor(() => again.statuses.slice(before).includes("idle"), 20_000, "turn end");
    expect(again.agentText()).toContain("RESULT list_cells (error): list_cells failed: no notebook in that tab");
    again.close();
  });
});
