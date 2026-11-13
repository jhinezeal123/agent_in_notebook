// The parts of the Chrome notebook mirror that need no VS Code: outputs in
// VS Code's form, and the steps that bring the browser's notebook in line
// with what the user did to the mirror.

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

export function sameOrder(local: readonly LocalCell[], remote: readonly { id: string; type: CellType }[]): boolean {
  return local.length === remote.length && local.every((c, i) => c.id === remote[i]!.id && c.type === remote[i]!.type);
}
