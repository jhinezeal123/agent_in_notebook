// Notebook model shared by the notebook adapters, the bridge and the chat UI.

export type Platform = "colab" | "kaggle" | "jupyter" | "vscode";

export type CellType = "code" | "markdown";

/** A code cell's run state as the editor shows it now: cheap to read (no source, no outputs). */
export interface CellRunState {
  cellId: string;
  running: boolean;
  executionCount: number | null;
  /** The editor's own timing of the cell's last finished run, when it keeps one (VS Code). */
  lastDurationMs?: number;
  /**
   * Evidence of a new run that does not depend on the execution count: the
   * adapter sets it (a generation string) each time it witnesses a new run of
   * the cell, so a fast run reusing the old count after a kernel restart is
   * still seen. Absent when the adapter cannot witness runs (Colab, VS Code).
   */
  runToken?: string;
}

/** One finished run of a code cell, as the page saw it: the user's runs and the agent's. */
export interface CellRun {
  cellId: string;
  /** The cell's position when the run finished. */
  index: number;
  status: "ok" | "error" | "interrupted";
  executionCount: number | null;
  /** `agent`: started by a run_cells op of this page's OpRunner; else the user (or a "run all" of the editor). */
  by: "agent" | "user";
  /** Wall time, when known: the page saw the run start, or the editor timed it. Includes time queued behind other cells. */
  durationMs?: number;
  /** First non-empty line of the source when it finished, at most 120 characters. */
  head: string;
  /** The error, for `error` and `interrupted`. `evalue` is cut to 300 characters. */
  ename?: string;
  evalue?: string;
}

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
  /** Present only when `outputsHash` was requested: changes whenever the cell's outputs change. */
  outputsHash?: string;
  /** Present only when `sourceHash` was requested: a fingerprint of the full source, which is then cut to "" (with `lineCount`). */
  sourceHash?: string;
  /** True while a review of this cell is pending. */
  pendingReview?: boolean;
  /** Set by a `summary` or `sourceHash` read: `source` then holds only the first line (summary) or nothing (sourceHash). */
  lineCount?: number;
  /** The source changed since the page last saw this cell finish a run. Unknown (absent) for runs before the page loaded. */
  stale?: boolean;
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
  /**
   * The notebook server lends a terminal, so the machine is reached without
   * the kernel (see `machine_exec`), even while a cell runs.
   */
  serverTerminals?: boolean;
}

/** What running code on the kernel outside any cell produced (see the `execute` op). */
export interface ExecResult {
  /** `running`: still running when the wait ended; `execute_wait` with `execId` keeps waiting. */
  status: "ok" | "error" | "running";
  outputs: CellOutput[];
  message?: string;
  /** Set while running. */
  execId?: string;
  /**
   * Generation of the output list: grows when the outputs stop being
   * append-only (a clear, or a stream cut mid-way). A waiting client sends it
   * back as `since.gen` to receive only what is new; a mismatch means full.
   */
  gen?: number;
  /**
   * Set while running when `execute_wait` was given a matching `since`: the
   * client appends `tail` to the stream it holds `chars` characters of (output
   * `n-1`), then pushes `rest`. `outputs` is then empty (the full list stays
   * on the page); the final result is always full, never a delta.
   */
  delta?: { n: number; chars: number; tail: string; rest: CellOutput[] };
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
  /** The cell's position when the review opened (for putting a deleted cell back on undo). */
  index?: number;
  /** A short title for the review: the first line of `after` (or `before` for a delete), at most 60 characters. */
  label?: string;
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
 * inserted from the chat).
 */
export type NotebookOp =
  | { op: "info" }
  /**
   * `summary`: each source is cut to its first line (with `lineCount`), for outlines of big notebooks.
   * `outputsHash`: each code cell carries a short fingerprint of its outputs instead of them,
   * so a reader that polls fetches only the outputs that changed.
   * `sourceHash`: each cell carries a fingerprint of its full source instead of it (`source` is "",
   * with `lineCount`); wins over `summary` when both are set. Combines with `outputsHash`.
   * `maxImages` / `maxImageBytes`: one image budget for the whole call (base64 length); images past
   * it lose their `image` and keep their mime in `mimes`. `get_output_image` fetches one for real.
   */
  | { op: "get_cells"; cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean; summary?: boolean; outputsHash?: boolean; sourceHash?: boolean; maxImages?: number; maxImageBytes?: number }
  /**
   * `expectedSource`: compare-and-set — when the cell's current source differs, nothing is applied,
   * journaled or reviewed and the result is `{ applied: false, conflict: true }`.
   */
  | { op: "update_cell"; cellId: string; source: string; review: boolean; byUser?: boolean; expectedSource?: string }
  | { op: "insert_cell"; index: number; cellType: CellType; source: string; review: boolean; byUser?: boolean }
  | { op: "delete_cell"; cellId: string; review: boolean; byUser?: boolean }
  | { op: "move_cell"; cellId: string; index: number; byUser?: boolean }
  /**
   * Run several cell changes in one round-trip, in order, each exactly as if it
   * were sent alone (review, journal and events keep their order). Steps must
   * be update_cell, insert_cell, delete_cell or move_cell; anything else is an
   * OpError and nothing runs. Results come back one per step, in order.
   */
  | { op: "apply_cells"; steps: NotebookOp[] }
  /** `maxImages` / `maxImageBytes`: one image budget across all results (see get_cells). */
  | { op: "run_cells"; cellIds: string[]; timeoutMs: number; stopOnError: boolean; maxImages?: number; maxImageBytes?: number }
  /**
   * Run code on the kernel without a cell: nothing is added to the notebook or
   * its history. Refused while the kernel is busy (the code would wait behind
   * the running cell). Code still running after `waitMs` keeps running; the
   * result then carries an `execId` for `execute_wait`.
   */
  | { op: "execute"; code: string; waitMs: number }
  /**
   * `since`: the caller already holds `n` outputs of this execution, of generation `gen`, and its
   * last one (if a stream) has `chars` characters. While running and the generation still matches,
   * the result is a `delta` (see ExecResult); otherwise, and always once finished, it is full.
   */
  | { op: "execute_wait"; execId: string; waitMs: number; since?: { gen: number; n: number; chars: number } }
  /** The real image of one cell output (no budget), for a reader that only got its mime. */
  | { op: "get_output_image"; cellId: string; outputIndex: number }
  /**
   * Run Python on the notebook's machine to work it (files, the terminal
   * sessions), not the notebook: through a terminal of the notebook server
   * when it lends one, so a running cell does not block it, else through the
   * kernel like `execute`. Not in the notebook's namespace.
   */
  | { op: "machine_exec"; code: string; waitMs: number }
  | { op: "interrupt" }
  | { op: "focus_cell"; cellId: string }
  | { op: "resolve_review"; reviewId: string; accept: boolean };

export interface NotebookOpResults {
  info: NotebookInfo;
  get_cells: { cells: CellInfo[] };
  update_cell: { applied: boolean; reviewId?: string; conflict?: boolean };
  insert_cell: { applied: boolean; cellId: string | null; reviewId?: string };
  delete_cell: { applied: boolean; reviewId?: string };
  move_cell: { index: number };
  apply_cells: { results: unknown[] };
  run_cells: { results: RunResult[] };
  execute: ExecResult;
  execute_wait: ExecResult;
  get_output_image: { image?: OutputImage };
  machine_exec: ExecResult;
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
  | { type: "change_applied"; change: AppliedChange }
  | { type: "cell_run"; run: CellRun }
  | { type: "kernel_changed"; kernel: KernelState };
