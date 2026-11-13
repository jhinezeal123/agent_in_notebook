import { describe, expect, it } from "vitest";
import { normalizeIpynbOutputs, outputsToText } from "../src/outputs.js";
import { capLines, collapseCarriageReturns, hideDataUris, restoreDataUris, squeezeRepeats, wasShortened } from "../src/text.js";
import { applyMessagePatch, type ChatMessage, type MessagePatch } from "../src/wire.js";

describe("output text for agents", () => {
  it("keeps only the final state of a progress bar", () => {
    let bar = "";
    for (let i = 1; i <= 2000; i++) bar += `\r${Math.round(i / 20)}%| ${i}/2000`;
    expect(collapseCarriageReturns(`${bar}\nDone\n`)).toBe("100%| 2000/2000\nDone\n");
    // Chunks of one stream are joined before carriage returns apply.
    const text = outputsToText([
      { kind: "stream", name: "stderr", text: "\r 10%" },
      { kind: "stream", name: "stderr", text: "\r 50%" },
      { kind: "stream", name: "stderr", text: "\r100%\n" },
    ]);
    expect(text).toBe("[stderr]\n100%");
  });

  it("squeezes runs of the same line", () => {
    const text = squeezeRepeats(["start", ...Array(50).fill("Warning: x"), "end"].join("\n"));
    expect(text).toBe("start\nWarning: x\nWarning: x\n… (the line above repeated 48 more times)\nend");
  });

  it("cuts between lines and says how much is missing", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const out = capLines(text, 500);
    expect(out.length).toBeLessThanOrEqual(560);
    expect(out.startsWith("line 0\n")).toBe(true);
    expect(out.endsWith("line 999")).toBe(true);
    expect(out).toMatch(/… \[\d+ lines \(\d+ characters\) omitted\] …/);
    expect(out.split("\n").every((l) => /^line \d+$/.test(l) || l.startsWith("…"))).toBe(true);
    expect(wasShortened(out)).toBe(true);
    expect(wasShortened(text)).toBe(false);
  });

  it("keeps the error line and the user's frame when a long log precedes the error", () => {
    let log = "";
    for (let e = 1; e <= 500; e++) log += `Epoch ${e}/500 - loss: ${(1 / e).toFixed(4)}\n`;
    const frames = Array.from({ length: 60 }, (_, i) => `  File "/lib/mod${i}.py", line ${i}, in fn${i}\n    return inner_${i}(x)`);
    const outs = normalizeIpynbOutputs([
      { output_type: "stream", name: "stdout", text: log },
      {
        output_type: "error",
        ename: "ValueError",
        evalue: "shapes not aligned",
        traceback: ["Traceback (most recent call last)", 'Cell In[3], line 5\n----> 5 model.fit(X, y)', ...frames, "ValueError: shapes not aligned"],
      },
    ]);
    const text = outputsToText(outs, 6000);
    expect(text.length).toBeLessThanOrEqual(6100);
    expect(text).toContain("[error] ValueError: shapes not aligned");
    expect(text).toContain("Cell In[3], line 5");
    expect(text.trimEnd().endsWith("ValueError: shapes not aligned")).toBe(true);
    expect(text).toContain("Epoch 1/500");
    expect(text).toContain("Epoch 500/500");
  });

  it("hides data URIs and puts them back into edited text", () => {
    const b64 = "iVBORw0KGgo".repeat(100);
    const source = `# Results\n![plot](data:image/png;base64,${b64})\ntext`;
    const { text, payloads } = hideDataUris(source);
    expect(text).toBe("# Results\n![plot](data:image/png;base64,[[ainb:data-1 1 KB hidden]])\ntext");
    expect(restoreDataUris(text.replace("text", "more text"), payloads)).toBe(source.replace("text", "more text"));
    expect(hideDataUris("no images").payloads).toEqual([]);
  });
});

describe("message patches", () => {
  const base = { chatId: "c", tabId: 1, id: "m1", role: "agent" as const, createdAt: 1 };

  it("builds a message from patches: appended text and replaced parts", () => {
    let list: ChatMessage[] = [];
    const steps: MessagePatch[] = [
      { ...base, length: 1, ops: [{ i: 0, part: { type: "text", text: "Hel" } }] },
      { ...base, length: 1, ops: [{ i: 0, at: 3, append: "lo" }] },
      { ...base, length: 2, ops: [{ i: 1, part: { type: "tool", toolCallId: "t", title: "read", status: "pending" } }] },
      { ...base, length: 2, changes: { count: 1 }, ops: [{ i: 1, part: { type: "tool", toolCallId: "t", title: "read", status: "completed" } }] },
    ];
    for (const p of steps) list = applyMessagePatch(list, p)!;
    expect(list).toEqual([
      { id: "m1", role: "agent", createdAt: 1, changes: { count: 1 }, parts: [{ type: "text", text: "Hello" }, { type: "tool", toolCallId: "t", title: "read", status: "completed" }] },
    ]);
  });

  it("applies an append twice without doubling the text, and asks for a resync when it cannot apply", () => {
    const list: ChatMessage[] = [{ id: "m1", role: "agent", createdAt: 1, parts: [{ type: "text", text: "Hello" }] }];
    const again = applyMessagePatch(list, { ...base, length: 1, ops: [{ i: 0, at: 3, append: "lo" }] })!;
    expect(again[0]!.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(again).not.toBe(list);
    expect(applyMessagePatch([], { ...base, length: 1, ops: [{ i: 0, at: 3, append: "lo" }] })).toBeNull();
    expect(applyMessagePatch([], { ...base, length: 2, ops: [{ i: 1, part: { type: "text", text: "x" } }] })).toBeNull();
  });
});
