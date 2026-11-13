// The chat UI <-> its host (the VS Code extension), over the webview's messages.

import type { AgentInfo, ChatSettings, NotebookInfo, Scope } from "@ainb/protocol";

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
  config: BridgeConfig;
}

export interface Prefs {
  agentId: string;
  scope: Scope;
  review: boolean;
  notebookOnly: boolean;
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
  | { event: "bridge"; params: { method: string; params: unknown } };

export type { ChatSettings };
