// Mentor in VS Code: its home page (an editor tab), the status bar item with
// the streak and rating, and what the page asks of the editor (open the
// exercise's notebook, pick the work folder, run an install command).

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { MentorEnv, MentorHome } from "@ainb/protocol";

export interface MentorDeps {
  /** A bridge request; starts the bridge when it is not running. */
  request(method: string, params: unknown): Promise<unknown>;
  connected(): boolean;
  /** Open the exercise's notebook with its chat beside it. */
  openNotebook(file: string): Promise<void>;
}

export class MentorHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: MentorDeps) {
    this.status = vscode.window.createStatusBarItem("ainb.mentor", vscode.StatusBarAlignment.Left, 40);
    this.status.name = "Mentor";
    this.status.command = "ainb.mentor.open";
    this.status.text = "$(star-empty) Mentor";
    this.status.tooltip = "Mở Mentor: bài hôm nay, bản đồ kỹ năng, rating";
    this.status.show();
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const assets = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel("ainb.mentor", "Mentor", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [assets],
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "mentor.svg");
    panel.webview.html = mentorHtml(panel.webview, assets);
    const listener = panel.webview.onDidReceiveMessage((message: { id?: unknown; method?: unknown; params?: unknown }) => {
      if (!message || typeof message.id !== "number" || typeof message.method !== "string") return;
      const id = message.id;
      void this.handle(message.method, message.params).then(
        (result) => panel.webview.postMessage({ id, ok: true, result: result ?? null }),
        (error: Error) => panel.webview.postMessage({ id, ok: false, error: error.message }),
      );
    });
    panel.onDidDispose(() => {
      listener.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "mentor.home":
        return this.deps.request("mentor.home", {});
      case "mentor.env": {
        const env = await this.deps.request("mentor.env", params ?? {}) as MentorEnv;
        return { ...env, jupyter: !!vscode.extensions.getExtension("ms-toolsai.jupyter") };
      }
      case "mentor.start": {
        const started = await this.deps.request("mentor.start", params ?? {}) as { file: string };
        await this.deps.openNotebook(started.file);
        return started;
      }
      case "mentor.pickWorkDir": {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Chọn thư mục bài làm" });
        if (!picked?.[0]) return null;
        return this.deps.request("mentor.settings", { workDir: picked[0].fsPath });
      }
      case "mentor.revealWorkDir": {
        const home = await this.deps.request("mentor.home", {}) as MentorHome;
        const dir = vscode.Uri.file(home.workDir);
        await vscode.workspace.fs.createDirectory(dir);
        return vscode.commands.executeCommand("revealFileInOS", dir);
      }
      case "mentor.install": {
        const command = String((params as { command?: unknown } | null)?.command ?? "").trim();
        if (!command) return null;
        const terminal = vscode.window.createTerminal({ name: "Mentor: cài thư viện" });
        terminal.show();
        for (const line of command.split("\n")) terminal.sendText(line);
        return null;
      }
      case "mentor.installJupyter":
        return vscode.commands.executeCommand("workbench.extensions.installExtension", "ms-toolsai.jupyter");
      default:
        throw new Error(`Unknown Mentor request: ${method}`);
    }
  }

  /** Progress changed (a verdict, a rating, a new attempt). */
  updated(): void {
    void this.panel?.webview.postMessage({ event: "updated" });
    void this.refreshStatus();
  }

  /** The bridge connected: the page and the status bar load again. */
  connected(): void {
    void this.panel?.webview.postMessage({ event: "connected" });
    void this.refreshStatus();
  }

  private async refreshStatus(): Promise<void> {
    if (!this.deps.connected()) return;
    try {
      const home = await this.deps.request("mentor.home", {}) as MentorHome;
      const streak = home.streak.current;
      this.status.text = `$(flame) ${streak} · $(star-full) ${home.overall ?? "—"}`;
      const tip = new vscode.MarkdownString(undefined, true);
      tip.appendMarkdown("**Mentor**\n\n");
      tip.appendMarkdown(`Chuỗi ngày học: ${streak}${home.streak.doneToday ? " (hôm nay đã học)" : " — hôm nay chưa học"}\n\n`);
      if (home.today) tip.appendMarkdown(`Bài hôm nay: ${home.today.title} (~${home.today.minutes} phút)\n\n`);
      tip.appendMarkdown("Bấm để mở trang Mentor.");
      this.status.tooltip = tip;
      this.status.backgroundColor = home.streak.doneToday || streak === 0 ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
    } catch {
      // Mentor not available (an older bridge): keep the plain entry.
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.status.dispose();
  }
}

function mentorHtml(webview: vscode.Webview, assets: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, name));
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("mentor.css")}">
<title>Mentor</title>
</head><body><div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset("mentor.js")}"></script></body></html>`;
}
