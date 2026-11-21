// The contract for notebook editors and the shared runner for their operations.

import {
  summarizeCell,
  type AppliedChange,
  type CellInfo,
  type CellOutput,
  type CellRunState,
  type CellType,
  type ExecResult,
  type KernelState,
  type NotebookEvent,
  type NotebookInfo,
  type NotebookOp,
  type ReviewInfo,
  type RunResult,
} from "./notebook.js";
import { normalizeIpynbOutput, OutputFingerprints } from "./outputs.js";
import { RunWatcher } from "./run-watcher.js";
import { firstLine, textHash } from "./text.js";

export interface NotebookAdapter {
  readonly platform: NotebookInfo["platform"];
  info(): NotebookInfo;
  getCells(opts: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[];
  /** Run state of every code cell, cheaper than getCells. Without it the watcher uses getCells({}). */
  runStates?(): CellRunState[];
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
  /** Release what the adapter holds outside the notebook (timers, listeners) when the runner goes away. */
  dispose?(): void;
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

const RUN_POLL_MS = 1000;

/**
 * Runs NotebookOps against an adapter and owns the pending reviews. Every
 * change it applies for the agent is reported as `change_applied`, with what
 * the cell held before, so the user can undo it later.
 */
export class OpRunner {
  private reviews = new Map<string, { info: ReviewInfo; resolve(accept: boolean): void | Promise<void> }>();
  private readonly fingerprints = new OutputFingerprints();
  private readonly executions = new Executions();
  readonly watcher: RunWatcher;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKernel: KernelState | undefined;

  constructor(
    private readonly adapter: NotebookAdapter,
    private readonly emit: (e: NotebookEvent) => void,
    opts: { pollMs?: number | null } = {},
  ) {
    this.watcher = new RunWatcher({
      states: () => adapter.runStates?.() ?? adapter.getCells({}).filter((c) => c.type === "code")
        .map((c) => ({ cellId: c.id, running: !!c.running, executionCount: c.executionCount ?? null })),
      cell: (id) => adapter.getCells({ cellIds: [id], includeOutputs: true })[0],
      // Hashing a source must not convert every output (images) of a big notebook.
      source: (id) => adapter.getCells({ cellIds: [id] })[0]?.source,
      emit: (run) => this.emit({ type: "cell_run", run }),
    });
    // Prime before the first op so even a fast first run can be reported.
    this.watcher.tick();
    this.checkKernel(this.readInfo());
    this.setPollMs(opts.pollMs === undefined ? RUN_POLL_MS : opts.pollMs);
    adapter.onSelectionChange(() => {
      // A real event, not a poll: it reads info on its own.
      const info = adapter.info();
      emit({ type: "selection_changed", activeCellId: info.activeCellId, selectedCellIds: info.selectedCellIds });
    });
  }

  /** One timer beat: the watcher, then one info() shared with the kernel check. */
  private pulse(): void {
    const t0 = Date.now();
    this.watcher.tick();
    this.checkKernel(this.readInfo());
    const dt = Date.now() - t0;
    this.pulseEma = this.pulseEma ? this.pulseEma * 0.8 + dt * 0.2 : dt;
  }

  /** A beat right now: an editor signal (kernel, cells, outputs) says something changed. */
  pulseNow(): void {
    this.pulse();
  }

  private pulseEma = 0;

  /** What a pulse costs lately (EMA, ms): a page adapts its poll to the notebook's size with this. */
  get pulseMs(): number {
    return this.pulseEma;
  }

  /** The poll interval; null stops the timer (tests). A measuring page calls this to slow down or speed up. */
  setPollMs(ms: number | null): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (ms !== null) {
      this.timer = setInterval(() => this.pulse(), ms);
      (this.timer as unknown as { unref?(): void }).unref?.();
    }
  }

  private readInfo(): NotebookInfo | undefined {
    try {
      return this.adapter.info();
    } catch {
      // The notebook may be reloading; keep the previous kernel state.
      return undefined;
    }
  }

  private checkKernel(info: NotebookInfo | undefined): void {
    if (!info) return;
    const kernel = info.kernel;
    const prev = this.lastKernel;
    if (prev === undefined) {
      this.lastKernel = kernel;
      return;
    }
    if (kernel !== prev) {
      // Reconnected: the counts and hashes the watcher primed with describe the old
      // kernel's runs, so prime again from what is there now (without emitting).
      if ((prev === "disconnected" || prev === "unknown") && (kernel === "idle" || kernel === "busy")) this.watcher.reprime();
      this.emit({ type: "kernel_changed", kernel });
    }
    this.lastKernel = kernel;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.adapter.dispose?.();
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
        const read = op.summary ? { ...op, includeOutputs: false } : op.outputsHash ? { ...op, includeOutputs: true } : op;
        const budget = imageBudget(op.maxImages, op.maxImageBytes);
        const cells = a.getCells(read).map((c) => {
          let out = c;
          if (op.outputsHash && !op.summary) {
            // Hashed in the page: only the fingerprint crosses the wire, unless the outputs were asked for too.
            const { outputs, ...rest } = c;
            const hashed = c.type === "code" ? { ...rest, outputsHash: this.fingerprints.read(c.id, outputs ?? []) } : rest;
            out = op.includeOutputs ? { ...hashed, outputs } : hashed;
          }
          // The budget trims what rides along, never the fingerprint above: that describes the real outputs.
          if (budget && out.outputs) out = { ...out, outputs: budget.filter(out.outputs) };
          if (op.sourceHash) {
            // Hash the full source here, then cut it: only the digest crosses the wire.
            out = { ...out, source: "", sourceHash: textHash(c.source), lineCount: c.source ? c.source.split("\n").length : 0 };
          }
          return out;
        }).map((c) => {
          // Stale compares with the hash of the source the cell ran; a sourceHash read already cut the source.
          const stale = c.type === "code" && (op.sourceHash
            ? this.watcher.isStaleHash(c.id, c.sourceHash!)
            : this.watcher.isStale(c.id, c.source));
          const withRunState = stale ? { ...c, stale: true } : c;
          return pending.has(c.id) ? { ...withRunState, pendingReview: true } : withRunState;
        });
        if (op.outputsHash && !op.cellIds && op.start === undefined && op.end === undefined) {
          this.fingerprints.retain(new Set(cells.filter((c) => c.type === "code").map((c) => c.id)));
        }
        // Summaries are cut here, in the page, so a big notebook's sources never cross the wire for an outline.
        // sourceHash already cut the source, and wins over summary when both are set.
        return { cells: op.summary && !op.sourceHash ? cells.map(summarizeCell) : cells };
      }
      case "update_cell": {
        this.assertNoReview(op.cellId);
        const [cell] = a.getCells({ cellIds: [op.cellId] });
        if (!cell) throw new OpError(`No cell with id "${op.cellId}".`);
        // Compare-and-set: the caller edits from a known version; if the cell moved on,
        // nothing is applied, journaled or reviewed — the caller re-reads and decides.
        if (op.expectedSource !== undefined && cell.source !== op.expectedSource) return { applied: false, conflict: true };
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
      case "apply_cells": {
        if (!Array.isArray(op.steps)) throw new OpError("apply_cells needs a steps array of cell changes.");
        const mutating = new Set(["update_cell", "insert_cell", "delete_cell", "move_cell"]);
        for (const step of op.steps) {
          if (!mutating.has((step as { op?: string } | null)?.op ?? "")) {
            throw new OpError(`apply_cells steps must be update_cell, insert_cell, delete_cell or move_cell; got "${String((step as { op?: unknown } | null)?.op)}".`);
          }
        }
        // Each step runs exactly as if it were sent alone: review, journal and events keep their order.
        const results: unknown[] = [];
        for (const step of op.steps) results.push(await this.run(step));
        return { results };
      }
      case "run_cells": {
        const deadline = Date.now() + op.timeoutMs;
        const budget = imageBudget(op.maxImages, op.maxImageBytes);
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
          this.watcher.agentRuns.add(id);
          this.watcher.agentStarted(id);
          let r: RunResult;
          try {
            r = await a.runCell(id, left);
          } catch (e) {
            this.watcher.agentRuns.delete(id);
            throw e;
          }
          if (r.status === "skipped") this.watcher.agentRuns.delete(id);
          else if (r.status !== "timeout") this.watcher.tick();
          results.push(r);
          if (r.status === "timeout") stop = true;
          if (r.status === "error" && op.stopOnError) stop = true;
        }
        // One budget across all results, in cell order.
        if (budget) return { results: results.map((r) => ({ ...r, outputs: budget.filter(r.outputs) })) };
        return { results };
      }
      case "execute":
        return this.executions.wait(this.executions.add(await a.startExecution(op.code)), op.waitMs);
      case "execute_wait":
        return this.executions.wait(op.execId, op.waitMs, op.since);
      case "get_output_image": {
        const [cell] = a.getCells({ cellIds: [op.cellId], includeOutputs: true });
        if (!cell) throw new OpError(`No cell with id "${op.cellId}".`);
        return { image: cell.outputs?.[op.outputIndex]?.image };
      }
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
    // Where the cell sits now, for putting a deleted cell back on undo.
    const index = this.adapter.getCells({ cellIds: [partial.cellId] })[0]?.index ?? 0;
    const info: ReviewInfo = {
      ...partial,
      reviewId: `rv${Date.now().toString(36)}${(++reviewSeq).toString(36)}`,
      index,
      label: firstLine(partial.after || partial.before, 60),
    };
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

/** A budget only when one was asked for; absent flags keep every image, as before. */
function imageBudget(maxImages?: number, maxImageBytes?: number): ImageBudget | null {
  return maxImages === undefined && maxImageBytes === undefined ? null : new ImageBudget(maxImages, maxImageBytes);
}

/**
 * One image budget shared by every output of one op call: the first images
 * that fit both limits keep their data; the rest lose it but keep their mime
 * in `mimes`, so the agent knows an image is there and can fetch it for real
 * with get_output_image. Bytes are counted as base64 length.
 */
class ImageBudget {
  private kept = 0;
  private bytes = 0;
  constructor(private readonly maxImages?: number, private readonly maxBytes?: number) {}

  filter(outputs: CellOutput[]): CellOutput[] {
    return outputs.map((o) => {
      if (!o.image) return o;
      const size = o.image.data.length;
      const overCount = this.maxImages !== undefined && this.kept >= this.maxImages;
      const overBytes = this.maxBytes !== undefined && this.bytes + size > this.maxBytes;
      if (overCount || overBytes) {
        const { image, ...rest } = o;
        const mimes = [...(rest.mimes ?? [])];
        if (!mimes.includes(image.mime)) mimes.push(image.mime);
        return { ...rest, mimes };
      }
      this.kept++;
      this.bytes += size;
      return o;
    });
  }
}

export const KERNEL_BUSY = "The kernel is busy running a cell, so this would wait behind it. Wait for the cell (wait_for_cells) or stop it (interrupt_kernel), then try again.";

/** Text a stream may hold while collecting; past it the middle is dropped. */
const STREAM_MAX = 1_000_000;
const STREAM_HEAD = 200_000;

/**
 * Outputs of one `execute`, from raw nbformat-style output messages. Chunks of
 * a stream join into one output; a command that prints without end cannot
 * fill the page's memory. `gen` grows whenever the list stops being
 * append-only (a clear, or a stream cut mid-way), so a waiting client knows
 * when its copy can no longer be extended with a delta.
 */
export class OutputCollector {
  private list: CellOutput[] = [];
  private clearOnNext = false;
  private generation = 0;

  add(raw: unknown): void {
    const o = normalizeIpynbOutput(raw);
    if (!o) return;
    if (this.clearOnNext) {
      this.list = [];
      this.clearOnNext = false;
      this.generation++;
    }
    const last = this.list.at(-1);
    if (o.kind === "stream" && last?.kind === "stream" && last.name === o.name) {
      last.text = (last.text ?? "") + (o.text ?? "");
      if (last.text.length > STREAM_MAX) {
        const tail = last.text.slice(-(STREAM_MAX - STREAM_HEAD));
        const dropped = last.text.length - STREAM_HEAD - tail.length;
        last.text = `${last.text.slice(0, STREAM_HEAD)}\n… [${dropped} characters omitted] …\n${tail}`;
        // The middle was dropped: what a client holds is no longer a prefix.
        this.generation++;
      }
      return;
    }
    this.list.push(o);
  }

  /** `wait`: clear when the next output arrives (clear_output(wait=True)). */
  clear(wait = false): void {
    if (wait) this.clearOnNext = true;
    else {
      this.list = [];
      this.generation++;
    }
  }

  get outputs(): CellOutput[] {
    return this.list;
  }

  get gen(): number {
    return this.generation;
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

  async wait(execId: string, waitMs: number, since?: { gen: number; n: number; chars: number }): Promise<ExecResult> {
    const run = this.runs.get(execId);
    if (!run) throw new OpError(`No execution "${execId}" here (the page reloaded, or its result was already collected).`);
    const r = await within(run.settled, waitMs);
    if (!r.done) {
      const gen = run.collected.gen;
      const outputs = run.collected.outputs;
      // A matching generation means the client's copy is still a prefix of the list: send only what is new.
      if (since && since.gen === gen) {
        const last = outputs[since.n - 1];
        const tail = last?.kind === "stream" ? (last.text ?? "").slice(since.chars) : "";
        // Not a stream (or nothing held yet): the client's last output is replaced whole, from n-1.
        const rest = outputs.slice(last?.kind === "stream" ? since.n : Math.max(0, since.n - 1));
        return { status: "running", outputs: [], execId, gen, delta: { n: since.n, chars: since.chars, tail, rest } };
      }
      return { status: "running", outputs: [...outputs], execId, gen };
    }
    this.runs.delete(execId);
    return r.value;
  }
}

function finalResult(ok: boolean, rep: { status?: string; ename?: string; evalue?: string } | undefined, error: Error | undefined, collected: OutputCollector): ExecResult {
  const outputs = collected.outputs;
  const gen = collected.gen;
  if (ok) return { status: "ok", outputs, gen };
  // The error output usually came over iopub; say what failed only when it did not.
  if (outputs.some((o) => o.kind === "error")) return { status: "error", outputs, gen };
  const what = rep?.ename ? `${rep.ename}: ${rep.evalue ?? ""}` : rep?.status ? `execution ${rep.status}` : (error?.message ?? "execution failed");
  return { status: "error", outputs, message: what, gen };
}
