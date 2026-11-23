// Easy-read through the bridge, as the VS Code reading tab and its chat use
// it: open a PDF, give it its text, open the paper's tutor, ask about a
// passage, and let the tutor read the paper and look at a page the tab draws
// (ER-1); choose a goal and let hidden chats write the map and a checkpoint,
// answer, write and be graded (ER-2). The agent is the scripted fake one
// (fixtures/fake-agent.mjs) and its tools go through the real MCP relay. No
// network: PDFs from disk, not arXiv.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSnapshot, ReaderGuide, ReaderLibraryItem, ReaderView } from "@ainb/protocol";
import { itemId, rightChoice, type ItemInput } from "../src/reader/items.js";
import { Bridge } from "../src/server.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";
import { JPEG } from "./fixtures/reader/fake-arxiv.js";

const TOKEN = "test-token-reader-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
const NO_ORX = { knownPorts: [], locate: () => ({ missing: "OpenResearch not used." }) };
/** The reading tab's chat: a tab id of its own, apart from notebooks (> 0, small) and Chrome tabs (< 0). */
const READER_TAB = 1_000_000_001;

let home: string;
let bridge: Bridge;
let port: number;
let editor: FakeExtension;
let paperId: string;
const events: { event: string; params: any }[] = [];

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ainb-reader-bridge-"));
  process.env.AINB_HOME = home;
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 3 }]));
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: NO_ORX, log: () => {} });
  port = await bridge.listen();
  editor = new FakeExtension(new FakeNotebook([]), 300);
  await editor.connect(port, TOKEN);
  for (const event of ["reader.updated", "reader.render", "mentor.updated"]) editor.rpc.on(event, (params: unknown) => events.push({ event, params }));
}, 60_000);

afterAll(async () => {
  editor?.close();
  await bridge?.close();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* windows child exit */ }
});

async function turn(chatId: string, text: string): Promise<string> {
  const before = editor.statuses.length;
  await editor.request("chat.send", { chatId, text });
  await editor.waitFor(() => editor.statuses.slice(before).some((s) => s === "idle" || s === "error"), 60_000, "turn end");
  return editor.agentText();
}

describe("easy-read through the bridge", () => {
  it("opens a PDF from disk, takes its text from the tab, and puts it on Mentor's shelf", async () => {
    const pdf = join(home, "Attention_Is_All_You_Need.pdf");
    writeFileSync(pdf, "%PDF-1.7\n% the paper\n");
    const opened = await editor.request<ReaderView>("reader.open", { source: { pdfPath: pdf } });
    paperId = opened.paperId;
    expect(opened).toMatchObject({ view: "pdf", needsText: true, title: "Attention Is All You Need" });
    expect(opened.dir).toBe(join(home, "mentor", "papers", paperId, "reader"));

    const view = await editor.request<ReaderView>("reader.pdfText", {
      paperId,
      pages: ["Attention Is All You Need\narXiv:1706.03762v7 [cs.CL]", "3 Model Architecture\nWe use scaled dot-product attention."],
    });
    expect(view.sections.map((s) => s.id)).toEqual(["page-1", "page-2"]);
    expect(view.arxivHint).toBe("1706.03762v7");
    await editor.waitFor(() => events.some((e) => e.event === "reader.updated" && e.params.paperId === paperId), 5000, "reader.updated");
    // On the shelf, not yet a workshop: Mentor shows it, and its text is the paper's.
    const paper = JSON.parse(readFileSync(join(home, "mentor", "papers", paperId, "paper.json"), "utf8"));
    expect(paper).toMatchObject({ title: "Attention Is All You Need", status: "shelved" });
    expect(readFileSync(join(home, "mentor", "papers", paperId, "source.md"), "utf8")).toContain("[page-2] 3 Model Architecture");
    await editor.waitFor(() => events.some((e) => e.event === "mentor.updated"), 5000, "mentor.updated");

    const list = await editor.request<{ papers: ReaderLibraryItem[] }>("reader.list", {});
    expect(list.papers).toEqual([expect.objectContaining({ paperId, view: "pdf", read: 0, total: 2 })]);
  });

  it("keeps what the reader did: time, marks, notes", async () => {
    await editor.request("reader.progress", { paperId, section: "page-2", ms: 30_000 });
    const marked = await editor.request<ReaderView>("reader.mark", { paperId, section: "page-1", read: true });
    expect(marked.sections.find((s) => s.id === "page-1")!.read).toBe(true);
    expect(marked.at).toBe("page-2");
    const noted = await editor.request<ReaderView>("reader.note", { paperId, note: { kind: "question", text: "Vì sao chia cho √d_k?", anchor: { id: "page-2", page: 2 } } });
    expect(noted.notes).toEqual([expect.objectContaining({ kind: "question", text: "Vì sao chia cho √d_k?" })]);
    expect((await editor.request<ReaderView>("reader.get", { paperId })).notes).toHaveLength(1);
  });

  it("says what is wrong with a request it cannot do", async () => {
    await expect(editor.request("reader.open", { source: {} })).rejects.toThrow(/Cần link arXiv, file PDF/);
    await expect(editor.request("reader.open", { source: { pdfPath: join(home, "missing.pdf") } })).rejects.toThrow(/ENOENT|no such file/);
    await expect(editor.request("reader.get", { paperId: "nope" })).rejects.toThrow(/Không có paper nope/);
    await expect(editor.request("chat.open", { tabId: READER_TAB + 9, agentId: "fake", settings: { scope: "auto", review: false, targetCellIds: [] }, reader: { paperId: "nope" } })).rejects.toThrow(/Không có paper nope/);
    await expect(editor.request("reader.ask", { chatId: "gone", kind: "explain", anchor: {}, quote: "x" })).rejects.toThrow(/no longer exists/);
  });

  it("opens the paper's tutor, which reads the paper with its own tools and never the notebook's", async () => {
    const snap = await editor.request<ChatSnapshot>("chat.open", {
      tabId: READER_TAB, agentId: "fake", settings: { scope: "write", review: true, targetCellIds: [] }, reader: { paperId },
    });
    expect(snap.reader).toEqual({ paperId, title: "Attention Is All You Need" });
    // The role's fixed mode, whatever the panel sent.
    expect(snap.settings).toMatchObject({ scope: "auto", review: false, notebookOnly: true });
    await editor.waitFor(() => editor.statuses.includes("idle"), 30_000, "agent start");

    const text = await turn(snap.chatId, script([{ tool: "paper_find", args: { query: "scaled dot-product" } }, { tool: "notebook_info", args: {} }]));
    expect(text).toContain("[saw reader playbook]");
    expect(text).toContain("RESULT paper_find: [page-2] in Trang 2 · 3 Model Architecture [[page-2]] (page)\n");
    expect(text).toContain("RESULT notebook_info (error): Unknown tool notebook_info.");
  });

  it("asks about a selected passage, and draws a page for the tutor through the tab", async () => {
    const snap = await editor.request<ChatSnapshot>("chat.open", { tabId: READER_TAB, agentId: "fake", settings: { scope: "auto", review: false, targetCellIds: [] }, reader: { paperId } });
    const before = editor.statuses.length;
    await editor.request("reader.ask", { chatId: snap.chatId, kind: "why", anchor: { id: "page-2", page: 2 }, quote: "We use scaled dot-product attention." });
    await editor.waitFor(() => editor.statuses.slice(before).includes("idle"), 30_000, "ask turn");
    expect(editor.agentText()).toContain('[saw <reader-selection kind="why" anchor="page-2" page="2">]');

    // The tutor looks at page 2: the bridge asks the tab, the tab sends a JPEG back.
    const drawn = new Promise<void>((done) => {
      editor.rpc.on("reader.render", (p: { paperId: string; page?: number }) => {
        void editor.request("reader.rendered", { paperId: p.paperId, page: p.page, jpeg: JPEG.toString("base64") }).then(() => done());
      });
    });
    const text = await turn(snap.chatId, script([{ tool: "paper_page", args: { page: 2 } }]));
    await drawn;
    expect(text).toContain(`IMAGES 1 image/jpeg:${JPEG.toString("base64").length}`);
    expect(text).toContain('RESULT paper_page: Page 2 of the PDF (cite it as [[page-2]]');
    expect(existsSync(join(home, "mentor", "papers", paperId, "reader", "pages", "2.jpg"))).toBe(true);
  });
});

describe("passes 1–2 through the bridge (ER-2)", () => {
  const TAB = READER_TAB + 1;
  const ev = (page: number, quote: string) => [{ anchor: `page-${page}`, quote }];
  const ARCH = "We use scaled dot-product attention.";
  const BLEU = "The Transformer reaches 28.4 BLEU on English-to-German.";
  const opt = (text: string, correct: boolean, why: string) => ({ text, correct, why });
  const ITEMS: ItemInput[] = [
    { concept: "scaled-dot", bloom: "understand", kind: "mcq", stem: "Transformer dùng loại attention nào trong kiến trúc của nó?", options: [opt("Scaled dot-product", true, "Đúng như mục 3"), opt("Additive attention", false, "Nhầm với attention của Bahdanau"), opt("Hard attention", false, "Nhầm với attention chọn một vị trí")], evidence: ev(3, ARCH), explain: "Mục 3 [[page-3]].", difficulty: 2 },
    { concept: "attention", bloom: "apply", kind: "mcq", stem: "Với một query, bước đầu tiên để tính trọng số của scaled dot-product là gì?", options: [opt("Nhân vô hướng query với từng key", true, "Dot-product"), opt("Cộng query với key rồi qua tanh", false, "Nhầm với additive attention"), opt("Lấy trung bình các value", false, "Bỏ qua bước so khớp query–key")], evidence: ev(3, ARCH), explain: "Dot-product [[page-3]].", difficulty: 3 },
    { concept: "attention", bloom: "remember", kind: "mcq", stem: "Cơ chế được mục Model Architecture nêu tên là cơ chế gì?", options: [opt("Attention", true, "Đúng tên"), opt("Convolution", false, "Nhầm với mô hình CNN"), opt("Recurrence", false, "Nhầm với mô hình RNN")], evidence: ev(3, ARCH), explain: "[[page-3]].", difficulty: 1 },
  ];
  const MAP = {
    roles: [{ anchor: "page-2", role: "objective" }, { anchor: "page-3", role: "method" }, { anchor: "page-4", role: "result" }],
    fivec: { category: "Kiến trúc mới.", context: "RNN và attention.", correctness: "Hợp lý.", contributions: "Transformer chỉ dùng attention [[page-3]].", clarity: "Rõ." },
    concepts: [{ id: "attention", name: "Attention" }, { id: "scaled-dot", name: "Scaled dot-product" }, { id: "bleu", name: "BLEU" }],
    notation: [{ symbol: "d_k", meaning: "số chiều của key" }],
    background: [],
    pretest: [
      { section: "page-3", stem: "Đoán xem Transformer dùng loại attention nào?", answer: "Scaled dot-product.", explain: "[[page-3]]", evidence: ev(3, ARCH) },
      { section: "page-4", stem: "Đoán điểm BLEU Anh–Đức của Transformer?", answer: "28.4", explain: "[[page-4]]", evidence: ev(4, BLEU) },
    ],
    units: [{ title: "Introduction", sections: ["page-1", "page-2"] }, { title: "Model Architecture", sections: ["page-3"] }, { title: "Results", sections: ["page-4"] }],
  };
  let id2: string;
  let tutorId: string;
  const guide = () => editor.request<ReaderGuide>("reader.guide", { paperId: id2 });
  const settled = async (what: string, ok: (g: ReaderGuide) => boolean) => {
    const end = Date.now() + 60_000;
    let g = await guide();
    while (!(ok(g) && g.author.state !== "running")) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(g.author)}`);
      await new Promise((r) => setTimeout(r, 100));
      g = await guide();
    }
    return g;
  };

  beforeAll(async () => {
    const pdf = join(home, "transformer.pdf");
    writeFileSync(pdf, "%PDF-1.7\n% another paper\n");
    id2 = (await editor.request<ReaderView>("reader.open", { source: { pdfPath: pdf } })).paperId;
    await editor.request("reader.pdfText", { paperId: id2, title: "The Transformer", pages: ["The Transformer", "1 Introduction\nRecurrent models are slow to train on long sequences.", `3 Model Architecture\n${ARCH}`, `5 Results\n${BLEU}`] });
    const L = "ABC";
    const answers = ITEMS.map((i) => {
      const item = { ...i, id: itemId("page-3", i), unit: "page-3" };
      return { id: item.id, bloom: i.bloom, options: rightChoice(item).options!.map((n) => L[n]), note: "from the passage" };
    });
    const scripts = {
      "reader:map": [{ tool: "reader_map_write", args: MAP }],
      "reader:checkpoint:page-1": [{ tool: "reader_items_write", args: { unit: "page-1", guide: "Paper giải bài toán gì?", light: "Chỉ mở đầu.", points: [{ text: "RNN chậm", anchor: "page-2" }, { text: "Cần song song", anchor: "page-2" }], items: [] } }],
      "reader:checkpoint:page-3": [{ tool: "reader_items_write", args: { unit: "page-3", guide: "Attention được tính thế nào?", points: [{ text: "Scaled dot-product attention", anchor: "page-3" }, { text: "Không dùng recurrence", anchor: "page-3" }], items: ITEMS } }],
      "reader:check": [{ tool: "reader_check_write", args: { answers } }],
    };
    const file = join(home, "fake-reader-author.json");
    writeFileSync(file, JSON.stringify(scripts));
    process.env.FAKE_AUTHOR = file;
  }, 60_000);

  afterAll(() => {
    delete process.env.FAKE_AUTHOR;
  });

  it("writes the map in a hidden chat once the reader chooses a goal; the editor hears nothing of that chat", async () => {
    const before = editor.snapshots.length;
    const chosen = await editor.request<ReaderGuide>("reader.goal", { paperId: id2, goal: "use", agentId: "fake" });
    expect(chosen.author.state).toBe("running");
    const g = await settled("the map", (x) => x.map.has.pretest);
    expect(g.map.has).toEqual({ roles: true, fivec: true, concepts: true, notation: true, background: true, pretest: true, units: true });
    expect(g.units.map((u) => [u.id, u.title, u.state])).toEqual([["page-1", "Introduction", "waiting"], ["page-3", "Model Architecture", "waiting"], ["page-4", "Results", "waiting"]]);
    expect(editor.snapshots.slice(before).every((sn) => sn.tabId > -1_000_000_000)).toBe(true);
    expect(editor.agentText()).not.toContain("[saw reader-author playbook]");
  });

  it("writes the first checkpoints in pass 2, checked blind by another hidden chat", async () => {
    await editor.request("reader.pass", { paperId: id2, pass: 2, agentId: "fake" });
    const g = await settled("the checkpoints", (x) => x.units.filter((u) => u.state === "ready").length === 2);
    expect(g.passed).toEqual([1]);
    expect(g.units.map((u) => [u.id, u.state, u.items.length])).toEqual([["page-1", "ready", 0], ["page-3", "ready", 3], ["page-4", "waiting", 0]]);
    const pack = JSON.parse(readFileSync(join(home, "mentor", "papers", id2, "reader", "items", "page-3.json"), "utf8"));
    expect(pack.checked).toBe(true);
  });

  it("keeps a waiting question's answer out of the tutor's prompt, until it is answered", async () => {
    const snap = await editor.request<ChatSnapshot>("chat.open", { tabId: TAB, agentId: "fake", settings: { scope: "auto", review: false, targetCellIds: [] }, reader: { paperId: id2 } });
    tutorId = snap.chatId;
    await editor.waitFor(() => editor.snapshots.some((x) => x.chatId === tutorId), 30_000, "tutor");
    let text = await turn(tutorId, "ECHO_PROMPT");
    let prompt = text.slice(text.lastIndexOf("[prompt]"));
    const first = (await guide()).units[1]!.items[0]!;
    expect(prompt).toContain(`question ${first.id} (Model Architecture): “Transformer dùng loại attention nào`);
    expect(prompt).not.toContain("Đúng như mục 3");
    expect(prompt).not.toMatch(/right answer: Scaled dot-product/);
    const answered = await editor.request<{ result: { correct: boolean; points: number } }>("reader.answer", { paperId: id2, item: first.id, choice: { options: [first.options!.indexOf("Scaled dot-product")] }, confidence: 3 });
    expect(answered.result).toMatchObject({ correct: true, points: 3 });
    text = await turn(tutorId, "ECHO_PROMPT");
    prompt = text.slice(text.lastIndexOf("[prompt]"));
    expect(prompt).toContain("right (sure 3/3); right answer: Scaled dot-product");
  });

  it("sends the reader's recall to the tutor with its reference; the tutor's grade opens the key points", async () => {
    const before = editor.statuses.length;
    const { id, graded } = await editor.request<{ id: string; graded: boolean }>("reader.write", { paperId: id2, chatId: tutorId, kind: "recall", unit: "page-3", text: "Transformer dùng scaled dot-product attention." });
    expect(graded).toBe(true);
    await editor.waitFor(() => editor.statuses.slice(before).includes("idle"), 30_000, "grading turn");
    expect(editor.agentText()).toContain("[saw reader-grade recall]");
    expect((await guide()).units[1]!.points).toBeUndefined();
    const text = await turn(tutorId, script([{ tool: "reader_grade", args: { write: id, grade: 2, feedback: "Đủ ý chính [[page-3]]." } }]));
    expect(text).toContain(`RESULT reader_grade: Graded ${id}: 2/2.`);
    const unit = (await guide()).units[1]!;
    expect(unit.recall).toMatchObject({ grade: 2, feedback: "Đủ ý chính [[page-3]]." });
    expect(unit.points!.map((p) => p.text)).toEqual(["Scaled dot-product attention", "Không dùng recurrence"]);
  });
});
