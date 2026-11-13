// Files on the notebook's machine, reached through its kernel (see kernel.ts).
// The helper keeps to plain file operations; reading lines, editing text and
// formatting results happen here, in the bridge.

import { posix } from "node:path";
import { CALL_WAIT_MS, helperCall, type KernelExec } from "./kernel.js";

/** Bytes moved per kernel call: replies pass through the page, which caps one stream near 1 MB. */
const CHUNK = 512 * 1024;
/** Largest file read whole (to edit it, or to show a notebook file as cells). */
export const WHOLE_MAX = 8 * 1024 * 1024;
/** Searches stop after this long on the machine and say so. */
const SEARCH_SECONDS = 20;

const HELPER = String.raw`
def _ainb_fs(args):
    import base64, fnmatch, glob, os, re, stat, time
    op, done = args["op"], _ainb_done
    def st(path):
        try:
            s = os.stat(path)
        except OSError:
            return None
        return {"size": s.st_size, "mtime": str(s.st_mtime_ns), "dir": stat.S_ISDIR(s.st_mode)}
    def fail(msg):
        return done({"error": msg})
    def binary(head):
        # A NUL, or bytes that are not UTF-8 (a character cut at the end of the sample is fine).
        if b"\0" in head:
            return True
        try:
            head.decode("utf-8")
        except UnicodeDecodeError as e:
            return e.start < len(head) - 4
        return False
    if op == "hello":
        import sys
        return done({"cwd": os.getcwd(), "home": os.path.expanduser("~"), "posix": os.name == "posix",
                     "path": os.environ.get("PATH", ""), "python": sys.executable or ""})
    if op == "stat":
        return done({"stats": [st(p) for p in args["paths"]]})
    if op == "read_lines":
        path = args["path"]
        s = st(path)
        if s is None:
            return fail("File does not exist: " + path)
        if s["dir"]:
            return fail(path + " is a directory. List it with Glob or ls.")
        with open(path, "rb") as f:
            head = f.read(8192)
            if binary(head):
                return done({"binary": True, "stat": s})
            f.seek(0)
            lines, total, used = [], 0, 0
            start, limit, cut, budget = args["offset"], args["limit"], args["cut"], args["budget"]
            for raw in f:
                total += 1
                if total < start or len(lines) >= limit or used >= budget:
                    continue
                text = raw.decode("utf-8", "replace").rstrip("\r\n")
                if len(text) > cut:
                    text = text[:cut] + "… [line cut at %d characters]" % cut
                lines.append(text)
                used += len(text) + 1
        return done({"lines": lines, "total": total, "stat": s, "full": used < budget})
    if op == "read":
        path = args["path"]
        s = st(path)
        if s is None:
            return fail("File does not exist: " + path)
        if s["dir"]:
            return fail(path + " is a directory.")
        with open(path, "rb") as f:
            f.seek(args["offset"])
            data = f.read(args["max"])
        return done({"data": base64.b64encode(data).decode(), "stat": s})
    if op == "write":
        path = args["path"]
        tmp = path + ".ainb-tmp"
        if args["first"]:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
        with open(tmp, "wb" if args["first"] else "ab") as f:
            f.write(base64.b64decode(args["data"]))
        if not args["last"]:
            return done({"ok": True})
        cur = st(path)
        expect = args["expect"]
        if expect != "any":
            if expect is None:
                ok = cur is None
            else:
                ok = cur is not None and cur["size"] == expect["size"] and cur["mtime"] == expect["mtime"]
            if not ok:
                os.remove(tmp)
                return done({"conflict": True, "stat": cur})
        if cur is not None:
            os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
        os.replace(tmp, path)
        return done({"stat": st(path)})
    if op == "claim":
        # The first of the paths that is free or already ours (from an earlier session).
        import tempfile
        user = os.getuid() if hasattr(os, "getuid") else os.getlogin()
        reg = os.path.join("/tmp" if os.name == "posix" else tempfile.gettempdir(), "ainb-%s" % user, "files")
        os.makedirs(os.path.dirname(reg), exist_ok=True)
        try:
            with open(reg) as f:
                owned = set(f.read().split("\n"))
        except OSError:
            owned = set()
        for p in args["paths"]:
            if p in owned:
                return done({"path": p})
            if not os.path.exists(p):
                with open(reg, "a") as f:
                    f.write(p + "\n")
                return done({"path": p})
        return fail("Every name tried for the notebook file is taken: " + ", ".join(args["paths"]))
    if op == "remove":
        try:
            os.remove(args["path"])
        except OSError:
            pass
        return done({})
    deadline = time.monotonic() + args["seconds"]
    skip = {".git", "node_modules", "__pycache__", ".ipynb_checkpoints"}
    def braces(p):
        m = re.search(r"\{([^{}]*)\}", p)
        if not m:
            return [p]
        return [q for alt in m.group(1).split(",") for q in braces(p[:m.start()] + alt + p[m.end():])]
    if op == "glob":
        base, pattern = args["base"], args["pattern"]
        found, more = [], False
        for pat in braces(pattern):
            for p in glob.iglob(pat if os.path.isabs(pat) else os.path.join(base, pat), recursive=True):
                if len(found) >= 20000 or time.monotonic() > deadline:
                    more = True
                    break
                if any(part in skip for part in p.split(os.sep)):
                    continue
                s = st(p)
                if s is not None and not s["dir"]:
                    found.append((p, int(s["mtime"])))
        found.sort(key=lambda x: -x[1])
        return done({"paths": [p for p, _ in found[: args["limit"]]], "total": len(found), "more": more})
    if op == "grep":
        flags = re.IGNORECASE if args["ignore_case"] else 0
        try:
            rx = re.compile(args["pattern"], flags)
        except re.error as e:
            return fail("Invalid regular expression: %s" % e)
        base, mode, ctx, limit = args["base"], args["mode"], args["context"], args["limit"]
        globs = [g for p in (args.get("glob") or "").split() for g in braces(p)] if args.get("glob") else []
        def wanted(path):
            if not globs:
                return True
            rel = os.path.relpath(path, base) if os.path.isdir(base) else os.path.basename(path)
            return any(fnmatch.fnmatch(rel if "/" in g else os.path.basename(path), g) for g in globs)
        def files():
            if os.path.isfile(base):
                yield base
                return
            for root, dirs, names in os.walk(base):
                dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith(".") and os.path.join(root, d) not in ("/proc", "/sys", "/dev"))
                for n in sorted(names):
                    yield os.path.join(root, n)
        hits, counts, matched, more, scanned = [], [], [], False, 0
        for path in files():
            if time.monotonic() > deadline or scanned >= 50000:
                more = True
                break
            if not wanted(path):
                continue
            scanned += 1
            try:
                if os.path.getsize(path) > 20 * 1024 * 1024:
                    continue
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if binary(data[:8192]):
                continue
            lines = data.decode("utf-8", "replace").split("\n")
            found = [i for i, l in enumerate(lines) if rx.search(l)]
            found_set = set(found)
            if not found:
                continue
            matched.append((path, os.path.getmtime(path)))
            counts.append([path, len(found)])
            if mode == "content" and len(hits) < limit:
                shown = set()
                for i in found:
                    if len(hits) >= limit:
                        more = True
                        break
                    for j in range(max(0, i - ctx), min(len(lines), i + ctx + 1)):
                        if j not in shown:
                            shown.add(j)
                            hits.append([path, j + 1, lines[j].rstrip("\r")[:500], j in found_set])
        matched.sort(key=lambda x: -x[1])
        return done({"files": [p for p, _ in matched], "counts": counts, "hits": hits, "more": more})
    return fail("unknown operation " + op)
`;

export interface Stat {
  size: number;
  /** Nanoseconds, as text: they do not fit a double. */
  mtime: string;
  dir: boolean;
}

export interface Hello {
  cwd: string;
  home: string;
  posix: boolean;
  /** PATH and the interpreter of the Python that answered. */
  path: string;
  python: string;
}

function call<T>(exec: KernelExec, op: string, args: Record<string, unknown> = {}): Promise<T> {
  return helperCall<T>(exec, HELPER, "_ainb_fs", { ...args, op }, CALL_WAIT_MS + SEARCH_SECONDS * 1000);
}

export const hello = (exec: KernelExec) => call<Hello>(exec, "hello");

export async function stat(exec: KernelExec, paths: string[]): Promise<(Stat | null)[]> {
  return (await call<{ stats: (Stat | null)[] }>(exec, "stat", { paths })).stats;
}

export interface Lines {
  lines: string[];
  /** Lines in the whole file. */
  total: number;
  stat: Stat;
  binary?: boolean;
  /** False when the text budget ran out before `limit` lines. */
  full: boolean;
}

export function readLines(exec: KernelExec, path: string, offset: number, limit: number, budget: number): Promise<Lines> {
  return call<Lines>(exec, "read_lines", { path, offset, limit, cut: 2000, budget });
}

/** The whole file, up to `max` bytes. */
export async function readFile(exec: KernelExec, path: string, max = WHOLE_MAX): Promise<{ data: Buffer; stat: Stat }> {
  const parts: Buffer[] = [];
  let first: Stat | undefined;
  for (let offset = 0; ; ) {
    const r = await call<{ data: string; stat: Stat }>(exec, "read", { path, offset, max: CHUNK });
    first ??= r.stat;
    if (first.size > max) throw new FileTooBig(path, first.size, max);
    const chunk = Buffer.from(r.data, "base64");
    parts.push(chunk);
    offset += chunk.length;
    if (!chunk.length || offset >= r.stat.size) return { data: Buffer.concat(parts), stat: r.stat };
  }
}

export class FileTooBig extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly max: number,
  ) {
    super(`${path} is ${size} bytes, more than the ${max} bytes this can handle.`);
  }
}

/**
 * Write a whole file, replacing it at once. `expect` guards against changes
 * made since it was read: its stat, `null` for "must not exist", or "any".
 * Returns the new stat, or `conflict` with what is there now.
 */
export async function writeFile(exec: KernelExec, path: string, data: Buffer, expect: Stat | null | "any" = "any"): Promise<{ stat: Stat } | { conflict: true; stat: Stat | null }> {
  for (let offset = 0; ; offset += CHUNK) {
    const last = offset + CHUNK >= data.length;
    const r = await call<{ stat?: Stat; conflict?: boolean }>(exec, "write", {
      path,
      data: data.subarray(offset, offset + CHUNK).toString("base64"),
      first: offset === 0,
      last,
      expect: expect === "any" || expect === null ? expect : { size: expect.size, mtime: expect.mtime },
    });
    if (last) return r.conflict ? { conflict: true, stat: r.stat ?? null } : { stat: r.stat! };
  }
}

/** The first of `paths` that is free, or was claimed before; it is then ours to overwrite. */
export async function claim(exec: KernelExec, paths: string[]): Promise<string> {
  return (await call<{ path: string }>(exec, "claim", { paths })).path;
}

export const removeFile =(exec: KernelExec, path: string) => call<object>(exec, "remove", { path });

export function glob(exec: KernelExec, base: string, pattern: string, limit: number) {
  return call<{ paths: string[]; total: number; more: boolean }>(exec, "glob", { base, pattern, limit, seconds: SEARCH_SECONDS });
}

export interface GrepArgs {
  pattern: string;
  base: string;
  glob?: string;
  ignore_case: boolean;
  mode: "content" | "files_with_matches" | "count";
  context: number;
  limit: number;
}

export function grep(exec: KernelExec, a: GrepArgs) {
  return call<{ files: string[]; counts: [string, number][]; hits: [string, number, string, boolean][]; more: boolean }>(exec, "grep", { ...a, seconds: SEARCH_SECONDS });
}

/** Where the agent's relative paths and `~` point on the machine. */
export interface Places {
  /** The notebook's working directory (the kernel's, when it was asked). */
  cwd: string;
  home: string;
  /** Environment the terminal takes from the kernel (PATH, so `python` and `pip` are the notebook's). */
  env?: Record<string, string>;
}

export function resolvePath(p: string, at: Places): string {
  let s = p.trim();
  if (s === "~" || s.startsWith("~/")) s = at.home + s.slice(1);
  return posix.normalize(posix.isAbsolute(s) ? s : posix.join(at.cwd, s)).replace(/(.)\/+$/, "$1");
}

export function sameStat(a: Stat | null | undefined, b: Stat | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.size === b.size && a.mtime === b.mtime;
}
