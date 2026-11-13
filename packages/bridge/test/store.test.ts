import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@ainb/protocol";
import { ChatStore, pruneDir } from "../src/store.js";

const msg = (parts: ChatMessage["parts"], role: ChatMessage["role"] = "agent"): ChatMessage => ({ id: Math.random().toString(36), role, parts, createdAt: 1 });

describe("ChatStore", () => {
  it("round-trips a transcript by notebook key and keeps keys apart", () => {
    const store = new ChatStore(mkdtempSync(join(tmpdir(), "ainb-store-")));
    const messages = [msg([{ type: "text", text: "hi" }], "user"), msg([{ type: "text", text: "hello" }])];
    store.save({ key: "colab:/drive/a", agentId: "claude", messages });
    expect(store.load("colab:/drive/a")?.messages.map((m) => m.parts)).toEqual(messages.map((m) => m.parts));
    expect(store.load("colab:/drive/b")).toBeNull();
    store.remove("colab:/drive/a");
    expect(store.load("colab:/drive/a")).toBeNull();
  });

  it("settles what was still waiting when the transcript was saved", () => {
    const store = new ChatStore(mkdtempSync(join(tmpdir(), "ainb-store-")));
    const review = { reviewId: "r1", cellId: "c1", kind: "update" as const, cellType: "code" as const, before: "a", after: "b" };
    store.save({
      key: "k",
      agentId: "fake",
      messages: [
        msg([
          { type: "prompt", promptId: "p1", title: "Run?", options: [] },
          { type: "review", review, status: "pending" },
          { type: "tool", toolCallId: "t1", title: "x", status: "in_progress" },
          { type: "review", review: { ...review, reviewId: "r2" }, status: "accepted" },
        ]),
      ],
    });
    const parts = store.load("k")!.messages[0]!.parts;
    expect(parts.map((p) => (p.type === "prompt" ? p.answer : "status" in p ? p.status : null))).toEqual(["cancelled", "discarded", "failed", "accepted"]);
  });

  it("keeps only the most recent messages", () => {
    const store = new ChatStore(mkdtempSync(join(tmpdir(), "ainb-store-")));
    const messages = Array.from({ length: 250 }, (_, i) => msg([{ type: "text", text: `m${i}` }]));
    store.save({ key: "k", agentId: "fake", messages });
    const loaded = store.load("k")!.messages;
    expect(loaded).toHaveLength(200);
    expect(loaded.at(-1)!.parts[0]).toEqual({ type: "text", text: "m249" });
  });

  it("ignores a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ainb-store-"));
    const store = new ChatStore(dir);
    store.save({ key: "k", agentId: "fake", messages: [msg([{ type: "text", text: "x" }])] });
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file!), "{ broken");
    expect(store.load("k")).toBeNull();
  });
});

describe("pruneDir", () => {
  it("removes only entries older than the cutoff, sparing kept names", () => {
    const dir = mkdtempSync(join(tmpdir(), "ainb-prune-"));
    const old = new Date(Date.now() - 40 * 24 * 3600_000);
    for (const name of ["old-ws", "fresh-ws", "old-keep"]) mkdirSync(join(dir, name));
    utimesSync(join(dir, "old-ws"), old, old);
    utimesSync(join(dir, "old-keep"), old, old);
    expect(pruneDir(dir, 30 * 24 * 3600_000, (n) => n.endsWith("keep"))).toBe(1);
    expect(existsSync(join(dir, "old-ws"))).toBe(false);
    expect(existsSync(join(dir, "fresh-ws"))).toBe(true);
    expect(existsSync(join(dir, "old-keep"))).toBe(true);
    expect(pruneDir(join(dir, "missing"), 1)).toBe(0);
  });
});
