import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Part } from "@ainb/protocol";
import { Chat, type ChatHost } from "../src/chat.js";

const agent = vi.hoisted(() => ({
  running: true, sessionId: "test-session", start: vi.fn(), prompt: vi.fn(),
  cancel: vi.fn(), dispose: vi.fn(), options: () => [],
}));

vi.mock("../src/agents/acp-agent.js", () => ({
  AcpAgent: vi.fn(function () { return agent; }),
  AgentStartError: class extends Error {},
}));

const workspaceRoot = mkdtempSync(join(tmpdir(), "ainb-chat-test-"));
const chats: Chat[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  agent.start.mockResolvedValue({});
  agent.prompt.mockResolvedValue({ stopReason: "end_turn" });
  agent.cancel.mockResolvedValue(undefined);
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

function setup() {
  const info = { platform: "jupyter", title: "test", url: "test", cellCount: 1, activeCellId: "a", selectedCellIds: ["a"], kernel: "idle", language: "python" };
  const notebookOp = vi.fn<ChatHost["notebookOp"]>().mockImplementation(async (_tab, raw) => {
    const op = raw as { op: string };
    if (op.op === "info") return info;
    if (op.op === "get_cells") return { cells: [{ id: "a", type: "code", source: "x = 1" }] };
    return { results: [{ cellId: "a", status: "ok", outputs: [] }] };
  });
  const chat = new Chat(1, {
    id: "fake", name: "Fake", builtin: false, toolWaitMs: 50, loginHint: "",
    resolve: () => ({ launch: { command: "fake", args: [] } }),
  }, { scope: "auto", review: true, targetCellIds: [], notebookOnly: true }, {
    notebookOp, emit: vi.fn(), mcpServer: () => ({ name: "notebook", command: "fake", args: [], env: [] }), workspaceRoot,
  });
  chats.push(chat);
  return { chat, notebookOp, info };
}

function prompts(chat: Chat) {
  return chat.snapshot().messages.flatMap((m) => m.parts).filter((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt");
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
