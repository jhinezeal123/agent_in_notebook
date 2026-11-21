// Mentor in a chat: the tutor of an exercise (`MentorChat`) and a paper's
// workshop (`WorkshopChat`). Both are roles the chat takes (chat-role.ts);
// everything the chat does differently for Mentor is in this file.

import type { CellRun, ChatSettings, ChatSnapshot, MentorResult, MentorVerdict } from "@ainb/protocol";
import type { ChatPort, ChatRole, RoleRunCard, RoleTurn } from "../chat-role.js";
import { runDuration } from "../instructions.js";
import { callTool, type ToolContext, type ToolDef, type ToolResult } from "../notebook/tools.js";
import { judgeCode, kernelProblem, newNonce, parseVerdict } from "./judge.js";
import { isSolutionCell } from "./notebook.js";
import { codeReviewBlock, hintBlock, hintText, learnerCells, mentorPlaybook, mentorState, verdictBlock } from "./prompt.js";
import { StageRefused, type MentorSession } from "./session.js";
import { MENTOR_CHAT_TOOLS } from "./tools.js";
import type { WorkshopSession } from "./workshop.js";

/** A Mentor chat's fixed mode: the agent may run scratch code; it has no tool that edits the notebook. */
export const MENTOR_SETTINGS: ChatSettings = { scope: "auto", review: false, targetCellIds: [], notebookOnly: true };

/** The chat beside a Mentor exercise: the agent coaches, the learner writes every line. */
export class MentorChat implements ChatRole {
  readonly settings = MENTOR_SETTINGS;
  private port!: ChatPort;
  /** The learner's cells as the agent last saw them. */
  private lastLearnerCells = "";

  constructor(readonly session: MentorSession) {}

  attach(port: ChatPort): () => void {
    this.port = port;
    const attemptId = this.session.attemptId;
    return this.session.mentor.subscribe((id) => {
      if (id === attemptId && !port.closed()) port.emit("chat.mentor", { chatId: port.chatId, tabId: port.tabId, mentor: this.session.view() });
    });
  }

  snapshot(): Partial<ChatSnapshot> {
    return { mentor: this.session.view() };
  }

  /** Its own rules, the exercise's state, and the learner's cells when they changed. */
  async prompt(turn: RoleTurn): Promise<string> {
    const s = this.session;
    const cells = await turn.cells();
    const blocks: string[] = [];
    if (turn.rules) blocks.push(mentorPlaybook(s.exercise, s.attempt.kind, s.view().variantOf));
    const full = turn.rules || !!turn.recap;
    if (turn.recap) blocks.push(turn.recap);
    const activity = turn.activity();
    if (activity) blocks.push(activity);
    if (turn.context) blocks.push(turn.context);
    const attached = await turn.attached();
    if (attached) blocks.push(attached);
    const seen = cells ? learnerCells(cells) : null;
    const shown = seen === null
      ? "The notebook could not be read this turn."
      : full || seen !== this.lastLearnerCells ? seen : "The learner's sketch and solution cells are unchanged since your last turn.";
    if (seen !== null) this.lastLearnerCells = seen;
    blocks.push(mentorState(s, shown, full ? s.mentor.learnerSummary(s.attemptId) : ""));
    blocks.push(turn.text);
    return blocks.join("\n\n");
  }

  tools(): readonly ToolDef<any, any>[] {
    return MENTOR_CHAT_TOOLS;
  }

  runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
    const s = this.session;
    const before = s.attempt.result;
    return callTool(Object.assign(ctx, { mentor: s }), name, args, MENTOR_CHAT_TOOLS).then((r) => {
      const after = s.attempt.result;
      if (after && !before) this.showResult(after);
      return r;
    });
  }

  /** A Mentor chat never fixes the learner's code: the mentor helps them find the bug. */
  readonly failedRun = {
    explain: "Hỏi mentor",
    dismiss: "Bỏ qua",
    ask: (run: CellRun) => `Cell [${run.index}] bị lỗi. Gợi ý giúp mình tìm ra lỗi (đừng sửa hộ).`,
  };

  /** An experiment's long cell finished (training, most likely): the judge measures what it left in the kernel. */
  longRun(run: CellRun): RoleRunCard | null {
    const s = this.session;
    if (s.exercise.role !== "experiment" || s.stage === "done") return null;
    return {
      title: `Cell [${run.index}] chạy xong · ${runDuration(run.durationMs ?? 0)}`,
      detail: "Train xong thì bấm Chấm bài: máy chấm đo trên mô hình đang nằm trong máy.",
      actions: [{ id: "judge", label: "Chấm bài", primary: true }, { id: "dismiss", label: "Bỏ qua" }],
      done: "Đã chấm bài",
      act: () => void this.judge().catch((e) => this.port.system((e as Error).message)),
    };
  }

  /** "Chấm bài": run the exercise's hidden tests on the learner's cells, show the verdict, and let the mentor react. */
  async judge(): Promise<void> {
    const s = this.session;
    const port = this.port;
    if (port.busy()) throw new Error("Đợi mentor trả lời xong (hoặc bấm dừng) rồi hãy chấm bài.");
    const card = port.addCard({ kind: "mentor", tone: "info", title: "Đang chấm bài…", actions: [] }, () => {});
    let verdict: MentorVerdict;
    let judged = "";
    try {
      verdict = await port.job(async () => {
        const { cells } = await port.call({ op: "get_cells" });
        const source = cells.filter((c) => isSolutionCell(c)).map((c) => c.source).join("\n\n");
        if (!source.trim()) {
          return { at: Date.now(), ok: false, passed: 0, total: 0, tests: [], error: "Không thấy cell bài làm (cell bắt đầu bằng dòng `#| mentor: solution`)." };
        }
        judged = source;
        const nonce = newNonce();
        const waitMs = s.exercise.judgeSeconds * 1000;
        const code = judgeCode(s.exercise, source, nonce, s.mentor.judgeContext(s.exercise));
        const res = await port.exclusive("run", () => port.call({ op: "execute", code, waitMs }, waitMs + 30_000));
        if (res.status === "running") await port.call({ op: "interrupt" }).catch(() => {});
        return parseVerdict(res, nonce);
      });
    } catch (e) {
      card.title = "Chưa chấm được";
      port.closeCard(card.cardId, "done", kernelProblem((e as Error).message), "error");
      return;
    }
    if (port.closed()) return;
    // A passing solution is what later exercises build on.
    if (verdict.ok && judged) s.mentor.store.saveSolution(s.exercise.id, judged);
    const result = s.judged(verdict);
    card.title = verdict.missing ? "Thiếu thư viện" : verdict.error ? "Bài làm chưa chạy được" : `Đạt ${verdict.passed}/${verdict.total} test`;
    card.tone = verdict.ok ? "ok" : "error";
    card.mentor = { type: "verdict", verdict };
    port.closeCard(card.cardId, "done");
    if (result) this.showResult(result);
    port.send("Chấm bài", { context: verdictBlock(verdict, s.stage, s.exercise) });
  }

  /** "Xin gợi ý": one hint level up, and the mentor gives a hint at it. */
  hint(): number {
    const s = this.session;
    if (s.stage === "done") throw new Error("Bài đã xong.");
    const level = s.raiseHint();
    this.port.send(hintText(level), { context: hintBlock(s.exercise, level) });
    return level;
  }

  /** "Nhận xét code": once the exercise is done, the mentor reviews the solution (no effect on the rating). */
  codeReview(): void {
    const s = this.session;
    if (s.stage !== "done") throw new Error("Nhận xét code mở ra sau khi xong bài.");
    if (this.port.busy()) throw new Error("Đợi mentor trả lời xong rồi hãy xin nhận xét.");
    this.port.send("Nhận xét code giúp mình", { context: codeReviewBlock(s.exercise) });
  }

  /** The learner moved the exercise on themself (skipping the lab, say). */
  stage(stage: Parameters<MentorSession["setStage"]>[0]): void {
    try {
      const result = this.session.setStage(stage, "user");
      if (result) this.showResult(result);
    } catch (e) {
      if (e instanceof StageRefused) throw new Error(e.message);
      throw e;
    }
  }

  /** The attempt is done: its rating change and the streak, as a card (and persist snapshot for C5). */
  private showResult(result: MentorResult): void {
    const s = this.session;
    const streak = s.mentor.status().streak;
    // Persist completed attempt snapshot (verdict + code) so attempt history survives 30-day chat prune.
    const learnerCode = s.mentor.store.solution(s.exercise.id) ?? s.mentor.store.work(s.attemptId)?.solution.join("\n\n") ?? undefined;
    s.mentor.store.saveAttemptSnapshot(s.attemptId, {
      savedAt: Date.now(),
      ...(s.verdict ? { verdict: s.verdict } : {}),
      ...(learnerCode ? { learnerCode } : {}),
    });
    const gained = result.deltas.reduce((sum, d) => sum + d.after - d.before, 0);
    const kindLabel = s.attempt.kind === "review" ? "Ôn xong" : s.attempt.kind === "interview" ? "Xong phỏng vấn" : "Xong bài";
    const card = this.port.addCard({
      kind: "mentor",
      tone: "ok",
      title: `${kindLabel}${result.revealed ? " (đã xem lời giải mẫu)" : ` · ${gained >= 0 ? "+" : ""}${gained} rating`}`,
      actions: [],
      mentor: { type: "result", result, streak },
    }, () => {});
    this.port.closeCard(card.cardId, "done");
  }
}

/** The chat of a paper's workshop: the agent plans the paper's reproduction (or, hidden, writes its exercises). */
export class WorkshopChat implements ChatRole {
  readonly settings = MENTOR_SETTINGS;

  constructor(readonly session: WorkshopSession) {}

  attach(port: ChatPort): () => void {
    const ws = this.session;
    return ws.hub.subscribe((paperId) => {
      if (paperId === ws.paperId && !port.closed() && ws.role === "plan") port.emit("chat.workshop", { chatId: port.chatId, tabId: port.tabId, workshop: ws.view() });
    });
  }

  snapshot(): Partial<ChatSnapshot> {
    if (this.session.role !== "plan") return {};
    try {
      return { workshop: this.session.view() };
    } catch {
      return {};
    }
  }

  async prompt(turn: RoleTurn): Promise<string> {
    const blocks = [turn.rules ? this.session.playbook() : "", turn.recap, this.session.state(), turn.context ?? "", turn.text];
    return blocks.filter(Boolean).join("\n\n");
  }

  tools(): readonly ToolDef<any, any>[] {
    return this.session.tools();
  }

  runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
    return callTool(Object.assign(ctx, { workshop: this.session }), name, args, this.session.tools());
  }
}

/** A chat, as far as these lookups need it. */
type HasRole = { readonly role?: ChatRole | undefined };

/** The chat's Mentor exercise, if it is one's. */
export function mentorOf(chat: HasRole): MentorChat | undefined {
  return chat.role instanceof MentorChat ? chat.role : undefined;
}

/** The same, for a request that only makes sense in an exercise's chat. */
export function requireMentor(chat: HasRole): MentorChat {
  const m = mentorOf(chat);
  if (!m) throw new Error("Chat này không phải một bài Mentor.");
  return m;
}

/** The chat's paper workshop, if it is one's. */
export function workshopOf(chat: HasRole): WorkshopSession | undefined {
  return chat.role instanceof WorkshopChat ? chat.role.session : undefined;
}
