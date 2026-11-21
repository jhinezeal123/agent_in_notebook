// The adaptive poll pace (A4.1): EMA cost base, idle stretch, activity snap-back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollGovernor } from "../src/page/poll-governor.js";

function harness() {
  let clock = 0;
  let ema = 0;
  let busy = false;
  const polls: number[] = [];
  const logs: string[] = [];
  const governor = new PollGovernor({
    pulseMs: () => ema,
    setPollMs: (ms) => polls.push(ms),
    busy: () => busy,
    log: (line) => logs.push(line),
    now: () => clock,
  });
  return {
    governor, polls, logs,
    setEma: (ms: number) => { ema = ms; },
    setBusy: (b: boolean) => { busy = b; },
    setClock: (ms: number) => { clock = ms; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("PollGovernor", () => {
  it("sets the base from the pulse EMA: >20ms → 2s, >50ms → 3s", () => {
    const h = harness();
    h.setEma(20); // not over the threshold
    h.governor.tick();
    expect(h.polls).toEqual([]);
    h.setEma(25);
    h.governor.tick();
    expect(h.polls).toEqual([2000]);
    h.setEma(60);
    h.governor.tick();
    expect(h.polls).toEqual([2000, 3000]);
    h.setEma(5);
    h.governor.tick();
    expect(h.polls).toEqual([2000, 3000, 1000]);
  });

  it("stretches to 3s after ~30 quiet beats and snaps back on activity", () => {
    const h = harness();
    h.setClock(30_000);
    h.governor.tick(); // 30s quiet at the 1s base ≈ 30 beats
    expect(h.polls).toEqual([3000]);
    h.governor.markActivity(); // an op or event: back to the base at once
    expect(h.polls).toEqual([3000, 1000]);
  });

  it("needs more quiet time when the base is already slow", () => {
    const h = harness();
    h.setEma(25); // base 2000
    h.setClock(30_000);
    h.governor.tick();
    expect(h.polls).toEqual([2000]); // 30 beats at 2s = 60s, not there yet
    h.setClock(60_000);
    h.governor.tick();
    expect(h.polls).toEqual([2000, 3000]);
  });

  it("does not stretch while a cell runs or an op is in flight", () => {
    const h = harness();
    h.setBusy(true);
    h.setClock(30_000);
    h.governor.tick();
    h.setClock(60_000);
    h.governor.tick();
    expect(h.polls).toEqual([]);
    h.setBusy(false);
    h.setClock(90_000);
    h.governor.tick();
    expect(h.polls).toEqual([3000]);
  });

  it("activity between checks keeps the base", () => {
    const h = harness();
    h.setClock(29_000);
    h.governor.markActivity();
    h.setClock(30_000);
    h.governor.tick(); // only 1s since the activity
    expect(h.polls).toEqual([]);
  });

  it("logs about every 30 beats only while measurement is on", () => {
    const h = harness();
    h.setClock(30_000);
    h.governor.markActivity(); // keep the 1s base for this test
    h.governor.tick();
    expect(h.logs).toEqual([]); // measure off
    h.governor.measure = true;
    h.setClock(60_000);
    h.governor.markActivity();
    h.governor.tick(); // 30 beats at 1s
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("poll 1000ms");
    // At a 3s pace, 30 beats take three checks.
    h.setEma(60);
    h.setClock(90_000);
    h.governor.markActivity();
    h.governor.tick();
    h.setClock(120_000);
    h.governor.markActivity();
    h.governor.tick();
    expect(h.logs).toHaveLength(1);
    h.setClock(150_000);
    h.governor.markActivity();
    h.governor.tick();
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toContain("poll 3000ms");
  });

  it("stops its own timer on dispose", () => {
    const h = harness();
    expect(vi.getTimerCount()).toBe(1);
    h.governor.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
