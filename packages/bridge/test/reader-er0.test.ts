// ER-0 (easy-read, docs/easy-read.md § F.1): a chat whose role works on a
// paper, not a notebook. The reader's tutor is a `Chat` with a `ChatRole`, on
// a target that has no notebook at all; these tests pin that the chat never
// reaches for one unless the role asks (RoleTurn.cells), so the reader can be
// built on the chat as it is.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChatSettings } from "@ainb/protocol";
import { Chat, isNotebookTool, type ChatHost } from "../src/chat.js";
import type { ChatPort, ChatRole, RoleTurn } from "../src/chat-role.js";
import { tool } from "../src/notebook/tools.js";

const agent = vi.hoisted(() => ({
  running: true, sessionId: "reader-session", start: vi.fn(), prompt: vi.fn(),
  cancel: vi.fn(), dispose: vi.fn(), options: () => [],
}));

vi.mock("../src/agents/acp-agent.js", () => ({
  AcpAgent: vi.fn(function () { return agent; }),
  AgentStartError: class extends Error {},
}));

const workspaceRoot = mkdtempSync(join(tmpdir(), "ainb-reader-er0-"));
const chats: Chat[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  agent.start.mockResolvedValue({});
  agent.prompt.mockResolvedValue({ stopReason: "end_turn" });
});

afterEach(() => {
  for (const chat of chats.splice(0)) chat.close();
});

afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const SETTINGS: ChatSettings = { scope: "auto", review: false, targetCellIds: [], notebookOnly: true };

/** The smallest reader-like role: its own prompt, one tool of its own, nothing of the notebook's. */
class PaperRole implements ChatRole {
  readonly settings = SETTINGS;
  port: ChatPort | undefined;
  turns: RoleTurn[] = [];
  attach(port: ChatPort): () => void {
    this.port = port;
    return () => { this.port = undefined; };
  }
  snapshot() {
    return {};
  }
  async prompt(turn: RoleTurn): Promise<string> {
    this.turns.push(turn);
    return `${turn.rules ? "<reader>rules</reader>\n" : ""}<reader-state>pass 2, section S4.SS1</reader-state>\n${turn.context ?? ""}${turn.text}`;
  }
  tools() {
    return [tool({
      name: "paper_find",
      description: "Find a passage in the paper.",
      schema: z.object({ query: z.string() }),
      run: async (_ctx, args) => ({ text: `[[S4.SS1]] "${args.query}" found` }),
    })];
  }
  runTool(ctx: Parameters<ChatRole["runTool"]>[0], name: string, args: unknown) {
    const def = this.tools().find((t) => t.name === name);
    if (!def) return Promise.resolve({ text: `No tool ${name}`, isError: true });
    return def.run(ctx, def.schema.parse(args));
  }
}

function setup() {
  const notebookOp = vi.fn<ChatHost["notebookOp"]>().mockRejectedValue(new Error("no notebook here"));
  const emit = vi.fn();
  const role = new PaperRole();
  // A tab id outside both ranges the editor uses (VS Code notebooks > 0, Chrome tabs < 0 as -tabId).
  const chat = new Chat(2_000_000_001, {
    id: "fake", name: "Fake", builtin: false, toolWaitMs: 50, loginHint: "",
    resolve: () => ({ launch: { command: "fake", args: [] } }),
  }, SETTINGS, {
    notebookOp, emit, mcpServer: () => ({ name: "notebook", command: "fake", args: [], env: [] }), workspaceRoot,
  }, { notebookKey: "reader:arxiv-2106-09685", role });
  chats.push(chat);
  return { chat, notebookOp, emit, role };
}

describe("ER-0: a chat with a role and no notebook", () => {
  it("runs a turn with the role's prompt and never touches a notebook", async () => {
    const { chat, notebookOp, role } = setup();
    chat.send("Vì sao B khởi tạo bằng 0?", { context: '<reader-selection anchor="S4.SS1.p2">We use a random Gaussian initialization for A and zero for B</reader-selection>\n' });
    await chat.whenIdle();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    const sent = agent.prompt.mock.calls[0]![0] as string;
    expect(sent).toContain("<reader>rules</reader>");
    expect(sent).toContain("<reader-selection anchor=\"S4.SS1.p2\">");
    expect(sent).toContain("Vì sao B khởi tạo bằng 0?");
    expect(role.turns[0]!.rules).toBe(true);
    expect(chat.snapshot().status).toBe("idle");
    // Second turn: rules not sent again.
    chat.send("Còn α/r?");
    await chat.whenIdle();
    expect(role.turns[1]!.rules).toBe(false);
    expect(notebookOp).not.toHaveBeenCalled();
  });

  it("offers only the role's tools and runs them without the notebook", async () => {
    const { chat, notebookOp } = setup();
    expect(chat.tools().map((t) => t.name)).toEqual(["paper_find"]);
    const res = await chat.runTool("paper_find", { query: "zero for B" });
    expect(res.text).toContain("[[S4.SS1]]");
    expect(notebookOp).not.toHaveBeenCalled();
  });

  it("gives the role jobs and cards (the author's progress, a checkpoint)", async () => {
    const { chat, notebookOp, role } = setup();
    const port = role.port!;
    let pressed = "";
    const card = port.addCard({ kind: "run", tone: "info", title: "Checkpoint §4.1", detail: "4 câu", actions: [{ id: "start", label: "Làm ngay", primary: true }] }, (id) => { pressed = id; });
    await chat.cardAction(card.cardId, "start");
    expect(pressed).toBe("start");
    // A job holds messages back until it ends (the workshop needs this; the reader's author must NOT use it, see E.4.2).
    let release!: () => void;
    const job = port.job(() => new Promise<void>((r) => { release = r; }));
    chat.send("hỏi trong lúc job chạy");
    expect(agent.prompt).not.toHaveBeenCalled();
    release();
    await job;
    await chat.whenIdle();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(notebookOp).not.toHaveBeenCalled();
  });

  it("closes cleanly and detaches the role", () => {
    const { chat, role, notebookOp } = setup();
    chat.close();
    expect(role.port).toBeUndefined();
    expect(chat.snapshot().status).toBe("closed");
    expect(notebookOp).not.toHaveBeenCalled();
  });

  it("lets the reader's paper_* and reader_* tools through Notebook only", () => {
    expect(isNotebookTool("paper_find", undefined)).toBe(true);
    expect(isNotebookTool("reader_grade", undefined)).toBe(true);
    expect(isNotebookTool("Bash", undefined)).toBe(false);
  });
});
