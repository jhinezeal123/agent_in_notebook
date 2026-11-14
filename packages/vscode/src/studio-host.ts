// The research views: our own screens (packages/studio) on OpenResearch's own
// client logic. This hosts them in VS Code: the "Research" side bar view
// (the open notebooks), the right side bar's Project view (the current
// project, its chats and its experiment tree), editor tabs (New
// Chat, Settings, an experiment), and research chats in the chat panel. Their
// OpenResearch requests go through OrxTunnel; what only VS Code or the bridge
// can do (open a tab, pick a folder, the notebooks, the notebook agents) they
// ask for with host requests, answered here.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ResearchStatus } from "@ainb/protocol";
import { DEFAULT_KERNEL_SETUP, pickProject, type FromHost, type HostEvents, type KaggleNotebookLaunch, type KernelSetup, type NotebookEntry, type SelectedChat, type StudioView, type ToHost } from "../../studio/src/messages.js";
import type { ChangeSet, ChangedFile } from "./changes.js";
import { listKaggleAccounts, openKaggleNotebook } from "./kaggle-notebooks.js";
import { OrxTunnel } from "./orx-tunnel.js";

export interface StudioDeps {
  context: vscode.ExtensionContext;
  /**
   * A request to the bridge, connecting to it first if needed. `force`: also
   * when the user stopped it (they asked for OpenResearch again).
   */
  bridge(method: string, params?: unknown, force?: boolean): Promise<unknown>;
  notebooks(): NotebookEntry[];
  selectedChat(): SelectedChat | null;
  /** Show this chat in the chat panel (a notebook chat with this agent, when given). */
  selectChat(chat: SelectedChat & { agentId?: string }): Promise<void>;
  /** Run the kernel setup on a notebook's machine now. */
  runKernelSetup(tabId: number): Promise<{ output: string; exitCode: number | null; running: boolean }>;
  stopBridge(): Promise<void>;
}

const KERNEL_KEY = "kernelSetup";
const PROJECT_KEY = "researchProject";

/** What the extension needs of an OpenResearch project. */
export interface OrxProject {
  id: string;
  name: string;
  repoPath: string;
  artifactsDir: string;
  updatedAt: number;
}

/** A checkout of a project's code (OpenResearch's code-tree, without its file list). */
export interface OrxCheckout {
  /** "worktree": a research chat's own; "clone": the project's repository. */
  root: "worktree" | "clone";
  path: string;
  /** Checked-out branch; null when detached. */
  branch: string | null;
}

export class Studio implements vscode.WebviewViewProvider, vscode.Disposable {
  private status: ResearchStatus = { state: "off" };
  private readonly statusChanged = new vscode.EventEmitter<ResearchStatus>();
  readonly onDidChangeResearchStatus = this.statusChanged.event;
  private readonly projectChanged = new vscode.EventEmitter<string>();
  /** Another project was opened (the right side bar follows it). */
  readonly onDidChangeProject = this.projectChanged.event;
  private readonly chatChanged = new vscode.EventEmitter<SelectedChat | null>();
  /** The chat panel shows another chat (the Code tree follows a research chat's worktree). */
  readonly onDidChangeChat = this.chatChanged.event;
  private readonly webviews = new Set<{ webview: vscode.Webview; view: () => StudioView | null }>();
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly kaggleLaunches = new Map<string, Promise<KaggleNotebookLaunch>>();
  private readonly statusItem: vscode.StatusBarItem;
  /** Live runs: their project, and whether they still wait in their provider's queue. */
  private running = new Map<string, { projectId: string; queued: boolean }>();

  constructor(private readonly deps: StudioDeps) {
    this.statusItem = vscode.window.createStatusBarItem("ainb.research", vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = "OpenResearch";
    this.statusItem.command = "ainb.openSettings";
    this.renderStatus();
  }

  // ------------------------------------------------------------ OpenResearch state

  researchStatus(): ResearchStatus { return this.status; }

  setResearchStatus(status: ResearchStatus): void {
    this.status = status;
    this.broadcast("research.status", status);
    this.renderStatus();
    this.statusChanged.fire(status);
  }

  // ------------------------------------------------------------ the current project

  /** The project opened last, as stored (it may since have been deleted: see pickProject). */
  openedProject(): string | null {
    return this.deps.context.globalState.get<string>(PROJECT_KEY) ?? null;
  }

  /** A project was opened (its row expanded, a chat of it shown, picked in the right side bar). */
  async openProject(id: string): Promise<void> {
    if (!id || id === this.openedProject()) return;
    await this.deps.context.globalState.update(PROJECT_KEY, id);
    this.broadcast("project.current", id);
    this.projectChanged.fire(id);
  }

  /** The chat panel shows another chat: tell the views; a research chat opens its project. */
  chatSelected(chat: SelectedChat | null): void {
    this.broadcast("chat.selected", chat);
    this.chatChanged.fire(chat);
    if (chat?.kind === "research") void this.openProject(chat.projectId);
  }

  /** The research chat in the chat panel, when it is this project's. */
  researchChatOf(projectId: string): string | null {
    const chat = this.deps.selectedChat();
    return chat?.kind === "research" && chat.projectId === projectId ? chat.sessionId : null;
  }

  /**
   * Where a project's code is checked out: the chat's own worktree (where its
   * agent works) when it has one, else the project's repository.
   */
  async codeCheckout(projectId: string, sessionId: string | null): Promise<OrxCheckout> {
    if (this.status.state !== "ready" || !this.status.url) throw new Error("OpenResearch is not running.");
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`${this.status.url}/api/projects/${encodeURIComponent(projectId)}/code-tree${query}`);
    if (!res.ok) throw new Error(`OpenResearch answered HTTP ${res.status}.`);
    const tree = await res.json() as Partial<OrxCheckout>;
    if (typeof tree.path !== "string") throw new Error("OpenResearch did not say where the code is.");
    return { root: tree.root === "worktree" ? "worktree" : "clone", path: tree.path, branch: typeof tree.branch === "string" ? tree.branch : null };
  }

  /** What a research chat changed in its worktree (null: it has none yet). */
  async worktreeChanges(sessionId: string): Promise<Omit<ChangeSet, "root"> | null> {
    if (this.status.state !== "ready" || !this.status.url) throw new Error("OpenResearch is not running.");
    const res = await fetch(`${this.status.url}/api/chat/sessions/${encodeURIComponent(sessionId)}/worktree`);
    if (!res.ok) throw new Error(`OpenResearch answered HTTP ${res.status}.`);
    const w = await res.json() as { exists?: boolean; branch?: string | null; baselineBranch?: string; baseSha?: string; files?: ChangedFile[] };
    if (!w.exists || !w.baseSha) return null;
    return { branch: w.branch ?? null, baselineBranch: w.baselineBranch ?? "baseline", baseSha: w.baseSha, files: Array.isArray(w.files) ? w.files : [] };
  }

  /** OpenResearch's projects; none while it is not running (this does not start it). */
  async projects(): Promise<OrxProject[]> {
    if (this.status.state !== "ready" || !this.status.url) return [];
    const res = await fetch(`${this.status.url}/api/projects`);
    if (!res.ok) throw new Error(`OpenResearch answered HTTP ${res.status}.`);
    const body = await res.json() as { projects?: OrxProject[] };
    return body.projects ?? [];
  }

  /** The project the right side bar shows. */
  async currentProject(): Promise<OrxProject | null> {
    return pickProject(await this.projects(), this.openedProject());
  }

  /** Choose which project the right side bar shows. */
  async pickProjectToShow(): Promise<void> {
    await this.baseUrl();
    const list = (await this.projects()).sort((a, b) => b.updatedAt - a.updatedAt);
    const current = pickProject(list, this.openedProject());
    const items: (vscode.QuickPickItem & { id?: string })[] = [
      ...list.map((p) => ({ label: `${p.id === current?.id ? "$(check)" : "$(folder)"} ${p.name}`, detail: p.repoPath, id: p.id })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(add) New Project...", detail: "An empty folder, an existing folder, or a paper with its code" },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: "Show a project", placeHolder: "Its chats, experiments and artifacts show in the right side bar", matchOnDetail: true });
    if (!picked) return;
    if (picked.id) await this.openProject(picked.id);
    else this.open({ view: "newchat" });
  }

  /** A run changed: count the live ones, and say when one ends. */
  runChanged(run: { id: string; status: string; experimentId: string; projectId: string; queueDetail?: string | null }): void {
    const live = run.status === "starting" || run.status === "running";
    const was = this.running.has(run.id);
    // OpenResearch's runDisplay: a starting run with a queue detail is "Queued".
    if (live) this.running.set(run.id, { projectId: run.projectId, queued: run.status === "starting" && !!run.queueDetail });
    else this.running.delete(run.id);
    this.renderStatus();
    if (was && !live && (run.status === "done" || run.status === "failed")) {
      const open = "Open experiment";
      const say = run.status === "done" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      void say(`Experiment run ${run.status === "done" ? "finished" : "failed"}.`, open).then((pick) => {
        if (pick === open) this.open({ view: "experiment", projectId: run.projectId, experimentId: run.experimentId });
      });
    }
  }

  private renderStatus(): void {
    const s = this.status;
    if (s.state === "off") { this.statusItem.hide(); return; }
    const queued = [...this.running.values()].filter((r) => r.queued).length;
    const runs = this.running.size - queued;
    const counts = [runs && `${runs} running`, queued && `${queued} queued`].filter(Boolean).join(" · ");
    this.statusItem.text = s.state === "ready"
      ? `$(beaker) ${counts || "OpenResearch"}`
      : s.state === "starting" ? "$(loading~spin) OpenResearch" : "$(warning) OpenResearch";
    this.statusItem.tooltip = s.state === "ready" ? `OpenResearch ${s.version ?? ""} at ${s.url}${s.owned ? "" : " (already running)"}` : s.error ?? "OpenResearch is starting";
    this.statusItem.show();
  }

  /** OpenResearch's address, starting it through the bridge when needed. */
  private async baseUrl(): Promise<string> {
    if (this.status.state === "ready" && this.status.url) return this.status.url;
    const status = await this.deps.bridge("research.status", { start: true }) as ResearchStatus;
    this.setResearchStatus(status);
    if (status.state !== "ready" || !status.url) throw new Error(status.error ?? "OpenResearch is not running.");
    return status.url;
  }

  // ------------------------------------------------------------ webviews

  /** The Research side bar view. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.resolveView(view, { view: "sidebar" });
  }

  /** The right side bar's Project view (the current project's bar and experiment tree). */
  readonly projectView: vscode.WebviewViewProvider = { resolveWebviewView: (view) => this.resolveView(view, { view: "project" }) };

  private resolveView(view: vscode.WebviewView, screen: StudioView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.deps.context.extensionUri, "dist")] };
    this.host(view.webview, () => screen, view);
  }

  /**
   * Serve our screens and OpenResearch's requests in a webview. `chatPanel`:
   * the chat panel, which loads the research screens next to the notebook chat.
   */
  host(webview: vscode.Webview, view: () => StudioView | null, owner: { onDidDispose: vscode.Event<void>; dispose?: () => void }, chatPanel = false): vscode.Disposable {
    const assets = vscode.Uri.joinPath(this.deps.context.extensionUri, "dist");
    if (!chatPanel) webview.html = studioHtml(webview, assets, view());
    const send = (m: FromHost) => { void webview.postMessage(m); };
    const tunnel = new OrxTunnel(() => this.baseUrl(), send);
    const entry = { webview, view };
    this.webviews.add(entry);
    const listener = webview.onDidReceiveMessage((m: ToHost) => {
      if (!m || typeof m !== "object" || typeof (m as { type?: unknown }).type !== "string") return;
      if (tunnel.handle(m)) return;
      if (m.type === "host.request") {
        const done = m.method === "close" && !chatPanel && owner.dispose
          ? Promise.resolve(owner.dispose())
          : this.request(m.method, m.params);
        void done.then(
          (result) => send({ type: "host.response", id: m.id, ok: true, result: result ?? null }),
          (e: Error) => send({ type: "host.response", id: m.id, ok: false, error: e.message }),
        );
      }
    });
    const dispose = () => {
      listener.dispose();
      tunnel.dispose();
      this.webviews.delete(entry);
    };
    owner.onDidDispose(dispose);
    return { dispose };
  }

  broadcast<K extends keyof HostEvents>(event: K, params: HostEvents[K]): void {
    for (const { webview } of this.webviews) void webview.postMessage({ type: "host.event", event, params } satisfies FromHost);
  }

  /** Open a screen in an editor tab (one tab per screen; experiments share one). */
  open(view: StudioView): void {
    const key = view.view === "experiment" ? "experiment" : view.view;
    const existing = this.panels.get(key);
    const title = view.view === "newchat" ? "New Chat" : view.view === "settings" ? "Agent in Notebook Settings" : view.view === "experiment" ? "Experiment" : "Research";
    if (existing) {
      existing.title = title;
      // A connect request is for once; a reload of the tab should not repeat it.
      (existing as unknown as { studioView: StudioView }).studioView = view.view === "settings" ? { view: "settings", section: view.section } : view;
      void existing.webview.postMessage({ type: "host.event", event: "view", params: view } satisfies FromHost);
      existing.reveal();
      return;
    }
    const assets = vscode.Uri.joinPath(this.deps.context.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel(`ainb.${key}`, title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets],
    });
    panel.iconPath = vscode.Uri.joinPath(this.deps.context.extensionUri, "notebook.svg");
    const holder = panel as unknown as { studioView: StudioView };
    holder.studioView = view;
    this.panels.set(key, panel);
    panel.onDidDispose(() => { if (this.panels.get(key) === panel) this.panels.delete(key); });
    this.host(panel.webview, () => holder.studioView, panel);
  }

  // ------------------------------------------------------------ host requests

  private async request(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "research.status": return this.status.state === "ready" ? this.status : this.baseUrl().then(() => this.status, () => this.status);
      case "research.chooseOrx": return this.chooseOrx();
      case "research.restart": {
        const status = await this.deps.bridge("research.configure", {}, true) as ResearchStatus;
        this.setResearchStatus(status);
        return status;
      }
      case "open": this.open(p as unknown as StudioView); return;
      case "chat.select": return this.deps.selectChat(p as unknown as SelectedChat & { agentId?: string });
      case "close": return; // a side bar view or the chat panel stays
      case "chat.selected": return this.deps.selectedChat();
      case "project.current": return this.openedProject();
      case "project.open": return typeof p.projectId === "string" ? this.openProject(p.projectId) : undefined;
      case "project.pick": return this.pickProjectToShow();
      case "notebooks.list": return this.deps.notebooks();
      case "kaggle.accounts":
      case "kaggle.openNotebook": {
        if (vscode.env.remoteName) throw new Error("Open Agent in Notebook in a local VS Code window to use the Kaggle Chrome launcher.");
        const config = vscode.workspace.getConfiguration("ainb.kaggle");
        const accounts = await listKaggleAccounts(config.get<string>("accountsFile", "").trim());
        if (method === "kaggle.accounts") return accounts;
        const account = accounts.find(({ id }) => id === p.id);
        if (!account) throw new Error("This Kaggle account is no longer in the registry. Reopen Compute to refresh the list.");
        const current = this.kaggleLaunches.get(account.id);
        if (current) return current;
        const profiles = vscode.Uri.joinPath(this.deps.context.globalStorageUri, "kaggle-chrome");
        const launch = openKaggleNotebook(account, profiles.fsPath, config.get<string>("chromePath", "").trim(), () => this.baseUrl(), p.recover !== false)
          .finally(() => this.kaggleLaunches.delete(account.id));
        this.kaggleLaunches.set(account.id, launch);
        return launch;
      }
      case "folder.pick": {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: typeof p.title === "string" ? p.title : "Choose a folder" });
        return picked?.[0]?.fsPath ?? null;
      }
      case "folder.open": {
        if (typeof p.path !== "string") return;
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(p.path), { forceNewWindow: !!p.newWindow });
        return;
      }
      case "folder.reveal": {
        if (typeof p.path === "string") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(p.path));
        return;
      }
      case "link.open": {
        if (typeof p.url === "string" && /^https?:\/\//.test(p.url)) await vscode.env.openExternal(vscode.Uri.parse(p.url));
        return;
      }
      case "agents.list": case "agents.save": case "agents.remove": case "agents.test":
        return this.deps.bridge(method, p);
      case "kernel.get": return { ...DEFAULT_KERNEL_SETUP, ...this.deps.context.globalState.get<KernelSetup>(KERNEL_KEY) };
      case "kernel.set": {
        const next = { ...DEFAULT_KERNEL_SETUP, ...(p as Partial<KernelSetup>) };
        await this.deps.context.globalState.update(KERNEL_KEY, next);
        return next;
      }
      case "kernel.run": return this.deps.runKernelSetup(Number(p.tabId));
      case "terminal.run": return this.runInTerminal(p);
      case "logs.show": return showRunLogs(String(p.runId), String(p.title ?? "Run"), () => this.baseUrl());
      case "message": {
        const text = String(p.text ?? "");
        if (p.level === "error") void vscode.window.showErrorMessage(text);
        else void vscode.window.showInformationMessage(text);
        return;
      }
      case "bridge.stop": return this.deps.stopBridge();
      default:
        throw new Error(`Unknown request: ${method}`);
    }
  }

  /** Ask for the orx program and restart OpenResearch with it. */
  async chooseOrx(): Promise<ResearchStatus> {
    const picked = await vscode.window.showOpenDialog({ title: "Choose the orx program (OpenResearch)", canSelectMany: false, openLabel: "Use this orx", filters: process.platform === "win32" ? { Programs: ["exe"] } : undefined });
    if (!picked?.[0]) return this.status;
    const status = await this.deps.bridge("research.configure", { orxPath: picked[0].fsPath }, true) as ResearchStatus;
    this.setResearchStatus(status);
    return status;
  }

  /**
   * Open a VS Code terminal for a step that needs the user's input (a host's
   * password or passphrase, signing in to OpenResearch). The page names the
   * step; the command is built here, from the orx program the bridge uses and
   * a validated host alias, and passed as program and arguments (no shell).
   */
  private runInTerminal(p: Record<string, unknown>): void {
    const orx = this.status.orxPath;
    if (!orx) throw new Error("OpenResearch's orx program is not known yet. Wait until OpenResearch has started, then try again.");
    let args: string[];
    if (p.command === "compute.connect") {
      const host = typeof p.host === "string" ? p.host.trim() : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(host)) throw new Error("Not a valid SSH host name.");
      if (p.backend !== "ssh" && p.backend !== "slurm") throw new Error("Unknown backend.");
      args = ["compute", "connect", p.backend, "--host", host];
    } else if (p.command === "login") {
      args = ["login"];
    } else {
      throw new Error("Unknown terminal command.");
    }
    const title = typeof p.title === "string" && p.title.trim() ? p.title.trim().slice(0, 60) : "OpenResearch";
    const terminal = vscode.window.createTerminal({ name: title, shellPath: orx, shellArgs: args });
    terminal.show();
  }

  kernelSetup(): KernelSetup {
    return { ...DEFAULT_KERNEL_SETUP, ...this.deps.context.globalState.get<KernelSetup>(KERNEL_KEY) };
  }

  dispose(): void {
    this.statusItem.dispose();
    this.statusChanged.dispose();
    this.projectChanged.dispose();
    this.chatChanged.dispose();
    for (const panel of this.panels.values()) panel.dispose();
  }
}

/** A run's log in a terminal tab, followed while the run lives. */
async function showRunLogs(runId: string, title: string, baseUrl: () => Promise<string>): Promise<void> {
  const base = await baseUrl();
  const write = new vscode.EventEmitter<string>();
  let stopped = false;
  let cursor = "";
  const pump = async () => {
    while (!stopped) {
      try {
        const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!res.ok) { write.fire(`\r\n[could not read the log: HTTP ${res.status}]\r\n`); return; }
        const page = await res.json() as { dataBase64?: string; nextCursor?: string | null; eof?: boolean };
        if (page.dataBase64) write.fire(Buffer.from(page.dataBase64, "base64").toString("utf8").replace(/\r?\n/g, "\r\n"));
        if (page.nextCursor) cursor = page.nextCursor;
        if (page.eof && !page.dataBase64) {
          const run = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`).then((r) => r.json() as Promise<{ run?: { status?: string } }>).catch(() => null);
          if (run?.run?.status && !["starting", "running"].includes(run.run.status)) { write.fire(`\r\n[run ${run.run.status}]\r\n`); return; }
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e) {
        write.fire(`\r\n[${(e as Error).message}]\r\n`);
        return;
      }
    }
  };
  const terminal = vscode.window.createTerminal({
    name: `Log: ${title}`,
    iconPath: new vscode.ThemeIcon("beaker"),
    pty: { onDidWrite: write.event, open: () => void pump(), close: () => { stopped = true; } },
  });
  terminal.show();
}

export function studioHtml(webview: vscode.Webview, assets: vscode.Uri, view: StudioView | null): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, name));
  const initial = JSON.stringify(view).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} https: data: blob:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("studio.css")}">
<title>Agent in Notebook</title>
</head><body${view?.view === "sidebar" || view?.view === "project" ? ' class="sidebar-host"' : ""}><div id="studio" data-view='${initial.replace(/'/g, "&#39;")}'></div><script type="module" nonce="${nonce}" src="${asset("studio.js")}"></script></body></html>`;
}
