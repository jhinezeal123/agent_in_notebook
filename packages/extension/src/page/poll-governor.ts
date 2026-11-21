// Adaptive polling for the page's OpRunner (A4.1). Pure logic: the runner and
// adapter are injected, so this is unit-testable without a notebook.
//
// Two forces set the pace:
//  - What a pulse costs lately (the runner's EMA): a big Colab notebook whose
//    getCells({}) serializes every output is polled slower, not faster.
//  - Idleness: no cell running, no agent op and no event for about 30 beats
//    lets the poll stretch to 3s. Any activity snaps back to the EMA base at
//    once — the runner also ticks right after run_cells, so events are not late.

/** EMA thresholds (ms) and the poll each one asks for. */
const BASE_MS = 1000;
const SLOW_MS = 2000;
const SLOWER_MS = 3000;
/** How often the pace is reconsidered. */
const GOVERN_MS = 30_000;
/** About this many quiet beats before the idle stretch. */
const IDLE_BEATS = 30;

export interface PollGovernorDeps {
  /** The runner's pulseMs EMA. */
  pulseMs(): number;
  setPollMs(ms: number): void;
  /** A cell is running, the kernel is busy, or an agent op is in flight. */
  busy(): boolean;
  /** Debug line, about every 30 beats, when measurement is on. */
  log?(line: string): void;
  now?(): number;
}

export class PollGovernor {
  /** Set from the `ainbMeasure` flag (chrome.storage.local, forwarded by the content script). */
  measure = false;
  private timer: ReturnType<typeof setInterval>;
  private current = BASE_MS;
  private lastActivity: number;
  private idleMs = 0;
  private beatDebt = 0;

  constructor(private readonly deps: PollGovernorDeps) {
    this.lastActivity = this.now();
    this.timer = setInterval(() => this.tick(), GOVERN_MS);
    (this.timer as unknown as { unref?(): void }).unref?.();
  }

  /** An op arrived or an event fired: the notebook is being used. */
  markActivity(): void {
    this.lastActivity = this.now();
    this.idleMs = 0;
    // Leave the idle stretch at once, without waiting for the next check.
    this.apply(this.base());
  }

  /** One 30s check of cost and idleness. */
  tick(): void {
    const now = this.now();
    let busy = false;
    try {
      busy = this.deps.busy();
    } catch {
      // The notebook may be reloading; treat it as quiet.
    }
    const idle = !busy && now - this.lastActivity >= GOVERN_MS;
    this.idleMs = idle ? this.idleMs + GOVERN_MS : 0;
    const base = this.base();
    // ~30 quiet beats at the current base before stretching to 3s.
    this.apply(this.idleMs >= IDLE_BEATS * base ? Math.max(base, SLOWER_MS) : base);

    // Debug: about every 30 beats. Beats are counted from the pace (the timer
    // itself is the runner's); a hidden tab's throttled timer only makes this
    // estimate optimistic, which is fine for a DevTools measurement.
    this.beatDebt += GOVERN_MS / this.current;
    if (this.measure && this.beatDebt >= IDLE_BEATS) {
      this.beatDebt = 0;
      this.deps.log?.(`[ainb] pulse EMA ${this.deps.pulseMs().toFixed(1)}ms, poll ${this.current}ms, idle ${Math.round(this.idleMs / 1000)}s${busy ? ", busy" : ""}`);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private base(): number {
    const ema = this.deps.pulseMs();
    return ema > 50 ? SLOWER_MS : ema > 20 ? SLOW_MS : BASE_MS;
  }

  private apply(ms: number): void {
    if (ms === this.current) return;
    this.current = ms;
    this.deps.setPollMs(ms);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
