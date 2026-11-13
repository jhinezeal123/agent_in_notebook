import { describe, expect, it } from "vitest";
import { planPush, sameOrder, toEditorOutputs, type LocalCell, type PushStep } from "../src/mirror-sync.js";

/** Apply the steps to the browser's list as the browser would, and return the ids in order. */
function apply(remote: { id: string; type: "code" | "markdown" }[], local: LocalCell[], steps: PushStep[]): string[] {
  const ids = remote.map((c) => c.id);
  let next = 0;
  for (const s of steps) {
    if (s.op === "delete") ids.splice(ids.indexOf(s.id), 1);
    else if (s.op === "move") {
      ids.splice(ids.indexOf(s.id), 1);
      ids.splice(s.index, 0, s.id);
    } else ids.splice(s.localIndex, 0, local[s.localIndex]!.id ?? `new${next++}`);
  }
  return ids;
}

describe("planPush", () => {
  const remote = [{ id: "a", type: "code" }, { id: "b", type: "code" }, { id: "c", type: "markdown" }, { id: "d", type: "code" }] as const;

  it("does nothing when the mirror matches", () => {
    const local = remote.map((c) => ({ ...c }));
    expect(planPush(local, [...remote])).toEqual([]);
    expect(sameOrder(local, [...remote])).toBe(true);
  });

  it("deletes, moves and inserts so the browser ends in the mirror's order", () => {
    const local: LocalCell[] = [
      { id: "d", type: "code" },
      { id: null, type: "markdown" },
      { id: "a", type: "code" },
      { id: "c", type: "markdown" },
      { id: null, type: "code" },
    ];
    const steps = planPush(local, [...remote]);
    expect(steps.filter((s) => s.op === "delete")).toEqual([{ op: "delete", id: "b" }]);
    expect(steps.filter((s) => s.op === "insert")).toEqual([{ op: "insert", localIndex: 1 }, { op: "insert", localIndex: 4 }]);
    expect(apply([...remote], local, steps)).toEqual(["d", "new0", "a", "c", "new1"]);
    expect(sameOrder(local, [...remote])).toBe(false);
  });

  it("replaces a cell whose type changed", () => {
    const local: LocalCell[] = [{ id: "a", type: "markdown" }, { id: "b", type: "code" }];
    expect(planPush(local, [{ id: "a", type: "code" }, { id: "b", type: "code" }])).toEqual([
      { op: "delete", id: "a" },
      { op: "insert", localIndex: 0 },
    ]);
  });
});

describe("toEditorOutputs", () => {
  it("turns streams, results with images, and errors into VS Code output items", () => {
    const png = Buffer.from([137, 80, 78, 71]).toString("base64");
    const out = toEditorOutputs([
      { kind: "stream", name: "stdout", text: "hi\n" },
      { kind: "stream", name: "stderr", text: "warn\n" },
      { kind: "result", text: "42" },
      { kind: "display", text: "<Figure>", image: { mime: "image/png", data: png } },
      { kind: "error", ename: "ValueError", evalue: "nope", traceback: "Traceback…" },
      { kind: "display", mimes: ["text/html"] },
    ]);
    const decode = (d: Uint8Array) => new TextDecoder().decode(d);
    expect(out.map((o) => o.items.map((i) => i.mime))).toEqual([
      ["application/vnd.code.notebook.stdout"],
      ["application/vnd.code.notebook.stderr"],
      ["text/plain"],
      ["image/png", "text/plain"],
      ["application/vnd.code.notebook.error"],
    ]);
    expect(decode(out[0]!.items[0]!.data)).toBe("hi\n");
    expect(out[2]!.metadata).toEqual({ outputType: "execute_result" });
    expect([...out[3]!.items[0]!.data]).toEqual([137, 80, 78, 71]);
    expect(JSON.parse(decode(out[4]!.items[0]!.data))).toEqual({ name: "ValueError", message: "nope", stack: "Traceback…" });
  });
});
