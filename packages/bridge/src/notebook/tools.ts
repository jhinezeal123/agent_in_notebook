// The tools offered to every agent over MCP. The agent works on the machine
// the notebook runs on (the Colab or Kaggle VM) as it would on its own
// computer: a terminal (Bash), files (Read, Write, Edit, Glob, Grep), and the
// notebook itself as an .ipynb file in the working directory, kept in step
// with the editor in the browser (see nbfile.ts). Running cells stays with the
// notebook tools. Each call is checked against the chat's mode at the moment
// it runs, so switching mode in the side panel takes effect on the agent's
// very next tool call.

import { z } from "zod";
import {
  capLines,
  decide,
  firstLine,
  hideDataUris,
  restoreDataUris,
  outputsToText,
  SCOPE_LABEL,
  type CellInfo,
  type CellOutput,
  type CellType,
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
import { asCellInfo, editCells, EditError, fromCellInfo, NotebookFormatError, parseIpynb, replaceInCells, writeIpynb, type CellEdit, type NbCell } from "./ipynb.js";
import { KernelBusy, Unreachable, VmError, type KernelExec } from "./kernel.js";
import { applyCells, describeApplied, machineExec, notebookPath, places, reachable, reviewLine, syncIn, syncOut, type NotebookMirror } from "./nbfile.js";
import { SCROLLBACK, SESSION_NAME, type Report, type ShellSession, type ShellSessions, type ShellStart } from "./shell.js";
import { FileTooBig, glob, grep, readFile, readLines, resolvePath, writeFile, type Stat } from "./vmfs.js";

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
  /** Preview raster outputs from executing notebook code in the chat. */
  showOutputImage?(image: OutputImage): void;
  /**
   * Run `fn` alone among the chat's calls holding the same lock. Agents call
   * tools in parallel: two edits of one cell would read the same source and the
   * second would undo the first, and runs on Jupyter go through the active cell.
   */
  exclusive<T>(lock: "edit" | "run", fn: () => Promise<T>): Promise<T>;
  /** Outputs of the chat's latest Bash / run_code calls, for read_output. */
  runs: RecentRuns;
  /** The chat's terminal sessions on the notebook's machine. */
  shells: ShellSessions;
  /** The notebook's file on its machine. */
  mirror: NotebookMirror;
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
/** Lines Read shows of a file by default. */
const READ_LINES = 2000;
/** Image files Read shows as images. */
const IMAGE_FILES: Record<string, OutputImage["mime"]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

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
    long ? `source is ${text.length} characters, shown shortened; Edit needs text from the shown parts` : "",
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
function joinWithinBudget(cells: CellInfo[], render: (c: CellInfo) => string, sep: string, att?: Attachments, budget = READ_BUDGET, more = readMoreHint): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, c] of cells.entries()) {
    const mark = att?.mark();
    const text = render(c);
    if (i > 0 && used + text.length > budget) {
      if (mark) att!.reset(mark);
      out.push(more(cells.slice(i)));
      break;
    }
    out.push(text);
    used += text.length + sep.length;
  }
  return out.join(sep);
}

function readMoreHint(rest: CellInfo[]): string {
  const first = rest[0]!;
  return `… ${rest.length} more cell${rest.length === 1 ? "" : "s"} not shown to keep this short ([${first.index}]..[${rest.at(-1)!.index}]). Read them with offset=${first.index}.`;
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

const pathArg = z.string().min(1).describe("Path on the notebook's machine; relative paths start in the notebook's working directory.");
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
    description:
      "The notebook open in the user's editor: title, platform, kernel state, active cell, its file on the machine, and the current permission mode.",
    schema: z.object({}),
    async run(ctx) {
      const info = await ctx.call({ op: "info" });
      return { text: describeInfo(info, ctx.settings(), ctx.targets(), await notebookPath(ctx, info).catch(() => null)) };
    },
  }),
  tool({
    name: "Read",
    description:
      "Read a file on the notebook's machine, with line numbers (offset: first line, 1-based; limit: number of lines; default the first 2000). " +
      "An .ipynb file is shown as its cells with their outputs (offset and limit then count cells, from 0), and the notebook file itself " +
      "comes straight from the browser, so it is current even while a cell runs. PNG and JPEG files are shown as images.",
    schema: z.object({
      file_path: pathArg,
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    async run(ctx, a) {
      check(ctx, "read", null);
      const info = await ctx.call({ op: "info" });
      const path = await resolve(ctx, info, a.file_path);
      if (path === (await notebookPath(ctx, info))) {
        const { cells } = await ctx.call({ op: "get_cells", includeOutputs: true });
        const head = `${path}: the notebook open in the browser, ${cells.length} cell${cells.length === 1 ? "" : "s"}, shown as cells.`;
        return readCells(ctx, head, cells, a.offset, a.limit);
      }
      const exec = machine(ctx, info);
      const ext = path.split(".").pop()!.toLowerCase();
      if (ext === "ipynb") {
        const { cells } = parseIpynb((await readFile(exec, path)).data.toString("utf8"));
        return readCells(ctx, `${path}: a notebook file, ${cells.length} cell${cells.length === 1 ? "" : "s"}, shown as cells.`, asCellInfo(cells), a.offset, a.limit);
      }
      if (IMAGE_FILES[ext] && ctx.images) {
        const { data } = await readFile(exec, path, IMAGES_BYTES_MAX);
        return { text: `${path}: image, ${data.length} bytes, attached.`, images: [{ mime: IMAGE_FILES[ext]!, data: data.toString("base64") }] };
      }
      const start = Math.max(1, a.offset ?? 1);
      const r = await readLines(exec, path, start, a.limit ?? READ_LINES, READ_BUDGET);
      if (r.binary) return { text: `${path} is a binary file (${r.stat.size} bytes).` };
      if (!r.total) return { text: `${path} is empty.` };
      if (!r.lines.length) return { text: `${path} has only ${r.total} lines.`, isError: true };
      const end = start + r.lines.length - 1;
      const body = r.lines.map((l, k) => `${String(start + k).padStart(6)}\t${l}`).join("\n");
      const more = end < r.total ? `\n(lines ${start}-${end} of ${r.total}; continue with offset=${end + 1})` : "";
      return { text: body + more };
    },
  }),
  tool({
    name: "Write",
    description:
      "Write a file on the notebook's machine, replacing it (parent directories are made). Writing the notebook file (.ipynb JSON) replaces the " +
      "notebook in the browser: cells are matched by id, so keep the ids of cells you keep; cells without an id are added. Outputs come from running cells and are not written.",
    schema: z.object({ file_path: pathArg, content: z.string() }),
    async run(ctx, a) {
      const info = await ctx.call({ op: "info" });
      const path = await resolve(ctx, info, a.file_path);
      if (path === (await notebookPath(ctx, info))) {
        let target: NbCell[];
        try {
          target = parseIpynb(a.content).cells;
        } catch (e) {
          if (e instanceof NotebookFormatError) throw new Denied(`Nothing was written: ${path} is the notebook, so the content must be the notebook as .ipynb JSON. ${e.message}`);
          throw e;
        }
        return changeNotebook(ctx, path, () => target);
      }
      const exec = machine(ctx, info);
      await confirmFileChange(ctx, `Write ${path} on the notebook's machine`, capLines(a.content, 3000, 0.7));
      const r = await writeFile(exec, path, Buffer.from(a.content, "utf8"));
      return { text: "conflict" in r ? `${path} could not be written.` : `Wrote ${path} (${r.stat.size} bytes).`, isError: "conflict" in r || undefined };
    },
  }),
  tool({
    name: "Edit",
    description:
      "Replace exact text in a file on the notebook's machine. old_string must occur exactly once unless replace_all is true. " +
      "In an .ipynb file (the notebook file included), the text is matched inside the cells as Read shows them, without line numbers; " +
      "an edit to the notebook file changes the notebook in the browser.",
    schema: z.object({
      file_path: pathArg,
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    async run(ctx, a) {
      if (a.old_string === a.new_string) throw new Denied("old_string and new_string are the same; nothing to change.");
      const info = await ctx.call({ op: "info" });
      const path = await resolve(ctx, info, a.file_path);
      const replace = (cells: NbCell[]) => replaceInCells(cells, a.old_string, a.new_string, a.replace_all ?? false).cells;
      if (path === (await notebookPath(ctx, info))) return changeNotebook(ctx, path, replace);
      const exec = machine(ctx, info);
      if (/\.ipynb$/i.test(path)) return changeNotebookFile(ctx, exec, path, replace);
      const { data, stat } = await readWhole(exec, path);
      const text = data.toString("utf8");
      const count = text.split(a.old_string).length - 1;
      if (count === 0) throw new Denied(`old_string was not found in ${path}. Read the file again; it may differ from what you expect.`);
      if (count > 1 && !a.replace_all) throw new Denied(`old_string occurs ${count} times in ${path}. Add surrounding text to make it unique, or set replace_all.`);
      const next = a.replace_all ? text.split(a.old_string).join(a.new_string) : text.replace(a.old_string, () => a.new_string);
      await confirmFileChange(ctx, `Edit ${path} on the notebook's machine`, `- ${capLines(a.old_string, 1500, 0.7)}\n+ ${capLines(a.new_string, 1500, 0.7)}`);
      return finishWrite(exec, path, next, stat, `Edited ${path}${count > 1 ? ` (${count} places)` : ""}.`);
    },
  }),
  tool({
    name: "NotebookEdit",
    description:
      "Change the cells of an .ipynb file on the notebook's machine; on the notebook file, this changes the notebook in the browser. " +
      'edit_mode "replace" (default) sets a cell\'s source (and type, if given); "insert" adds a cell after cell_id (at the top without one); ' +
      '"delete" removes a cell; "move" moves a cell to index (0-based).',
    schema: z.object({
      notebook_path: pathArg,
      cell_id: z.string().optional().describe("The cell to change; for insert, the cell the new one follows."),
      new_source: z.string().optional(),
      cell_type: z.enum(["code", "markdown"]).optional().describe("Required for insert."),
      edit_mode: z.enum(["replace", "insert", "delete", "move"]).optional(),
      index: z.number().int().min(0).optional().describe("For move: the cell's new index."),
    }),
    async run(ctx, a) {
      const edit = notebookEdit(a);
      const info = await ctx.call({ op: "info" });
      const path = await resolve(ctx, info, a.notebook_path);
      const apply = (cells: NbCell[]) => editCells(cells, edit);
      if (path === (await notebookPath(ctx, info))) return changeNotebook(ctx, path, apply);
      if (!/\.ipynb$/i.test(path)) throw new Denied(`${path} is not an .ipynb file; use Edit or Write.`);
      return changeNotebookFile(ctx, machine(ctx, info), path, apply);
    },
  }),
  tool({
    name: "Glob",
    description: 'Find files on the notebook\'s machine by pattern ("**/*.py", "data/*.{csv,parquet}"), newest first.',
    schema: z.object({ pattern: z.string().min(1), path: z.string().optional().describe("Directory to search; default the working directory.") }),
    async run(ctx, a) {
      check(ctx, "read", null);
      const info = await ctx.call({ op: "info" });
      const exec = machine(ctx, info);
      const notes = await syncOutNotes(ctx);
      const base = await resolve(ctx, info, a.path ?? ".");
      const r = await glob(exec, base, a.pattern, 200);
      const body = r.paths.length ? r.paths.join("\n") : `No files match ${a.pattern} in ${base}.`;
      const more = r.total > r.paths.length || r.more ? `\n(${r.more ? "search stopped early; " : ""}showing ${r.paths.length} of ${r.total}${r.more ? "+" : ""} files; narrow the pattern)` : "";
      return withNotes(notes, { text: body + more });
    },
  }),
  tool({
    name: "Grep",
    description:
      "Search file contents on the notebook's machine with a regular expression (Python syntax). Skips binary files and hidden, .git and node_modules directories. " +
      'output_mode: "files_with_matches" (default, newest first), "content" (matching lines as path:line:text), or "count".',
    schema: z.object({
      pattern: z.string().min(1),
      path: z.string().optional().describe("File or directory to search; default the working directory."),
      glob: z.string().optional().describe('Only files matching this ("*.py", "*.{ts,tsx}").'),
      output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
      "-i": z.boolean().optional().describe("Ignore case."),
      "-C": z.number().int().min(0).max(20).optional().describe("Lines of context around each match (content mode)."),
      head_limit: z.number().int().min(1).optional().describe("Show at most this many results."),
    }),
    async run(ctx, a) {
      check(ctx, "read", null);
      const info = await ctx.call({ op: "info" });
      const exec = machine(ctx, info);
      const notes = await syncOutNotes(ctx);
      const base = await resolve(ctx, info, a.path ?? ".");
      const mode = a.output_mode ?? "files_with_matches";
      const limit = a.head_limit ?? (mode === "content" ? 200 : 100);
      const r = await grep(exec, { pattern: a.pattern, base, glob: a.glob, ignore_case: a["-i"] ?? false, mode, context: a["-C"] ?? 0, limit });
      let lines: string[];
      if (mode === "content") lines = r.hits.map(([p, n, text, hit]) => `${p}${hit ? ":" : "-"}${n}${hit ? ":" : "-"}${text}`);
      else if (mode === "count") lines = r.counts.slice(0, limit).map(([p, n]) => `${p}:${n}`);
      else lines = r.files.slice(0, limit);
      const total = mode === "content" ? r.hits.length : mode === "count" ? r.counts.length : r.files.length;
      if (!lines.length) return withNotes(notes, { text: `No matches for ${a.pattern} in ${base}.${r.more ? " (The search stopped early: too many files.)" : ""}` });
      let text = capLines(lines.join("\n"), EXEC_OUTPUT_MAX, 0.8);
      if (r.more || total > lines.length) text += `\n(more results not shown${r.more ? "; the search stopped early" : ""}: narrow the pattern, path or glob)`;
      return withNotes(notes, { text });
    },
  }),
  tool({
    name: "Bash",
    description:
      "Run a command in a terminal on the machine the notebook runs on, as you would in a terminal on your own computer. " +
      "Each session is a persistent interactive bash: cd, exported variables and an activated environment carry over to the next command, and it outlives kernel restarts. " +
      "Commands run until they finish, however long. If one is still running when this call has waited long enough, you get its output so far and it keeps running: " +
      "then use shell_wait, shell_input (to answer a prompt) or shell_interrupt (Ctrl+C). " +
      "Use more sessions, by name, to run things side by side (a server in one, commands in another). " +
      "You see what the terminal shows (progress bars in their final state). The notebook's Python variables are not visible here; run_code sees them. " +
      "The notebook's file is in the working directory: commands may read or change it, and changes reach the notebook in the browser.",
    schema: z.object({
      command: z.string().min(1).describe("What to type at the prompt; may span several lines."),
      session: sessionArg,
      wait_seconds: waitArg,
    }),
    async run(ctx, a) {
      const d = check(ctx, "execute", null);
      const { exec, start } = await terminal(ctx);
      const name = a.session ?? "main";
      if (d.allow && d.askBeforeRun && !(await ctx.confirmRun(`Run in the notebook machine's terminal${name === "main" ? "" : ` (${name})`}`, a.command))) {
        return { text: "The user declined to run this command. Nothing was run." };
      }
      const deadline = Date.now() + waitWindow(ctx, a.wait_seconds);
      const before = await syncOutNotes(ctx);
      const result = await ctx.shells.exclusive(name, async (sh) => {
        const { paused: before } = await catchUp(sh, exec, deadline, start);
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
      return withNotes(before, withNotes(await syncInNotes(ctx), result, "after"));
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
      const { exec, start } = await terminal(ctx);
      const result = await ctx.shells.exclusive(name, async (sh) => {
        if (sh.state === "new") await sh.open(exec, deadline, start);
        const cmd = sh.command;
        const { paused } = await sh.pollUntil(exec, () => sh.state !== "running" || !!cmd?.end, deadline);
        return shellResult(ctx, sh, sh.report(paused));
      });
      return withNotes(await syncInNotes(ctx), result, "after");
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
      const { exec, start } = await terminal(ctx);
      const result = await ctx.shells.exclusive(name, async (sh) => {
        await catchUp(sh, exec, Date.now() + waitWindow(ctx), start);
        if (sh.state !== "running") return { text: `Nothing is running in session "${name}". Use Bash to run a command.`, isError: true };
        const cmd = sh.command;
        await sh.type(exec, a.text + (a.press_enter ?? true ? "\r" : ""));
        const { paused } = await sh.pollUntil(exec, () => !!cmd?.end, Date.now() + Math.min(2_000, waitWindow(ctx)));
        return shellResult(ctx, sh, sh.report(paused));
      });
      return withNotes(await syncInNotes(ctx), result, "after");
    },
  }),
  tool({
    name: "shell_interrupt",
    description: "Press Ctrl+C in a terminal session, stopping the command running there, and show its last output.",
    schema: z.object({ session: sessionArg }),
    async run(ctx, a) {
      check(ctx, "interrupt", null);
      const name = a.session ?? "main";
      const { exec, start } = await terminal(ctx);
      const result = await ctx.shells.exclusive(name, async (sh) => {
        await catchUp(sh, exec, Date.now() + waitWindow(ctx), start);
        if (sh.state !== "running") return { text: `Nothing is running in session "${name}".` };
        const cmd = sh.command;
        await sh.type(exec, "\u0003");
        const { paused } = await sh.pollUntil(exec, () => !!cmd?.end, Date.now() + Math.min(5_000, waitWindow(ctx)));
        return shellResult(ctx, sh, sh.report(paused));
      });
      return withNotes(await syncInNotes(ctx), result, "after");
    },
  }),
  tool({
    name: "run_cells",
    description:
      "Run code cells of the notebook in order and return their outputs. Stops at the first error. If a cell is still running when the wait ends, it keeps running; use wait_for_cells.",
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
    description: "Run every code cell of the notebook from the top, stopping at the first error.",
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
      showOutputImages(ctx, cells.flatMap((cell) => cell.outputs ?? []));
      const att = new Attachments(ctx.images);
      return att.result(joinWithinBudget(cells, (c) => renderCell(c, true, att), "\n\n", att, READ_BUDGET, (rest) => `… ${rest.length} more cells not shown; wait for them separately.`));
    },
  }),
  tool({
    name: "read_output",
    description:
      "The full text output of one code cell, or of a Bash / run_code result, for when it was shortened. Search it with pattern (a regular expression, case-insensitive) or page through it with start_line / line_count.",
    schema: z.object({
      cell_id: z.string().describe("Cell id, or the run id (run-N) a Bash / run_code result named."),
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
        if (!cell) throw new Denied(`No cell with id "${a.cell_id}". Read the notebook file to see the current ids.`);
        outputs = cell.outputs ?? [];
      }
      const text = outputsToText(outputs, Infinity);
      if (!text) return { text: `${a.cell_id.startsWith("run-") ? "Run" : "Cell"} ${a.cell_id} has no text output.` };
      return { text: a.pattern ? searchLines(text, a.pattern, a.context_lines ?? 2) : pageLines(text, a.start_line ?? 1, a.line_count ?? 200) };
    },
  }),
  tool({
    name: "run_code",
    description:
      "Run code on the notebook's kernel, in its language, without adding a cell, and see its output: it sees and changes the notebook's variables " +
      "(df.shape, df.head(), a model's config, torch.cuda.is_available()). It runs until it finishes, like a cell; if it is still running when this call " +
      "has waited long enough, you get its output so far and a run id for wait_for_code, and the kernel stays busy meanwhile (interrupt_kernel stops it). " +
      "Not while a cell is running. Work the notebook depends on belongs in its cells.",
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
    description: "Wait for the user's decision on a change to the notebook that is awaiting review.",
    schema: z.object({ review_id: z.string() }),
    async run(ctx, a) {
      return { text: reviewLine(await ctx.awaitReview(a.review_id, ctx.waitMs), `Review ${a.review_id}`, a.review_id) };
    },
  }),
];

// ------------------------------------------------------------ files

/** The machine is reached through a Python kernel; returns the way to it. */
function machine(ctx: ToolContext, info: NotebookInfo): KernelExec {
  if (!reachable(info)) {
    throw new Denied(
      `The notebook's machine is reached through its Python kernel; this kernel runs ${info.language}. ` +
        "The notebook file itself can still be read and edited; run commands with run_code and the language's own call (system() in R, run() in Julia).",
    );
  }
  return machineExec(ctx);
}

/** The way to the machine's terminal sessions, and where a new one starts. */
async function terminal(ctx: ToolContext): Promise<{ exec: KernelExec; start: ShellStart }> {
  const info = await ctx.call({ op: "info" });
  const exec = machine(ctx, info);
  const at = await places(ctx, info);
  return { exec, start: { cwd: at.cwd, env: at.env } };
}

async function resolve(ctx: ToolContext, info: NotebookInfo, p: string): Promise<string> {
  return resolvePath(p, await places(ctx, info));
}

async function readWhole(exec: KernelExec, path: string): Promise<{ data: Buffer; stat: Stat }> {
  try {
    return await readFile(exec, path);
  } catch (e) {
    if (e instanceof FileTooBig) throw new Denied(`${e.message} Change it with a command in Bash instead.`);
    throw e;
  }
}

/** Cells as Read shows them, from `offset` (a cell index), at most `limit` of them. */
function readCells(ctx: ToolContext, head: string, cells: CellInfo[], offset?: number, limit?: number): ToolResult {
  const from = offset ?? 0;
  const shown = cells.slice(from, limit ? from + limit : undefined);
  if (!shown.length) return { text: `${head}\nNo cells in that range.` };
  const att = new Attachments(ctx.images);
  return att.result(`${head}\n\n${joinWithinBudget(shown, (c) => renderCell(c, true, att), "\n\n", att)}`);
}

/** In review mode, VM file changes wait for the user, like commands. */
async function confirmFileChange(ctx: ToolContext, summary: string, detail: string): Promise<void> {
  const d = check(ctx, "execute", null);
  if (d.allow && d.askBeforeRun && !(await ctx.confirmRun(summary, detail))) throw new Denied("The user declined this change. Nothing was changed.");
}

async function finishWrite(exec: KernelExec, path: string, text: string, expect: Stat, done: string): Promise<ToolResult> {
  const r = await writeFile(exec, path, Buffer.from(text, "utf8"), expect);
  if ("conflict" in r) return { text: `${path} changed while it was being edited, so nothing was written. Read it again and redo the edit.`, isError: true };
  return { text: done };
}

/**
 * Change the open notebook (through its file's path): `edit` gets the cells as
 * they are in the browser and returns what they should be. Reviews are awaited
 * after the edit lock is released; then the file follows.
 */
async function changeNotebook(ctx: ToolContext, path: string, edit: (cells: NbCell[]) => NbCell[]): Promise<ToolResult> {
  const applied = await ctx.exclusive("edit", async () => {
    const before = fromCellInfo((await ctx.call({ op: "get_cells" })).cells);
    let after: NbCell[];
    try {
      after = edit(before);
    } catch (e) {
      if (e instanceof EditError) throw new Denied(e.message);
      throw e;
    }
    // Read showed embedded images as marks; a cell that keeps a mark keeps its image.
    const old = new Map(before.map((c) => [c.id, hideDataUris(c.source).payloads]));
    after = after.map((c) => {
      const payloads = c.id ? old.get(c.id) : undefined;
      return payloads?.length ? { ...c, source: restoreDataUris(c.source, payloads) } : c;
    });
    return applyCells(ctx, before, after, { concurrent: false });
  });
  const report = await describeApplied(ctx, applied, true);
  const notes = await syncOutNotes(ctx);
  if (report.noop) return withNotes(notes, { text: `No change: the notebook already reads like that (${path}).` });
  return withNotes(notes, { text: report.lines.join("\n"), isError: report.failed || undefined });
}

/** Change another .ipynb file on the machine, cell by cell. */
async function changeNotebookFile(ctx: ToolContext, exec: KernelExec, path: string, edit: (cells: NbCell[]) => NbCell[]): Promise<ToolResult> {
  const { data, stat } = await readWhole(exec, path);
  let parsed: ReturnType<typeof parseIpynb>;
  try {
    parsed = parseIpynb(data.toString("utf8"));
  } catch (e) {
    if (e instanceof NotebookFormatError) throw new Denied(`${path} is not a notebook this can edit by cells: ${e.message} Edit it as text with Bash.`);
    throw e;
  }
  let after: NbCell[];
  try {
    after = edit(parsed.cells);
  } catch (e) {
    if (e instanceof EditError) throw new Denied(e.message);
    throw e;
  }
  await confirmFileChange(ctx, `Edit the notebook file ${path} on the notebook's machine`, `${after.length} cells after the change`);
  return finishWrite(exec, path, writeIpynb(parsed.doc, after), stat, `Edited ${path} (${after.length} cells).`);
}

function notebookEdit(a: { cell_id?: string; new_source?: string; cell_type?: CellType; edit_mode?: CellEdit["mode"]; index?: number }): CellEdit {
  const need = (v: unknown, what: string) => {
    if (v === undefined) throw new Denied(`${what} is required for edit_mode "${a.edit_mode ?? "replace"}".`);
  };
  switch (a.edit_mode ?? "replace") {
    case "replace":
      need(a.cell_id, "cell_id");
      need(a.new_source, "new_source");
      return { mode: "replace", cellId: a.cell_id!, source: a.new_source!, type: a.cell_type };
    case "insert":
      need(a.new_source, "new_source");
      need(a.cell_type, "cell_type");
      return { mode: "insert", afterId: a.cell_id, source: a.new_source!, type: a.cell_type! };
    case "delete":
      need(a.cell_id, "cell_id");
      return { mode: "delete", cellId: a.cell_id! };
    case "move":
      need(a.cell_id, "cell_id");
      need(a.index, "index");
      return { mode: "move", cellId: a.cell_id!, index: a.index! };
  }
}

/** Bring the notebook file up to date before the agent looks at the machine. */
async function syncOutNotes(ctx: ToolContext): Promise<string[]> {
  try {
    return await syncOut(ctx);
  } catch (e) {
    return [`(The notebook file could not be updated: ${(e as Error).message})`];
  }
}

/** Pick up what the agent's commands did to the notebook file. */
async function syncInNotes(ctx: ToolContext): Promise<string[]> {
  try {
    return await syncIn(ctx);
  } catch (e) {
    return [`(Changes to the notebook file could not be checked: ${(e as Error).message})`];
  }
}

function withNotes(notes: string[], r: ToolResult, where: "before" | "after" = "before"): ToolResult {
  if (!notes.length) return r;
  const block = notes.join("\n");
  return { ...r, text: where === "before" ? `${block}\n\n${r.text}` : `${r.text}\n\n${block}` };
}

// ------------------------------------------------------------ outputs

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

export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Open the session (or find it again after a bridge restart), then read what it printed meanwhile. */
async function catchUp(sh: ShellSession, exec: KernelExec, deadline: number, start: ShellStart): Promise<{ paused: boolean }> {
  if (sh.state === "new" || sh.state === "exited") {
    await sh.open(exec, deadline, start);
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
    head = `the shell exited${r.exitCode != null ? ` (exit code ${r.exitCode})` : ""}${where}; the next Bash call starts a new one`;
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

function showOutputImages(ctx: ToolContext, outputs: CellOutput[]): void {
  if (!ctx.showOutputImage) return;
  const preview = new Attachments(true);
  for (const { image } of outputs) if (image) preview.attach(image);
  for (const image of preview.images) ctx.showOutputImage(image);
}

function codeResult(ctx: ToolContext, res: ExecResult, ms: number): ToolResult {
  showOutputImages(ctx, res.outputs);
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
  showOutputImages(ctx, results.flatMap((result) => result.outputs));
  const stillRunning = results.some((r) => r.status === "timeout");
  return att.result(
    stillRunning ? `${text}\n\nSome cells are still running. Call wait_for_cells to keep waiting.` : text,
    results.some((r) => r.status === "error"),
  );
}

export function describeInfo(info: NotebookInfo, settings: ChatSettings, targets: string[], file: string | null = null): string {
  const lines = [
    `Notebook: ${info.title} (${info.platform}) ${info.url}`,
    file ? `Notebook file: ${file}` : "",
    `Cells: ${info.cellCount}. Kernel: ${info.kernel}. Language: ${info.language}.`,
    `Active cell: ${info.activeCellId ?? "none"}${info.selectedCellIds.length > 1 ? `; selected: ${info.selectedCellIds.join(", ")}` : ""}.`,
    `Mode: ${SCOPE_LABEL[settings.scope]}${settings.review ? " with review (each change waits for the user's approval)" : ""}.`,
  ].filter(Boolean);
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
    if (e instanceof Denied || e instanceof VmError) return { text: e.message, isError: true };
    if (e instanceof KernelBusy) {
      return { text: "The kernel is busy running a cell, so the notebook's machine cannot be reached until it finishes. The notebook file itself can still be read and edited.", isError: true };
    }
    if (e instanceof Unreachable) return { text: `${e.message} The notebook file itself can still be read and edited.`, isError: true };
    return { text: `${name} failed: ${(e as Error).message}`, isError: true };
  }
}

export type { NotebookOp };
