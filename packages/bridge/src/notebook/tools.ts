// The notebook tools offered to every agent over MCP. Each call is checked
// against the chat's mode at the moment it runs, so switching mode in the side
// panel takes effect on the agent's very next tool call.

import { z } from "zod";
import {
  capLines,
  decide,
  firstLine,
  hideDataUris,
  outputsToText,
  restoreDataUris,
  SCOPE_LABEL,
  type CellInfo,
  type CellOutput,
  type ChatSettings,
  type ExecResult,
  type NotebookInfo,
  type NotebookOp,
  type NotebookOpName,
  type NotebookOpOf,
  type NotebookOpResults,
  type OutputImage,
  type RunResult,
  type ToolAction,
  wasShortened,
} from "@ainb/protocol";
import { RecentRuns } from "./exec.js";
import { SCROLLBACK, SESSION_NAME, ShellError, type KernelExec, type Report, type ShellSession, type ShellSessions } from "./shell.js";

export type ReviewOutcome = "accepted" | "rejected" | "pending" | "discarded";

export interface ToolContext {
  settings(): ChatSettings;
  /** Cells the `cell` scope may edit for the current turn. */
  targets(): string[];
  call<N extends NotebookOpName>(op: NotebookOpOf<N>, timeoutMs?: number): Promise<NotebookOpResults[N]>;
  /** Wait for a review the page opened. */
  awaitReview(reviewId: string, waitMs: number): Promise<ReviewOutcome>;
  /** In review mode, ask the user before running code. `detail` shows what would run. Resolves true to run. */
  confirmRun(summary: string, detail?: string): Promise<boolean>;
  /** Longest a call may block on the user or a running cell. */
  waitMs: number;
  /** The agent reads images in tool results, so plots are attached rather than described as hidden. */
  images: boolean;
  /**
   * Run `fn` alone among the chat's calls holding the same lock. Agents call
   * tools in parallel: two edits of one cell would read the same source and the
   * second would undo the first, and runs on Jupyter go through the active cell.
   */
  exclusive<T>(lock: "edit" | "run", fn: () => Promise<T>): Promise<T>;
  /** Outputs of the chat's latest run_shell / run_code calls, for read_output. */
  runs: RecentRuns;
  /** The chat's terminal sessions on the notebook's machine. */
  shells: ShellSessions;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** Plots and other raster outputs, sent as MCP image content after the text. */
  images?: OutputImage[];
}

const IMAGES_MAX = 4;
const IMAGES_BYTES_MAX = 3_000_000;

/** Images gathered for one tool result, within a count and size limit. */
class Attachments {
  readonly images: OutputImage[] = [];
  private bytes = 0;

  constructor(private readonly enabled: boolean) {}

  readonly attach = (image: OutputImage): string | null => {
    if (!this.enabled) return null;
    if (this.images.length >= IMAGES_MAX || this.bytes + image.data.length > IMAGES_BYTES_MAX) {
      return `[${image.mime} output not attached: this result already carries ${this.images.length} images; read this cell on its own to see it]`;
    }
    this.images.push(image);
    this.bytes += image.data.length;
    return `[${image.mime} output: image ${this.images.length} attached to this result]`;
  };

  mark(): { count: number; bytes: number } {
    return { count: this.images.length, bytes: this.bytes };
  }

  /** Drop images attached after `mark` (their cell was left out of the result). */
  reset(mark: { count: number; bytes: number }): void {
    this.images.length = mark.count;
    this.bytes = mark.bytes;
  }

  result(text: string, isError?: boolean): ToolResult {
    const out: ToolResult = { text };
    if (isError) out.isError = true;
    if (this.images.length) out.images = [...this.images];
    return out;
  }
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(ctx: ToolContext, args: z.infer<S>): Promise<ToolResult>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

class Denied extends Error {}

function check(ctx: ToolContext, action: ToolAction, cellId: string | null) {
  const d = decide(ctx.settings(), action, cellId, ctx.targets());
  if (!d.allow) throw new Denied(d.reason);
  return d;
}

const OUTPUT_MAX = 6000;
/** One cell's source shown to the agent; longer sources keep head and tail. */
const SOURCE_MAX = 20_000;
/** Total text one read returns, so a big notebook cannot flood the agent's context. */
export const READ_BUDGET = 60_000;
/** Total text of one run_cells / run_all result; each cell's output shrinks to share it. */
export const RUN_BUDGET = 30_000;
/** Smallest share of RUN_BUDGET a cell's output is cut to. */
const RUN_OUTPUT_MIN = 1200;
/** One read_output page. */
const PAGE_MAX = 12_000;
/** Output of one terminal / run_code result. */
const EXEC_OUTPUT_MAX = 10_000;
/** What a tool call keeps of its time for answering after a wait. */
const WAIT_MARGIN_MS = 10_000;

const SHORTENED_HINT = "(output shortened: read_output with this cell id pages through or searches all of it)";

function renderOutputs(c: { outputs?: CellOutput[] }, max: number, att?: Attachments): string {
  const out = c.outputs?.length ? outputsToText(c.outputs, max, att?.attach) : "";
  return wasShortened(out) ? `${out}\n${SHORTENED_HINT}` : out;
}

function renderCell(c: CellInfo, withOutputs: boolean, att?: Attachments): string {
  const exec = c.type === "code" ? ` exec=${c.executionCount ?? "-"}${c.running ? " RUNNING" : ""}` : "";
  const pending = c.pendingReview ? " (change awaiting user review)" : "";
  // Images pasted into markdown are long base64 runs; the agent sees a mark it can keep in its edits.
  const { text, payloads } = hideDataUris(c.source);
  const long = text.length > SOURCE_MAX;
  const source = long ? capLines(text, SOURCE_MAX, 0.6) : text;
  const notes = [
    long ? `source is ${text.length} characters, shown shortened; edit_cell needs text from the shown parts` : "",
    payloads.length ? `${payloads.length} embedded data URI${payloads.length === 1 ? "" : "s"} shown as [[ainb:data-N]] marks; keep the marks to keep them` : "",
  ].filter(Boolean);
  let s = `### cell [${c.index}] id=${c.id} ${c.type}${exec}${pending}${notes.length ? ` (${notes.join("; ")})` : ""}\n${source}`;
  if (withOutputs && c.type === "code") {
    s += `\n--- output ---\n${renderOutputs(c, OUTPUT_MAX, att) || "(no output)"}`;
  }
  return s;
}

/**
 * Join rendered cells until the budget is spent. The first cell is always
 * shown; the rest is named so the agent can ask for it.
 */
function joinWithinBudget(cells: CellInfo[], render: (c: CellInfo) => string, sep: string, att?: Attachments, budget = READ_BUDGET): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, c] of cells.entries()) {
    const mark = att?.mark();
    const text = render(c);
    if (i > 0 && used + text.length > budget) {
      if (mark) att!.reset(mark);
      const rest = cells.slice(i);
      const first = rest[0]!;
      const last = rest.at(-1)!;
      out.push(
        `… ${rest.length} more cell${rest.length === 1 ? "" : "s"} not shown to keep this short ([${first.index}]..[${last.index}]). ` +
          `Ask for them with read_cells using start_index=${first.index}, or by cell_ids.`,
      );
      break;
    }
    out.push(text);
    used += text.length + sep.length;
  }
  return out.join(sep);
}

function runHead(r: RunResult): string {
  return `cell ${r.cellId}: ${r.status}${r.executionCount != null ? ` (exec ${r.executionCount})` : ""}${r.message ? ` — ${r.message}` : ""}`;
}

/**
 * The results of a run within RUN_BUDGET. A failed cell keeps the full output
 * room (its error is what the agent needs); the others share what is left.
 * Past the budget, cells are reported by status only.
 */
function renderRuns(results: RunResult[], att: Attachments): string {
  const withOutput = results.filter((r) => r.outputs.length);
  const failed = withOutput.filter((r) => r.status === "error").length;
  const others = withOutput.length - failed;
  const share = others ? Math.floor((RUN_BUDGET - failed * OUTPUT_MAX) / others) : OUTPUT_MAX;
  const perCell = Math.max(RUN_OUTPUT_MIN, Math.min(OUTPUT_MAX, share));
  const out: string[] = [];
  let used = 0;
  for (const r of results) {
    const head = runHead(r);
    if (used >= RUN_BUDGET && r.outputs.length && r.status !== "error") {
      out.push(`${head} (output not shown to keep this short; read_output shows it)`);
      continue;
    }
    const body = renderOutputs(r, r.status === "error" ? OUTPUT_MAX : perCell, att);
    const text = body ? `${head}\n${body}` : head;
    out.push(text);
    used += text.length + 2;
  }
  return out.join("\n\n");
}

async function findCell(ctx: ToolContext, cellId: string): Promise<CellInfo> {
  const { cells } = await ctx.call({ op: "get_cells", cellIds: [cellId] });
  const cell = cells[0];
  if (!cell) throw new Denied(`No cell with id "${cellId}". Call list_cells to see the current ids.`);
  return cell;
}

function reviewText(outcome: ReviewOutcome, what: string, reviewId: string): ToolResult {
  if (outcome === "accepted") return { text: `${what}: the user accepted the change; it is applied.` };
  if (outcome === "rejected") {
    return { text: `${what}: the user REJECTED the change, so nothing was applied. Do not retry the same change; ask the user what they want instead.` };
  }
  if (outcome === "discarded") {
    return {
      text: `${what}: the notebook page reloaded or navigated away before the user decided, so the change was not applied. Read the notebook again before proposing it anew.`,
      isError: true,
    };
  }
  return {
    text: `${what}: the change is shown to the user and still awaiting review (review_id "${reviewId}"). Call await_review with this review_id to wait for the decision before depending on it.`,
  };
}

const cellId = z.string().describe("Cell id, as shown by list_cells.");
const sessionArg = z.string().regex(SESSION_NAME).optional().describe('Terminal session name, like a terminal tab (letters, digits, - and _). Default "main".');
const waitArg = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Return after this long even if it is still running (it keeps running). Default: as long as this tool call may take.");

export const TOOLS = [
  tool({
    name: "notebook_info",
    description: "Title, platform, kernel state, active cell and the current permission mode of the notebook open in the user's browser.",
    schema: z.object({}),
    async run(ctx) {
      const info = await ctx.call({ op: "info" });
      return { text: describeInfo(info, ctx.settings(), ctx.targets()) };
    },
  }),
  tool({
    name: "list_cells",
    description: "Outline of every cell: index, id, type, first line, execution count. Use read_cells for full source and outputs.",
    schema: z.object({}),
    async run(ctx) {
      const { cells } = await ctx.call({ op: "get_cells", summary: true });
      if (!cells.length) return { text: "The notebook has no cells." };
      const line = (c: CellInfo) => {
        const exec = c.type === "code" ? ` [${c.running ? "*" : (c.executionCount ?? " ")}]` : "";
        const lines = c.lineCount ?? (c.source ? c.source.split("\n").length : 0);
        return `[${c.index}] ${c.id} ${c.type}${exec} (${lines} lines)${c.pendingReview ? " (pending review)" : ""}: ${firstLine(c.source) || "(empty)"}`;
      };
      return { text: joinWithinBudget(cells, line, "\n") };
    },
  }),
  tool({
    name: "read_output",
    description:
      "The full text output of one code cell, or of a run_shell / run_code result, for when it was shortened. Search it with pattern (a regular expression, case-insensitive) or page through it with start_line / line_count.",
    schema: z.object({
      cell_id: z.string().describe("Cell id, or the run id (run-N) a run_shell / run_code result named."),
      pattern: z.string().min(1).optional().describe("Show only the lines matching this, with context."),
      context_lines: z.number().int().min(0).max(20).optional().describe("Lines shown around each match. Default 2."),
      start_line: z.number().int().min(1).optional().describe("First line to show (1-based). Default 1."),
      line_count: z.number().int().min(1).max(1000).optional().describe("Lines to show. Default 200."),
    }),
    async run(ctx, a) {
      check(ctx, "read", null);
      let outputs = ctx.runs.get(a.cell_id);
      if (!outputs) {
        if (/^run-\d+$/.test(a.cell_id)) throw new Denied(`The output of ${a.cell_id} is no longer kept (only the latest runs are). Run it again.`);
        const cell = (await ctx.call({ op: "get_cells", cellIds: [a.cell_id], includeOutputs: true })).cells[0];
        if (!cell) throw new Denied(`No cell with id "${a.cell_id}". Call list_cells to see the current ids.`);
        outputs = cell.outputs ?? [];
      }
      const text = outputsToText(outputs, Infinity);
      if (!text) return { text: `${a.cell_id.startsWith("run-") ? "Run" : "Cell"} ${a.cell_id} has no text output.` };
      return { text: a.pattern ? searchLines(text, a.pattern, a.context_lines ?? 2) : pageLines(text, a.start_line ?? 1, a.line_count ?? 200) };
    },
  }),
  tool({
    name: "read_cells",
    description:
      "Full source of cells, with their outputs (plots come back as images when you can read them). Pass cell_ids, or an index range; with neither, reads the whole notebook.",
    schema: z.object({
      cell_ids: z.array(z.string()).optional().describe("Cells to read."),
      start_index: z.number().int().min(0).optional(),
      end_index: z.number().int().min(0).optional().describe("Inclusive."),
      include_outputs: z.boolean().optional().describe("Default true."),
      include_images: z.boolean().optional().describe("Attach plot images (at most 4 per call). Default true."),
    }),
    async run(ctx, a) {
      const includeOutputs = a.include_outputs ?? true;
      const { cells } = await ctx.call({ op: "get_cells", cellIds: a.cell_ids, start: a.start_index, end: a.end_index, includeOutputs });
      if (!cells.length) return { text: "No matching cells." };
      const att = new Attachments(ctx.images && (a.include_images ?? true));
      return att.result(joinWithinBudget(cells, (c) => renderCell(c, includeOutputs, att), "\n\n", att));
    },
  }),
  tool({
    name: "update_cell",
    description: "Replace the whole source of a cell. Prefer edit_cell for small changes to long cells.",
    schema: z.object({ cell_id: cellId, source: z.string().describe("The complete new source.") }),
    async run(ctx, a) {
      const d = check(ctx, "update", a.cell_id);
      return applyUpdate(ctx, a.cell_id, d.allow && d.review, () => a.source);
    },
  }),
  tool({
    name: "edit_cell",
    description: "Replace an exact snippet of a cell's source with new text. old_text must match exactly once unless replace_all is true.",
    schema: z.object({
      cell_id: cellId,
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    }),
    async run(ctx, a) {
      const d = check(ctx, "update", a.cell_id);
      return applyUpdate(ctx, a.cell_id, d.allow && d.review, (shown) => {
        // Matched against the source as the agent saw it (data URIs as marks).
        const count = shown.split(a.old_text).length - 1;
        if (count === 0) return { text: `old_text was not found in cell ${a.cell_id}. Read the cell again; it may have changed.`, isError: true };
        if (count > 1 && !a.replace_all) {
          return { text: `old_text matches ${count} places in cell ${a.cell_id}. Add surrounding context to make it unique, or pass replace_all.`, isError: true };
        }
        return a.replace_all ? shown.split(a.old_text).join(a.new_text) : shown.replace(a.old_text, () => a.new_text);
      });
    },
  }),
  tool({
    name: "insert_cell",
    description: "Insert a new code or markdown cell. Position it with after_cell_id or index; with neither, it goes at the end.",
    schema: z.object({
      cell_type: z.enum(["code", "markdown"]),
      source: z.string(),
      after_cell_id: z.string().optional().describe("Insert right after this cell."),
      index: z.number().int().min(0).optional().describe("Position of the new cell."),
    }),
    async run(ctx, a) {
      const d = check(ctx, "insert", null);
      const review = d.allow && d.review;
      const { index, res } = await ctx.exclusive("edit", async () => {
        let index: number;
        if (a.after_cell_id) index = (await findCell(ctx, a.after_cell_id)).index + 1;
        else if (a.index !== undefined) index = a.index;
        else index = (await ctx.call({ op: "info" })).cellCount;
        return { index, res: await ctx.call({ op: "insert_cell", index, cellType: a.cell_type, source: a.source, review }) };
      });
      if (!res.reviewId) return { text: `Inserted ${a.cell_type} cell ${res.cellId} at index ${index}.` };
      const outcome = await ctx.awaitReview(res.reviewId, ctx.waitMs);
      return reviewText(outcome, `New ${a.cell_type} cell ${res.cellId} at index ${index}`, res.reviewId);
    },
  }),
  tool({
    name: "delete_cell",
    description: "Delete a cell.",
    schema: z.object({ cell_id: cellId }),
    async run(ctx, a) {
      const d = check(ctx, "delete", a.cell_id);
      const res = await ctx.exclusive("edit", () => ctx.call({ op: "delete_cell", cellId: a.cell_id, review: d.allow && d.review }));
      if (!res.reviewId) return { text: `Deleted cell ${a.cell_id}.` };
      return reviewText(await ctx.awaitReview(res.reviewId, ctx.waitMs), `Deleting cell ${a.cell_id}`, res.reviewId);
    },
  }),
  tool({
    name: "move_cell",
    description: "Move a cell to a new index.",
    schema: z.object({ cell_id: cellId, index: z.number().int().min(0) }),
    async run(ctx, a) {
      check(ctx, "move", a.cell_id);
      const res = await ctx.exclusive("edit", () => ctx.call({ op: "move_cell", cellId: a.cell_id, index: a.index }));
      return { text: `Moved cell ${a.cell_id} to index ${res.index}.` };
    },
  }),
  tool({
    name: "run_cells",
    description:
      "Run code cells in order and return their outputs. Stops at the first error. If a cell is still running when the wait ends, it keeps running; use wait_for_cells.",
    schema: z.object({
      cell_ids: z.array(z.string()).min(1),
      timeout_seconds: z.number().int().min(1).optional().describe("How long to wait for the results."),
    }),
    async run(ctx, a) {
      const d = check(ctx, "run", a.cell_ids[0] ?? null);
      if (d.allow && d.askBeforeRun) {
        const ok = await ctx.confirmRun(`Run ${a.cell_ids.length === 1 ? "cell" : "cells"} ${a.cell_ids.join(", ")}`);
        if (!ok) return { text: "The user declined to run these cells. Nothing was run." };
      }
      return runAndReport(ctx, a.cell_ids, a.timeout_seconds);
    },
  }),
  tool({
    name: "run_all",
    description: "Run every code cell from the top, stopping at the first error.",
    schema: z.object({ timeout_seconds: z.number().int().min(1).optional() }),
    async run(ctx, a) {
      const d = check(ctx, "run", null);
      const { cells } = await ctx.call({ op: "get_cells", summary: true });
      const ids = cells.filter((c) => c.type === "code").map((c) => c.id);
      if (!ids.length) return { text: "There are no code cells to run." };
      if (d.allow && d.askBeforeRun) {
        const ok = await ctx.confirmRun(`Run all ${ids.length} code cells`);
        if (!ok) return { text: "The user declined to run the notebook. Nothing was run." };
      }
      return runAndReport(ctx, ids, a.timeout_seconds);
    },
  }),
  tool({
    name: "wait_for_cells",
    description: "Wait for running cells to finish and return their outputs.",
    schema: z.object({ cell_ids: z.array(z.string()).min(1), timeout_seconds: z.number().int().min(1).optional() }),
    async run(ctx, a) {
      check(ctx, "read", null);
      const deadline = Date.now() + Math.min((a.timeout_seconds ?? Infinity) * 1000, ctx.waitMs);
      // Poll the running state only; outputs (images included) are fetched once at the end.
      for (;;) {
        const { cells } = await ctx.call({ op: "get_cells", cellIds: a.cell_ids });
        if (!cells.some((c) => c.running) || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const { cells } = await ctx.call({ op: "get_cells", cellIds: a.cell_ids, includeOutputs: true });
      const att = new Attachments(ctx.images);
      return att.result(joinWithinBudget(cells, (c) => renderCell(c, true, att), "\n\n", att));
    },
  }),
  tool({
    name: "run_shell",
    description:
      "Run a command in a terminal on the machine the notebook's kernel runs on (the Colab or Kaggle VM), as you would in a terminal on your own computer. " +
      "Each session is a persistent interactive bash: cd, exported variables and an activated environment carry over to the next command, and it outlives kernel restarts. " +
      "Commands run until they finish, however long. If one is still running when this call has waited long enough, you get its output so far and it keeps running: " +
      "then use shell_wait, shell_input (to answer a prompt) or shell_interrupt (Ctrl+C). " +
      "Use more sessions, by name, to run things side by side (a server in one, commands in another). " +
      "You see what the terminal shows (progress bars in their final state). The notebook's Python variables are not visible here; run_code sees them. " +
      "Steps the notebook needs in order to run again (installs it imports, downloads it reads) still belong in cells.",
    schema: z.object({
      command: z.string().min(1).describe("What to type at the prompt; may span several lines."),
      session: sessionArg,
      wait_seconds: waitArg,
    }),
    async run(ctx, a) {
      const d = check(ctx, "execute", null);
      await requirePython(ctx);
      const name = a.session ?? "main";
      if (d.allow && d.askBeforeRun && !(await ctx.confirmRun(`Run in the notebook machine's terminal${name === "main" ? "" : ` (${name})`}`, a.command))) {
        return { text: "The user declined to run this command. Nothing was run." };
      }
      const deadline = Date.now() + waitWindow(ctx, a.wait_seconds);
      const exec = kernelExec(ctx);
      return ctx.shells.exclusive(name, async (sh) => {
        const { paused: before } = await catchUp(sh, exec, deadline);
        if (sh.state === "running") return busySession(sh);
        // A command that ended after the agent last looked: say how, before the new one.
        const previous = sh.command?.end ? shellResult(ctx, sh, sh.report(false)) : undefined;
        await sh.start(exec, a.command);
        const cmd = sh.command!;
        const { paused } = await sh.pollUntil(exec, () => !!cmd.end, deadline);
        const result = shellResult(ctx, sh, sh.report(paused || before));
        if (previous) result.text = `(the previous command ended meanwhile: ${previous.text})\n\n${result.text}`;
        return result;
      });
    },
  }),
  tool({
    name: "shell_wait",
    description:
      "Wait for the command running in a terminal session and show what it printed since you last looked, or, with nothing running, what background jobs printed.",
    schema: z.object({ session: sessionArg, wait_seconds: waitArg }),
    async run(ctx, a) {
      check(ctx, "read", null);
      const name = a.session ?? "main";
      const deadline = Date.now() + waitWindow(ctx, a.wait_seconds);
      const exec = kernelExec(ctx);
      return ctx.shells.exclusive(name, async (sh) => {
        if (sh.state === "new") await sh.open(exec, deadline);
        const cmd = sh.command;
        const { paused } = await sh.pollUntil(exec, () => sh.state !== "running" || !!cmd?.end, deadline);
        return shellResult(ctx, sh, sh.report(paused));
      });
    },
  }),
  tool({
    name: "shell_input",
    description:
      "Type into the program running in a terminal session (answer a prompt, feed a REPL), then show what it printed. " +
      "Enter is pressed after the text unless press_enter is false. Control characters work too: \\u0004 is Ctrl+D, \\u001b is Escape.",
    schema: z.object({
      text: z.string(),
      session: sessionArg,
      press_enter: z.boolean().optional().describe("Default true."),
    }),
    async run(ctx, a) {
      const d = check(ctx, "execute", null);
      const name = a.session ?? "main";
      if (d.allow && d.askBeforeRun && !(await ctx.confirmRun(`Type into the terminal${name === "main" ? "" : ` (${name})`}`, a.text))) {
        return { text: "The user declined. Nothing was typed." };
      }
      const exec = kernelExec(ctx);
      return ctx.shells.exclusive(name, async (sh) => {
        await catchUp(sh, exec, Date.now() + waitWindow(ctx));
        if (sh.state !== "running") return { text: `Nothing is running in session "${name}". Use run_shell to run a command.`, isError: true };
        const cmd = sh.command;
        await sh.type(exec, a.text + (a.press_enter ?? true ? "\r" : ""));
        const { paused } = await sh.pollUntil(exec, () => !!cmd?.end, Date.now() + Math.min(2_000, waitWindow(ctx)));
        return shellResult(ctx, sh, sh.report(paused));
      });
    },
  }),
  tool({
    name: "shell_interrupt",
    description: "Press Ctrl+C in a terminal session, stopping the command running there, and show its last output.",
    schema: z.object({ session: sessionArg }),
    async run(ctx, a) {
      check(ctx, "interrupt", null);
      const name = a.session ?? "main";
      const exec = kernelExec(ctx);
      return ctx.shells.exclusive(name, async (sh) => {
        await catchUp(sh, exec, Date.now() + waitWindow(ctx));
        if (sh.state !== "running") return { text: `Nothing is running in session "${name}".` };
        const cmd = sh.command;
        await sh.type(exec, "\u0003");
        const { paused } = await sh.pollUntil(exec, () => !!cmd?.end, Date.now() + Math.min(5_000, waitWindow(ctx)));
        return shellResult(ctx, sh, sh.report(paused));
      });
    },
  }),
  tool({
    name: "run_code",
    description:
      "Run code on the notebook's kernel, in its language, without adding a cell, and see its output: it sees and changes the notebook's variables " +
      "(df.shape, df.head(), a model's config, torch.cuda.is_available()). It runs until it finishes, like a cell; if it is still running when this call " +
      "has waited long enough, you get its output so far and a run id for wait_for_code, and the kernel stays busy meanwhile (interrupt_kernel stops it). " +
      "Not while a cell is running. Work the notebook depends on belongs in cells (insert_cell, run_cells).",
    schema: z.object({ code: z.string().min(1), wait_seconds: waitArg }),
    async run(ctx, a) {
      const d = check(ctx, "execute", null);
      if (d.allow && d.askBeforeRun && !(await ctx.confirmRun("Run code on the kernel (no cell is added)", a.code))) {
        return { text: "The user declined to run this code. Nothing was run." };
      }
      const waitMs = waitWindow(ctx, a.wait_seconds);
      const started = Date.now();
      const res = await ctx.exclusive("run", () => ctx.call({ op: "execute", code: a.code, waitMs }, waitMs + 30_000));
      return codeResult(ctx, res, Date.now() - started);
    },
  }),
  tool({
    name: "wait_for_code",
    description: "Keep waiting for code run_code left running, by the run id it gave.",
    schema: z.object({ run_id: z.string().min(1), wait_seconds: waitArg }),
    async run(ctx, a) {
      check(ctx, "read", null);
      const waitMs = waitWindow(ctx, a.wait_seconds);
      const started = Date.now();
      const res = await ctx.exclusive("run", () => ctx.call({ op: "execute_wait", execId: a.run_id, waitMs }, waitMs + 30_000));
      return codeResult(ctx, res, Date.now() - started);
    },
  }),
  tool({
    name: "interrupt_kernel",
    description: "Interrupt the running kernel (stop the executing cell).",
    schema: z.object({}),
    async run(ctx) {
      check(ctx, "interrupt", null);
      const res = await ctx.call({ op: "interrupt" });
      return { text: res.interrupted ? "Kernel interrupted." : "Nothing was running." };
    },
  }),
  tool({
    name: "await_review",
    description: "Wait for the user's decision on a change that is awaiting review.",
    schema: z.object({ review_id: z.string() }),
    async run(ctx, a) {
      return reviewText(await ctx.awaitReview(a.review_id, ctx.waitMs), `Review ${a.review_id}`, a.review_id);
    },
  }),
];

/**
 * Read the cell, compute its new source from what the agent was shown, and
 * write it, with no other edit in between. The review (if any) is awaited
 * outside the lock, so other edits can be proposed meanwhile.
 */
async function applyUpdate(ctx: ToolContext, id: string, review: boolean, edit: (shown: string) => string | ToolResult): Promise<ToolResult> {
  const res = await ctx.exclusive("edit", async () => {
    const cell = await findCell(ctx, id);
    const { text, payloads } = hideDataUris(cell.source);
    const next = edit(text);
    if (typeof next !== "string") return next;
    return ctx.call({ op: "update_cell", cellId: id, source: restoreDataUris(next, payloads), review });
  });
  if ("text" in res) return res;
  if (!res.reviewId) return { text: res.applied ? `Updated cell ${id}.` : `Cell ${id} already had that content.` };
  return reviewText(await ctx.awaitReview(res.reviewId, ctx.waitMs), `Change to cell ${id}`, res.reviewId);
}

function numbered(lines: string[], from: number): string {
  return lines.map((l, k) => `${from + k}: ${l.length > 2000 ? `${l.slice(0, 1999)}…` : l}`).join("\n");
}

function pageLines(text: string, start: number, count: number): string {
  const lines = text.split("\n");
  if (start > lines.length) return `The output has only ${lines.length} lines.`;
  const shown = lines.slice(start - 1, start - 1 + count);
  const end = start + shown.length - 1;
  let body = numbered(shown, start);
  if (body.length > PAGE_MAX) body = capLines(body, PAGE_MAX, 0.5);
  const more = end < lines.length ? ` Continue with start_line=${end + 1}.` : "";
  return `Lines ${start}-${end} of ${lines.length}.${more}\n${body}`;
}

function searchLines(text: string, pattern: string, context: number): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const lines = text.split("\n");
  const hits = lines.flatMap((l, k) => (re.test(l) ? [k] : []));
  if (!hits.length) return `No line of the output (${lines.length} lines) matches ${JSON.stringify(pattern)}.`;
  const MAX_HITS = 60;
  // Merge overlapping context windows into blocks.
  const blocks: [number, number][] = [];
  for (const k of hits.slice(0, MAX_HITS)) {
    const from = Math.max(0, k - context);
    const to = Math.min(lines.length - 1, k + context);
    const last = blocks.at(-1);
    if (last && from <= last[1] + 1) last[1] = to;
    else blocks.push([from, to]);
  }
  let body = blocks.map(([from, to]) => numbered(lines.slice(from, to + 1), from + 1)).join("\n--\n");
  if (body.length > PAGE_MAX) body = capLines(body, PAGE_MAX, 0.6);
  const extra = hits.length > MAX_HITS ? ` Showing the first ${MAX_HITS}; narrow the pattern or page with start_line.` : "";
  return `${hits.length} matching line${hits.length === 1 ? "" : "s"} of ${lines.length}.${extra}\n${body}`;
}

/** How long a call waits: what was asked, within what is left of the tool call's time. */
function waitWindow(ctx: ToolContext, seconds?: number): number {
  return Math.max(1_000, Math.min((seconds ?? Infinity) * 1000, ctx.waitMs - WAIT_MARGIN_MS));
}

function kernelExec(ctx: ToolContext): KernelExec {
  return (code, waitMs) => ctx.call({ op: "execute", code, waitMs }, waitMs + 15_000);
}

async function requirePython(ctx: ToolContext): Promise<void> {
  const info = await ctx.call({ op: "info" });
  if (info.language !== "python") {
    throw new Denied(`The terminal is reached through a Python kernel; this notebook's kernel runs ${info.language}. Use run_code with the language's own call (system() in R, run() in Julia).`);
  }
}

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Open the session (or find it again after a bridge restart), then read what it printed meanwhile. */
async function catchUp(sh: ShellSession, exec: KernelExec, deadline: number): Promise<{ paused: boolean }> {
  if (sh.state === "new" || sh.state === "exited") {
    await sh.open(exec, deadline);
    return { paused: false };
  }
  return sh.refresh(exec);
}

function busySession(sh: ShellSession): ToolResult {
  const c = sh.command;
  return {
    text:
      `Session "${sh.name}" is still running ${c ? `\`${firstLine(c.command, 60)}\` (for ${duration(Date.now() - c.startedAt)})` : "a command"}. ` +
      "Wait for it (shell_wait), answer it (shell_input), stop it (shell_interrupt), or run this in another session (session: \"<name>\").",
    isError: true,
  };
}

/** Text of an output for the agent, shortened when long, the full text kept for read_output. */
function shortened(ctx: ToolContext, text: string, full = text): string {
  const body = capLines(text, EXEC_OUTPUT_MAX, 0.3);
  if (!wasShortened(body)) return body;
  const id = ctx.runs.add([{ kind: "stream", name: "stdout", text: full }]);
  return `${body}\n(output shortened: read_output with cell_id "${id}" pages through or searches all of it)`;
}

function shellResult(ctx: ToolContext, sh: ShellSession, r: Report): ToolResult {
  const where = sh.name === "main" ? "" : ` · session ${sh.name}`;
  const notes: string[] = [];
  const cmd = r.command;
  let head: string;
  let failed = false;
  if (r.state === "exited") {
    head = `the shell exited${r.exitCode != null ? ` (exit code ${r.exitCode})` : ""}${where}; the next run_shell starts a new one`;
  } else if (r.full !== undefined && cmd) {
    head = `exit code ${cmd.status}${cmd.status === 130 ? " (interrupted)" : ""} · ${duration(Date.now() - cmd.startedAt)}${where}`;
    failed = cmd.status !== 0;
  } else if (cmd && r.state === "running") {
    head =
      `still running after ${duration(Date.now() - cmd.startedAt)}${where}. It keeps running: shell_wait for more output, ` +
      "shell_input to type into it, shell_interrupt for Ctrl+C";
  } else {
    head = `idle${where}`;
  }
  if (r.paused) notes.push("(the kernel was busy running a cell, so the terminal could not be read for part of this wait; the command itself kept running)");
  if (r.screen) notes.push("(a full-screen program is showing; this is its screen)");
  if (r.scrolledOut) notes.push(`(the start of this output scrolled out of the terminal's ${SCROLLBACK}-line scrollback)`);
  const parts = [head, ...notes];
  if (r.between) parts.push(`(printed in the terminal before this command, by background jobs:)\n${capLines(r.between, 3000, 0.3)}\n(the command's output:)`);
  const text = r.text || (r.full !== undefined || r.state === "running" ? "(no output)" : "");
  if (text) parts.push(shortened(ctx, text, r.full ?? text));
  return { text: parts.join("\n"), isError: failed || undefined };
}

function codeResult(ctx: ToolContext, res: ExecResult, ms: number): ToolResult {
  const att = new Attachments(ctx.images);
  let head: string;
  if (res.status === "running") {
    head =
      `still running after ${duration(ms)} (run id ${res.execId}). The kernel stays busy until it ends: ` +
      "wait_for_code with this run id for the rest, interrupt_kernel to stop it";
  } else head = res.status === "ok" ? "ok" : `error${res.message ? ` — ${res.message}` : ""}`;
  const body = res.outputs.length ? outputsToText(res.outputs, EXEC_OUTPUT_MAX, att.attach) : "";
  let text = `${head}\n${body || "(no output)"}`;
  if (wasShortened(body)) text += `\n(output shortened: read_output with cell_id "${ctx.runs.add(res.outputs)}" pages through or searches all of it)`;
  return att.result(text, res.status === "error");
}

async function runAndReport(ctx: ToolContext, ids: string[], timeoutSeconds?: number): Promise<ToolResult> {
  const timeoutMs = Math.min((timeoutSeconds ?? Infinity) * 1000, ctx.waitMs);
  // One run at a time: the kernel runs cells one after another anyway, and Jupyter runs "the active cell".
  const { results } = await ctx.exclusive("run", () => ctx.call({ op: "run_cells", cellIds: ids, timeoutMs, stopOnError: true }, timeoutMs + 15_000));
  const att = new Attachments(ctx.images);
  const text = renderRuns(results, att);
  const stillRunning = results.some((r) => r.status === "timeout");
  return att.result(
    stillRunning ? `${text}\n\nSome cells are still running. Call wait_for_cells to keep waiting.` : text,
    results.some((r) => r.status === "error"),
  );
}

export function describeInfo(info: NotebookInfo, settings: ChatSettings, targets: string[]): string {
  const lines = [
    `Notebook: ${info.title} (${info.platform}) ${info.url}`,
    `Cells: ${info.cellCount}. Kernel: ${info.kernel}. Language: ${info.language}.`,
    `Active cell: ${info.activeCellId ?? "none"}${info.selectedCellIds.length > 1 ? `; selected: ${info.selectedCellIds.join(", ")}` : ""}.`,
    `Mode: ${SCOPE_LABEL[settings.scope]}${settings.review ? " with review (each change waits for the user's approval)" : ""}.`,
  ];
  if (settings.scope === "cell") lines.push(`Editable cell(s): ${targets.join(", ") || "none selected"}.`);
  return lines.join("\n");
}

export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listTools(): McpToolListing[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema as z.ZodType, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { text: `Unknown tool ${name}.`, isError: true };
  const parsed = (t.schema as z.ZodType).safeParse(args ?? {});
  if (!parsed.success) return { text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, isError: true };
  try {
    return await (t as ToolDef<z.ZodType>).run(ctx, parsed.data);
  } catch (e) {
    if (e instanceof Denied || e instanceof ShellError) return { text: e.message, isError: true };
    return { text: `${name} failed: ${(e as Error).message}`, isError: true };
  }
}

export type { NotebookOp };
