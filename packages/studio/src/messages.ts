// Messages between the research views (webviews) and the VS Code extension.
//
// OpenResearch's client code calls `fetch("/api/...")` and opens
// `EventSource("/api/events")` as if it were served by `orx up`. In a webview
// those go through the extension instead (see tunnel.ts): the extension makes
// the request to the OpenResearch the bridge runs, as a local process, and
// sends the answer back.

import type { ResearchStatus } from "@ainb/protocol";

export type ToHost =
  | { type: "orx.fetch"; id: number; url: string; method: string; headers: Record<string, string>; body?: string }
  | { type: "orx.abort"; id: number }
  | { type: "orx.sse"; id: number; url: string }
  | { type: "orx.sse.close"; id: number }
  | { type: "host.request"; id: number; method: string; params?: unknown };

export type FromHost =
  /** `body`: base64. */
  | { type: "orx.response"; id: number; status: number; statusText: string; headers: Record<string, string>; body: string }
  | { type: "orx.error"; id: number; message: string }
  | { type: "orx.sse.open"; id: number }
  | { type: "orx.sse.event"; id: number; event: string; data: string; lastEventId: string }
  | { type: "orx.sse.error"; id: number; closed: boolean }
  | { type: "host.response"; id: number; ok: true; result: unknown }
  | { type: "host.response"; id: number; ok: false; error: string }
  | { type: "host.event"; event: string; params: unknown };

/** Which screen a webview shows. */
export type StudioView =
  | { view: "sidebar" }
  | { view: "newchat" }
  | { view: "settings"; section?: SettingsSection }
  | { view: "experiment"; projectId: string; experimentId: string }
  | { view: "chat"; projectId: string; sessionId: string };

export type SettingsSection = "agents" | "compute" | "environment" | "kernel";

/** Host events the views listen to. */
export interface HostEvents {
  /** OpenResearch's state as the bridge runs it. */
  "research.status": ResearchStatus;
  /** Notebooks the notebook chat can be about (VS Code's and Chrome tabs'). */
  notebooks: NotebookEntry[];
  /** The chat shown in the chat panel. */
  "chat.selected": SelectedChat | null;
  /** Switch this view to another screen (an editor tab reused for another experiment). */
  view: StudioView;
}

export interface NotebookEntry {
  tabId: number;
  title: string;
  platform: "colab" | "kaggle" | "jupyter" | "vscode";
  place: "vscode" | "chrome";
}

export type SelectedChat = { kind: "notebook"; tabId: number } | { kind: "research"; projectId: string; sessionId: string };

/** Kernel environment: what runs on a notebook's machine when it attaches. */
export interface KernelSetup {
  script: string;
  runOnAttach: boolean;
  colab: boolean;
  kaggle: boolean;
}

export const DEFAULT_KERNEL_SETUP: KernelSetup = { script: "", runOnAttach: false, colab: true, kaggle: true };
