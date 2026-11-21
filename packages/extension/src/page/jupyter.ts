// JupyterLab 4 / Jupyter Notebook 7, which is what Kaggle's editor embeds (in
// an iframe, with exposeAppInBrowser on, so window.jupyterapp is reachable).
// Local Jupyter works the same when started with expose_app_in_browser.

import { normalizeIpynbOutputs, type CellInfo, type CellRunState, type CellType, type ExecResult, type NotebookInfo, type ReviewInfo, type RunResult } from "@ainb/protocol";
import { KERNEL_BUSY, NoServerPython, OpError, OutputCollector, within, type Execution, type NotebookAdapter } from "@ainb/protocol";
import { ServerPython, type TerminalLink } from "./server-python.js";
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

/** A lumino-style signal connection, remembered so it can be undone. */
interface Link { signal: Any; cb: Any }

export class JupyterAdapter implements NotebookAdapter {
  readonly platform: NotebookInfo["platform"];
  private readonly cards = new Map<string, HTMLElement>();
  private readonly server = new ServerPython(() => this.openTerminal());

  /**
   * `nudge` asks the OpRunner for a beat right now (main.ts passes
   * runner.pulseNow). Editor signals call it; the runner's background timer
   * keeps running at its own pace — Kaggle's packaged JupyterLab may lack or
   * miswire a signal, so a signal is an early tick, never the only source.
   */
  constructor(private readonly nudge: () => void = () => {}) {
    this.platform = /(^|\.)kaggle\.(com|net)$/.test(location.hostname) || /kaggle/i.test(document.referrer) ? "kaggle" : "jupyter";
    this.hookRunSignals();
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
    const selected = nb.widgets.filter((w: Any) => nb.isSelectedOrActive?.(w)).map((w: Any) => w.model.id);
    return {
      platform: this.platform,
      title: String(panel.title?.label ?? panel.context?.path ?? document.title),
      url: location.href,
      cellCount: nb.widgets.length,
      activeCellId: nb.activeCell?.model?.id ?? null,
      selectedCellIds: selected,
      kernel: this.kernelState(k, nb.widgets),
      language: String(nb.model?.defaultKernelLanguage || panel.sessionContext?.kernelPreference?.language || "python"),
      docPath: typeof panel.context?.path === "string" ? panel.context.path : undefined,
      serverTerminals: this.terminalsAvailable() && this.server.usable,
    };
  }

  /**
   * The kernel's state. A connection that came back while a cell runs (Kaggle
   * reconnects its socket) reads "unknown" until the kernel next says idle or
   * busy, which a long run never does: a cell seen running means busy.
   */
  private kernelState(k: Any, widgets: Any[]): NotebookInfo["kernel"] {
    if (!k) return "disconnected";
    const status = k.status;
    if (status === "idle" || status === "busy") return status;
    if (status === "dead") return "disconnected";
    return widgets.some((w) => this.running(w)) ? "busy" : "unknown";
  }

  private running(cell: Any): boolean {
    if (cell.model.type !== "code") return false;
    if (cell.model.executionState === "running") return true;
    if (this.futureRunning(cell.outputArea?.future, cell.model.id)) return true;
    // Older JupyterLab shows "[*]"; Kaggle draws a spinner instead, so this alone misses its runs.
    return /\*/.test(cell.promptNode?.textContent ?? "");
  }

  /** Kernel futures seen, and those whose run has ended. */
  private readonly seenFutures = new WeakSet<object>();
  private readonly doneFutures = new WeakSet<object>();
  /** Per-cell generation of witnessed runs: the runToken evidence (A4.4). */
  private readonly generations = new Map<string, number>();

  /**
   * A cell's output area keeps the future of its last run (not disposed when
   * it ends), so a future whose `done` has not settled is a run in progress:
   * true on any JupyterLab 4 and whatever the page draws as the prompt.
   * A future seen for the first time is a new run of its cell: bump the
   * generation the watcher reads as runToken, independent of the count.
   */
  private futureRunning(future: Any, cellId?: string): boolean {
    if (!future || typeof future !== "object" || future.isDisposed || this.doneFutures.has(future)) return false;
    if (!this.seenFutures.has(future)) {
      this.seenFutures.add(future);
      if (cellId) this.generations.set(cellId, (this.generations.get(cellId) ?? 0) + 1);
      const end = () => { this.doneFutures.add(future); };
      Promise.resolve(future.done).then(end, end);
      // First sight: an old future settles on the next microtask; until then
      // only trust it while the kernel is busy.
      return this.kernel()?.status === "busy";
    }
    return true;
  }

  /** Runs started by `startExecution` whose `done` has not settled. */
  private readonly ownRuns = new Set<object>();

  private async cellRunning(): Promise<boolean> {
    if (!this.widgets().some((w) => this.running(w))) return false;
    // A future first seen just now settles on the next microtask if its run had ended: look again after it.
    await Promise.resolve();
    return this.widgets().some((w) => this.running(w));
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

  runStates(): CellRunState[] {
    const alive = new Set<string>();
    const states = this.widgets().filter((w) => w.model.type === "code")
      .map((w) => {
        const id: string = w.model.id;
        alive.add(id);
        const running = this.running(w);
        const gen = this.generations.get(id);
        const state: CellRunState = { cellId: id, running, executionCount: w.model.executionCount ?? null };
        // Only a witnessed run gives a token; a pasted or undone old cell has none.
        if (gen !== undefined) state.runToken = String(gen);
        return state;
      });
    for (const id of this.generations.keys()) if (!alive.has(id)) this.generations.delete(id);
    return states;
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
    const present = (): boolean => {
      try {
        return this.widgets().some((w) => w.model.id === id);
      } catch {
        return false;
      }
    };
    if (present()) return id;
    // cellsChange says when the widget list moved (A4.3); the old 20ms×50 loop
    // stays as the fallback for builds without the signal, and as the timeout.
    await new Promise<void>((resolve) => {
      let settled = false;
      let hooked = false;
      let tries = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (hooked) {
          try { shared.cellsChange.disconnect(onChange); } catch { /* already gone */ }
        }
        resolve();
      };
      const onChange = () => { if (present()) finish(); };
      const timer = setInterval(() => { if (present() || ++tries >= 50) finish(); }, 20);
      try {
        if (typeof shared.cellsChange?.connect === "function") {
          shared.cellsChange.connect(onChange);
          hooked = true;
        }
      } catch {
        // no signal in this build: the loop alone waits
      }
      if (present()) finish();
    });
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

  private terminalsAvailable(): boolean {
    try {
      return !!this.app?.serviceManager?.terminals?.isAvailable?.();
    } catch {
      return false;
    }
  }

  machineExec(code: string, waitMs: number): Promise<ExecResult> {
    if (!this.terminalsAvailable()) return Promise.reject(new NoServerPython("This notebook server has no terminals."));
    return this.server.run(code, waitMs);
  }

  /** A terminal of the notebook server for ServerPython; shut down when the page goes. */
  private async openTerminal(): Promise<TerminalLink> {
    const conn = await this.app.serviceManager.terminals.startNew();
    const output: ((t: string) => void)[] = [];
    const closed: (() => void)[] = [];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      for (const cb of closed) cb();
    };
    conn.messageReceived.connect((_: unknown, msg: Any) => {
      if (msg?.type === "stdout") for (const cb of output) cb(String(msg.content?.[0] ?? ""));
      else if (msg?.type === "disconnect") end();
    });
    conn.disposed?.connect?.(() => end());
    const shutdown = () => void Promise.resolve(conn.shutdown?.()).catch(() => {});
    window.addEventListener("pagehide", shutdown, { once: true });
    return {
      send: (text) => conn.send({ type: "stdin", content: [text] }),
      onOutput: (cb) => output.push(cb),
      onClose: (cb) => closed.push(cb),
      close: () => {
        window.removeEventListener("pagehide", shutdown);
        shutdown();
        end();
      },
    };
  }

  async startExecution(code: string): Promise<Execution> {
    const kernel = await this.readyKernel();
    // "Busy" here means a run this call would wait behind: a cell, or a run of ours not yet ended.
    // The kernel's own status flag is not used: it reads "busy" for a moment after a run has ended
    // and while the page asks the kernel small things, so it refused calls that had nothing to wait for.
    if (this.ownRuns.size > 0 || (await this.cellRunning())) throw new OpError(KERNEL_BUSY);
    const collected = new OutputCollector();
    const future = kernel.requestExecute({ code, silent: false, store_history: false, allow_stdin: false, stop_on_error: false }, true);
    this.ownRuns.add(future);
    const ended = () => { this.ownRuns.delete(future); };
    Promise.resolve(future.done).then(ended, ended);
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
      unhookSource?.();
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

    // The cell's sharedModel says at once when its source changes (A4.4): give
    // up the review then, not a poll later. Both signal names are tried — the
    // exact one depends on the @jupyter/ydoc build; the slow interval below is
    // the fallback when neither exists, and re-attaches the card when the DOM
    // is redrawn. The accept path re-checks the source anyway, so an edit is
    // never overwritten even in the fallback window.
    let unhookSource: (() => void) | null = null;
    const onSourceChange = () => {
      const c = findCell();
      if (!c || c.model.sharedModel.getSource() !== expectedSource) settle(false);
    };
    try {
      const sm = cell.model.sharedModel;
      for (const sig of [sm?.sourceChange, sm?.changed]) {
        if (sig && typeof sig.connect === "function") {
          sig.connect(onSourceChange);
          const prev = unhookSource;
          unhookSource = () => {
            prev?.();
            try { sig.disconnect(onSourceChange); } catch { /* already gone */ }
          };
        }
      }
    } catch {
      // no signals in this build
    }

    // Re-rendering can recreate cell nodes; keep the card on the cell, and give
    // up the review if the user deletes or changes the cell.
    const keepAttached = setInterval(() => {
      const c = findCell();
      if (!c || c.model.sharedModel.getSource() !== expectedSource) {
        settle(false);
      } else if (!c.node.contains(card)) {
        this.attachCard(review.reviewId, c, card);
      }
    }, 2500);

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
      if (p && p !== hooked) {
        hooked = p;
        p.content.activeCellChanged?.connect?.(() => cb());
        p.content.selectionChanged?.connect?.(() => cb());
        cb();
      }
      // The same re-hook sweep keeps the run signals on the current panel.
      this.hookRunSignals();
    };
    hook();
    this.app?.shell?.currentChanged?.connect?.(() => hook());
    this.selectionTimer = setInterval(hook, 2000);
  }

  // ------------------------------------------------------------------ run signals (A4.3)

  private signalPanel: Any = null;
  private signalKernel: Any = null;
  private readonly panelLinks: Link[] = [];
  private readonly kernelLinks: Link[] = [];
  /** Output models already hooked; weak, so deleted cells take their links along. */
  private readonly hookedOutputs = new WeakSet<object>();
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  private link(signal: Any, cb: (...args: Any[]) => void, bucket: Link[]): void {
    try {
      if (signal && typeof signal.connect === "function") {
        signal.connect(cb);
        bucket.push({ signal, cb });
      }
    } catch {
      // signal absent or different in this build
    }
  }

  private unlink(bucket: Link[]): void {
    for (const { signal, cb } of bucket) {
      try { signal.disconnect(cb); } catch { /* already gone */ }
    }
    bucket.length = 0;
  }

  /** Coalesce a burst of signals into one early beat (~60ms debounce). */
  private scheduleNudge(): void {
    if (this.disposed || this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      try {
        this.nudge();
      } catch {
        // the runner is gone
      }
    }, 60);
  }

  /**
   * Public JupyterLab 4 signals: the kernel's status/connection, the notebook
   * model's changes, and each cell's outputs. Every hook is optional — a
   * packaged build (Kaggle) may lack one; the runner's timer covers that.
   */
  private hookRunSignals(): void {
    if (this.disposed) return;
    const p = findPanel();
    if (!p) return;
    if (p !== this.signalPanel) {
      this.unlink(this.panelLinks);
      this.unlink(this.kernelLinks);
      this.signalKernel = null;
      this.signalPanel = p;
      const nudge = () => this.scheduleNudge();
      this.link(p.sessionContext?.kernelChanged, () => { this.hookKernel(); nudge(); }, this.panelLinks);
      const shared = p.content?.model?.sharedModel;
      this.link(shared?.changed, nudge, this.panelLinks);
      this.link(shared?.cellsChange, () => { this.hookOutputs(); nudge(); }, this.panelLinks);
    }
    this.hookKernel();
    this.hookOutputs();
  }

  private hookKernel(): void {
    try {
      const k = this.signalPanel?.sessionContext?.session?.kernel ?? null;
      if (!k || k === this.signalKernel) return;
      this.unlink(this.kernelLinks);
      this.signalKernel = k;
      const nudge = () => this.scheduleNudge();
      this.link(k.statusChanged, nudge, this.kernelLinks);
      this.link(k.connectionStatusChanged, nudge, this.kernelLinks);
    } catch {
      // session not ready yet; kernelChanged tries again
    }
  }

  private hookOutputs(): void {
    try {
      for (const w of this.signalPanel?.content?.widgets ?? []) {
        const om = w?.model?.outputs;
        if (!om || typeof om !== "object" || this.hookedOutputs.has(om)) continue;
        if (typeof om.changed?.connect === "function") {
          om.changed.connect(() => this.scheduleNudge());
          this.hookedOutputs.add(om);
        }
      }
    } catch {
      // widgets mid-rebuild
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
    if (this.selectionTimer) clearInterval(this.selectionTimer);
    this.selectionTimer = null;
    this.unlink(this.panelLinks);
    this.unlink(this.kernelLinks);
    this.signalPanel = null;
    this.signalKernel = null;
  }
}

function ensurePageStyle() {
  if (document.getElementById("ainb-style")) return;
  const s = document.createElement("style");
  s.id = "ainb-style";
  s.textContent = `.ainb-pending-delete .jp-Cell-inputWrapper { opacity: .45; text-decoration: line-through; }`;
  document.head.append(s);
}
