// A paper's reading tab: the page from packages/ui/src/reader, with requests
// answered by ReaderHost in the extension host.

import { render } from "preact";
import { ReaderApp } from "../../ui/src/reader/app.js";
import type { ReaderPageHost } from "../../ui/src/reader/host.js";

interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

type Message = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string } | { event: string; params?: unknown };

const vscode = acquireVsCodeApi();
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Set<(event: { event: string; params?: unknown }) => void>();
let nextId = 1;

window.addEventListener("message", ({ data }: MessageEvent<Message>) => {
  if (!data || typeof data !== "object") return;
  if ("event" in data) {
    for (const listener of listeners) listener(data);
    return;
  }
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.ok) request.resolve(data.result);
  else request.reject(new Error(data.error));
});

const host: ReaderPageHost = {
  request<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      vscode.postMessage({ id, method, params: params ?? {} });
    });
  },
  on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

render(<ReaderApp host={host} />, document.getElementById("root")!);
