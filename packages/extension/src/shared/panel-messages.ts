// Side panel <-> background, over a chrome.runtime Port.

import type { AgentInfo, ChatSettings, NotebookInfo, Scope } from "@ainb/protocol";

/** `replaced`: another browser window or profile took over the bridge; no automatic reconnect. */
export type ConnState = "disconnected" | "connecting" | "connected" | "unpaired" | "replaced";

export interface BridgeState {
  conn: ConnState;
  error?: string;
  agents: AgentInfo[];
  bridgeVersion?: string;
  config: { port: number; token: string };
}

export interface Prefs {
  agentId: string;
  scope: Scope;
  review: boolean;
}

export const DEFAULT_PREFS: Prefs = { agentId: "claude", scope: "write", review: true };

/** Methods the background answers itself; every other method goes to the bridge. */
export interface LocalMethods {
  "state.get": { params: Record<string, never>; result: BridgeState };
  "config.set": { params: { port: number; token: string }; result: BridgeState };
  "tab.notebook": { params: { tabId: number }; result: NotebookInfo | null };
  "notebook.focus": { params: { tabId: number; cellId: string }; result: { focused: boolean } };
}

export type PanelRequest = { id: number; method: string; params: unknown };
export type PanelResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type PanelEvent =
  | { event: "state"; params: BridgeState }
  | { event: "notebook"; params: { tabId: number; info: NotebookInfo | null } }
  | { event: "bridge"; params: { method: string; params: unknown } };

export type { ChatSettings };
