// Đợt 2c (shell/vmfs/kernel): helper install-once + reduced JSON nesting (A5.1),
// asymmetric WRITE_CHUNK (A5.1), ShellSessions cap 8 + closeIdle (A6.4),
// listTools schema cache + describeAgents cache (A5.4).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "@ainb/protocol";
import { helperCall, program, resetHelperCache, type KernelExec } from "../src/notebook/kernel.js";
import { MAX_SESSIONS, ShellSessions } from "../src/notebook/shell.js";
import { writeFile, WRITE_CHUNK_KERNEL, WRITE_CHUNK_TERMINAL } from "../src/notebook/vmfs.js";
import { listTools } from "../src/notebook/tools.js";
import { FakeVm } from "./fixtures/fake-extension.js";

afterEach(() => {
  resetHelperCache();
});

describe("A5.1 kernel helper install-once & encoding", () => {
  it("passes args outside exec body so quotes are not triple-escaped", () => {
    const code = program("def _ainb_x(a): pass", "_ainb_x", { text: 'hello "world"' });
    expect(code).toContain('"_ainb_raw":');
    // Double-escaped (\\\" = 3 backslashes), never triple-escaped (\\\\\\\" = 7 backslashes).
    expect(code).not.toContain(String.raw`\\\\\\\"`);
  });

  it("installs helper once, sends tiny stub afterwards, and re-installs if VM reports missing", async () => {
    const sent: string[] = [];
    const BIG_HELPER = `def _ainb_test(args):\n    # ${"x".repeat(4000)}\n    _ainb_done({"ok": args["v"]})\n`;
    let vmHasHelper = false;
    const exec: KernelExec = async (code): Promise<ExecResult> => {
      sent.push(code);
      if (code.includes("# xxxx")) {
        vmHasHelper = true;
        return { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb {"ok":1}\n` }] };
      }
      if (!vmHasHelper) {
        return { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb {"__ainb_missing_helper":true}\n` }] };
      }
      return { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb {"ok":2}\n` }] };
    };

    const r1 = await helperCall<{ ok: number }>(exec, BIG_HELPER, "_ainb_test", { v: 1 });
    expect(r1.ok).toBe(1);
    expect(sent[0]!.length).toBeGreaterThan(4000);

    const r2 = await helperCall<{ ok: number }>(exec, BIG_HELPER, "_ainb_test", { v: 2 });
    expect(r2.ok).toBe(2);
    expect(sent[1]!.length).toBeLessThan(1200);

    // Simulate VM replacement: stub reports missing, helperCall transparently re-installs.
    vmHasHelper = false;
    const r3 = await helperCall<{ ok: number }>(exec, BIG_HELPER, "_ainb_test", { v: 3 });
    expect(r3.ok).toBe(1);
    expect(sent.length).toBe(4);
    expect(sent[3]!.length).toBeGreaterThan(4000);
  });
});

describe("A5.1 asymmetric WRITE_CHUNK", () => {
  it("writes in 512 KB chunks by default and 1 MB chunks when server-terminal chunk is passed", async () => {
    const data = Buffer.alloc(1_200_000, 65);
    const vm1 = new FakeVm();
    let calls1 = 0;
    await writeFile(async (code) => { calls1++; return vm1.handle(code); }, "/tmp/a.bin", data);
    expect(calls1).toBe(Math.ceil(data.length / WRITE_CHUNK_KERNEL));

    const vm2 = new FakeVm();
    let calls2 = 0;
    await writeFile(async (code) => { calls2++; return vm2.handle(code); }, "/tmp/b.bin", data, "any", { writeChunk: WRITE_CHUNK_TERMINAL });
    expect(calls2).toBe(Math.ceil(data.length / WRITE_CHUNK_TERMINAL));
    expect(calls2).toBeLessThan(calls1);
    expect(vm2.files.get("/tmp/b.bin")?.data.length).toBe(data.length);
  });
});

describe("A6.4 ShellSessions cap & closeIdle", () => {
  it("caps active sessions at MAX_SESSIONS and reuses slots of exited sessions", () => {
    const shells = new ShellSessions();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const s = shells.get(`s${i}`);
      s.state = "idle";
    }
    expect(() => shells.get("overflow")).toThrow(/Too many terminal sessions/);

    // Mark one exited: slot is reclaimed.
    shells.get("s0").state = "exited";
    expect(shells.get("reclaimed").name).toBe("reclaimed");
  });

  it("closes idle sessions on closeIdle and leaves running sessions untouched on the VM", async () => {
    const shells = new ShellSessions();
    const idle = shells.get("idle1");
    idle.state = "idle";
    const running = shells.get("run1");
    running.state = "running";
    const vm = new FakeVm();
    const exec = vi.fn<KernelExec>(async (code) => vm.handle(code));

    await shells.closeIdle(exec);
    expect(vm.ops).toEqual(["close"]);
    expect(idle.state).toBe("exited");
    expect(running.state).toBe("running");
    expect(shells.names()).toEqual([]);
  });
});

describe("A5.4 listTools schema cache", () => {
  it("returns cached tool schema objects on repeated calls", () => {
    const a = listTools();
    const b = listTools();
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]).toBe(b[0]);
  });
});
