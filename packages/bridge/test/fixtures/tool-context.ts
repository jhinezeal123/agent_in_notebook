// A tool context on a FakeNotebook, for calling the tools without a bridge.

import { DEFAULT_SETTINGS, type ChatSettings, type NotebookOp } from "@ainb/protocol";
import { RecentRuns } from "../../src/notebook/exec.js";
import { NotebookMirror } from "../../src/notebook/nbfile.js";
import { ShellSessions } from "../../src/notebook/shell.js";
import type { ToolContext } from "../../src/notebook/tools.js";
import type { FakeNotebook } from "./fake-extension.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `latency` makes ops slow enough for calls to overlap; `locks: false` turns the chat's locks off. */
export function context(
  nb: FakeNotebook,
  opts: { settings?: Partial<ChatSettings>; latency?: number; locks?: boolean; overrides?: Partial<ToolContext> } = {},
): ToolContext {
  const settings: ChatSettings = { ...DEFAULT_SETTINGS, scope: "auto", review: false, ...opts.settings };
  const locks = new Map<string, Promise<unknown>>();
  return {
    settings: () => settings,
    targets: () => [],
    call: async (op) => {
      if (opts.latency) await sleep(opts.latency);
      const r = nb.handle(op as NotebookOp);
      if (opts.latency) await sleep(opts.latency);
      return r as never;
    },
    awaitReview: async () => "pending",
    confirmRun: async () => true,
    waitMs: 10_000,
    images: false,
    exclusive: (lock, fn) => {
      if (opts.locks === false) return fn();
      const run = (locks.get(lock) ?? Promise.resolve()).then(fn, fn);
      locks.set(lock, run.catch(() => {}));
      return run;
    },
    runs: new RecentRuns(),
    shells: new ShellSessions(),
    mirror: new NotebookMirror(),
    ...opts.overrides,
  };
}
