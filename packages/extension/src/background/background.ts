// Service worker: the extension's one connection to the local bridge, the
// router for notebook ops to the right tab and frame, and the hub for side
// panels.

import { BRIDGE_DEFAULT_PORT, notebookKey, RpcPeer, WIRE_VERSION, type Envelope, type NotebookInfo, type NotebookOp } from "@ainb/protocol";
import type { BackgroundToContent, ContentToBackground, OpResponse } from "../shared/page-messages.js";
import type { BridgeState, PanelEvent, PanelRequest, PanelResponse } from "../shared/panel-messages.js";

const VERSION = chrome.runtime.getManifest().version;

const state: BridgeState = { conn: "disconnected", agents: [], config: { port: BRIDGE_DEFAULT_PORT, token: "" } };
/** Notebook frames by tab. */
const tabs = new Map<number, { frameId: number; info: NotebookInfo }>();
const panels = new Set<chrome.runtime.Port>();

let ws: WebSocket | null = null;
let rpc: RpcPeer | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;

/** The bridge closes a connection with this code when a newer one replaces it. */
const CLOSE_REPLACED = 4000;
const REPLACED_MESSAGE =
  "Another Chrome window or profile connected to the bridge, so this one stepped back. Connect again here to take over.";

// ------------------------------------------------------------------ bridge

async function loadConfig() {
  const { config } = (await chrome.storage.local.get("config")) as { config?: { port?: unknown; token?: unknown } };
  if (config && typeof config.port === "number") state.config = { port: config.port, token: String(config.token ?? "") };
  // Remember a takeover across service-worker restarts (until the browser restarts),
  // or two profiles would keep stealing the bridge from each other.
  try {
    const { replaced } = (await chrome.storage.session.get("replaced")) as { replaced?: boolean };
    if (replaced) {
      state.conn = "replaced";
      state.error = REPLACED_MESSAGE;
    }
  } catch {
    // storage.session unavailable
  }
}

function setConn(conn: BridgeState["conn"], error?: string) {
  state.conn = conn;
  state.error = error;
  broadcast({ event: "state", params: state });
}

function scheduleReconnect() {
  if (retryTimer || state.conn === "unpaired" || state.conn === "replaced") return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10_000);
}

function connect() {
  if (state.conn === "replaced") return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!state.config.token) {
    setConn("unpaired", "Paste the pairing token printed by the bridge.");
    return;
  }
  setConn("connecting");
  const socket = new WebSocket(`ws://127.0.0.1:${state.config.port}/ext`);
  ws = socket;
  const peer = new RpcPeer({ send: (env: Envelope) => socket.send(JSON.stringify(env)), timeoutMs: 60_000 });

  peer.handle("notebook.op", ({ tabId, op }: { tabId: number; op: NotebookOp }) => runOp(tabId, op));
  peer.on("agents.changed", (params: { agents: BridgeState["agents"] }) => {
    state.agents = params.agents;
    broadcast({ event: "state", params: state });
  });
  for (const method of ["chat.snapshot", "chat.message", "chat.status"]) {
    peer.on(method, (params) => broadcast({ event: "bridge", params: { method, params } }));
  }

  socket.onopen = async () => {
    try {
      const hello = await peer.request<{ bridgeVersion: string; agents: BridgeState["agents"] }>("hello", {
        token: state.config.token,
        wire: WIRE_VERSION,
        extensionVersion: VERSION,
      });
      rpc = peer;
      retryDelay = 1000;
      state.agents = hello.agents;
      state.bridgeVersion = hello.bridgeVersion;
      setConn("connected");
      for (const [tabId, t] of tabs) peer.emit("notebook.attached", { tabId, info: t.info });
    } catch (e) {
      const msg = (e as Error).message;
      setConn(/token/i.test(msg) ? "unpaired" : "disconnected", msg);
      socket.close();
    }
  };
  socket.onmessage = (e) => {
    try {
      void peer.receive(JSON.parse(String(e.data)));
    } catch {
      // ignore malformed frames
    }
  };
  socket.onclose = (e) => {
    peer.failAll("bridge connection closed");
    if (ws === socket) {
      ws = null;
      rpc = null;
      if (e.code === CLOSE_REPLACED) {
        setConn("replaced", REPLACED_MESSAGE);
        void chrome.storage.session?.set({ replaced: true }).catch(() => {});
      } else if (state.conn !== "unpaired") {
        setConn("disconnected", state.conn === "connected" ? "Lost the connection to the bridge." : "The bridge is not running.");
        scheduleReconnect();
      }
    }
  };
}

function reconnect() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 1000;
  state.conn = "disconnected";
  void chrome.storage.session?.remove("replaced").catch(() => {});
  const old = ws;
  ws = null;
  rpc = null;
  old?.close();
  connect();
}

// ------------------------------------------------------------------ notebook frames

/**
 * Add the notebook's stable key. It comes from the tab's top-level URL: on
 * Kaggle the notebook lives in an iframe that does not know which notebook it is.
 */
async function withKey(tabId: number, info: NotebookInfo, tabUrl?: string): Promise<NotebookInfo> {
  let url = tabUrl;
  if (!url) {
    try {
      url = (await chrome.tabs.get(tabId)).url;
    } catch {
      url = undefined;
    }
  }
  return { ...info, key: notebookKey(info.platform, url ?? info.url, info.docPath) };
}

async function runOp(tabId: number, op: NotebookOp): Promise<unknown> {
  let t = tabs.get(tabId);
  if (!t) t = (await discover(tabId)) ?? undefined;
  if (!t) throw new Error("No notebook is open in that tab any more.");
  const msg: BackgroundToContent = { type: "ainb.op", op };
  let res: OpResponse | undefined;
  try {
    res = await chrome.tabs.sendMessage(tabId, msg, { frameId: t.frameId });
  } catch {
    tabs.delete(tabId);
    throw new Error("The notebook page is not reachable (it may have reloaded). Try again.");
  }
  if (!res) throw new Error("The notebook page did not answer.");
  if (!res.ok) throw new Error(res.error);
  if (op.op === "info") return withKey(tabId, res.result as NotebookInfo);
  return res.result;
}

/** Ask every frame of a tab whether it holds a notebook. */
async function discover(tabId: number): Promise<{ frameId: number; info: NotebookInfo } | null> {
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null = null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }
  for (const f of frames ?? [{ frameId: 0 } as chrome.webNavigation.GetAllFrameResultDetails]) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: "ainb.ping" } satisfies BackgroundToContent, { frameId: f.frameId });
      if (r?.attached) {
        const entry = { frameId: f.frameId, info: await withKey(tabId, r.info as NotebookInfo) };
        tabs.set(tabId, entry);
        return entry;
      }
    } catch {
      // no content script in that frame
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg: ContentToBackground, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId === undefined) return;
  if (msg.type === "ainb.attached") {
    const frameId = sender.frameId;
    void withKey(tabId, msg.info, sender.tab?.url).then((info) => {
      tabs.set(tabId, { frameId, info });
      rpc?.emit("notebook.attached", { tabId, info });
      broadcast({ event: "notebook", params: { tabId, info } });
    });
  } else if (msg.type === "ainb.event") {
    const t = tabs.get(tabId);
    if (t && msg.event.type === "selection_changed") {
      t.info = { ...t.info, activeCellId: msg.event.activeCellId, selectedCellIds: msg.event.selectedCellIds };
      broadcast({ event: "notebook", params: { tabId, info: t.info } });
    }
    rpc?.emit("notebook.event", { tabId, event: msg.event });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  rpc?.request("tab.closed", { tabId }).catch(() => {});
});

// A real navigation of the notebook's frame (or the whole tab) drops the page
// script; it re-announces when the new document is ready. Same-document URL
// changes (Colab rewrites #scrollTo=... as cells change) fire other events and
// keep the notebook attached.
chrome.webNavigation.onCommitted.addListener((d) => {
  const t = tabs.get(d.tabId);
  if (!t || (d.frameId !== 0 && d.frameId !== t.frameId)) return;
  tabs.delete(d.tabId);
  rpc?.emit("notebook.detached", { tabId: d.tabId });
  broadcast({ event: "notebook", params: { tabId: d.tabId, info: null } });
});

// ------------------------------------------------------------------ side panels

function broadcast(e: PanelEvent) {
  for (const p of panels) {
    try {
      p.postMessage(e);
    } catch {
      panels.delete(p);
    }
  }
}

async function handlePanel(method: string, params: any): Promise<unknown> {
  switch (method) {
    case "state.get":
      return state;
    case "config.set": {
      const port = Number(params.port) || BRIDGE_DEFAULT_PORT;
      state.config = { port, token: String(params.token ?? "").trim() };
      await chrome.storage.local.set({ config: state.config });
      reconnect();
      return state;
    }
    case "tab.notebook": {
      const t = tabs.get(params.tabId) ?? (await discover(params.tabId));
      return t?.info ?? null;
    }
    case "notebook.focus":
      return runOp(params.tabId, { op: "focus_cell", cellId: params.cellId });
    default:
      if (!rpc) throw new Error("Not connected to the bridge.");
      return rpc.request(method, params, 120_000);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
  port.onMessage.addListener((req: PanelRequest) => {
    handlePanel(req.method, req.params).then(
      (result) => port.postMessage({ id: req.id, ok: true, result: result ?? null } satisfies PanelResponse),
      (e: Error) => port.postMessage({ id: req.id, ok: false, error: e?.message ?? String(e) } satisfies PanelResponse),
    );
  });
  port.postMessage({ event: "state", params: state } satisfies PanelEvent);
  if (state.conn === "disconnected") reconnect();
});

// ------------------------------------------------------------------ startup

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

void loadConfig().then(connect);
// A wake-up alarm reconnects after the worker was suspended without a socket.
chrome.alarms.create("ainb-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws) connect();
});
