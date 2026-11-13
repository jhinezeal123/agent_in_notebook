// An in-memory notebook and a WebSocket client that plays the browser extension.

import WebSocket from "ws";
import {
  RpcPeer,
  applyMessagePatch,
  summarizeCell,
  type ChatUsage,
  type MessagePatch,
  type AppliedChange,
  WIRE_VERSION,
  type CellInfo,
  type CellOutput,
  type ChatMessage,
  type ChatSnapshot,
  type Envelope,
  type ExecResult,
  type NotebookInfo,
  type NotebookOp,
  type ReviewInfo,
  type RunResult,
} from "@ainb/protocol";

export const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface Cell {
  id: string;
  type: "code" | "markdown";
  source: string;
  outputs: CellOutput[];
  executionCount: number | null;
}

interface PendingReview {
  info: ReviewInfo;
  index: number;
  apply(): void;
  revert(): void;
}

export class FakeNotebook {
  cells: Cell[] = [];
  activeCellId: string | null = null;
  reviews = new Map<string, PendingReview>();
  ran: string[] = [];
  /** Code run through the execute op by run_code (terminal calls go to `vm`). */
  executed: { code: string; waitMs: number }[] = [];
  /** A busy kernel refuses execute, like the real adapters. */
  busy = false;
  language = "python";
  /** The machine behind the kernel, for the terminal tools. */
  vm = new FakeVm();
  /** What run_code's execute returns. */
  execResult: (code: string) => ExecResult = () => ({ status: "ok", outputs: [{ kind: "result", text: "42" }] });
  /** Results execute_wait hands out, by exec id. */
  execWaits = new Map<string, ExecResult[]>();
  private nextId = 1;
  private exec = 0;
  onEvent: (e: unknown) => void = () => {};

  constructor(cells: { type: "code" | "markdown"; source: string }[]) {
    for (const c of cells) this.cells.push({ id: `c${this.nextId++}`, type: c.type, source: c.source, outputs: [], executionCount: null });
    this.activeCellId = this.cells[0]?.id ?? null;
  }

  info(): NotebookInfo {
    return {
      platform: "colab",
      title: "test.ipynb",
      url: "https://colab.research.google.com/drive/test",
      cellCount: this.cells.length,
      activeCellId: this.activeCellId,
      selectedCellIds: this.activeCellId ? [this.activeCellId] : [],
      kernel: this.busy ? "busy" : "idle",
      language: this.language,
    };
  }

  private cellInfo(c: Cell, includeOutputs: boolean): CellInfo {
    return {
      id: c.id,
      index: this.cells.indexOf(c),
      type: c.type,
      source: c.source,
      executionCount: c.executionCount,
      outputs: includeOutputs ? c.outputs.map((o) => ({ ...o })) : undefined,
      pendingReview: [...this.reviews.values()].some((r) => r.info.cellId === c.id),
    };
  }

  private find(id: string): Cell {
    const c = this.cells.find((x) => x.id === id);
    if (!c) throw new Error(`No cell was found with ID "${id}".`);
    return c;
  }

  /** Like the page's OpRunner: report each change applied for the agent. */
  private journal(change: AppliedChange, byUser?: boolean) {
    if (!byUser) this.onEvent({ type: "change_applied", change });
  }

  private openReview(info: Omit<ReviewInfo, "reviewId">, apply: () => void, revert: () => void): string {
    const reviewId = `r${this.reviews.size + 1}-${Date.now() % 10000}`;
    const review = { ...info, reviewId };
    const index = this.cells.findIndex((c) => c.id === info.cellId);
    this.reviews.set(reviewId, { info: review, index, apply, revert });
    this.onEvent({ type: "review_opened", review });
    return reviewId;
  }

  resolve(reviewId: string, accept: boolean): boolean {
    const r = this.reviews.get(reviewId);
    if (!r) return false;
    this.reviews.delete(reviewId);
    if (accept) {
      r.apply();
      const { kind, cellId, cellType, before, after } = r.info;
      this.journal({ kind, cellId, cellType, index: r.index, before, after, reviewId });
    } else r.revert();
    this.onEvent({ type: "review_closed", reviewId, accepted: accept });
    return true;
  }

  handle(op: NotebookOp): unknown {
    switch (op.op) {
      case "info":
        return this.info();
      case "get_cells": {
        let list = this.cells;
        if (op.cellIds) list = op.cellIds.map((id) => this.cells.find((c) => c.id === id)).filter((c): c is Cell => !!c);
        else if (op.start !== undefined || op.end !== undefined) list = this.cells.slice(op.start ?? 0, (op.end ?? this.cells.length - 1) + 1);
        const cells = list.map((c) => this.cellInfo(c, !!op.includeOutputs && !op.summary));
        return { cells: op.summary ? cells.map(summarizeCell) : cells };
      }
      case "update_cell": {
        const c = this.find(op.cellId);
        if (c.source === op.source) return { applied: false };
        if (!op.review) {
          this.journal({ kind: "update", cellId: c.id, cellType: c.type, index: this.cells.indexOf(c), before: c.source, after: op.source }, op.byUser);
          c.source = op.source;
          return { applied: true };
        }
        const before = c.source;
        const reviewId = this.openReview(
          { cellId: c.id, kind: "update", cellType: c.type, before, after: op.source },
          () => (c.source = op.source),
          () => (c.source = before),
        );
        return { applied: false, reviewId };
      }
      case "insert_cell": {
        const cell: Cell = { id: `c${this.nextId++}`, type: op.cellType, source: op.source, outputs: [], executionCount: null };
        this.cells.splice(Math.min(op.index, this.cells.length), 0, cell);
        if (!op.review) {
          this.journal({ kind: "insert", cellId: cell.id, cellType: cell.type, index: this.cells.indexOf(cell), before: "", after: op.source }, op.byUser);
          return { applied: true, cellId: cell.id };
        }
        const reviewId = this.openReview(
          { cellId: cell.id, kind: "insert", cellType: cell.type, before: "", after: op.source },
          () => {},
          () => (this.cells = this.cells.filter((c) => c !== cell)),
        );
        return { applied: false, cellId: cell.id, reviewId };
      }
      case "delete_cell": {
        const c = this.find(op.cellId);
        if (!op.review) {
          this.journal({ kind: "delete", cellId: c.id, cellType: c.type, index: this.cells.indexOf(c), before: c.source, after: "" }, op.byUser);
          this.cells = this.cells.filter((x) => x !== c);
          return { applied: true };
        }
        const reviewId = this.openReview(
          { cellId: c.id, kind: "delete", cellType: c.type, before: c.source, after: "" },
          () => (this.cells = this.cells.filter((x) => x !== c)),
          () => {},
        );
        return { applied: false, reviewId };
      }
      case "move_cell": {
        const c = this.find(op.cellId);
        const from = this.cells.indexOf(c);
        this.cells = this.cells.filter((x) => x !== c);
        const index = Math.min(op.index, this.cells.length);
        this.cells.splice(index, 0, c);
        if (index !== from) this.journal({ kind: "move", cellId: c.id, cellType: c.type, index: from, toIndex: index, before: "", after: "" }, op.byUser);
        return { index };
      }
      case "run_cells": {
        const results: RunResult[] = [];
        for (const id of op.cellIds) {
          const c = this.find(id);
          this.ran.push(id);
          c.executionCount = ++this.exec;
          if (c.source.includes("raise")) {
            results.push({ cellId: id, status: "error", executionCount: c.executionCount, outputs: [{ kind: "error", ename: "ValueError", evalue: "boom", traceback: "Traceback..." }] });
            if (op.stopOnError) break;
            continue;
          }
          c.outputs = [{ kind: "stream", name: "stdout", text: `ran ${c.source}\n` }];
          // "plot" cells draw a (tiny, valid) PNG, like matplotlib would.
          if (c.source.includes("plot")) c.outputs.push({ kind: "display", text: "<Figure size 640x480>", image: { mime: "image/png", data: TINY_PNG } });
          results.push({ cellId: id, status: "ok", executionCount: c.executionCount, outputs: c.outputs });
        }
        return { results };
      }
      case "execute":
        if (this.busy) throw new Error("The kernel is busy running a cell, so this would wait behind it.");
        if (op.code.includes("_ainb_shell")) return this.vm.handle(op.code);
        this.executed.push({ code: op.code, waitMs: op.waitMs });
        return this.execResult(op.code);
      case "execute_wait": {
        const next = this.execWaits.get(op.execId)?.shift();
        if (!next) throw new Error(`No execution "${op.execId}" here.`);
        return next;
      }
      case "interrupt":
        return { interrupted: false };
      case "focus_cell":
        this.activeCellId = op.cellId;
        return { focused: true };
      case "resolve_review":
        return { resolved: this.resolve(op.reviewId, op.accept) };
    }
  }
}

export class FakeExtension {
  ws!: WebSocket;
  rpc!: RpcPeer;
  messages = new Map<string, ChatMessage>();
  snapshots: ChatSnapshot[] = [];
  patches: MessagePatch[] = [];
  usage: ChatUsage | undefined;
  statuses: string[] = [];
  /** Accept (true) / reject (false) every review as it opens, or leave pending (undefined). */
  autoReview: boolean | undefined = undefined;

  constructor(
    readonly notebook: FakeNotebook,
    readonly tabId = 7,
  ) {}

  async connect(port: number, token: string, origin = "chrome-extension://abcdef"): Promise<unknown> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.rpc = new RpcPeer({ send: (env: Envelope) => this.ws.send(JSON.stringify(env)) });
    this.ws.on("message", (d) => void this.rpc.receive(JSON.parse(String(d))));
    this.rpc.handle("notebook.op", ({ tabId, op }: { tabId: number; op: NotebookOp }) => {
      if (tabId !== this.tabId) throw new Error("no notebook in that tab");
      return this.notebook.handle(op);
    });
    this.rpc.on("chat.patch", (p: MessagePatch) => {
      const old = this.messages.get(p.id);
      const next = applyMessagePatch(old ? [old] : [], p);
      if (!next) throw new Error(`patch for ${p.id} does not apply`);
      this.messages.set(p.id, next.find((m) => m.id === p.id)!);
      this.patches.push(p);
    });
    this.rpc.on("chat.usage", (p: { usage: ChatUsage }) => (this.usage = p.usage));
    this.rpc.on("chat.snapshot", (p: ChatSnapshot) => this.snapshots.push(p));
    this.rpc.on("chat.status", (p: { status: string }) => this.statuses.push(p.status));
    this.notebook.onEvent = (event) => {
      this.rpc.emit("notebook.event", { tabId: this.tabId, event });
      const e = event as { type: string; review?: ReviewInfo };
      if (e.type === "review_opened" && this.autoReview !== undefined) {
        const id = e.review!.reviewId;
        const accept = this.autoReview;
        setTimeout(() => this.notebook.resolve(id, accept), 30);
      }
    };
    return this.rpc.request("hello", { token, wire: WIRE_VERSION, extensionVersion: "test" });
  }

  request<T>(method: string, params: unknown): Promise<T> {
    return this.rpc.request<T>(method, params, 60_000);
  }

  /** Concatenated text of all agent messages so far. */
  agentText(): string {
    return [...this.messages.values()]
      .filter((m) => m.role === "agent")
      .flatMap((m) => m.parts)
      .map((p) => (p.type === "text" ? p.text : p.type === "notice" ? `[notice ${p.text}]` : ""))
      .join("");
  }

  parts() {
    return [...this.messages.values()].flatMap((m) => m.parts);
  }

  async waitFor(pred: () => boolean, ms = 30_000, what = "condition"): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}. Agent text so far:\n${this.agentText()}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close() {
    this.ws?.close();
  }
}

const OSC = (s: string) => `\u001b]7770;${s}\u0007`;

interface FakeShell {
  log: string;
  alive: boolean;
  exit: number | null;
  files: Map<string, string>;
  /** Typed input not yet read by a line-reading program. */
  line: string;
  /** What the running command does with the next line typed, or with Ctrl+C. */
  running?: { onLine?(line: string): void; onInterrupt(): void };
}

/**
 * The notebook machine as the terminal tools see it: answers the kernel
 * snippets the bridge sends (open, step, close) with a scripted bash. Commands:
 * `echo X`, `fail`, `progress`, `forever` (until Ctrl+C), `ask` (a y/N prompt),
 * `bg` (a background job that prints later, see `background`), `exit`.
 */
export class FakeVm {
  shells = new Map<string, FakeShell>();
  /** Commands as the shell received them. */
  commands: string[] = [];
  /** Kernel snippets seen, by operation. */
  ops: string[] = [];

  handle(code: string): ExecResult {
    const body = JSON.parse(code.match(/^exec\((".*"), \{"__name__": "__ainb__"\}\)$/s)![1]!) as string;
    const m = body.match(/_ainb_shell\(("[^"]*"), ("[^"]*"), _json\.loads\((".*")\)\)\n$/s)!;
    const op = JSON.parse(m[1]!) as string;
    const name = JSON.parse(m[2]!) as string;
    const args = JSON.parse(JSON.parse(m[3]!)) as Record<string, any>;
    this.ops.push(op);
    let res: Record<string, unknown>;
    if (op === "open") {
      const sh = this.shells.get(name);
      if (sh?.alive) res = { state: "alive", size: sh.log.length };
      else {
        this.shells.set(name, { log: "root@vm:/content# ", alive: true, exit: null, files: new Map(), line: "" });
        res = { state: "started", size: 0 };
      }
    } else if (op === "close") {
      this.shells.delete(name);
      res = { closed: true };
    } else {
      const sh = this.shells.get(name);
      if (!sh) res = { size: 0, data: "", alive: false, exit: null, exists: false };
      else {
        if (args.file && sh.alive) sh.files.set(args.file.name, args.file.text);
        if (args.write && sh.alive) this.type(sh, Buffer.from(args.write, "base64").toString("utf8"));
        const chunk = sh.log.slice(args.offset, args.offset + args.max);
        res = { size: sh.log.length, data: Buffer.from(chunk, "latin1").toString("base64"), alive: sh.alive, exit: sh.exit, exists: true };
      }
    }
    return { status: "ok", outputs: [{ kind: "stream", name: "stdout", text: `\u001eainb-shell ${JSON.stringify(res)}\n` }] };
  }

  /** Print from a background job of a session. */
  background(name: string, text: string): void {
    this.shells.get(name)!.log += text;
  }

  private type(sh: FakeShell, data: string): void {
    for (const ch of data) {
      if (ch === "\u0003") {
        sh.line = "";
        sh.running?.onInterrupt();
        continue;
      }
      if (ch !== "\r") {
        sh.line += ch;
        continue;
      }
      const line = sh.line;
      sh.line = "";
      if (sh.running?.onLine) sh.running.onLine(line);
      else if (!sh.running) this.shellLine(sh, line);
    }
  }

  private prompt(sh: FakeShell, status: number): void {
    sh.running = undefined;
    sh.log += OSC(`prompt;${status}`);
  }

  private shellLine(sh: FakeShell, line: string): void {
    if (line.includes("stty -echo")) {
      sh.log += line + "\r\n" + OSC("ready") + OSC("prompt;0");
      return;
    }
    const m = line.match(/\$\(< .+?\/(cmd-\w+)\)".*start;(\w+)/);
    if (!m) throw new Error(`unexpected line typed into the shell: ${line}`);
    const command = sh.files.get(m[1]!)!;
    sh.files.delete(m[1]!);
    this.commands.push(command);
    sh.log += OSC(`start;${m[2]}`);
    const [word, ...rest] = command.split(" ");
    switch (word) {
      case "echo":
        sh.log += `${rest.join(" ")}\r\n`;
        return this.prompt(sh, 0);
      case "fail":
        sh.log += "boom\r\n";
        return this.prompt(sh, 1);
      case "progress":
        sh.log += "  0%|          | 0/100\r 50%|#####     | 50/100\r100%|##########| 100/100\r\nDone\r\n";
        return this.prompt(sh, 0);
      case "lines":
        for (let i = 1; i <= Number(rest[0]); i++) sh.log += `line ${i}\r\n`;
        return this.prompt(sh, 0);
      case "forever":
        sh.log += "working...\r\n";
        sh.running = { onInterrupt: () => ((sh.log += "^C\r\n"), this.prompt(sh, 130)) };
        return;
      case "ask":
        sh.log += "Continue? [y/N] ";
        sh.running = {
          onLine: (l) => {
            // No echo on the machine's terminal: the answer and its Enter do not show up here.
            sh.log += l === "y" ? "ok\r\n" : "Abort.\r\n";
            this.prompt(sh, l === "y" ? 0 : 1);
          },
          onInterrupt: () => this.prompt(sh, 130),
        };
        return;
      case "exit":
        sh.alive = false;
        sh.exit = Number(rest[0] ?? 0);
        sh.log += "exit\r\n";
        return;
      default:
        sh.log += `bash: ${word}: command not found\r\n`;
        return this.prompt(sh, 127);
    }
  }
}
