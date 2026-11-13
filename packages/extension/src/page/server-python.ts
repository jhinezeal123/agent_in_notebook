// Python on the notebook's machine, reached through one of the notebook
// server's own terminals rather than through the kernel. The kernel runs one
// request at a time, so while a cell runs nothing else gets through it; the
// server's terminals are served by the server itself and stay free.
//
// A terminal is a shell in a pseudo-terminal, which suits people, not
// programs. So the first thing typed into it replaces the shell with a small
// Python loop that switches the terminal to raw mode (no echo, no line
// editing, no line length limit) and then serves requests: one base64 JSON
// line in ({id, code}), one marked JSON line out ({id, out, error}), with
// `out` what the code printed. The page shuts the terminal down when it goes;
// should that not get through, the loop ends after 15 idle minutes, and the
// server drops a terminal whose process ended.

import type { ExecResult } from "@ainb/protocol";
import { NoServerPython, OpError, within } from "@ainb/protocol";

/** A terminal of the notebook server, as the page's Jupyter app gives it. */
export interface TerminalLink {
  send(text: string): void;
  onOutput(cb: (text: string) => void): void;
  /** The terminal ended or its connection dropped for good. */
  onClose(cb: () => void): void;
  close(): void;
}

const READY = "\u001eainb-ready";
const RESP = "\u001eainb-resp ";
/** How long the loop may take to start (a fresh terminal, a slow server). */
const START_MS = 20_000;
/** After failing to start, try again only after this long. */
const RETRY_MS = 60_000;

const LOOP = String.raw`
import base64, contextlib, io, json, os, select, sys, traceback
IDLE = 900
try:
    import tty
    tty.setraw(0)
except Exception:
    pass
w = sys.stdout.buffer
def send(s):
    w.write(s.encode())
    w.flush()
send("\n\x1eainb-ready\n")
buf = b""
while True:
    # Idle for long (its page is gone, say): end, which ends the terminal too. A page opens a new one when it needs it.
    try:
        if not select.select([0], [], [], IDLE)[0]:
            break
    except OSError:
        pass
    try:
        data = os.read(0, 1 << 20)
    except InterruptedError:
        continue
    if not data:
        break
    buf += data
    while True:
        i = buf.find(b"\n")
        if i < 0:
            break
        line, buf = buf[:i].strip(), buf[i + 1:]
        if not line:
            continue
        try:
            req = json.loads(base64.b64decode(line))
        except Exception:
            continue
        out, err = io.StringIO(), None
        try:
            with contextlib.redirect_stdout(out):
                exec(req["code"], {"__name__": "__ainb__"})
        except BaseException:
            err = traceback.format_exc()[-4000:]
        send("\n\x1eainb-resp " + json.dumps({"id": req["id"], "out": out.getvalue(), "error": err}) + "\n")
`;

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Typed into the terminal's shell: replace it with the loop (the leading space keeps it out of history). */
export function bootLine(): string {
  return ` exec "$(command -v python3 || command -v python)" -u -c 'import base64;exec(base64.b64decode("${base64(LOOP)}"))'\r`;
}

interface Reply {
  out: string;
  error: string | null;
}

export class ServerPython {
  private link: TerminalLink | null = null;
  private starting: Promise<TerminalLink> | null = null;
  private buf = "";
  private ready: (() => void) | null = null;
  private readonly waiting = new Map<number, (r: Reply) => void>();
  private seq = 0;
  private failedAt = 0;

  constructor(private readonly open: () => Promise<TerminalLink>) {}

  /** False for a while after the loop failed to start. */
  get usable(): boolean {
    return Date.now() - this.failedAt > RETRY_MS;
  }

  /** Run `code` and return what it printed, as an `execute` would. Throws NoServerPython when this way is not open. */
  async run(code: string, waitMs: number): Promise<ExecResult> {
    const link = await this.connect();
    const id = ++this.seq;
    const reply = new Promise<Reply>((resolve) => this.waiting.set(id, resolve));
    link.send(`${base64(JSON.stringify({ id, code }))}\n`);
    const r = await within(reply, waitMs);
    if (!r.done) {
      this.waiting.delete(id);
      throw new OpError("The notebook machine did not answer in time.");
    }
    const outputs: ExecResult["outputs"] = [{ kind: "stream", name: "stdout", text: r.value.out }];
    if (r.value.error === null) return { status: "ok", outputs };
    const last = r.value.error.trim().split("\n").at(-1) ?? "Error";
    const [ename, ...rest] = last.split(": ");
    return { status: "error", outputs: [...outputs, { kind: "error", ename: ename ?? "Error", evalue: rest.join(": "), traceback: r.value.error }] };
  }

  close(): void {
    this.link?.close();
    this.drop();
  }

  private connect(): Promise<TerminalLink> {
    if (this.link) return Promise.resolve(this.link);
    if (!this.usable) return Promise.reject(new NoServerPython("The notebook server's terminal is not usable."));
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<TerminalLink> {
    let link: TerminalLink;
    try {
      link = await this.open();
    } catch (e) {
      this.failedAt = Date.now();
      throw new NoServerPython(`No terminal on the notebook server: ${(e as Error).message}`);
    }
    this.buf = "";
    const ready = new Promise<void>((r) => (this.ready = r));
    link.onOutput((t) => this.receive(t));
    link.onClose(() => {
      if (this.link === link) this.drop();
    });
    link.send(bootLine());
    if (!(await within(ready, START_MS)).done) {
      this.failedAt = Date.now();
      link.close();
      throw new NoServerPython("Python did not start in the notebook server's terminal.");
    }
    this.link = link;
    return link;
  }

  /** The terminal is gone: whatever waits gets an error, the next run opens a new one. */
  private drop(): void {
    this.link = null;
    for (const [, resolve] of this.waiting) resolve({ out: "", error: "OSError: the notebook server's terminal closed" });
    this.waiting.clear();
  }

  private receive(text: string): void {
    // A reply can be a megabyte long, in many chunks: look for its end in the new text only.
    let from = this.buf.length;
    this.buf += text;
    for (;;) {
      const i = this.buf.indexOf("\n", from);
      if (i < 0) return;
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      from = 0;
      if (line.startsWith(READY)) {
        this.ready?.();
        this.ready = null;
      } else if (line.startsWith(RESP)) {
        try {
          const r = JSON.parse(line.slice(RESP.length)) as Reply & { id: number };
          this.waiting.get(r.id)?.({ out: r.out, error: r.error });
          this.waiting.delete(r.id);
        } catch {
          // a damaged line; its caller times out
        }
      }
    }
  }
}
