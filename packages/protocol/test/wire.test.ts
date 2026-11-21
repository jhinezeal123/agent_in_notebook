// Đợt 2/3 wire types: the version bump and the queued mark on user messages.

import { describe, expect, it } from "vitest";
import { applyMessagePatch, WIRE_VERSION, type ChatMessage, type MessagePatch } from "../src/wire.js";

describe("wire version", () => {
  it("is 6 for the partial-sync batch", () => {
    expect(WIRE_VERSION).toBe(6);
  });
});

describe("queued mark through patches", () => {
  const base = { chatId: "c", tabId: 1, id: "u1", role: "user" as const, createdAt: 1 };
  const text = (t: string): MessagePatch["ops"] => [{ i: 0, part: { type: "text", text: t } }];

  it("sets the mark, keeps it through silent patches, and clears it when the turn begins", () => {
    let list: ChatMessage[] = [];
    list = applyMessagePatch(list, { ...base, length: 1, queued: true, ops: text("help") })!;
    expect(list[0]!.queued).toBe(true);
    list = applyMessagePatch(list, { ...base, length: 1, ops: [{ i: 0, at: 4, append: " me" }] })!;
    expect(list[0]!.queued).toBe(true); // a patch that says nothing keeps the mark
    expect(list[0]!.parts).toEqual([{ type: "text", text: "help me" }]);
    list = applyMessagePatch(list, { ...base, length: 1, queued: false, ops: [] })!;
    expect(list[0]!.queued).toBeUndefined();
  });

  it("keeps a mark a snapshot already carried, and leaves unqueued messages alone", () => {
    const snapshot: ChatMessage[] = [{ id: "u1", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }], queued: true }];
    const kept = applyMessagePatch(snapshot, { ...base, length: 1, ops: [{ i: 0, at: 2, append: "!" }] })!;
    expect(kept[0]!.queued).toBe(true);
    const plain = applyMessagePatch([], { ...base, length: 1, ops: text("hi") })!;
    expect(plain[0]!.queued).toBeUndefined();
    expect(plain).toEqual([{ id: "u1", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }] }]);
  });
});