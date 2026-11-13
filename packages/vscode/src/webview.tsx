import { render } from "preact";
import { App } from "../../ui/src/app.js";
import { PanelHostContext, type PanelHost } from "../../ui/src/host.js";
import type { PanelEvent, PanelRequest, PanelResponse, Prefs } from "../../ui/src/panel-messages.js";

// VS Code exposes this API only inside its webview and it can be acquired once;
// the research chat's code (studio.js, loaded next) takes it from here.
interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
type ResearchChat = { projectId: string; sessionId: string };
type Selected = { kind: "notebook"; tabId: number } | ({ kind: "research" } & ResearchChat) | null;
const page = window as unknown as {
  __ainbVsCode?: VsCodeApi;
  ainbStudio?: { showChat(element: HTMLElement, chat: ResearchChat | null): void };
};
const vscode = (page.__ainbVsCode ??= acquireVsCodeApi());
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Set<(event: PanelEvent) => void>();
let nextId = 1;

window.addEventListener("message", ({ data }: MessageEvent<PanelEvent | PanelResponse>) => {
  if (!data || typeof data !== "object") return;
  // Typed messages belong to the research chat's code (its requests and OpenResearch's answers).
  const typed = data as { type?: unknown; event?: unknown; params?: unknown };
  if (typeof typed.type === "string") {
    if (typed.type === "host.event" && typed.event === "chat.selected") showChat(typed.params as Selected);
    return;
  }
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

const root = document.getElementById("root")!;
render(<PanelHostContext.Provider value={host}><App /></PanelHostContext.Provider>, root);

// The chat panel shows the notebook chat, or a research chat (OpenResearch's)
// in a shadow root of its own, so the two chats' styles stay apart.
const research = document.getElementById("research")!;
let mount: HTMLElement | undefined;
function researchMount(): HTMLElement {
  if (mount) return mount;
  const shadow = research.attachShadow({ mode: "open" });
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = research.dataset.css!;
  mount = document.createElement("div");
  mount.style.height = "100%";
  shadow.append(css, mount);
  return mount;
}

function showChat(selected: Selected): void {
  const studio = page.ainbStudio;
  if (!studio) {
    window.addEventListener("load", () => showChat(selected), { once: true });
    return;
  }
  const chat = selected?.kind === "research" ? { projectId: selected.projectId, sessionId: selected.sessionId } : null;
  root.style.display = chat ? "none" : "";
  research.style.display = chat ? "" : "none";
  if (chat || mount) studio.showChat(researchMount(), chat);
}

void host.request<Selected>("chat.selected").then((selected) => { if (selected?.kind === "research") showChat(selected); }, () => {});
