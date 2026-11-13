import { describe, expect, it } from "vitest";
import type { NotebookInfo } from "@ainb/protocol";
import { NO_LOCAL_NOTEBOOKS, PanelCore } from "../src/panel-core.js";

const info: NotebookInfo = {
  platform: "colab", title: "train.ipynb", url: "https://colab.research.google.com/drive/x", cellCount: 2,
  activeCellId: null, selectedCellIds: [], kernel: "idle", language: "python",
};

function core(openMirror?: (tab: number, info: NotebookInfo) => Promise<void>) {
  const bridge = {
    request: async (method: string) => {
      if (method === "browser.op") return info;
      throw new Error(`unexpected ${method}`);
    },
    snapshot: () => ({ conn: "connected" }) as never,
  };
  const c = new PanelCore(bridge, NO_LOCAL_NOTEBOOKS, () => {}, openMirror);
  c.onBrowser({ notebook: { tabId: 7, info } });
  return c;
}

describe("notebook.mirror", () => {
  it("opens a Chrome tab's notebook in the editor, by its Chrome tab id", async () => {
    const opened: [number, string][] = [];
    const c = core(async (tab, i) => { opened.push([tab, i.title]); });
    expect(c.activeTab).toBe(-7);
    await c.handle("notebook.mirror", { tabId: -7 });
    expect(opened).toEqual([[7, "train.ipynb"]]);
  });

  it("refuses notebooks that are not in Chrome, and hosts without an editor", async () => {
    await expect(core(async () => {}).handle("notebook.mirror", { tabId: 3 })).rejects.toThrow(/no longer open/);
    await expect(core(async () => {}).handle("notebook.mirror", { tabId: -8 })).rejects.toThrow(/no longer open/);
    await expect(core().handle("notebook.mirror", { tabId: -7 })).rejects.toThrow(/not available/);
  });
});
