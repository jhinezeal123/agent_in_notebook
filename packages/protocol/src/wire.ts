// Messages between the extension (background service worker) and the bridge,
// carried as JSON over one WebSocket. Both sides send requests, responses and
// events with the same envelope.

import type { ChatImageMime } from "./chat-image.js";
import type { ChatSettings } from "./modes.js";
import type { NotebookEvent, NotebookInfo, NotebookOp, Platform, ReviewInfo } from "./notebook.js";

export const BRIDGE_DEFAULT_PORT = 47821;
export const WIRE_VERSION = 3;

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

export type Part =
  | { type: "text"; text: string }
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
  | { type: "notice"; level: "info" | "error"; text: string };

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  parts: Part[];
  createdAt: number;
  /** Notebook changes the agent applied in this turn; the bridge keeps their content for undo. */
  changes?: { count: number; undone?: boolean };
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
  /** The OpenResearch project the notebook belongs to (absent for chats opened without a notebook). */
  project?: ChatProject;
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
  if (index < 0) return [...list, message];
  const next = list.slice();
  next[index] = message;
  return next;
}

// ---------------------------------------------------------------- methods

/** Requests the extension sends to the bridge. */
export interface BridgeMethods {
  hello: { params: { token: string; wire: number; extensionVersion: string }; result: { bridgeVersion: string; agents: AgentInfo[] } };
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
    params: { tabId: number; agentId: string; settings: ChatSettings; platform: Platform; notebookKey?: string; browserTab?: number; projectId?: string };
    result: ChatSnapshot;
  };
  /** Move a notebook (and its chat) to another OpenResearch project; takes effect from its next turn. */
  "notebook.link": { params: { notebookKey: string; projectId: string; title?: string; platform?: Platform; url?: string }; result: { project: ChatProject } };
  /** The project a notebook was linked to (null: none yet, it goes to Scratch), without asking OpenResearch. */
  "notebook.project": { params: { notebookKey: string }; result: { projectId: string | null } };
  /** The notebook chats of a project, newest first. */
  "chats.list": { params: { projectId: string }; result: { chats: NotebookChatSummary[] } };
  /** Save the chat's notebook (with outputs) to its project's artifacts/notebooks. */
  "chat.saveNotebook": { params: { chatId: string }; result: { path: string } };
  "chat.get": { params: { tabId: number }; result: ChatSnapshot | null };
  "chat.send": { params: { chatId: string; text: string }; result: { accepted: boolean } };
  "chat.cancel": { params: { chatId: string }; result: { cancelled: boolean } };
  "chat.close": { params: { chatId: string }; result: { closed: boolean } };
  "chat.settings": { params: { chatId: string; settings: ChatSettings }; result: ChatSnapshot };
  "chat.option": { params: { chatId: string; optionId: string; value: string | boolean }; result: ChatSnapshot };
  "chat.answer": { params: { chatId: string; promptId: string; optionId: string }; result: { answered: boolean } };
  "chat.review": { params: { chatId: string; reviewId: string; accept: boolean }; result: { resolved: boolean } };
  /** Revert the notebook changes of one agent turn, newest first, skipping cells edited since. */
  "chat.undo": { params: { chatId: string; messageId: string }; result: UndoResult };
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
  /**
   * Run the kernel environment setup script in a terminal on the notebook's
   * machine (its "setup" session), outside any chat. Waits up to `waitSeconds`
   * (default 90); a longer script keeps running there (`running`).
   */
  "notebook.setup": {
    params: { tabId: number; browserTab?: number; script: string; waitSeconds?: number };
    result: { output: string; exitCode: number | null; running: boolean };
  };
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
  "chat.usage": { chatId: string; tabId: number; usage: ChatUsage };
  "chat.status": { chatId: string; tabId: number; status: ChatStatus; error?: string };
  "agents.changed": { agents: AgentInfo[] };
  /** A notebook in a Chrome tab appeared, changed, or (info null) went away. */
  "browser.notebook": { tabId: number; info: NotebookInfo | null };
  /** The user brought a Chrome tab holding a notebook to the front. */
  "browser.focused": { tabId: number };
  "research.status": ResearchStatus;
  /** A run of an OpenResearch experiment started, changed state or finished. */
  "research.run": ResearchRun;
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
