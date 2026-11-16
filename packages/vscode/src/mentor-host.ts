// Mentor in VS Code: its home page (an editor tab), the status bar item with
// the streak and rating, and what the page asks of the editor. An exercise
// runs in a notebook the learner opened in Chrome (Kaggle): starting one asks
// which, the bridge writes the exercise into it, and its copy opens here.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { MentorHome, MentorKind, MentorPlace } from "@ainb/protocol";

const NEW_KAGGLE_NOTEBOOK = "https://www.kaggle.com/code/new";

export interface MentorDeps {
  /** A bridge request; starts the bridge when it is not running. */
  request(method: string, params: unknown): Promise<unknown>;
  connected(): boolean;
  /** Open VS Code's copy of the notebook in a Chrome tab, with its chat beside it. */
  openMirror(chromeTabId: number): Promise<void>;
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
      case "mentor.start": {
        const p = (params ?? {}) as { exerciseId?: string; kind?: MentorKind };
        return this.start(p.exerciseId, p.kind === "review" ? "review" : "learn");
      }
      case "mentor.openKaggle":
        return vscode.env.openExternal(vscode.Uri.parse(NEW_KAGGLE_NOTEBOOK));
      case "mentor.addPaper":
        return this.addPaper();
      case "mentor.openWorkshop":
        return this.openWorkshop(String((params as { paperId?: unknown })?.paperId ?? ""));
      case "mentor.focus":
        return this.deps.request("mentor.focus", params ?? { focus: null });
      case "mentor.paperNotes":
        return this.deps.request("mentor.paper.notes", params);
      case "mentor.paperArchive":
        return this.deps.request("mentor.paper.archive", params);
      default:
        throw new Error(`Unknown Mentor request: ${method}`);
    }
  }

  /**
   * Start an exercise: in the notebook that already holds it, else in one the
   * learner picks among those open in Chrome. Null when they cancel.
   */
  private async start(exerciseId: string | undefined, kind: MentorKind): Promise<unknown> {
    if (!exerciseId) {
      const home = await this.deps.request("mentor.home", {}) as MentorHome;
      exerciseId = (kind === "review" ? home.warmup : home.today)?.exerciseId;
      if (!exerciseId) throw new Error(kind === "review" ? "Hôm nay không có bài nào đến hạn ôn." : "Bạn đã làm hết các bài hiện có.");
    }
    const places = await this.deps.request("mentor.places", {}) as MentorPlace[];
    const here = places.find((p) => p.holds && p.holds.exerciseId === exerciseId && p.holds.kind === kind && !p.holds.done);
    let place = here;
    if (!place) {
      if (!places.length) {
        const open = await vscode.window.showWarningMessage(
          "Chưa có notebook nào trong Chrome nối với bridge. Mở một notebook Kaggle trong Chrome (có extension Agent in Notebook), rồi bấm Bắt đầu lại.",
          "Mở Kaggle",
        );
        if (open) await vscode.env.openExternal(vscode.Uri.parse(NEW_KAGGLE_NOTEBOOK));
        return null;
      }
      place = await this.pickPlace(places);
      if (!place) return null;
      if (place.foreignCells > 0) {
        const yes = await vscode.window.showWarningMessage(
          `Notebook "${place.title}" đang có ${place.foreignCells} cell của bạn. Chép đề vào sẽ thay toàn bộ nội dung.`,
          { modal: true, detail: "Bản cũ được lưu về máy (thư mục ~/.agent-in-notebook/mentor/backups) trước khi thay." },
          "Thay toàn bộ",
        );
        if (!yes) return null;
      }
    }
    const chosen = place;
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Mentor: đang chép đề vào "${chosen.title}"…` },
      () => this.deps.request("mentor.start", { exerciseId, kind, tabId: chosen.tabId, replace: chosen.foreignCells > 0 }),
    ) as { tabId: number };
    await this.deps.openMirror(started.tabId);
    return started;
  }

  /**
   * "Thêm paper": an arXiv link (or a PDF file), then the notebook that becomes
   * its workshop. The bridge fetches the paper and writes the workshop's cell;
   * its copy opens here with the chat that plans the reproduction.
   */
  private async addPaper(): Promise<unknown> {
    const how = await vscode.window.showQuickPick(
      [
        { label: "$(link) Link hoặc id arXiv", detail: "Ví dụ 2006.11239 hoặc https://arxiv.org/abs/2006.11239. Mentor đọc mã LaTeX gốc: công thức nguyên vẹn.", value: "arxiv" as const },
        { label: "$(file-pdf) File PDF trên máy", detail: "Chữ được rút trên máy của notebook (cần bật Internet để cài pypdf). Công thức có thể bị vỡ.", value: "pdf" as const },
      ],
      { title: "Thêm paper vào tủ", placeHolder: "Paper lấy từ đâu?" },
    );
    if (!how) return null;
    let source: { arxiv: string } | { pdfPath: string };
    if (how.value === "arxiv") {
      const text = await vscode.window.showInputBox({
        title: "Thêm paper: arXiv",
        prompt: "Dán link hoặc id arXiv",
        placeHolder: "2006.11239",
        validateInput: (v) => (/(\d{4}\.\d{4,5})|([a-z-]+\/\d{7})/i.test(v.trim()) ? undefined : "Chưa thấy id arXiv (dạng 2006.11239)."),
      });
      if (!text) return null;
      source = { arxiv: text.trim() };
    } else {
      const files = await vscode.window.showOpenDialog({ title: "Thêm paper: chọn file PDF", canSelectMany: false, filters: { PDF: ["pdf"] } });
      if (!files?.[0]) return null;
      source = { pdfPath: files[0].fsPath };
    }
    const place = await this.choosePlace("Notebook nào làm xưởng của paper?", "Mentor đọc paper, lập kế hoạch với bạn và chạy thử các bài trên máy của notebook này.");
    if (!place) return null;
    const added = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Mentor: đang lấy paper…" },
      () => this.deps.request("mentor.paper.add", { source, tabId: place.tabId, replace: place.foreignCells > 0 }),
    ) as { tabId: number };
    await this.deps.openMirror(added.tabId);
    return added;
  }

  /** A paper's workshop: where it is open now, else in a notebook the learner picks. */
  private async openWorkshop(paperId: string): Promise<unknown> {
    if (!paperId) throw new Error("Không rõ paper nào.");
    const places = await this.deps.request("mentor.places", {}) as MentorPlace[];
    const here = places.find((p) => p.workshop?.paperId === paperId);
    const place = here ?? await this.choosePlace("Mở xưởng của paper ở notebook nào?", "Xưởng được chép vào notebook bạn chọn; cuộc trò chuyện với mentor đi theo nó.", places);
    if (!place) return null;
    const opened = here ? { tabId: here.tabId } : await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Mentor: đang mở xưởng trong "${place.title}"…` },
      () => this.deps.request("mentor.paper.open", { paperId, tabId: place.tabId, replace: place.foreignCells > 0 }),
    ) as { tabId: number };
    await this.deps.openMirror(opened.tabId);
    return opened;
  }

  /** A notebook open in Chrome, picked by the learner (with a yes before their own cells are replaced). */
  private async choosePlace(title: string, placeHolder: string, known?: MentorPlace[]): Promise<MentorPlace | undefined> {
    const places = known ?? await this.deps.request("mentor.places", {}) as MentorPlace[];
    if (!places.length) {
      const open = await vscode.window.showWarningMessage(
        "Chưa có notebook nào trong Chrome nối với bridge. Mở một notebook Kaggle trong Chrome (có extension Agent in Notebook), rồi thử lại.",
        "Mở Kaggle",
      );
      if (open) await vscode.env.openExternal(vscode.Uri.parse(NEW_KAGGLE_NOTEBOOK));
      return undefined;
    }
    const place = await this.pickPlace(places, title, placeHolder);
    if (!place) return undefined;
    if (place.foreignCells > 0) {
      const yes = await vscode.window.showWarningMessage(
        `Notebook "${place.title}" đang có ${place.foreignCells} cell của bạn. Dùng nó sẽ thay toàn bộ nội dung.`,
        { modal: true, detail: "Bản cũ được lưu về máy (thư mục ~/.agent-in-notebook/mentor/backups) trước khi thay." },
        "Thay toàn bộ",
      );
      if (!yes) return undefined;
    }
    return place;
  }

  private async pickPlace(places: MentorPlace[], title = "Làm bài trong notebook nào?", placeHolder = "Các notebook đang mở trong Chrome. Đề bài sẽ được chép vào notebook bạn chọn."): Promise<MentorPlace | undefined> {
    const platform = (p: MentorPlace) => (p.platform === "kaggle" ? "Kaggle" : p.platform === "colab" ? "Colab" : p.platform);
    const machine = (p: MentorPlace) => (p.kernel === "idle" || p.kernel === "busy" ? "máy đang bật" : "máy chưa bật");
    const items = [...places]
      .sort((a, b) => Number(!!a.holds || !!a.workshop || a.foreignCells > 0) - Number(!!b.holds || !!b.workshop || b.foreignCells > 0) || Number(b.platform === "kaggle") - Number(a.platform === "kaggle"))
      .map((p) => ({
        label: p.title || "(notebook chưa đặt tên)",
        description: `${platform(p)} · ${machine(p)}`,
        detail: p.workshop
          ? `Đang là xưởng của paper "${p.workshop.title}": cuộc trò chuyện được cất lại, mở xưởng lại được từ tủ paper.`
          : p.holds
          ? `Đang chứa bài "${p.holds.title}"${p.holds.done ? " (đã xong)" : ""}: bài làm của bạn được lưu lại để làm tiếp sau.`
          : p.foreignCells > 0 ? `Có ${p.foreignCells} cell của bạn: sẽ bị thay (bản cũ lưu về máy).` : "Trống: dùng được ngay.",
        place: p,
      }));
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder,
      matchOnDescription: true,
    });
    return picked?.place;
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
      if (home.warmup) tip.appendMarkdown(`Khởi động: ôn lại ${home.warmup.title} (~${home.warmup.minutes} phút)\n\n`);
      if (home.today) tip.appendMarkdown(`Bài hôm nay: ${home.today.title} (~${home.today.minutes} phút)\n\n`);
      const due = home.mistakes.filter((m) => m.status === "due").length;
      if (due) tip.appendMarkdown(`Sổ lỗi sai: ${due} câu hỏi lại hôm nay\n\n`);
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
