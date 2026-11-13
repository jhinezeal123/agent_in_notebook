import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { OpRunner, type NotebookInfo, type NotebookOp } from "@ainb/protocol";
import { DEFAULT_PREFS, type PanelEvent, type PanelRequest, type PanelResponse, type Prefs } from "../../ui/src/panel-messages.js";
import type { SelectedChat, StudioView } from "../../studio/src/messages.js";
import { BridgeLink } from "./bridge.js";
import { ChromeMirrors, MIRROR_TYPE, mirrorTab } from "./mirror.js";
import { openChatLink, readChatImage } from "./chat-links.js";
import { VSCodeNotebook } from "./notebook.js";
import { PanelCore, chromeTab, isChrome, type LocalNotebooks } from "./panel-core.js";
import { Studio } from "./studio-host.js";
import { ARTIFACTS, CODE, FolderTree } from "./folder-tree.js";
import { registerChangeProviders } from "./changes.js";

const secret = "bridge.config";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new NotebookPanel(context);
  const { studio } = panel;
  const retain = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    panel,
    studio,
    vscode.window.registerWebviewViewProvider("ainb.chat", panel, retain),
    vscode.window.registerWebviewViewProvider("ainb.research", studio, retain),
    vscode.window.registerWebviewViewProvider("ainb.project", studio.projectView, retain),
    registerChangeProviders(),
    new FolderTree(studio, CODE),
    new FolderTree(studio, ARTIFACTS),
    vscode.commands.registerCommand("ainb.pickProject", () => studio.pickProjectToShow()),
    vscode.commands.registerCommand("ainb.open", () => vscode.commands.executeCommand("ainb.chat.focus")),
    vscode.commands.registerCommand("ainb.newChat", () => studio.open({ view: "newchat" })),
    vscode.commands.registerCommand("ainb.openSettings", () => studio.open({ view: "settings" })),
    vscode.commands.registerCommand("ainb.openCompute", () => studio.open({ view: "settings", section: "compute" })),
    vscode.commands.registerCommand("ainb.chooseOrx", () => studio.chooseOrx()),
    vscode.commands.registerCommand("ainb.clearChat", () => panel.clearChat()),
    vscode.commands.registerCommand("ainb.stopBridge", () => panel.stopBridge()),
  );
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
  /** Notebooks of Chrome tabs opened in VS Code. */
  private readonly mirrors: ChromeMirrors;
  /** The research screens (OpenResearch's), and the research chats in this panel. */
  readonly studio: Studio;
  /** The chat this panel shows: about a notebook, or a research chat. */
  private selected: SelectedChat | null = null;
  /** Notebooks (Chrome tab and notebook) the kernel setup already ran on. */
  private readonly setupRan = new Set<string>();
  private setupLog?: vscode.OutputChannel;

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
      if (!connected) this.studio.setResearchStatus({ state: "off" });
    }, ({ tabId, op }) => this.runOp(tabId, op), (event) => {
      this.core.onBrowser(event);
      if ("notebook" in event) {
        this.mirrors.browserChanged(event.notebook.tabId, event.notebook.info);
        this.autoSetup(event.notebook.tabId, event.notebook.info);
      }
    }, (event) => {
      if ("status" in event) this.studio.setResearchStatus(event.status);
      else this.studio.runChanged(event.run);
    });
    this.mirrors = new ChromeMirrors((method, params) => this.bridge.request(method, params));
    this.studio = new Studio({
      context,
      bridge: async (method, params, force) => {
        await this.ensureBridge(!!force);
        return this.bridge.request(method, params);
      },
      notebooks: () => this.core.choices(),
      selectedChat: () => this.selected,
      selectChat: (chat) => this.selectChat(chat),
      runKernelSetup: (tabId) => this.runSetup(tabId),
      stopBridge: () => this.bridge.stop(),
    });
    this.core = new PanelCore(this.bridge, this.localNotebooks(), (event) => this.post(event), (tab, info) => this.mirrors.open(tab, info));
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
        if (!document) return null;
        if (document.notebookType === MIRROR_TYPE) {
          const tab = mirrorTab(document.uri);
          return tab === null ? null : -tab;
        }
        return this.notebooks.get(document)?.tabId ?? null;
      },
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const assets = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
    this.view = view;
    const listener = view.webview.onDidReceiveMessage((request: PanelRequest) => {
      // Typed messages are the research chat's, answered by the Studio.
      if (!request || typeof (request as { type?: unknown }).type === "string" || !Number.isSafeInteger(request.id) || typeof request.method !== "string") return;
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
    this.studio.host(view.webview, () => null, view, true);
    this.activeChanged();
    if (this.bridge.snapshot().conn === "disconnected") void this.connect().catch((error: Error) => vscode.window.showErrorMessage(`Agent in Notebook: ${error.message}`));
  }

  /** Clear Chat (the chat view's title bar): the chat panel clears the chat it shows. */
  clearChat(): void {
    this.post({ event: "command", params: "chat.clear" });
  }

  /** Stop the Bridge (the title bar's overflow menu). */
  async stopBridge(): Promise<void> {
    try {
      await this.bridge.stop();
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent in Notebook: ${(e as Error).message}`);
    }
  }

  /** Connect to the bridge (starting it) unless connected, or stopped by the user and not `force`. */
  private async ensureBridge(force: boolean): Promise<void> {
    const state = () => this.bridge.snapshot();
    if (state().conn === "connected") return;
    const stopped = state().error?.startsWith("The bridge was stopped");
    if (state().conn !== "connecting" && state().conn !== "replaced" && (force || !stopped)) await this.connect();
    for (let i = 0; i < 75 && state().conn === "connecting"; i++) await new Promise((r) => setTimeout(r, 200));
    if (state().conn !== "connected") throw new Error(state().error ?? "Not connected to the bridge.");
  }

  private async connect(): Promise<void> {
    const saved = await this.context.secrets.get(secret);
    await this.bridge.connect(saved ? JSON.parse(saved) : undefined);
  }

  private activeChanged(): void {
    const document = vscode.window.activeNotebookEditor?.notebook;
    if (document?.notebookType === MIRROR_TYPE) {
      // A Chrome tab's notebook shown here: the chat is about that tab.
      const tab = mirrorTab(document.uri);
      if (tab !== null && this.core.exists(-tab)) this.core.follow(-tab);
      return;
    }
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

  private post(event: PanelEvent): void {
    void this.view?.webview.postMessage(event);
    if (event.event === "notebooks") this.studio.broadcast("notebooks", event.params);
    // The chat follows the notebook in front, unless a research chat is shown.
    else if (event.event === "activeTab" && this.selected?.kind !== "research") {
      this.setSelected(event.params === null ? null : { kind: "notebook", tabId: event.params });
    }
  }

  private setSelected(chat: SelectedChat | null): void {
    this.selected = chat;
    // Showing a research chat opens its project (the right side bar follows).
    this.studio.chatSelected(chat);
  }

  /** Show a chat in this panel: about a notebook (with this agent, when given), or a research chat. */
  private async selectChat(chat: SelectedChat & { agentId?: string }): Promise<void> {
    if (chat.kind === "notebook") {
      this.setSelected({ kind: "notebook", tabId: chat.tabId });
      await this.core.handle("notebooks.select", { tabId: chat.tabId });
      if (chat.agentId) {
        const prefs: Prefs = { ...DEFAULT_PREFS, ...this.context.globalState.get<Prefs>("prefs"), agentId: chat.agentId };
        await this.context.globalState.update("prefs", prefs);
        this.post({ event: "prefs", params: prefs });
      }
    } else {
      this.setSelected({ kind: "research", projectId: chat.projectId, sessionId: chat.sessionId });
    }
    await vscode.commands.executeCommand("ainb.chat.focus");
  }

  /** Run the kernel setup script on a notebook's machine (a Chrome tab's has a negative id). */
  private runSetup(tabId: number): Promise<{ output: string; exitCode: number | null; running: boolean }> {
    const { script } = this.studio.kernelSetup();
    const target = isChrome(tabId) ? { tabId, browserTab: chromeTab(tabId) } : { tabId };
    return this.bridge.request("notebook.setup", { ...target, script }) as Promise<{ output: string; exitCode: number | null; running: boolean }>;
  }

  /** A Colab or Kaggle notebook got a running kernel: set its machine up, once, when the user asked for that. */
  private autoSetup(chromeTabId: number, info: NotebookInfo | null): void {
    if (!info?.key || (info.platform !== "colab" && info.platform !== "kaggle")) return;
    if (info.kernel !== "idle" && info.kernel !== "busy") return;
    const setup = this.studio.kernelSetup();
    if (!setup.runOnAttach || !setup.script.trim() || !setup[info.platform]) return;
    const key = `${chromeTabId}:${info.key}`;
    if (this.setupRan.has(key)) return;
    this.setupRan.add(key);
    const title = info.title || "the notebook";
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Setting up the machine of ${title}…` },
      () => this.runSetup(-chromeTabId),
    ).then((r) => {
      const log = (this.setupLog ??= vscode.window.createOutputChannel("Agent in Notebook: Kernel setup"));
      log.appendLine(`--- ${title} (${new Date().toLocaleString()})`);
      log.appendLine(r.output);
      const show = "Show output";
      const say = r.running
        ? vscode.window.showInformationMessage(`The kernel setup of ${title} is still running on its machine (terminal session "setup").`, show)
        : r.exitCode === 0
          ? vscode.window.showInformationMessage(`Kernel setup finished on ${title}.`, show)
          : vscode.window.showWarningMessage(`Kernel setup on ${title} ended with exit code ${r.exitCode}.`, show);
      void say.then((pick) => { if (pick === show) log.show(); });
    }, (e: Error) => {
      this.setupRan.delete(key);
      void vscode.window.showWarningMessage(`Kernel setup did not run on ${title}: ${e.message}`);
    });
  }

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
      case "chat.selected": return this.selected;
      case "studio.open": return this.studio.open(params as StudioView);
      case "prefs.set": return this.context.globalState.update("prefs", params);
      case "config.auto": return this.connect();
      case "bridge.stop": return this.bridge.stop();
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
    this.setupLog?.dispose();
    this.mirrors.dispose();
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
</head><body><div id="root"></div><div id="research" style="display:none;height:100%" data-css="${asset("studio.css")}"></div>
<script type="module" nonce="${nonce}" src="${asset("webview.js")}"></script>
<script type="module" nonce="${nonce}" src="${asset("studio.js")}"></script></body></html>`;
}
