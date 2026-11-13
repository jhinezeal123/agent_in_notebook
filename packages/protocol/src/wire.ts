// Messages between the extension (background service worker) and the bridge,
// carried as JSON over one WebSocket. Both sides send requests, responses and
// events with the same envelope.

import type { ChatSettings } from "./modes.js";
import type { NotebookEvent, NotebookInfo, NotebookOp, Platform, ReviewInfo } from "./notebook.js";

export const BRIDGE_DEFAULT_PORT = 47821;
export const WIRE_VERSION = 2;

// ---------------------------------------------------------------- native messaging

/** The name `ainb install` registers the bridge under as a browser native messaging host. */
export const NATIVE_HOST = "com.agent_in_notebook.bridge";
/** The extension's ID, fixed by the `key` in its manifest. */
export const EXTENSION_ID = "mkdjlgboacefhokakjlobfailhipgklf";

/** One request to the native host: start the bridge if needed and say how to reach it. */
export type NativeRequest = { type: "connect" };
export type NativeReply =
  | { ok: true; port: number; token: string; version: string; started: boolean }
  | { ok: false; error: string; log?: string };

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
    /** With a notebookKey the chat is saved and restored per notebook. */
    params: { tabId: number; agentId: string; settings: ChatSettings; platform: Platform; notebookKey?: string };
    result: ChatSnapshot;
  };
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
  ping: { t: number };
}

/** Events from the extension to the bridge. */
export interface ExtensionEvents {
  "notebook.event": { tabId: number; event: NotebookEvent };
  "notebook.attached": { tabId: number; info: NotebookInfo };
  "notebook.detached": { tabId: number };
}

export type MethodName<M> = keyof M & string;
export type ParamsOf<M, K extends keyof M> = M[K] extends { params: infer P } ? P : never;
export type ResultOf<M, K extends keyof M> = M[K] extends { result: infer R } ? R : never;
