// Đợt 2c (chat-side): parallel prompt fetch, dirty-part patches, chat.meta + RAM
// trim, quiet+ceiling persist, adaptive machine poll, notice-only watchdog, queue
// cap, the queued mark, and single-read undo. These pin the optimizations without
// changing the prompt's meaning or the transcript the store keeps.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMessagePatch, type CellInfo, type ChatMessage, type ChatSettings, type MessagePatch, type Part } from "@ainb/protocol";
import { Chat, type ChatHost, type ChatProjectHost } from "../src/chat.js";
import type { CodePlace } from "../src/project/vmrepo.js";

const agent = vi.hoisted(() => ({
  running: true, sessionId: "test-session", start: vi.fn(), prompt: vi.fn(),
  cancel: vi.fn(), dispose: vi.fn(), setOption: vi.fn(), applyConfigUpdate: vi.fn(), applyModeUpdate: vi.fn(),
  options: () => [] as unknown[],
}));

vi.mock("../src/agents/acp-agent.js", () => ({
  AcpAgent: vi.fn(function () { return agent; }),
  AgentStartError: class extends Error {},
}));

const workspaceRoot = mkdtempSync(join(tmpdir(), "ainb-chat-opt-"));
const chats: Chat[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  agent.start.mockResolvedValue({});
  agent.prompt.mockResolvedValue({ stopReason: "end_turn" });
  agent.cancel.mockResolvedValue(undefined);
  agent.setOption.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const chat of chats.splice(0)) chat.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function withProject(chat: Chat) {
  const host = (chat as unknown as { host: ChatHost }).host;
  const orx = { id: "p", name: "Project", repoPath: "/tmp/repo", githubUrl: "https://github.com/u/repo", artifactsDir: "/tmp/artifacts", updatedAt: 0 };
  const cache = { ...orx };
  const resolve = vi.fn(async () => ({ orx, project: { id: "p", name: "Project", state: "ready" as const } }));
  host.project = {
    links: { markDirty: vi.fn(), brief: vi.fn(async () => ({ id: "p", name: "Project", paperId: null, githubUrl: null, docs: [], artifacts: [], artifactsTotal: 0, digest: "d" })) } as unknown as ChatProjectHost["links"],
    research: {} as ChatProjectHost["research"],
    resolve,
    cached: () => cache,
  };
  return { cache, resolve };
}

const place: CodePlace = { projectId: "p", dir: "/root/.ainb-projects/k-repo", branch: "notebook/test", remote: "https://github.com/u/repo", session: "project-k", worktree: "/tmp/worktree" };

function withCode(chat: Chat) {
  const sync = {
    current: null as CodePlace | null,
    ensure: vi.fn(async () => { sync.current = place; return { state: "ready", place }; }),
    invalidate: vi.fn(() => { sync.current = null; }),
    syncBack: vi.fn(async () => ({ ok: true, changed: false, text: "" })),
  };
  (chat as unknown as { code: unknown }).code = sync;
  (chat as unknown as { codeState: unknown }).codeState = { state: "missing" };
  return sync;
}

async function handlers() {
  const { AcpAgent } = await import("../src/agents/acp-agent.js");
  return vi.mocked(AcpAgent).mock.calls.at(-1)![1] as { onUpdate(n: unknown): void };
}

const chunk = (text: string) => ({ sessionId: "test-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const toolCall = (id: string, title: string) => ({ sessionId: "test-session", update: { sessionUpdate: "tool_call", toolCallId: id, title, status: "pending", content: [] } });
const toolUpdate = (id: string, status: string) => ({ sessionId: "test-session", update: { sessionUpdate: "tool_call_update", toolCallId: id, status } });

describe("A1.1 parallel prompt fetch", () => {
  it("keeps the prompt blocks in order with project, code and attached cells", async () => {
    const { chat, cell } = setup({}, "nb-key");
    withProject(chat);
    withCode(chat);
    cell.source = "df = load()";
    chat.send("why?", { cells: [{ cellId: "a", index: 0, label: "df = load()" }] });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    const prompt = agent.prompt.mock.calls[0]![0] as string;
    const order = ["<agent-in-notebook>", "<project-context>", "<project-code>", "<attached-cells>", "<notebook-context>"];
    const indices = order.map((tag) => prompt.lastIndexOf(tag));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(prompt.trimEnd().endsWith("why?")).toBe(true);
  });

  it("starts the notebook read without waiting for the machine read", async () => {
    vi.useFakeTimers();
    const { chat, notebookOp, info } = setup();
    const machineGate = deferred<unknown>();
    let machineCalled = false;
    let infoCalled = false;
    const original = notebookOp.getMockImplementation()!;
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string };
      if (op.op === "machine_exec") { machineCalled = true; return machineGate.promise; }
      if (op.op === "info") { infoCalled = true; return info; }
      return original(tab, raw, 30_000);
    });
    chat.send("hi");
    // Let the turn reach buildPrompt: the notebook read starts even though the
    // machine read is still gated (the old sequential chain waited on it first).
    await vi.advanceTimersByTimeAsync(10);
    expect(machineCalled).toBe(true);
    expect(infoCalled).toBe(true);
    machineGate.resolve({ status: "ok", outputs: [] });
    await vi.advanceTimersByTimeAsync(1600);
    expect(agent.prompt).toHaveBeenCalledTimes(1);
  });
});

describe("A3.2 dirty-part patches", () => {
  it("re-serializes only the changed part of a many-part message", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const gate = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(gate.promise);
    chat.send("go");
    await vi.advanceTimersByTimeAsync(20);
    const h = await handlers();
    const stringify = vi.spyOn(JSON, "stringify");
    for (let i = 0; i < 6; i++) h.onUpdate(toolCall(`t${i}`, `Tool ${i}`));
    await vi.advanceTimersByTimeAsync(80);
    const reply = chat.messages.find((m) => m.role === "agent")!;
    const parts = reply.parts as object[];
    const firstFlush = stringify.mock.calls.filter(([arg]) => parts.includes(arg as object)).length;
    expect(firstFlush).toBe(6);

    stringify.mockClear();
    h.onUpdate(toolUpdate("t2", "completed"));
    await vi.advanceTimersByTimeAsync(80);
    const secondFlush = stringify.mock.calls.filter(([arg]) => parts.includes(arg as object)).length;
    expect(secondFlush).toBe(1);
    gate.resolve({ stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(20);
  });
});

describe("A3.3 chat.meta and RAM trim", () => {
  it("emits chat.meta with only the changed field, and no full snapshot mid-session", () => {
    const { chat, emit } = setup({}, "nb-key");
    withProject(chat);
    withCode(chat);
    emit.mockClear();
    chat.updateSettings({ scope: "write", review: false, targetCellIds: [], notebookOnly: true });
    expect(emit).toHaveBeenCalledWith("chat.meta", { chatId: chat.id, tabId: 1, settings: chat.settings });
    chat.setProject({ project: { id: "p", name: "Project", state: "ready" } } as never);
    expect(emit).toHaveBeenCalledWith("chat.meta", expect.objectContaining({ chatId: chat.id, tabId: 1, project: expect.objectContaining({ id: "p" }) }));
    expect(emit.mock.calls.filter(([e]) => e === "chat.snapshot")).toEqual([]);
  });

  it("trims messages to the last 200 and the journal to surviving ids at turn end, not mid-turn", async () => {
    const { chat } = setup();
    const messages: ChatMessage[] = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, role: "agent", parts: [], createdAt: i }));
    (chat as unknown as { messages: ChatMessage[] }).messages = messages;
    const journal = (chat as unknown as { journal: Map<string, unknown[]> }).journal;
    journal.set("m0", [{ kind: "update", cellId: "a", cellType: "code", index: 0, before: "x", after: "y" }]);
    journal.set("m249", [{ kind: "update", cellId: "a", cellType: "code", index: 0, before: "x", after: "y" }]);
    const gate = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(gate.promise);
    chat.send("hi");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    // Mid-turn nothing is dropped (250 carried + user + reply).
    expect(chat.messages.length).toBe(252);
    gate.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(chat.status).toBe("idle"));
    expect(chat.messages.length).toBe(200);
    expect(chat.messages[0]!.id).toBe("m52");
    expect(journal.has("m0")).toBe(false);
    expect(journal.has("m249")).toBe(true);
  });
});

describe("A3.4 persist quiet debounce with a ceiling", () => {
  it("saves after a true 2s quiet pause", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const persist = vi.fn();
    (chat as unknown as { host: ChatHost }).host.persist = persist;
    chat.notice("something happened");
    await vi.advanceTimersByTimeAsync(80); // flush schedules the save
    await vi.advanceTimersByTimeAsync(1999);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![1]).toBe(false);
  });

  it("still saves at the 10s ceiling while changes never pause", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const persist = vi.fn();
    (chat as unknown as { host: ChatHost }).host.persist = persist;
    // A change every 500ms would postpone a plain debounce forever; the ceiling forces a save.
    for (let t = 0; t < 10_500; t += 500) {
      chat.notice(`tick ${t}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(persist).toHaveBeenCalled();
  });

  it("saves synchronously when the chat closes", () => {
    const { chat } = setup();
    const persist = vi.fn();
    (chat as unknown as { host: ChatHost }).host.persist = persist;
    chat.close();
    expect(persist).toHaveBeenCalledWith(chat, true);
  });
});

describe("A4.5 adaptive machine poll", () => {
  const statsOk = { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb ${JSON.stringify({ boot: "boot-a", memTotal: 1, memAvailable: 1, diskTotal: 1, diskFree: 1, gpus: [] })}\n` }] };

  it("reads every tick while active, every fifth while idle, and never while detached", async () => {
    vi.useFakeTimers();
    const { chat, notebookOp, info } = setup();
    chat.notebook = info as Chat["notebook"];
    let reads = 0;
    const original = notebookOp.getMockImplementation()!;
    notebookOp.mockImplementation(async (tab, raw) => {
      if ((raw as { op: string }).op === "machine_exec") { reads++; return statsOk; }
      return original(tab, raw, 30_000);
    });
    await chat.refreshMachine(); // starts the poll
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    // Active: a recent turn/cell run keeps every tick reading.
    (chat as unknown as { lastActiveAt: number }).lastActiveAt = Date.now();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(3);

    // Idle: only every fifth tick (~150s) reads.
    (chat as unknown as { lastActiveAt: number }).lastActiveAt = Date.now() - 3 * 60_000;
    (chat as unknown as { machineIdleTicks: number }).machineIdleTicks = 0;
    const before = reads;
    await vi.advanceTimersByTimeAsync(30_000 * 4);
    expect(reads).toBe(before);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(before + 1);

    // Detached: no machine to read.
    chat.notebook = null;
    const detached = reads;
    await vi.advanceTimersByTimeAsync(30_000 * 6);
    expect(reads).toBe(detached);
  });
});

describe("A6.5 watchdog and queue cap", () => {
  it("notices once after 5 silent minutes, never cancels, and resets on an update", async () => {
    vi.useFakeTimers();
    const { chat } = setup();
    const gate = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(gate.promise);
    chat.send("think hard");
    await vi.advanceTimersByTimeAsync(20);
    const h = await handlers();
    const notices = () => chat.messages.flatMap((m) => m.parts).filter((p): p is Extract<Part, { type: "notice" }> => p.type === "notice" && p.text.includes("sent nothing for 5 minutes"));

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(notices()).toHaveLength(0);
    h.onUpdate(chunk("still thinking")); // resets the window
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(notices()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000); // 5 min since the update
    expect(notices()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(notices()).toHaveLength(1); // once per turn
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(chat.status).toBe("running");
    gate.resolve({ stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(20);
    expect(chat.status).toBe("idle");
  });

  it("refuses a new message past 20 queued, with a notice, leaving the queue alone", async () => {
    const { chat, emit } = setup();
    const gate = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValue(gate.promise);
    chat.send("first");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 20; i++) chat.send(`queued ${i}`);
    expect((chat as unknown as { queue: unknown[] }).queue.length).toBe(20);
    const userBefore = chat.messages.filter((m) => m.role === "user").length;
    chat.send("one too many");
    expect((chat as unknown as { queue: unknown[] }).queue.length).toBe(20);
    expect(chat.messages.filter((m) => m.role === "user").length).toBe(userBefore);
    const full = chat.messages.flatMap((m) => m.parts).some((p) => p.type === "notice" && p.text.includes("queue is full (20)"));
    expect(full).toBe(true);
    gate.resolve({ stopReason: "end_turn" });
  });
});

describe("B1.3 queued mark", () => {
  it("marks a queued message and clears the mark when its turn begins, through patches", async () => {
    const { chat, emit } = setup();
    const first = deferred<{ stopReason: "end_turn" }>();
    agent.prompt.mockReturnValueOnce(first.promise);
    chat.send("first");
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    chat.send("second");
    await vi.waitFor(() => expect(emit.mock.calls.some(([e, p]) => e === "chat.patch" && (p as MessagePatch).queued === true)).toBe(true));
    const secondId = chat.messages.find((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "second"))!.id;

    // Rebuild the UI copy from patches: the mark is set, and a silent patch keeps it.
    let list: ChatMessage[] = [];
    for (const [e, p] of emit.mock.calls) if (e === "chat.patch") list = applyMessagePatch(list, p as MessagePatch)!;
    expect(list.find((m) => m.id === secondId)?.queued).toBe(true);

    agent.prompt.mockResolvedValue({ stopReason: "end_turn" });
    first.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(emit.mock.calls.some(([e, p]) => e === "chat.patch" && (p as MessagePatch).id === secondId && (p as MessagePatch).queued === false)).toBe(true));
    list = [];
    for (const [e, p] of emit.mock.calls) if (e === "chat.patch") list = applyMessagePatch(list, p as MessagePatch)!;
    expect(list.find((m) => m.id === secondId)?.queued).toBeFalsy();
  });

  it("clears the mark for a message queued behind a notebook job too", async () => {
    const { chat, emit } = setup();
    const job = deferred<void>();
    const running = chat.runJob(() => job.promise);
    chat.send("behind the job");
    await vi.waitFor(() => expect(emit.mock.calls.some(([e, p]) => e === "chat.patch" && (p as MessagePatch).queued === true)).toBe(true));
    job.resolve();
    await running;
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(emit.mock.calls.some(([e, p]) => e === "chat.patch" && (p as MessagePatch).queued === false)).toBe(true));
  });
});

describe("A2.5 undo reads the notebook once", () => {
  function undoSetup() {
    const result = setup();
    const cells: CellInfo[] = [
      { id: "a", index: 0, type: "code", source: "after2", executionCount: null },
      { id: "b", index: 1, type: "code", source: "user edited", executionCount: null },
    ];
    const gets: unknown[] = [];
    const original = result.notebookOp.getMockImplementation()!;
    result.notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellId?: string; source?: string };
      if (op.op === "get_cells") { gets.push(op); return { cells }; }
      if (op.op === "update_cell") { const c = cells.find((x) => x.id === op.cellId); if (c) c.source = op.source!; return { applied: true }; }
      return original(tab, raw, 30_000);
    });
    const msg: ChatMessage = { id: "agent-msg", role: "agent", parts: [], createdAt: 1, changes: { count: 3 } };
    chat_messages(result.chat).push(msg);
    const journal = (result.chat as unknown as { journal: Map<string, unknown[]> }).journal;
    journal.set("agent-msg", [
      { kind: "update", cellId: "a", cellType: "code", index: 0, before: "before1", after: "after1" },
      { kind: "update", cellId: "a", cellType: "code", index: 0, before: "after1", after: "after2" },
      { kind: "update", cellId: "b", cellType: "code", index: 1, before: "orig", after: "changed" },
    ]);
    return { ...result, cells, gets };
  }
  const chat_messages = (chat: Chat) => (chat as unknown as { messages: ChatMessage[] }).messages;

  it("reads once for several changes, keeps an edited cell, and undoes newest first", async () => {
    const { chat, gets } = undoSetup();
    const res = await chat.undo("agent-msg");
    expect(gets.length).toBe(1);
    expect(res.undone).toBe(2);
    expect(res.skipped.some((s) => s.includes("edited since"))).toBe(true);
    expect(res.skipped.length).toBe(1);
  });

  it("reads again only after an op fails", async () => {
    const { chat, notebookOp, gets, cells } = undoSetup();
    const original = notebookOp.getMockImplementation()!;
    let failed = false;
    notebookOp.mockImplementation(async (tab, raw) => {
      const op = raw as { op: string; cellId?: string; source?: string };
      if (op.op === "update_cell" && !failed) { failed = true; throw new Error("kernel hiccup"); }
      return original(tab, raw, 30_000);
    });
    const res = await chat.undo("agent-msg");
    expect(gets.length).toBe(2); // initial read + one re-read after the failure
    expect(res.skipped.some((s) => s.includes("kernel hiccup"))).toBe(true);
    expect(cells.length).toBe(2);
  });
});
