// The parts of the Chrome notebook mirror that need no VS Code: outputs in
// VS Code's form, the steps that bring the browser's notebook in line with
// what the user did to the mirror (push), and the fewest edits that bring the
// mirror in line with what the browser did to its notebook (pull).

import type { CellOutput, CellType } from "@ainb/protocol";

export interface OutputItems {
  items: { mime: string; data: Uint8Array }[];
  metadata?: Record<string, unknown>;
}

const STDOUT = "application/vnd.code.notebook.stdout";
const STDERR = "application/vnd.code.notebook.stderr";
const ERROR = "application/vnd.code.notebook.error";

const text = (s: string) => new TextEncoder().encode(s);

/** A cell's outputs as VS Code shows them (the caller wraps them in NotebookCellOutput). */
export function toEditorOutputs(outputs: readonly CellOutput[]): OutputItems[] {
  const result: OutputItems[] = [];
  for (const o of outputs) {
    if (o.kind === "stream") {
      result.push({ items: [{ mime: o.name === "stderr" ? STDERR : STDOUT, data: text(o.text ?? "") }] });
    } else if (o.kind === "error") {
      const error = { name: o.ename ?? "Error", message: o.evalue ?? "", stack: o.traceback ?? "" };
      result.push({ items: [{ mime: ERROR, data: text(JSON.stringify(error)) }] });
    } else {
      const items: OutputItems["items"] = [];
      if (o.image) items.push({ mime: o.image.mime, data: Uint8Array.from(Buffer.from(o.image.data, "base64")) });
      if (o.text !== undefined) items.push({ mime: "text/plain", data: text(o.text) });
      if (!items.length) continue;
      result.push({ items, metadata: { outputType: o.kind === "result" ? "execute_result" : "display_data" } });
    }
  }
  return result;
}

/** What the mirror holds: each cell's browser id, or null for a cell the user added and the browser does not have yet. */
export interface LocalCell {
  id: string | null;
  type: CellType;
}

export type PushStep =
  | { op: "delete"; id: string }
  | { op: "move"; id: string; index: number }
  | { op: "insert"; localIndex: number };

/**
 * The steps that make the browser's cells (`remote`, in order) match the
 * mirror's: deletions first, then moves of the cells both have, then the new
 * cells in order, each at its own index. A cell whose type changed in the
 * mirror is replaced: deleted, and inserted again.
 */
export function planPush(local: readonly LocalCell[], remote: readonly { id: string; type: CellType }[]): PushStep[] {
  const remoteType = new Map(remote.map((c) => [c.id, c.type]));
  const kept = local.map((c) => (c.id !== null && remoteType.get(c.id) === c.type ? c.id : null));
  const keptIds = new Set(kept.filter((id): id is string => id !== null));
  const steps: PushStep[] = [];
  for (const { id } of remote) if (!keptIds.has(id)) steps.push({ op: "delete", id });
  const current = remote.map((c) => c.id).filter((id) => keptIds.has(id));
  const target = kept.filter((id): id is string => id !== null);
  for (let i = 0; i < target.length; i++) {
    if (current[i] === target[i]) continue;
    const id = target[i]!;
    current.splice(current.indexOf(id), 1);
    current.splice(i, 0, id);
    steps.push({ op: "move", id, index: i });
  }
  kept.forEach((id, i) => {
    if (id === null) steps.push({ op: "insert", localIndex: i });
  });
  return steps;
}

/**
 * What a poll does with the browser's cells:
 * - "wait": the user's own change to the cells is still on its way to the browser;
 * - "rebuild": the mirror no longer matches what the browser was last known to
 *   hold (a push failed half way, e.g. Kaggle adds an empty cell when the last
 *   one is deleted): read the whole notebook again;
 * - "diff": the browser added, removed or moved cells: bring the mirror in line
 *   with the fewest edits (planPull), keeping the cells that stay put;
 * - "sync": same cells in both: follow sources and runs cell by cell.
 */
export function pullAction(
  local: readonly LocalCell[],
  known: readonly { id: string; type: CellType }[],
  remote: readonly { id: string; type: CellType }[],
  pushPending: boolean,
): "wait" | "rebuild" | "diff" | "sync" {
  if (!sameOrder(local, known)) return pushPending ? "wait" : "rebuild";
  return sameOrder(known, remote) ? "sync" : "diff";
}

export function sameOrder(local: readonly LocalCell[], remote: readonly { id: string; type: CellType }[]): boolean {
  return local.length === remote.length && local.every((c, i) => c.id === remote[i]!.id && c.type === remote[i]!.type);
}

export type PullStep =
  | { op: "delete"; id: string }
  /** Remove the cell, then insert it again at `index` (the list after the deletes and the moves before it). */
  | { op: "move"; id: string; index: number }
  /** A cell the browser added (or retyped): insert it at `index`, its final position. */
  | { op: "insert"; index: number; id: string; type: CellType };

/**
 * The fewest edits that bring the mirror's cells (`known`, in order) in line
 * with the browser's (`remote`): deletions first, then moves of the cells both
 * have, then the new cells. The cells on a longest increasing subsequence of
 * the target order keep their place — only the others move (the same principle
 * as the bridge's applyCells). A cell whose type changed in the browser is
 * replaced: deleted, and inserted again.
 *
 * Null when a minimal diff is not worth it or not safe: more than half the
 * cells change (each cell deleted, moved, inserted or retyped counted once),
 * or an id is empty or repeated — the caller rebuilds the whole notebook instead.
 */
export function planPull(known: readonly { id: string; type: CellType }[], remote: readonly { id: string; type: CellType }[]): PullStep[] | null {
  if (new Set(known.map((c) => c.id)).size !== known.length) return null;
  if (remote.some((c) => !c.id) || new Set(remote.map((c) => c.id)).size !== remote.length) return null;
  const knownType = new Map(known.map((c) => [c.id, c.type]));
  const kept = remote.map((c) => (knownType.get(c.id) === c.type ? c.id : null));
  const keptIds = new Set(kept.filter((id): id is string => id !== null));
  const steps: PullStep[] = [];
  for (const { id } of known) if (!keptIds.has(id)) steps.push({ op: "delete", id });
  const current = known.map((c) => c.id).filter((id) => keptIds.has(id));
  const target = kept.filter((id): id is string => id !== null);
  if (target.length) {
    const stable = longestIncreasing(target.map((id) => current.indexOf(id)));
    const order = [...current];
    const move = (id: string, to: (order: string[]) => number) => {
      order.splice(order.indexOf(id), 1);
      const at = to(order);
      order.splice(at, 0, id);
      steps.push({ op: "move", id, index: at });
    };
    const firstStable = target.findIndex((_, j) => stable.has(j));
    // Cells before the first one that stays go, in order, right before it.
    for (let j = firstStable - 1; j >= 0; j--) {
      const anchor = target[j + 1];
      move(target[j]!, (o) => (anchor ? o.indexOf(anchor) : o.length));
    }
    for (let j = firstStable + 1; j < target.length; j++) {
      if (stable.has(j)) continue;
      const prev = target[j - 1]!;
      move(target[j]!, (o) => o.indexOf(prev) + 1);
    }
  }
  // After the moves the kept cells sit in the browser's relative order, so a
  // new cell's index in the browser is also its index in the list being built.
  remote.forEach((c, i) => {
    if (!keptIds.has(c.id)) steps.push({ op: "insert", index: i, id: c.id, type: c.type });
  });
  const total = Math.max(known.length, remote.length);
  const affected = new Set(steps.map((s) => s.id)).size;
  return affected * 2 > total ? null : steps;
}

/** Indexes (into `xs`) of a longest strictly increasing subsequence. */
function longestIncreasing(xs: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]!]! < xs[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) out.add(i);
  return out;
}
