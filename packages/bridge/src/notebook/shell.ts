// Terminal sessions on the machine the notebook's kernel runs on (the cloud VM
// on Colab and Kaggle), for the agent to use like a terminal on its own
// computer.
//
// On the VM, a small daemon holds an interactive bash in a pseudo-terminal,
// detached from the kernel: commands run until they end, survive a kernel
// restart, and keep the shell's state (cwd, exported variables, an activated
// venv) between commands. It appends everything the terminal prints to a log
// and types what arrives on a FIFO. The kernel is only the way in: short
// snippets start the daemon, write to the FIFO and read the log from an
// offset. The bridge feeds the log through a terminal emulator, so the agent
// reads what a person would see on the screen (progress bars in their final
// state, redrawn lines redrawn), and finds where each command starts and ends
// by invisible OSC marks the shell prints.

import { createRequire } from "node:module";
import type { IMarker, Terminal as XTerm } from "@xterm/headless";
import { helperCall, KernelBusy, VmError, type KernelExec } from "./kernel.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

export const COLS = 160;
const ROWS = 50;
/** Lines a session keeps above the screen, like a terminal's scrollback. */
export const SCROLLBACK = 10_000;
/** Log read per kernel call. */
const READ_CHUNK = 256 * 1024;
/** Log replayed into a new emulator when the bridge finds a session it did not start (it restarted). */
const REPLAY_BYTES = 2 * 1024 * 1024;
const OSC = 7770;

export const SESSION_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** Runs on the VM, detached from the kernel: argv = dir, cols, rows, cwd. */
const DAEMON = String.raw`
import os, pty, select, shutil, struct, sys, fcntl, termios
d, cols, rows, cwd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
if os.fork():
    os._exit(0)
shell = shutil.which("bash") or "/bin/sh"
pid, fd = pty.fork()
if pid == 0:
    try:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.chdir(cwd)
    except OSError:
        pass
    os.execv(shell, [shell, "--noediting", "-i"] if os.path.basename(shell) == "bash" else [shell, "-i"])
def put(name, value):
    with open(os.path.join(d, name + ".tmp"), "w") as f:
        f.write(str(value))
    os.replace(os.path.join(d, name + ".tmp"), os.path.join(d, name))
put("child", pid)
fin = os.open(os.path.join(d, "in"), os.O_RDWR | os.O_NONBLOCK)
out = os.open(os.path.join(d, "out"), os.O_WRONLY | os.O_APPEND)
put("pid", os.getpid())
while True:
    try:
        ready = select.select([fd, fin], [], [])[0]
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(out, data)
    if fin in ready:
        data = os.read(fin, 65536)
        while data:
            data = data[os.write(fd, data):]
_, status = os.waitpid(pid, 0)
put("exit", os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8)
`;

/** Runs in the kernel, in a namespace of its own: one operation on a session's files. */
const HELPER = String.raw`
def _ainb_shell(args):
    import base64, os, shutil, signal, subprocess, sys, time
    op, name, done = args["op"], args["name"], _ainb_done
    if os.name != "posix":
        return done({"error": "Terminal sessions need a Linux or macOS machine; this kernel runs on " + sys.platform + "."})
    d = os.path.join("/tmp", "ainb-shell-%d" % os.getuid(), name)
    fifo, out = os.path.join(d, "in"), os.path.join(d, "out")
    def read(fname):
        try:
            with open(os.path.join(d, fname)) as f:
                return int(f.read())
        except (OSError, ValueError):
            return None
    def alive():
        pid = read("pid")
        if pid is None or read("exit") is not None:
            return False
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    res = {}
    if op == "open":
        if alive():
            res["state"] = "alive"
        else:
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d, mode=0o700)
            os.mkfifo(fifo, 0o600)
            open(out, "wb").close()
            env = {k: v for k, v in os.environ.items() if not k.startswith(("JPY_", "PYDEVD"))}
            # Set for the kernel's own output; a terminal has neither.
            if env.get("MPLBACKEND", "").startswith("module://"):
                del env["MPLBACKEND"]
            for k in ("FORCE_COLOR", "CLICOLOR"):
                env.pop(k, None)
            env.update(args.get("env") or {})
            env.update(TERM="xterm-256color", PAGER="cat", GIT_PAGER="cat", MANPAGER="cat")
            cwd = args.get("cwd") or os.getcwd()
            if not os.path.isdir(cwd):
                cwd = os.getcwd()
            with open(os.path.join(d, "daemon.log"), "wb") as log:
                subprocess.Popen([sys.executable, "-c", args["daemon"], d, str(args["cols"]), str(args["rows"]), cwd],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True, close_fds=True).wait(10)
            end = time.monotonic() + 10
            while not alive() and time.monotonic() < end:
                time.sleep(0.05)
            if alive():
                res["state"] = "started"
            else:
                res["state"] = "failed"
                try:
                    with open(os.path.join(d, "daemon.log"), errors="replace") as f:
                        res["log"] = f.read()[-2000:]
                except OSError:
                    pass
        res["size"] = os.path.getsize(out) if os.path.exists(out) else 0
        return done(res)
    if op == "close":
        child = read("child")
        if child is not None and alive():
            try:
                os.kill(child, signal.SIGHUP)
            except OSError:
                pass
        shutil.rmtree(d, ignore_errors=True)
        return done({"closed": True})
    # step: maybe save a command file, maybe type something, then read the log from an offset.
    is_alive = alive()
    if args.get("file") and is_alive:
        with open(os.path.join(d, args["file"]["name"]), "w") as f:
            f.write(args["file"]["text"])
    data = base64.b64decode(args.get("write") or "")
    if data and is_alive:
        fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        try:
            while data:
                data = data[os.write(fd, data):]
        finally:
            os.close(fd)
    try:
        size = os.path.getsize(out)
        with open(out, "rb") as f:
            f.seek(args["offset"])
            chunk = f.read(args["max"])
    except OSError:
        size, chunk = 0, b""
    done({"size": size, "data": base64.b64encode(chunk).decode(), "alive": is_alive, "exit": read("exit"), "exists": os.path.isdir(d)})
`;

/**
 * Typed into a new shell. Echo goes off (the agent sees output, not its own
 * typing); each prompt prints a mark with the last exit status, from
 * PROMPT_COMMAND and, should a command replace that, from PS1.
 */
const INIT =
  ` stty -echo 2>/dev/null; HISTCONTROL=ignorespace; PS2=''; ` +
  `PROMPT_COMMAND='printf "\\033]${OSC};prompt;%s\\007" "$?"'; PS1='\\[\\033]${OSC};prompt;$?\\007\\]'; ` +
  `printf '\\033]${OSC};ready\\007'\r`;

function call<T>(exec: KernelExec, op: string, name: string, args: Record<string, unknown>): Promise<T> {
  return helperCall<T>(exec, HELPER, "_ainb_shell", { ...args, op, name });
}

interface StepReply {
  size: number;
  data: string;
  alive: boolean;
  exit: number | null;
  exists: boolean;
}

/** A place in the terminal's buffer that follows its line as the scrollback moves. */
interface Pos {
  marker: IMarker | undefined;
  line: number;
  col: number;
}

export interface Command {
  id: string;
  command: string;
  startedAt: number;
  start?: Pos;
  end?: Pos;
  status?: number;
  /** Where the next partial report starts (the line that was still being written). */
  reportFrom?: Pos;
}

/** Where a new shell starts, and what it adds to its environment. */
export interface ShellStart {
  cwd?: string;
  env?: Record<string, string>;
}

export type SessionState = "new" | "starting" | "idle" | "running" | "exited";

/** What a session did while the bridge waited on it. */
export interface Report {
  state: SessionState;
  command?: Command;
  /** Output of the command (or, if it was reported on before, its output since). */
  text: string;
  /** All of the command's output, once it has ended. */
  full?: string;
  /** Printed while no command of ours ran: background jobs, job notices. */
  between?: string;
  /** The kernel was busy running a cell, so the log could not be read for a while. */
  paused: boolean;
  /** The shell exited with this code. */
  exitCode?: number;
  /** A full-screen program (vim, less, htop) is showing; `text` is its screen. */
  screen?: boolean;
  scrolledOut?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ShellSession {
  state: SessionState = "new";
  command?: Command;
  exitCode?: number;
  private term!: XTerm;
  private offset = 0;
  private replaying = false;
  /** Terminal replies (cursor position, device attributes) waiting to be typed back. */
  private replies = "";
  private lastEnd?: Pos;
  private seq = 0;

  constructor(readonly name: string) {
    this.reset();
  }

  private reset(): void {
    this.term?.dispose();
    this.term = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
    this.term.parser.registerOscHandler(OSC, (data) => {
      this.onMark(data);
      return true;
    });
    this.term.onData((d) => {
      if (!this.replaying) this.replies += d;
    });
    this.offset = 0;
    this.lastEnd = undefined;
    this.command = undefined;
  }

  /** The cursor's place, tracked as the scrollback moves when `keep`. */
  private here(keep = true): Pos {
    const b = this.term.buffer.active;
    const marker = keep && b.type === "normal" ? this.term.registerMarker(0) : undefined;
    return { marker, line: b.baseY + b.cursorY, col: b.cursorX };
  }

  private onMark(data: string): void {
    const [kind, arg] = data.split(";");
    if (kind === "ready") {
      if (this.state === "starting" || this.state === "new") this.state = "idle";
      this.lastEnd ??= this.here();
    } else if (kind === "start") {
      // A command we did not send: one the bridge started before it restarted.
      if (!this.command || this.command.id !== arg) this.command = { id: arg ?? "?", command: "(started earlier)", startedAt: Date.now() };
      this.command.start = this.here();
      this.state = "running";
    } else if (kind === "prompt") {
      if (this.state === "running" && this.command?.start && !this.command.end) {
        this.command.end = this.here();
        this.command.status = Number(arg);
      }
      if (this.state !== "exited") this.state = "idle";
    }
  }

  private write(data: Buffer): Promise<void> {
    return new Promise((r) => this.term.write(data, r));
  }

  /** Read what the terminal printed since the last call (and type what is given). */
  async sync(exec: KernelExec, input = "", file?: { name: string; text: string }): Promise<void> {
    const write = this.replies + input;
    this.replies = "";
    for (let first = true; ; first = false) {
      const r = await call<StepReply>(exec, "step", this.name, {
        offset: this.offset,
        max: READ_CHUNK,
        write: first && write ? Buffer.from(write, "utf8").toString("base64") : "",
        file: first ? file : undefined,
      });
      const bytes = Buffer.from(r.data, "base64");
      if (bytes.length) {
        await this.write(bytes);
        this.offset += bytes.length;
      }
      if (!r.alive) {
        if (r.exists === false || r.size < this.offset) {
          // The session's files are gone: a new machine, or someone removed them.
          this.state = "exited";
          this.exitCode = r.exit ?? undefined;
          return;
        }
        if (this.offset >= r.size) {
          this.state = "exited";
          this.exitCode = r.exit ?? undefined;
          return;
        }
        continue;
      }
      if (this.offset >= r.size || !bytes.length) return;
    }
  }

  /**
   * Start the shell, or pick up one that runs from before the bridge restarted.
   * A new shell starts in `start.cwd` with `start.env` added to its environment.
   */
  async open(exec: KernelExec, deadline: number, start: ShellStart = {}): Promise<void> {
    if (this.state !== "new" && this.state !== "exited") return;
    this.reset();
    this.state = "new";
    this.exitCode = undefined;
    const r = await call<{ state: string; size: number; log?: string }>(exec, "open", this.name, { daemon: DAEMON, cols: COLS, rows: ROWS, cwd: start.cwd, env: start.env });
    if (r.state === "failed") throw new VmError(`The terminal did not start on the notebook's machine.${r.log ? `\n${r.log}` : ""}`);
    if (r.state === "alive") {
      // Rebuild the screen from the end of the log; its marks say whether a command runs.
      this.offset = Math.max(0, r.size - REPLAY_BYTES);
      this.state = "idle";
      this.replaying = true;
      try {
        await this.sync(exec);
      } finally {
        this.replaying = false;
      }
      this.lastEnd = this.here();
      if (this.command?.end) this.command = undefined;
      return;
    }
    this.state = "starting";
    await this.sync(exec, INIT);
    await this.pollUntil(exec, () => this.state !== "starting", Math.min(deadline, Date.now() + 15_000));
    if (this.state === "starting") throw new VmError("The terminal started but did not answer.");
  }

  /** Read until `done` holds or the deadline passes. */
  async pollUntil(exec: KernelExec, done: () => boolean, deadline: number): Promise<{ paused: boolean }> {
    let delay = 100;
    let paused = false;
    for (;;) {
      try {
        await this.sync(exec);
      } catch (e) {
        if (!(e instanceof KernelBusy)) throw e;
        paused = true;
        delay = 1000;
      }
      if (done() || this.state === "exited" || Date.now() + delay > deadline) return { paused };
      await sleep(delay);
      delay = Math.min(1000, Math.round(delay * 1.5));
    }
  }

  /** Catch up with the log once (the session may have moved on since the last tool call). */
  async refresh(exec: KernelExec): Promise<{ paused: boolean }> {
    try {
      await this.sync(exec);
      return { paused: false };
    } catch (e) {
      if (e instanceof KernelBusy) return { paused: true };
      throw e;
    }
  }

  /** Type a command into the idle shell. */
  async start(exec: KernelExec, command: string): Promise<void> {
    if (this.state !== "idle") throw new VmError(`Session "${this.name}" is not idle.`);
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const dir = `/tmp/ainb-shell-$(id -u)/${this.name}`;
    const file = `cmd-${id}`;
    this.command = { id, command, startedAt: Date.now() };
    // The command travels as a file: a terminal line holds at most 4095 characters. The leading
    // space keeps the line out of the history; eval in the shell itself, so cd and export last.
    const line = ` __ainb_c="$(< ${dir}/${file})"; rm -f ${dir}/${file}; printf '\\033]${OSC};start;${id}\\007'; eval "$__ainb_c"\r`;
    await this.sync(exec, line, { name: file, text: command });
  }

  /**
   * Type into the running program. The machine's terminal does not echo (so
   * the commands the bridge types stay off the screen); typed text is put on
   * the screen here instead, as a terminal shows what one types.
   */
  async type(exec: KernelExec, text: string): Promise<void> {
    await this.sync(exec);
    const shown = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r/g, "\r\n");
    if (shown) await this.write(Buffer.from(shown, "utf8"));
    await this.sync(exec, text);
  }

  /** What happened since the last report. `final` keeps the command's whole output too. */
  report(paused: boolean): Report {
    const cmd = this.command;
    const out: Report = { state: this.state, command: cmd, text: "", paused };
    if (this.state === "exited") out.exitCode = this.exitCode;
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") {
      out.screen = true;
      out.text = this.lines(buf.baseY, 0, buf.baseY + this.term.rows - 1, this.term.cols);
      return out;
    }
    const cursor = this.here(false);
    if (cmd?.start) {
      if (this.lineOf(cmd.start) < 0) out.scrolledOut = true;
      // What was printed between the previous command and this one (background jobs).
      if (this.lastEnd && !cmd.reportFrom) {
        const between = this.between(this.lastEnd, cmd.start).trim();
        if (between) out.between = between;
      }
      out.text = this.between(cmd.reportFrom ?? cmd.start, cmd.end ?? cursor);
      if (cmd.end) {
        out.full = cmd.reportFrom ? this.between(cmd.start, cmd.end) : out.text;
        this.lastEnd = cmd.end;
        this.command = undefined;
      } else {
        // The line being written may still change: report it again next time.
        cmd.reportFrom = { ...this.here(), col: 0 };
        this.lastEnd = cmd.start;
      }
    } else if (this.lastEnd) {
      // No command of ours: what background jobs printed since.
      const text = this.between(this.lastEnd, cursor).trim();
      if (text) out.between = text;
      this.lastEnd = this.here();
    }
    return out;
  }

  private lineOf(p: Pos): number {
    if (!p.marker) return p.line;
    return p.marker.isDisposed ? -1 : p.marker.line;
  }

  private between(from: Pos, to: Pos): string {
    const a = this.lineOf(from);
    const b = this.lineOf(to);
    return this.lines(a < 0 ? 0 : a, a < 0 ? 0 : from.col, b < 0 ? 0 : b, b < 0 ? 0 : to.col);
  }

  /** Text from (line, col) to (line, col), wrapped lines joined, trailing blanks dropped. */
  private lines(l1: number, c1: number, l2: number, c2: number): string {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = l1; i <= l2 && i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const start = i === l1 ? c1 : 0;
      const end = i === l2 ? c2 : undefined;
      const text = line.translateToString(end === undefined, start, end);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  }

  async close(exec: KernelExec): Promise<void> {
    await call(exec, "close", this.name, {});
    this.term.dispose();
    this.state = "exited";
  }
}

/** The chat's sessions, by name, one operation at a time on each. */
export class ShellSessions {
  private readonly sessions = new Map<string, ShellSession>();
  private readonly locks = new Map<string, Promise<unknown>>();

  get(name: string): ShellSession {
    let s = this.sessions.get(name);
    if (!s) this.sessions.set(name, (s = new ShellSession(name)));
    return s;
  }

  names(): string[] {
    return [...this.sessions.keys()];
  }

  exclusive<T>(name: string, fn: (s: ShellSession) => Promise<T>): Promise<T> {
    const run = (this.locks.get(name) ?? Promise.resolve()).then(
      () => fn(this.get(name)),
      () => fn(this.get(name)),
    );
    this.locks.set(
      name,
      run.catch(() => {}),
    );
    return run;
  }
}
