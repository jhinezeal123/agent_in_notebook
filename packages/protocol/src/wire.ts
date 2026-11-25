// Messages between the extension (background service worker) and the bridge,
// carried as JSON over one WebSocket. Both sides send requests, responses and
// events with the same envelope.

import type { ChatImageMime } from "./chat-image.js";
import type { MentorAttemptDetail, MentorCardBody, MentorChat, MentorHome, MentorKind, MentorPaper, MentorPlace, MentorStage, MentorWorkshop } from "./mentor.js";
import type { ChatSettings } from "./modes.js";
import type { ReaderAnchor, ReaderAgentMode, ReaderAnswerResult, ReaderAskKind, ReaderCardGrade, ReaderCardView, ReaderChat, ReaderChoice, ReaderGoal, ReaderGuide, ReaderLibraryItem, ReaderNote, ReaderPass, ReaderSettings, ReaderView, ReaderWriteKind } from "./reader.js";
import type { AppliedChange, CellRun, NotebookEvent, NotebookInfo, NotebookOp, Platform, ReviewInfo } from "./notebook.js";

export const BRIDGE_DEFAULT_PORT = 47821;
export const WIRE_VERSION = 6;

// ---------------------------------------------------------------- native messaging

/** The name `ainb install` registers the bridge under as a browser native messaging host. */
export const NATIVE_HOST = "com.agent_in_notebook.bridge";
/** The extension's ID, fixed by the `key` in its manifest. */
export const EXTENSION_ID = "mkdjlgboacefhokakjlobfailhipgklf";

/** One request to the native host: start the bridge if needed and say how to reach it. */
/** `start: false`: only report a running bridge (the browser); otherwise start it if needed (VS Code). */
export type NativeRequest = { type: "connect"; start?: boolean };
export type NativeReply =
  | { ok: true; port: number; token: string; version: string; started: boolean }
  | { ok: false; error: string; log?: string; notRunning?: boolean };

export type Envelope =
  | { kind: "req"; id: number; method: string; params: unknown }
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: string }
  | { kind: "evt"; method: string; params: unknown };

// ---------------------------------------------------------------- agents

export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  /** Why the agent cannot be used (not installed, ...). */
  reason?: string;
  /** How the agent is launched, for display. */
  command: string;
  builtin: boolean;
  /** Editable launch command for a saved custom agent. */
  launchCommand?: string;
}

/** A selectable agent setting (model, reasoning effort, agent mode) exposed over ACP. */
export interface AgentOption {
  id: string;
  name: string;
  category?: string | null;
  kind: "select" | "boolean";
  value: string | boolean;
  choices?: { value: string; name: string; description?: string | null }[];
  /** ACP session modes are set with session/set_mode rather than set_config_option. */
  viaMode?: boolean;
}

// ---------------------------------------------------------------- chat model

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** `discarded`: the page reloaded or navigated away before the user decided; nothing was applied. */
export type ReviewStatus = "pending" | "accepted" | "rejected" | "discarded";

/** Something that happened, with what the user can do about it. The bridge writes every text. */
export interface ChatCard {
  cardId: string;
  kind: "run" | "verify" | "mentor";
  tone: "error" | "info" | "ok";
  title: string;
  /** One or two lines of plain text. */
  detail?: string;
  /** A cell the card is about: the UI offers to show it in the notebook. */
  cellId?: string;
  actions: { id: string; label: string; primary?: boolean }[];
  /** `stale`: nothing can be done with it any more (a later run replaced it, or the chat was restored). */
  state: "open" | "done" | "stale";
  /** What became of it, shown in place of the buttons ("Asked the agent to fix it"). */
  outcome?: string;
  /** The user dismissed it: the chat no longer shows it. */
  dismissed?: boolean;
  /** For a job in progress. */
  progress?: { done: number; total: number };
  /** What a Mentor card shows (kind "mentor"). */
  mentor?: MentorCardBody;
}

/** A cell the user attached to a message: what they ask about, or want changed. */
export interface AttachedCell {
  cellId: string;
  /** Its position when it was attached (0-based). */
  index: number;
  /** The first line of its source, short. */
  label: string;
}

/** At most this many cells go with one message. */
export const ATTACHED_CELLS_MAX = 20;

export type Part =
  | { type: "text"; text: string }
  /** Cells the user attached to the message (user messages only). */
  | { type: "cells"; cells: AttachedCell[] }
  | { type: "thought"; text: string }
  | { type: "image"; mime: ChatImageMime; data: string; alt?: string }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      kind?: string | null;
      status: ToolStatus;
      /** Short text of inputs/outputs for display, capped. */
      detail?: string;
      /** True for calls to our notebook tools. */
      notebook?: boolean;
      /**
       * Notebook tools this call reached, recorded by the bridge as they run.
       * One agent tool call can make several (OpenCode's code mode).
       */
      notebookCalls?: string[];
    }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | {
      type: "prompt";
      promptId: string;
      title: string;
      detail?: string;
      options: { id: string; name: string; kind: string }[];
      /** Option chosen, or "cancelled". Absent while waiting. */
      answer?: string;
    }
  | { type: "review"; review: ReviewInfo; status: ReviewStatus }
  | { type: "card"; card: ChatCard }
  | { type: "notice"; level: "info" | "error"; text: string };

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  parts: Part[];
  createdAt: number;
  /** Notebook changes the agent applied in this turn; the bridge keeps their content for undo. */
  changes?: { count: number; undone?: boolean };
  /** A user message waiting in the queue; the bridge clears this when its turn begins. */
  queued?: boolean;
  /** Pinned by the user so it survives the 200-message transcript trim. */
  pinned?: boolean;
}

export type ChatStatus = "starting" | "idle" | "running" | "error" | "closed";

export interface ChatSnapshot {
  chatId: string;
  tabId: number;
  agentId: string;
  agentName: string;
  /** The notebook this chat belongs to (absent for chats opened without one). */
  notebookKey?: string;
  status: ChatStatus;
  error?: string;
  settings: ChatSettings;
  options: AgentOption[];
  messages: ChatMessage[];
  notebook: NotebookInfo | null;
  /** How full the agent's context is, when the agent reports it. */
  usage?: ChatUsage;
  /** Latest resources read from the notebook's machine, when available. */
  machine?: MachineStats;
  /** The OpenResearch project the notebook belongs to (absent for chats opened without a notebook). */
  project?: ChatProject;
  /** The project's code on the notebook's machine (absent for chats without project code). */
  code?: ChatCode;
  /** The Mentor exercise this notebook is (absent for other notebooks). */
  mentor?: MentorChat;
  /** A paper's workshop chat. */
  workshop?: MentorWorkshop;
  /** The tutor of a paper being read (easy-read). */
  reader?: ReaderChat;
}

/**
 * The project's code on the notebook's machine. `ready`: cloned there, on the
 * chat's branch; `missing`: not there (or not checked yet on this machine),
 * `chat.pushCode` puts it there; `pushing`: being put there; `none`: it is
 * never put there (the project has no GitHub repository, say), `why` says why.
 */
export interface ChatCode {
  state: "ready" | "missing" | "pushing" | "none";
  dir?: string;
  branch?: string;
  why?: string;
}

/**
 * The OpenResearch project a notebook chat belongs to. `pending`: being
 * resolved (OpenResearch is starting, or Scratch is being made); `missing`:
 * OpenResearch says the project no longer exists; `unavailable`: OpenResearch
 * could not be reached, so whether it exists is not known.
 */
export interface ChatProject {
  /** Null while a new notebook waits for its Scratch project. */
  id: string | null;
  name: string;
  state: "ready" | "pending" | "missing" | "unavailable";
  /** The project notebooks go to when no other was chosen. */
  scratch?: boolean;
  error?: string;
  /** The notebook chat's worktree on the user's computer, once made (the Chat Worktree view shows it). */
  worktree?: string;
}

/** A notebook chat as the bridge keeps it for a project (chats.list). */
export interface NotebookChatSummary {
  notebookKey: string;
  title?: string;
  url?: string;
  platform?: Platform;
  agentId?: string;
  updatedAt: number;
  /** Has a saved conversation. */
  messages: boolean;
  /** Open in an editor tab now (its id), else absent. */
  tabId?: number;
}

/** Context use the agent reported over ACP (usage_update). */
export interface ChatUsage {
  /** Tokens in the agent's context now. */
  used: number;
  /** The context window, in tokens. */
  size: number;
  cost?: { amount: number; currency: string };
}

export interface MachineStats {
  at: number;
  memTotal?: number;
  memAvailable?: number;
  diskTotal?: number;
  diskFree?: number;
  gpus?: { name: string; memUsed: number; memTotal: number; util: number }[];
}

/**
 * What changed in one message since the bridge last sent it. Streaming sends
 * these instead of the whole message every few dozen milliseconds: text grows
 * by appending, other parts are replaced whole when they change.
 */
export type PartOp = { i: number; part: Part } | { i: number; at: number; append: string };

export interface MessagePatch {
  chatId: string;
  tabId: number;
  id: string;
  role: ChatMessage["role"];
  createdAt: number;
  changes?: ChatMessage["changes"];
  /** Set or clear the queued mark; absent keeps what the message already had. */
  queued?: boolean;
  /** Set or clear the pinned mark; absent keeps what the message already had. */
  pinned?: boolean;
  /** Number of parts the message has now. */
  length: number;
  ops: PartOp[];
}

/**
 * Apply a patch to a list of messages, returning a new list (the old one is
 * not modified). Null means the patch does not fit what the list holds (an
 * event was missed): fetch the chat again.
 */
export function applyMessagePatch(list: ChatMessage[], p: MessagePatch): ChatMessage[] | null {
  const index = list.findIndex((m) => m.id === p.id);
  const old = index >= 0 ? list[index]! : undefined;
  const parts: (Part | undefined)[] = (old?.parts ?? []).slice(0, p.length);
  for (const op of p.ops) {
    if ("part" in op) {
      parts[op.i] = op.part;
      continue;
    }
    const cur = parts[op.i];
    // `at` anchors the append, so applying a patch to text that already has it changes nothing.
    if (!cur || (cur.type !== "text" && cur.type !== "thought") || cur.text.length < op.at) return null;
    parts[op.i] = { ...cur, text: cur.text.slice(0, op.at) + op.append };
  }
  if (parts.length !== p.length) return null;
  // A plain loop: some() skips the holes a missed part leaves.
  for (let k = 0; k < parts.length; k++) if (parts[k] === undefined) return null;
  const message: ChatMessage = { id: p.id, role: p.role, createdAt: p.createdAt, parts: parts as Part[] };
  if (p.changes) message.changes = p.changes;
  // A patch that says nothing about the queue/pin keeps the mark the message had.
  if (p.queued ?? old?.queued) message.queued = true;
  if (p.pinned ?? old?.pinned) message.pinned = true;
  if (index < 0) return [...list, message];
  const next = list.slice();
  next[index] = message;
  return next;
}

// ---------------------------------------------------------------- methods

export interface ChatSearchHit {
  notebookKey: string;
  title?: string;
  url?: string;
  platform?: Platform;
  messageId: string;
  role: ChatMessage["role"];
  createdAt: number;
  snippet: string;
}

export interface MentorStatus {
  streak: number;
  overall: number;
  dueReviews: number;
  activeToday: boolean;
}

export interface KaggleQuotaStatus {
  configured: boolean;
  checkedAt: number;
  accounts: {
    account: string;
    gpu?: { used: number; reserved: number; total: number; remaining: number } | null;
    tpu?: { used: number; reserved: number; total: number; remaining: number } | null;
    refreshAt?: string | null;
    error?: string;
  }[];
  idleSessions: {
    id: string;
    account: string;
    state: string;
    created: number;
    deadline: number;
    idleMs: number;
    note?: string | null;
  }[];
  lowGpuAccounts: string[];
  error?: string;
}

/** Requests the extension sends to the bridge. */
export interface BridgeMethods {
  hello: {
    params: { token: string; wire: number; extensionVersion: string };
    result: { bridgeVersion: string; agents: AgentInfo[]; browserConnected?: boolean };
  };
  "agents.list": { params: { refresh?: boolean }; result: { agents: AgentInfo[] } };
  "agents.save": { params: { id?: string; name?: string; launchCommand: string }; result: { agent: AgentInfo } };
  "agents.remove": { params: { id: string }; result: { removed: boolean } };
  "agents.test": { params: { launchCommand: string }; result: { name: string; options: AgentOption[] } };
  "chat.open": {
    /**
     * With a notebookKey the chat is saved and restored per notebook. `tabId`
     * is the editor's id for the notebook; `browserTab`, when given, puts the
     * notebook in that Chrome tab: the chat stays with the editor, its
     * notebook operations go to the browser extension.
     */
    params: { tabId: number; agentId: string; settings: ChatSettings; platform: Platform; notebookKey?: string; browserTab?: number; projectId?: string; reader?: { paperId: string } };
    result: ChatSnapshot;
  };
  /** Move a notebook (and its chat) to another OpenResearch project; takes effect from its next turn. */
  "notebook.link": { params: { notebookKey: string; projectId: string; title?: string; platform?: Platform; url?: string }; result: { project: ChatProject } };
  /** The project a notebook was linked to (null: none yet, it goes to Scratch), without asking OpenResearch. */
  "notebook.project": { params: { notebookKey: string }; result: { projectId: string | null } };
  /** The notebook chats of a project, newest first. */
  "chats.list": { params: { projectId: string }; result: { chats: NotebookChatSummary[] } };
  /** Search saved notebook chat transcripts on this machine. */
  "chats.search": { params: { query: string; limit?: number }; result: { hits: ChatSearchHit[] } };
  /** Save the chat's notebook (with outputs) to its project's artifacts/notebooks. */
  "chat.saveNotebook": { params: { chatId: string }; result: { path: string } };
  /** Run every code cell from a reset Python namespace, then save only on success. */
  "chat.verifyNotebook": { params: { chatId: string }; result: { started: boolean } };
  /** Put the project's code on the notebook's machine now (cheap when it is already there). */
  "chat.pushCode": { params: { chatId: string }; result: ChatCode };
  "chat.get": { params: { tabId: number }; result: ChatSnapshot | null };
  "chat.send": { params: { chatId: string; text: string; cells?: AttachedCell[] }; result: { accepted: boolean } };
  "chat.cancel": { params: { chatId: string }; result: { cancelled: boolean } };
  "chat.close": { params: { chatId: string }; result: { closed: boolean } };
  "chat.settings": { params: { chatId: string; settings: ChatSettings }; result: ChatSnapshot };
  "chat.option": { params: { chatId: string; optionId: string; value: string | boolean }; result: ChatSnapshot };
  "chat.answer": { params: { chatId: string; promptId: string; optionId: string }; result: { answered: boolean } };
  "chat.review": { params: { chatId: string; reviewId: string; accept: boolean }; result: { resolved: boolean } };
  /** Revert the notebook changes of one agent turn, newest first, skipping cells edited since. */
  "chat.undo": { params: { chatId: string; messageId: string }; result: UndoResult };
  /** The notebook changes one agent message applied, from the chat's journal (for a diff view). */
  "chat.changes": { params: { chatId: string; messageId: string }; result: { changes: AppliedChange[] } };
  /** Pin or unpin a message so it survives transcript trimming. */
  "chat.pin": { params: { chatId: string; messageId: string; pinned: boolean }; result: { pinned: boolean } };
  /** Remove a single queued user message before its turn begins. */
  "chat.dequeue": { params: { chatId: string; messageId: string }; result: { removed: boolean } };
  /** The user pressed a button of a card. */
  "chat.cardAction": { params: { chatId: string; cardId: string; actionId: string }; result: { accepted: boolean } };
  "tab.closed": { params: { tabId: number }; result: { ok: true } };
  /** The notebooks open in Chrome tabs, for the editor's notebook picker. */
  "browser.notebooks": { params: Record<string, never>; result: { notebooks: BrowserNotebook[] } };
  /**
   * What the user does to a notebook in a Chrome tab from the editor (the
   * chat's "Insert as cell", or the notebook mirrored in VS Code): read it,
   * change it, run it. The agent's operations go through its chat instead.
   */
  "browser.op": { params: { tabId: number; op: BrowserOp }; result: unknown };
  /** OpenResearch's state; `start` starts it when it is not running. */
  "research.status": { params: { start?: boolean }; result: ResearchStatus };
  /**
   * Restart OpenResearch (what the bridge started), with this orx binary when
   * `orxPath` is given (null: look for one again).
   */
  "research.configure": { params: { orxPath?: string | null }; result: ResearchStatus };
  /** Kaggle quota and idle sessions from the bridge watcher (never starts orx). */
  "research.quota": { params: { refresh?: boolean }; result: KaggleQuotaStatus };
  /** Close a live Kaggle compute session. */
  "research.closeSession": { params: { sessionId: string }; result: { closing: boolean } };
  /**
   * Run the kernel environment setup script in a terminal on the notebook's
   * machine (its "setup" session), outside any chat. Waits up to `waitSeconds`
   * (default 90); a longer script keeps running there (`running`).
   */
  "notebook.setup": {
    params: { tabId: number; browserTab?: number; script: string; waitSeconds?: number };
    result: { output: string; exitCode: number | null; running: boolean };
  };
  /** Mentor: the home page (map, ratings, streak, today's exercise). */
  "mentor.home": { params: Record<string, never>; result: MentorHome };
  /** Mentor: lightweight status bar summary (streak, overall rating, due reviews). */
  "mentor.status": { params: Record<string, never>; result: MentorStatus };
  /** Mentor: the notebooks open in Chrome an exercise can be put in. */
  "mentor.places": { params: Record<string, never>; result: MentorPlace[] };
  /**
   * Mentor: start an exercise (today's when none is named) or reopen its
   * unfinished attempt, in the notebook of Chrome tab `tabId`: the bridge
   * writes the exercise into it. Without `tabId`, only an attempt already in
   * an open notebook starts (else the error asks for one). Replacing the
   * learner's own cells needs `replace` (they are backed up first).
   */
  "mentor.start": {
    params: { exerciseId?: string; kind?: MentorKind; tabId?: number; replace?: boolean };
    result: { attemptId: string; exerciseId: string; tabId: number; resumed: boolean };
  };
  /** Mentor: run the exercise's hidden tests on the learner's cells. */
  "mentor.judge": { params: { chatId: string }; result: { started: boolean } };
  /** Mentor: the learner asks for the next hint level. */
  "mentor.hint": { params: { chatId: string }; result: { level: number } };
  /** "Nhận xét code": the mentor reviews the finished solution (no effect on the rating). */
  "mentor.codeReview": { params: { chatId: string }; result: { started: boolean } };
  /** Mentor: the learner moves the exercise to a step themself (moving past the build needs a passing verdict). */
  "mentor.stage": { params: { chatId: string; stage: MentorStage }; result: MentorChat };
  /** Bring a paper: its source is fetched, and the notebook of the tab becomes its workshop. */
  "mentor.paper.add": { params: { source: { arxiv: string } | { pdfPath: string }; tabId: number; replace?: boolean }; result: { paperId: string; tabId: number } };
  /** Put a paper's workshop (back) in a notebook. */
  "mentor.paper.open": { params: { paperId: string; tabId: number; replace?: boolean }; result: { paperId: string; tabId: number } };
  "mentor.paper.get": { params: { paperId: string }; result: MentorPaper };
  /** The learner approves the plan in the workshop chat; the exercises are then written. */
  "mentor.paper.approve": { params: { chatId: string }; result: MentorWorkshop };
  /** Write the exercises not written yet (or again, for one component). */
  /** Write what is not written yet; `retry`: also what could not be written; `slug`: one exercise again (one the learner reported as wrong). */
  "mentor.paper.author": { params: { chatId: string; slug?: string; retry?: boolean }; result: MentorWorkshop };
  "mentor.paper.stopAuthoring": { params: { chatId: string }; result: MentorWorkshop };
  "mentor.paper.notes": { params: { paperId: string; notes: string }; result: { ok: true } };
  "mentor.paper.archive": { params: { paperId: string; archived: boolean }; result: { ok: true } };
  /** What "today's exercise" follows: a paper, a constellation, or the map (null). */
  "mentor.focus": { params: { focus: { kind: "paper" | "constellation"; id: string } | null }; result: { ok: true } };
  /** "Báo bài sai": the exercise looks wrong; the attempt no longer counts, and the mentor rewrites it. */
  "mentor.report": { params: { chatId: string; reason: string }; result: { ok: true } };
  /** Mentor: learner attempt history with saved code/verdict and (once done/revealed) reference diff (C5). */
  "mentor.attempts": { params: { exerciseId?: string; limit?: number }; result: { attempts: MentorAttemptDetail[] } };
  /** Mentor: export learner profile & progress as Markdown or JSON backup (C6). */
  "mentor.export": { params: { format?: "markdown" | "json"; includeMistakes?: boolean }; result: { content: string; filename: string } };
  /** Mentor: import a previously exported JSON backup into events.jsonl (C6). */
  "mentor.import": { params: { data: string }; result: { importedEvents: number } };
  /** Easy-read: open a paper to read (fetched and converted the first time). */
  "reader.open": { params: { source: { arxiv: string } | { pdfPath: string } | { paperId: string } }; result: ReaderView };
  "reader.get": { params: { paperId: string }; result: ReaderView };
  "reader.session": { params: { paperId: string; action: "start" | "end" }; result: ReaderView };
  /** The papers read so far, latest first. */
  "reader.list": { params: Record<string, never>; result: { papers: ReaderLibraryItem[] } };
  /** Time spent in a section (the tab sends it in slices); the section is where the reader is now. */
  "reader.progress": { params: { paperId: string; section: string; ms: number; agentId?: string }; result: { ok: true } };
  /** The reader marks a section read, or not. */
  "reader.mark": { params: { paperId: string; section: string; read: boolean }; result: ReaderView };
  /** Add or change a note or one of "my questions" (`id` given: that one); `remove`: delete it. */
  "reader.note": { params: { paperId: string; note?: { id?: string; kind: ReaderNote["kind"]; text: string; anchor?: ReaderAnchor; done?: boolean }; remove?: string }; result: ReaderView };
  /** A PDF's text, page by page, as the tab's pdf.js took it out. */
  "reader.pdfText": { params: { paperId: string; pages: string[]; title?: string }; result: ReaderView };
  /** What `reader.render` asked for, drawn by the tab as a JPEG (base64); `error` when it could not be. */
  "reader.rendered": { params: { paperId: string; page?: number; asset?: string; jpeg?: string; error?: string }; result: { ok: true } };
  /** A selected passage to the paper's tutor: "Giải thích", "Ví dụ cụ thể", "Ký hiệu", "Vì sao?". */
  "reader.ask": { params: { chatId: string; kind: ReaderAskKind; anchor: ReaderAnchor; quote: string }; result: { accepted: true } };
  /** The passes (ER-2): the paper's map, units and checkpoints, what the reader wrote and answered. */
  "reader.guide": { params: { paperId: string; agentId?: string }; result: ReaderGuide };
  "reader.appeal": { params: { paperId: string; chatId: string; write: string; reason: string }; result: ReaderGuide };
  "reader.cards.due": { params: Record<string, never>; result: ReaderCardView[] };
  "reader.cards.keep": { params: { paperId: string; card?: string; edit?: { front?: string; back?: string; evidence?: { anchor: string; quote: string } } }; result: ReaderGuide };
  "reader.cards.drop": { params: { paperId: string; card: string }; result: ReaderGuide };
  "reader.cards.review": { params: { paperId: string; card: string; grade: ReaderCardGrade }; result: ReaderGuide };
  "reader.peer": { params: { paperId: string; note: string; persona: import("./reader.js").ReaderPeerReply["persona"]; agentId?: string }; result: { accepted: true } };
  "reader.related": { params: { paperId: string }; result: import("./reader.js").ReaderRelated };
  "reader.lab.open": { params: { paperId: string; widget: string; tabId: number }; result: { tabId: number; added: number } };
  "reader.widget.request": { params: { paperId: string; anchor: ReaderAnchor; goal: string; agentId?: string }; result: ReaderGuide };
  "reader.widget.answer": { params: { paperId: string; id: string; choice: number }; result: ReaderGuide };
  /** Why the reader reads it: the author starts on the paper's map (on the tutor's agent and settings; `agentId` is ignored). */
  "reader.goal": { params: { paperId: string; goal: ReaderGoal; agentId?: string }; result: ReaderGuide };
  /** Go to a pass (pass 2 has the author write the first units' checkpoints); `done`: finish it and stop there. */
  "reader.pass": { params: { paperId: string; pass: ReaderPass; done?: boolean; agentId?: string }; result: ReaderGuide };
  /** Answer a checkpoint question (with how sure, 1–3), or guess a pretest one (`pretest`, no confidence). */
  "reader.answer": { params: { paperId: string; item: string; choice: ReaderChoice & { text?: string }; confidence?: 1 | 2 | 3; pretest?: boolean }; result: { result?: ReaderAnswerResult; guide: ReaderGuide } };
  /** Something the reader wrote: graded by the tutor in `chatId` (5C, recall, explain, QALMRI, summary), or kept (figure, predict). */
  "reader.write": { params: { paperId: string; chatId?: string; kind: ReaderWriteKind; unit?: string; key?: string; text?: string; fields?: Record<string, string> }; result: { id: string; graded: boolean; guide: ReaderGuide } };
  /** "Cho xem luôn": a pending task's answer shown; it does not count. `task`: "5c", "summary", "pretest:<id>", "item:<id>", "<unit>:recall|explain|qalmri". */
  "reader.skip": { params: { paperId: string; task: string }; result: ReaderGuide };
  /** "Báo câu sai": the question is withdrawn. */
  "reader.report": { params: { paperId: string; item: string; reason: string }; result: ReaderGuide };
  /** The hidden author: lock the paper ("stop", kept on disk) or unlock it, try failed work again, or run a proposal ("all": every one). */
  "reader.author": { params: { paperId: string; action: "stop" | "unlock" | "retry" | "run"; task?: string; agentId?: string }; result: ReaderGuide };
  /** Easy-read settings (when background agents run, the blind checker): omit fields to read. Every background agent runs on the tutor's agent and settings. */
  "reader.settings": { params: { agentMode?: ReaderAgentMode; checker?: boolean; checkerRounds?: number }; result: ReaderSettings };
}

/**
 * OpenResearch (`orx up`) as the bridge runs it, for the editor to show its
 * web app. `missing`: no orx binary found; `off`: not started yet.
 */
export interface ResearchStatus {
  state: "off" | "missing" | "starting" | "ready" | "error";
  error?: string;
  /** The orx binary used (or configured). */
  orxPath?: string;
  /** Where its web app and API listen, once ready. */
  url?: string;
  version?: string;
  /** False when the bridge found an OpenResearch already running and uses that one. */
  owned?: boolean;
}

/** OpenResearch's run states; the last four are final. */
export type RunStatus = "starting" | "running" | "done" | "failed" | "cancelled" | "lost";
export const FINAL_RUN_STATUSES: readonly RunStatus[] = ["done", "failed", "cancelled", "lost"];

/** The fields of an OpenResearch run the editor uses (its API sends more). */
export interface ResearchRun {
  id: string;
  experimentId: string;
  projectId: string;
  status: RunStatus;
  backend?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  exitCode?: number | null;
  /** Set while a starting run waits in its provider's queue (e.g. "Queued on Kaggle…"). */
  queueDetail?: string | null;
}

export interface BrowserNotebook {
  tabId: number;
  info: NotebookInfo;
}

/** The notebook operations the user may run on a Chrome tab from the editor: no review, and not journaled as the agent's. */
export type BrowserOp =
  | Extract<NotebookOp, { op: "info" | "get_cells" | "focus_cell" | "run_cells" | "interrupt" }>
  | (Extract<NotebookOp, { op: "insert_cell" | "update_cell" | "delete_cell" }> & { review: false; byUser: true })
  | (Extract<NotebookOp, { op: "move_cell" }> & { byUser: true });

export function isBrowserOp(op: unknown): op is BrowserOp {
  const o = op as { op?: unknown; review?: unknown; byUser?: unknown } | null;
  switch (o?.op) {
    case "info": case "get_cells": case "focus_cell": case "run_cells": case "interrupt":
      return true;
    case "insert_cell": case "update_cell": case "delete_cell":
      return o.review === false && o.byUser === true;
    case "move_cell":
      return o.byUser === true;
    default:
      return false;
  }
}

export interface UndoResult {
  undone: number;
  /** One line per change left alone, with the reason. */
  skipped: string[];
}

/** Requests the bridge sends to the extension. */
export interface ExtensionMethods {
  "notebook.op": { params: { tabId: number; op: NotebookOp }; result: unknown };
}

/** Events from the bridge to the extension. */
export interface BridgeEvents {
  "chat.snapshot": ChatSnapshot;
  "chat.patch": MessagePatch;
  /** Mid-session metadata change without resending the whole transcript. */
  "chat.meta": { chatId: string; tabId: number; settings?: ChatSettings; options?: AgentOption[]; project?: ChatProject; code?: ChatCode };
  "chat.usage": { chatId: string; tabId: number; usage: ChatUsage };
  /** A long run of a cell ended while no turn was running: the editor may tell the user. */
  "chat.run": { chatId: string; tabId: number; cardId: string; run: CellRun; title: string };
  "chat.machine": { chatId: string; tabId: number; machine: MachineStats };
  /** The notebook's machine was replaced (a new boot): the editor may set it up again. */
  "chat.machineReplaced": { chatId: string; tabId: number };
  "chat.status": { chatId: string; tabId: number; status: ChatStatus; error?: string };
  "agents.changed": { agents: AgentInfo[] };
  /** A notebook in a Chrome tab appeared, changed, or (info null) went away. */
  "browser.notebook": { tabId: number; info: NotebookInfo | null };
  /** The user brought a Chrome tab holding a notebook to the front. */
  "browser.focused": { tabId: number };
  /** Whether the Chrome browser extension is currently connected to the bridge. */
  "browser.status": { connected: boolean };
  "research.status": ResearchStatus;
  /** A run of an OpenResearch experiment started, changed state or finished. */
  "research.run": ResearchRun;
  /** Proactive Kaggle quota / idle-session update from the bridge watcher. */
  "research.quota": KaggleQuotaStatus;
  /** A Mentor exercise's step, hint level or verdict changed. */
  "chat.mentor": { chatId: string; tabId: number; mentor: MentorChat };
  "chat.workshop": { chatId: string; tabId: number; workshop: MentorWorkshop };
  /** Mentor progress changed (an attempt, a verdict, a rating): the home page reloads. */
  "mentor.updated": Record<string, never>;
  /** A paper's reading changed (progress, notes, its text). */
  "reader.updated": { paperId: string; view: ReaderView };
  /** The tutor wants to look at a PDF page, or a figure the agent cannot read as it is (SVG): the paper's tab draws it and sends `reader.rendered`. */
  "reader.render": { paperId: string; page?: number; asset?: string };
  ping: { t: number };
}

/** Events from the extension to the bridge. */
export interface ExtensionEvents {
  "notebook.event": { tabId: number; event: NotebookEvent };
  "notebook.attached": { tabId: number; info: NotebookInfo };
  "notebook.detached": { tabId: number };
  /** The browser: the user brought this notebook's tab to the front. */
  "notebook.focused": { tabId: number };
}

export type MethodName<M> = keyof M & string;
export type ParamsOf<M, K extends keyof M> = M[K] extends { params: infer P } ? P : never;
export type ResultOf<M, K extends keyof M> = M[K] extends { result: infer R } ? R : never;
