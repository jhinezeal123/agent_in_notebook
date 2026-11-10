// The contract every platform adapter implements. Adapters run in the page's
// main world, next to the notebook app they drive.

import type { CellInfo, CellType, NotebookEvent, NotebookInfo, NotebookOp, ReviewInfo, RunResult } from "@ainb/protocol";

export interface NotebookAdapter {
  readonly platform: NotebookInfo["platform"];
  info(): NotebookInfo;
  getCells(opts: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[];
  /** Returns false when the source was already equal. */
  setSource(cellId: string, source: string): boolean;
  insertCell(index: number, type: CellType, source: string): Promise<string>;
  deleteCell(cellId: string): void;
  moveCell(cellId: string, index: number): number;
  /** Run one code cell; resolves when it finishes or `timeoutMs` passes (the cell keeps running). */
  runCell(cellId: string, timeoutMs: number): Promise<RunResult>;
  interrupt(): boolean;
  focusCell(cellId: string): boolean;
  /**
   * Show a proposed change in the notebook. `decided` resolves when the user
   * accepts or rejects it, here or through `resolve`.
   */
  showReview(review: ReviewInfo): { decided: Promise<boolean>; resolve(accept: boolean): void };
  /** Selection changes, for the "edit this cell" mode. */
  onSelectionChange(cb: () => void): void;
}

export class OpError extends Error {}

let reviewSeq = 0;

/** Runs NotebookOps against an adapter and owns the pending reviews. */
export class OpRunner {
  private reviews = new Map<string, { info: ReviewInfo; resolve(accept: boolean): void }>();

  constructor(
    private readonly adapter: NotebookAdapter,
    private readonly emit: (e: NotebookEvent) => void,
  ) {
    adapter.onSelectionChange(() => {
      const info = adapter.info();
      emit({ type: "selection_changed", activeCellId: info.activeCellId, selectedCellIds: info.selectedCellIds });
    });
  }

  pendingCellIds(): Set<string> {
    return new Set([...this.reviews.values()].map((r) => r.info.cellId));
  }

  async run(op: NotebookOp): Promise<unknown> {
    const a = this.adapter;
    switch (op.op) {
      case "info":
        return a.info();
      case "get_cells": {
        const pending = this.pendingCellIds();
        return {
          cells: a.getCells(op).map((c) => (pending.has(c.id) ? { ...c, pendingReview: true } : c)),
        };
      }
      case "update_cell": {
        this.assertNoReview(op.cellId);
        const [cell] = a.getCells({ cellIds: [op.cellId] });
        if (!cell) throw new OpError(`No cell with id "${op.cellId}".`);
        if (cell.source === op.source) return { applied: false };
        if (!op.review) return { applied: a.setSource(op.cellId, op.source) };
        const reviewId = this.open({ cellId: cell.id, kind: "update", cellType: cell.type, before: cell.source, after: op.source });
        return { applied: false, reviewId };
      }
      case "insert_cell": {
        const index = Math.max(0, Math.min(op.index, a.info().cellCount));
        if (!op.review) {
          const cellId = await a.insertCell(index, op.cellType, op.source);
          return { applied: true, cellId };
        }
        // The cell exists while it is reviewed; rejecting removes it again.
        const cellId = await a.insertCell(index, op.cellType, "");
        const reviewId = this.open({ cellId, kind: "insert", cellType: op.cellType, before: "", after: op.source });
        return { applied: false, cellId, reviewId };
      }
      case "delete_cell": {
        this.assertNoReview(op.cellId);
        const [cell] = a.getCells({ cellIds: [op.cellId] });
        if (!cell) throw new OpError(`No cell with id "${op.cellId}".`);
        if (!op.review) {
          a.deleteCell(op.cellId);
          return { applied: true };
        }
        const reviewId = this.open({ cellId: cell.id, kind: "delete", cellType: cell.type, before: cell.source, after: "" });
        return { applied: false, reviewId };
      }
      case "move_cell":
        return { index: a.moveCell(op.cellId, op.index) };
      case "run_cells": {
        const deadline = Date.now() + op.timeoutMs;
        const results: RunResult[] = [];
        let stop = false;
        for (const id of op.cellIds) {
          if (stop) {
            results.push({ cellId: id, status: "skipped", outputs: [], message: "not run: an earlier cell failed" });
            continue;
          }
          if (this.pendingCellIds().has(id)) {
            results.push({ cellId: id, status: "skipped", outputs: [], message: "not run: a change to this cell awaits review" });
            continue;
          }
          const left = deadline - Date.now();
          if (left <= 0) {
            results.push({ cellId: id, status: "skipped", outputs: [], message: "not run: time ran out" });
            continue;
          }
          const r = await a.runCell(id, left);
          results.push(r);
          if (r.status === "timeout") stop = true;
          if (r.status === "error" && op.stopOnError) stop = true;
        }
        return { results };
      }
      case "interrupt":
        return { interrupted: a.interrupt() };
      case "focus_cell":
        return { focused: a.focusCell(op.cellId) };
      case "resolve_review": {
        const r = this.reviews.get(op.reviewId);
        if (!r) return { resolved: false };
        r.resolve(op.accept);
        return { resolved: true };
      }
    }
  }

  private assertNoReview(cellId: string) {
    if (this.pendingCellIds().has(cellId)) {
      throw new OpError(`Cell ${cellId} has a change awaiting the user's review. Wait for it (await_review) before changing the cell again.`);
    }
  }

  private open(partial: Omit<ReviewInfo, "reviewId">): string {
    const info: ReviewInfo = { ...partial, reviewId: `rv${Date.now().toString(36)}${(++reviewSeq).toString(36)}` };
    const shown = this.adapter.showReview(info);
    this.reviews.set(info.reviewId, { info, resolve: shown.resolve });
    this.emit({ type: "review_opened", review: info });
    shown.decided.then(
      (accepted) => {
        this.reviews.delete(info.reviewId);
        this.emit({ type: "review_closed", reviewId: info.reviewId, accepted });
      },
      () => {
        this.reviews.delete(info.reviewId);
        this.emit({ type: "review_closed", reviewId: info.reviewId, accepted: false });
      },
    );
    return info.reviewId;
  }
}

/** Race a promise against a timeout without cancelling it. */
export function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  return Promise.race([
    p.then((value) => ({ done: true as const, value })),
    new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), Math.max(0, ms))),
  ]);
}
