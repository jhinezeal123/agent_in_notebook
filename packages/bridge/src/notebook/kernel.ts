// The way onto the notebook's machine: short Python snippets run on its
// kernel, outside any cell. Each snippet defines one function in a namespace
// of its own, calls it with JSON arguments, and prints a marked JSON line.

import { createHash } from "node:crypto";
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
const MISSING_HELPER = "__ainb_missing_helper";

/** Helper hashes we have already installed at least once in this process. */
const knownHelpers = new Set<string>();
const hashCache = new Map<string, string>();

function helperHash(fullSource: string): string {
  let h = hashCache.get(fullSource);
  if (!h) {
    h = createHash("sha256").update(fullSource).digest("hex").slice(0, 12);
    hashCache.set(fullSource, h);
  }
  return h;
}

/**
 * The code that runs `fn(args)` from `source`.
 * Passing `_ainb_raw` in the exec namespace dict avoids triple-escaping `args`
 * (which carries 512KB–1MB file chunks) inside the outer `JSON.stringify(body)`.
 */
export function program(source: string, fn: string, args: Record<string, unknown>): string {
  const body = `${source}\nimport json as _json\n${fn}(_json.loads(_ainb_raw))\n`;
  return `exec(${JSON.stringify(body)}, {"__name__": "__ainb__", "_ainb_raw": ${JSON.stringify(JSON.stringify(args))}})`;
}

/** Tiny stub that loads `/tmp/ainb-<uid>/helpers-<hash>.py` if present on the VM, else reports missing. */
function cachedLoader(hash: string, fn: string): string {
  return String.raw`
import os as _os, tempfile as _tf
_hd = _os.path.join("/tmp" if _os.name == "posix" else _tf.gettempdir(), "ainb-%s" % (_os.getuid() if hasattr(_os, "getuid") else _os.getlogin()))
_hp = _os.path.join(_hd, "helpers-${hash}.py")
if _os.path.exists(_hp):
    with open(_hp, "r", encoding="utf-8") as _hf:
        exec(_hf.read(), globals())
else:
    def ${fn}(_a):
        print("\x1eainb {\"${MISSING_HELPER}\":true}")
`;
}

/** Write the helper source atomically to `/tmp/ainb-<uid>/helpers-<hash>.py` so later calls only send the stub. */
function installPrefix(hash: string, fullSource: string): string {
  return String.raw`
import os as _os, tempfile as _tf
try:
    _hd = _os.path.join("/tmp" if _os.name == "posix" else _tf.gettempdir(), "ainb-%s" % (_os.getuid() if hasattr(_os, "getuid") else _os.getlogin()))
    _hp = _os.path.join(_hd, "helpers-${hash}.py")
    if not _os.path.exists(_hp):
        _os.makedirs(_hd, mode=0o700, exist_ok=True)
        _ht = _hp + ".%d.tmp" % _os.getpid()
        with open(_ht, "w", encoding="utf-8") as _hf:
            _hf.write(${JSON.stringify(fullSource)})
        _os.replace(_ht, _hp)
except OSError:
    pass
`;
}

/** Python that `source` can use to answer: `_ainb_done(result)`. */
export const DONE = String.raw`
def _ainb_done(res):
    import json
    print("\x1eainb " + json.dumps(res))
`;

async function runSnippet<T>(exec: KernelExec, code: string, waitMs: number): Promise<T & { [MISSING_HELPER]?: boolean }> {
  let res: ExecResult;
  try {
    res = await exec(code, waitMs);
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
  return parsed as T & { [MISSING_HELPER]?: boolean };
}

export async function helperCall<T>(exec: KernelExec, source: string, fn: string, args: Record<string, unknown>, waitMs = CALL_WAIT_MS): Promise<T> {
  const full = DONE + source;
  const hash = helperHash(full);
  if (knownHelpers.has(hash)) {
    const cached = await runSnippet<T>(exec, program(cachedLoader(hash, fn), fn, args), waitMs);
    if (!cached[MISSING_HELPER]) return cached;
  }
  const result = await runSnippet<T>(exec, program(installPrefix(hash, full) + full, fn, args), waitMs);
  knownHelpers.add(hash);
  return result;
}

/** Reset the in-process helper install cache (tests). */
export function resetHelperCache(): void {
  knownHelpers.clear();
}
