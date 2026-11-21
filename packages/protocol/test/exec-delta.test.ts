// Đợt 2 protocol: execute_wait delta — generation tracking in OutputCollector,
// tail/rest deltas while running, invalidation on clear/truncate, full finals.

import { describe, expect, it } from "vitest";
import { Executions, OpRunner, OutputCollector, type Execution, type NotebookAdapter } from "../src/adapter.js";
import type { CellOutput, CellType, ExecResult, NotebookInfo, ReviewInfo, RunResult } from "../src/notebook.js";

const stream = (text: string, name = "stdout") => ({ output_type: "stream", name, text });
const result = (text: string) => ({ output_type: "execute_result", data: { "text/plain": text } });

function makeExec() {
  const collected = new OutputCollector();
  let finish!: (r: { status?: string; ename?: string; evalue?: string }) => void;
  const reply = new Promise<{ status?: string; ename?: string; evalue?: string }>((r) => (finish = r));
  const executions = new Executions();
  const execId = executions.add({ reply, collected });
  return { collected, executions, execId, finish };
}

describe("OutputCollector generation", () => {
  it("starts at 0 and stays while streams only append", () => {
    const c = new OutputCollector();
    expect(c.gen).toBe(0);
    c.add(stream("a"));
    c.add(stream("b"));
    c.add(result("3"));
    expect(c.gen).toBe(0);
  });

  it("grows on an immediate clear and on a deferred clear when it fires", () => {
    const c = new OutputCollector();
    c.add(stream("a"));
    c.clear();
    expect(c.gen).toBe(1);
    c.add(stream("b"));
    c.clear(true);
    expect(c.gen).toBe(1); // not cleared yet
    expect(c.outputs).toHaveLength(1);
    c.add(stream("c"));
    expect(c.gen).toBe(2);
    expect(c.outputs).toEqual([{ kind: "stream", name: "stdout", text: "c" }]);
  });

  it("grows when STREAM_MAX cuts a stream mid-way", () => {
    const c = new OutputCollector();
    c.add(stream("x".repeat(600_000)));
    expect(c.gen).toBe(0); // pushed whole, nothing cut yet
    c.add(stream("x".repeat(600_000))); // appending passes the limit: the middle is dropped
    expect(c.gen).toBe(1);
    expect(c.outputs[0]!.text).toMatch(/characters omitted/);
    c.add(stream("y"));
    expect(c.gen).toBe(2); // still over the limit: cut again
  });
});

describe("execute_wait delta", () => {
  it("returns full outputs plus gen when no since is given", async () => {
    const { collected, executions, execId } = makeExec();
    collected.add(stream("abc"));
    const r = await executions.wait(execId, 10);
    expect(r).toEqual({ status: "running", outputs: [{ kind: "stream", name: "stdout", text: "abc" }], execId, gen: 0 });
  });

  it("sends tail and rest when the generation matches a held stream", async () => {
    const { collected, executions, execId } = makeExec();
    collected.add(stream("abc"));
    collected.add(stream("def"));
    collected.add(result("42"));
    const r = await executions.wait(execId, 10, { gen: 0, n: 1, chars: 3 });
    expect(r.status).toBe("running");
    expect(r.outputs).toEqual([]);
    expect(r.gen).toBe(0);
    expect(r.delta).toEqual({ n: 1, chars: 3, tail: "def", rest: [{ kind: "result", text: "42", mimes: undefined }] });
  });

  it("replaces from n-1 when the held last output is not a stream", async () => {
    const { collected, executions, execId } = makeExec();
    collected.add(stream("abc"));
    collected.add(result("42"));
    const r = await executions.wait(execId, 10, { gen: 0, n: 2, chars: 0 });
    expect(r.delta).toEqual({ n: 2, chars: 0, tail: "", rest: [{ kind: "result", text: "42", mimes: undefined }] });
  });

  it("sends everything as rest when the client holds nothing (n = 0)", async () => {
    const { collected, executions, execId } = makeExec();
    collected.add(stream("abc"));
    const r = await executions.wait(execId, 10, { gen: 0, n: 0, chars: 0 });
    expect(r.delta).toEqual({ n: 0, chars: 0, tail: "", rest: [{ kind: "stream", name: "stdout", text: "abc" }] });
  });

  it("falls back to full when a clear changed the generation", async () => {
    const { collected, executions, execId } = makeExec();
    collected.add(stream("abc"));
    collected.clear();
    collected.add(stream("new"));
    const r = await executions.wait(execId, 10, { gen: 0, n: 1, chars: 3 });
    expect(r.delta).toBeUndefined();
    expect(r).toEqual({ status: "running", outputs: [{ kind: "stream", name: "stdout", text: "new" }], execId, gen: 1 });
    // With the new generation the delta works again.
    collected.add(stream("more"));
    const d = await executions.wait(execId, 10, { gen: 1, n: 1, chars: 3 });
    expect(d.delta).toEqual({ n: 1, chars: 3, tail: "more", rest: [] });
  });

  it("falls back to full when STREAM_MAX truncated the held stream", async () => {
    const { collected, executions, execId } = makeExec();
    collected.add(stream("head"));
    const first = await executions.wait(execId, 10);
    expect(first.gen).toBe(0);
    collected.add(stream("x".repeat(1_100_000)));
    const r = await executions.wait(execId, 10, { gen: 0, n: 1, chars: 4 });
    expect(r.delta).toBeUndefined();
    expect(r.gen).toBe(1);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs![0]!.text).toMatch(/characters omitted/);
  });

  it("always returns the full result with gen once finished, even with a matching since", async () => {
    const { collected, executions, execId, finish } = makeExec();
    collected.add(stream("abc"));
    finish({ status: "ok" });
    const r = await executions.wait(execId, 10, { gen: 0, n: 1, chars: 1 });
    expect(r).toEqual({ status: "ok", outputs: [{ kind: "stream", name: "stdout", text: "abc" }], gen: 0 });
    await expect(executions.wait(execId, 10)).rejects.toThrow(/No execution/);
  });

  it("a client merging deltas ends up with exactly the full output list", async () => {
    const { collected, executions, execId, finish } = makeExec();
    // The client's copy, built only from what the waits hand back.
    let held: CellOutput[] = [];
    let state = { gen: 0, n: 0, chars: 0 };
    const merge = (r: ExecResult) => {
      if (r.delta) {
        const { n, chars, tail, rest } = r.delta;
        if (tail) {
          const last = held[n - 1]!;
          held[n - 1] = { ...last, text: (last.text ?? "").slice(0, chars) + tail };
        }
        held = [...held.slice(0, n), ...rest];
        const last = held.at(-1);
        state = { gen: r.gen!, n: held.length, chars: last?.kind === "stream" ? (last.text ?? "").length : 0 };
      } else {
        held = r.outputs!.map((o) => ({ ...o }));
        const last = held.at(-1);
        state = { gen: r.gen!, n: held.length, chars: last?.kind === "stream" ? (last.text ?? "").length : 0 };
      }
    };
    collected.add(stream("abc"));
    merge(await executions.wait(execId, 10, state));
    collected.add(stream("def"));
    collected.add(result("1"));
    merge(await executions.wait(execId, 10, state));
    collected.add(stream("ghi"));
    merge(await executions.wait(execId, 10, state));
    collected.clear(); // a clear invalidates the client's copy
    collected.add(stream("fresh"));
    merge(await executions.wait(execId, 10, state));
    collected.add(stream(" end"));
    finish({ status: "ok" });
    const final = await executions.wait(execId, 10, state);
    expect(final.delta).toBeUndefined();
    merge(final);
    expect(held).toEqual(final.outputs);
    expect(held).toEqual([
      { kind: "stream", name: "stdout", text: "fresh end" },
    ]);
  });
});

// The op itself hands `since` through to Executions.
class ExecAdapter implements NotebookAdapter {
  readonly platform = "jupyter" as const;
  collected = new OutputCollector();
  finish!: (r: { status?: string }) => void;
  private reply = new Promise<{ status?: string }>((r) => (this.finish = r));
  info(): NotebookInfo {
    return { platform: "jupyter", title: "t", url: "u", cellCount: 0, activeCellId: null, selectedCellIds: [], kernel: "idle", language: "python" };
  }
  getCells(): { id: string; index: number; type: CellType; source: string }[] {
    return [];
  }
  setSource() {
    return false;
  }
  async insertCell() {
    return "x";
  }
  deleteCell() {}
  moveCell(_id: string, index: number) {
    return index;
  }
  async runCell(id: string): Promise<RunResult> {
    return { cellId: id, status: "ok", outputs: [] };
  }
  async startExecution(): Promise<Execution> {
    return { reply: this.reply, collected: this.collected };
  }
  interrupt() {
    return false;
  }
  focusCell() {
    return false;
  }
  showReview(_review: ReviewInfo) {
    return { decided: Promise.resolve(false), resolve: () => {} };
  }
  onSelectionChange() {}
}

describe("execute_wait op with since", () => {
  it("passes since through and deltas while running", async () => {
    const adapter = new ExecAdapter();
    const runner = new OpRunner(adapter, () => {}, { pollMs: null });
    adapter.collected.add(stream("abc"));
    const first = (await runner.run({ op: "execute", code: "loop()", waitMs: 10 })) as ExecResult;
    expect(first.status).toBe("running");
    expect(first.gen).toBe(0);
    adapter.collected.add(stream("def"));
    const delta = (await runner.run({ op: "execute_wait", execId: first.execId!, waitMs: 10, since: { gen: 0, n: 1, chars: 3 } })) as ExecResult;
    expect(delta.delta).toEqual({ n: 1, chars: 3, tail: "def", rest: [] });
    adapter.finish({ status: "ok" });
    const final = (await runner.run({ op: "execute_wait", execId: first.execId!, waitMs: 10, since: { gen: 0, n: 1, chars: 6 } })) as ExecResult;
    expect(final).toEqual({ status: "ok", outputs: [{ kind: "stream", name: "stdout", text: "abcdef" }], gen: 0 });
    runner.dispose();
  });
});