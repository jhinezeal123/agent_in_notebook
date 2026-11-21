import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { applyMessagePatch, type CellInfo, type CellRun, type ChatMessage, type ChatSettings, type MessagePatch, type Part } from "@ainb/protocol";
import { Chat, type ChatHost, type ChatProjectHost } from "../src/chat.js";
import type { CodePlace } from "../src/project/vmrepo.js";

const agent = vi.hoisted(() => ({
  running: true, sessionId: "test-session", start: vi.fn(), prompt: vi.fn(),
  cancel: vi.fn(), dispose: vi.fn(), options: () => [],
}));

vi.mock("../src/agents/acp-agent.js", () => ({
  AcpAgent: vi.fn(function () { return agent; }),
  AgentStartError: class extends Error {},
}));

const projectTools = vi.hoisted(() => ({ saveNotebook: vi.fn() }));
vi.mock("../src/project/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/project/tools.js")>()),
  saveNotebook: projectTools.saveNotebook,
}));

const workspaceRoot = mkdtempSync(join(tmpdir(), "ainb-chat-test-"));
const chats: Chat[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  agent.start.mockResolvedValue({});
  agent.prompt.mockResolvedValue({ stopReason: "end_turn" });
  agent.cancel.mockResolvedValue(undefined);
  projectTools.saveNotebook.mockReset();
  projectTools.saveNotebook.mockResolvedValue({ path: "artifacts/notebooks/test.ipynb", cells: 2, bytes: 10, project: { id: "p", name: "Project" } });
});

afterEach(() => {
  for (const chat of chats.splice(0)) chat.close();
  vi.useRealTimers();
});

afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(settings: Partial<ChatSettings> = {}, notebookKey?: string) {
  const info = { platform: "jupyter", title: "test", url: "test", cellCount: 1, activeCellId: "a", selectedCellIds: ["a"], kernel: "idle", language: "python" };
  const cell: CellInfo = { id: "a", index: 0, type: "code", source: "x = 1", executionCount: null, outputs: [] };
  const notebookOp = vi.fn<ChatHost["notebookOp"]>().mockImplementation(async (_tab, raw) => {
    const op = raw as { op: string };
    if (op.op === "info") return info;
    if (op.op === "get_cells") return { cells: [cell] };
    return { results: [{ cellId: "a", status: "ok", outputs: [] }] };
  });
  const emit = vi.fn();
  const chat = new Chat(1, {
    id: "fake", name: "Fake", builtin: false, toolWaitMs: 50, loginHint: "",
    resolve: () => ({ launch: { command: "fake", args: [] } }),
  }, { scope: "auto", review: true, targetCellIds: [], notebookOnly: true, ...settings }, {
    notebookOp, emit, mcpServer: () => ({ name: "notebook", command: "fake", args: [], env: [] }), workspaceRoot,
  }, { notebookKey });
  chats.push(chat);
  return { chat, notebookOp, info, cell, emit };
}

function prompts(chat: Chat) {
  return chat.snapshot().messages.flatMap((m) => m.parts).filter((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt");
}

function cards(chat: Chat) {
  return chat.messages.flatMap((m) => m.parts).filter((p): p is Extract<Part, { type: "card" }> => p.type === "card").map((p) => p.card);
}

function emitRun(chat: Chat, over: Partial<CellRun> = {}) {
  const run: CellRun = {
    cellId: "a", index: 0, status: "error", executionCount: 1, by: "user",
    durationMs: 8_000, head: "x = 1", ename: "ValueError", evalue: "boom", ...over,
  };
  chat.onNotebookEvent({ type: "cell_run", run });
  return run;
}

function withProject(chat: Chat) {
  const host = (chat as unknown as { host: ChatHost }).host;
  const cache = { id: "p", name: "Project", repoPath: "/tmp/repo", githubUrl: null, artifactsDir: "/tmp/artifacts" };
  host.project = {
    links: { markDirty: vi.fn() } as unknown as ChatProjectHost["links"],
    research: {} as ChatProjectHost["research"],
    resolve: async () => ({ orx: undefined, project: { id: "p", name: "Project", state: "ready" } }),
    cached: () => cache,
  };
  return cache;
}

describe("Stop before a prompt is sent", () => {
  it("does not send a prompt after Stop during agent startup", async () => {
    const started = deferred<void>();
    agent.start.mockReturnValue(started.promise);
    const { chat, notebookOp } = setup();
    chat.send("do not run this");
    expect(await chat.cancel()).toBe(true);
    started.resolve();
    await vi.waitFor(() => expect(chat.status).toBe("idle"));
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(notebookOp).not.toHaveBeenCalled();
  });

  it("does not send a prompt after Stop during notebook context loading, and accepts a later turn", async () => {
    const context = deferred<unknown>();
    const { chat, notebookOp, info } = setup();
    notebookOp.mockImplementationOnce(() => context.promise);
    chat.send("cancel this turn");
    await vi.waitFor(() => expect(notebookOp).toHaveBeenCalled());
    chat.send("clear this queued turn too");
    expect(await chat.cancel()).toBe(true);
    context.resolve(info);
    await vi.waitFor(() => expect(chat.status).toBe("idle"));
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(chat.snapshot().messages.flatMap((m) => m.parts)).toContainEqual({ type: "notice", level: "info", text: "Stopped." });

    chat.send("next turn");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    expect(agent.prompt.mock.calls[0]![0]).toContain("next turn");
  });

  it("keeps a closed chat closed after context loading finishes", async () => {
    const context = deferred<unknown>();
    const { chat, notebookOp, info } = setup();
    notebookOp.mockImplementationOnce(() => context.promise);
    chat.send("close this turn");
    await vi.waitFor(() => expect(notebookOp).toHaveBeenCalled());
    chat.close();
    context.resolve(info);
    await new Promise((r) => setTimeout(r, 0));
    expect(chat.status).toBe("closed");
    expect(agent.prompt).not.toHaveBeenCalled();
  });
});

describe("Run approval deadlines", () => {
  it.each(["run_cells", "run_all"])("expires %s approval and refuses a late Run answer", async (name) => {
    vi.useFakeTimers();
    const { chat, notebookOp } = setup();
    const result = chat.runTool(name, name === "run_cells" ? { cell_ids: ["a"] } : {});
    await vi.advanceTimersByTimeAsync(0);
    const prompt = prompts(chat)[0]!;
    expect(prompt.answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ isError: true, text: expect.stringContaining("Run approval expired") });
    expect(prompt.answer).toBe("expired");
    expect(chat.answer(prompt.promptId, "run")).toBe(false);
    expect(notebookOp.mock.calls.some(([, op]) => (op as { op: string }).op === "run_cells")).toBe(false);
  });

  it("uses only the remaining tool budget for execution after approval", async () => {
    vi.useFakeTimers();
    const { chat, notebookOp } = setup();
    const result = chat.runTool("run_cells", { cell_ids: ["a"] });
    await vi.advanceTimersByTimeAsync(40);
    expect(chat.answer(prompts(chat)[0]!.promptId, "run")).toBe(true);
    expect(await result).toMatchObject({ text: "cell a: ok" });
    expect(notebookOp).toHaveBeenCalledWith(1, expect.objectContaining({ op: "run_cells", timeoutMs: 10 }), 15_010);
    await vi.advanceTimersByTimeAsync(100);
    expect(prompts(chat)[0]!.answer).toBe("run");
  });
});

describe("Attached cells", () => {
  it("shows the attached cells, as they are now and with outputs, before the notebook context", async () => {
    const { chat, cell, notebookOp } = setup();
    cell.source = "df = load()\ndf.head()";
    cell.outputs = [{ kind: "error", ename: "KeyError", evalue: "'price'", traceback: "KeyError: 'price'" }];
    chat.send("why does this fail?", { cells: [{ cellId: "a", index: 0, label: "df = load()" }] });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    const prompt = agent.prompt.mock.calls[0]![0] as string;
    expect(notebookOp).toHaveBeenCalledWith(1, expect.objectContaining({ op: "get_cells", cellIds: ["a"], includeOutputs: true }), expect.any(Number));
    expect(prompt).toContain("<attached-cells>");
    expect(prompt).toContain("### cell [0] id=a code");
    expect(prompt).toContain("df.head()");
    expect(prompt).toContain("KeyError: 'price'");
    expect(prompt.indexOf("<attached-cells>")).toBeLessThan(prompt.lastIndexOf("<notebook-context>"));
    expect(prompt.trimEnd().endsWith("why does this fail?")).toBe(true);
  });

  it("keeps the attached cells on the user's message", () => {
    const { chat } = setup();
    const cells = [{ cellId: "a", index: 0, label: "x = 1" }];
    chat.send("explain", { cells });
    const message = chat.messages.find((m) => m.role === "user")!;
    expect(message.parts).toEqual([{ type: "text", text: "explain" }, { type: "cells", cells }]);
  });

  it("sends no attached-cells block without attachments", async () => {
    const { chat } = setup();
    chat.send("hello");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    expect(agent.prompt.mock.calls[0]![0]).not.toContain("<attached-cells>");
    expect(chat.messages.find((m) => m.role === "user")!.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("makes the attached cells the editable cells in cell scope, over the selection", async () => {
    const { chat, info } = setup({ scope: "cell", review: false });
    info.activeCellId = "other";
    info.selectedCellIds = ["other"];
    chat.send("fix it", { cells: [{ cellId: "a", index: 0, label: "x = 1" }] });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    expect(agent.prompt.mock.calls[0]![0]).toContain("Editable cell(s): a.");
  });

  it("leaves pinned cells editable when others are attached", async () => {
    const { chat } = setup({ scope: "cell", review: false, targetCellIds: ["pinned"] });
    chat.send("look at this", { cells: [{ cellId: "a", index: 0, label: "x = 1" }] });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    expect(agent.prompt.mock.calls[0]![0]).toContain("Editable cell(s): pinned.");
  });

  it("says which attached cells were deleted before the turn", async () => {
    const { chat, notebookOp, info, cell } = setup();
    notebookOp.mockImplementation(async (_tab, raw) => {
      const op = raw as { op: string; cellIds?: string[] };
      if (op.op === "info") return info;
      if (op.op === "get_cells") return { cells: op.cellIds ? [cell].filter((c) => op.cellIds!.includes(c.id)) : [cell] };
      return {};
    });
    chat.send("compare", { cells: [{ cellId: "a", index: 0, label: "x = 1" }, { cellId: "gone", index: 3, label: "y = 2" }] });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    const prompt = agent.prompt.mock.calls[0]![0] as string;
    expect(prompt).toContain("### cell [0] id=a code");
    expect(prompt).toContain("Attached but no longer in the notebook (deleted since): gone.");
  });
});

describe("Cell run cards", () => {
  it("opens a system error card with Fix, Explain and Dismiss while idle", () => {
    const { chat } = setup();
    emitRun(chat);
    const message = chat.messages.at(-1)!;
    expect(message.role).toBe("system");
    expect(cards(chat)).toHaveLength(1);
    expect(cards(chat)[0]).toMatchObject({
      kind: "run", tone: "error", state: "open", cellId: "a",
      title: "Cell [0] failed · ValueError: boom", detail: "x = 1 · 8s",
    });
    expect(cards(chat)[0]!.actions.map((a) => a.id)).toEqual(["fix", "explain", "dismiss"]);
  });

  it("does not open a card for an interrupted run", () => {
    const { chat } = setup();
    emitRun(chat, { status: "interrupted", ename: "KeyboardInterrupt" });
    expect(cards(chat)).toEqual([]);
  });

  it("does not open a card during a turn, but still supersedes the old one", async () => {
    const { chat } = setup();
    emitRun(chat);
    const pending = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(pending.promise);
    chat.send("working");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    emitRun(chat, { executionCount: 2, evalue: "another error" });
    expect(cards(chat)).toHaveLength(1);
    expect(cards(chat)[0]).toMatchObject({ state: "stale", outcome: "Superseded by a later run", actions: [] });
    pending.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(chat.status).toBe("idle"));
  });

  it("supersedes an error card on a later error or successful run of the same cell", () => {
    const { chat } = setup();
    emitRun(chat);
    emitRun(chat, { executionCount: 2, evalue: "again" });
    expect(cards(chat).map((c) => c.state)).toEqual(["stale", "open"]);
    emitRun(chat, { status: "ok", executionCount: 3, ename: undefined, evalue: undefined });
    expect(cards(chat).map((c) => c.state)).toEqual(["stale", "stale"]);
    expect(cards(chat)[1]!.outcome).toBe("Superseded by a later run");
  });

  it("Fix closes the card and sends the cell, traceback and language instruction", async () => {
    const { chat, cell } = setup();
    cell.outputs = [{ kind: "error", ename: "ValueError", evalue: "boom", traceback: "Traceback (most recent call last):\n  File \"train.py\", line 4\nValueError: boom" }];
    emitRun(chat);
    const card = cards(chat)[0]!;
    expect(chat.cardAction(card.cardId, "fix")).toBe(true);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    const prompt = agent.prompt.mock.calls[0]![0] as string;
    expect(prompt).toContain("<cell-run>");
    expect(prompt).toContain("Traceback (most recent call last)");
    expect(prompt).toContain('File "train.py", line 4');
    expect(prompt).toContain("Answer in the language the user has been writing in this chat");
    expect(card).toMatchObject({ state: "done", outcome: "Asked the agent to fix it", actions: [] });
    expect(chat.messages.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "Fix the error in cell [0]"))).toBe(true);
  });

  it("Explain changes nothing and describes an earlier agent-started cell correctly", async () => {
    const { chat } = setup();
    emitRun(chat, { by: "agent" });
    expect(chat.cardAction(cards(chat)[0]!.cardId, "explain")).toBe(true);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    const prompt = agent.prompt.mock.calls[0]![0] as string;
    expect(prompt).toContain("A cell you started earlier");
    expect(prompt).toContain("Explain what went wrong and what would fix it. Change nothing.");
    expect(chat.messages.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "Explain the error in cell [0]"))).toBe(true);
  });

  it("targets the failed cell in cell scope instead of the current selection", async () => {
    const { chat, info, cell } = setup({ scope: "cell", review: false });
    info.activeCellId = "other";
    info.selectedCellIds = ["other"];
    cell.outputs = [{ kind: "error", ename: "ValueError", evalue: "boom", traceback: "ValueError: boom" }];
    emitRun(chat);
    chat.cardAction(cards(chat)[0]!.cardId, "fix");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    expect(agent.prompt.mock.calls[0]![0]).toContain("Editable cell(s): a.");
  });

  it("rejects unknown and closed actions, and Dismiss never calls the agent", async () => {
    const { chat } = setup();
    emitRun(chat);
    const card = cards(chat)[0]!;
    expect(chat.cardAction("missing", "fix")).toBe(false);
    expect(chat.cardAction(card.cardId, "unknown")).toBe(false);
    expect(chat.cardAction(card.cardId, "dismiss")).toBe(true);
    expect(card).toMatchObject({ state: "done", outcome: "Dismissed", actions: [] });
    expect(chat.cardAction(card.cardId, "fix")).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("settles a carried open card because its action handlers stay with the old chat", () => {
    const { chat } = setup();
    emitRun(chat);
    const card = cards(chat)[0]!;
    const host = (chat as unknown as { host: ChatHost }).host;
    const reopened = new Chat(chat.tabId, chat.spec, chat.settings, host, { carried: chat.messages });
    chats.push(reopened);
    expect(cards(reopened)[0]).toMatchObject({ cardId: card.cardId, state: "stale", actions: [] });
    expect(reopened.cardAction(card.cardId, "fix")).toBe(false);
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("does not send or persist a late card action after the chat closes", async () => {
    const { chat, notebookOp, cell } = setup();
    const reading = deferred<unknown>();
    notebookOp.mockImplementationOnce(() => reading.promise);
    const host = (chat as unknown as { host: ChatHost }).host;
    const persist = vi.fn();
    host.persist = persist;
    emitRun(chat);
    chat.cardAction(cards(chat)[0]!.cardId, "fix");
    chat.close();
    reading.resolve({ cells: [cell] });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(chat.messages.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text.startsWith("Fix the error")))).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(chat.status).toBe("closed");
  });

  it("keeps at most five open run cards", () => {
    const { chat } = setup();
    for (let i = 0; i < 6; i++) emitRun(chat, { cellId: `c${i}`, index: i });
    expect(cards(chat)).toHaveLength(6);
    expect(cards(chat)[0]).toMatchObject({ state: "stale", outcome: "Superseded", actions: [] });
    expect(cards(chat).filter((c) => c.state === "open")).toHaveLength(5);
  });
});

describe("Long cell runs", () => {
  it("opens a finished card and emits chat.run after a successful run of 61 seconds", () => {
    const { chat, emit } = setup();
    const run = emitRun(chat, { status: "ok", durationMs: 61_000, ename: undefined, evalue: undefined });
    const card = cards(chat)[0]!;
    expect(card).toMatchObject({ kind: "run", tone: "ok", state: "open", title: "Cell [0] finished · 1m 01s" });
    expect(card.actions.map((a) => a.id)).toEqual(["summarize", "dismiss"]);
    expect(emit).toHaveBeenCalledWith("chat.run", { chatId: chat.id, tabId: 1, cardId: card.cardId, run, title: "" });
  });

  it("does nothing for a successful run below a minute", () => {
    const { chat, emit } = setup();
    emitRun(chat, { status: "ok", durationMs: 5_000, ename: undefined, evalue: undefined });
    expect(cards(chat)).toEqual([]);
    expect(emit.mock.calls.filter(([event]) => event === "chat.run")).toEqual([]);
  });

  it("keeps a short error as a card without a VS Code run notification", () => {
    const { chat, emit } = setup();
    emitRun(chat, { durationMs: 5_000 });
    expect(cards(chat)).toHaveLength(1);
    expect(emit.mock.calls.filter(([event]) => event === "chat.run")).toEqual([]);
  });

  it("emits chat.run for a long error as well as its error card", () => {
    const { chat, emit } = setup();
    emitRun(chat, { durationMs: 61_000 });
    expect(cards(chat)[0]).toMatchObject({ tone: "error", state: "open" });
    expect(emit.mock.calls.filter(([event]) => event === "chat.run")).toHaveLength(1);
  });

  it("does not create a card or notification for a long run during a turn", async () => {
    const { chat, emit } = setup();
    const pending = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(pending.promise);
    chat.send("working");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    emitRun(chat, { status: "ok", durationMs: 61_000, ename: undefined, evalue: undefined });
    expect(cards(chat)).toEqual([]);
    expect(emit.mock.calls.filter(([event]) => event === "chat.run")).toEqual([]);
    pending.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(chat.status).toBe("idle"));
  });

  it("Summarize sends the finished cell with the summarize instruction", async () => {
    const { chat } = setup();
    emitRun(chat, { status: "ok", durationMs: 61_000, ename: undefined, evalue: undefined });
    expect(chat.cardAction(cards(chat)[0]!.cardId, "summarize")).toBe(true);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    expect(agent.prompt.mock.calls[0]![0]).toContain("<cell-run>");
    expect(agent.prompt.mock.calls[0]![0]).toContain("Say what the run produced and whether it looks right");
    expect(chat.messages.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "Summarize the result of cell [0]"))).toBe(true);
  });
});

describe("Notebook run context", () => {
  it("reports user activity from during a turn once, then clears it", async () => {
    const { chat } = setup();
    const pending = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValueOnce(pending.promise);
    chat.send("first");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    emitRun(chat, { status: "ok", by: "user", durationMs: 2_000, ename: undefined, evalue: undefined });
    pending.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect((chat as unknown as { current: unknown }).current).toBeNull());

    chat.send("second");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect((chat as unknown as { current: unknown }).current).toBeNull());
    expect(agent.prompt.mock.calls[1]![0]).toContain("<notebook-activity>");
    expect(agent.prompt.mock.calls[1]![0]).toContain("[0] a ok (2s)");

    chat.send("third");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect((chat as unknown as { current: unknown }).current).toBeNull());
    expect(agent.prompt.mock.calls[2]![0]).not.toContain("<notebook-activity>");
  });

  it("sends run diagnostics only when they change and marks stale cells in Read", async () => {
    const { chat, cell } = setup();
    const turn = async (text: string, count: number) => {
      chat.send(text);
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(count));
      await vi.waitFor(() => expect((chat as unknown as { current: unknown }).current).toBeNull());
      return agent.prompt.mock.calls[count - 1]![0] as string;
    };
    cell.running = true;
    expect(await turn("one", 1)).toContain("Run state:\nRunning now: [0] a");
    expect(await turn("two", 2)).not.toContain("Run state:");
    cell.running = false;
    cell.stale = true;
    expect(await turn("three", 3)).toContain("Edited since they last ran (what they define may be out of date): [0] a");

    const { renderCell } = await import("../src/notebook/tools.js");
    expect(renderCell(cell, false)).toContain("STALE (edited since it last ran)");
  });
  it("tells the next turn when a disconnected kernel comes back", async () => {
    const { chat, info } = setup();
    chat.notebook = info as Chat["notebook"];
    chat.onNotebookEvent({ type: "kernel_changed", kernel: "disconnected" });
    // notebook.attached may report idle before kernel_changed arrives.
    chat.notebook = { ...info, kernel: "idle" } as Chat["notebook"];
    chat.onNotebookEvent({ type: "kernel_changed", kernel: "idle" });
    chat.send("check the kernel");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((chat as unknown as { current: unknown }).current).toBeNull());
    expect(agent.prompt.mock.calls[0]![0]).toContain("<notebook-activity>");
    expect(agent.prompt.mock.calls[0]![0]).toContain("The kernel restarted or reconnected");
    expect(chat.notebook?.kernel).toBe("idle");
  });
});

describe("Kernel state tool", () => {
  it("reads variables through execute in cell scope and renders their details", async () => {
    const { chat, notebookOp } = setup({ scope: "cell", review: false });
    const original = notebookOp.getMockImplementation()!;
    const vars = { vars: [
      { name: "df", type: "pandas.core.frame.DataFrame", shape: "(3, 2)", size: 2048 },
      { name: "model", type: "torch.nn.Module", size: 1_048_576, device: "cuda:0" },
    ] };
    notebookOp.mockImplementation(async (tab, raw) => (raw as { op: string }).op === "execute"
      ? { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb ${JSON.stringify(vars)}\n` }] }
      : original(tab, raw, 30_000));
    const result = await chat.runTool("kernel_state", { limit: 2, pattern: "df|model" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("df · pandas.core.frame.DataFrame · (3, 2) · 2.0 KB");
    expect(result.text).toContain("model · torch.nn.Module · - · 1.0 MB · cuda:0");
    expect(notebookOp.mock.calls.some(([, op]) => (op as { op: string }).op === "execute")).toBe(true);
    expect(notebookOp.mock.calls.some(([, op]) => (op as { op: string }).op === "machine_exec")).toBe(false);
  });

  it("refuses a non-Python kernel without executing code", async () => {
    const { chat, notebookOp, info } = setup({ scope: "cell" });
    info.language = "r";
    const result = await chat.runTool("kernel_state", {});
    expect(result).toMatchObject({ isError: true, text: "kernel_state is only for Python kernels." });
    expect(notebookOp.mock.calls.some(([, op]) => (op as { op: string }).op === "execute")).toBe(false);
  });
});

describe("Machine stats", () => {
  it("refreshes machine stats and silently keeps the old values when the kernel is busy", async () => {
    const { chat, notebookOp, emit } = setup();
    const original = notebookOp.getMockImplementation()!;
    const machine = { memTotal: 16_000_000_000, memAvailable: 12_000_000_000, diskTotal: 100_000_000_000, diskFree: 50_000_000_000, gpus: [] };
    notebookOp.mockImplementation(async (tab, raw) => (raw as { op: string }).op === "machine_exec"
      ? { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb ${JSON.stringify(machine)}\n` }] }
      : original(tab, raw, 30_000));
    await chat.refreshMachine();
    expect(chat.machine).toMatchObject(machine);
    expect(emit).toHaveBeenCalledWith("chat.machine", { chatId: chat.id, tabId: 1, machine: chat.machine });

    const before = chat.machine;
    (chat as unknown as { machineAt: number }).machineAt = 0;
    notebookOp.mockImplementation(async (tab, raw) => {
      if ((raw as { op: string }).op === "machine_exec") throw new Error("The kernel is busy running a cell");
      return original(tab, raw, 30_000);
    });
    await expect(chat.refreshMachine()).resolves.toBeUndefined();
    expect(chat.machine).toBe(before);
    expect(chat.messages).toEqual([]);
  });
  it("retries immediately after an in-flight read when the kernel reconnects", async () => {
    const { chat, notebookOp } = setup();
    const original = notebookOp.getMockImplementation()!;
    const firstRead = deferred<unknown>();
    let calls = 0;
    notebookOp.mockImplementation(async (tab, raw) => {
      if ((raw as { op: string }).op !== "machine_exec") return original(tab, raw, 30_000);
      calls++;
      if (calls === 1) return firstRead.promise;
      return { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb ${JSON.stringify({ boot: "boot-b" })}\n` }] };
    });
    const first = chat.refreshMachine();
    await vi.waitFor(() => expect(calls).toBe(1));
    const reconnected = chat.refreshMachine(true);
    firstRead.resolve({ status: "ok", outputs: [] });
    await first;
    await reconnected;
    expect(calls).toBe(2);
  });
});

describe("Machine replacement", () => {
  it("ignores the same boot and resets machine-local state only when the boot changes, telling the agent and the editor", async () => {
    const { chat, notebookOp } = setup();
    const original = notebookOp.getMockImplementation()!;
    const current = { boot: "boot-a" };
    notebookOp.mockImplementation(async (tab, raw) => (raw as { op: string }).op === "machine_exec"
      ? { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `ainb ${JSON.stringify(current)}\n` }] }
      : original(tab, raw, 30_000));
    const host = (chat as unknown as { host: ChatHost }).host;
    host.machineReset = vi.fn();
    const emit = vi.spyOn(host, "emit");
    const notes = () => (chat as unknown as { kernelNotes: string[] }).kernelNotes;
    const replaced = () => emit.mock.calls.filter(([event]) => event === "chat.machineReplaced");
    await chat.refreshMachine();
    const mirror = (chat as unknown as { mirror: unknown }).mirror;
    const shells = (chat as unknown as { shells: unknown }).shells;

    (chat as unknown as { machineAt: number }).machineAt = 0;
    await chat.refreshMachine();
    expect(replaced()).toEqual([]);
    current.boot = "boot-b";
    (chat as unknown as { machineAt: number }).machineAt = 0;
    await chat.refreshMachine();
    expect(replaced()).toHaveLength(1);
    expect(notes().join(" ")).toContain("machine was replaced");
    // No card in the chat: the header shows the code state.
    expect(cards(chat)).toEqual([]);
    expect((chat as unknown as { mirror: unknown }).mirror).not.toBe(mirror);
    expect((chat as unknown as { shells: unknown }).shells).not.toBe(shells);
    expect(host.machineReset).toHaveBeenCalledTimes(1);
  });

  it("forgets the code place when the machine is replaced, so a busy kernel cannot restore it", async () => {
    const { chat, notebookOp } = setup();
    const original = notebookOp.getMockImplementation()!;
    const current = { boot: "boot-a" };
    notebookOp.mockImplementation(async (tab, raw) => (raw as { op: string }).op === "machine_exec"
      ? { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb ${JSON.stringify(current)}\n` }] }
      : original(tab, raw, 30_000));
    const invalidate = vi.fn();
    (chat as unknown as { code: { current: null; invalidate: typeof invalidate } }).code = { current: null, invalidate };
    await chat.refreshMachine();
    expect(invalidate).not.toHaveBeenCalled();
    current.boot = "boot-b";
    (chat as unknown as { machineAt: number }).machineAt = 0;
    await chat.refreshMachine();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("Bridge notes", () => {
  it("puts a note made during a turn inside the turn's reply, not pinned after it", async () => {
    const { chat } = setup();
    const pending = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(pending.promise);
    chat.send("working");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    (chat as unknown as { system(text: string): void }).system("code is ready");
    const last = chat.messages.at(-1)!;
    expect(last.role).toBe("agent");
    expect(last.parts).toContainEqual({ type: "notice", level: "info", text: "code is ready" });
    pending.resolve({ stopReason: "end_turn" });
  });
});

describe("Autosave", () => {
  const place: CodePlace = { projectId: "p", dir: "/content/repo", branch: "notebook/test", remote: "https://example.test/repo", session: "project-test", worktree: "/tmp/worktree" };

  function withCode(chat: Chat, result: { ok: boolean; changed: boolean; text: string }) {
    const syncBack = vi.fn().mockResolvedValue(result);
    (chat as unknown as { code: { current: CodePlace; syncBack: typeof syncBack } }).code = { current: place, syncBack };
    return syncBack;
  }

  it("syncs once after ten minutes following user activity", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const syncBack = withCode(chat, { ok: true, changed: false, text: "" });
    emitRun(chat, { status: "ok", ename: undefined, evalue: undefined });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(syncBack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(syncBack).toHaveBeenCalledTimes(1);
  });

  it("does not sync without user activity or while an agent turn is running", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const syncBack = withCode(chat, { ok: true, changed: false, text: "" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncBack).not.toHaveBeenCalled();

    const pending = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(pending.promise);
    chat.send("working");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    emitRun(chat, { status: "ok", ename: undefined, evalue: undefined });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncBack).not.toHaveBeenCalled();
    pending.resolve({ stopReason: "end_turn" });
  });

  it("retries a failed sync silently after another interval", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const syncBack = withCode(chat, { ok: false, changed: false, text: "sync failed" });
    emitRun(chat, { status: "ok", ename: undefined, evalue: undefined });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncBack).toHaveBeenCalledTimes(1);
    expect(chat.messages.filter((message) => message.role === "system" && message.parts.some((part) => part.type === "notice" && part.text.includes("sync failed")))).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncBack).toHaveBeenCalledTimes(2);
  });

  it("does not call again after the chat closes", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const syncBack = withCode(chat, { ok: true, changed: false, text: "" });
    emitRun(chat, { status: "ok", ename: undefined, evalue: undefined });
    chat.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncBack).not.toHaveBeenCalled();
  });
});

describe("Verify and save", () => {
  const cells: CellInfo[] = [
    { id: "a", index: 0, type: "code", source: "a = 1", executionCount: null },
    { id: "b", index: 1, type: "code", source: "b = a + 1", executionCount: null },
  ];

  function verifySetup() {
    const result = setup({}, "notebook:test");
    withProject(result.chat);
    const original = result.notebookOp.getMockImplementation()!;
    result.notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[] };
      if (op.op === "get_cells") return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") {
        const id = op.cellIds![0]!;
        return { results: [{ cellId: id, status: id === "b" ? "error" : "ok", outputs: [] }] };
      }
      if (op.op === "interrupt") return { interrupted: true };
      return original(tab, raw, 30_000);
    });
    return { ...result, original };
  }

  it("resets, runs every cell in order and saves after they all pass", async () => {
    const { chat, notebookOp, original } = verifySetup();
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[] };
      if (op.op === "get_cells") return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") return { results: [{ cellId: op.cellIds![0]!, status: "ok", outputs: [] }] };
      return original(tab, raw, 30_000);
    });
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    expect(card.actions.map((action) => action.id)).toEqual(["verify", "dismiss"]);
    chat.cardAction(card.cardId, "verify");
    await vi.waitFor(() => expect(card.state).toBe("done"));
    const ops = notebookOp.mock.calls.filter(([, op]) => ["execute", "run_cells"].includes((op as { op: string }).op));
    expect(ops.map(([, op]) => (op as { op: string }).op)).toEqual(["execute", "run_cells", "run_cells"]);
    expect(ops.map(([, op]) => (op as { cellIds?: string[] }).cellIds?.[0]).filter(Boolean)).toEqual(["a", "b"]);
    expect(ops[0]![1]).toMatchObject({ op: "execute", code: "%reset -f" });
    expect(projectTools.saveNotebook).toHaveBeenCalledTimes(1);
    expect(projectTools.saveNotebook.mock.calls[0]![1]).toEqual({ user: { notebookKey: "notebook:test" } });
    expect(card.outcome).toBe("Verified: 2 cells ran from a clean state. Saved to artifacts/notebooks/test.ipynb.");
  });

  it("does not save when the second cell fails", async () => {
    const { chat } = verifySetup();
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    chat.cardAction(card.cardId, "verify");
    await vi.waitFor(() => expect(card.state).toBe("done"));
    expect(projectTools.saveNotebook).not.toHaveBeenCalled();
    expect(card.outcome).toBe("Stopped at cell [1]: it failed. Nothing was saved.");
  });

  it("Stop interrupts and does not save", async () => {
    const { chat, notebookOp, original } = verifySetup();
    const running = deferred<{ results: { cellId: string; status: string; outputs: never[] }[] }>();
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[] };
      if (op.op === "get_cells") return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") return running.promise;
      if (op.op === "interrupt") return { interrupted: true };
      return original(tab, raw, 30_000);
    });
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    chat.cardAction(card.cardId, "verify");
    await vi.waitFor(() => expect(notebookOp.mock.calls.some(([, op]) => (op as { op: string }).op === "run_cells")).toBe(true));
    expect(chat.cardAction(card.cardId, "cancel")).toBe(true);
    expect(notebookOp.mock.calls.some(([, op]) => (op as { op: string }).op === "interrupt")).toBe(true);
    running.resolve({ results: [{ cellId: "a", status: "ok", outputs: [] }] });
    await vi.waitFor(() => expect(card.state).toBe("done"));
    expect(projectTools.saveNotebook).not.toHaveBeenCalled();
    expect(card.outcome).toBe("Stopped by the user. Nothing was saved.");
  });

  it("does not save when the notebook changes during verification", async () => {
    const { chat, notebookOp, original } = verifySetup();
    const before = cells[1]!.source;
    try {
      notebookOp.mockImplementation(async (tab, raw) => {
        const op = raw as { op: string; cellIds?: string[] };
        if (op.op === "get_cells") return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
        if (op.op === "execute") return { status: "ok", outputs: [] };
        if (op.op === "run_cells") {
          if (op.cellIds![0] === "b") cells[1]!.source = "b = changed while verifying";
          return { results: [{ cellId: op.cellIds![0]!, status: "ok", outputs: [] }] };
        }
        return original(tab, raw, 30_000);
      });
      await chat.verifyAndSave();
      const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
      chat.cardAction(card.cardId, "verify");
      await vi.waitFor(() => expect(card.state).toBe("done"));
      expect(projectTools.saveNotebook).not.toHaveBeenCalled();
      expect(card.outcome).toBe("The notebook changed during verification. Nothing was saved.");
    } finally {
      cells[1]!.source = before;
    }
  });

  it("does not save when Stop happens during the final pre-save read", async () => {
    const { chat, notebookOp, original } = verifySetup();
    let reads = 0;
    let cardId = "";
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[] };
      if (op.op === "get_cells") {
        reads++;
        if (reads === 2) chat.cardAction(cardId, "cancel");
        return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      }
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") return { results: [{ cellId: op.cellIds![0]!, status: "ok", outputs: [] }] };
      if (op.op === "interrupt") return { interrupted: true };
      return original(tab, raw, 30_000);
    });
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    cardId = card.cardId;
    chat.cardAction(cardId, "verify");
    await vi.waitFor(() => expect(card.state).toBe("done"));
    expect(projectTools.saveNotebook).not.toHaveBeenCalled();
    expect(card.outcome).toBe("Stopped by the user. Nothing was saved.");
  });

  it("polls a timed-out cell with summaries and reads its outputs once at the end", async () => {
    const { chat, notebookOp, original } = verifySetup();
    let polls = 0;
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[]; summary?: boolean; includeOutputs?: boolean };
      if (op.op === "get_cells") {
        if (op.summary) {
          polls++;
          return { cells: [{ ...cells[0]!, running: polls < 2, lineCount: 1 }] };
        }
        if (op.includeOutputs) return { cells: [{ ...cells[0]!, executionCount: 1, outputs: [{ kind: "stream", name: "stdout", text: "ran a = 1\n" }] }] };
        return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      }
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") return { results: [{ cellId: op.cellIds![0]!, status: op.cellIds![0] === "a" ? "timeout" : "ok", outputs: [] }] };
      return original(tab, raw, 30_000);
    });
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    chat.cardAction(card.cardId, "verify");
    await vi.waitFor(() => expect(card.state).toBe("done"), { timeout: 20_000 });
    const gets = notebookOp.mock.calls.filter(([, op]) => (op as { op: string }).op === "get_cells").map(([, op]) => op as { op: string; cellIds?: string[]; summary?: boolean; includeOutputs?: boolean });
    // While the cell runs: summaries of that cell only, no outputs riding along every 2s.
    const summaries = gets.filter((op) => op.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((op) => op.cellIds?.[0] === "a" && !op.includeOutputs)).toBe(true);
    // The outputs are fetched once, when it finished.
    expect(gets.filter((op) => op.includeOutputs)).toEqual([{ op: "get_cells", cellIds: ["a"], includeOutputs: true }]);
    expect(card.outcome).toBe("Verified: 2 cells ran from a clean state. Saved to artifacts/notebooks/test.ipynb.");
  });

  it("treats a cell the kernel restart left unrun as a failure, not a pass", async () => {
    const { chat, notebookOp, original } = verifySetup();
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[]; summary?: boolean; includeOutputs?: boolean };
      if (op.op === "get_cells") {
        if (op.summary) return { cells: [{ ...cells[0]!, running: false, lineCount: 1 }] };
        if (op.includeOutputs) return { cells: [{ ...cells[0]!, executionCount: null, outputs: [] }] };
        return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      }
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") return { results: [{ cellId: op.cellIds![0]!, status: "timeout", outputs: [] }] };
      return original(tab, raw, 30_000);
    });
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    chat.cardAction(card.cardId, "verify");
    await vi.waitFor(() => expect(card.state).toBe("done"), { timeout: 20_000 });
    expect(projectTools.saveNotebook).not.toHaveBeenCalled();
    expect(card.outcome).toBe("Stopped at cell [0]: it failed. Nothing was saved.");
  });

  it("still fails a timed-out cell whose outputs hold an error", async () => {
    const { chat, notebookOp, original } = verifySetup();
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellIds?: string[]; summary?: boolean; includeOutputs?: boolean };
      if (op.op === "get_cells") {
        if (op.summary) return { cells: [{ ...cells[0]!, running: false, lineCount: 1 }] };
        if (op.includeOutputs) return { cells: [{ ...cells[0]!, executionCount: 1, outputs: [{ kind: "error", ename: "ValueError", evalue: "boom" }] }] };
        return { cells: op.cellIds ? cells.filter((cell) => op.cellIds!.includes(cell.id)) : cells };
      }
      if (op.op === "execute") return { status: "ok", outputs: [] };
      if (op.op === "run_cells") return { results: [{ cellId: op.cellIds![0]!, status: "timeout", outputs: [] }] };
      return original(tab, raw, 30_000);
    });
    await chat.verifyAndSave();
    const card = cards(chat).find((candidate) => candidate.kind === "verify")!;
    chat.cardAction(card.cardId, "verify");
    await vi.waitFor(() => expect(card.state).toBe("done"), { timeout: 20_000 });
    expect(projectTools.saveNotebook).not.toHaveBeenCalled();
    expect(card.outcome).toBe("Stopped at cell [0]: it failed. Nothing was saved.");
  });

  it("rejects a non-Python kernel before creating a card", async () => {
    const { chat, info } = verifySetup();
    info.language = "r";
    await expect(chat.verifyAndSave()).rejects.toThrow("Verifying needs a Python kernel.");
    expect(cards(chat).filter((card) => card.kind === "verify")).toEqual([]);
  });

  it("rejects while an agent turn is running", async () => {
    const { chat } = verifySetup();
    const pending = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(pending.promise);
    chat.send("working");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    await expect(chat.verifyAndSave()).rejects.toThrow("Wait for the agent's turn");
    pending.resolve({ stopReason: "end_turn" });
    expect(cards(chat).filter((card) => card.kind === "verify")).toEqual([]);
  });
});

describe("Streaming and context", () => {
  async function handlers() {
    const { AcpAgent } = await import("../src/agents/acp-agent.js");
    return vi.mocked(AcpAgent).mock.calls.at(-1)![1] as { onUpdate(n: unknown): void };
  }
  const chunk = (text: string) => ({ sessionId: "test-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

  it("streams patches that rebuild the transcript, sends text as appends, and reports context use", async () => {
    const { chat } = setup();
    const emit = (chat as unknown as { host: ChatHost }).host.emit as ReturnType<typeof vi.fn>;
    agent.prompt.mockImplementation(async () => {
      const h = await handlers();
      for (const piece of ["Hel", "lo ", "world"]) {
        h.onUpdate(chunk(piece));
        await new Promise((r) => setTimeout(r, 100));
      }
      h.onUpdate({ sessionId: "test-session", update: { sessionUpdate: "usage_update", used: 53_000, size: 200_000, cost: { amount: 0.12, currency: "USD" } } });
      return { stopReason: "end_turn" };
    });
    chat.send("hi");
    await vi.waitFor(() => expect(chat.status).toBe("idle"));
    await vi.waitFor(() => expect(chat.snapshot().messages.at(-1)!.parts).toEqual([{ type: "text", text: "Hello world" }]));

    const patches = emit.mock.calls.filter(([e]) => e === "chat.patch").map(([, p]) => p as MessagePatch);
    let rebuilt: ChatMessage[] = [];
    for (const p of patches) rebuilt = applyMessagePatch(rebuilt, p)!;
    expect(rebuilt).toEqual(chat.snapshot().messages);
    // After the first piece, text travels as appends only.
    const ops = patches.filter((p) => p.role === "agent").flatMap((p) => p.ops);
    expect(ops.filter((o) => "append" in o).map((o) => (o as { append: string }).append)).toEqual(["lo ", "world"]);
    expect(emit).toHaveBeenCalledWith("chat.usage", { chatId: chat.id, tabId: 1, usage: { used: 53_000, size: 200_000, cost: { amount: 0.12, currency: "USD" } } });
    expect(chat.snapshot().usage).toEqual({ used: 53_000, size: 200_000, cost: { amount: 0.12, currency: "USD" } });
  });

  it("sends the outline again only when it changed", async () => {
    const { chat, notebookOp, info } = setup();
    let source = "x = 1";
    notebookOp.mockImplementation(async (_tab, raw) => {
      const op = raw as { op: string; summary?: boolean };
      if (op.op === "info") return info;
      if (op.op === "get_cells") return { cells: [{ id: "a", index: 0, type: "code", source, lineCount: 1 }] };
      return {};
    });
    const turn = async (text: string) => {
      const n = agent.prompt.mock.calls.length;
      chat.send(text);
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(n + 1));
      await vi.waitFor(() => expect(chat.status).toBe("idle"));
      return agent.prompt.mock.calls[n]![0] as string;
    };
    expect(await turn("one")).toContain("[0] a code: x = 1");
    const second = await turn("two");
    expect(second).toContain("Outline: 1 cells, unchanged since your previous message.");
    expect(second).not.toContain("[0] a code");
    source = "y = 2";
    expect(await turn("three")).toContain("[0] a code: y = 2");
    // The outline is read as summaries, never as full sources.
    expect(notebookOp.mock.calls.filter(([, op]) => (op as { op: string }).op === "get_cells").every(([, op]) => (op as { summary?: boolean }).summary)).toBe(true);
  });
});

describe("Context compaction", () => {
  it("sends the playbook again when the reported context shrinks sharply", async () => {
    const { chat } = setup();
    const { AcpAgent } = await import("../src/agents/acp-agent.js");
    const usage = (used: number) => ({ sessionId: "test-session", update: { sessionUpdate: "usage_update", used, size: 200_000 } });
    let report: number[] = [];
    agent.prompt.mockImplementation(async () => {
      const h = vi.mocked(AcpAgent).mock.calls.at(-1)![1] as { onUpdate(n: unknown): void };
      for (const n of report) h.onUpdate(usage(n));
      return { stopReason: "end_turn" };
    });
    const turn = async (text: string, used: number[]) => {
      report = used;
      const n = agent.prompt.mock.calls.length;
      chat.send(text);
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(n + 1));
      await vi.waitFor(() => expect(chat.status).toBe("idle"));
      return agent.prompt.mock.calls[n]![0] as string;
    };
    expect(await turn("one", [90_000, 150_000])).toContain("<agent-in-notebook>");
    expect(await turn("two", [160_000, 40_000])).not.toContain("<agent-in-notebook>");
    // 160k -> 40k: compacted during "two".
    expect(await turn("three", [45_000])).toContain("<agent-in-notebook>");
    // Growing again, or shrinking a little, is no compaction.
    expect(await turn("four", [60_000, 50_000])).not.toContain("<agent-in-notebook>");
    expect(await turn("five", [])).not.toContain("<agent-in-notebook>");
  });
});

describe("Project code in the notebook header", () => {
  const place: CodePlace = { projectId: "p", dir: "/root/.ainb-projects/k-repo", branch: "notebook/test", remote: "https://github.com/u/repo", session: "project-k", worktree: "/tmp/worktree" };
  type FakeSync = { current: CodePlace | null; ensure: Mock; invalidate: Mock };
  function withCode(chat: Chat, ensure: () => Promise<unknown>): FakeSync {
    withProject(chat);
    const sync: FakeSync = { current: null, ensure: vi.fn(async () => {
      const st = await ensure() as { state: string; place?: CodePlace };
      if (st.state === "ready") sync.current = st.place!;
      return st;
    }), invalidate: vi.fn(() => { sync.current = null; }) };
    (chat as unknown as { code: FakeSync }).code = sync;
    (chat as unknown as { codeState: unknown }).codeState = { state: "missing" };
    return sync;
  }

  it("shows the code as missing, pushing, then ready when the user puts it on the machine", async () => {
    const { chat, emit } = setup({}, "nb-key");
    const done = deferred<unknown>();
    withCode(chat, () => done.promise);
    expect(chat.snapshot().code?.state).toBe("missing");
    const pushed = chat.pushCode();
    await vi.waitFor(() => expect(chat.snapshot().code?.state).toBe("pushing"));
    done.resolve({ state: "ready", place });
    expect(await pushed).toEqual({ state: "ready", dir: place.dir, branch: place.branch });
    // Mid-session the code state travels as chat.meta (just the field), not a full snapshot.
    const states = emit.mock.calls.filter(([event]) => event === "chat.meta").map(([, meta]) => (meta as { code?: { state: string } }).code?.state).filter(Boolean);
    expect(states).toEqual(["pushing", "ready"]);
    expect(emit.mock.calls.filter(([event]) => event === "chat.snapshot")).toEqual([]);
    expect(chat.messages.flatMap((m) => m.parts).some((p) => p.type === "notice" && p.text.includes(place.dir))).toBe(true);
  });

  it("stays missing, with the reason, when the code could not be put there", async () => {
    const { chat } = setup({}, "nb-key");
    withCode(chat, async () => ({ state: "error", why: "Could not clone: no network." }));
    expect(await chat.pushCode()).toEqual({ state: "missing", why: "Could not clone: no network." });
  });

  it("does not show a spinner when the clone is already there, and turns missing when the machine is replaced", async () => {
    const { chat, emit } = setup({}, "nb-key");
    const sync = withCode(chat, async () => ({ state: "ready", place }));
    await chat.pushCode();
    emit.mockClear();
    await chat.pushCode();
    expect(sync.ensure).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.filter(([event]) => event === "chat.snapshot" || event === "chat.meta")).toEqual([]);
    (chat as unknown as { onMachineReplaced(): void }).onMachineReplaced();
    expect(sync.invalidate).toHaveBeenCalledTimes(1);
    expect(sync.current).toBeNull();
    expect(chat.snapshot().code?.state).toBe("missing");
    expect(emit).toHaveBeenCalledWith("chat.meta", expect.objectContaining({ code: expect.objectContaining({ state: "missing" }) }));
  });
});

describe("Project code after a move to another project", () => {
  it("turns the code state back to missing (pushable) when the notebook moves to another project", () => {
    const { chat, emit } = setup({}, "nb-key");
    withProject(chat);
    (chat as unknown as { code: unknown }).code = { current: null, ensure: vi.fn() };
    chat.setProject({ project: { id: "scratch", name: "Scratch", state: "ready" } } as never);
    (chat as unknown as { codeState: unknown }).codeState = { state: "none", why: "The project Scratch has no GitHub repository." };
    emit.mockClear();
    chat.setProject({ project: { id: "gepa", name: "gepa", state: "ready" } } as never, true);
    expect(chat.snapshot().code).toEqual({ state: "missing", why: "The code of gepa is not on the notebook's machine yet." });
    expect(emit).toHaveBeenCalledWith("chat.meta", expect.objectContaining({ code: expect.objectContaining({ state: "missing" }) }));
    expect(emit.mock.calls.filter(([event]) => event === "chat.snapshot")).toEqual([]);
  });
});
