import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { OpRunner, type NotebookInfo, type NotebookOp } from "@ainb/protocol";
import type { PanelEvent, PanelRequest, PanelResponse, Prefs } from "../../extension/src/shared/panel-messages.js";
import { BridgeLink } from "./bridge.js";
import { VSCodeNotebook } from "./notebook.js";

const bridgeMethods = new Set([
  "agents.list", "agents.save", "agents.remove", "agents.test", "chat.get", "chat.send",
  "chat.cancel", "chat.settings", "chat.option", "chat.answer", "chat.review", "chat.undo",
]);
const secret = "bridge.config";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new NotebookPanel(context);
  context.subscriptions.push(panel, vscode.window.registerWebviewViewProvider("ainb.chat", panel, {
    webviewOptions: { retainContextWhenHidden: true },
  }), vscode.commands.registerCommand("ainb.open", () => vscode.commands.executeCommand("ainb.chat.focus")));
}

interface OpenNotebook {
  tabId: number;
  adapter: VSCodeNotebook;
  runner: OpRunner;
  edit: Promise<unknown>;
  chatId?: string;
  agentId?: string;
}

const editOps = new Set<NotebookOp["op"]>(["update_cell", "insert_cell", "delete_cell", "move_cell", "resolve_review"]);

class NotebookPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[];
  private readonly notebooks = new Map<vscode.NotebookDocument, OpenNotebook>();
  private activeTab: number | null = null;
  private nextTab = 1;
  private readonly bridge: BridgeLink;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bridge = new BridgeLink(context.extension.packageJSON.version, (event) => {
      this.post(event);
      if (event.event !== "state") return;
      for (const notebook of this.notebooks.values()) {
        if (event.params.conn === "connected") this.attach(notebook.tabId, notebook.adapter.info());
        else {
          notebook.chatId = undefined;
          notebook.agentId = undefined;
          void notebook.runner.discardReviews();
        }
      }
    }, ({ tabId, op }) => this.runOp(tabId, op));
    this.subscriptions = [
      vscode.window.onDidChangeActiveNotebookEditor(() => this.activeChanged()),
      vscode.workspace.onDidChangeNotebookDocument(({ notebook, cellChanges }) => {
        if (cellChanges.some((change) => change.executionSummary)) this.notebooks.get(notebook)?.adapter.refreshKernel();
        this.refresh(notebook);
      }),
      vscode.workspace.onDidCloseNotebookDocument((document) => this.closeNotebook(document)),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const assets = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
    this.view = view;
    const listener = view.webview.onDidReceiveMessage((request: PanelRequest) => {
      if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== "string") return;
      const respond = (response: PanelResponse) => { void view.webview.postMessage(response); };
      void this.handle(request.method, request.params).then(
        (result) => respond({ id: request.id, ok: true, result: result ?? null }),
        (error: Error) => respond({ id: request.id, ok: false, error: error.message }),
      );
    });
    view.onDidDispose(() => {
      listener.dispose();
      if (this.view === view) this.view = undefined;
    });
    view.webview.html = panelHtml(view.webview, assets);
    this.activeChanged();
    if (this.bridge.snapshot().conn === "disconnected") void this.connect().catch((error: Error) => vscode.window.showErrorMessage(`Agent in Notebook: ${error.message}`));
  }

  private async connect(): Promise<void> {
    const saved = await this.context.secrets.get(secret);
    await this.bridge.connect(saved ? JSON.parse(saved) : undefined);
  }

  private activeChanged(): void {
    if (!this.view) return;
    const document = vscode.window.activeNotebookEditor?.notebook;
    const supported = document?.notebookType === "jupyter-notebook";
    let notebook = supported ? this.notebooks.get(document) : undefined;
    if (supported && !notebook) {
      const tabId = this.nextTab++;
      const adapter = new VSCodeNotebook(document, () => this.refresh(document));
      const runner = new OpRunner(adapter, (event) => {
        this.bridge.emit("notebook.event", { tabId, event });
        if (event.type === "selection_changed") this.refresh(document);
      });
      notebook = { tabId, adapter, runner, edit: Promise.resolve() };
      this.notebooks.set(document, notebook);
    }
    this.activeTab = notebook?.tabId ?? null;
    this.post({ event: "activeTab", params: this.activeTab });
    if (document) this.refresh(document);
  }

  private closeNotebook(document: vscode.NotebookDocument): void {
    const notebook = this.notebooks.get(document);
    if (!notebook) return;
    const { tabId, adapter } = notebook;
    this.notebooks.delete(document);
    this.bridge.emit("notebook.detached", { tabId });
    void this.bridge.request("tab.closed", { tabId }).catch(() => {});
    adapter.dispose();
    if (this.activeTab === tabId) this.activeChanged();
  }

  private attach(tabId: number, info: NotebookInfo): void { this.bridge.emit("notebook.attached", { tabId, info }); }

  private refresh(document: vscode.NotebookDocument): void {
    const notebook = this.notebooks.get(document);
    if (!notebook) return;
    const { tabId, adapter } = notebook;
    const info = adapter.info();
    this.attach(tabId, info);
    if (tabId === this.activeTab) this.post({ event: "notebook", params: { tabId, info } });
  }

  private post(event: PanelEvent): void { void this.view?.webview.postMessage(event); }

  private find(tabId: number) { return [...this.notebooks.values()].find((notebook) => notebook.tabId === tabId); }

  private runOp(tabId: number, op: NotebookOp): Promise<unknown> {
    const notebook = this.find(tabId);
    if (!notebook) return Promise.reject(new Error("That notebook is no longer open in VS Code."));
    const run = () => {
      if (notebook.adapter.document.isClosed) throw new Error("That notebook is no longer open in VS Code.");
      return notebook.runner.run(op);
    };
    if (!editOps.has(op.op)) return Promise.resolve().then(run);
    const task = notebook.edit.then(run);
    notebook.edit = task.catch(() => {});
    return task;
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "state.get": return this.bridge.snapshot();
      case "activeTab.get": return this.activeTab;
      case "prefs.get": return this.context.globalState.get<Prefs>("prefs");
      case "prefs.set": return this.context.globalState.update("prefs", params);
      case "config.auto": return this.connect();
      case "config.prompt": {
        const token = await vscode.window.showInputBox({ title: "Agent in Notebook pairing token", password: true, ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : "Enter the token printed by pnpm bridge." });
        if (!token) return;
        const port = await vscode.window.showInputBox({ title: "Bridge port", value: String(this.bridge.port), validateInput: (value) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? undefined : "Enter a port from 1 to 65535." });
        if (!port) return;
        const config = { port: Number(port), token: token.trim() };
        await this.context.secrets.store(secret, JSON.stringify(config));
        return this.bridge.connect(config);
      }
      case "config.reset": {
        await this.context.secrets.delete(secret);
        return this.connect();
      }
      case "clipboard.copy": return vscode.env.clipboard.writeText((params as { text: string }).text);
      case "link.open": {
        const uri = vscode.Uri.parse((params as { url: string }).url);
        if (uri.scheme === "http" || uri.scheme === "https" || uri.scheme === "mailto") return vscode.env.openExternal(uri);
        return false;
      }
      case "tab.notebook": return this.find((params as { tabId: number }).tabId)?.adapter.info() ?? null;
      case "notebook.focus": {
        const { tabId, cellId } = params as { tabId: number; cellId: string };
        return this.runOp(tabId, { op: "focus_cell", cellId });
      }
      case "notebook.insert": {
        const { tabId, source, cellType } = params as { tabId: number; source: string; cellType: "code" | "markdown" };
        const notebook = this.find(tabId);
        if (!notebook) throw new Error("That notebook is no longer open in VS Code.");
        const info = notebook.adapter.info();
        const selected = info.activeCellId ? notebook.adapter.getCells({ cellIds: [info.activeCellId] })[0] : undefined;
        const index = selected ? selected.index + 1 : info.cellCount;
        const result = await this.runOp(tabId, { op: "insert_cell", index, source, cellType, review: false, byUser: true }) as { cellId: string };
        await notebook.adapter.focusCell(result.cellId).catch(() => {});
        return result;
      }
      case "chat.open": {
        const { tabId, agentId } = params as { tabId: number; agentId: string };
        const notebook = this.find(tabId);
        if (!notebook) throw new Error("That notebook is no longer open in VS Code.");
        if (notebook.agentId && notebook.agentId !== agentId) await notebook.runner.discardReviews();
        const info = notebook.adapter.info();
        const result = await this.bridge.request(method, { ...(params as object), platform: info.platform, notebookKey: info.key }) as { chatId: string; agentId: string };
        notebook.chatId = result.chatId;
        notebook.agentId = result.agentId;
        return result;
      }
      case "chat.close": {
        const { chatId } = params as { chatId: string };
        const notebook = [...this.notebooks.values()].find((candidate) => candidate.chatId === chatId);
        await notebook?.runner.discardReviews();
        return this.bridge.request(method, params);
      }
      default:
        if (!bridgeMethods.has(method)) throw new Error(`Unknown panel request: ${method}`);
        return this.bridge.request(method, params);
    }
  }

  dispose(): void {
    this.bridge.dispose();
    for (const { adapter } of this.notebooks.values()) adapter.dispose();
    this.notebooks.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

function panelHtml(webview: vscode.Webview, assets: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, name));
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("sidepanel.css")}">
<link rel="stylesheet" href="${asset("theme.css")}">
<title>Agent in Notebook</title>
</head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${asset("webview.js")}"></script></body></html>`;
}
