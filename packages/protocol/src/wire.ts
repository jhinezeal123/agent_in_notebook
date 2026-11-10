// Messages between the extension (background service worker) and the bridge,
// carried as JSON over one WebSocket. Both sides send requests, responses and
// events with the same envelope.

import type { ChatSettings } from "./modes.js";
import type { NotebookEvent, NotebookInfo, NotebookOp, Platform, ReviewInfo } from "./notebook.js";

export const BRIDGE_DEFAULT_PORT = 47821;
export const WIRE_VERSION = 1;

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
  | { type: "review"; review: ReviewInfo; status: "pending" | "accepted" | "rejected" }
  | { type: "notice"; level: "info" | "error"; text: string };

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  parts: Part[];
  createdAt: number;
}

export type ChatStatus = "starting" | "idle" | "running" | "error" | "closed";

export interface ChatSnapshot {
  chatId: string;
  tabId: number;
  agentId: string;
  agentName: string;
  status: ChatStatus;
  error?: string;
  settings: ChatSettings;
  options: AgentOption[];
  messages: ChatMessage[];
  notebook: NotebookInfo | null;
}

// ---------------------------------------------------------------- methods

/** Requests the extension sends to the bridge. */
export interface BridgeMethods {
  hello: { params: { token: string; wire: number; extensionVersion: string }; result: { bridgeVersion: string; agents: AgentInfo[] } };
  "agents.list": { params: { refresh?: boolean }; result: { agents: AgentInfo[] } };
  "chat.open": {
    params: { tabId: number; agentId: string; settings: ChatSettings; platform: Platform };
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
  "tab.closed": { params: { tabId: number }; result: { ok: true } };
}

/** Requests the bridge sends to the extension. */
export interface ExtensionMethods {
  "notebook.op": { params: { tabId: number; op: NotebookOp }; result: unknown };
}

/** Events from the bridge to the extension. */
export interface BridgeEvents {
  "chat.snapshot": ChatSnapshot;
  "chat.message": { chatId: string; tabId: number; message: ChatMessage };
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
