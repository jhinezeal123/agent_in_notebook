// OpenResearch run hidden by the bridge: started (a stand-in for orx), joined
// when one already runs, reported missing, and its run changes passed on.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchRun, ResearchStatus } from "@ainb/protocol";
import { Orx, toRun } from "../src/research/orx.js";

const FAKE_ORX = resolve(__dirname, "fixtures/fake-orx.mjs");
const COUNTING_ORX_UP = resolve(__dirname, "fixtures/counting-orx-up.mjs");

let orx: Orx | undefined;
afterEach(() => {
  orx?.close();
  orx = undefined;
  delete process.env.FAKE_ORX_FAIL;
});

function make(opts: { knownPorts?: number[]; missing?: boolean } = {}) {
  const statuses: ResearchStatus[] = [];
  const runs: ResearchRun[] = [];
  orx = new Orx({
    log: () => {},
    onStatus: (s) => statuses.push(s),
    onRun: (r) => runs.push(r),
    knownPorts: opts.knownPorts ?? [],
    startTimeoutMs: 10_000,
    locate: () => (opts.missing ? { missing: "orx is not installed" } : { path: "fake-orx", command: process.execPath, args: [FAKE_ORX] }),
  });
  return { orx, statuses, runs };
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("OpenResearch sidecar", () => {
  it("starts orx up hidden, learns its address, and passes run changes on", async () => {
    const { orx, statuses, runs } = make();
    const status = await orx.start();
    expect(status).toMatchObject({ state: "ready", owned: true, version: "9.9.9-fake", orxPath: "fake-orx" });
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(statuses.map((s) => s.state)).toEqual(["starting", "ready"]);
    // A second start while ready changes nothing.
    expect(await orx.start()).toBe(status);
    await until(() => runs.length > 0);
    expect(runs).toEqual([{ id: "run_1", experimentId: "exp_1", projectId: "proj_1", status: "done", backend: "kaggle", startedAt: 1, endedAt: 2, exitCode: 0 }]);
  });

  it("starts the new configuration when restarted during startup", async () => {
    const { orx } = make();
    const first = orx.start();
    const restarted = orx.restart();
    expect((await first).state).toBe("off");
    expect(await restarted).toMatchObject({ state: "ready", owned: true });
  });

  it("uses an OpenResearch that is already running instead of starting another", async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/api/health" ? JSON.stringify({ ok: true, version: "1.2.3" }) : "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const { orx } = make({ knownPorts: [port], missing: true });
      expect(await orx.start()).toMatchObject({ state: "ready", owned: false, url: `http://127.0.0.1:${port}`, version: "1.2.3" });
    } finally {
      server.close();
    }
  });

  it("says when orx is missing, and why it could not start", async () => {
    const missing = make({ missing: true });
    expect(await missing.orx.start()).toEqual({ state: "missing", error: "orx is not installed" });
    missing.orx.close();

    process.env.FAKE_ORX_FAIL = "1";
    const failing = make();
    const status = await failing.orx.start();
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/already running on this computer/);
  });

  it("does not spawn again on automatic starts right after a failure, but a manual start may", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "ainb-orx-cooldown-")), "spawns.log");
    process.env.COUNTING_ORX_UP_LOG = log;
    const spawns = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
    orx = new Orx({
      log: () => {},
      onStatus: () => {},
      onRun: () => {},
      knownPorts: [],
      startTimeoutMs: 10_000,
      locate: () => ({ path: "counting-orx", command: process.execPath, args: [COUNTING_ORX_UP] }),
    });
    try {
      const first = await orx.start(); // a user action (the default): spawns
      expect(first.state).toBe("error");
      expect(first.error).toMatch(/already running on this computer/);
      expect(spawns()).toBe(1);
      // An automatic start inside the cooldown gets the same error at once, no second process.
      expect(await orx.start(false)).toBe(first);
      expect(spawns()).toBe(1);
      // A user action may try again at once.
      expect((await orx.start()).state).toBe("error");
      expect(spawns()).toBe(2);
      // After the cooldown, an automatic start tries again too.
      const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      try {
        expect((await orx.start(false)).state).toBe("error");
        expect(spawns()).toBe(3);
      } finally {
        later.mockRestore();
      }
    } finally {
      delete process.env.COUNTING_ORX_UP_LOG;
    }
  });

  it("backs off reconnecting a dropping event stream, and resets once it is healthy", async () => {
    const attempts: number[] = [];
    let healthy = false;
    let live: ServerResponse | undefined;
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "1.2.3" }));
        return;
      }
      if (req.url === "/api/events") {
        attempts.push(Date.now());
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (healthy) {
          live = res;
          res.write(": hello\n\n");
        } else res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const { orx } = make({ knownPorts: [port], missing: true });
      expect(await orx.start()).toMatchObject({ state: "ready", owned: false });
      // The stream keeps dropping: each reconnect waits longer than the last (2s, then 4s, ...).
      await until(() => attempts.length >= 3, 15_000);
      const firstGap = attempts[1]! - attempts[0]!;
      const secondGap = attempts[2]! - attempts[1]!;
      expect(firstGap).toBeGreaterThanOrEqual(1_900);
      expect(secondGap).toBeGreaterThan(firstGap + 1_000);
      // A stream that stays open and speaks resets the delay: the next drop reconnects after ~2s again.
      healthy = true;
      await until(() => attempts.length >= 4 && live !== undefined, 20_000);
      const droppedAt = Date.now();
      live!.destroy();
      await until(() => attempts.length >= 5, 10_000);
      const afterHealthy = attempts[4]! - droppedAt;
      expect(afterHealthy).toBeGreaterThanOrEqual(1_900);
      expect(afterHealthy).toBeLessThan(3_500);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("reads only well-formed runs", () => {
    expect(toRun({ id: "r", experimentId: "e", projectId: "p", status: "running" })).toMatchObject({ id: "r", status: "running", backend: null });
    expect(toRun({ id: "r", experimentId: "e", projectId: "p", status: "exploded" })).toBeNull();
    expect(toRun(null)).toBeNull();
  });

  it("keeps a provider's queue detail, so VS Code can count queued runs", () => {
    expect(toRun({ id: "r", experimentId: "e", projectId: "p", status: "starting", queueDetail: "Queued on Kaggle" })).toMatchObject({ status: "starting", queueDetail: "Queued on Kaggle" });
    expect(toRun({ id: "r", experimentId: "e", projectId: "p", status: "starting", queueDetail: null })).not.toHaveProperty("queueDetail");
  });
});
