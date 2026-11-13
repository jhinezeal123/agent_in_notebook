// The notebook as an .ipynb file (nbformat 4.5): written from the editor's
// cells, read back after the agent changed it, and edited cell by cell.

import { randomBytes } from "node:crypto";
import { capLines, hideDataUris, joinSource, normalizeIpynbOutputs, restoreDataUris, type CellInfo, type CellOutput, type CellType } from "@ainb/protocol";

/** One output's text in the file; the full text stays with the editor (read_output). */
const FILE_OUTPUT_MAX = 20_000;

/** A cell as an .ipynb file holds it. */
export interface NbCell {
  /** Missing for a cell the agent added without one. */
  id?: string;
  type: CellType;
  source: string;
  executionCount?: number | null;
  outputs?: CellOutput[];
  /** The outputs and execution count as the file holds them, to tell when they were changed. */
  outputsKey?: string;
}

export class NotebookFormatError extends Error {}

/** An edit the agent asked for that cannot be made; nothing was changed. */
export class EditError extends Error {}

function toLines(text: string): string[] {
  return text ? text.split(/(?<=\n)/) : [];
}

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;
}

function outputToIpynb(o: CellOutput, exec: number | null | undefined): Record<string, unknown> {
  const text = (t: string) => toLines(capLines(t, FILE_OUTPUT_MAX, 0.3));
  switch (o.kind) {
    case "stream":
      return { name: o.name ?? "stdout", output_type: "stream", text: text(o.text ?? "") };
    case "error":
      return { ename: o.ename ?? "Error", evalue: o.evalue ?? "", output_type: "error", traceback: (o.traceback ?? "").split("\n") };
    default: {
      const data: Record<string, unknown> = {};
      if (o.image) data[o.image.mime] = o.image.data;
      if (o.text !== undefined) data["text/plain"] = text(o.text);
      return o.kind === "result"
        ? { data: sortKeys(data), execution_count: exec ?? null, metadata: {}, output_type: "execute_result" }
        : { data: sortKeys(data), metadata: {}, output_type: "display_data" };
    }
  }
}

const KERNELS: Record<string, { name: string; display_name: string }> = {
  python: { name: "python3", display_name: "Python 3" },
  r: { name: "ir", display_name: "R" },
  julia: { name: "julia", display_name: "Julia" },
};

/** The editor's cells (with outputs) as the text of an .ipynb file, laid out as Jupyter saves it. */
export function toIpynb(cells: CellInfo[], language: string): string {
  const lang = (language || "python").toLowerCase();
  const kernel = KERNELS[lang] ?? { name: lang, display_name: language };
  const nb = {
    cells: cells.map((c) =>
      c.type === "code"
        ? {
            cell_type: "code",
            execution_count: c.executionCount ?? null,
            id: c.id,
            metadata: {},
            outputs: (c.outputs ?? []).map((o) => sortKeys(outputToIpynb(o, c.executionCount))),
            source: toLines(c.source),
          }
        : { cell_type: "markdown", id: c.id, metadata: {}, source: toLines(c.source) },
    ),
    metadata: { kernelspec: { ...kernel, language: lang }, language_info: { name: lang } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(nb, null, 1)}\n`;
}

/** Cells of an .ipynb file, and the parsed document (to write it back with its other fields). */
export function parseIpynb(text: string): { cells: NbCell[]; doc: Record<string, any> } {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new NotebookFormatError(`It is not valid JSON: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.cells)) throw new NotebookFormatError('It has no "cells" list.');
  const cells = doc.cells.map((c: any, i: number): NbCell => {
    if (!c || typeof c !== "object") throw new NotebookFormatError(`Cell ${i} is not an object.`);
    if (c.cell_type !== "code" && c.cell_type !== "markdown") {
      throw new NotebookFormatError(`Cell ${i} has cell_type ${JSON.stringify(c.cell_type)}; only "code" and "markdown" cells are supported.`);
    }
    const cell: NbCell = { type: c.cell_type, source: joinSource(c.source ?? "") };
    if (typeof c.id === "string" && c.id) cell.id = c.id;
    if (c.cell_type === "code") {
      cell.executionCount = typeof c.execution_count === "number" ? c.execution_count : null;
      cell.outputs = normalizeIpynbOutputs(c.outputs);
      cell.outputsKey = JSON.stringify([c.execution_count ?? null, c.outputs ?? []]);
    }
    return cell;
  });
  return { cells, doc };
}

/** Cells for display (tools render CellInfo). */
export function asCellInfo(cells: NbCell[]): CellInfo[] {
  return cells.map((c, index) => ({
    id: c.id ?? "(no id)",
    index,
    type: c.type,
    source: c.source,
    executionCount: c.executionCount,
    outputs: c.outputs,
  }));
}

export function fromCellInfo(cells: CellInfo[]): NbCell[] {
  return cells.map((c) => ({ id: c.id, type: c.type, source: c.source, executionCount: c.executionCount, outputs: c.outputs }));
}

export type CellEdit =
  | { mode: "replace"; cellId: string; source: string; type?: CellType }
  | { mode: "insert"; afterId?: string; source: string; type: CellType }
  | { mode: "delete"; cellId: string }
  | { mode: "move"; cellId: string; index: number };

function indexOf(cells: NbCell[], id: string): number {
  const i = cells.findIndex((c) => c.id === id);
  if (i < 0) throw new EditError(`No cell with id "${id}". Read the notebook to see the current ids.`);
  return i;
}

/** The cells after one structural edit. */
export function editCells(cells: NbCell[], e: CellEdit): NbCell[] {
  const out = [...cells];
  switch (e.mode) {
    case "replace": {
      const i = indexOf(out, e.cellId);
      out[i] = { ...out[i]!, source: e.source, ...(e.type ? { type: e.type } : {}) };
      return out;
    }
    case "insert": {
      const at = e.afterId ? indexOf(out, e.afterId) + 1 : 0;
      out.splice(at, 0, { type: e.type, source: e.source });
      return out;
    }
    case "delete":
      out.splice(indexOf(out, e.cellId), 1);
      return out;
    case "move": {
      const [cell] = out.splice(indexOf(out, e.cellId), 1);
      out.splice(Math.max(0, Math.min(e.index, out.length)), 0, cell!);
      return out;
    }
  }
}

/**
 * Replace text inside cells, matched against each cell's source as the agent
 * reads it (embedded data URIs shown as marks). Unless `all`, the text must
 * occur exactly once in the whole notebook.
 */
export function replaceInCells(cells: NbCell[], oldText: string, newText: string, all: boolean): { cells: NbCell[]; changed: string[] } {
  const shown = cells.map((c) => hideDataUris(c.source));
  const counts = shown.map((s) => s.text.split(oldText).length - 1);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    throw new EditError(
      "old_string was not found in any cell. It must match a cell's text exactly (as Read shows it, without the line numbers) and lie within one cell; " +
        "use NotebookEdit or Write to change the notebook's structure.",
    );
  }
  if (total > 1 && !all) {
    const where = cells.flatMap((c, i) => (counts[i] ? [`${c.id ?? `[${i}]`}${counts[i]! > 1 ? ` (${counts[i]}×)` : ""}`] : []));
    throw new EditError(`old_string occurs ${total} times (cells ${where.join(", ")}). Add surrounding text to make it unique, or set replace_all.`);
  }
  const changed: string[] = [];
  const out = cells.map((c, i) => {
    if (!counts[i]) return c;
    changed.push(c.id ?? `[${i}]`);
    const s = shown[i]!;
    const next = all ? s.text.split(oldText).join(newText) : s.text.replace(oldText, () => newText);
    return { ...c, source: restoreDataUris(next, s.payloads) };
  });
  return { cells: out, changed };
}

/** A new nbformat cell id. */
export function newCellId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * An .ipynb file's text after its cells changed to `cells`: cells kept by id
 * keep their outputs and metadata; new cells get ids.
 */
export function writeIpynb(doc: Record<string, any>, cells: NbCell[]): string {
  const byId = new Map<string, any>();
  for (const c of doc.cells as any[]) if (typeof c?.id === "string") byId.set(c.id, c);
  const out = { ...doc };
  out.cells = cells.map((c) => {
    const old = c.id ? byId.get(c.id) : undefined;
    if (old && old.cell_type === c.type) return { ...old, source: toLines(c.source) };
    const id = c.id ?? newCellId();
    return c.type === "code"
      ? { cell_type: "code", execution_count: null, id, metadata: {}, outputs: [], source: toLines(c.source) }
      : { cell_type: "markdown", id, metadata: {}, source: toLines(c.source) };
  });
  // Cell ids arrived with nbformat 4.5.
  if (out.nbformat === 4 && (out.nbformat_minor ?? 0) < 5) out.nbformat_minor = 5;
  return `${JSON.stringify(out, null, 1)}\n`;
}
