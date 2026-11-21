import type * as vscode from "vscode";
import { afterEach, expect, it, vi } from "vitest";
import { textHash, type BrowserOp, type CellInfo, type CellOutput } from "@ainb/protocol";
import { Mirror } from "../src/mirror.js";

// A small working model of the VS Code notebook API: applyEdit really splices
// cells and replaces text, and fires the change events the mirror listens to,
// so a pull's edits are observed exactly as the editor would observe them.
const h = vi.hoisted(() => {
  let cellSeq = 0;

  class FakeRange {
    constructor(public sl: number, public sc: number, public el: number, public ec: number) {}
  }
  class FakeNotebookRange {
    constructor(public start: number, public end: number) {}
  }
  class FakeNotebookCellData {
    metadata?: Record<string, unknown>;
    outputs?: unknown[];
    executionSummary?: { executionOrder: number; success?: boolean };
    constructor(public kind: number, public value: string, public languageId: string) {}
  }
  class FakeNotebookCellOutputItem {
    constructor(public data: Uint8Array, public mime: string) {}
  }
  class FakeNotebookCellOutput {
    constructor(public items: FakeNotebookCellOutputItem[], public metadata?: Record<string, unknown>) {}
  }
  type FakeNotebookEdit =
    | { type: "insert"; index: number; cells: FakeNotebookCellData[] }
    | { type: "delete"; start: number; end: number }
    | { type: "replace"; start: number; end: number; cells: FakeNotebookCellData[] }
    | { type: "metadata"; index: number; metadata: Record<string, unknown> };
  const NotebookEdit = {
    insertCells: (index: number, cells: FakeNotebookCellData[]): FakeNotebookEdit => ({ type: "insert", index, cells }),
    deleteCells: (range: FakeNotebookRange): FakeNotebookEdit => ({ type: "delete", start: range.start, end: range.end }),
    replaceCells: (range: FakeNotebookRange, cells: FakeNotebookCellData[]): FakeNotebookEdit => ({ type: "replace", start: range.start, end: range.end, cells }),
    updateCellMetadata: (index: number, metadata: Record<string, unknown>): FakeNotebookEdit => ({ type: "metadata", index, metadata }),
  };
  class FakeWorkspaceEdit {
    replaces: { uri: object; range: FakeRange; text: string }[] = [];
    notebookEdits: { uri: object; edits: FakeNotebookEdit[] }[] = [];
    replace(uri: object, range: FakeRange, text: string) { this.replaces.push({ uri, range, text }); }
    set(uri: object, edits: FakeNotebookEdit[]) { this.notebookEdits.push({ uri, edits }); }
  }

  class FakeCell {
    kind: number;
    metadata: Record<string, unknown>;
    outputs: unknown[] = [];
    executionSummary?: { executionOrder: number; success?: boolean };
    document: { getText(): string; uri: object; readonly lineCount: number; languageId: string };
    private text: string;
    constructor(public notebook: FakeNotebook, spec: { id: string; text?: string; type?: "code" | "markdown"; outputs?: unknown[]; executionCount?: number | null }) {
      this.kind = spec.type === "markdown" ? 1 : 2;
      this.metadata = { id: spec.id };
      this.text = spec.text ?? "";
      if (spec.outputs) this.outputs = spec.outputs;
      if (spec.executionCount != null) this.executionSummary = { executionOrder: spec.executionCount };
      const cell = this;
      this.document = {
        getText: () => cell.text,
        uri: { scheme: "vscode-notebook-cell", path: `/1/c${++cellSeq}`, toString() { return `vscode-notebook-cell:/1/c${cellSeq}`; } },
        get lineCount() { return cell.text.split("\n").length; },
        languageId: this.kind === 2 ? "python" : "markdown",
      };
    }
    get index() { return this.notebook.cells.indexOf(this); }
    setText(text: string) { this.text = text; }
  }

  class FakeNotebook {
    cells: FakeCell[] = [];
    isDirty = false;
    isClosed = false;
    save = vi.fn(async () => { this.isDirty = false; return true; });
    onChange?: (event: { contentChanges: unknown[]; cellChanges: { cell: FakeCell; document: FakeCell["document"] }[] }) => void;
    uri = { scheme: "ainb-chrome", path: "/1/nb (Colab).ainb", toString() { return "ainb-chrome:/1/nb (Colab).ainb"; } };
    constructor(specs: { id: string; text?: string; type?: "code" | "markdown"; outputs?: unknown[]; executionCount?: number | null }[]) {
      for (const spec of specs) this.cells.push(new FakeCell(this, spec));
    }
    get cellCount() { return this.cells.length; }
    getCells() { return [...this.cells]; }
    fire(structural: boolean, touched: FakeCell[]) {
      this.onChange?.({ contentChanges: structural ? [{}] : [], cellChanges: touched.map((cell) => ({ cell, document: cell.document })) });
    }
  }

  class FakeExecution {
    startedAt?: number;
    endedAt?: number;
    success?: boolean;
    ended = false;
    executionOrder?: number;
    replaceOutputCalls = 0;
    constructor(public cell: FakeCell) {}
    start(at?: number) { this.startedAt = at; }
    end(success: boolean | undefined, at?: number) { this.ended = true; this.success = success; this.endedAt = at; }
    clearOutput() { this.cell.outputs = []; return Promise.resolve(); }
    replaceOutput(outputs: unknown[]) { this.replaceOutputCalls++; this.cell.outputs = outputs; return Promise.resolve(); }
  }

  const state: { notebook: FakeNotebook | null; executions: FakeExecution[] } = { notebook: null, executions: [] };

  function applyEditImpl(edit: FakeWorkspaceEdit): boolean {
    const nb = state.notebook;
    if (!nb) return false;
    const touched: FakeCell[] = [];
    let structural = false;
    const make = (d: FakeNotebookCellData) => {
      const cell = new FakeCell(nb, { id: String(d.metadata?.id ?? ""), text: d.value, type: d.kind === 2 ? "code" : "markdown" });
      if (d.outputs) cell.outputs = d.outputs;
      if (d.executionSummary) cell.executionSummary = d.executionSummary;
      return cell;
    };
    for (const r of edit.replaces) {
      const cell = nb.cells.find((c) => c.document.uri === r.uri);
      if (!cell) return false;
      cell.setText(r.text);
      touched.push(cell);
    }
    for (const group of edit.notebookEdits) {
      for (const e of group.edits) {
        if (e.type === "insert") { structural = true; nb.cells.splice(e.index, 0, ...e.cells.map(make)); }
        else if (e.type === "delete") { structural = true; nb.cells.splice(e.start, e.end - e.start); }
        else if (e.type === "replace") { structural = true; nb.cells.splice(e.start, e.end - e.start, ...e.cells.map(make)); }
        else { const cell = nb.cells[e.index]; if (!cell) return false; cell.metadata = e.metadata; }
      }
    }
    nb.isDirty = true;
    nb.fire(structural, touched);
    return true;
  }

  const ui = {
    applyEdit: vi.fn(applyEditImpl),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    setStatusBarMessage: vi.fn(() => ({ dispose() {} })),
  };

  return { FakeRange, FakeNotebookRange, FakeNotebookCellData, FakeNotebookCellOutput, FakeNotebookCellOutputItem, FakeWorkspaceEdit, NotebookEdit, FakeCell, FakeNotebook, FakeExecution, state, ui };
});

vi.mock("vscode", () => ({
  NotebookCellKind: { Code: 2, Markup: 1 },
  WorkspaceEdit: h.FakeWorkspaceEdit,
  Range: h.FakeRange,
  NotebookRange: h.FakeNotebookRange,
  NotebookEdit: h.NotebookEdit,
  NotebookCellData: h.FakeNotebookCellData,
  NotebookCellOutput: h.FakeNotebookCellOutput,
  NotebookCellOutputItem: h.FakeNotebookCellOutputItem,
  workspace: { applyEdit: h.ui.applyEdit },
  window: { showErrorMessage: h.ui.showErrorMessage, showWarningMessage: h.ui.showWarningMessage, setStatusBarMessage: h.ui.setStatusBarMessage },
}));

type RemoteSpec = { id: string; type: "code" | "markdown"; source: string; outputs?: CellOutput[]; executionCount?: number | null; running?: boolean };

/** A Chrome tab holding cells, answering the ops the mirror sends (digests and CAS included). */
function fakeBrowser(initial: RemoteSpec[]) {
  const cells = initial.map((c) => ({ ...c, outputs: c.outputs ?? [] }));
  let insertSeq = 0;
  const op = vi.fn(async (_tab: number, o: BrowserOp): Promise<unknown> => {
    switch (o.op) {
      case "get_cells": {
        let list = cells;
        if (o.cellIds) list = o.cellIds.map((id) => cells.find((c) => c.id === id)).filter((c): c is (typeof cells)[number] => !!c);
        return {
          cells: list.map((c): CellInfo => {
            const info: CellInfo = { id: c.id, index: cells.indexOf(c), type: c.type, source: c.source, executionCount: c.executionCount ?? null, running: !!c.running };
            if (o.includeOutputs) info.outputs = c.outputs;
            if (o.outputsHash && c.type === "code") info.outputsHash = textHash(JSON.stringify(c.outputs));
            if (o.sourceHash) { info.sourceHash = textHash(c.source); info.source = ""; info.lineCount = c.source ? c.source.split("\n").length : 0; }
            return info;
          }),
        };
      }
      case "update_cell": {
        const cell = cells.find((c) => c.id === o.cellId);
        if (!cell) throw new Error(`No cell with id "${o.cellId}".`);
        if (o.expectedSource !== undefined && cell.source !== o.expectedSource) return { applied: false, conflict: true };
        if (cell.source === o.source) return { applied: false };
        cell.source = o.source;
        return { applied: true };
      }
      case "run_cells":
        return { results: o.cellIds.map((id) => ({ cellId: id, status: "ok", executionCount: 1, outputs: [] })) };
      case "delete_cell": {
        const i = cells.findIndex((c) => c.id === o.cellId);
        if (i >= 0) cells.splice(i, 1);
        return { applied: true };
      }
      case "insert_cell": {
        const id = `new${++insertSeq}`;
        cells.splice(o.index, 0, { id, type: o.cellType, source: o.source, outputs: [] });
        return { applied: true, cellId: id };
      }
      case "move_cell": {
        const i = cells.findIndex((c) => c.id === o.cellId);
        const [cell] = cells.splice(i, 1);
        cells.splice(o.index, 0, cell!);
        return { index: o.index };
      }
      default:
        return {};
    }
  });
  return { cells, op };
}

function setup(remote: RemoteSpec[]) {
  vi.useFakeTimers();
  h.state.executions.length = 0;
  const browser = fakeBrowser(remote);
  const nb = new h.FakeNotebook(remote.map((c) => ({ id: c.id, text: c.source, type: c.type })));
  h.state.notebook = nb;
  const controller = {
    createNotebookCellExecution: (cell: InstanceType<typeof h.FakeCell>) => {
      const execution = new h.FakeExecution(cell);
      h.state.executions.push(execution);
      return execution;
    },
  };
  const mirror = new Mirror(1, nb as unknown as vscode.NotebookDocument, { op: browser.op }, controller as unknown as vscode.NotebookController);
  nb.onChange = (event) => mirror.localChanged(event as unknown as vscode.NotebookDocumentChangeEvent);
  /** The user types in a cell (the editor fires the change event by hand, as VS Code would). */
  const edit = (cell: InstanceType<typeof h.FakeCell>, text: string) => {
    cell.setText(text);
    nb.isDirty = true;
    mirror.localChanged({ contentChanges: [], cellChanges: [{ cell, document: cell.document }] } as unknown as vscode.NotebookDocumentChangeEvent);
  };
  const tick = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);
  const ids = () => nb.cells.map((c) => c.metadata.id);
  const ops = () => browser.op.mock.calls.map(([, o]) => o);
  return { browser, nb, mirror, edit, tick, ids, ops, executions: h.state.executions };
}

const idOf = (cell: { metadata: { id?: unknown } }) => String(cell.metadata.id);
const CONFLICT_MESSAGE = "Cell 1 changed in Chrome; your unsent edit was kept in the editor but not pushed. Edit it again to send.";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  h.state.notebook = null;
  h.state.executions.length = 0;
});

it("stops Run when Chrome rejects the source update", async () => {
  const { browser, nb, mirror, edit } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    browser.op.mockRejectedValue(new Error("write failed"));
    edit(nb.cells[0]!, "new");
    await mirror.run([nb.cells[0]! as unknown as vscode.NotebookCell]);
    expect(browser.op.mock.calls.map(([, o]) => o.op)).toEqual(["update_cell"]);
    expect(h.ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("write failed"));
  } finally {
    mirror.dispose();
  }
});

it("drops a poll response read before a completed edit", async () => {
  let reply!: (value: unknown) => void;
  const read = new Promise<unknown>((resolve) => { reply = resolve; });
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    browser.op.mockImplementation(async (_tab: number, o: BrowserOp) => (o.op === "get_cells" ? read : { applied: true }));
    await tick(1000);
    edit(nb.cells[0]!, "new");
    await tick(400);
    expect(browser.op.mock.calls.map(([, o]) => o.op)).toEqual(["get_cells", "update_cell"]);
    reply({ cells: [{ id: "a", type: "code", index: 0, source: "old", sourceHash: textHash("old") }] });
    await tick(0);
    expect(h.ui.applyEdit).not.toHaveBeenCalled();
  } finally {
    mirror.dispose();
  }
});

// ---------------------------------------------------------------- A6.2: compare-and-set push

it("flush sends the browser text the edit started from as expectedSource", async () => {
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    edit(nb.cells[0]!, "new");
    await tick(400);
    const updates = browser.op.mock.calls.filter(([, o]) => o.op === "update_cell");
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toMatchObject({ op: "update_cell", cellId: "a", source: "new", expectedSource: "old", review: false, byUser: true });
    expect(browser.cells[0]!.source).toBe("new");
  } finally {
    mirror.dispose();
  }
});

it("a conflict keeps the user's text, reads the cell again, warns once, and never pushes the stale edit", async () => {
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    edit(nb.cells[0]!, "mine");
    browser.cells[0]!.source = "agent"; // the agent changes the cell in Chrome before the flush lands
    await tick(400);
    expect(nb.cells[0]!.document.getText()).toBe("mine");
    expect(browser.cells[0]!.source).toBe("agent");
    const reads = browser.op.mock.calls.filter(([, o]) => o.op === "get_cells" && o.cellIds);
    expect(reads).toHaveLength(1);
    expect(reads[0]![1]).toMatchObject({ cellIds: ["a"], includeOutputs: true, outputsHash: true });
    expect(h.ui.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(h.ui.showWarningMessage).toHaveBeenCalledWith(CONFLICT_MESSAGE);
    // Later polls neither push the stale text nor overwrite the editor with the browser's.
    await tick(3000);
    expect(browser.op.mock.calls.filter(([, o]) => o.op === "update_cell")).toHaveLength(1);
    expect(nb.cells[0]!.document.getText()).toBe("mine");
    expect(browser.cells[0]!.source).toBe("agent");
    expect(h.ui.showWarningMessage).toHaveBeenCalledTimes(1);
  } finally {
    mirror.dispose();
  }
});

it("editing again after a conflict pushes from the new known base", async () => {
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    edit(nb.cells[0]!, "mine");
    browser.cells[0]!.source = "agent";
    await tick(400);
    expect(h.ui.showWarningMessage).toHaveBeenCalledTimes(1);
    edit(nb.cells[0]!, "mine2");
    await tick(400);
    const updates = browser.op.mock.calls.filter(([, o]) => o.op === "update_cell");
    expect(updates).toHaveLength(2);
    expect(updates[1]![1]).toMatchObject({ source: "mine2", expectedSource: "agent" });
    expect(browser.cells[0]!.source).toBe("mine2");
  } finally {
    mirror.dispose();
  }
});

it("Run does not execute a conflicted cell", async () => {
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    edit(nb.cells[0]!, "mine");
    browser.cells[0]!.source = "agent";
    await tick(400);
    await mirror.run([nb.cells[0]! as unknown as vscode.NotebookCell]);
    expect(browser.op.mock.calls.some(([, o]) => o.op === "run_cells")).toBe(false);
  } finally {
    mirror.dispose();
  }
});

it("a pull across an unsent edit updates known but not the editor, and never pushes the stale text", async () => {
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old", outputs: [{ kind: "stream", name: "stdout", text: "1\n" }] }]);
  try {
    edit(nb.cells[0]!, "mine");
    browser.cells[0]!.source = "agent";
    await tick(400); // the flush conflicts; "mine" stays in the editor, unsent
    expect(h.ui.showWarningMessage).toHaveBeenCalledTimes(1);
    // The agent changes the cell again while the unsent edit sits in the editor.
    browser.cells[0]!.source = "agent2";
    browser.op.mockClear();
    await tick(1000);
    const sourceReads = browser.op.mock.calls.filter(([, o]) => o.op === "get_cells" && o.cellIds && !o.includeOutputs);
    expect(sourceReads).toHaveLength(1);
    expect(sourceReads[0]![1]).toMatchObject({ cellIds: ["a"] });
    expect(nb.cells[0]!.document.getText()).toBe("mine");
    expect(browser.cells[0]!.source).toBe("agent2");
    expect(browser.op.mock.calls.some(([, o]) => o.op === "update_cell")).toBe(false);
    expect(h.ui.showWarningMessage).toHaveBeenCalledTimes(1);
    // Editing again sends from the newest known base.
    edit(nb.cells[0]!, "mine2");
    await tick(400);
    const updates = browser.op.mock.calls.filter(([, o]) => o.op === "update_cell");
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toMatchObject({ source: "mine2", expectedSource: "agent2" });
  } finally {
    mirror.dispose();
  }
});

// ---------------------------------------------------------------- A2.2: digest pull

it("an idle poll reads digests only: no source, no outputs, no image budget", async () => {
  const { browser, mirror, tick, ops } = setup([
    { id: "a", type: "code", source: "print(1)", outputs: [{ kind: "stream", name: "stdout", text: "1\n" }] },
    { id: "b", type: "markdown", source: "# hi" },
  ]);
  try {
    await tick(1000); // the first poll reads the outputs once (nothing was known about them)
    browser.op.mockClear();
    await tick(1000);
    expect(ops()).toEqual([{ op: "get_cells", sourceHash: true, outputsHash: true }]);
  } finally {
    mirror.dispose();
  }
});

it("fetches only the cells whose source changed, without their outputs", async () => {
  const { browser, nb, mirror, tick, ops } = setup([
    { id: "a", type: "code", source: "a text", outputs: [{ kind: "stream", name: "stdout", text: "a\n" }] },
    { id: "b", type: "code", source: "b text", outputs: [{ kind: "stream", name: "stdout", text: "b\n" }] },
    { id: "c", type: "code", source: "c text", outputs: [{ kind: "stream", name: "stdout", text: "c\n" }] },
  ]);
  try {
    await tick(1000); // prime
    browser.cells[1]!.source = "new b";
    browser.op.mockClear();
    h.ui.applyEdit.mockClear();
    await tick(1000);
    expect(ops()).toEqual([
      { op: "get_cells", sourceHash: true, outputsHash: true },
      { op: "get_cells", cellIds: ["b"] },
    ]);
    expect(nb.cells[1]!.document.getText()).toBe("new b");
    expect(nb.cells[0]!.document.getText()).toBe("a text");
    expect(nb.cells[2]!.document.getText()).toBe("c text");
    expect(h.ui.applyEdit).toHaveBeenCalledTimes(1);
    const edit = h.ui.applyEdit.mock.calls[0]![0] as InstanceType<typeof h.FakeWorkspaceEdit>;
    expect(edit.replaces).toHaveLength(1);
    // The next idle poll fetches nothing again: the known hash followed the source.
    browser.op.mockClear();
    await tick(1000);
    expect(ops()).toEqual([{ op: "get_cells", sourceHash: true, outputsHash: true }]);
  } finally {
    mirror.dispose();
  }
});

it("fetches only the cells whose outputs changed, with their outputs", async () => {
  const { browser, nb, mirror, tick, ops, executions } = setup([
    { id: "a", type: "code", source: "a text", outputs: [{ kind: "stream", name: "stdout", text: "a\n" }] },
    { id: "b", type: "code", source: "b text", outputs: [{ kind: "stream", name: "stdout", text: "b\n" }] },
  ]);
  try {
    await tick(1000); // prime
    browser.cells[1]!.outputs = [{ kind: "stream", name: "stdout", text: "fresh" }];
    browser.op.mockClear();
    await tick(1000);
    expect(ops()).toEqual([
      { op: "get_cells", sourceHash: true, outputsHash: true },
      { op: "get_cells", cellIds: ["b"], includeOutputs: true, outputsHash: true },
    ]);
    const shown = executions.filter((e) => idOf(e.cell) === "b").at(-1)!;
    expect(shown.ended).toBe(true);
    const output = nb.cells[1]!.outputs[0] as InstanceType<typeof h.FakeNotebookCellOutput>;
    expect(new TextDecoder().decode(output.items[0]!.data)).toBe("fresh");
    expect(nb.cells[1]!.document.getText()).toBe("b text"); // the source did not change
  } finally {
    mirror.dispose();
  }
});

// ---------------------------------------------------------------- A6.3: minimal-diff pull

it("a browser move keeps the cells that stay put, their ids, and the running cell's spinner", async () => {
  const { browser, nb, mirror, tick, ids, executions } = setup([
    { id: "a", type: "code", source: "a" },
    { id: "b", type: "code", source: "b" },
    { id: "c", type: "code", source: "c", running: true, outputs: [{ kind: "stream", name: "stdout", text: "training…" }] },
    { id: "d", type: "code", source: "d" },
  ]);
  try {
    await tick(1000); // prime: c is running, its spinner exists
    const [ca, cb, , cd] = nb.cells;
    const spinner = executions.filter((e) => idOf(e.cell) === "c").at(-1)!;
    expect(spinner.ended).toBe(false);
    // The browser moves c up between a and b; the LIS keeps a, b, d in place.
    browser.cells.splice(2, 1);
    browser.cells.splice(1, 0, { id: "c", type: "code", source: "c", running: true, outputs: [{ kind: "stream", name: "stdout", text: "training…" }] });
    browser.op.mockClear();
    h.ui.applyEdit.mockClear();
    await tick(1000);
    expect(ids()).toEqual(["a", "c", "b", "d"]);
    expect(nb.cells[0]).toBe(ca);
    expect(nb.cells[2]).toBe(cb);
    expect(nb.cells[3]).toBe(cd);
    expect(nb.cells[1]).not.toBe(ca); // the moved cell is a new object, carrying its id and outputs
    expect(nb.cells[1]!.metadata).toEqual({ id: "c" });
    expect(nb.cells[1]!.outputs).toHaveLength(1);
    // The moved cell's old execution ended; a fresh spinner shows it still running.
    expect(spinner.ended).toBe(true);
    const live = executions.filter((e) => idOf(e.cell) === "c" && !e.ended);
    expect(live).toHaveLength(1);
    // No cell that stayed put was given a run, and nothing was rebuilt wholesale.
    expect(executions.filter((e) => ["a", "b", "d"].includes(idOf(e.cell)) && !e.ended)).toHaveLength(0);
    expect(browser.op.mock.calls.some(([, o]) => o.op === "get_cells" && o.includeOutputs && !o.cellIds)).toBe(false);
    for (const [edit] of h.ui.applyEdit.mock.calls) {
      for (const group of (edit as InstanceType<typeof h.FakeWorkspaceEdit>).notebookEdits) {
        for (const e of group.edits) expect(e.type === "insert" || e.type === "delete").toBe(true);
      }
    }
  } finally {
    mirror.dispose();
  }
});

it("a browser insert reads just the new cell and keeps the existing ones", async () => {
  const { browser, nb, mirror, tick, ids, ops, executions } = setup([
    { id: "a", type: "code", source: "a" },
    { id: "b", type: "code", source: "b" },
  ]);
  try {
    await tick(1000); // prime
    const [ca, cb] = nb.cells;
    browser.cells.push({ id: "e", type: "code", source: "new cell", running: true, outputs: [{ kind: "stream", name: "stdout", text: "hi" }] });
    browser.op.mockClear();
    await tick(1000);
    expect(ids()).toEqual(["a", "b", "e"]);
    expect(nb.cells[0]).toBe(ca);
    expect(nb.cells[1]).toBe(cb);
    expect(nb.cells[2]!.metadata).toEqual({ id: "e" });
    expect(nb.cells[2]!.document.getText()).toBe("new cell");
    expect(ops().filter((o) => o.op === "get_cells" && o.cellIds)).toEqual([
      { op: "get_cells", cellIds: ["e"], includeOutputs: true, outputsHash: true },
    ]);
    expect(executions.filter((e) => idOf(e.cell) === "e" && !e.ended)).toHaveLength(1);
  } finally {
    mirror.dispose();
  }
});

it("a browser delete removes just that cell and ends its run", async () => {
  const { browser, nb, mirror, tick, ids, executions } = setup([
    { id: "a", type: "code", source: "a" },
    { id: "b", type: "code", source: "b", running: true },
    { id: "c", type: "code", source: "c" },
  ]);
  try {
    await tick(1000); // prime: b's spinner exists
    const [ca, , cc] = nb.cells;
    const spinner = executions.filter((e) => idOf(e.cell) === "b").at(-1)!;
    browser.cells.splice(1, 1);
    await tick(1000);
    expect(ids()).toEqual(["a", "c"]);
    expect(nb.cells[0]).toBe(ca);
    expect(nb.cells[1]).toBe(cc);
    expect(spinner.ended).toBe(true);
    expect(executions.filter((e) => !e.ended)).toHaveLength(0);
  } finally {
    mirror.dispose();
  }
});

it("rebuilds the whole notebook when more than half the cells change", async () => {
  const { browser, nb, mirror, tick, ids } = setup([
    { id: "a", type: "code", source: "a" },
    { id: "b", type: "code", source: "b", running: true },
    { id: "c", type: "code", source: "c" },
  ]);
  try {
    await tick(1000); // prime
    const before = [...nb.cells];
    browser.cells.reverse(); // two of three cells move: past the threshold
    browser.op.mockClear();
    await tick(1000);
    expect(ids()).toEqual(["c", "b", "a"]);
    expect(browser.op.mock.calls.some(([, o]) => o.op === "get_cells" && o.includeOutputs && !o.cellIds)).toBe(true);
    expect(nb.cells.every((c) => !before.includes(c))).toBe(true);
    const replaced = h.ui.applyEdit.mock.calls.some(([edit]) =>
      (edit as InstanceType<typeof h.FakeWorkspaceEdit>).notebookEdits.some((g) => g.edits.some((e) => e.type === "replace")));
    expect(replaced).toBe(true);
  } finally {
    mirror.dispose();
  }
});

it("a rebuild keeps a conflicted cell's unsent text in the editor", async () => {
  const { browser, nb, mirror, edit, tick, ids } = setup([
    { id: "a", type: "code", source: "old" },
    { id: "b", type: "code", source: "b" },
    { id: "c", type: "code", source: "c" },
  ]);
  try {
    edit(nb.cells[0]!, "mine");
    browser.cells[0]!.source = "agent";
    await tick(400); // the flush conflicts; the text stays
    browser.cells.reverse();
    await tick(1000); // the reversal is a rebuild
    expect(ids()).toEqual(["c", "b", "a"]);
    const a = nb.cells.find((c) => c.metadata.id === "a")!;
    expect(a.document.getText()).toBe("mine");
    expect(browser.cells.find((c) => c.id === "a")!.source).toBe("agent");
    edit(a, "mine2");
    await tick(400);
    const updates = browser.op.mock.calls.filter(([, o]) => o.op === "update_cell");
    expect(updates.at(-1)![1]).toMatchObject({ source: "mine2", expectedSource: "agent" });
    expect(browser.cells.find((c) => c.id === "a")!.source).toBe("mine2");
  } finally {
    mirror.dispose();
  }
});

it("user structural changes still push in order, without CAS", async () => {
  const { browser, nb, mirror, tick } = setup([
    { id: "a", type: "code", source: "a" },
    { id: "b", type: "code", source: "b" },
  ]);
  try {
    nb.cells.splice(0, 1); // the user deletes cell a in VS Code
    nb.isDirty = true;
    mirror.localChanged({ contentChanges: [{}], cellChanges: [] } as unknown as vscode.NotebookDocumentChangeEvent);
    await tick(400);
    const structural = browser.op.mock.calls.filter(([, o]) => ["delete_cell", "insert_cell", "move_cell"].includes(o.op));
    expect(structural).toHaveLength(1);
    expect(structural[0]![1]).toEqual({ op: "delete_cell", cellId: "a", review: false, byUser: true });
    expect(browser.cells.map((c) => c.id)).toEqual(["b"]);
  } finally {
    mirror.dispose();
  }
});

// ---------------------------------------------------------------- A2.4: live output throttle

it("shows a running cell's large output live at most every 2 s", async () => {
  const big = "x".repeat(150_000);
  const { browser, mirror, tick, executions } = setup([
    { id: "a", type: "code", source: "train()", running: true, outputs: [{ kind: "stream", name: "stdout", text: big }] },
  ]);
  try {
    await tick(1000); // first live show
    const spinner = executions.filter((e) => idOf(e.cell) === "a").at(-1)!;
    expect(spinner.replaceOutputCalls).toBe(1);
    browser.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: `${big}1` }];
    await tick(1000); // 1 s later: throttled
    expect(spinner.replaceOutputCalls).toBe(1);
    browser.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: `${big}12` }];
    await tick(1000); // 2 s after the last show: shown again
    expect(spinner.replaceOutputCalls).toBe(2);
  } finally {
    mirror.dispose();
  }
});

it("shows a running cell's small output every poll", async () => {
  const { browser, mirror, tick, executions } = setup([
    { id: "a", type: "code", source: "print()", running: true, outputs: [{ kind: "stream", name: "stdout", text: "epoch 1\n" }] },
  ]);
  try {
    await tick(1000);
    const spinner = executions.filter((e) => idOf(e.cell) === "a").at(-1)!;
    expect(spinner.replaceOutputCalls).toBe(1);
    browser.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "epoch 1\nepoch 2\n" }];
    await tick(1000);
    expect(spinner.replaceOutputCalls).toBe(2);
    browser.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: "epoch 1\nepoch 2\nepoch 3\n" }];
    await tick(1000);
    expect(spinner.replaceOutputCalls).toBe(3);
  } finally {
    mirror.dispose();
  }
});

it("a finished run shows its full output even past the throttle", async () => {
  const big = "x".repeat(150_000);
  const { browser, mirror, tick, executions } = setup([
    { id: "a", type: "code", source: "train()", running: true, outputs: [{ kind: "stream", name: "stdout", text: big }] },
  ]);
  try {
    await tick(1000);
    const spinner = executions.filter((e) => idOf(e.cell) === "a").at(-1)!;
    expect(spinner.replaceOutputCalls).toBe(1);
    browser.cells[0]!.running = false;
    browser.cells[0]!.executionCount = 7;
    browser.cells[0]!.outputs = [{ kind: "stream", name: "stdout", text: `${big}done` }];
    await tick(1000); // finished within the throttle window: still shown in full
    expect(spinner.replaceOutputCalls).toBe(2);
    expect(spinner.ended).toBe(true);
    expect(spinner.executionOrder).toBe(7);
  } finally {
    mirror.dispose();
  }
});

// ---------------------------------------------------------------- save() batching

it("saves once per poll cycle, not after each flush", async () => {
  const { nb, mirror, edit, tick } = setup([
    { id: "a", type: "code", source: "a" },
    { id: "b", type: "code", source: "b" },
  ]);
  try {
    edit(nb.cells[0]!, "a2");
    edit(nb.cells[1]!, "b2");
    await tick(400); // both flushes land
    expect(nb.save).not.toHaveBeenCalled();
    await tick(1000); // the poll cycle saves once, with the queue idle
    expect(nb.save).toHaveBeenCalledTimes(1);
    expect(nb.isDirty).toBe(false);
  } finally {
    mirror.dispose();
  }
});

it("does not save while a push is still queued", async () => {
  const { browser, nb, mirror, edit, tick } = setup([{ id: "a", type: "code", source: "old" }]);
  try {
    let resolveRead!: (value: unknown) => void;
    let resolveWrite!: (value: unknown) => void;
    const digest = new Promise<unknown>((r) => { resolveRead = r; });
    const write = new Promise<unknown>((r) => { resolveWrite = r; });
    const original = browser.op.getMockImplementation()!;
    let readHung = false;
    let writeHung = false;
    browser.op.mockImplementation(async (tab: number, o: BrowserOp) => {
      if (o.op === "get_cells" && o.sourceHash && !readHung) { readHung = true; return digest; }
      if (o.op === "update_cell" && !writeHung) { writeHung = true; return write; }
      return original(tab, o);
    });
    await tick(1000); // the poll's digest read hangs
    edit(nb.cells[0]!, "new"); // t=1000: dirty, flush due at 1400
    await tick(400); // the flush is queued, its write hangs
    resolveRead({ cells: [{ id: "a", type: "code", index: 0, source: "old", sourceHash: textHash("old") }] });
    await tick(0); // the poll ends with a push still queued: no save
    expect(nb.save).not.toHaveBeenCalled();
    resolveWrite({ applied: true });
    browser.cells[0]!.source = "new"; // the write landed in the browser
    await tick(1000); // the next cycle, queue idle: save once
    expect(nb.save).toHaveBeenCalledTimes(1);
  } finally {
    mirror.dispose();
  }
});