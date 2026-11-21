// Pure event-replay logic shared by the content script and the service worker
// (A6.1). No chrome APIs here: the ring buffer and the per-tab ordering gate are
// plain classes so they can be unit-tested without a browser.
//
// The MV3 service worker sleeps and restarts; while it is gone the content
// script's sendMessage fails and events used to be lost. Now every event gets a
// per-content-script sequence number and rides in a ring buffer; the worker
// tracks the last sequence it delivered to the bridge (acked) and asks for the
// missing part after its next hello. Replays are idempotent: anything at or
// below the watermark, or already waiting, is dropped.

import type { NotebookEvent } from "@ainb/protocol";

export interface SequencedEvent {
  seq: number;
  event: NotebookEvent;
}

/** The last `capacity` events of one content script, numbered from 1. */
export class EventRing {
  private buf: SequencedEvent[] = [];
  private next = 1;

  constructor(private readonly capacity = 128) {}

  /** Highest sequence handed out so far (0 before the first event). */
  get lastSeq(): number {
    return this.next - 1;
  }

  push(event: NotebookEvent): number {
    const seq = this.next++;
    this.buf.push({ seq, event });
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    return seq;
  }

  /** Buffered events with seq >= fromSeq, in order. */
  since(fromSeq: number): SequencedEvent[] {
    return this.buf.filter((e) => e.seq >= fromSeq);
  }
}

export interface TabGateDeps {
  /** Deliver one event to the bridge; only called while connected. */
  emit: (event: NotebookEvent) => void;
  /** Ask the content script to replay from this sequence (inclusive). */
  requestReplay: (fromSeq: number) => void;
  /** The delivery watermark moved; the caller persists it (throttled). */
  onAck?: (acked: number) => void;
  now?: () => number;
}

/** How often a stalled gap may be asked for again. */
const REPLAY_RETRY_MS = 2_000;
/** A gap still open this long after (re)connecting fell out of the ring: skip it. */
const STALL_GIVE_UP_MS = 10_000;
/** Most events kept for a bridge that is down; the oldest go first, as before. */
const MAX_PENDING = 1024;

/**
 * One tab's events, in sequence order, exactly once. Everything received but
 * not yet delivered waits in `pending`; a contiguous run from acked+1 is
 * delivered while connected, and held (in order) while not. A gap — events the
 * worker missed while it slept — is filled by replay; one that can no longer be
 * filled (older than the ring) is skipped rather than block the tab forever.
 */
export class TabEventGate {
  /** Highest sequence delivered to the bridge. */
  acked: number;
  /** The content script instance these sequences belong to. */
  bootId: string;
  frameId: number;
  private connected = false;
  private pending = new Map<number, NotebookEvent>();
  private stallSince: number | null = null;
  private replayAskedAt = -Infinity;

  constructor(private readonly deps: TabGateDeps, init: { acked?: number; bootId?: string; frameId?: number } = {}) {
    this.acked = init.acked ?? 0;
    this.bootId = init.bootId ?? "";
    this.frameId = init.frameId ?? 0;
  }

  /** First sequence not delivered yet: what a replay should start from. */
  get firstMissing(): number {
    return this.acked + 1;
  }

  get waiting(): number {
    return this.pending.size;
  }

  setConnected(on: boolean): void {
    this.connected = on;
    if (!on) return;
    // A fresh window for the gap: one that waited while the bridge was down
    // must not be given up on before the first replay after hello can answer.
    this.stallSince = this.pending.size ? this.now() : null;
    this.drain();
    if (this.pending.size) this.askReplay(true);
  }

  /** One event arrived (real-time or replayed). */
  ingest(seq: number, event: NotebookEvent, bootId: string): void {
    // A new content script (the tab reloaded): its sequences start over, and
    // the old document's events are not this notebook's any more.
    if (bootId !== this.bootId) this.reset(bootId);
    if (!Number.isInteger(seq) || seq <= this.acked) return; // already delivered
    this.pending.set(seq, event); // same seq twice: the same event, kept once
    if (this.pending.size > MAX_PENDING) {
      const oldest = [...this.pending.keys()].sort((a, b) => a - b).slice(0, this.pending.size - MAX_PENDING);
      for (const k of oldest) this.pending.delete(k);
      // What was dropped is older than the content ring could ever replay:
      // move the watermark past it so the rest stays deliverable. Those
      // events are lost — as they were before this buffer existed.
      const last = oldest[oldest.length - 1]!;
      if (last > this.acked) {
        this.acked = last;
        this.deps.onAck?.(last);
      }
    }
    this.drain();
  }

  /** Ask for the missing part now (throttled unless forced). */
  askReplay(force: boolean): void {
    const now = this.now();
    if (!force && now - this.replayAskedAt < REPLAY_RETRY_MS) return;
    this.replayAskedAt = now;
    this.deps.requestReplay(this.firstMissing);
  }

  /** Periodic: retry a stalled replay, and give up on gaps older than the ring. */
  tick(): void {
    if (!this.pending.size) return;
    const now = this.now();
    if (this.connected && this.stallSince !== null && now - this.stallSince >= STALL_GIVE_UP_MS) {
      // Deliver what is held, in order; the missing sequences are gone for good.
      for (const seq of [...this.pending.keys()].sort((a, b) => a - b)) {
        const event = this.pending.get(seq)!;
        this.pending.delete(seq);
        this.deliver(seq, event);
      }
      this.stallSince = null;
      return;
    }
    if (this.hasGap()) this.askReplay(false);
  }

  /** Start over for a new content script instance. */
  reset(bootId: string): void {
    this.bootId = bootId;
    this.acked = 0;
    this.pending.clear();
    this.stallSince = null;
    this.replayAskedAt = -Infinity;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private deliver(seq: number, event: NotebookEvent): void {
    this.deps.emit(event);
    this.acked = seq;
    this.deps.onAck?.(seq);
  }

  private drain(): void {
    if (this.connected) {
      while (this.pending.has(this.acked + 1)) {
        const seq = this.acked + 1;
        const event = this.pending.get(seq)!;
        this.pending.delete(seq);
        this.deliver(seq, event);
      }
    }
    if (this.hasGap()) {
      this.stallSince ??= this.now();
      this.askReplay(false);
    } else {
      this.stallSince = null;
    }
  }

  /** Something is waiting, but not the next sequence: a replay must fill it. */
  private hasGap(): boolean {
    if (!this.pending.size) return false;
    let min = Infinity;
    for (const k of this.pending.keys()) if (k < min) min = k;
    return min > this.acked + 1;
  }
}
