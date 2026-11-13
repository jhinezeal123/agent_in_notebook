// The kernel environment setup: the user's script (pip installs, a clone, a
// download) run in a terminal on the notebook's machine, outside any chat.
// It uses the same terminal daemon as the agent's shell tool, in a session of
// its own ("setup"), so a long install keeps running on the machine if the
// bridge stops waiting, and the agent can look at it later (shell_wait with
// session "setup").

import type { NotebookInfo, NotebookOp } from "@ainb/protocol";
import type { KernelExec } from "./kernel.js";
import { reachable } from "./nbfile.js";
import { ShellSessions } from "./shell.js";

export const SETUP_SESSION = "setup";

export interface SetupResult {
  output: string;
  /** null: still running when the bridge stopped waiting. */
  exitCode: number | null;
  running: boolean;
}

/** Terminal screens of the setup sessions, by notebook. */
const sessions = new Map<string, ShellSessions>();

export async function runSetup(
  call: (op: NotebookOp, timeoutMs?: number) => Promise<unknown>,
  target: string,
  script: string,
  waitMs: number,
): Promise<SetupResult> {
  if (!script.trim()) throw new Error("The setup script is empty.");
  const info = (await call({ op: "info" })) as NotebookInfo;
  if (!reachable(info)) throw new Error(`This notebook's kernel runs ${info.language}; the setup runs only through a Python kernel.`);
  const exec: KernelExec = (code, wait) => call({ op: "machine_exec", code, waitMs: wait }, wait + 15_000) as ReturnType<KernelExec>;
  let shells = sessions.get(target);
  if (!shells) sessions.set(target, (shells = new ShellSessions()));
  const deadline = Date.now() + waitMs;
  return shells.exclusive(SETUP_SESSION, async (sh) => {
    if (sh.state === "new" || sh.state === "exited") await sh.open(exec, deadline);
    else await sh.refresh(exec);
    if (sh.state === "running") throw new Error("The previous setup is still running on the notebook's machine.");
    await sh.start(exec, script);
    const cmd = sh.command!;
    const { paused } = await sh.pollUntil(exec, () => !!cmd.end, deadline);
    const report = sh.report(paused);
    const running = !cmd.end;
    return { output: (report.full ?? report.text).trimEnd(), exitCode: running ? null : (cmd.status ?? null), running };
  });
}

/** The notebook went away: forget its setup terminal's screen. */
export function forgetSetup(target: string): void {
  sessions.delete(target);
}
