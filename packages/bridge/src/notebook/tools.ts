// The notebook tools offered to every agent over MCP. Each call is checked
// against the chat's mode at the moment it runs, so switching mode in the side
// panel takes effect on the agent's very next tool call.

import { z } from "zod";
import {
  capText,
  decide,
  firstLine,
  outputsToText,
  SCOPE_LABEL,
  type CellInfo,
  type ChatSettings,
  type NotebookInfo,
  type NotebookOp,
  type NotebookOpName,
  type NotebookOpOf,
  type NotebookOpResults,
  type OutputImage,
  type RunResult,
  type ToolAction,
} from "@ainb/protocol";

export type ReviewOutcome = "accepted" | "rejected" | "pending" | "discarded";

export interface ToolContext {
  settings(): ChatSettings;
  /** Cells the `cell` scope may edit for the current turn. */
  targets(): string[];
  call<N extends NotebookOpName>(op: NotebookOpOf<N>, timeoutMs?: number): Promise<NotebookOpResults[N]>;
  /** Wait for a review the page opened. */
  awaitReview(reviewId: string, waitMs: number): Promise<ReviewOutcome>;
  /** In review mode, ask the user before running cells. Resolves true to run. */
  confirmRun(summary: string): Promise<boolean>;
  /** Longest a call may block on the user or a running cell. */
  waitMs: number;
  /** The agent reads images in tool results, so plots are attached rather than described as hidden. */
  images: boolean;
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

function renderCell(c: CellInfo, withOutputs: boolean, att?: Attachments): string {
  const exec = c.type === "code" ? ` exec=${c.executionCount ?? "-"}${c.running ? " RUNNING" : ""}` : "";
  const pending = c.pendingReview ? " (change awaiting user review)" : "";
  const long = c.source.length > SOURCE_MAX;
  const source = long ? capText(c.source, SOURCE_MAX) : c.source;
  const note = long ? ` (source is ${c.source.length} characters, shown shortened; edit_cell needs text from the shown parts)` : "";
  let s = `### cell [${c.index}] id=${c.id} ${c.type}${exec}${pending}${note}\n${source}`;
  if (withOutputs && c.type === "code") {
    const out = c.outputs?.length ? outputsToText(c.outputs, OUTPUT_MAX, att?.attach) : "";
    s += `\n--- output ---\n${out || "(no output)"}`;
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

function renderRun(r: RunResult, att?: Attachments): string {
  const head = `cell ${r.cellId}: ${r.status}${r.executionCount != null ? ` (exec ${r.executionCount})` : ""}${r.message ? ` — ${r.message}` : ""}`;
  const out = outputsToText(r.outputs, OUTPUT_MAX, att?.attach);
  return out ? `${head}\n${out}` : head;
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
      const { cells } = await ctx.call({ op: "get_cells" });
      if (!cells.length) return { text: "The notebook has no cells." };
      const line = (c: CellInfo) => {
        const exec = c.type === "code" ? ` [${c.running ? "*" : (c.executionCount ?? " ")}]` : "";
        const lines = c.source ? c.source.split("\n").length : 0;
        return `[${c.index}] ${c.id} ${c.type}${exec} (${lines} lines)${c.pendingReview ? " (pending review)" : ""}: ${firstLine(c.source) || "(empty)"}`;
      };
      return { text: joinWithinBudget(cells, line, "\n") };
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
      return applyUpdate(ctx, a.cell_id, a.source, d.allow && d.review);
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
      const cell = await findCell(ctx, a.cell_id);
      const count = cell.source.split(a.old_text).length - 1;
      if (count === 0) return { text: `old_text was not found in cell ${a.cell_id}. Read the cell again; it may have changed.`, isError: true };
      if (count > 1 && !a.replace_all) {
        return { text: `old_text matches ${count} places in cell ${a.cell_id}. Add surrounding context to make it unique, or pass replace_all.`, isError: true };
      }
      const next = a.replace_all ? cell.source.split(a.old_text).join(a.new_text) : cell.source.replace(a.old_text, () => a.new_text);
      return applyUpdate(ctx, a.cell_id, next, d.allow && d.review);
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
      let index: number;
      if (a.after_cell_id) index = (await findCell(ctx, a.after_cell_id)).index + 1;
      else if (a.index !== undefined) index = a.index;
      else index = (await ctx.call({ op: "info" })).cellCount;
      const review = d.allow && d.review;
      const res = await ctx.call({ op: "insert_cell", index, cellType: a.cell_type, source: a.source, review });
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
      const res = await ctx.call({ op: "delete_cell", cellId: a.cell_id, review: d.allow && d.review });
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
      const res = await ctx.call({ op: "move_cell", cellId: a.cell_id, index: a.index });
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
      const { cells } = await ctx.call({ op: "get_cells" });
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

async function applyUpdate(ctx: ToolContext, id: string, source: string, review: boolean): Promise<ToolResult> {
  const res = await ctx.call({ op: "update_cell", cellId: id, source, review });
  if (!res.reviewId) return { text: res.applied ? `Updated cell ${id}.` : `Cell ${id} already had that content.` };
  return reviewText(await ctx.awaitReview(res.reviewId, ctx.waitMs), `Change to cell ${id}`, res.reviewId);
}

async function runAndReport(ctx: ToolContext, ids: string[], timeoutSeconds?: number): Promise<ToolResult> {
  const timeoutMs = Math.min((timeoutSeconds ?? Infinity) * 1000, ctx.waitMs);
  const { results } = await ctx.call({ op: "run_cells", cellIds: ids, timeoutMs, stopOnError: true }, timeoutMs + 15_000);
  const att = new Attachments(ctx.images);
  const text = results.map((r) => renderRun(r, att)).join("\n\n");
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
    if (e instanceof Denied) return { text: e.message, isError: true };
    return { text: `${name} failed: ${(e as Error).message}`, isError: true };
  }
}

export type { NotebookOp };
