// JupyterLab 4 / Jupyter Notebook 7, which is what Kaggle's editor embeds (in
// an iframe, with exposeAppInBrowser on, so window.jupyterapp is reachable).
// Local Jupyter works the same when started with expose_app_in_browser.

import { normalizeIpynbOutputs, type CellInfo, type CellType, type NotebookInfo, type ReviewInfo, type RunResult } from "@ainb/protocol";
import { KERNEL_BUSY, OpError, OutputCollector, within, type Execution, type NotebookAdapter } from "./adapter.js";
import { createReviewCard } from "./review-widget.js";

type Any = any;

function isNotebookPanel(w: Any): boolean {
  return !!(w && w.content && w.content.model && w.content.model.sharedModel && Array.isArray(w.content.widgets) && w.sessionContext);
}

function findPanel(): Any | null {
  const app = (window as Any).jupyterapp;
  if (!app?.shell) return null;
  const current = app.shell.currentWidget;
  if (isNotebookPanel(current)) return current;
  try {
    for (const w of app.shell.widgets?.("main") ?? []) if (isNotebookPanel(w)) return w;
  } catch {
    // shell without widgets()
  }
  return null;
}

export function detectJupyter(): boolean {
  return findPanel() !== null;
}

export class JupyterAdapter implements NotebookAdapter {
  readonly platform: NotebookInfo["platform"];
  private readonly cards = new Map<string, HTMLElement>();

  constructor() {
    this.platform = /(^|\.)kaggle\.(com|net)$/.test(location.hostname) || /kaggle/i.test(document.referrer) ? "kaggle" : "jupyter";
  }

  private get app(): Any {
    return (window as Any).jupyterapp;
  }

  private get panel(): Any {
    const p = findPanel();
    if (!p) throw new OpError("No notebook is open in this Jupyter page.");
    return p;
  }

  private widgets(): Any[] {
    return this.panel.content.widgets;
  }

  private find(id: string): { cell: Any; index: number } {
    const index = this.widgets().findIndex((w) => w.model.id === id);
    if (index < 0) throw new OpError(`No cell with id "${id}".`);
    return { cell: this.widgets()[index], index };
  }

  private kernel(): Any | null {
    return this.panel.sessionContext?.session?.kernel ?? null;
  }

  info(): NotebookInfo {
    const panel = this.panel;
    const nb = panel.content;
    const k = this.kernel();
    const status = k?.status;
    const selected = nb.widgets.filter((w: Any) => nb.isSelectedOrActive?.(w)).map((w: Any) => w.model.id);
    return {
      platform: this.platform,
      title: String(panel.title?.label ?? panel.context?.path ?? document.title),
      url: location.href,
      cellCount: nb.widgets.length,
      activeCellId: nb.activeCell?.model?.id ?? null,
      selectedCellIds: selected,
      kernel: !k ? "disconnected" : status === "idle" ? "idle" : status === "busy" ? "busy" : status === "dead" ? "disconnected" : "unknown",
      language: String(nb.model?.defaultKernelLanguage || panel.sessionContext?.kernelPreference?.language || "python"),
      docPath: typeof panel.context?.path === "string" ? panel.context.path : undefined,
    };
  }

  private running(cell: Any): boolean {
    if (cell.model.type !== "code") return false;
    if (typeof cell.model.executionState === "string") return cell.model.executionState === "running";
    return /\*/.test(cell.promptNode?.textContent ?? "");
  }

  private toInfo(cell: Any, index: number, includeOutputs: boolean): CellInfo {
    const m = cell.model;
    const type: CellType = m.type === "code" ? "code" : "markdown";
    const info: CellInfo = { id: m.id, index, type, source: m.sharedModel.getSource() };
    if (type === "code") {
      info.executionCount = m.executionCount ?? null;
      info.running = this.running(cell);
      if (includeOutputs) info.outputs = normalizeIpynbOutputs(m.outputs?.toJSON?.() ?? []);
    }
    return info;
  }

  getCells(opts: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[] {
    const all = this.widgets().map((w, i) => [w, i] as const);
    let picked = all;
    if (opts.cellIds) picked = opts.cellIds.map((id) => all.find(([w]) => w.model.id === id)).filter((x): x is (typeof all)[number] => !!x);
    else if (opts.start !== undefined || opts.end !== undefined) picked = all.slice(opts.start ?? 0, (opts.end ?? all.length - 1) + 1);
    return picked.map(([w, i]) => this.toInfo(w, i, !!opts.includeOutputs));
  }

  setSource(cellId: string, source: string): boolean {
    const { cell } = this.find(cellId);
    if (cell.model.sharedModel.getSource() === source) return false;
    cell.model.sharedModel.setSource(source);
    return true;
  }

  async insertCell(index: number, type: CellType, source: string): Promise<string> {
    const shared = this.panel.content.model.sharedModel;
    const ycell = shared.insertCell(index, { cell_type: type, source, metadata: {} });
    // The cell widget is created asynchronously after the model change.
    const id: string = ycell.id;
    for (let i = 0; i < 50 && !this.widgets().some((w) => w.model.id === id); i++) await new Promise((r) => setTimeout(r, 20));
    return id;
  }

  deleteCell(cellId: string): void {
    const { index } = this.find(cellId);
    this.panel.content.model.sharedModel.deleteCell(index);
  }

  moveCell(cellId: string, index: number): number {
    const { index: from } = this.find(cellId);
    const to = Math.max(0, Math.min(index, this.widgets().length - 1));
    if (from !== to) this.panel.content.model.sharedModel.moveCell(from, to);
    return to;
  }

  async runCell(cellId: string, timeoutMs: number): Promise<RunResult> {
    const { cell, index } = this.find(cellId);
    if (cell.model.type !== "code") return { cellId, status: "skipped", outputs: [], message: "not a code cell" };
    await this.readyKernel();
    const nb = this.panel.content;
    nb.activeCellIndex = index;
    nb.deselectAll?.();
    const run = (this.app.commands.execute("notebook:run-cell") as Promise<boolean>).then(
      () => null,
      (e: Error) => e,
    );
    const r = await within(run, timeoutMs);
    const [info] = this.getCells({ cellIds: [cellId], includeOutputs: true });
    const outputs = info?.outputs ?? [];
    if (!r.done) return { cellId, status: "timeout", executionCount: info?.executionCount, outputs, message: "still running" };
    if (r.value) return { cellId, status: "error", executionCount: info?.executionCount, outputs, message: r.value.message };
    const failed = outputs.some((o) => o.kind === "error");
    return { cellId, status: failed ? "error" : "ok", executionCount: info?.executionCount, outputs };
  }

  /** The session's kernel, waiting a little for one that is still starting. */
  private async readyKernel(): Promise<Any> {
    const ctx = this.panel.sessionContext;
    // A kernel that is still starting has no session yet.
    if (!ctx.session && ctx.ready) await within(Promise.resolve(ctx.ready), 20_000);
    const kernel = ctx.session?.kernel;
    if (!kernel) {
      throw new OpError(
        this.platform === "kaggle"
          ? "The Kaggle session is not running. Ask the user to start it (the power button), then try again."
          : "No kernel is connected to this notebook.",
      );
    }
    return kernel;
  }

  async startExecution(code: string): Promise<Execution> {
    const kernel = await this.readyKernel();
    if (kernel.status === "busy") throw new OpError(KERNEL_BUSY);
    const collected = new OutputCollector();
    const future = kernel.requestExecute({ code, silent: false, store_history: false, allow_stdin: false, stop_on_error: false }, true);
    future.onIOPub = (msg: Any) => {
      const type = msg?.header?.msg_type;
      if (type === "clear_output") collected.clear(!!msg.content?.wait);
      else if (type === "stream" || type === "error" || type === "execute_result" || type === "display_data") collected.add({ output_type: type, ...msg.content });
    };
    return { reply: (future.done as Promise<Any>).then((msg) => msg?.content ?? {}), collected };
  }

  interrupt(): boolean {
    const k = this.kernel();
    if (!k || k.status !== "busy") return false;
    void k.interrupt();
    return true;
  }

  focusCell(cellId: string): boolean {
    const { cell, index } = this.find(cellId);
    this.panel.content.activeCellIndex = index;
    cell.node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    return true;
  }

  showReview(review: ReviewInfo): { decided: Promise<boolean>; resolve(accept: boolean): void } {
    // A review belongs to the notebook that opened it, even after a tab switch.
    const panel = this.panel;
    const notebook = panel.content;
    const model = notebook.model;
    const findCell = (): Any | undefined => {
      if (panel.isDisposed || notebook.model !== model) return undefined;
      return notebook.widgets.find((c: Any) => c.model.id === review.cellId);
    };
    let settle!: (accept: boolean) => void;
    let settled = false;
    const decided = new Promise<boolean>((resolve) => {
      settle = (accept) => {
        if (settled) return;
        settled = true;
        resolve(accept);
      };
    });

    const cell = findCell();
    if (!cell) throw new OpError(`No cell with id "${review.cellId}".`);
    if (review.kind === "insert") cell.model.sharedModel.setSource(review.after);
    const expectedSource = review.kind === "insert" ? review.after : review.before;
    const card = createReviewCard(review, (accept) => settle(accept));
    this.attachCard(review.reviewId, cell, card);
    if (review.kind === "delete") cell.node?.classList.add("ainb-pending-delete");
    cell.node?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });

    const finished = decided.then((accept) => {
      card.remove();
      this.cards.delete(review.reviewId);
      clearInterval(keepAttached);
      const current = findCell();
      current?.node?.classList.remove("ainb-pending-delete");
      // Never overwrite or delete edits made while the diff was waiting.
      if (!current || current.model.sharedModel.getSource() !== expectedSource) return false;
      if (review.kind === "update" && accept) current.model.sharedModel.setSource(review.after);
      if ((review.kind === "insert" && !accept) || (review.kind === "delete" && accept)) {
        model.sharedModel.deleteCell(notebook.widgets.indexOf(current));
      }
      return accept;
    });

    // Re-rendering can recreate cell nodes; keep the card on the cell, and give
    // up the review if the user deletes or changes the cell.
    const keepAttached = setInterval(() => {
      const c = findCell();
      if (!c || c.model.sharedModel.getSource() !== expectedSource) {
        settle(false);
      } else if (!c.node.contains(card)) {
        this.attachCard(review.reviewId, c, card);
      }
    }, 1000);

    return { decided: finished, resolve: (accept) => settle(accept) };
  }

  private attachCard(id: string, cell: Any, card: HTMLElement) {
    const anchor = cell.node.querySelector(".jp-Cell-inputWrapper") ?? cell.node.firstChild;
    cell.node.insertBefore(card, anchor);
    this.cards.set(id, card);
    ensurePageStyle();
  }

  onSelectionChange(cb: () => void): void {
    let hooked: Any = null;
    const hook = () => {
      const p = findPanel();
      if (!p || p === hooked) return;
      hooked = p;
      p.content.activeCellChanged?.connect?.(() => cb());
      p.content.selectionChanged?.connect?.(() => cb());
      cb();
    };
    hook();
    this.app?.shell?.currentChanged?.connect?.(() => hook());
    setInterval(hook, 2000);
  }
}

function ensurePageStyle() {
  if (document.getElementById("ainb-style")) return;
  const s = document.createElement("style");
  s.id = "ainb-style";
  s.textContent = `.ainb-pending-delete .jp-Cell-inputWrapper { opacity: .45; text-decoration: line-through; }`;
  document.head.append(s);
}
