// Easy-read in VS Code (docs/easy-read.md, E.10): "Easy Read: Mở paper…", one
// editor tab per paper (packages/ui/src/reader), and what the tab asks of the
// bridge. While a paper's tab is in front, the chat in the side bar is its
// tutor's (PanelCore: reading tabs have ids of their own); a passage the reader
// selects goes to that chat, and a citation the tutor writes brings the tab to
// the place it cites.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { READER_ASK_LABEL, type ChatSettings, type ChatSnapshot, type MentorHome, type ReaderAnchor, type ReaderAskKind, type ReaderLibraryItem, type ReaderView } from "@ainb/protocol";
import type { Prefs } from "../../ui/src/panel-messages.js";
import { READER_TAB_BASE, type ReaderTabs } from "./panel-core.js";

export interface ReaderDeps {
  /** A bridge request; starts the bridge when it is not running. */
  request(method: string, params: unknown): Promise<unknown>;
  connected(): boolean;
  /** The chat panel's prefs: the agent the tutor runs on. */
  prefs(): Prefs;
  /** A reading tab came to the front: the chat follows it. */
  follow(tabId: number): void;
  /** A reading tab opened or closed. */
  changed(): void;
  reproduce(paperId: string): Promise<unknown>;
  lab(paperId: string, widget: string): Promise<unknown>;
}

/** The tutor's mode (the bridge fixes it too: ReaderChat's settings). */
const TUTOR_SETTINGS: ChatSettings = { scope: "auto", review: false, targetCellIds: [], notebookOnly: true };

interface ReaderTab {
  paperId: string;
  tabId: number;
  panel: vscode.WebviewPanel;
  view: ReaderView;
}

type Source = { arxiv: string } | { pdfPath: string } | { paperId: string };

export class ReaderHost implements vscode.Disposable, ReaderTabs {
  private readonly tabs = new Map<string, ReaderTab>();
  /** Each paper's tab id for this session, so its chat stays the same when its tab is opened again. */
  private readonly ids = new Map<string, number>();
  private nextId = READER_TAB_BASE + 1;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: ReaderDeps) {}

  // ------------------------------------------------------------------ ReaderTabs (PanelCore)

  has(tabId: number): boolean {
    return !!this.byTab(tabId);
  }

  info(tabId: number): { paperId: string; title: string } | null {
    const tab = this.byTab(tabId);
    return tab ? { paperId: tab.paperId, title: tab.view.title } : null;
  }

  async reveal(tabId: number, anchor?: ReaderAnchor, action?: "quiz"): Promise<void> {
    const tab = this.byTab(tabId);
    if (!tab) return;
    tab.panel.reveal(tab.panel.viewColumn, action !== "quiz");
    if (anchor) await tab.panel.webview.postMessage({ event: "reveal", params: anchor });
    if (action === "quiz") await tab.panel.webview.postMessage({ event: "quiz" });
  }

  private byTab(tabId: number): ReaderTab | undefined {
    for (const tab of this.tabs.values()) if (tab.tabId === tabId) return tab;
    return undefined;
  }

  // ------------------------------------------------------------------ opening

  /** "Easy Read: Mở paper…": an arXiv link, a PDF on this computer, or a paper read before or on Mentor's shelf. */
  async open(): Promise<void> {
    type Pick = vscode.QuickPickItem & { source?: Source; how?: "arxiv" | "pdf" };
    const items: Pick[] = [
      { label: "$(link) Link hoặc id arXiv", detail: "Ví dụ 2106.09685 hoặc https://arxiv.org/abs/2106.09685. Bản HTML của arXiv: công thức đúng như tác giả viết.", how: "arxiv" },
      { label: "$(file-pdf) File PDF trên máy", detail: "Hiện đúng bản PDF; gia sư đọc chữ rút từ PDF và xem ảnh trang khi cần.", how: "pdf" },
    ];
    try {
      const { papers } = await this.deps.request("reader.list", {}) as { papers: ReaderLibraryItem[] };
      const seen = new Set(papers.map((p) => p.paperId));
      if (papers.length) items.push({ label: "Đã đọc", kind: vscode.QuickPickItemKind.Separator });
      for (const p of papers) {
        items.push({ label: `$(book) ${p.title}`, description: [p.authors, p.year].filter(Boolean).join(", "), detail: `${p.read}/${p.total} mục đã đọc · ${p.view === "html" ? "HTML arXiv" : "PDF"}`, source: { paperId: p.paperId } });
      }
      const home = await this.deps.request("mentor.home", {}).catch(() => null) as MentorHome | null;
      const shelf = (home?.papers ?? []).filter((p) => !seen.has(p.id) && p.url && /arxiv\.org/.test(p.url));
      if (shelf.length) items.push({ label: "Trên tủ paper của Mentor", kind: vscode.QuickPickItemKind.Separator });
      for (const p of shelf) items.push({ label: `$(library) ${p.title}`, description: [p.authors, p.year].filter(Boolean).join(", "), source: { paperId: p.id } });
    } catch {
      // The bridge is not reachable yet: the two ways in still work (opening starts it).
    }
    const picked = await vscode.window.showQuickPick(items, { title: "Easy Read: mở paper", placeHolder: "Paper lấy từ đâu?", matchOnDescription: true });
    if (!picked) return;
    let source = picked.source;
    if (picked.how === "arxiv") {
      const text = await vscode.window.showInputBox({
        title: "Easy Read: paper trên arXiv",
        prompt: "Dán link hoặc id arXiv",
        placeHolder: "2106.09685",
        ignoreFocusOut: true,
        validateInput: (v) => (/(\d{4}\.\d{4,5})|([a-z-]+(\.[A-Z]{2})?\/\d{7})/i.test(v.trim()) ? undefined : "Chưa thấy id arXiv (dạng 2106.09685)."),
      });
      if (!text) return;
      source = { arxiv: text.trim() };
    } else if (picked.how === "pdf") {
      const files = await vscode.window.showOpenDialog({ title: "Easy Read: chọn file PDF", canSelectMany: false, filters: { PDF: ["pdf"] } });
      if (!files?.[0]) return;
      source = { pdfPath: files[0].fsPath };
    }
    if (source) await this.openPaper(source);
  }

  /** Open a paper in its tab (fetched the first time), with its tutor in the chat. */
  async openPaper(source: Source): Promise<void> {
    if ("paperId" in source) {
      const open = this.tabs.get(source.paperId);
      if (open) {
        open.panel.reveal(open.panel.viewColumn);
        return;
      }
    }
    try {
      const view = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Easy Read: đang mở paper…", cancellable: false },
        () => this.deps.request("reader.open", { source }),
      ) as ReaderView;
      this.show(view);
      await vscode.commands.executeCommand("ainb.chat.focus").then(undefined, () => {});
      // The reading tab takes the focus back: the chat beside it is ready to ask.
      this.tabs.get(view.paperId)?.panel.reveal(undefined, false);
    } catch (e) {
      void vscode.window.showErrorMessage(`Easy Read: ${(e as Error).message}`);
    }
  }

  private show(view: ReaderView): void {
    const open = this.tabs.get(view.paperId);
    if (open) {
      open.view = view;
      open.panel.reveal(open.panel.viewColumn);
      return;
    }
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const dir = vscode.Uri.file(view.dir);
    const panel = vscode.window.createWebviewPanel("ainb.reader", tabTitle(view.title), vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist, dir],
    });
    let tabId = this.ids.get(view.paperId);
    if (tabId === undefined) {
      tabId = this.nextId++;
      this.ids.set(view.paperId, tabId);
    }
    const tab: ReaderTab = { paperId: view.paperId, tabId, panel, view };
    this.tabs.set(view.paperId, tab);
    panel.webview.html = readerHtml(panel.webview, dist);
    const listener = panel.webview.onDidReceiveMessage((message: { id?: unknown; method?: unknown; params?: unknown }) => {
      if (!message || typeof message.id !== "number" || typeof message.method !== "string") return;
      const id = message.id;
      void this.handle(tab, message.method, message.params ?? {}).then(
        (result) => panel.webview.postMessage({ id, ok: true, result: result ?? null }),
        (error: Error) => panel.webview.postMessage({ id, ok: false, error: error.message }),
      );
    });
    const state = panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) this.deps.follow(tab.tabId);
    });
    panel.onDidDispose(() => {
      listener.dispose();
      state.dispose();
      if (this.tabs.get(tab.paperId) === tab) this.tabs.delete(tab.paperId);
      this.deps.changed();
    });
    this.deps.changed();
    this.deps.follow(tab.tabId);
  }

  // ------------------------------------------------------------------ the tab's requests

  private async handle(tab: ReaderTab, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const { paperId } = tab;
    switch (method) {
      case "init": {
        const webview = tab.panel.webview;
        const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
        tab.view = await this.deps.request("reader.get", { paperId }) as ReaderView;
        tab.panel.title = tabTitle(tab.view.title);
        return {
          view: tab.view,
          base: `${webview.asWebviewUri(vscode.Uri.file(tab.view.dir)).toString()}/`,
          pdfjs: webview.asWebviewUri(vscode.Uri.joinPath(dist, "pdf.min.mjs")).toString(),
          pdfWorker: webview.asWebviewUri(vscode.Uri.joinPath(dist, "pdf.worker.min.mjs")).toString(),
        };
      }
      case "reader.progress":
      case "reader.mark":
      case "reader.note":
      case "reader.session":
      case "reader.pdfText":
      case "reader.rendered":
      case "reader.get": {
        // The reader's agent goes with what may start the hidden author (time in a section, in pass 2).
        const result = await this.deps.request(method, { ...p, paperId, ...(method === "reader.progress" ? { agentId: this.deps.prefs().agentId } : {}) });
        if (method !== "reader.progress" && method !== "reader.rendered" && result && typeof result === "object") {
          tab.view = result as ReaderView;
          tab.panel.title = tabTitle(tab.view.title);
        }
        return result;
      }
      // The passes (ER-2): the guide and what the reader does in it.
      case "reader.answer":
      case "reader.skip":
      case "reader.report":
      case "reader.widget.answer":
      case "reader.related":
      case "reader.cards.keep":
      case "reader.cards.drop":
      case "reader.cards.review":
        return this.deps.request(method, { ...p, paperId });
      case "reader.guide":
      case "reader.goal":
      case "reader.pass":
      case "reader.author":
      case "reader.widget.request":
      case "reader.peer":
        // These start the hidden author: it uses the reader's agent when no tutor chat is open.
        return this.deps.request(method, { ...p, paperId, agentId: this.deps.prefs().agentId });
      case "write":
        return this.write(tab, p);
      case "appeal": {
        const chat = await this.tutorChat(tab);
        return this.deps.request("reader.appeal", { ...p, paperId, chatId: chat.chatId });
      }
      case "reproduce":
        return this.deps.reproduce(paperId);
      case "lab":
        return this.deps.lab(paperId, String(p.widget));
      case "ask":
        return this.ask(tab, p.kind as ReaderAskKind, (p.anchor ?? {}) as ReaderAnchor, String(p.quote ?? ""));
      case "askText":
        return this.askText(tab, String(p.text ?? ""), p.anchor as ReaderAnchor | undefined);
      case "openArxiv": {
        // A PDF that is on arXiv: its HTML version, in a tab of its own.
        const arxiv = String(p.arxiv ?? "");
        if (!/^\d{4}\.\d{4,5}(v\d+)?$/.test(arxiv)) throw new Error("Không rõ id arXiv.");
        await this.openPaper({ arxiv });
        return null;
      }
      case "chat.focus":
        return vscode.commands.executeCommand("ainb.chat.focus");
      case "reader.settings":
        // The mode of background agents, changed from the author bar too (it is global: reader.json).
        return this.deps.request("reader.settings", p);
      case "link.open": {
        // Outside links of the paper (its code, a dataset): the browser, never a command.
        const url = String(p.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("Chỉ mở được link http(s).");
        return vscode.env.openExternal(vscode.Uri.parse(url));
      }
      default:
        throw new Error(`Unknown reader request: ${method}`);
    }
  }

  /** A selected passage to the paper's tutor: its chat (opened if need be), then the chat comes to the front. */
  private async ask(tab: ReaderTab, kind: ReaderAskKind, anchor: ReaderAnchor, quote: string): Promise<{ accepted: true }> {
    if (!READER_ASK_LABEL[kind]) throw new Error(`Không rõ yêu cầu ${kind}.`);
    const chat = await this.tutorChat(tab);
    await this.deps.request("reader.ask", { chatId: chat.chatId, kind, anchor, quote });
    this.deps.follow(tab.tabId);
    await vscode.commands.executeCommand("ainb.chat.focus").then(undefined, () => {});
    return { accepted: true };
  }

  /**
   * Something the reader wrote in a pass. The kinds the tutor grades go to the
   * paper's chat (opened if need be), which the panel then shows; the others
   * are only kept.
   */
  private async write(tab: ReaderTab, p: Record<string, unknown>): Promise<unknown> {
    const graded = ["5c", "recall", "explain", "qalmri", "summary", "deep", "derive", "find-flaws", "review", "outline", "feynman"].includes(String(p.kind));
    const chat = graded ? await this.tutorChat(tab) : undefined;
    const result = await this.deps.request("reader.write", { ...p, paperId: tab.paperId, ...(chat ? { chatId: chat.chatId } : {}) });
    if (chat) this.deps.follow(tab.tabId);
    return result;
  }

  /** One of the reader's own questions, to the tutor, with the passage it is about. */
  private async askText(tab: ReaderTab, text: string, anchor?: ReaderAnchor): Promise<{ accepted: true }> {
    const question = text.trim();
    if (!question) throw new Error("Câu hỏi trống.");
    const where = anchor?.id ? ` [[${anchor.id}]]` : "";
    const quote = anchor?.quote ? `\n\n> ${anchor.quote.replace(/\s+/g, " ").slice(0, 600)}` : "";
    const chat = await this.tutorChat(tab);
    await this.deps.request("chat.send", { chatId: chat.chatId, text: `Câu hỏi của tôi${where}: ${question}${quote}` });
    this.deps.follow(tab.tabId);
    await vscode.commands.executeCommand("ainb.chat.focus").then(undefined, () => {});
    return { accepted: true };
  }

  private async tutorChat(tab: ReaderTab): Promise<ChatSnapshot> {
    const agentId = this.deps.prefs().agentId;
    const open = await this.deps.request("chat.get", { tabId: tab.tabId }) as ChatSnapshot | null;
    if (open && open.status !== "closed" && open.reader?.paperId === tab.paperId && open.agentId === agentId) return open;
    return await this.deps.request("chat.open", { tabId: tab.tabId, agentId, settings: TUTOR_SETTINGS, reader: { paperId: tab.paperId } }) as ChatSnapshot;
  }

  // ------------------------------------------------------------------ from the bridge

  /** `reader.updated` / `reader.render` from the bridge. */
  onBridge(method: string, params: unknown): void {
    const p = params as { paperId?: string; view?: ReaderView; page?: number; asset?: string };
    if (typeof p?.paperId !== "string") return;
    const tab = this.tabs.get(p.paperId);
    if (method === "reader.updated") {
      if (!tab || !p.view) return;
      tab.view = p.view;
      tab.panel.title = tabTitle(p.view.title);
      void tab.panel.webview.postMessage({ event: "updated", params: p.view });
    } else if (method === "reader.render") {
      const what = typeof p.page === "number" ? { page: p.page } : typeof p.asset === "string" ? { asset: p.asset } : null;
      if (!what) return;
      // Only an open tab can draw: say so at once rather than letting the tutor wait.
      if (!tab) void this.deps.request("reader.rendered", { paperId: p.paperId, ...what, error: "Tab đọc của paper đang đóng: mở lại paper rồi hỏi lại." }).catch(() => {});
      else void tab.panel.webview.postMessage({ event: "render", params: what });
    }
  }

  /** The bridge (re)connected: the tabs load their paper again. */
  connected(): void {
    for (const tab of this.tabs.values()) void tab.panel.webview.postMessage({ event: "connected" });
  }

  dispose(): void {
    for (const tab of [...this.tabs.values()]) tab.panel.dispose();
    this.tabs.clear();
  }
}

function tabTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return `Đọc: ${t.length > 40 ? `${t.slice(0, 39)}…` : t}`;
}

function readerHtml(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name));
  const csp = webview.cspSource;
  // ER-0 (docs/easy-read-er0.md): pdf.js is imported from dist (script-src csp), its worker
  // comes from a blob (worker-src blob:), the paper's files are fetched (connect-src csp).
  // Nothing from the network: the paper's images were downloaded by the bridge.
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob:; style-src ${csp} 'unsafe-inline'; font-src ${csp}; script-src 'nonce-${nonce}' ${csp}; connect-src ${csp}; worker-src blob:;">
<link rel="stylesheet" href="${asset("katex.min.css")}">
<link rel="stylesheet" href="${asset("reader.css")}">
<title>Easy Read</title>
</head><body><div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset("reader.js")}"></script></body></html>`;
}
