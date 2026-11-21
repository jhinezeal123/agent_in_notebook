// The chat UI <-> its host (the VS Code extension), over the webview's messages.

import type { AgentInfo, AttachedCell, ChatSettings, NotebookInfo, Scope } from "@ainb/protocol";

/** `replaced`: another VS Code window took over the bridge; no automatic reconnect. */
export type ConnState = "disconnected" | "connecting" | "connected" | "unpaired" | "replaced";

export interface BridgeConfig {
  port: number;
  token: string;
  /** `manual`: typed in by the user, not read from the bridge's config.json. */
  source?: "manual";
}

export interface BridgeState {
  conn: ConnState;
  error?: string;
  agents: AgentInfo[];
  bridgeVersion?: string;
  /** Whether the Chrome browser extension is currently connected to the bridge. */
  browserConnected?: boolean;
  config: BridgeConfig;
}

export interface CustomSlashTemplate {
  name: string;
  prompt: string;
}

export interface Prefs {
  agentId: string;
  scope: Scope;
  review: boolean;
  notebookOnly: boolean;
  /** User-defined slash command templates (B5.1). */
  slashTemplates?: CustomSlashTemplate[];
  /** UI language override (B5.4): "auto" | "en" | "vi". */
  language?: "auto" | "en" | "vi";
}

export const DEFAULT_PREFS: Prefs = { agentId: "claude", scope: "write", review: true, notebookOnly: true };

/** A notebook the chat can be about: one open in VS Code, or in a Chrome tab. */
export interface NotebookChoice {
  tabId: number;
  platform: NotebookInfo["platform"];
  title: string;
  place: "vscode" | "chrome";
}

export type PanelRequest = { id: number; method: string; params: unknown };
export type PanelResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type PanelEvent =
  | { event: "state"; params: BridgeState }
  | { event: "activeTab"; params: number | null }
  | { event: "notebook"; params: { tabId: number; info: NotebookInfo | null } }
  | { event: "notebooks"; params: NotebookChoice[] }
  /** The prefs changed outside the panel (New Chat picked an agent). */
  | { event: "prefs"; params: Prefs }
  /** The cells attached to the next message about a notebook; `added`: the user just attached some. */
  | { event: "attachments"; params: { tabId: number; cells: AttachedCell[]; added?: boolean } }
  /** A command from the view's title bar. */
  | { event: "command"; params: "chat.clear" | "chat.export" }
  | { event: "bridge"; params: { method: string; params: unknown } };

export type { AttachedCell, ChatSettings };
