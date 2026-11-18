import type * as vscode from "vscode";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserOp } from "@ainb/protocol";
import { Mirror } from "../src/mirror.js";

const ui = vi.hoisted(() => ({ applyEdit: vi.fn(), showErrorMessage: vi.fn() }));
vi.mock("vscode", () => ({
  NotebookCellKind: { Code: 2 },
  WorkspaceEdit: class { replace() {} },
  Range: class {},
  workspace: { applyEdit: ui.applyEdit },
  window: { showErrorMessage: ui.showErrorMessage },
}));

function notebook(op: (tab: number, op: BrowserOp) => Promise<unknown>) {
  vi.useFakeTimers();
  let text = "old";
  const cell = { kind: 2, index: 0, metadata: { id: "a" }, document: { getText: () => text } } as unknown as vscode.NotebookCell;
  const document = { getCells: () => [cell] } as unknown as vscode.NotebookDocument;
  const mirror = new Mirror(1, document, { op }, {} as vscode.NotebookController);
  const edit = () => {
    text = "new";
    mirror.localChanged({ contentChanges: [], cellChanges: [{ cell, document: cell.document }] } as unknown as vscode.NotebookDocumentChangeEvent);
  };
  return { mirror, cell, edit };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("stops Run when Chrome rejects the source update", async () => {
  const op = vi.fn().mockRejectedValue(new Error("write failed"));
  const { mirror, cell, edit } = notebook(op);
  try {
    edit();
    await mirror.run([cell]);
    expect(op.mock.calls.map(([, op]) => op.op)).toEqual(["update_cell"]);
    expect(ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("write failed"));
  } finally {
    mirror.dispose();
  }
});

it("drops a poll response read before a completed edit", async () => {
  let reply!: (value: unknown) => void;
  const read = new Promise<unknown>((resolve) => { reply = resolve; });
  const op = vi.fn(async (_tab: number, op: BrowserOp) => op.op === "get_cells" ? read : {});
  const { mirror, edit } = notebook(op);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    edit();
    await vi.advanceTimersByTimeAsync(400);
    expect(op.mock.calls.map(([, op]) => op.op)).toEqual(["get_cells", "update_cell"]);
    reply({ cells: [{ id: "a", type: "code", index: 0, source: "old" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.applyEdit).not.toHaveBeenCalled();
  } finally {
    mirror.dispose();
  }
});
