// Autonomy modes and the policy that enforces them on every notebook tool call.

/**
 * - `cell`:  edit only the target cell(s); no new cells, no deletes, no runs.
 * - `write`: free writing (code and markdown cells, edit, delete, move) without running.
 * - `auto`:  full autonomy, including running cells and the whole notebook.
 */
export type Scope = "cell" | "write" | "auto";

export interface ChatSettings {
  scope: Scope;
  /** Every change (and, in `auto`, every run) waits for the user's approval. */
  review: boolean;
  /**
   * Cells the agent may edit in `cell` scope. Empty means "the cell active in
   * the notebook when the message was sent".
   */
  targetCellIds: string[];
}

export const DEFAULT_SETTINGS: ChatSettings = { scope: "write", review: true, targetCellIds: [] };

export type ToolAction = "read" | "update" | "insert" | "delete" | "move" | "run" | "interrupt";

export type PolicyDecision =
  | { allow: true; review: boolean; askBeforeRun: boolean }
  | { allow: false; reason: string };

export const SCOPE_LABEL: Record<Scope, string> = {
  cell: "Edit cell",
  write: "Write",
  auto: "Autonomous",
};

export const SCOPE_HINT: Record<Scope, string> = {
  cell: "Only the target cell may be changed. Nothing is run.",
  write: "May add, edit, delete and move code and markdown cells. Nothing is run.",
  auto: "May change cells and run any cell or the whole notebook.",
};

/**
 * Decide whether a tool action is allowed under the chat's settings.
 * `cellId` is the cell an update targets; `effectiveTargets` resolves the
 * `cell` scope's targets (explicit ids, or the active cell).
 */
export function decide(
  settings: ChatSettings,
  action: ToolAction,
  cellId: string | null,
  effectiveTargets: string[],
): PolicyDecision {
  const { scope, review } = settings;
  switch (action) {
    case "read":
      return { allow: true, review: false, askBeforeRun: false };
    case "update":
      if (scope === "cell" && (cellId === null || !effectiveTargets.includes(cellId))) {
        return {
          allow: false,
          reason:
            effectiveTargets.length === 0
              ? "Mode is 'Edit cell' but no target cell is selected. Ask the user to select the cell to edit."
              : `Mode is 'Edit cell': only cell(s) ${effectiveTargets.join(", ")} may be edited.`,
        };
      }
      return { allow: true, review, askBeforeRun: false };
    case "insert":
    case "delete":
    case "move":
      if (scope === "cell") {
        return {
          allow: false,
          reason: `Mode is 'Edit cell': you may only edit cell(s) ${effectiveTargets.join(", ") || "(none selected)"}; adding, deleting or moving cells is not allowed.`,
        };
      }
      return { allow: true, review: action === "move" ? false : review, askBeforeRun: false };
    case "run":
    case "interrupt":
      if (scope !== "auto") {
        return {
          allow: false,
          reason: `Mode is '${SCOPE_LABEL[scope]}': running cells is not allowed. Tell the user which cells to run instead.`,
        };
      }
      return { allow: true, review: false, askBeforeRun: review && action === "run" };
  }
}
