// The open notebook as an .ipynb file on its machine, in the working
// directory. The editor in the browser stays the notebook itself; the file
// follows it, so the agent can work on the notebook like on any file there.
//
// - Editor to file: before the agent touches the machine (a command, a read,
//   a search), the file is written again if the notebook changed.
// - File to editor: after the agent's commands, a changed file is compared
//   with what was written, cell by cell (cells keep their ids), and the
//   difference is applied in the editor, under the chat's mode and review.
//   What the mode refuses or the user rejects goes back out of the file.
// - The agent's own reads and edits of this path (Read, Edit, NotebookEdit,
//   Write) go straight to the editor, so they work while a cell runs, and a
//   review's outcome comes back with the call.

import { posix } from "node:path";
import { decide, type CellInfo, type CellType, type NotebookInfo, type ToolAction } from "@ainb/protocol";
import { parseIpynb, toIpynb, NotebookFormatError, type NbCell } from "./ipynb.js";
import { Unreachable, type KernelExec } from "./kernel.js";
import { claim, hello, readFile, removeFile, sameStat, stat, writeFile, type Places, type Stat } from "./vmfs.js";
import type { ReviewOutcome, ToolContext } from "./tools.js";

/** The notebook file's state, kept by the chat. */
export class NotebookMirror {
  places: Places | null = null;
  /** The file name the notebook's title gives, and where it was claimed. */
  name: string | null = null;
  path: string | null = null;
  claimed = false;
  /** What the file held when the bridge last wrote (or read) it. */
  last: { text: string; stat: Stat; cells: NbCell[] } | null = null;
}

/** Where a platform's kernel works, for when the kernel cannot be asked. */
const DEFAULT_CWD: Record<NotebookInfo["platform"], string> = { colab: "/content", kaggle: "/kaggle/working", jupyter: "/" };

/** Python through the kernel itself: it sees the kernel's working directory and environment. */
export function kernelExec(ctx: ToolContext): KernelExec {
  return (code, waitMs) => ctx.call({ op: "execute", code, waitMs }, waitMs + 15_000);
}

/** Python on the machine for working it: through the notebook server's terminal when it lends one, else the kernel. */
export function machineExec(ctx: ToolContext): KernelExec {
  return (code, waitMs) => ctx.call({ op: "machine_exec", code, waitMs }, waitMs + 15_000);
}

export function reachable(info: NotebookInfo): boolean {
  return info.language === "python" || !!info.serverTerminals;
}

/**
 * The working directory and home on the machine, asked once. The kernel knows
 * them best (and its PATH, which the terminal gets, so `python` and `pip` there
 * are the notebook's); without it, the server's terminal is asked, else the
 * platform's usual places are guessed.
 */
export async function places(ctx: ToolContext, info: NotebookInfo): Promise<Places> {
  const m = ctx.mirror;
  if (m.places) return m.places;
  if (info.language === "python") {
    try {
      const h = await hello(kernelExec(ctx));
      const bin = posix.dirname(h.python);
      const path = h.path.split(":")[0] === bin ? h.path : `${bin}:${h.path}`;
      m.places = { cwd: h.cwd, home: h.home, env: h.posix && h.python ? { PATH: path } : undefined };
      return m.places;
    } catch {
      // Not now (no runtime, a cell running).
    }
  }
  if (info.serverTerminals) {
    try {
      const h = await hello(machineExec(ctx));
      // The server works from its root; a Jupyter kernel from the notebook's folder in it.
      const cwd = info.platform === "jupyter" ? posix.join(h.cwd, posix.dirname(info.docPath ?? "")) : DEFAULT_CWD[info.platform];
      m.places = { cwd, home: h.home };
      return m.places;
    } catch {
      // fall through to the guess
    }
  }
  return { cwd: DEFAULT_CWD[info.platform], home: info.platform === "jupyter" ? "/" : "/root" };
}

export function fileName(info: NotebookInfo): string {
  let base = info.platform === "jupyter" && info.docPath ? posix.basename(info.docPath) : info.title;
  base = base.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, "_").trim() || "notebook";
  if (!/\.ipynb$/i.test(base)) base += ".ipynb";
  return base;
}

/**
 * The notebook file's path. Claimed on the machine when it can be reached: a
 * file already there that the bridge did not write (a Jupyter server's own
 * copy of the notebook) is left alone, and the file gets another name.
 */
export async function notebookPath(ctx: ToolContext, info: NotebookInfo): Promise<string> {
  const m = ctx.mirror;
  const name = fileName(info);
  if (m.name !== name) {
    // A new title: the old file goes, the new one is written on the next sync.
    const old = m.claimed ? m.path : null;
    m.name = name;
    m.path = null;
    m.claimed = false;
    m.last = null;
    if (old && reachable(info)) await removeFile(machineExec(ctx), old).catch(() => {});
  }
  if (m.path && (m.claimed || !reachable(info))) return m.path;
  const dir = (await places(ctx, info)).cwd;
  const stem = name.replace(/\.ipynb$/i, "");
  const candidates = [name, `${stem}.agent.ipynb`, ...[2, 3, 4, 5].map((n) => `${stem}.agent-${n}.ipynb`)].map((n) => posix.join(dir, n));
  if (reachable(info) && ctx.mirror.places) {
    try {
      m.path = await claim(machineExec(ctx), candidates);
      m.claimed = true;
      return m.path;
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
    }
  }
  m.path ??= candidates[0]!;
  return m.path;
}

/** The notebook's text as an .ipynb file, from the editor. */
async function render(ctx: ToolContext, info: NotebookInfo): Promise<string> {
  const { cells } = await ctx.call({ op: "get_cells", includeOutputs: true });
  return toIpynb(cells, info.language);
}

/**
 * Bring the file up to date with the editor. A file changed on the machine
 * since it was written is applied to the editor first. Returns notes for the
 * agent (changes picked up from the file). Does nothing while the kernel is busy.
 */
export async function syncOut(ctx: ToolContext): Promise<string[]> {
  const info = await ctx.call({ op: "info" });
  if (!reachable(info)) return [];
  return ctx.exclusive("edit", async () => {
    try {
      await notebookPath(ctx, info);
      if (!ctx.mirror.claimed) return [];
      const notes: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const m = ctx.mirror;
        const text = await render(ctx, info);
        if (m.last && text === m.last.text) return notes;
        const r = await writeFile(machineExec(ctx), m.path!, Buffer.from(text, "utf8"), m.last ? m.last.stat : "any");
        if (!("conflict" in r)) {
          m.last = { text, stat: r.stat, cells: parseIpynb(text).cells };
          return notes;
        }
        // Changed on the machine since it was written: apply that first.
        notes.push(...(await pullLocked(ctx, info)));
      }
      return notes;
    } catch (e) {
      if (e instanceof Unreachable) return [];
      throw e;
    }
  });
}

/** Apply changes made to the file on the machine (by the agent's commands) to the editor, then rewrite it. */
export async function syncIn(ctx: ToolContext): Promise<string[]> {
  const info = await ctx.call({ op: "info" });
  if (!reachable(info) || !ctx.mirror.last) return [];
  return ctx.exclusive("edit", async () => {
    try {
      const notes = await pullLocked(ctx, info);
      if (notes.length) await writeBack(ctx, info);
      return notes;
    } catch (e) {
      if (e instanceof Unreachable) return [];
      throw e;
    }
  });
}

/** Rewrite the file from the editor, whatever it holds now. */
async function writeBack(ctx: ToolContext, info: NotebookInfo): Promise<void> {
  const m = ctx.mirror;
  const text = await render(ctx, info);
  const r = await writeFile(machineExec(ctx), m.path!, Buffer.from(text, "utf8"), "any");
  if (!("conflict" in r)) m.last = { text, stat: r.stat, cells: parseIpynb(text).cells };
}

/** File to editor, under the edit lock. Leaves `last` at what the file held. */
async function pullLocked(ctx: ToolContext, info: NotebookInfo): Promise<string[]> {
  const m = ctx.mirror;
  if (!m.last || !m.path) return [];
  const exec = machineExec(ctx);
  const [now] = await stat(exec, [m.path]);
  if (sameStat(now, m.last.stat)) return [];
  const where = `The notebook file ${m.path}`;
  if (!now) {
    m.last = null;
    await writeBack(ctx, info);
    return [`${where} was removed; it was written again from the notebook. (Delete cells to remove them.)`];
  }
  const { data, stat: st } = await readFile(exec, m.path);
  const text = data.toString("utf8");
  if (text === m.last.text) {
    m.last = { ...m.last, stat: st };
    return [];
  }
  let cells: NbCell[];
  try {
    cells = parseIpynb(text).cells;
  } catch (e) {
    if (!(e instanceof NotebookFormatError)) throw e;
    m.last = null;
    await writeBack(ctx, info);
    return [`${where} was changed into something that is not a notebook (${e.message}). The notebook did not change; the file was written again from it.`];
  }
  const base = m.last.cells;
  m.last = { text, stat: st, cells };
  const report = await describeApplied(ctx, await applyCells(ctx, base, cells, { concurrent: true }), false);
  const notes = report.noop ? [] : [`${where} changed on the machine; this reached the notebook in the browser:`, ...report.lines];
  if (outputsTouched(base, cells)) notes.push("Outputs and execution counts in the notebook file come from running cells; changes to them were not applied.");
  return notes;
}

function outputsTouched(before: NbCell[], after: NbCell[]): boolean {
  const old = new Map(before.filter((c) => c.id).map((c) => [c.id!, c.outputsKey]));
  return after.some((c) => c.id && old.has(c.id) && c.outputsKey !== undefined && old.get(c.id) !== undefined && c.outputsKey !== old.get(c.id));
}

export interface Applied {
  done: string[];
  skipped: string[];
  reviews: { reviewId: string; what: string }[];
}

export interface ApplyReport {
  lines: string[];
  /** Something was refused, rejected or could not be applied. */
  failed: boolean;
  /** Nothing differed. */
  noop: boolean;
}

interface Planned {
  cell: NbCell;
  /** The editor cell it is (kept cells). */
  id?: string;
}

/**
 * Turn the notebook from `base` into `target` in the editor: updates, deletes,
 * moves and inserts, each checked against the mode, with review when it is on.
 * Cells are matched by id. `concurrent`: the editor may have changed since
 * `base` (the user kept working); a cell changed on both sides keeps the user's
 * version. Call under the edit lock; reviews are opened, not awaited.
 */
export async function applyCells(ctx: ToolContext, base: NbCell[], target: NbCell[], opts: { concurrent: boolean }): Promise<Applied> {
  const { cells: editor } = await ctx.call({ op: "get_cells" });
  const live = new Map<string, CellInfo>(editor.map((c) => [c.id, c]));
  const baseById = new Map(base.filter((c) => c.id).map((c) => [c.id!, c]));
  const done: string[] = [];
  const skipped: string[] = [];
  const reviews: { reviewId: string; what: string }[] = [];

  const allowed = (action: ToolAction, cellId: string | null, what: string): { review: boolean } | null => {
    const d = decide(ctx.settings(), action, cellId, ctx.targets());
    if (d.allow) return { review: d.review };
    skipped.push(`${what}: not applied. ${d.reason}`);
    return null;
  };
  /** The editor cell, unless the user changed or removed it since `base`. */
  const untouched = (id: string, what: string): CellInfo | null => {
    const e = live.get(id);
    if (!e) {
      skipped.push(`${what}: cell ${id} is no longer in the notebook (removed in the browser).`);
      return null;
    }
    if (opts.concurrent && e.source !== baseById.get(id)!.source) {
      skipped.push(`${what}: not applied, the user edited cell ${id} meanwhile. Read it again.`);
      return null;
    }
    if (e.pendingReview) {
      skipped.push(`${what}: not applied, a change to cell ${id} is still awaiting review.`);
      return null;
    }
    return e;
  };

  // Match the target's cells to the notebook's by id. A changed type makes a new cell.
  const seen = new Set<string>();
  const plan: Planned[] = target.map((cell) => {
    const b = cell.id ? baseById.get(cell.id) : undefined;
    if (!b || seen.has(cell.id!) || b.type !== cell.type) return { cell };
    seen.add(cell.id!);
    return { cell, id: cell.id };
  });
  const removed = base.filter((c) => c.id && !seen.has(c.id));
  const changed = plan.filter((p) => p.id && p.cell.source !== baseById.get(p.id)!.source);
  const added = plan.filter((p) => !p.id);

  for (const p of changed) {
    const what = `Change to cell ${p.id}`;
    if (!untouched(p.id!, what)) continue;
    const ok = allowed("update", p.id!, what);
    if (!ok) continue;
    const res = await ctx.call({ op: "update_cell", cellId: p.id!, source: p.cell.source, review: ok.review });
    if (res.reviewId) reviews.push({ reviewId: res.reviewId, what });
    else if (res.applied) done.push(`cell ${p.id} changed`);
  }

  const order = editor.map((c) => c.id);
  for (const c of removed) {
    const what = `Deleting cell ${c.id}`;
    if (!live.has(c.id!)) continue;
    if (!untouched(c.id!, what)) continue;
    const ok = allowed("delete", c.id!, what);
    if (!ok) continue;
    const res = await ctx.call({ op: "delete_cell", cellId: c.id!, review: ok.review });
    if (res.reviewId) reviews.push({ reviewId: res.reviewId, what });
    else {
      done.push(`cell ${c.id} deleted`);
      order.splice(order.indexOf(c.id!), 1);
    }
  }

  // Order the kept cells as the target has them, moving as few as possible.
  const kept = plan.filter((p) => p.id && order.includes(p.id)).map((p) => p.id!);
  const stable = longestIncreasing(kept.map((id) => order.indexOf(id)));
  if (stable.size < kept.length && allowed("move", kept[0]!, "Reordering cells")) {
    const move = async (id: string, to: (order: string[]) => number) => {
      order.splice(order.indexOf(id), 1);
      const at = to(order);
      order.splice(at, 0, id);
      await ctx.call({ op: "move_cell", cellId: id, index: at });
      done.push(`cell ${id} moved to index ${at}`);
    };
    const firstStable = kept.findIndex((_, j) => stable.has(j));
    // Cells before the first one that stays go, in order, right before it.
    for (let j = (firstStable < 0 ? kept.length : firstStable) - 1; j >= 0; j--) {
      const anchor = kept[j + 1];
      await move(kept[j]!, (o) => (anchor ? o.indexOf(anchor) : o.length));
    }
    for (let j = Math.max(0, firstStable) + 1; firstStable >= 0 && j < kept.length; j++) {
      if (stable.has(j)) continue;
      const prev = kept[j - 1]!;
      await move(kept[j]!, (o) => o.indexOf(prev) + 1);
    }
  }

  // New cells go right after the cell that precedes them in the target.
  if (added.length) {
    let prev: string | null = null;
    for (const p of plan) {
      if (p.id) {
        if (order.includes(p.id)) prev = p.id;
        continue;
      }
      const kind = cellKind(p.cell.type);
      const what = `New ${kind} cell${prev ? ` after cell ${prev}` : " at the top"}`;
      const ok = allowed("insert", null, what);
      if (!ok) continue;
      const index = prev ? order.indexOf(prev) + 1 : 0;
      const res = await ctx.call({ op: "insert_cell", index, cellType: p.cell.type, source: p.cell.source, review: ok.review });
      if (!res.cellId) continue;
      order.splice(index, 0, res.cellId);
      prev = res.cellId;
      if (res.reviewId) reviews.push({ reviewId: res.reviewId, what: `${what} (id ${res.cellId})` });
      else done.push(`new ${kind} cell ${res.cellId} inserted at index ${index}`);
    }
  }

  return { done, skipped, reviews };
}

/** What applying did, for the agent. `wait`: wait for the user's review decisions first (outside any lock). */
export async function describeApplied(ctx: ToolContext, a: Applied, wait: boolean): Promise<ApplyReport> {
  const lines: string[] = [];
  let failed = a.skipped.length > 0;
  if (a.done.length) lines.push(`Applied: ${a.done.join("; ")}.`);
  if (a.reviews.length && wait) {
    const outcomes = await Promise.all(a.reviews.map((r) => ctx.awaitReview(r.reviewId, ctx.waitMs)));
    a.reviews.forEach((r, i) => {
      const o = outcomes[i]!;
      if (o !== "accepted") failed = true;
      lines.push(reviewLine(o, r.what, r.reviewId));
    });
  } else if (a.reviews.length) {
    lines.push(
      `Awaiting the user's review: ${a.reviews.map((r) => `${r.what} (review_id "${r.reviewId}")`).join("; ")}. ` +
        "Call await_review with a review_id to wait for the decision before depending on it.",
    );
  }
  lines.push(...a.skipped);
  return { lines, failed, noop: !a.done.length && !a.reviews.length && !a.skipped.length };
}

function cellKind(t: CellType): string {
  return t === "code" ? "code" : "markdown";
}

export function reviewLine(outcome: ReviewOutcome, what: string, reviewId: string): string {
  if (outcome === "accepted") return `${what}: the user accepted it; it is applied.`;
  if (outcome === "rejected") return `${what}: the user REJECTED it, so it was not applied. Do not retry the same change; ask the user what they want instead.`;
  if (outcome === "discarded") return `${what}: the notebook page reloaded before the user decided, so it was not applied. Read the notebook again before proposing it anew.`;
  return `${what}: still awaiting the user's review (review_id "${reviewId}"). Call await_review with this review_id to wait for the decision before depending on it.`;
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
