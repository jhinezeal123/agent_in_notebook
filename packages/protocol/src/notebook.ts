// Notebook model shared by the page adapters, the bridge and the side panel.

export type Platform = "colab" | "kaggle" | "jupyter";

export type CellType = "code" | "markdown";

/** A raster image from a cell output, base64-encoded. */
export interface OutputImage {
  mime: "image/png" | "image/jpeg";
  data: string;
}

/** One output of a code cell, flattened to text plus at most one image. */
export interface CellOutput {
  kind: "stream" | "result" | "display" | "error";
  /** stdout / stderr for streams. */
  name?: string;
  text?: string;
  /** A PNG/JPEG the output carried, which agents that read images can see. */
  image?: OutputImage;
  /** Other non-text mime types the output carried (text/html, image/svg+xml...), which the agent cannot see. */
  mimes?: string[];
  ename?: string;
  evalue?: string;
  traceback?: string;
}

export interface CellInfo {
  id: string;
  index: number;
  type: CellType;
  source: string;
  executionCount?: number | null;
  running?: boolean;
  /** Present only when outputs were requested. */
  outputs?: CellOutput[];
  /** True while a review of this cell is pending. */
  pendingReview?: boolean;
  /** Set by a `summary` read: `source` then holds only the first line. */
  lineCount?: number;
}

export type KernelState = "idle" | "busy" | "disconnected" | "unknown";

export interface NotebookInfo {
  platform: Platform;
  title: string;
  url: string;
  cellCount: number;
  activeCellId: string | null;
  selectedCellIds: string[];
  kernel: KernelState;
  language: string;
  /** Path of the document inside the notebook server (Jupyter), to tell notebooks apart. */
  docPath?: string;
  /** Stable identity of the notebook (see notebookKey), added by the extension from the tab URL. */
  key?: string;
}

/** What running code on the kernel outside any cell produced (see the `execute` op). */
export interface ExecResult {
  /** `running`: still running when the wait ended; `execute_wait` with `execId` keeps waiting. */
  status: "ok" | "error" | "running";
  outputs: CellOutput[];
  message?: string;
  /** Set while running. */
  execId?: string;
}

export interface RunResult {
  cellId: string;
  status: "ok" | "error" | "timeout" | "skipped";
  executionCount?: number | null;
  outputs: CellOutput[];
  message?: string;
}

/** A change shown to the user for approval. */
export interface ReviewInfo {
  reviewId: string;
  cellId: string;
  kind: "update" | "insert" | "delete";
  cellType: CellType;
  before: string;
  after: string;
}

/**
 * A change that was applied to the notebook on the agent's behalf (directly,
 * or when the user accepted its review), recorded so the user can undo it.
 * `index` is the cell's position before the change; a move also has `toIndex`.
 */
export interface AppliedChange {
  kind: "update" | "insert" | "delete" | "move";
  cellId: string;
  cellType: CellType;
  index: number;
  toIndex?: number;
  before: string;
  after: string;
  /** Set when the change was applied by accepting this review. */
  reviewId?: string;
}

/**
 * Operations the bridge asks the page to perform. Every mutating op carries
 * `review`: when true, the page shows the change for approval and answers at
 * once with a `reviewId` and `applied: false`; the decision arrives later as a
 * `review_closed` event. Mutating ops are journaled as `change_applied`
 * events unless `byUser` marks them as the user's own (an undo, a cell
 * inserted from the side panel).
 */
export type NotebookOp =
  | { op: "info" }
  /** `summary`: each source is cut to its first line (with `lineCount`), for outlines of big notebooks. */
  | { op: "get_cells"; cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean; summary?: boolean }
  | { op: "update_cell"; cellId: string; source: string; review: boolean; byUser?: boolean }
  | { op: "insert_cell"; index: number; cellType: CellType; source: string; review: boolean; byUser?: boolean }
  | { op: "delete_cell"; cellId: string; review: boolean; byUser?: boolean }
  | { op: "move_cell"; cellId: string; index: number; byUser?: boolean }
  | { op: "run_cells"; cellIds: string[]; timeoutMs: number; stopOnError: boolean }
  /**
   * Run code on the kernel without a cell: nothing is added to the notebook or
   * its history. Refused while the kernel is busy (the code would wait behind
   * the running cell). Code still running after `waitMs` keeps running; the
   * result then carries an `execId` for `execute_wait`.
   */
  | { op: "execute"; code: string; waitMs: number }
  | { op: "execute_wait"; execId: string; waitMs: number }
  | { op: "interrupt" }
  | { op: "focus_cell"; cellId: string }
  | { op: "resolve_review"; reviewId: string; accept: boolean };

export interface NotebookOpResults {
  info: NotebookInfo;
  get_cells: { cells: CellInfo[] };
  update_cell: { applied: boolean; reviewId?: string };
  insert_cell: { applied: boolean; cellId: string | null; reviewId?: string };
  delete_cell: { applied: boolean; reviewId?: string };
  move_cell: { index: number };
  run_cells: { results: RunResult[] };
  execute: ExecResult;
  execute_wait: ExecResult;
  interrupt: { interrupted: boolean };
  focus_cell: { focused: boolean };
  resolve_review: { resolved: boolean };
}

/** The outline form of a cell (see the `summary` flag of get_cells). */
export function summarizeCell(c: CellInfo): CellInfo {
  const lines = c.source ? c.source.split("\n").length : 0;
  const first = c.source.split("\n").find((l) => l.trim() !== "") ?? "";
  // Long enough for an outline; a pasted image's data: URI would otherwise ride along.
  return { ...c, source: first.length > 120 ? `${first.slice(0, 119)}…` : first, lineCount: lines };
}

export type NotebookOpName = NotebookOp["op"];
export type NotebookOpOf<N extends NotebookOpName> = Extract<NotebookOp, { op: N }>;

/** Events the page pushes without being asked. */
export type NotebookEvent =
  | { type: "review_opened"; review: ReviewInfo }
  | { type: "review_closed"; reviewId: string; accepted: boolean }
  | { type: "selection_changed"; activeCellId: string | null; selectedCellIds: string[] }
  | { type: "change_applied"; change: AppliedChange };
