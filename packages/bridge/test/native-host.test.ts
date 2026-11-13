// The native messaging host as the browser runs it: framed JSON over stdio,
// starting the bridge on demand. Installing (which writes to the browsers'
// registry keys / folders) is covered by the extension's E2E test.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NativeReply } from "@ainb/protocol";
import { frame, NativeReader } from "../src/native-host.js";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });
}

/** Run the host like the browser does: one framed request in, one framed reply out. */
function ask(home: string, request: unknown): Promise<NativeReply> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, "native-host", "chrome-extension://abc/"], { env: { ...process.env, AINB_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
    const reader = new NativeReader();
    child.stdout.on("data", (c: Buffer) => {
      const [msg] = reader.push(c);
      if (msg) {
        done(msg as NativeReply);
        child.stdin.end();
      }
    });
    child.on("error", fail);
    child.on("exit", (code) => code && fail(new Error(`host exited with ${code}`)));
    child.stdin.write(frame(request));
  });
}

const cli = (home: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AINB_HOME: home }, encoding: "utf8" });

describe("native host", () => {
  const homes: string[] = [];
  afterAll(() => {
    for (const home of homes) cli(home, "stop");
  });

  it("frames messages and splits them back out of arbitrary chunks", () => {
    const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: "ü" })]);
    const reader = new NativeReader();
    expect(reader.push(bytes.subarray(0, 3))).toEqual([]);
    expect(reader.push(bytes.subarray(3, 12))).toEqual([{ a: 1 }]);
    expect(reader.push(bytes.subarray(12))).toEqual([{ b: "ü" }]);
  });

  it("starts the bridge once, hands out its port and token, and `ainb stop` stops it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ainb-native-"));
    homes.push(home);
    const port = await freePort();
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "native-token-0123456789", port }));

    const first = await ask(home, { type: "connect" });
    expect(first).toMatchObject({ ok: true, port, token: "native-token-0123456789", started: true });
    // The bridge outlived the host process.
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);

    expect(await ask(home, { type: "connect" })).toMatchObject({ ok: true, started: false });
    expect(cli(home, "status").status).toBe(0);
    expect(cli(home, "stop").stdout).toContain("Stopped.");
    expect(cli(home, "status").status).toBe(1);
  });

  it("refuses to stop a bridge for a request without its token", async () => {
    const home = mkdtempSync(join(tmpdir(), "ainb-native-"));
    homes.push(home);
    const port = await freePort();
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "native-token-abcdefghij", port }));
    await ask(home, { type: "connect" });
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    // From a web page (an Origin header): refused before the token is even looked at.
    const page = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: { authorization: "Bearer native-token-abcdefghij", origin: "https://evil.example" } });
    expect(page.status).toBe(403);
    expect(cli(home, "status").status).toBe(0);
  });

  it("reports a port held by another program instead of starting a second server", async () => {
    const home = mkdtempSync(join(tmpdir(), "ainb-native-"));
    const squatter = createServer((s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi")).listen(0, "127.0.0.1");
    await new Promise((r) => squatter.once("listening", r));
    const port = (squatter.address() as { port: number }).port;
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "native-token-0123456789", port }));
    const reply = await ask(home, { type: "connect" });
    squatter.close();
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining(`Port ${port} is taken`) });
  });
});
