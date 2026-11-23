// Easy-read (ER-1): the tutor beside the paper. Its tools read the paper by
// section, find in it, look at a figure or a PDF page; its role tells the agent
// where the reader is, and turns a selected passage + "Giải thích / Ví dụ cụ
// thể / Ký hiệu / Vì sao?" into a message. Last, the whole of it in a real Chat
// (the agent faked, as in reader-er0.test.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerChatKey } from "@ainb/protocol";
import { Chat } from "../src/chat.js";
import type { ChatPort } from "../src/chat-role.js";
import type { ToolContext, ToolResult } from "../src/notebook/tools.js";
import { READER_SETTINGS, ReaderChat, readerOf } from "../src/reader/chat.js";
import { findInDoc } from "../src/reader/tools.js";
import { cleanShelves, JPEG, LORA, LORA_ID, PNG, testHub } from "./fixtures/reader/fake-arxiv.js";

const agent = vi.hoisted(() => ({
  running: true, sessionId: "tutor-session", start: vi.fn(), prompt: vi.fn(),
  cancel: vi.fn(), dispose: vi.fn(), options: () => [],
}));

vi.mock("../src/agents/acp-agent.js", () => ({
  AcpAgent: vi.fn(function () { return agent; }),
  AgentStartError: class extends Error {},
}));

const scratch = mkdtempSync(join(tmpdir(), "ainb-reader-tutor-"));
const chats: Chat[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  agent.start.mockResolvedValue({});
  agent.prompt.mockResolvedValue({ stopReason: "end_turn" });
});

afterEach(() => {
  for (const chat of chats.splice(0)) chat.close();
});

afterAll(() => {
  cleanShelves();
  rmSync(scratch, { recursive: true, force: true });
});

/** What a tool needs of a chat; the notebook is never there. */
function ctx(images: boolean): ToolContext {
  return {
    settings: () => READER_SETTINGS, targets: () => [], waitMs: 1000, images,
    call: () => Promise.reject(new Error("no notebook here")),
    awaitReview: async () => "pending", confirmRun: async () => false,
  } as unknown as ToolContext;
}

async function lora() {
  const t = testHub();
  await t.hub.open({ arxiv: LORA });
  const tutor = new ReaderChat(t.hub, LORA_ID);
  const run = (name: string, args: unknown, images = false): Promise<ToolResult> => tutor.runTool(ctx(images), name, args);
  return { ...t, tutor, run };
}

let pdfs = 0;
async function pdfPaper() {
  const t = testHub();
  const path = join(scratch, `paper-${++pdfs}.pdf`);
  writeFileSync(path, `%PDF-1.7\n% ${pdfs}\n`);
  const { paperId } = await t.hub.open({ pdfPath: path });
  const tutor = new ReaderChat(t.hub, paperId);
  const run = (name: string, args: unknown, images = false): Promise<ToolResult> => tutor.runTool(ctx(images), name, args);
  return { ...t, paperId, tutor, run };
}

describe("paper_read", () => {
  it("gives the outline, then the whole paper with every anchor, formulas as TeX", async () => {
    const { run } = await lora();
    const r = await run("paper_read", {});
    expect(r.isError).toBeUndefined();
    expect(r.text.startsWith("Outline:\n[[abstract]] Abstract\n[[S1]] 1 Introduction")).toBe(true);
    expect(r.text).toContain("  [[S4.SS1]] 4.1 Low-Rank-Parametrized Update Matrices");
    expect(r.text).toContain("[S4.SS1.p2] We use a random Gaussian initialization for $A$ and zero for $B$");
    expect(r.text).toContain("$$h=W_{0}x+\\Delta Wx=W_{0}x+BAx$$ (3) [S4.E3]");
  });

  it("reads one section with its subsections, found by the id of anything in it", async () => {
    const { run } = await lora();
    const s4 = (await run("paper_read", { section: "S4" })).text;
    expect(s4).toContain("[[S4.SS1]]");
    expect(s4).not.toContain("[[S1]]");
    expect(s4).not.toContain("Outline:");
    expect((await run("paper_read", { section: "S4.SS1.p2" })).text.startsWith("### 4.1 Low-Rank-Parametrized Update Matrices  [[S4.SS1]]")).toBe(true);
    expect((await run("paper_read", { section: "S2.E1" })).text).toContain("[[S2]]");
    const missing = await run("paper_read", { section: "S9" });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('No section "S9". The sections are:\n[[abstract]] Abstract');
  });

  it("pages a long paper, and says where the end is", async () => {
    const { hub, run } = await lora();
    const doc = hub.doc(LORA_ID);
    hub.store.writeDoc({ ...doc, blocks: doc.blocks.map((b) => (b.id === "S4.p1" ? { ...b, text: "x".repeat(50_000) } : b)) });
    const first = (await run("paper_read", {})).text;
    const next = first.match(/paper_read again with offset=(\d+)\]$/);
    expect(next?.[1]).toBe("40000");
    const rest = (await run("paper_read", { offset: 40_000 })).text;
    expect(rest).not.toContain("Outline:");
    expect(rest).not.toContain("more characters");
    expect((await run("paper_read", { offset: 10_000_000 })).text).toMatch(/offset 10000000 is past the end/);
  });

  it("reads the authors' LaTeX only when there is some", async () => {
    const { run } = await lora();
    expect(await run("paper_read", { latex: true })).toMatchObject({ isError: true, text: expect.stringContaining("no LaTeX source") });
  });

  it("refuses bad arguments as the agent can fix them", async () => {
    const { run } = await lora();
    expect(await run("paper_read", { offset: -1 })).toMatchObject({ isError: true, text: expect.stringContaining("Invalid arguments for paper_read") });
    expect(await run("notebook_info", {})).toMatchObject({ isError: true, text: "Unknown tool notebook_info." });
  });
});

describe("paper_find", () => {
  it("finds a phrase, with its anchor and section", async () => {
    const { run } = await lora();
    const r = (await run("paper_find", { query: "zero for B" })).text;
    expect(r.split("\n")[0]).toBe("[S4.SS1.p2] in 4.1 Low-Rank-Parametrized Update Matrices [[S4.SS1]]");
    expect((await run("paper_find", { query: "Trainable parameters" })).text).toMatch(/^\[S4\.T1\] in 4\.1 .* \(table\)/);
  });

  it("puts the whole phrase above its words scattered, and says when nothing matches", async () => {
    const { hub, run } = await lora();
    const hits = findInDoc(hub.doc(LORA_ID), "pre-trained model weights");
    expect(hits[0]!.block.id).toBe("abstract1.1");
    expect((await run("paper_find", { query: "quantum banana" })).text).toMatch(/^Nothing in the paper matches "quantum banana"/);
  });
});

describe("paper_figure", () => {
  it("attaches a figure's image when the agent reads images, by id or by how the paper calls it", async () => {
    const { run } = await lora();
    const r = await run("paper_figure", { id: "Figure 2" }, true);
    expect(r.text).toBe("[S4.F2] Figure 2: Subspace similarity.\n[image 1 attached: assets/2-qv8_qv64.png]");
    expect(r.images).toEqual([{ mime: "image/png", data: PNG.toString("base64") }]);
    expect((await run("paper_figure", { id: "S4.F2" }, false)).text).toContain("not attached, this agent does not read images");
  });

  it("has the tab draw an SVG figure as JPEG", async () => {
    const { hub, run, emit } = await lora();
    emit.mockClear();
    const pending = run("paper_figure", { id: "S1.F1" }, true);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("reader.render", { paperId: LORA_ID, asset: "assets/1-figure1.svg" }));
    hub.rendered(LORA_ID, { asset: "assets/1-figure1.svg", jpeg: JPEG.toString("base64") });
    const r = await pending;
    expect(r.text).toBe("[S1.F1] Figure 1: Our reparametrization. We only train $A$ and $B$.\n[image 1 attached: assets/1-figure1.svg]");
    expect(r.images).toEqual([{ mime: "image/jpeg", data: JPEG.toString("base64") }]);
    // Drawn once: kept beside the SVG.
    emit.mockClear();
    expect((await run("paper_figure", { id: "Figure 1" }, true)).images).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("gives a table its rows, and lists what there is when the figure is not found", async () => {
    const { run } = await lora();
    expect((await run("paper_figure", { id: "Table 1" })).text).toBe("[S4.T1] Table 1: Trainable parameters.\nMethod | Params\nLoRA | 4.7M");
    const missing = await run("paper_figure", { id: "Figure 9" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("S1.F1: Figure 1: Our reparametrization.");
  });

  it("sends a PDF's reader to paper_page, and an HTML's away from it", async () => {
    const { run } = await lora();
    expect(await run("paper_page", { page: 1 }, true)).toMatchObject({ isError: true, text: expect.stringContaining("There are no pages") });
    const pdf = await pdfPaper();
    pdf.hub.pdfText(pdf.paperId, ["Figure 1: a plot"]);
    expect(await pdf.run("paper_figure", { id: "Figure 1" }, true)).toMatchObject({ isError: true, text: expect.stringContaining("paper_page") });
  });
});

describe("a PDF being read", () => {
  it("waits for the tab to take its text out", async () => {
    const { run } = await pdfPaper();
    for (const [name, args] of [["paper_read", {}], ["paper_find", { query: "attention" }]] as const) {
      expect(await run(name, args)).toMatchObject({ isError: true, text: expect.stringContaining("not taken out yet") });
    }
  });

  it("shows a page drawn by the tab, if the agent reads images and the page is there", async () => {
    const { hub, paperId, run, emit } = await pdfPaper();
    hub.pdfText(paperId, ["Attention Is All You Need", "3 Model Architecture"]);
    expect(await run("paper_page", { page: 1 }, false)).toMatchObject({ isError: true, text: expect.stringContaining("does not read images") });
    expect(await run("paper_page", { page: 5 }, true)).toMatchObject({ isError: true, text: "The PDF has 2 pages." });
    emit.mockClear();
    const pending = run("paper_page", { page: 2 }, true);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("reader.render", { paperId, page: 2 }));
    hub.rendered(paperId, { page: 2, jpeg: JPEG.toString("base64") });
    const r = await pending;
    expect(r.text).toBe('Page 2 of the PDF (cite it as [[page-2]] or [[p2: "exact words"]]).');
    expect(r.images).toEqual([{ mime: "image/jpeg", data: JPEG.toString("base64") }]);
    // Read: the section per page now.
    expect((await run("paper_read", { section: "page-2" })).text).toContain("[page-2] 3 Model Architecture");
  });
});

describe("the tutor's role", () => {
  it("sends its rules once, with the outline, the reader's open questions and where they are", async () => {
    const { hub, tutor } = await lora();
    hub.mark(LORA_ID, "S2", true);
    hub.progress(LORA_ID, "S4.SS1", 1000);
    hub.note(LORA_ID, { note: { kind: "question", text: "Vì sao B = 0?", anchor: { id: "S4.SS1.p2" } } });
    hub.note(LORA_ID, { note: { kind: "note", text: "a note, not a question" } });
    const first = await tutor.prompt({ text: "Bắt đầu thôi", rules: true, recap: "", context: "<ctx/>" } as never);
    expect(first).toContain('You are the reading tutor for the paper "LoRA: Low-Rank Adaptation of Large Language Models" (Edward J. Hu, Yelong Shen, 2021)');
    expect(first).not.toContain("paper_page to look at a PDF page");
    expect(first).toContain("Shown to the reader as arXiv's HTML.");
    expect(first).toContain("✓ [[S2]] 2 Problem Statement");
    expect(first).toContain("  ◐ [[S4.SS1]] 4.1 Low-Rank-Parametrized Update Matrices");
    expect(first).toContain("- Vì sao B = 0? [[S4.SS1.p2]]");
    expect(first).not.toContain("a note, not a question");
    expect(first).toContain("The reader is now in [[S4.SS1]] 4.1 Low-Rank-Parametrized Update Matrices.");
    expect(first.endsWith("<ctx/>\n\nBắt đầu thôi")).toBe(true);

    // Later turns: only where the reader went, and nothing when they stayed.
    expect(await tutor.prompt({ text: "Còn α?", rules: false, recap: "" } as never)).toBe("Còn α?");
    hub.progress(LORA_ID, "A1", 1000);
    const moved = await tutor.prompt({ text: "Và đây?", rules: false, recap: "" } as never);
    expect(moved).toBe("<reader-state>\nThe reader is now in [[A1]] A Large Language Models Still Need Parameter Updates.\n</reader-state>\n\nVà đây?");
  });

  it("tells the tutor of a PDF to look at pages, and how far its text can be trusted", async () => {
    const { hub, paperId, tutor } = await pdfPaper();
    const before = await tutor.prompt({ text: "?", rules: true, recap: "" } as never);
    expect(before).toContain("paper_page to look at a PDF page");
    expect(before).toContain("[[p4: \"exact words from that page\"]]");
    expect(before).toContain("The PDF's text is not taken out yet");
    hub.pdfText(paperId, ["Some title page"]);
    const after = await tutor.prompt({ text: "?", rules: false, recap: "<recap/>" } as never);
    expect(after).toContain("taken out of the PDF (formulas may be garbled: look at the page with paper_page)");
    expect(after).not.toContain("not taken out yet");
  });

  it("turns a selected passage and what the reader wants into their message", async () => {
    const { tutor } = await lora();
    const send = vi.fn();
    const detach = tutor.attach({ closed: () => false, send } as unknown as ChatPort);
    tutor.ask("why", { id: "S4.SS1.p2" }, "We use a random   Gaussian\n initialization for A");
    expect(send).toHaveBeenLastCalledWith("Vì sao?: “We use a random Gaussian initialization for A”", {
      context: '<reader-selection kind="why" anchor="S4.SS1.p2">\nWe use a random Gaussian initialization for A\n</reader-selection>',
    });
    tutor.ask("notation", { id: "S4.E3" }, "h = W0 x + BAx");
    expect(send.mock.lastCall![1].context).toContain('kind="notation" anchor="S4.E3"');
    // An anchor the paper does not have is left out; a long passage is shortened in the message only.
    const long = "word ".repeat(100).trim();
    tutor.ask("example", { id: 'S9"><b' }, long);
    const [text, extra] = send.mock.lastCall!;
    expect(extra.context.startsWith('<reader-selection kind="example">\n')).toBe(true);
    expect(extra.context).toContain(long);
    expect(text).toMatch(/^Ví dụ cụ thể: “(word ){40,}.*…”$/);
    expect(() => tutor.ask("explain", {}, "   ")).toThrow(/Chọn một đoạn/);
    expect(() => tutor.ask("translate" as never, {}, "x")).toThrow(/Không rõ yêu cầu translate/);
    detach();
    expect(() => tutor.ask("explain", {}, "x")).toThrow(/đã đóng/);
  });

  it("puts the page of a PDF's passage on it", async () => {
    const { hub, paperId, tutor } = await pdfPaper();
    hub.pdfText(paperId, ["one", "two", "three"]);
    const send = vi.fn();
    tutor.attach({ closed: () => false, send } as unknown as ChatPort);
    tutor.ask("explain", { id: "page-3", page: 3 }, "three");
    expect(send.mock.lastCall![1].context).toBe('<reader-selection kind="explain" anchor="page-3" page="3">\nthree\n</reader-selection>');
  });

  it("names the paper in the chat's snapshot", async () => {
    const { hub, tutor } = await lora();
    expect(tutor.snapshot()).toEqual({ reader: { paperId: LORA_ID, title: "LoRA: Low-Rank Adaptation of Large Language Models" } });
    expect(new ReaderChat(hub, "gone").snapshot()).toEqual({ reader: { paperId: "gone", title: "gone" } });
  });
});

describe("the tutor in a chat", () => {
  async function tutorChat() {
    const t = await lora();
    const chat = new Chat(1_000_000_001, {
      id: "fake", name: "Fake", builtin: false, toolWaitMs: 50, loginHint: "",
      resolve: () => ({ launch: { command: "fake", args: [] } }),
    }, READER_SETTINGS, {
      notebookOp: vi.fn().mockRejectedValue(new Error("no notebook here")), emit: vi.fn(),
      mcpServer: () => ({ name: "notebook", command: "fake", args: [], env: [] }), workspaceRoot: scratch,
    }, { notebookKey: readerChatKey(LORA_ID), role: t.tutor });
    chats.push(chat);
    return { ...t, chat };
  }

  it("offers the paper's tools only, names the paper, and asks with the selection", async () => {
    const { chat, tutor } = await tutorChat();
    expect(chat.tools().map((t) => t.name)).toEqual([
      "paper_read", "paper_find", "paper_figure", "paper_page", "reader_grade", "reader_misconception", "reader_widget_request",
    ]);
    expect(chat.snapshot().reader).toEqual({ paperId: LORA_ID, title: "LoRA: Low-Rank Adaptation of Large Language Models" });
    expect(readerOf(chat)).toBe(tutor);
    tutor.ask("explain", { id: "S4.SS1.p2" }, "zero for B");
    await chat.whenIdle();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    const sent = agent.prompt.mock.calls[0]![0] as string;
    expect(sent).toContain("<reader>\nYou are the reading tutor");
    expect(sent).toContain('<reader-selection kind="explain" anchor="S4.SS1.p2">\nzero for B\n</reader-selection>');
    expect(sent.endsWith("Giải thích: “zero for B”")).toBe(true);
    const found = await chat.runTool("paper_find", { query: "zero for B" });
    expect(found.text).toContain("[S4.SS1.p2]");
    const offer = await chat.runTool("reader_widget_request", { anchor: "S4.SS1.p2", goal: "Minh họa ma trận B lúc khởi tạo" });
    expect(offer.isError).toBeFalsy();
    expect(tutor.hub.widgets.requests(LORA_ID)).toMatchObject([{ offered: true, anchor: { id: "S4.SS1.p2" } }]);
    expect(tutor.hub.author.status(LORA_ID)).toMatchObject({ state: "idle", queued: 0 });
  });
});
