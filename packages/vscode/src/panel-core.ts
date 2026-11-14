// What the chat panel's host does apart from VS Code itself: which notebook
// the chat is about, the notebooks open in Chrome tabs (served by the browser
// extension through the bridge), and the panel's requests about them. VS Code
// supplies its own notebooks through `LocalNotebooks`; the browser tests run
// this with none.

import type { BridgeEvents, BrowserNotebook, BrowserOp, NotebookInfo } from "@ainb/protocol";
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
  "chat.cancel", "chat.settings", "chat.option", "chat.answer", "chat.review", "chat.undo", "chat.saveNotebook",
]);

/** A notebook in a Chrome tab has the tab's id, negated, so it never meets an editor id. */
export const chromeTab = (tabId: number) => -tabId;
export const isChrome = (tabId: number) => tabId < 0;

export class PanelCore {
  /** Notebooks open in Chrome tabs, by Chrome tab id. */
  private readonly browser = new Map<number, NotebookInfo>();
  activeTab: number | null = null;

  constructor(
    private readonly bridge: PanelBridge,
    private readonly local: LocalNotebooks,
    private readonly post: (event: PanelEvent) => void,
    /** Show a Chrome tab's notebook in the editor (VS Code's mirror); absent where there is no editor. */
    private readonly openMirror?: (chromeTabId: number, info: NotebookInfo) => Promise<void>,
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

  /** What the panel itself does to a notebook (the agent's operations go through its chat). */
  private userOp(tabId: number, op: BrowserOp): Promise<unknown> {
    if (isChrome(tabId)) return this.bridge.request("browser.op", { tabId: chromeTab(tabId), op });
    return this.local.userOp(tabId, op);
  }

  async info(tabId: number): Promise<NotebookInfo | null> {
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
        if (!isChrome(tabId)) await this.local.reveal(tabId);
        return;
      }
      case "tab.notebook": return this.info((params as { tabId: number }).tabId);
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
