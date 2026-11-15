// Watches only the run state the editors already expose, so every adapter shares it.
// A fast run can be missed after a kernel restart if it reuses the old execution count,
// or when a cell is created and finishes within one tick. Chrome may throttle a hidden
// tab's timer to about once a minute: those events arrive late, not in a different order.

import { capText, firstLine, textHash } from "./text.js";
import type { CellInfo, CellRun, CellRunState } from "./notebook.js";

export interface RunWatcherDeps {
  states(): CellRunState[];
  /** The cell with its outputs, to tell how the run ended; undefined when it is gone. */
  cell(cellId: string): CellInfo | undefined;
  /** The cell's source alone (no outputs), read whenever a run starts; falls back to `cell`. */
  source?(cellId: string): string | undefined;
  emit(run: CellRun): void;
  now?(): number;
}

interface KnownRun {
  running: boolean;
  count: number | null;
  startedAt?: number;
  /** Source when this run started, so edits during it stay marked stale. */
  sourceHash?: string;
  /** Last source seen before this run, including a fast run never seen running. */
  lastSourceHash?: string;
}

export class RunWatcher {
  /** Cells a run_cells op started and whose end was not reported yet. */
  readonly agentRuns = new Set<string>();
  private known = new Map<string, KnownRun>();
  private ranHash = new Map<string, string>();
  private primed = false;

  constructor(private readonly deps: RunWatcherDeps) {}

  tick(): void {
    let states: CellRunState[];
    try {
      states = this.deps.states();
    } catch {
      // A notebook reload is temporary; keep the old states for the next tick.
      return;
    }
    const now = this.deps.now?.() ?? Date.now();
    if (!this.primed) {
      for (const s of states) this.known.set(s.cellId, this.initial(s, now));
      this.primed = true;
      return;
    }

    for (const s of states) {
      const prev = this.known.get(s.cellId);
      if (!prev) {
        this.known.set(s.cellId, this.initial(s, now));
        continue;
      }
      if (s.running && !prev.running) {
        prev.startedAt = now;
        prev.sourceHash = this.sourceHash(s.cellId);
        prev.lastSourceHash = prev.sourceHash;
      }
      const finished = (prev.running && !s.running)
        || (!prev.running && !s.running && s.executionCount !== null && s.executionCount !== prev.count);
      if (finished) {
        this.finished(s, prev, now);
        prev.startedAt = undefined;
        prev.sourceHash = undefined;
      }
      prev.running = s.running;
      prev.count = s.executionCount;
    }

    const alive = new Set(states.map((s) => s.cellId));
    for (const id of this.known.keys()) {
      if (alive.has(id)) continue;
      this.known.delete(id);
      this.ranHash.delete(id);
      this.agentRuns.delete(id);
    }
  }

  private initial(s: CellRunState, now: number): KnownRun {
    const sourceHash = this.sourceHash(s.cellId);
    return {
      running: s.running,
      count: s.executionCount,
      startedAt: s.running ? now : undefined,
      sourceHash: s.running ? sourceHash : undefined,
      lastSourceHash: sourceHash,
    };
  }

  isStale(cellId: string, source: string): boolean {
    return this.ranHash.has(cellId) && this.ranHash.get(cellId) !== textHash(source);
  }

  /** Capture an op's source before runCell can let the user edit it. */
  agentStarted(cellId: string): void {
    const known = this.known.get(cellId);
    if (known && !known.running) {
      known.sourceHash = this.sourceHash(cellId);
      known.lastSourceHash = known.sourceHash;
    }
  }

  private sourceHash(cellId: string): string | undefined {
    try {
      const source = this.deps.source ? this.deps.source(cellId) : this.deps.cell(cellId)?.source;
      return source === undefined ? undefined : textHash(source);
    } catch {
      return undefined;
    }
  }

  private finished(s: CellRunState, prev: KnownRun, now: number): void {
    let c: CellInfo | undefined;
    try {
      c = this.deps.cell(s.cellId);
    } catch {
      // Outputs are best-effort: a reload after the state read must not fail the completed op.
    }
    if (!c) {
      this.agentRuns.delete(s.cellId);
      return;
    }
    const error = c.outputs?.filter((o) => o.kind === "error").at(-1);
    const status = error?.ename === "KeyboardInterrupt" ? "interrupted" : error ? "error" : "ok";
    const by = this.agentRuns.has(s.cellId) ? "agent" : "user";
    this.agentRuns.delete(s.cellId);
    this.ranHash.set(s.cellId, prev.sourceHash ?? prev.lastSourceHash ?? textHash(c.source));
    prev.lastSourceHash = this.ranHash.get(s.cellId);
    this.deps.emit({
      cellId: s.cellId,
      index: c.index,
      status,
      executionCount: s.executionCount,
      by,
      durationMs: prev.startedAt !== undefined ? now - prev.startedAt : s.lastDurationMs,
      head: firstLine(c.source, 120),
      ...(error ? { ename: error.ename, evalue: error.evalue === undefined ? undefined : capText(error.evalue, 300) } : {}),
    });
  }
}
