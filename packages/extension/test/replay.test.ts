// Pure replay logic (A6.1): the content script's ring buffer and the worker's
// per-tab ordering gate, without any chrome API.

import { describe, expect, it } from "vitest";
import type { NotebookEvent } from "@ainb/protocol";
import { EventRing, TabEventGate } from "../src/shared/replay.js";

/** An event distinguishable by its sequence-shaped payload. */
const ev = (n: number): NotebookEvent => ({ type: "selection_changed", activeCellId: `c${n}`, selectedCellIds: [] });
const ids = (events: NotebookEvent[]) => events.map((e) => (e.type === "selection_changed" ? e.activeCellId : "?"));

describe("EventRing", () => {
  it("numbers events from 1 and hands back the buffered part in order", () => {
    const ring = new EventRing(128);
    expect(ring.lastSeq).toBe(0);
    expect(ring.push(ev(1))).toBe(1);
    expect(ring.push(ev(2))).toBe(2);
    expect(ring.push(ev(3))).toBe(3);
    expect(ring.lastSeq).toBe(3);
    expect(ring.since(1).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ring.since(2).map((e) => e.seq)).toEqual([2, 3]);
    expect(ring.since(4)).toEqual([]);
  });

  it("keeps only the last 128 events, but the sequence keeps growing", () => {
    const ring = new EventRing();
    for (let i = 1; i <= 130; i++) ring.push(ev(i));
    expect(ring.lastSeq).toBe(130);
    const all = ring.since(1);
    expect(all).toHaveLength(128);
    expect(all[0]!.seq).toBe(3);
    expect(all.at(-1)!.seq).toBe(130);
    expect(ring.since(129).map((e) => e.seq)).toEqual([129, 130]);
  });

  it("honours a smaller capacity", () => {
    const ring = new EventRing(2);
    ring.push(ev(1));
    ring.push(ev(2));
    ring.push(ev(3));
    expect(ring.since(1).map((e) => e.seq)).toEqual([2, 3]);
  });
});

function harness(init: { acked?: number; bootId?: string } = {}) {
  let clock = 0;
  const emitted: NotebookEvent[] = [];
  const replays: number[] = [];
  const acks: number[] = [];
  const gate = new TabEventGate({
    emit: (e) => emitted.push(e),
    requestReplay: (fromSeq) => replays.push(fromSeq),
    onAck: (seq) => acks.push(seq),
    now: () => clock,
  }, { bootId: "boot-a", ...init });
  return {
    gate, emitted, replays, acks,
    setClock: (ms: number) => { clock = ms; },
    ingest: (seq: number, bootId = "boot-a") => gate.ingest(seq, ev(seq), bootId),
  };
}

describe("TabEventGate", () => {
  it("delivers in order while connected and acks each sequence", () => {
    const h = harness();
    h.gate.setConnected(true);
    h.ingest(1);
    h.ingest(2);
    expect(ids(h.emitted)).toEqual(["c1", "c2"]);
    expect(h.gate.acked).toBe(2);
    expect(h.acks).toEqual([1, 2]);
    expect(h.gate.waiting).toBe(0);
  });

  it("drops replays at or below the watermark, and duplicates already waiting", () => {
    const h = harness();
    h.gate.setConnected(true);
    h.ingest(1);
    h.ingest(2);
    h.ingest(1); // replayed again
    h.ingest(2);
    expect(ids(h.emitted)).toEqual(["c1", "c2"]);
    // A gap holds 3; a replay carrying 2 and 3 twice delivers 3 once.
    h.ingest(4);
    h.gate.ingest(3, ev(3), "boot-a");
    h.gate.ingest(3, ev(3), "boot-a");
    expect(ids(h.emitted)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("queues in order while the bridge is down and flushes after hello", () => {
    const h = harness();
    h.ingest(1);
    h.ingest(2);
    h.ingest(3);
    expect(h.emitted).toEqual([]);
    expect(h.gate.waiting).toBe(3);
    expect(h.replays).toEqual([]); // contiguous: nothing missing to ask for
    h.gate.setConnected(true);
    expect(ids(h.emitted)).toEqual(["c1", "c2", "c3"]);
    expect(h.gate.acked).toBe(3);
  });

  it("holds out-of-order events until a replay fills the gap, then delivers in order", () => {
    const h = harness();
    h.gate.setConnected(true);
    h.ingest(3);
    expect(h.emitted).toEqual([]);
    expect(h.replays).toEqual([1]); // ask from the first missing
    h.ingest(1);
    expect(ids(h.emitted)).toEqual(["c1"]);
    // The replay answer: 2 and 3 (3 already held — kept once).
    h.gate.ingest(2, ev(2), "boot-a");
    h.gate.ingest(3, ev(3), "boot-a");
    expect(ids(h.emitted)).toEqual(["c1", "c2", "c3"]);
    expect(h.gate.acked).toBe(3);
  });

  it("fills a gap even while disconnected, and flushes everything in order", () => {
    const h = harness();
    h.ingest(2);
    h.ingest(3);
    expect(h.replays).toEqual([1]);
    h.ingest(1);
    expect(h.emitted).toEqual([]);
    h.gate.setConnected(true);
    expect(ids(h.emitted)).toEqual(["c1", "c2", "c3"]);
  });

  it("starts over when the content script restarts (new bootId)", () => {
    const h = harness({ acked: 5 });
    h.gate.setConnected(true);
    h.ingest(1, "boot-b");
    expect(h.gate.acked).toBe(1);
    expect(h.gate.bootId).toBe("boot-b");
    expect(ids(h.emitted)).toEqual(["c1"]);
    // The old instance's sequences mean nothing now.
    h.ingest(6, "boot-b");
    expect(h.gate.waiting).toBe(1); // held: 2..5 of the new instance are missing
  });

  it("restores the watermark from the session cache after a worker restart", () => {
    const h = harness({ acked: 7 });
    h.gate.setConnected(true);
    h.ingest(8);
    h.ingest(7); // replayed overlap
    expect(ids(h.emitted)).toEqual(["c8"]);
    expect(h.gate.acked).toBe(8);
  });

  it("retries a stalled replay, then skips a gap older than the ring", () => {
    const h = harness();
    h.gate.setConnected(true);
    h.setClock(1000);
    h.ingest(5); // 1..4 fell out of the content ring while the worker slept
    expect(h.replays).toEqual([1]);
    h.setClock(3500);
    h.gate.tick();
    expect(h.replays).toEqual([1, 1]); // retried after the throttle window
    h.setClock(5000);
    h.gate.tick();
    expect(h.replays).toHaveLength(2); // throttled again
    expect(h.emitted).toEqual([]); // not given up yet
    h.setClock(12_000);
    h.gate.tick();
    expect(ids(h.emitted)).toEqual(["c5"]);
    expect(h.gate.acked).toBe(5);
    expect(h.gate.waiting).toBe(0);
    // Later events flow normally again.
    h.ingest(6);
    expect(ids(h.emitted)).toEqual(["c5", "c6"]);
  });

  it("gives a reconnecting gap a fresh window before skipping it", () => {
    const h = harness();
    h.setClock(0);
    h.ingest(5); // gap while the bridge is down
    h.setClock(60_000);
    h.gate.setConnected(true); // hello: the replay gets a fresh chance
    h.gate.tick();
    expect(h.emitted).toEqual([]); // not skipped on the first tick after hello
    h.ingest(1);
    h.ingest(2);
    h.ingest(3);
    h.ingest(4);
    expect(ids(h.emitted)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("bounds what waits for a bridge that stays down", () => {
    const h = harness();
    for (let i = 1; i <= 1100; i++) h.ingest(i);
    expect(h.gate.waiting).toBeLessThanOrEqual(1024);
    h.gate.setConnected(true);
    // The oldest were dropped, the newest all arrive, in order.
    expect(ids(h.emitted).at(-1)).toBe("c1100");
    const seqs = h.emitted.map((e) => Number((e as { activeCellId: string }).activeCellId.slice(1)));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("keeps two tabs independent", () => {
    const a = harness();
    const b = harness();
    a.gate.setConnected(true);
    b.gate.setConnected(true);
    a.ingest(1);
    b.ingest(1);
    a.ingest(2);
    expect(ids(a.emitted)).toEqual(["c1", "c2"]);
    expect(ids(b.emitted)).toEqual(["c1"]);
    expect(a.gate.acked).toBe(2);
    expect(b.gate.acked).toBe(1);
  });
});
