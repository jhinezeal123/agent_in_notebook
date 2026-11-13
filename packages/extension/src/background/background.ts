// Service worker: the extension's one connection to the local bridge, and the
// router for notebook ops to the right tab and frame. The chat itself is in
// VS Code; this extension only serves the notebooks open in Chrome tabs.

import {
  BRIDGE_DEFAULT_PORT,
  NATIVE_HOST,
  notebookKey,
  RpcPeer,
  WIRE_VERSION,
  type Envelope,
  type NativeReply,
  type NativeRequest,
  type NotebookInfo,
  type NotebookOp,
} from "@ainb/protocol";
import type { BackgroundToContent, ContentToBackground, OpResponse } from "../shared/page-messages.js";

const VERSION = chrome.runtime.getManifest().version;

type Conn = "disconnected" | "connecting" | "connected" | "unpaired" | "replaced";
interface Config {
  port: number;
  token: string;
  /** `manual`: written by hand (tests, devtools), so the native host does not replace it. */
  source?: "native" | "manual";
}

const state: { conn: Conn; error?: string; config: Config } = { conn: "disconnected", config: { port: BRIDGE_DEFAULT_PORT, token: "" } };
/** Notebook frames by tab. */
const tabs = new Map<number, { frameId: number; info: NotebookInfo }>();

let ws: WebSocket | null = null;
let rpc: RpcPeer | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;

/** The bridge closes a connection with this code when a newer one replaces it. */
const CLOSE_REPLACED = 4000;
/** ...and with this one when it shuts down on purpose (Ctrl+C, `ainb stop`). */
const CLOSE_STOPPED = 4001;
const REPLACED_MESSAGE = "Another Chrome window or profile connected to the bridge. Click the extension's icon to take over.";

/** Ask the native host (which can start the bridge) before the next connection attempt. */
let askNative = true;
/** The bridge was stopped on purpose: no automatic reconnect or restart until the user asks. */
let stopped = false;
let connecting: Promise<void> | null = null;

// ------------------------------------------------------------------ bridge

async function loadConfig() {
  const { config } = (await chrome.storage.local.get("config")) as { config?: { port?: unknown; token?: unknown; source?: unknown } };
  if (config && typeof config.port === "number") {
    state.config = { port: config.port, token: String(config.token ?? ""), source: config.source === "manual" ? "manual" : config.source === "native" ? "native" : undefined };
  }
  // Remember a takeover across service-worker restarts (until the browser restarts),
  // or two profiles would keep stealing the bridge from each other.
  try {
    const { replaced } = (await chrome.storage.session.get("replaced")) as { replaced?: boolean };
    if (replaced) setConn("replaced", REPLACED_MESSAGE);
  } catch {
    // storage.session unavailable
  }
}

// A pairing config written outside this worker (devtools, tests): use it.
// The worker's own writes match what it holds already and change nothing.
chrome.storage.onChanged.addListener((changes, area) => {
  const next = changes.config?.newValue as { port?: unknown; token?: unknown; source?: unknown } | undefined;
  if (area !== "local" || !next || typeof next.port !== "number") return;
  const source = next.source === "manual" ? "manual" : next.source === "native" ? "native" : undefined;
  const token = String(next.token ?? "");
  const c = state.config;
  if (c.port === next.port && c.token === token && c.source === source) return;
  state.config = { port: next.port, token, source };
  reconnect();
});

/** The icon's badge tells whether the notebooks here reach the bridge (and so VS Code). */
function setConn(conn: Conn, error?: string) {
  state.conn = conn;
  state.error = error;
  const text = conn === "connected" ? "" : conn === "connecting" ? "…" : tabs.size ? "!" : "";
  void chrome.action.setBadgeText({ text }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: "#b3261e" }).catch(() => {});
  const title = conn === "connected"
    ? `Agent in Notebook: connected. Chat about ${tabs.size === 1 ? "this notebook" : "these notebooks"} in VS Code.`
    : `Agent in Notebook: ${error ?? conn}. Click to connect again.`;
  void chrome.action.setTitle({ title }).catch(() => {});
}

function scheduleReconnect() {
  if (retryTimer || stopped || state.conn === "unpaired" || state.conn === "replaced") return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10_000);
}

/**
 * Ask the native host for the bridge's port and token; it starts the bridge if
 * it is not running.
 */
async function pairNatively(): Promise<{ ok: boolean; error?: string }> {
  let reply: NativeReply | undefined;
  try {
    reply = (await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "connect" } satisfies NativeRequest)) as NativeReply;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return { ok: false, error: /not found|forbidden/i.test(msg) ? 'The bridge is not registered with Chrome. Run "ainb install" once.' : msg };
  }
  if (!reply?.ok) return { ok: false, error: reply?.error ?? "The native host did not answer." };
  if (reply.port !== state.config.port || reply.token !== state.config.token || state.config.source !== "native") {
    state.config = { port: reply.port, token: reply.token, source: "native" };
    await chrome.storage.local.set({ config: state.config });
  }
  return { ok: true };
}

function connect(): void {
  connecting ??= connectNow().finally(() => (connecting = null));
}

async function connectNow(): Promise<void> {
  if (state.conn === "replaced") return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // Only start the bridge while a notebook is open here: that is the user
  // working on one, and the browser starting up is not.
  let fresh = false;
  if (askNative && tabs.size > 0 && state.config.source !== "manual") {
    askNative = false;
    setConn("connecting");
    const paired = await pairNatively();
    fresh = paired.ok;
    if (!paired.ok && !state.config.token) {
      setConn("disconnected", paired.error);
      return;
    }
  }
  if (!state.config.token) {
    setConn("unpaired", 'Not paired with the bridge. Run "ainb install" once.');
    return;
  }
  openSocket(fresh);
}

/** `fresh`: the config just came from the native host, so a rejected token is not worth asking it again. */
function openSocket(fresh: boolean): void {
  setConn("connecting");
  const socket = new WebSocket(`ws://127.0.0.1:${state.config.port}/ext`);
  ws = socket;
  const peer = new RpcPeer({ send: (env: Envelope) => socket.send(JSON.stringify(env)), timeoutMs: 60_000 });

  peer.handle("notebook.op", ({ tabId, op }: { tabId: number; op: NotebookOp }) => runOp(tabId, op));

  socket.onopen = async () => {
    try {
      await peer.request("hello", { token: state.config.token, wire: WIRE_VERSION, extensionVersion: VERSION });
      rpc = peer;
      retryDelay = 1000;
      setConn("connected");
      for (const [tabId, t] of tabs) peer.emit("notebook.attached", { tabId, info: t.info });
      void announceFocused();
    } catch (e) {
      const msg = (e as Error).message;
      const badToken = /token/i.test(msg);
      // The token may have been reset (`ainb token --reset`): the native host knows the new one.
      const retry = badToken && !fresh && state.config.source !== "manual" && tabs.size > 0;
      setConn(badToken ? "unpaired" : "disconnected", badToken && fresh ? `${msg}. The running bridge has another token than config.json: restart it ("ainb stop").` : msg);
      socket.close();
      if (retry) {
        askNative = true;
        state.conn = "disconnected";
        if (ws === socket) ws = null;
        connect();
      }
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
      } else if (e.code === CLOSE_STOPPED) {
        stopped = true;
        askNative = true;
        setConn("disconnected", "the bridge was stopped");
      } else if (state.conn !== "unpaired") {
        // Not running, or it crashed: the native host can start it again.
        askNative = true;
        setConn("disconnected", state.conn === "connected" ? "lost the connection to the bridge" : "the bridge is not running");
        scheduleReconnect();
      }
    }
  };
}

function reconnect() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 1000;
  stopped = false;
  askNative = true;
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
  if (op.op === "info") {
    const info = await withKey(tabId, res.result as NotebookInfo);
    t.info = info;
    return info;
  }
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
      if (rpc) {
        rpc.emit("notebook.attached", { tabId, info });
        if (sender.tab?.active) rpc.emit("notebook.focused", { tabId });
      } else connect();
    });
  } else if (msg.type === "ainb.event") {
    const t = tabs.get(tabId);
    if (t && msg.event.type === "selection_changed") {
      t.info = { ...t.info, activeCellId: msg.event.activeCellId, selectedCellIds: msg.event.selectedCellIds };
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
});

/**
 * After the worker restarts, the pages are still there but no longer known:
 * ask the tabs that may hold a notebook.
 */
async function discoverAll(): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const patterns = manifest.content_scripts?.[0]?.matches ?? [];
  let found: chrome.tabs.Tab[] = [];
  try {
    found = await chrome.tabs.query({ url: patterns });
  } catch {
    found = [];
  }
  await Promise.all(found.map((t) => (t.id === undefined || tabs.has(t.id) ? null : discover(t.id))));
}

// The notebook the user looks at in Chrome is the one VS Code's chat follows.
async function announceFocused(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined && tabs.has(tab.id)) rpc?.emit("notebook.focused", { tabId: tab.id });
  } catch {
    // no window
  }
}
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (tabs.has(tabId)) rpc?.emit("notebook.focused", { tabId });
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void announceFocused();
});

// ------------------------------------------------------------------ startup

// The icon is the one control here: connect again (after a takeover, a stop, a token change).
chrome.action.onClicked.addListener(() => reconnect());

void loadConfig().then(discoverAll).then(connect);
// A wake-up alarm reconnects after the worker was suspended without a socket.
chrome.alarms.create("ainb-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws && !stopped) connect();
});
