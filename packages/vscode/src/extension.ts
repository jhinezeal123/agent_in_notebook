import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { OpRunner, type NotebookInfo, type NotebookOp } from "@ainb/protocol";
import type { PanelEvent, PanelRequest, PanelResponse, Prefs } from "../../ui/src/panel-messages.js";
import { BridgeLink } from "./bridge.js";
import { openChatLink, readChatImage } from "./chat-links.js";
import { VSCodeNotebook } from "./notebook.js";
import { PanelCore, type LocalNotebooks } from "./panel-core.js";

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
  private nextTab = 1;
  private readonly bridge: BridgeLink;
  /** Which notebook the chat is about, and the notebooks in Chrome tabs. */
  private readonly core: PanelCore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bridge = new BridgeLink(context.extension.packageJSON.version, (event) => {
      this.post(event);
      if (event.event !== "state") return;
      const connected = event.params.conn === "connected";
      for (const notebook of this.notebooks.values()) {
        if (connected) this.attach(notebook.tabId, notebook.adapter.info());
        else {
          notebook.chatId = undefined;
          notebook.agentId = undefined;
          void notebook.runner.discardReviews();
        }
      }
      this.core.connectionChanged(connected);
    }, ({ tabId, op }) => this.runOp(tabId, op), (event) => this.core.onBrowser(event));
    this.core = new PanelCore(this.bridge, this.localNotebooks(), (event) => this.post(event));
    this.subscriptions = [
      vscode.window.onDidChangeActiveNotebookEditor(() => this.activeChanged()),
      vscode.workspace.onDidChangeNotebookDocument(({ notebook, cellChanges }) => {
        if (cellChanges.some((change) => change.executionSummary)) this.notebooks.get(notebook)?.adapter.refreshKernel();
        this.refresh(notebook);
      }),
      vscode.workspace.onDidCloseNotebookDocument((document) => this.closeNotebook(document)),
    ];
  }

  private localNotebooks(): LocalNotebooks {
    return {
      choices: () => [...this.notebooks.values()].map(({ tabId, adapter }) => {
        const info = adapter.info();
        return { tabId, platform: info.platform, title: info.title, place: "vscode" as const };
      }),
      has: (tabId) => !!this.find(tabId),
      info: (tabId) => this.find(tabId)?.adapter.info() ?? null,
      userOp: (tabId, op) => this.runOp(tabId, op),
      openChat: async (tabId, params) => {
        const notebook = this.find(tabId);
        if (!notebook) throw new Error("That notebook is no longer open in VS Code.");
        const agentId = params.agentId as string;
        if (notebook.agentId && notebook.agentId !== agentId) await notebook.runner.discardReviews();
        const info = notebook.adapter.info();
        const result = await this.bridge.request("chat.open", { ...params, platform: info.platform, notebookKey: info.key }) as { chatId: string; agentId: string };
        notebook.chatId = result.chatId;
        notebook.agentId = result.agentId;
        return result;
      },
      closeChat: async (chatId) => {
        const notebook = [...this.notebooks.values()].find((candidate) => candidate.chatId === chatId);
        await notebook?.runner.discardReviews();
      },
      reveal: async (tabId) => {
        const notebook = this.find(tabId);
        if (notebook) await vscode.window.showNotebookDocument(notebook.adapter.document, { preserveFocus: true, preview: false });
      },
      front: () => {
        const document = vscode.window.activeNotebookEditor?.notebook;
        return (document && this.notebooks.get(document)?.tabId) ?? null;
      },
    };
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
      this.core.localChanged();
    }
    this.core.follow(notebook?.tabId ?? null);
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
    this.core.localChanged();
  }

  private attach(tabId: number, info: NotebookInfo): void { this.bridge.emit("notebook.attached", { tabId, info }); }

  private refresh(document: vscode.NotebookDocument): void {
    const notebook = this.notebooks.get(document);
    if (!notebook) return;
    const { tabId, adapter } = notebook;
    const info = adapter.info();
    this.attach(tabId, info);
    if (tabId === this.core.activeTab) this.post({ event: "notebook", params: { tabId, info } });
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
        const target = (params as { url?: unknown })?.url;
        return typeof target === "string" ? openChatLink(target, this.documentUri()) : false;
      }
      case "image.resolve": {
        const target = (params as { target?: unknown })?.target;
        if (typeof target !== "string") return null;
        return readChatImage(target, this.documentUri());
      }
      default:
        return this.core.handle(method, params);
    }
  }

  /** The VS Code notebook the chat is about, for links relative to it (none for a Chrome tab). */
  private documentUri(): vscode.Uri | undefined {
    const tabId = this.core.activeTab;
    return tabId === null ? undefined : this.find(tabId)?.adapter.document.uri;
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; style-src-attr 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("katex.min.css")}">
<link rel="stylesheet" href="${asset("chat.css")}">
<link rel="stylesheet" href="${asset("theme.css")}">
<title>Agent in Notebook</title>
</head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${asset("webview.js")}"></script></body></html>`;
}
