// OpenResearch run hidden by the bridge: started (a stand-in for orx), joined
// when one already runs, reported missing, and its run changes passed on.

import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchRun, ResearchStatus } from "@ainb/protocol";
import { Orx, toRun } from "../src/research/orx.js";

const FAKE_ORX = resolve(__dirname, "fixtures/fake-orx.mjs");

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
