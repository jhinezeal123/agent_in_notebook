// The way onto the notebook's machine: short Python snippets run on its
// kernel, outside any cell. Each snippet defines one function in a namespace
// of its own, calls it with JSON arguments, and prints a marked JSON line.

import type { ExecResult } from "@ainb/protocol";

/** How the bridge reaches the kernel: run code and wait at most `waitMs`. */
export type KernelExec = (code: string, waitMs: number) => Promise<ExecResult>;

/** The machine cannot be reached right now: no runtime is connected, or the kernel is busy. */
export class Unreachable extends Error {}

/** The kernel is running a cell, so the machine cannot be reached until it ends. */
export class KernelBusy extends Unreachable {}

const NOT_CONNECTED = /not connected to a runtime|session is not running|no kernel is connected/i;

/** A failure on the notebook's machine, reported to the agent as it is. */
export class VmError extends Error {}

/** Each call waits at most this long; longer means it queued behind a cell. */
export const CALL_WAIT_MS = 15_000;
const MARK = "\u001eainb ";

/** The code that runs `fn(args)` from `source`. */
export function program(source: string, fn: string, args: Record<string, unknown>): string {
  const body = `${source}\nimport json as _json\n${fn}(_json.loads(${JSON.stringify(JSON.stringify(args))}))\n`;
  // JSON string literals are valid Python string literals.
  return `exec(${JSON.stringify(body)}, {"__name__": "__ainb__"})`;
}

/** Python that `source` can use to answer: `_ainb_done(result)`. */
export const DONE = String.raw`
def _ainb_done(res):
    import json
    print("\x1eainb " + json.dumps(res))
`;

export async function helperCall<T>(exec: KernelExec, source: string, fn: string, args: Record<string, unknown>, waitMs = CALL_WAIT_MS): Promise<T> {
  let res: ExecResult;
  try {
    res = await exec(program(DONE + source, fn, args), waitMs);
  } catch (e) {
    const msg = (e as Error).message;
    if (/kernel is busy/i.test(msg)) throw new KernelBusy(msg);
    if (NOT_CONNECTED.test(msg)) throw new Unreachable(msg);
    throw e;
  }
  // Queued behind a cell the user started meanwhile; it runs when that ends.
  if (res.status === "running") throw new KernelBusy("The kernel is busy running a cell.");
  const text = res.outputs.map((o) => (o.kind === "stream" ? (o.text ?? "") : "")).join("");
  const line = text.split("\n").find((l) => l.startsWith(MARK));
  if (!line) {
    const err = res.outputs.find((o) => o.kind === "error");
    throw new VmError(err ? `${err.ename}: ${err.evalue}` : (res.message ?? "the kernel did not answer"));
  }
  const parsed = JSON.parse(line.slice(MARK.length));
  if (parsed.error) throw new VmError(parsed.error);
  return parsed as T;
}
