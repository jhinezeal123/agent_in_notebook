// Side panel <-> background, over a chrome.runtime Port.

import type { AgentInfo, ChatSettings, NotebookInfo, Scope } from "@ainb/protocol";

/** `replaced`: another browser window or profile took over the bridge; no automatic reconnect. */
export type ConnState = "disconnected" | "connecting" | "connected" | "unpaired" | "replaced";

/**
 * What the native host (`ainb install`) said. `missing`: not installed;
 * `forbidden`: installed, but not for this extension's ID; `error`: it answered
 * but the bridge would not start.
 */
export interface NativeStatus {
  status: "ok" | "missing" | "forbidden" | "error";
  error?: string;
  /** The end of the bridge's log when it failed to start. */
  log?: string;
}

export interface BridgeConfig {
  port: number;
  token: string;
  /** `manual`: typed in by the user, so the native host does not replace it. */
  source?: "native" | "manual";
}

export interface BridgeState {
  conn: ConnState;
  error?: string;
  agents: AgentInfo[];
  bridgeVersion?: string;
  config: BridgeConfig;
  native?: NativeStatus;
  extensionId: string;
}

export interface Prefs {
  agentId: string;
  scope: Scope;
  review: boolean;
  notebookOnly: boolean;
}

export const DEFAULT_PREFS: Prefs = { agentId: "claude", scope: "write", review: true, notebookOnly: true };

/** Methods the background answers itself; every other method goes to the bridge. */
export interface LocalMethods {
  "state.get": { params: Record<string, never>; result: BridgeState };
  "config.set": { params: { port: number; token: string }; result: BridgeState };
  /** Drop a manual config and pair through the native host again. */
  "config.auto": { params: Record<string, never>; result: BridgeState };
  "tab.notebook": { params: { tabId: number }; result: NotebookInfo | null };
  "notebook.focus": { params: { tabId: number; cellId: string }; result: { focused: boolean } };
  "notebook.insert": { params: { tabId: number; source: string; cellType: "code" | "markdown" }; result: { cellId: string | null } };
}

export type PanelRequest = { id: number; method: string; params: unknown };
export type PanelResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type PanelEvent =
  | { event: "state"; params: BridgeState }
  | { event: "notebook"; params: { tabId: number; info: NotebookInfo | null } }
  | { event: "bridge"; params: { method: string; params: unknown } };

export type { ChatSettings };
