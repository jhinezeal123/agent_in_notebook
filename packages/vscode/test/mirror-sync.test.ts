import { describe, expect, it } from "vitest";
import { planPull, planPush, pullAction, sameOrder, toEditorOutputs, type LocalCell, type PullStep, type PushStep } from "../src/mirror-sync.js";

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

/** Apply pull steps to the mirror's list as the editor would, and return the ids in order. */
function applyPull(known: { id: string; type: "code" | "markdown" }[], steps: PullStep[]): string[] {
  const ids = known.map((c) => c.id);
  for (const s of steps) {
    if (s.op === "delete") ids.splice(ids.indexOf(s.id), 1);
    else if (s.op === "move") {
      ids.splice(ids.indexOf(s.id), 1);
      ids.splice(s.index, 0, s.id);
    } else ids.splice(s.index, 0, s.id);
  }
  return ids;
}

/** Length of a longest strictly increasing subsequence, by simple DP (an independent check of the LIS moves). */
function lisLength(xs: number[]): number {
  const best = xs.map(() => 1);
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < i; j++) if (xs[j]! < xs[i]!) best[i] = Math.max(best[i]!, best[j]! + 1);
  return Math.max(0, ...best);
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

describe("pullAction", () => {
  const a = { id: "a", type: "code" } as const;
  const b = { id: "b", type: "code" } as const;
  const blank = { id: "z", type: "code" } as const;

  it("follows sources and runs when all three hold the same cells", () => {
    expect(pullAction([a, b], [a, b], [a, b], false)).toBe("sync");
  });

  it("diffs minimally when cells changed in the browser", () => {
    expect(pullAction([a, b], [a, b], [b, a], false)).toBe("diff");
  });

  it("waits while the user's own change is on its way", () => {
    expect(pullAction([a], [a, b], [a, b], true)).toBe("wait");
  });

  it("takes the browser's notebook when the browser did not end where the mirror asked", () => {
    // Every cell deleted in VS Code; Kaggle keeps one empty cell. Nothing is left to push.
    expect(pullAction([], [blank], [blank], false)).toBe("rebuild");
  });

  it("takes the browser's notebook after a push that failed half way", () => {
    expect(pullAction([{ id: null, type: "code" }], [a, b], [a], false)).toBe("rebuild");
  });
});

describe("planPull", () => {
  const cells = (...ids: string[]) => ids.map((id) => ({ id, type: "code" as const }));

  it("does nothing when the mirror already matches the browser", () => {
    expect(planPull(cells("a", "b"), cells("a", "b"))).toEqual([]);
  });

  it("moves only the cells off the longest increasing subsequence", () => {
    // [a,b,c] -> [b,c,a]: b and c stay, only a moves (a greedy planner would move two).
    const steps = planPull(cells("a", "b", "c"), cells("b", "c", "a"))!;
    expect(steps).toEqual([{ op: "move", id: "a", index: 2 }]);
    expect(applyPull(cells("a", "b", "c"), steps)).toEqual(["b", "c", "a"]);
  });

  it("swaps two cells with one move", () => {
    const steps = planPull(cells("a", "b"), cells("b", "a"))!;
    expect(steps.filter((s) => s.op === "move")).toHaveLength(1);
    expect(applyPull(cells("a", "b"), steps)).toEqual(["b", "a"]);
  });

  it("inserts new cells at their final index, around the kept ones", () => {
    const steps = planPull(cells("a", "b", "c"), cells("x", "a", "y", "b", "c"))!;
    expect(steps).toEqual([
      { op: "insert", index: 0, id: "x", type: "code" },
      { op: "insert", index: 2, id: "y", type: "code" },
    ]);
    expect(applyPull(cells("a", "b", "c"), steps)).toEqual(["x", "a", "y", "b", "c"]);
  });

  it("deletes the cells the browser no longer has", () => {
    const steps = planPull(cells("a", "b", "c", "d", "e"), cells("a", "c", "e"))!;
    expect(steps).toEqual([{ op: "delete", id: "b" }, { op: "delete", id: "d" }]);
    expect(applyPull(cells("a", "b", "c", "d", "e"), steps)).toEqual(["a", "c", "e"]);
  });

  it("replaces a cell whose type changed in the browser", () => {
    const known = [{ id: "a", type: "code" as const }, { id: "b", type: "code" as const }];
    const remote = [{ id: "a", type: "markdown" as const }, { id: "b", type: "code" as const }];
    const steps = planPull(known, remote)!;
    expect(steps).toEqual([{ op: "delete", id: "a" }, { op: "insert", index: 0, id: "a", type: "markdown" }]);
    expect(applyPull(known, steps)).toEqual(["a", "b"]);
  });

  it("mixes delete, move and insert and ends in the browser's order", () => {
    const known = cells("a", "b", "c", "d", "e", "f");
    const remote = cells("a", "c", "x", "b", "e", "f");
    const steps = planPull(known, remote)!;
    expect(steps.filter((s) => s.op === "delete")).toEqual([{ op: "delete", id: "d" }]);
    expect(steps.filter((s) => s.op === "move")).toEqual([{ op: "move", id: "c", index: 1 }]);
    expect(steps.filter((s) => s.op === "insert")).toEqual([{ op: "insert", index: 2, id: "x", type: "code" }]);
    expect(applyPull(known, steps)).toEqual(["a", "c", "x", "b", "e", "f"]);
  });

  it("moves the fewest cells possible on shuffled orders", () => {
    // A fixed pseudo-random shuffle of eight ids, repeated with different seeds.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (let round = 0; round < 20; round++) {
      const target = [...ids];
      for (let i = target.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [target[i], target[j]] = [target[j]!, target[i]!];
      }
      const steps = planPull(cells(...ids), cells(...target));
      const positions = target.map((id) => ids.indexOf(id));
      const minMoves = ids.length - lisLength(positions);
      // A shuffle that moves more than half the cells is a rebuild, not a diff.
      if (minMoves * 2 > ids.length) {
        expect(steps).toBeNull();
        continue;
      }
      expect(steps).not.toBeNull();
      expect(steps!.filter((s) => s.op === "move")).toHaveLength(minMoves);
      expect(applyPull(cells(...ids), steps!)).toEqual(target);
    }
  });

  it("falls back to a rebuild when more than half the cells change", () => {
    expect(planPull(cells("a", "b", "c"), cells("c", "b", "a"))).toBeNull(); // two of three move
    expect(planPull(cells("a"), cells())).toBeNull();
    expect(planPull(cells(), cells("a", "b"))).toBeNull();
    // Exactly half is still a diff: one delete out of two cells.
    expect(planPull(cells("a", "b"), cells("a"))).toEqual([{ op: "delete", id: "b" }]);
  });

  it("falls back to a rebuild when ids cannot be matched", () => {
    expect(planPull(cells("a", "a"), cells("a"))).toBeNull();
    expect(planPull(cells("a"), cells("b", "b"))).toBeNull();
    expect(planPull(cells("a"), [{ id: "", type: "code" }])).toBeNull();
  });
});
