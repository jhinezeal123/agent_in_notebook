import { describe, expect, it } from "vitest";
import { decide, DEFAULT_SETTINGS, type ChatSettings } from "../src/modes.js";
import { diffLines, diffStats, withContext } from "../src/diff.js";
import { normalizeIpynbOutputs, outputsToText } from "../src/outputs.js";
import { RpcPeer } from "../src/rpc.js";
import { capText } from "../src/text.js";
import type { Envelope } from "../src/wire.js";

describe("diffLines", () => {
  it("returns equal lines for identical text", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.op === "eq")).toBe(true);
    expect(d).toHaveLength(2);
  });

  it("finds a changed middle line", () => {
    const d = diffLines("import os\nx = 1\nprint(x)", "import os\nx = 2\nprint(x)");
    expect(d.map((l) => l.op)).toEqual(["eq", "del", "add", "eq"]);
    expect(d[1]).toMatchObject({ text: "x = 1", oldNo: 2 });
    expect(d[2]).toMatchObject({ text: "x = 2", newNo: 2 });
    expect(d[3]).toMatchObject({ oldNo: 3, newNo: 3 });
  });

  it("handles insertion into empty and deletion to empty", () => {
    expect(diffLines("", "a\nb").map((l) => l.op)).toEqual(["add", "add"]);
    expect(diffLines("a\nb", "").map((l) => l.op)).toEqual(["del", "del"]);
  });

  it("numbers suffix lines after an insertion", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(d.map((l) => l.op)).toEqual(["eq", "add", "eq"]);
    expect(d[2]).toMatchObject({ text: "c", oldNo: 2, newNo: 3 });
    expect(diffStats(d)).toEqual({ added: 1, removed: 0 });
  });

  it("collapses unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "LINE 10");
    const rows = withContext(diffLines(before, after), 2);
    expect(rows[0]).toEqual({ op: "skip", count: 8 });
    expect(rows.filter((r) => r.op !== "skip")).toHaveLength(6);
    expect(rows.at(-1)).toEqual({ op: "skip", count: 7 });
  });
});

describe("decide", () => {
  const s = (over: Partial<ChatSettings>): ChatSettings => ({ ...DEFAULT_SETTINGS, ...over });

  it("always allows reads", () => {
    expect(decide(s({ scope: "cell" }), "read", null, [])).toMatchObject({ allow: true });
  });

  it("cell scope only edits target cells", () => {
    expect(decide(s({ scope: "cell", review: false }), "update", "a", ["a"])).toEqual({ allow: true, review: false, askBeforeRun: false });
    const denied = decide(s({ scope: "cell" }), "update", "b", ["a"]);
    expect(denied.allow).toBe(false);
    expect(decide(s({ scope: "cell" }), "update", "a", []).allow).toBe(false);
    expect(decide(s({ scope: "cell" }), "insert", null, ["a"]).allow).toBe(false);
    expect(decide(s({ scope: "cell" }), "run", "a", ["a"]).allow).toBe(false);
  });

  it("write scope edits freely but never runs", () => {
    expect(decide(s({ scope: "write", review: true }), "insert", null, [])).toEqual({ allow: true, review: true, askBeforeRun: false });
    expect(decide(s({ scope: "write", review: true }), "move", "a", [])).toEqual({ allow: true, review: false, askBeforeRun: false });
    expect(decide(s({ scope: "write" }), "run", "a", []).allow).toBe(false);
    expect(decide(s({ scope: "write" }), "interrupt", null, []).allow).toBe(false);
  });

  it("auto scope runs, asking first only in review", () => {
    expect(decide(s({ scope: "auto", review: false }), "run", "a", [])).toEqual({ allow: true, review: false, askBeforeRun: false });
    expect(decide(s({ scope: "auto", review: true }), "run", "a", [])).toEqual({ allow: true, review: false, askBeforeRun: true });
    expect(decide(s({ scope: "auto", review: true }), "interrupt", null, [])).toEqual({ allow: true, review: false, askBeforeRun: false });
  });
});

describe("outputs", () => {
  const raw = [
    { output_type: "stream", name: "stdout", text: ["hello\n", "world\n"] },
    { output_type: "execute_result", data: { "text/plain": "42", "text/html": "<b>42</b>" }, execution_count: 1 },
    { output_type: "display_data", data: { "image/png": "iVBOR..." } },
    { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mTraceback\u001b[0m", "ValueError: bad"] },
    { output_type: "weird" },
  ];

  it("normalizes ipynb outputs and strips ANSI", () => {
    const outs = normalizeIpynbOutputs(raw);
    expect(outs).toHaveLength(4);
    expect(outs[0]).toEqual({ kind: "stream", name: "stdout", text: "hello\nworld\n" });
    expect(outs[1]).toEqual({ kind: "result", text: "42", mimes: ["text/html"] });
    expect(outs[2]).toEqual({ kind: "display", text: undefined, mimes: ["image/png"] });
    expect(outs[3]!.traceback).toBe("Traceback\nValueError: bad");
  });

  it("renders text for an agent", () => {
    const text = outputsToText(normalizeIpynbOutputs(raw));
    expect(text).toContain("hello\nworld");
    expect(text).toContain("[image/png output not shown]");
    expect(text).toContain("[error] ValueError: bad");
  });

  it("caps long text keeping head and tail", () => {
    const capped = capText("x".repeat(100) + "END", 50);
    expect(capped.length).toBeLessThan(120);
    expect(capped.endsWith("END")).toBe(true);
  });
});

describe("RpcPeer", () => {
  function pair() {
    let a!: RpcPeer;
    let b!: RpcPeer;
    a = new RpcPeer({ send: (e: Envelope) => queueMicrotask(() => void b.receive(JSON.parse(JSON.stringify(e)))) });
    b = new RpcPeer({ send: (e: Envelope) => queueMicrotask(() => void a.receive(JSON.parse(JSON.stringify(e)))) });
    return { a, b };
  }

  it("round-trips requests, errors and events", async () => {
    const { a, b } = pair();
    b.handle("add", ({ x, y }: { x: number; y: number }) => x + y);
    b.handle("boom", () => {
      throw new Error("nope");
    });
    expect(await a.request("add", { x: 2, y: 3 })).toBe(5);
    await expect(a.request("boom", {})).rejects.toThrow("nope");
    await expect(a.request("missing", {})).rejects.toThrow("unknown method missing");
    const seen: unknown[] = [];
    b.on("tick", (p) => seen.push(p));
    a.emit("tick", { n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ n: 1 }]);
  });

  it("times out and fails pending requests", async () => {
    const lost = new RpcPeer({ send: () => {} });
    await expect(lost.request("x", {}, 20)).rejects.toThrow("timed out");
    const p = lost.request("y", {}, 0);
    lost.failAll("closed");
    await expect(p).rejects.toThrow("closed");
  });
});
