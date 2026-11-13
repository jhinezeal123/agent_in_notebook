// Starting the bridge from VS Code. It asks the same native host the browser
// extension uses: `ainb install` writes its launcher, which runs the user's
// own Node and bridge CLI. The host starts the bridge when it is not running
// and answers with its port and pairing token, so VS Code needs no copy of the
// bridge and no token typed in.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostReply =
  | { ok: true; port: number; token: string; started: boolean }
  | { ok: false; error: string; log?: string };

export function dataDir(): string {
  return process.env.AINB_HOME ?? join(homedir(), ".agent-in-notebook");
}

/** The launcher `ainb install` wrote, if it did. */
export function launcherPath(): string | null {
  const file = join(dataDir(), "native-host", process.platform === "win32" ? "ainb-native-host.cmd" : "ainb-native-host.sh");
  return existsSync(file) ? file : null;
}

/** One framed `connect` request in, one framed reply out (the browser's native messaging, done by hand). */
export function askNativeHost(launcher: string, timeoutMs = 30_000): Promise<HostReply> {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", launcher], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
      : spawn(launcher, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = Buffer.alloc(0);
    let done = false;
    const finish = (reply: HostReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Closing its input lets the host exit; the bridge it started runs on.
      child.stdin.end();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "The bridge did not start in time." }), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      try {
        finish(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as HostReply);
      } catch {
        finish({ ok: false, error: "The bridge's launcher gave an unreadable answer." });
      }
    });
    child.on("error", (error) => finish({ ok: false, error: `Could not run the bridge's launcher: ${error.message}` }));
    child.on("close", () => finish({ ok: false, error: 'The bridge\'s launcher stopped without answering. Run "pnpm ainb install" again.' }));
    child.stdin.on("error", () => {});
    const body = Buffer.from(JSON.stringify({ type: "connect" }), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([head, body]));
  });
}
