// The terminal tools against a real Linux machine: the Python helper and
// daemon, bash in a pseudo-terminal, and the bridge's emulator, reached the
// way a kernel reaches its VM (Python code in, stdout out), here through
// `docker exec`. Opt-in:
//
//   docker run -d --name ainb-vm python:3.12-slim sleep infinity
//   SHELL_VM=ainb-vm pnpm --filter @ainb/bridge exec vitest run test/shell-vm.test.ts

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ExecResult, type NotebookOp } from "@ainb/protocol";
import { RecentRuns } from "../src/notebook/exec.js";
import { ShellSessions } from "../src/notebook/shell.js";
import { callTool, type ToolContext } from "../src/notebook/tools.js";

const VM = process.env.SHELL_VM;

function python(code: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", ["exec", "-i", VM!, "python3", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      resolve(code === 0 ? { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: out }] } : { status: "error", outputs: [{ kind: "error", ename: "Error", evalue: err }] }),
    );
    p.stdin.end(code);
  });
}

function context(shells = new ShellSessions()): ToolContext {
  return {
    settings: () => ({ ...DEFAULT_SETTINGS, scope: "auto", review: false }),
    targets: () => [],
    call: async (op) => {
      const o = op as NotebookOp;
      if (o.op === "info") return { platform: "colab", title: "t", url: "u", cellCount: 0, activeCellId: null, selectedCellIds: [], kernel: "idle", language: "python" } as never;
      if (o.op === "execute") return (await python(o.code)) as never;
      throw new Error(`unexpected op ${o.op}`);
    },
    awaitReview: async () => "pending",
    confirmRun: async () => true,
    waitMs: 60_000,
    images: false,
    exclusive: (_lock, fn) => fn(),
    runs: new RecentRuns(),
    shells,
  };
}

const run = (ctx: ToolContext, args: Record<string, unknown>) => callTool(ctx, "run_shell", args).then((r) => r.text);

describe.skipIf(!VM)("terminal on a real Linux machine", () => {
  const session = `t${Date.now().toString(36)}`;
  const ctx = context();
  const sh = (command: string, extra: Record<string, unknown> = {}) => run(ctx, { command, session, ...extra });

  it("keeps the shell's state between commands, and reports exit codes", async () => {
    expect(await sh("cd /tmp && export GREETING=hello && mkdir -p ainb-t && cd ainb-t")).toMatch(/^exit code 0 · /);
    expect(await sh('pwd; echo "$GREETING"')).toMatch(/\n\/tmp\/ainb-t\nhello$/);
    expect(await sh("ls /nope")).toMatch(/^exit code 2 · .*\nls: cannot access '\/nope': No such file or directory$/);
  }, 60_000);

  it("runs multi-line commands and lines longer than a terminal line", async () => {
    expect(await sh("cat <<'EOF' > notes.txt\nfirst\nsecond\nEOF\nwc -l < notes.txt")).toMatch(/\n2$/);
    expect(await sh(`echo ${"a".repeat(6000)} | wc -c`)).toMatch(/\n6001$/);
  }, 60_000);

  it("shows the screen: a progress bar in its final state, redrawn lines redrawn", async () => {
    const bar = "python3 -c \"import sys,time\nfor i in range(0,101,25):\n    sys.stdout.write(f'\\r{i}%'); sys.stdout.flush(); time.sleep(0.05)\nprint(' done')\"";
    expect(await sh(bar)).toMatch(/\n100% done$/);
    expect(await sh("printf 'one\\ntwo\\n\\033[1A\\033[2Kthree\\n'")).toMatch(/\none\nthree$/);
  }, 60_000);

  it("lets a long command run on: wait for it, type into it, stop it", async () => {
    expect(await sh("sleep 3; echo slept", { wait_seconds: 1 })).toMatch(/^still running after/);
    expect((await callTool(ctx, "shell_wait", { session })).text).toMatch(/^exit code 0 · [3-9]\.\d s · session \S+\nslept$/);

    expect(await sh('read -p "Continue? " answer; echo "got $answer"', { wait_seconds: 2 })).toMatch(/still running.*\nContinue\?$/);
    expect((await callTool(ctx, "shell_input", { session, text: "yes" })).text).toMatch(/^exit code 0 · .*\nContinue\? yes\ngot yes$/);

    expect(await sh("sleep 100", { wait_seconds: 1 })).toMatch(/^still running/);
    expect((await callTool(ctx, "shell_interrupt", { session })).text).toMatch(/^exit code 130 \(interrupted\)/);
    expect(await sh("echo after")).toMatch(/\nafter$/);
  }, 60_000);

  it("reports what a background job printed in between", async () => {
    expect(await sh("(sleep 1; echo from-background) &")).toMatch(/^exit code 0/);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await sh("echo foreground")).toMatch(/by background jobs:\)\n(.|\n)*from-background(.|\n)*\(the command's output:\)\nforeground$/);
  }, 60_000);

  it("shows a full-screen program's screen", async () => {
    // What less or vim do: switch to the alternate screen, draw, wait for a key, switch back.
    const app = "printf '\\033[?1049h\\033[H\\033[2JFULL SCREEN APP\\npress a key'; read -rsn1 key; printf '\\033[?1049l'; echo \"key=$key\"";
    const res = await sh(app, { wait_seconds: 2 });
    expect(res).toMatch(/full-screen program is showing/);
    expect(res).toMatch(/\nFULL SCREEN APP\npress a key/);
    expect((await callTool(ctx, "shell_input", { session, text: "q", press_enter: false })).text).toMatch(/^exit code 0 · .*\nkey=q$/);
  }, 60_000);

  it("is picked up by a bridge that restarted while a command ran", async () => {
    expect(await sh("sleep 2; echo survived", { wait_seconds: 1 })).toMatch(/^still running/);
    const fresh = context();
    expect((await callTool(fresh, "shell_wait", { session })).text).toMatch(/^exit code 0 · .*\nsurvived$/);
  }, 60_000);

  it("tells about a command that ended between calls before running the next", async () => {
    // `ctx` last saw "sleep 2; echo survived" running; it ended meanwhile.
    const res = await sh("exit 4");
    expect(res).toMatch(/^\(the previous command ended meanwhile: exit code 0 · .*\nsurvived\)\n\nthe shell exited \(exit code 4\)/);
    expect(await sh("pwd")).toMatch(/\n\/$/);
  }, 60_000);
});
