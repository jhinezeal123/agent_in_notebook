// End-to-end through the real bridge: fake extension (WebSocket) -> bridge ->
// scripted ACP agent (child process) -> `ainb mcp` relay (child process of the
// agent) -> bridge -> fake extension's notebook.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSettings, ChatSnapshot, Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";

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
      { id: "fake2", name: "Fake Agent 2", command: process.execPath, args: [FAKE_AGENT] },
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

describe("agent lifecycle", () => {
  it("relays the agent's own permission requests", async () => {
    const { ext, chatId } = await setup([]);
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
