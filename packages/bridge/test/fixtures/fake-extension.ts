// An in-memory notebook and a WebSocket client that plays the browser extension.

import WebSocket from "ws";
import {
  RpcPeer,
  WIRE_VERSION,
  type CellInfo,
  type CellOutput,
  type ChatMessage,
  type ChatSnapshot,
  type Envelope,
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
  apply(): void;
  revert(): void;
}

export class FakeNotebook {
  cells: Cell[] = [];
  activeCellId: string | null = null;
  reviews = new Map<string, PendingReview>();
  ran: string[] = [];
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
      kernel: "idle",
      language: "python",
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

  private openReview(info: Omit<ReviewInfo, "reviewId">, apply: () => void, revert: () => void): string {
    const reviewId = `r${this.reviews.size + 1}-${Date.now() % 10000}`;
    const review = { ...info, reviewId };
    this.reviews.set(reviewId, { info: review, apply, revert });
    this.onEvent({ type: "review_opened", review });
    return reviewId;
  }

  resolve(reviewId: string, accept: boolean): boolean {
    const r = this.reviews.get(reviewId);
    if (!r) return false;
    this.reviews.delete(reviewId);
    if (accept) r.apply();
    else r.revert();
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
        return { cells: list.map((c) => this.cellInfo(c, !!op.includeOutputs)) };
      }
      case "update_cell": {
        const c = this.find(op.cellId);
        if (c.source === op.source) return { applied: false };
        if (!op.review) {
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
        if (!op.review) return { applied: true, cellId: cell.id };
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
        this.cells = this.cells.filter((x) => x !== c);
        const index = Math.min(op.index, this.cells.length);
        this.cells.splice(index, 0, c);
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
    this.rpc.on("chat.message", (p: { message: ChatMessage }) => this.messages.set(p.message.id, p.message));
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
