// The side panel's channel to the background service worker. Reconnects when
// the worker restarts.

import type { PanelEvent, PanelResponse, Prefs } from "../shared/panel-messages.js";

import { externalChatUrl } from "../shared/chat-links.js";
import type { PanelHost } from "./host.js";

type Listener = (e: PanelEvent) => void;

export class PanelClient implements PanelHost {
  readonly kind = "browser" as const;
  private port: chrome.runtime.Port | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();

  constructor() {
    this.open();
  }

  private open() {
    const port = chrome.runtime.connect({ name: "sidepanel" });
    this.port = port;
    port.onMessage.addListener((msg: PanelResponse | PanelEvent) => {
      if ("event" in msg) {
        this.listeners.forEach((l) => l(msg));
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    port.onDisconnect.addListener(() => {
      this.port = null;
      for (const p of this.pending.values()) p.reject(new Error("The extension restarted. Try again."));
      this.pending.clear();
      setTimeout(() => this.open(), 300);
    });
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.port) return reject(new Error("The extension is restarting. Try again."));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ id, method, params });
    });
  }

  watchTab(listener: (id: number | null) => void): () => void {
    // A pinned panel is used when it is opened as a page, e.g. in tests.
    const pinned = Number(new URLSearchParams(location.search).get("tab"));
    if (pinned) {
      listener(pinned);
      return () => {};
    }
    let windowId: number | undefined;
    let watching = true;
    let activation = 0;
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (windowId !== undefined && info.windowId === windowId) {
        activation++;
        listener(info.tabId);
      }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    void chrome.windows.getCurrent().then(async (window) => {
      windowId = window.id;
      const observed = activation;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (watching && observed === activation) listener(tab?.id ?? null);
    }).catch(() => {});
    return () => {
      watching = false;
      chrome.tabs.onActivated.removeListener(onActivated);
    };
  }

  async getPrefs(): Promise<Partial<Prefs> | undefined> {
    return (await chrome.storage.local.get<{ prefs?: Partial<Prefs> }>("prefs")).prefs;
  }

  async setPrefs(prefs: Prefs): Promise<void> {
    await chrome.storage.local.set({ prefs });
  }

  copy(text: string): Promise<void> { return navigator.clipboard.writeText(text); }

  async openLink(target: string): Promise<unknown> {
    const url = externalChatUrl(target);
    if (url) return chrome.tabs.create({ url });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const client = new PanelClient();
