import { render } from "preact";
import { App } from "../../ui/src/app.js";
import { PanelHostContext, type PanelHost } from "../../ui/src/host.js";
import type { PanelEvent, PanelRequest, PanelResponse, Prefs } from "../../ui/src/panel-messages.js";

// VS Code exposes this API only inside its webview and it can be acquired once.
declare function acquireVsCodeApi(): { postMessage(message: PanelRequest): void };
const vscode = acquireVsCodeApi();
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Set<(event: PanelEvent) => void>();
let nextId = 1;

window.addEventListener("message", ({ data }: MessageEvent<PanelEvent | PanelResponse>) => {
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

const host: PanelHost = {

  request<T>(method: string, params: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: (result) => resolve(result as T), reject });
      vscode.postMessage({ id, method, params });
    });
  },
  on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  watchTab(listener) {
    let observed = false;
    const unlisten = this.on((event) => {
      if (event.event !== "activeTab") return;
      observed = true;
      listener(event.params);
    });
    void this.request<number | null>("activeTab.get").then((id) => { if (!observed) listener(id); }, () => {});
    return () => { observed = true; unlisten(); };
  },
  getPrefs() { return this.request<Prefs | undefined>("prefs.get"); },
  setPrefs(prefs) { return this.request("prefs.set", prefs); },
  copy(text) { return this.request("clipboard.copy", { text }); },
  openLink(url) { return this.request("link.open", { url }); },
};

render(<PanelHostContext.Provider value={host}><App /></PanelHostContext.Provider>, document.getElementById("root")!);
