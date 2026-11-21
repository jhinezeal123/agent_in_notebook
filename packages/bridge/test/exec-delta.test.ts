// wait_for_code asks only for what is new (A2.4): the bridge keeps what it
// holds of a running execution, sends `since`, and merges the delta (a tail
// for the stream it holds, then the new outputs). A generation that moved on
// (clear_output, a stream cut mid-way) arrives as a full answer and replaces
// the copy; the final result is always full and clears the state.
//
// The fake answers execute/execute_wait with the protocol's own Executions and
// OutputCollector, so the deltas are exactly what a real page sends.

import { describe, expect, it } from "vitest";
import { Executions, OutputCollector, type ExecResult, type NotebookOp } from "@ainb/protocol";
import { callTool } from "../src/notebook/tools.js";
import { FakeNotebook } from "./fixtures/fake-extension.js";
import { context } from "./fixtures/tool-context.js";

const long = { waitMs: 60_000 };
const stream = (text: string) => ({ output_type: "stream", name: "stdout", text });
const display = (text: string) => ({ output_type: "display_data", data: { "text/plain": text } });

class DeltaFakeNotebook extends FakeNotebook {
  ops: NotebookOp[] = [];
  private executions = new Executions();
  private collectors = new Map<string, OutputCollector>();
  private replies = new Map<string, (r: { status?: string }) => void>();

  override handle(op: NotebookOp): unknown {
    this.ops.push(op);
    if (op.op === "execute" && !op.code.includes("_ainb_")) {
      return { status: "running", outputs: [], execId: this.start(), gen: 0 };
    }
    if (op.op === "execute_wait") {
      // The wire serializes every answer: the bridge never holds the page's own
      // objects (the collector keeps appending to its streams in place).
      return this.executions.wait(op.execId, op.waitMs, op.since).then((r) => JSON.parse(JSON.stringify(r)) as ExecResult);
    }
    return super.handle(op);
  }

  /** An execution the page started, without the bridge asking (a bridge restart, say). */
  start(): string {
    const collected = new OutputCollector();
    let resolve!: (r: { status?: string }) => void;
    const reply = new Promise<{ status?: string }>((r) => (resolve = r));
    const execId = this.executions.add({ reply, collected });
    this.collectors.set(execId, collected);
    this.replies.set(execId, resolve);
    return execId;
  }

  feed(execId: string, raw: unknown): void {
    this.collectors.get(execId)!.add(raw);
  }
  clear(execId: string): void {
    this.collectors.get(execId)!.clear();
  }
  finish(execId: string): void {
    this.replies.get(execId)!({ status: "ok" });
  }
  waits(): Extract<NotebookOp, { op: "execute_wait" }>[] {
    return this.ops.filter((o): o is Extract<NotebookOp, { op: "execute_wait" }> => o.op === "execute_wait");
  }
}

/** run_code, then the exec id it handed out. */
async function runCode(nb: DeltaFakeNotebook, ctx: ReturnType<typeof context>): Promise<string> {
  const res = await callTool(ctx, "run_code", { code: "train()", wait_seconds: 1 });
  expect(res.text).toMatch(/^still running after .* \(run id (exec-\d+)\)/);
  return res.text.match(/run id (exec-\d+)/)![1]!;
}

const wait = (ctx: ReturnType<typeof context>, runId: string) => callTool(ctx, "wait_for_code", { run_id: runId, wait_seconds: 1 });

describe("wait_for_code deltas", () => {
  it("merges a tail and new outputs across beats, and the final result is full", async () => {
    const nb = new DeltaFakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const id = await runCode(nb, ctx);
    expect(nb.waits()).toEqual([]);

    nb.feed(id, stream("epoch 1\n"));
    const first = await wait(ctx, id);
    expect(first.text).toMatch(/^still running.*\nepoch 1$/);
    // The first wait held nothing: since says so, and the whole output came as rest.
    expect(nb.waits()[0]!.since).toEqual({ gen: 0, n: 0, chars: 0 });

    nb.feed(id, stream("epoch 2\n"));
    const second = await wait(ctx, id);
    expect(second.text).toMatch(/^still running.*\nepoch 1\nepoch 2$/);
    expect(nb.waits()[1]!.since).toEqual({ gen: 0, n: 1, chars: 8 });

    nb.feed(id, display("fig"));
    const third = await wait(ctx, id);
    expect(third.text).toMatch(/^still running.*\nepoch 1\nepoch 2\n\nfig$/);
    expect(nb.waits()[2]!.since).toEqual({ gen: 0, n: 1, chars: 16 });

    nb.feed(id, stream("late\n"));
    nb.finish(id);
    const final = await wait(ctx, id);
    expect(final.text).toBe("ok\nepoch 1\nepoch 2\n\nfig\nlate");
    // The last output held was not a stream: chars is 0, and a delta's rest
    // would replace the output at n-1 whole.
    expect(nb.waits()[3]!.since).toEqual({ gen: 0, n: 2, chars: 0 });

    // The state is gone with the final result: the page no longer knows the id either.
    const gone = await wait(ctx, id);
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("No execution");
    expect(nb.waits()[4]!.since).toBeUndefined();
  });

  it("a clear_output invalidates the held copy: the full answer replaces it", async () => {
    const nb = new DeltaFakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const id = await runCode(nb, ctx);
    nb.feed(id, stream("a\n"));
    expect((await wait(ctx, id)).text).toMatch(/\na$/);

    nb.clear(id);
    nb.feed(id, stream("b\n"));
    const afterClear = await wait(ctx, id);
    expect(afterClear.text.endsWith("\nb")).toBe(true);
    // The generation moved on, so the page answered full; the next wait is a delta again.
    nb.feed(id, stream("c\n"));
    const next = await wait(ctx, id);
    expect(next.text).toMatch(/^still running.*\nb\nc$/);
    const waits = nb.waits();
    expect(waits[1]!.since).toEqual({ gen: 0, n: 1, chars: 2 });
    expect(waits[2]!.since).toEqual({ gen: 1, n: 1, chars: 2 });
    nb.finish(id);
    expect((await wait(ctx, id)).text).toBe("ok\nb\nc");
  });

  it("a stream cut mid-way (the page dropped its middle) arrives as full", async () => {
    const nb = new DeltaFakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const id = await runCode(nb, ctx);
    nb.feed(id, stream("start\n"));
    expect((await wait(ctx, id)).text).toMatch(/\nstart$/);
    // Past STREAM_MAX the collector drops the middle and bumps the generation.
    nb.feed(id, stream("x".repeat(1_100_000)));
    const cut = await wait(ctx, id);
    expect(cut.text).toContain("characters omitted");
    expect(cut.text).toContain("start");
    expect(nb.waits()[1]!.since!.gen).toBe(0);
    nb.finish(id);
    const final = await wait(ctx, id);
    expect(final.text).toContain("characters omitted");
    expect(nb.waits()[2]!.since!.gen).toBe(1);
  });

  it("without held state (a bridge restart) the first wait is full and seeds the next", async () => {
    const nb = new DeltaFakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const id = nb.start();
    nb.feed(id, stream("hello\n"));
    const first = await wait(ctx, id);
    expect(first.text).toMatch(/^still running.*\nhello$/);
    expect(nb.waits()[0]!.since).toBeUndefined();
    nb.feed(id, stream("again\n"));
    const second = await wait(ctx, id);
    expect(second.text).toMatch(/^still running.*\nhello\nagain$/);
    expect(nb.waits()[1]!.since).toEqual({ gen: 0, n: 1, chars: 6 });
    nb.finish(id);
    await wait(ctx, id);
  });

  it("a result kept for read_output does not grow when later deltas arrive", async () => {
    const nb = new DeltaFakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const id = await runCode(nb, ctx);
    const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`).join("");
    nb.feed(id, stream(lines(3000, "line")));
    const first = await wait(ctx, id);
    expect(first.text).toContain('read_output with cell_id "run-1"');
    nb.feed(id, stream(lines(3000, "more")));
    await wait(ctx, id);
    const page = await callTool(ctx, "read_output", { cell_id: "run-1", start_line: 2999, line_count: 3 });
    expect(page.text).toBe("Lines 2999-3000 of 3000.\n2999: line 2999\n3000: line 3000");
    nb.finish(id);
    await wait(ctx, id);
  });

  it("keeps at most 16 executions' state: the oldest is forgotten, not merged", async () => {
    const nb = new DeltaFakeNotebook([]);
    const ctx = context(nb, { overrides: long });
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) ids.push(await runCode(nb, ctx));
    // The first execution's state was evicted: its wait asks without since.
    const oldest = await wait(ctx, ids[0]!);
    expect(oldest.text).toMatch(/^still running/);
    expect(nb.waits()[0]!.since).toBeUndefined();
    // The newest is still held.
    await wait(ctx, ids[16]!);
    expect(nb.waits()[1]!.since).toEqual({ gen: 0, n: 0, chars: 0 });
    for (const id of ids) nb.finish(id);
  });
});
