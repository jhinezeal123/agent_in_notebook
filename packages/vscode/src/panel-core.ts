// What the chat panel's host does apart from VS Code itself: which notebook
// the chat is about, the notebooks open in Chrome tabs (served by the browser
// extension through the bridge), and the panel's requests about them. VS Code
// supplies its own notebooks through `LocalNotebooks`; the browser tests run
// this with none.

import { ATTACHED_CELLS_MAX, type AttachedCell, type BridgeEvents, type BrowserNotebook, type BrowserOp, type NotebookInfo, type ReaderAnchor } from "@ainb/protocol";
import type { BridgeState, NotebookChoice, PanelEvent } from "../../ui/src/panel-messages.js";

export interface PanelBridge {
  request(method: string, params: unknown): Promise<unknown>;
  snapshot(): BridgeState;
}

/** The editor's own notebooks, by positive id. */
export interface LocalNotebooks {
  choices(): NotebookChoice[];
  has(tabId: number): boolean;
  info(tabId: number): NotebookInfo | null;
  userOp(tabId: number, op: BrowserOp): Promise<unknown>;
  openChat(tabId: number, params: Record<string, unknown>): Promise<unknown>;
  closeChat(chatId: string): Promise<void>;
  /** Bring the notebook to the front in the editor. */
  reveal(tabId: number): Promise<void>;
  /** The notebook the editor shows in front, if any. */
  front(): number | null;
}

/** Easy-read: papers open in their reading tabs, each with a tab id of its own (READER_TAB_BASE and up). */
export interface ReaderTabs {
  has(tabId: number): boolean;
  /** The paper a reading tab shows. */
  info(tabId: number): { paperId: string; title: string } | null;
  /** Bring the reading tab to the front, at a place the tutor cited. */
  reveal(tabId: number, anchor?: ReaderAnchor, action?: "quiz"): Promise<void>;
}

export const NO_READER_TABS: ReaderTabs = {
  has: () => false,
  info: () => null,
  reveal: async () => {},
};

/** Reading tabs' ids: far above the editor's notebooks (counted from 1), and positive unlike Chrome tabs. */
export const READER_TAB_BASE = 1_000_000_000;
export const isReaderTab = (tabId: number) => tabId >= READER_TAB_BASE;

export const NO_LOCAL_NOTEBOOKS: LocalNotebooks = {
  choices: () => [],
  has: () => false,
  info: () => null,
  userOp: () => Promise.reject(new Error("No such notebook.")),
  openChat: () => Promise.reject(new Error("No such notebook.")),
  closeChat: async () => {},
  reveal: async () => {},
  front: () => null,
};

/** Panel requests passed to the bridge as they are. */
const BRIDGE_METHODS = new Set([
  "agents.list", "agents.save", "agents.remove", "agents.test", "chat.get", "chat.send",
  "chat.cancel", "chat.settings", "chat.option", "chat.answer", "chat.review", "chat.undo", "chat.changes", "chat.pin", "chat.dequeue", "chat.cardAction", "chat.saveNotebook", "chat.verifyNotebook", "chat.pushCode",
  "chats.search", "research.quota", "research.closeSession",
  "mentor.status", "mentor.judge", "mentor.hint", "mentor.stage", "mentor.codeReview", "mentor.report",
  "mentor.paper.approve", "mentor.paper.author", "mentor.paper.stopAuthoring",
  "reader.settings",
]);

/** A notebook in a Chrome tab has the tab's id, negated, so it never meets an editor id. */
export const chromeTab = (tabId: number) => -tabId;
export const isChrome = (tabId: number) => tabId < 0;

export class PanelCore {
  /** Notebooks open in Chrome tabs, by Chrome tab id. */
  private readonly browser = new Map<number, NotebookInfo>();
  /**
   * Cells attached to the next message, by notebook. Kept here, not in the
   * panel, so cells attached before the chat view first opens are not lost.
   */
  private readonly attachments = new Map<number, AttachedCell[]>();
  activeTab: number | null = null;

  constructor(
    private readonly bridge: PanelBridge,
    private readonly local: LocalNotebooks,
    private readonly post: (event: PanelEvent) => void,
    /** Show a Chrome tab's notebook in the editor (VS Code's mirror); absent where there is no editor. */
    private readonly openMirror?: (chromeTabId: number, info: NotebookInfo) => Promise<void>,
    /** Papers open in reading tabs: the chat is their tutor's while one is in front. */
    private readonly readers: ReaderTabs = NO_READER_TABS,
  ) {}

  /** The bridge connected or went away. */
  connectionChanged(connected: boolean): void {
    if (connected) {
      void this.loadBrowserNotebooks();
      return;
    }
    if (!this.browser.size) return;
    this.browser.clear();
    this.localChanged();
  }

  /** From the bridge: a Chrome notebook appeared, changed or went, or the user brought one to the front. */
  onBrowser(event: { notebook: BridgeEvents["browser.notebook"] } | { focused: number }): void {
    if ("focused" in event) {
      if (this.browser.has(event.focused)) this.select(-event.focused);
      return;
    }
    const { tabId, info } = event.notebook;
    if (info) this.browser.set(tabId, info);
    else this.browser.delete(tabId);
    this.post({ event: "notebooks", params: this.choices() });
    if (this.activeTab === -tabId) {
      if (info) this.post({ event: "notebook", params: { tabId: -tabId, info } });
      else this.select(this.fallback());
    } else if (this.activeTab === null && info) this.select(-tabId);
  }

  /** A reading tab opened or closed: the chat leaves a paper whose tab is gone. */
  readersChanged(): void {
    if (this.activeTab !== null && !this.exists(this.activeTab)) this.select(this.fallback());
  }

  /** The editor's notebooks changed (one opened or closed). */
  localChanged(): void {
    this.post({ event: "notebooks", params: this.choices() });
    if (this.activeTab === null || !this.exists(this.activeTab)) this.select(this.fallback());
  }

  /**
   * A notebook came to the front in the editor: the chat follows it. Leaving
   * notebooks for a text editor keeps the chat where it was (it may be about
   * a notebook in Chrome).
   */
  follow(tabId: number | null): void {
    if (tabId !== null) this.select(tabId);
    else if (this.activeTab === null || !this.exists(this.activeTab)) this.select(this.fallback());
  }

  exists(tabId: number): boolean {
    if (isReaderTab(tabId)) return this.readers.has(tabId);
    return isChrome(tabId) ? this.browser.has(chromeTab(tabId)) : this.local.has(tabId);
  }

  private fallback(): number | null {
    const front = this.local.front();
    if (front !== null) return front;
    const [first] = this.browser.keys();
    return first === undefined ? null : -first;
  }

  private select(tabId: number | null): void {
    if (this.activeTab === tabId) return;
    this.activeTab = tabId;
    this.post({ event: "activeTab", params: tabId });
  }

  choices(): NotebookChoice[] {
    return [
      ...this.local.choices(),
      ...[...this.browser].map(([tab, info]) => ({ tabId: -tab, platform: info.platform, title: info.title, place: "chrome" as const })),
    ];
  }

  private async loadBrowserNotebooks(): Promise<void> {
    try {
      const { notebooks } = await this.bridge.request("browser.notebooks", {}) as { notebooks: BrowserNotebook[] };
      this.browser.clear();
      for (const { tabId, info } of notebooks) this.browser.set(tabId, info);
    } catch {
      return;
    }
    this.localChanged();
  }

  /** "Attach to Chat" on cells of a notebook: they join that notebook's next message. A cell attached again keeps its place, with its label updated. */
  attach(tabId: number, cells: AttachedCell[]): void {
    const fresh = new Map(cells.map((c) => [c.cellId, c]));
    const before = this.attached(tabId);
    const kept = before.map((c) => fresh.get(c.cellId) ?? c);
    const known = new Set(before.map((c) => c.cellId));
    const next = [...kept, ...[...fresh.values()].filter((c) => !known.has(c.cellId))].slice(-ATTACHED_CELLS_MAX);
    this.setAttachments(tabId, next, true);
  }

  attached(tabId: number): AttachedCell[] {
    return this.attachments.get(tabId) ?? [];
  }

  private setAttachments(tabId: number, cells: AttachedCell[], added = false): void {
    if (cells.length) this.attachments.set(tabId, cells);
    else this.attachments.delete(tabId);
    this.post({ event: "attachments", params: { tabId, cells, ...(added ? { added } : {}) } });
  }

  /** What the panel itself does to a notebook (the agent's operations go through its chat). */
  private userOp(tabId: number, op: BrowserOp): Promise<unknown> {
    if (isChrome(tabId)) return this.bridge.request("browser.op", { tabId: chromeTab(tabId), op });
    return this.local.userOp(tabId, op);
  }

  async info(tabId: number): Promise<NotebookInfo | null> {
    if (isReaderTab(tabId)) return null;
    if (!isChrome(tabId)) return this.local.info(tabId);
    const known = this.browser.get(chromeTab(tabId));
    if (!known) return null;
    try {
      return await this.userOp(tabId, { op: "info" }) as NotebookInfo;
    } catch {
      return known;
    }
  }

  /** Answers the panel's requests about notebooks and chats; `undefined` handler means not one of them. */
  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "state.get": return this.bridge.snapshot();
      case "activeTab.get": return this.activeTab;
      case "notebooks.list": return this.choices();
      case "notebooks.select": {
        const { tabId } = params as { tabId: number };
        if (!this.exists(tabId)) throw new Error("That notebook is no longer open.");
        this.select(tabId);
        if (isReaderTab(tabId)) await this.readers.reveal(tabId);
        else if (!isChrome(tabId)) await this.local.reveal(tabId);
        return;
      }
      case "tab.notebook": return this.info((params as { tabId: number }).tabId);
      case "tab.reader": {
        const { tabId } = params as { tabId: number };
        return isReaderTab(tabId) ? this.readers.info(tabId) : null;
      }
      case "reader.reveal": {
        // A citation chip in the tutor's answer: its reading tab scrolls there.
        const { tabId, anchor, action } = params as { tabId: number; anchor?: ReaderAnchor; action?: "quiz" };
        if (!isReaderTab(tabId) || !this.readers.has(tabId)) throw new Error("Tab đọc của paper này đã đóng. Mở lại paper (Easy Read: Mở paper…).");
        return this.readers.reveal(tabId, anchor, action === "quiz" ? action : undefined);
      }
      case "reader.guide": {
        const { tabId } = params as { tabId: number };
        const paper = this.readers.info(tabId);
        return paper ? this.bridge.request("reader.guide", { paperId: paper.paperId }) : null;
      }
      case "attachments.get": return this.attached((params as { tabId: number }).tabId);
      case "attachments.remove": {
        // `cellIds` absent: all of them (the message they rode on was sent).
        const { tabId, cellIds } = params as { tabId: number; cellIds?: string[] };
        const gone = cellIds && new Set(cellIds);
        const before = this.attached(tabId);
        const after = gone ? before.filter((c) => !gone.has(c.cellId)) : [];
        if (after.length !== before.length) this.setAttachments(tabId, after);
        return;
      }
      case "notebook.focus": {
        const { tabId, cellId } = params as { tabId: number; cellId: string };
        return this.userOp(tabId, { op: "focus_cell", cellId });
      }
      case "notebook.insert": {
        // The user's own "Insert as cell": below the selected cell (or at the end), no review.
        const { tabId, source, cellType } = params as { tabId: number; source: string; cellType: "code" | "markdown" };
        const info = await this.info(tabId);
        if (!info) throw new Error("That notebook is no longer open.");
        let index = info.cellCount;
        if (info.activeCellId) {
          const { cells } = await this.userOp(tabId, { op: "get_cells", cellIds: [info.activeCellId] }) as { cells: { index: number }[] };
          if (cells[0]) index = cells[0].index + 1;
        }
        const result = await this.userOp(tabId, { op: "insert_cell", index, source, cellType, review: false, byUser: true }) as { cellId: string | null };
        if (result.cellId) await this.userOp(tabId, { op: "focus_cell", cellId: result.cellId }).catch(() => {});
        return result;
      }
      case "notebook.mirror": {
        const { tabId } = params as { tabId: number };
        const info = isChrome(tabId) ? await this.info(tabId) : null;
        if (!info) throw new Error("That notebook is no longer open in Chrome.");
        if (!this.openMirror) throw new Error("Opening a Chrome notebook here is not available.");
        return this.openMirror(chromeTab(tabId), info);
      }
      case "chat.open": {
        const p = params as Record<string, unknown> & { tabId: number };
        if (isReaderTab(p.tabId)) {
          // A paper's tutor: no notebook, the paper names the chat.
          const paper = this.readers.info(p.tabId);
          if (!paper) throw new Error("Tab đọc của paper này đã đóng.");
          const { platform: _p, notebookKey: _k, browserTab: _b, ...rest } = p;
          return this.bridge.request(method, { ...rest, reader: { paperId: paper.paperId } });
        }
        if (!isChrome(p.tabId)) return this.local.openChat(p.tabId, p);
        const info = this.browser.get(chromeTab(p.tabId));
        if (!info) throw new Error("That notebook is no longer open in Chrome.");
        return this.bridge.request(method, { ...p, platform: info.platform, notebookKey: info.key, browserTab: chromeTab(p.tabId) });
      }
      case "chat.close": {
        await this.local.closeChat((params as { chatId: string }).chatId);
        return this.bridge.request(method, params);
      }
      default:
        if (!BRIDGE_METHODS.has(method)) throw new Error(`Unknown panel request: ${method}`);
        return this.bridge.request(method, params);
    }
  }
}
