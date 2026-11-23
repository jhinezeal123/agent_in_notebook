// The tutor of a paper being read (E.4.1): a role the chat takes (chat-role.ts),
// beside the paper's tab rather than a notebook. It reads the paper with its
// own tools, answers with anchors the reader can click, and never touches a
// notebook: the chat reads cells only when a role asks, and this one does not.

import { z } from "zod";
import { READER_ASK_LABEL, type ChatSettings, type ChatSnapshot, type ReaderAnchor, type ReaderAskKind } from "@ainb/protocol";
import type { ChatPort, ChatRole, RoleTurn } from "../chat-role.js";
import { callTool, tool, type ToolContext, type ToolDef, type ToolResult } from "../notebook/tools.js";
import type { ReaderHub } from "./index.js";
import type { ReaderTutorPort } from "./passes.js";
import { READER_TOOLS, sectionOf, type ReaderToolContext, type ReaderToolHost } from "./tools.js";

/** The tutor's fixed mode: no tool that edits anything; the agent's own tools refused. */
export const READER_SETTINGS: ChatSettings = { scope: "auto", review: false, targetCellIds: [], notebookOnly: true };

const QUOTE_MAX = 4000;

const grade = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const readerGrade = tool({
  name: "reader_grade",
  description: "Grade something the reader wrote (their 5C, a recall, an explanation, a QALMRI sheet, the pass summary), as asked in <reader-grade write=…>: 0/1/2 by its rubric, per part when asked, what is missing, and your feedback (the reader sees it under their writing). Grade again only when the reader disputes it.",
  schema: z.object({
    write: z.string().min(1).max(60).describe("The write's id, from <reader-grade write=…>"),
    grade,
    parts: z.array(z.object({ key: z.string().min(1).max(20), grade, note: z.string().max(400).optional() })).max(8).optional(),
    missing: z.array(z.string().min(1).max(300)).max(8).optional().describe("What the reader's writing lacks, briefly"),
    feedback: z.string().min(1).max(2000).describe("Short, in Vietnamese, quoting their words; with [[anchors]]"),
  }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    const w = ctx.reader.hub.passes.grade(ctx.reader.paperId, args.write, args);
    return { text: `Graded ${w.id}: ${args.grade}/2. The reader sees your grade and the reference now.` };
  },
});

const readerMisconception = tool({
  name: "reader_misconception",
  description: "Record a misconception the reader showed about the paper (into the paper's misconception book and Mentor's, which asks it again in two days). Not for a slip or a question.",
  schema: z.object({
    concept: z.string().min(1).max(60).describe("The concept's id from <reader-state> (or a short kebab-case name)"),
    note: z.string().min(1).max(400).describe("What they believe, and what the paper says instead, in Vietnamese"),
  }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    ctx.reader.hub.passes.miss(ctx.reader.paperId, args.concept, args.note);
    return { text: "Recorded in the misconception book." };
  },
});

const offerWidget = tool({
  name: "reader_widget_request",
  description: "Suggest a small interactive numeric example at an exact paper anchor. The author starts once the reader accepts in the reading tab.",
  schema: z.object({ anchor: z.string().trim().min(1).max(120), goal: z.string().trim().min(8).max(200) }),
  async run(ctx: ReaderToolContext, args): Promise<ToolResult> {
    ctx.reader.hub.widgets.request(ctx.reader.paperId, { id: args.anchor }, args.goal, true);
    return { text: "Suggestion added to the reading tab. Invite the reader to accept it there." };
  },
});

/** The tutor's tools: reading the paper, grading the reader's writing, the misconception book. */
export const TUTOR_TOOLS: readonly ToolDef<any, any>[] = [...READER_TOOLS, readerGrade, readerMisconception, offerWidget];

export class ReaderChat implements ChatRole, ReaderToolHost {
  readonly settings = READER_SETTINGS;
  private port?: ChatPort;
  /** The section named in the last turn's state, so an unchanged place is not repeated. */
  private lastAt: string | undefined;
  /** The passes as the last turn's state had them. */
  private lastPasses = "";

  constructor(readonly hub: ReaderHub, readonly paperId: string) {}

  attach(port: ChatPort): () => void {
    this.port = port;
    return () => {
      this.port = undefined;
    };
  }

  snapshot(): Partial<ChatSnapshot> {
    try {
      return { reader: { paperId: this.paperId, title: this.hub.meta(this.paperId).title } };
    } catch {
      return { reader: { paperId: this.paperId, title: this.paperId } };
    }
  }

  async prompt(turn: RoleTurn): Promise<string> {
    const full = turn.rules || !!turn.recap;
    const blocks = [
      turn.rules ? readerPlaybook(this.hub, this.paperId) : "",
      turn.recap,
      this.state(full),
      turn.context ?? "",
      turn.text,
    ];
    return blocks.filter(Boolean).join("\n\n");
  }

  tools(): readonly ToolDef<any, any>[] {
    return TUTOR_TOOLS;
  }

  runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
    return callTool(Object.assign(ctx, { reader: this as ReaderToolHost }), name, args, TUTOR_TOOLS);
  }

  /** Where the reader's writing goes to be graded: this chat, as their message. */
  tutorPort(): ReaderTutorPort {
    const port = this.port;
    if (!port || port.closed()) throw new Error("Chat của paper đã đóng.");
    return { send: (text, context) => port.send(text, { context }) };
  }

  /** What the tutor knows of the reading each turn: where the reader is; the outline and their questions when it needs them again. */
  state(full: boolean): string {
    const view = this.hub.view(this.paperId);
    const lines: string[] = [];
    if (full) {
      lines.push(`Paper: ${view.title}${view.authors ? ` — ${view.authors}` : ""}${view.year ? ` (${view.year})` : ""}${view.arxiv ? `, arXiv ${view.arxiv}` : ""}.`);
      lines.push(`Shown to the reader as ${view.view === "html" ? "arXiv's HTML" : "a PDF"}. Your text of it: ${view.text === "html" ? "from that HTML, formulas as the authors' TeX (exact)" : view.text === "latex" ? "PDF pages; the authors' LaTeX is also there (paper_read latex: true)" : "taken out of the PDF (formulas may be garbled: look at the page with paper_page)"}.`);
      if (view.needsText) lines.push("The PDF's text is not taken out yet (the reading tab is doing it).");
      if (view.sections.length) {
        lines.push("Outline (✓ read by the reader, ◐ started):");
        for (const s of view.sections) lines.push(`${"  ".repeat(s.level - 1)}${s.read ? "✓" : s.readMs > 0 ? "◐" : "·"} [[${s.id}]] ${s.number ? `${s.number} ` : ""}${s.title}`);
      }
      const questions = view.notes.filter((n) => n.kind === "question" && !n.done);
      if (questions.length) {
        lines.push("The reader's open questions (\"Câu hỏi của tôi\"; help with them when it fits, do not answer all at once unasked):");
        for (const q of questions.slice(-10)) lines.push(`- ${q.text.slice(0, 300)}${q.anchor?.id ? ` [[${q.anchor.id}]]` : ""}`);
      }
    }
    if (view.at && (full || view.at !== this.lastAt)) {
      const s = view.sections.find((x) => x.id === view.at);
      if (s) lines.push(`The reader is now in [[${s.id}]] ${s.number ? `${s.number} ` : ""}${s.title}.`);
    }
    this.lastAt = view.at;
    // The passes: what waits for the reader (without its answers), what was answered, what to grade.
    try {
      const passes = this.hub.passes.tutorState(this.paperId);
      const text = passes.join("\n");
      if (full || text !== this.lastPasses) lines.push(...passes);
      this.lastPasses = text;
    } catch {
      // The guide is extra: the tutor still answers about the paper.
    }
    return lines.length ? `<reader-state>\n${lines.join("\n")}\n</reader-state>` : "";
  }

  /** A passage the reader selected, with what they want: sent as their message. */
  ask(kind: ReaderAskKind, anchor: ReaderAnchor, quote: string): void {
    if (!this.port || this.port.closed()) throw new Error("Chat của paper đã đóng.");
    const text = quote.replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX);
    if (!text) throw new Error("Chọn một đoạn trong paper trước đã.");
    const label = READER_ASK_LABEL[kind];
    if (!label) throw new Error(`Không rõ yêu cầu ${kind}.`);
    const doc = this.hub.doc(this.paperId);
    const id = anchor.id && (sectionOf(doc, anchor.id) || doc.equations.some((e) => e.id === anchor.id)) ? anchor.id : undefined;
    const shown = text.length > 220 ? `${text.slice(0, 220)}…` : text;
    const attrs = [`kind="${kind}"`, id ? `anchor="${escapeAttr(id)}"` : "", anchor.page ? `page="${anchor.page}"` : ""].filter(Boolean).join(" ");
    this.port.send(`${label}: “${shown}”`, { context: `<reader-selection ${attrs}>\n${text}\n</reader-selection>` });
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[<>"&]/g, "");
}

/** The tutor's rules: sent once per agent session, and again after a compaction. */
export function readerPlaybook(hub: ReaderHub, paperId: string): string {
  const meta = hub.meta(paperId);
  const pdf = meta.view === "pdf";
  return `<reader>
You are the reading tutor for the paper "${meta.title}"${meta.authors ? ` (${meta.authors}${meta.year ? `, ${meta.year}` : ""})` : ""}. The paper is open in the reader's tab beside this chat; the reader wants to understand it in depth, not to get a summary.

Language: answer in Vietnamese. Keep technical terms in English, and give a term's meaning in Vietnamese the first time it comes up. Quote the paper in its own words (English).

Ground what you say in the paper:
- Read before you answer: paper_find for words or a phrase, paper_read for a section (by its id), paper_figure for a figure or table${pdf ? ", paper_page to look at a PDF page (formulas taken out of a PDF are often garbled: look at the page before explaining a formula)" : ""}. Do not answer about the paper from memory.
- After each statement about the paper, put an anchor the reader can click: [[S4.SS1]] a section, [[S4.SS1.p2]] a paragraph, [[S2.E1]] an equation, [[S1.F1]] a figure, [[S3.T1]] a table${pdf ? ", [[page-4]] a page, [[p4: \"exact words\"]] a phrase on a page" : ", [[S4.SS1.p2: \"exact words\"]] a phrase in a paragraph"}. Use only ids that appear in your tool results. Quoted words must be the paper's exact words, at most ~15 of them.
- Keep apart what the paper says (anchored), what you know from outside the paper (start it with "Ngoài paper:"), and your own inference ("Suy luận:"). Say so when the paper does not say something.

When the reader selects a passage, it comes as <reader-selection kind=… anchor=…>, and the message says what they want:
- Giải thích (explain): what it says in plain words, then the role it plays in the paper's argument, tied to what came before it.
- Ví dụ cụ thể (example): a small worked example with concrete numbers (tiny shapes, 2–4 dimensions), step by step and computed correctly; say what each number stands for.
- Ký hiệu (notation): every symbol in it: meaning, type or shape, and where the paper defines it (anchor); point out symbols the paper never defines.
- Vì sao? (why): the problem this choice solves, an alternative the authors could have taken, and what would go wrong without it; anchor the paper's own reasons and mark yours as inference.

Tasks waiting for the reader (<reader-state> lists them: their 5C, a recall, an explanation, a checkpoint question, a QALMRI sheet): do not give their answers, the right option, or the reference. Asked for help with one, go up the hint ladder one rung at a time — 0 a guiding question, 1 a direction, 2 part of the explanation, 3 the full explanation with an example — and say the reader can press "Cho xem luôn" to see the answer. Everything else you explain fully and directly. Questions already answered you may discuss freely.

When the reader's writing comes with <reader-grade write=…>, grade it by its rubric and call reader_grade: quote their own words for each point, tell restating from explaining (saying why, tying it to what they know), say exactly what is missing with anchors, then ask one follow-up question on the biggest gap rather than handing over the full answer; show the reference after your feedback. Build on what they wrote; do not lecture from scratch.

When an answer or a message shows a misconception about the paper (not a slip), record it with reader_misconception.

Style: short paragraphs; formulas in $…$ and $$…$$ (they are rendered); about 250 words at most unless the reader asks for more. Build on what the reader asked instead of retelling the whole section. When it helps, end with one short question that makes the reader think about the passage (why, what if), not a question of trivia.

You read here and grade the reader's writing; you do not edit files or run code.
</reader>`;
}

/** The chat's paper tutor, if it is one. */
export function readerOf(chat: { readonly role?: ChatRole | undefined }): ReaderChat | undefined {
  return chat.role instanceof ReaderChat ? chat.role : undefined;
}
