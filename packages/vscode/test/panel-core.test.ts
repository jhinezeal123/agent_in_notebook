import { describe, expect, it } from "vitest";
import type { AttachedCell, NotebookInfo } from "@ainb/protocol";
import type { PanelEvent } from "../../ui/src/panel-messages.js";
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

describe("attached cells", () => {
  const cell = (cellId: string, index: number, label = `x = ${index}`): AttachedCell => ({ cellId, index, label });
  function withEvents() {
    const events: PanelEvent[] = [];
    const bridge = { request: async () => info, snapshot: () => ({ conn: "connected" }) as never };
    const c = new PanelCore(bridge, NO_LOCAL_NOTEBOOKS, (e) => events.push(e));
    const attachments = () => events.filter((e): e is Extract<PanelEvent, { event: "attachments" }> => e.event === "attachments").map((e) => e.params);
    return { c, attachments };
  }

  it("keeps a notebook's attached cells, in order, until they are removed", async () => {
    const { c, attachments } = withEvents();
    c.attach(-7, [cell("a", 0)]);
    c.attach(-7, [cell("b", 3), cell("a", 1, "y = 1")]);
    expect(await c.handle("attachments.get", { tabId: -7 })).toEqual([cell("a", 1, "y = 1"), cell("b", 3)]);
    expect(await c.handle("attachments.get", { tabId: 5 })).toEqual([]);
    expect(attachments().at(-1)).toEqual({ tabId: -7, cells: [cell("a", 1, "y = 1"), cell("b", 3)], added: true });

    await c.handle("attachments.remove", { tabId: -7, cellIds: ["a"] });
    expect(attachments().at(-1)).toEqual({ tabId: -7, cells: [cell("b", 3)] });
    await c.handle("attachments.remove", { tabId: -7 });
    expect(await c.handle("attachments.get", { tabId: -7 })).toEqual([]);
    expect(attachments().at(-1)).toEqual({ tabId: -7, cells: [] });
  });

  it("tells nothing when a removal changes nothing", async () => {
    const { c, attachments } = withEvents();
    c.attach(3, [cell("a", 0)]);
    await c.handle("attachments.remove", { tabId: 3, cellIds: ["missing"] });
    expect(attachments()).toHaveLength(1);
  });

  it("keeps at most twenty cells, dropping the oldest", async () => {
    const { c } = withEvents();
    c.attach(3, Array.from({ length: 25 }, (_, i) => cell(`c${i}`, i)));
    const kept = await c.handle("attachments.get", { tabId: 3 }) as AttachedCell[];
    expect(kept).toHaveLength(20);
    expect(kept[0]!.cellId).toBe("c5");
  });
});
