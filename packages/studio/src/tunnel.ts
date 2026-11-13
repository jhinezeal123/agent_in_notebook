// Inside a webview: route OpenResearch's own requests through the extension.
// Its client code uses the browser's fetch and EventSource on "/api/...";
// these stand-ins carry them as messages to the extension, which talks to the
// OpenResearch the bridge runs (a webview cannot reach it directly: it is
// another origin, and OpenResearch accepts writes only from its own pages).

import type { FromHost, HostEvents, ToHost } from "./messages.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let vscode: VsCodeApi | undefined;
let nextId = 1;
const fetches = new Map<number, { resolve: (r: Response) => void; reject: (e: unknown) => void }>();
const streams = new Map<number, TunnelEventSource>();
const requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<(event: string, params: unknown) => void>();

function post(message: ToHost): void {
  vscode!.postMessage(message);
}

const isOrxPath = (path: string) => path.startsWith("/api/") || path.startsWith("/_orx/");

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Install the stand-ins. Call once, before OpenResearch's code runs. */
export function installTunnel(): VsCodeApi {
  if (vscode) return vscode;
  // VS Code hands its API out once per webview: the chat panel's own code may have it already.
  const shared = window as unknown as { __ainbVsCode?: VsCodeApi };
  vscode = shared.__ainbVsCode ??= acquireVsCodeApi();
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!isOrxPath(url.pathname)) return realFetch(input, init);
    const id = nextId++;
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : toBase64(new Uint8Array(await request.arrayBuffer()));
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? request.signal;
      if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      const onAbort = () => {
        if (!fetches.delete(id)) return;
        post({ type: "orx.abort", id });
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      fetches.set(id, {
        resolve: (r) => { signal?.removeEventListener("abort", onAbort); resolve(r); },
        reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
      });
      post({ type: "orx.fetch", id, url: url.pathname + url.search, method: request.method, headers, body });
    });
  };

  (window as unknown as { EventSource: unknown }).EventSource = TunnelEventSource;

  window.addEventListener("message", (e: MessageEvent<FromHost>) => {
    const m = e.data;
    if (!m || typeof m !== "object" || typeof (m as { type?: unknown }).type !== "string") return;
    switch (m.type) {
      case "orx.response": {
        const p = fetches.get(m.id);
        if (!p) return;
        fetches.delete(m.id);
        const nullBody = m.status === 204 || m.status === 304;
        p.resolve(new Response(nullBody ? null : (fromBase64(m.body) as BodyInit), { status: m.status, statusText: m.statusText, headers: m.headers }));
        return;
      }
      case "orx.error": {
        const p = fetches.get(m.id);
        if (!p) return;
        fetches.delete(m.id);
        p.reject(new TypeError(m.message));
        return;
      }
      case "orx.sse.open": streams.get(m.id)?.opened(); return;
      case "orx.sse.event": streams.get(m.id)?.deliver(m.event, m.data, m.lastEventId); return;
      case "orx.sse.error": streams.get(m.id)?.failed(m.closed); return;
      case "host.response": {
        const p = requests.get(m.id);
        if (!p) return;
        requests.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error));
        return;
      }
      case "host.event":
        for (const l of listeners) l(m.event, m.params);
        return;
    }
  });
  return vscode;
}

/** EventSource over the extension. Reconnects after a drop, as a browser's does. */
class TunnelEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private id = 0;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(url: string | URL) {
    super();
    const u = new URL(String(url), location.href);
    this.url = u.href;
    this.connect(u.pathname + u.search);
  }

  private connect(path: string): void {
    this.id = nextId++;
    streams.set(this.id, this);
    post({ type: "orx.sse", id: this.id, url: path });
  }

  opened(): void {
    this.readyState = 1;
    const e = new Event("open");
    this.onopen?.(e);
    this.dispatchEvent(e);
  }

  deliver(event: string, data: string, lastEventId: string): void {
    const e = new MessageEvent(event || "message", { data, lastEventId });
    if (!event || event === "message") this.onmessage?.(e);
    this.dispatchEvent(e);
  }

  failed(closed: boolean): void {
    streams.delete(this.id);
    if (this.readyState === 2) return;
    this.readyState = closed ? 2 : 0;
    const e = new Event("error");
    this.onerror?.(e);
    this.dispatchEvent(e);
    if (!closed) {
      const u = new URL(this.url);
      this.retry = setTimeout(() => { if (this.readyState !== 2) this.connect(u.pathname + u.search); }, 3000);
    }
  }

  close(): void {
    this.readyState = 2;
    clearTimeout(this.retry);
    if (streams.delete(this.id)) post({ type: "orx.sse.close", id: this.id });
  }
}

/** Ask the extension for something (open a tab, the notebooks, a setting...). */
export function hostRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    requests.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "host.request", id, method, params });
  });
}

export function onHostEvent<K extends keyof HostEvents>(event: K, fn: (params: HostEvents[K]) => void): () => void {
  const l = (e: string, p: unknown) => { if (e === event) fn(p as HostEvents[K]); };
  listeners.add(l);
  return () => listeners.delete(l);
}
