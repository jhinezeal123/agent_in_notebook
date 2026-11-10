// The side panel's channel to the background service worker. Reconnects when
// the worker restarts.

import type { PanelEvent, PanelResponse } from "../shared/panel-messages.js";

type Listener = (e: PanelEvent) => void;

export class PanelClient {
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

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const client = new PanelClient();
