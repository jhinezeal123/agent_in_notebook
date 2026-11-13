// The contract for notebook editors and the shared runner for their operations.

import {
  summarizeCell,
  type AppliedChange,
  type CellInfo,
  type CellOutput,
  type CellType,
  type ExecResult,
  type NotebookEvent,
  type NotebookInfo,
  type NotebookOp,
  type ReviewInfo,
  type RunResult,
} from "./notebook.js";
import { normalizeIpynbOutput } from "./outputs.js";

export interface NotebookAdapter {
  readonly platform: NotebookInfo["platform"];
  info(): NotebookInfo;
  getCells(opts: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[];
  /** Returns false when the source was already equal. */
  setSource(cellId: string, source: string): boolean | Promise<boolean>;
  insertCell(index: number, type: CellType, source: string): Promise<string>;
  deleteCell(cellId: string): void | Promise<void>;
  /** Resolves to the index the cell ended up at. */
  moveCell(cellId: string, index: number): number | Promise<number>;
  /** Run one code cell; resolves when it finishes or `timeoutMs` passes (the cell keeps running). */
  runCell(cellId: string, timeoutMs: number): Promise<RunResult>;
  /**
   * Start running code on the kernel outside any cell, without storing it in
   * the kernel's history. Throws when the kernel is busy or not connected.
   */
  startExecution(code: string): Promise<Execution>;
  /**
   * Run Python on the machine without the kernel (see ServerPython). Throws
   * NoServerPython when the server offers no way; the kernel is used then.
   */
  machineExec?(code: string, waitMs: number): Promise<ExecResult>;
  interrupt(): boolean | Promise<boolean>;
  focusCell(cellId: string): boolean | Promise<boolean>;
  /** Reserve an ID for a reviewed insertion that only exists once it is accepted. */
  reserveCell?(index: number, type: CellType): string;
  /**
   * Show a proposed change in the notebook. `decided` resolves when the user
   * accepts or rejects it, here or through `resolve`.
   */
  showReview(review: ReviewInfo): { decided: Promise<boolean | { index: number }>; resolve(accept: boolean): void | Promise<void> };
  /** Selection changes, for the "edit this cell" mode. */
  onSelectionChange(cb: () => void): void;
}

export class OpError extends Error {}

/** The notebook server cannot lend a terminal that runs Python; the kernel is used instead. */
export class NoServerPython extends Error {}

/** Code running on the kernel outside any cell: its reply, and the outputs so far. */
export interface Execution {
  reply: Promise<{ status?: string; ename?: string; evalue?: string }>;
  collected: OutputCollector;
}

let reviewSeq = 0;

/**
 * Runs NotebookOps against an adapter and owns the pending reviews. Every
 * change it applies for the agent is reported as `change_applied`, with what
 * the cell held before, so the user can undo it later.
 */
export class OpRunner {
  private reviews = new Map<string, { info: ReviewInfo; resolve(accept: boolean): void | Promise<void> }>();
  private readonly executions = new Executions();

  constructor(
    private readonly adapter: NotebookAdapter,
    private readonly emit: (e: NotebookEvent) => void,
  ) {
    adapter.onSelectionChange(() => {
      const info = adapter.info();
      emit({ type: "selection_changed", activeCellId: info.activeCellId, selectedCellIds: info.selectedCellIds });
    });
  }

  async discardReviews(): Promise<void> {
    await Promise.allSettled([...this.reviews.values()].map(({ resolve }) => Promise.resolve(resolve(false))));
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
        const cells = a.getCells(op.summary ? { ...op, includeOutputs: false } : op).map((c) => (pending.has(c.id) ? { ...c, pendingReview: true } : c));
        // Summaries are cut here, in the page, so a big notebook's sources never cross the wire for an outline.
        return { cells: op.summary ? cells.map(summarizeCell) : cells };
      }
      case "update_cell": {
        this.assertNoReview(op.cellId);
        const [cell] = a.getCells({ cellIds: [op.cellId] });
        if (!cell) throw new OpError(`No cell with id "${op.cellId}".`);
        if (cell.source === op.source) return { applied: false };
        if (!op.review) {
          const applied = await a.setSource(op.cellId, op.source);
          if (applied && !op.byUser) this.journal({ kind: "update", cellId: cell.id, cellType: cell.type, index: cell.index, before: cell.source, after: op.source });
          return { applied };
        }
        const reviewId = this.open({ cellId: cell.id, kind: "update", cellType: cell.type, before: cell.source, after: op.source });
        return { applied: false, reviewId };
      }
      case "insert_cell": {
        const index = Math.max(0, Math.min(op.index, a.info().cellCount));
        if (!op.review) {
          const cellId = await a.insertCell(index, op.cellType, op.source);
          if (!op.byUser) this.journal({ kind: "insert", cellId, cellType: op.cellType, index, before: "", after: op.source });
          return { applied: true, cellId };
        }
        // Browser adapters use a cell to host the inline diff. An editor that
        // displays the diff elsewhere can reserve an ID without editing yet.
        const cellId = a.reserveCell?.(index, op.cellType) ?? await a.insertCell(index, op.cellType, "");
        const reviewId = this.open({ cellId, kind: "insert", cellType: op.cellType, before: "", after: op.source });
        return { applied: false, cellId, reviewId };
      }
      case "delete_cell": {
        this.assertNoReview(op.cellId);
        const [cell] = a.getCells({ cellIds: [op.cellId] });
        if (!cell) throw new OpError(`No cell with id "${op.cellId}".`);
        if (!op.review) {
          await a.deleteCell(op.cellId);
          if (!op.byUser) this.journal({ kind: "delete", cellId: cell.id, cellType: cell.type, index: cell.index, before: cell.source, after: "" });
          return { applied: true };
        }
        const reviewId = this.open({ cellId: cell.id, kind: "delete", cellType: cell.type, before: cell.source, after: "" });
        return { applied: false, reviewId };
      }
      case "move_cell": {
        const [cell] = a.getCells({ cellIds: [op.cellId] });
        const index = await a.moveCell(op.cellId, op.index);
        if (cell && index !== cell.index && !op.byUser) {
          this.journal({ kind: "move", cellId: cell.id, cellType: cell.type, index: cell.index, toIndex: index, before: "", after: "" });
        }
        return { index };
      }
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
      case "execute":
        return this.executions.wait(this.executions.add(await a.startExecution(op.code)), op.waitMs);
      case "execute_wait":
        return this.executions.wait(op.execId, op.waitMs);
      case "machine_exec":
        if (a.machineExec) {
          try {
            return await a.machineExec(op.code, op.waitMs);
          } catch (e) {
            if (!(e instanceof NoServerPython)) throw e;
          }
        }
        return this.executions.wait(this.executions.add(await a.startExecution(op.code)), op.waitMs);
      case "interrupt":
        return { interrupted: await a.interrupt() };
      case "focus_cell":
        return { focused: await a.focusCell(op.cellId) };
      case "resolve_review": {
        const r = this.reviews.get(op.reviewId);
        if (!r) return { resolved: false };
        await r.resolve(op.accept);
        return { resolved: true };
      }
    }
  }

  private assertNoReview(cellId: string) {
    if (this.pendingCellIds().has(cellId)) {
      throw new OpError(`Cell ${cellId} has a change awaiting the user's review. Wait for it (await_review) before changing the cell again.`);
    }
  }

  private journal(change: AppliedChange): void {
    this.emit({ type: "change_applied", change });
  }

  private open(partial: Omit<ReviewInfo, "reviewId">): string {
    const info: ReviewInfo = { ...partial, reviewId: `rv${Date.now().toString(36)}${(++reviewSeq).toString(36)}` };
    // Where the cell sits now, for putting a deleted cell back on undo.
    const index = this.adapter.getCells({ cellIds: [info.cellId] })[0]?.index ?? 0;
    const shown = this.adapter.showReview(info);
    this.reviews.set(info.reviewId, { info, resolve: shown.resolve });
    this.emit({ type: "review_opened", review: info });
    shown.decided.then(
      (accepted) => {
        this.reviews.delete(info.reviewId);
        if (accepted) {
          // The change is recorded before the review closes, so whoever waits on the review sees it.
          this.journal({ kind: info.kind, cellId: info.cellId, cellType: info.cellType, index: typeof accepted === "object" ? accepted.index : index, before: info.before, after: info.after, reviewId: info.reviewId });
        }
        this.emit({ type: "review_closed", reviewId: info.reviewId, accepted: !!accepted });
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
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.then((value) => ({ done: true as const, value })),
    new Promise<{ done: false }>((r) => { timer = setTimeout(() => r({ done: false }), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

export const KERNEL_BUSY = "The kernel is busy running a cell, so this would wait behind it. Wait for the cell (wait_for_cells) or stop it (interrupt_kernel), then try again.";

/** Text a stream may hold while collecting; past it the middle is dropped. */
const STREAM_MAX = 1_000_000;
const STREAM_HEAD = 200_000;

/**
 * Outputs of one `execute`, from raw nbformat-style output messages. Chunks of
 * a stream join into one output; a command that prints without end cannot
 * fill the page's memory.
 */
export class OutputCollector {
  private list: CellOutput[] = [];
  private clearOnNext = false;

  add(raw: unknown): void {
    const o = normalizeIpynbOutput(raw);
    if (!o) return;
    if (this.clearOnNext) {
      this.list = [];
      this.clearOnNext = false;
    }
    const last = this.list.at(-1);
    if (o.kind === "stream" && last?.kind === "stream" && last.name === o.name) {
      last.text = (last.text ?? "") + (o.text ?? "");
      if (last.text.length > STREAM_MAX) {
        const tail = last.text.slice(-(STREAM_MAX - STREAM_HEAD));
        const dropped = last.text.length - STREAM_HEAD - tail.length;
        last.text = `${last.text.slice(0, STREAM_HEAD)}\n… [${dropped} characters omitted] …\n${tail}`;
      }
      return;
    }
    this.list.push(o);
  }

  /** `wait`: clear when the next output arrives (clear_output(wait=True)). */
  clear(wait = false): void {
    if (wait) this.clearOnNext = true;
    else this.list = [];
  }

  get outputs(): CellOutput[] {
    return this.list;
  }
}

/** How long a finished execution nobody asked about is kept. */
const EXECUTION_KEEP_MS = 30 * 60_000;

let execSeq = 0;

/**
 * Executions by id, so code that outlasts one wait can be waited on again.
 * Nothing is interrupted: code runs until it ends, like a cell.
 */
export class Executions {
  private readonly runs = new Map<string, { settled: Promise<ExecResult>; collected: OutputCollector }>();

  add(e: Execution): string {
    const execId = `exec-${++execSeq}`;
    const settled = e.reply.then(
      (r) => finalResult(r?.status === "ok" || r?.status === undefined, r, undefined, e.collected),
      (err: Error) => finalResult(false, undefined, err, e.collected),
    );
    this.runs.set(execId, { settled, collected: e.collected });
    // Dropped some time after it ends, if nobody comes back for it.
    void settled.then(() => {
      if (!this.runs.has(execId)) return;
      const timer = setTimeout(() => this.runs.delete(execId), EXECUTION_KEEP_MS);
      (timer as unknown as { unref?(): void }).unref?.();
    });
    return execId;
  }

  async wait(execId: string, waitMs: number): Promise<ExecResult> {
    const run = this.runs.get(execId);
    if (!run) throw new OpError(`No execution "${execId}" here (the page reloaded, or its result was already collected).`);
    const r = await within(run.settled, waitMs);
    if (!r.done) return { status: "running", outputs: [...run.collected.outputs], execId };
    this.runs.delete(execId);
    return r.value;
  }
}

function finalResult(ok: boolean, rep: { status?: string; ename?: string; evalue?: string } | undefined, error: Error | undefined, collected: OutputCollector): ExecResult {
  const outputs = collected.outputs;
  if (ok) return { status: "ok", outputs };
  // The error output usually came over iopub; say what failed only when it did not.
  if (outputs.some((o) => o.kind === "error")) return { status: "error", outputs };
  const what = rep?.ename ? `${rep.ename}: ${rep.evalue ?? ""}` : rep?.status ? `execution ${rep.status}` : (error?.message ?? "execution failed");
  return { status: "error", outputs, message: what };
}
