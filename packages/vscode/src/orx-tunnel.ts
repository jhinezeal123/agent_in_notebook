// The extension's side of the research views' tunnel (see studio/src/tunnel.ts):
// their OpenResearch requests and event streams, made here to the
// OpenResearch the bridge runs, as a local process (no browser Origin).

import type { FromHost, ToHost } from "../../studio/src/messages.js";

/** Headers a webview must not pass on: OpenResearch would take the request for a cross-site one. */
const DROP = new Set(["origin", "referer", "host", "cookie", "connection", "content-length"]);

export class OrxTunnel {
  private readonly aborts = new Map<number, AbortController>();

  constructor(
    /** OpenResearch's address, starting it if needed; rejects with why it is not available. */
    private readonly baseUrl: () => Promise<string>,
    private readonly send: (message: FromHost) => void,
  ) {}

  /** Handle a message from the webview; false when it is not a tunnel message. */
  handle(message: ToHost): boolean {
    switch (message.type) {
      case "orx.fetch": void this.fetch(message); return true;
      case "orx.abort": this.abort(message.id); return true;
      case "orx.sse": void this.stream(message.id, message.url); return true;
      case "orx.sse.close": this.abort(message.id); return true;
      default: return false;
    }
  }

  dispose(): void {
    for (const id of [...this.aborts.keys()]) this.abort(id);
  }

  private abort(id: number): void {
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
  }

  private async fetch(m: Extract<ToHost, { type: "orx.fetch" }>): Promise<void> {
    if (!isOrxPath(m.url)) return this.send({ type: "orx.error", id: m.id, message: "Not an OpenResearch address." });
    const controller = new AbortController();
    this.aborts.set(m.id, controller);
    try {
      const base = await this.baseUrl();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.headers)) if (!DROP.has(k.toLowerCase()) && !k.toLowerCase().startsWith("sec-")) headers[k] = v;
      const res = await fetch(base + m.url, {
        method: m.method,
        headers,
        body: m.body === undefined ? undefined : Buffer.from(m.body, "base64"),
        signal: controller.signal,
      });
      const body = Buffer.from(await res.arrayBuffer()).toString("base64");
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { out[k] = v; });
      if (this.aborts.get(m.id) === controller) this.send({ type: "orx.response", id: m.id, status: res.status, statusText: res.statusText, headers: out, body });
    } catch (e) {
      if (this.aborts.get(m.id) === controller) this.send({ type: "orx.error", id: m.id, message: (e as Error).message });
    } finally {
      if (this.aborts.get(m.id) === controller) this.aborts.delete(m.id);
    }
  }

  private async stream(id: number, url: string): Promise<void> {
    if (!isOrxPath(url)) return this.send({ type: "orx.sse.error", id, closed: true });
    const controller = new AbortController();
    this.aborts.set(id, controller);
    const live = () => this.aborts.get(id) === controller;
    try {
      const base = await this.baseUrl();
      const res = await fetch(base + url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
      if (!res.ok || !res.body) {
        // As a browser does: an answer that is not an event stream ends it for good.
        if (live()) this.send({ type: "orx.sse.error", id, closed: true });
        return;
      }
      if (!live()) return;
      this.send({ type: "orx.sse.open", id });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let lastEventId = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n?/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = "";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            const val = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") event = val;
            else if (field === "data") data.push(val);
            else if (field === "id") lastEventId = val;
          }
          if (data.length && live()) this.send({ type: "orx.sse.event", id, event, data: data.join("\n"), lastEventId });
        }
      }
      if (live()) this.send({ type: "orx.sse.error", id, closed: false });
    } catch {
      if (live()) this.send({ type: "orx.sse.error", id, closed: false });
    } finally {
      if (live()) this.aborts.delete(id);
    }
  }
}

function isOrxPath(url: string): boolean {
  return (url.startsWith("/api/") || url.startsWith("/_orx/")) && !url.includes("..");
}
