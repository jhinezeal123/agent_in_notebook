// Google Colab. Colab exposes its notebook object at colab.global.notebook,
// with the cell API and the agent tools its own Gemini integration uses
// (add_code_cell, run_code_cell, ...) and an inline diff with Accept/Reject.
// Its code is minified: only names that survive minification (public methods,
// tool names) are used, and each lookup fails with a clear message.

import { normalizeIpynbOutputs, type CellInfo, type CellType, type NotebookInfo, type ReviewInfo, type RunResult } from "@ainb/protocol";
import { KERNEL_BUSY, OpError, OutputCollector, within, type Execution, type NotebookAdapter } from "@ainb/protocol";

type Any = any;

export function detectColab(): boolean {
  const w = window as Any;
  return !!(location.hostname === "colab.research.google.com" && w.colab?.global?.notebook && Array.isArray(w.colab.global.notebook.cells));
}

const LANGS = ["python", "r", "julia"] as const;

export class ColabAdapter implements NotebookAdapter {
  readonly platform = "colab" as const;

  private get nb(): Any {
    const nb = (window as Any).colab?.global?.notebook;
    if (!nb) throw new OpError("Colab's notebook is not loaded yet.");
    return nb;
  }

  private get model(): Any {
    return (window as Any).colab?.global?.notebookModel ?? this.nb.getNotebookModel?.();
  }

  private cells(): Any[] {
    const nb = this.nb;
    return typeof nb.getCells === "function" ? nb.getCells() : nb.cells;
  }

  private cell(id: string): Any {
    const c = this.cells().find((x) => x.getId() === id);
    if (!c) throw new OpError(`No cell with id "${id}".`);
    return c;
  }

  /** Colab's own agent tools, found by their stable tool names. */
  private tool(name: string): Any {
    const nb = this.nb;
    const candidates = [nb.colabMcpToolsService, ...Object.values(nb)];
    for (const svc of candidates) {
      if (svc && typeof svc === "object" && Array.isArray((svc as Any).tools)) {
        const t = (svc as Any).tools.find((x: Any) => x?.toolName === name);
        if (t && typeof t.toolCallback === "function") return t;
      }
    }
    throw new OpError(`Colab's "${name}" tool is not available in this version of Colab.`);
  }

  private language(): (typeof LANGS)[number] {
    const lang = String(this.model?.getSyntaxLanguage?.() ?? "python").replace(/^notebook-/, "");
    return (LANGS as readonly string[]).includes(lang) ? (lang as (typeof LANGS)[number]) : "python";
  }

  private kernelState(): NotebookInfo["kernel"] {
    try {
      const k = this.nb.getKernel?.() ?? this.nb.kernel;
      if (!k) return "unknown";
      if (!k.isConnected?.()) return "disconnected";
      return k.isBusy?.() ? "busy" : "idle";
    } catch {
      return "unknown";
    }
  }

  info(): NotebookInfo {
    const cells = this.cells();
    const focused = this.nb.focusedCell;
    const selected = cells.filter((c) => c.isSelected?.()).map((c) => c.getId());
    return {
      platform: "colab",
      title: String(this.model?.getTitle?.() ?? document.title.replace(/ - Colab$/, "")),
      url: location.href,
      cellCount: cells.length,
      activeCellId: focused?.isInNotebook?.() === false ? null : (focused?.getId?.() ?? null),
      selectedCellIds: selected,
      kernel: this.kernelState(),
      language: this.language(),
    };
  }

  private toInfo(c: Any, index: number, includeOutputs: boolean): CellInfo {
    const type: CellType = c.getType() === "code" ? "code" : "markdown";
    const info: CellInfo = { id: c.getId(), index, type, source: String(c.getText() ?? "") };
    if (type === "code") {
      let json: Any = null;
      try {
        json = c.getModel().toJson();
      } catch {
        json = null;
      }
      info.executionCount = json?.execution_count ?? null;
      info.running = !!c.isRunning?.();
      if (includeOutputs) info.outputs = normalizeIpynbOutputs(json?.outputs);
    }
    return info;
  }

  getCells(opts: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[] {
    const all = this.cells().map((c, i) => [c, i] as const);
    let picked = all;
    if (opts.cellIds) picked = opts.cellIds.map((id) => all.find(([c]) => c.getId() === id)).filter((x): x is (typeof all)[number] => !!x);
    else if (opts.start !== undefined || opts.end !== undefined) picked = all.slice(opts.start ?? 0, (opts.end ?? all.length - 1) + 1);
    return picked.map(([c, i]) => this.toInfo(c, i, !!opts.includeOutputs));
  }

  setSource(cellId: string, source: string): boolean {
    const c = this.cell(cellId);
    if (c.getText() === source) return false;
    c.setText(source);
    return true;
  }

  async insertCell(index: number, type: CellType, source: string): Promise<string> {
    const res =
      type === "code"
        ? await this.tool("add_code_cell").toolCallback({ cellIndex: index, language: this.language(), code: source })
        : await this.tool("add_text_cell").toolCallback({ cellIndex: index, content: source });
    const id = res?.newCellId;
    if (!id) throw new OpError("Colab did not return the new cell's id.");
    // Colab may show its own accept/reject for agent-added cells; ours replaces it.
    const cell = this.cells().find((c) => c.getId() === id);
    cell?.getInlineDiff?.()?.accept?.();
    return id;
  }

  deleteCell(cellId: string): void {
    this.nb.removeCells([this.cell(cellId)]);
  }

  async moveCell(cellId: string, index: number): Promise<number> {
    const max = this.cells().length - 1;
    const target = Math.max(0, Math.min(index, max));
    this.cell(cellId);
    // Colab's tool reports failure by rejecting; let that reach the agent, but
    // never hang on a callback that does not settle.
    const moved = Promise.resolve(this.tool("move_cell").toolCallback({ cellId, cellIndex: target }));
    const r = await within(moved.then(() => null, (e: Error) => e), 5_000);
    if (r.done && r.value) throw new OpError(`Colab could not move the cell: ${r.value.message}`);
    const now = this.cells().findIndex((c) => c.getId() === cellId);
    return now >= 0 ? now : target;
  }

  async runCell(cellId: string, timeoutMs: number): Promise<RunResult> {
    const c = this.cell(cellId);
    if (c.getType() !== "code") return { cellId, status: "skipped", outputs: [], message: "not a code cell" };
    const run = this.tool("run_code_cell").toolCallback({ cellId }) as Promise<unknown>;
    const r = await within(
      run.then(
        () => null,
        (e: Error) => e,
      ),
      timeoutMs,
    );
    const [info] = this.getCells({ cellIds: [cellId], includeOutputs: true });
    const outputs = info?.outputs ?? [];
    if (!r.done) return { cellId, status: "timeout", executionCount: info?.executionCount, outputs, message: "still running" };
    if (r.value) return { cellId, status: "error", executionCount: info?.executionCount, outputs, message: r.value.message };
    const failed = outputs.some((o) => o.kind === "error");
    return { cellId, status: failed ? "error" : "ok", executionCount: info?.executionCount, outputs };
  }

  async startExecution(code: string): Promise<Execution> {
    const k = this.nb.getKernel?.() ?? this.nb.kernel;
    if (typeof k?.execute !== "function") throw new OpError("Colab's kernel cannot run code in this version of Colab.");
    if (k.isRunning?.() === false || k.isConnected?.() === false) {
      throw new OpError("Colab is not connected to a runtime. Ask the user to connect it (the Connect button), then try again.");
    }
    if (k.isBusy?.()) throw new OpError(KERNEL_BUSY);
    const collected = new OutputCollector();
    // Colab calls these on whatever handler an execution carries; outputs arrive as nbformat dicts.
    const handler = {
      onOutput: (output: Any) => {
        collected.add(output);
        return true;
      },
      onClearOutput: (wait?: boolean) => {
        collected.clear(!!wait);
        return true;
      },
      supportsUserInput: () => false,
      onUserInputRequest: () => {},
      onColabRequest: () => null,
      getCellId: () => "",
      onCommOpen: () => {},
      onCommMessage: () => {},
      onCommClose: () => {},
      onExecuteReply: () => {},
      onExecuteInput: () => {},
      onExecutionStarted: () => {},
    };
    let reply: Promise<Any>;
    try {
      reply = Promise.resolve(k.execute(code, handler, { silent: false, storeHistory: false }));
    } catch (e) {
      throw new OpError(`Colab could not run the code: ${(e as Error).message}`);
    }
    // A failed execution rejects with an error that carries the reply.
    const asReply = reply.then(
      (r: Any) => ({ status: r?.status ?? "ok", ename: r?.ename, evalue: r?.evalue }),
      (e: Any) => {
        if (e?.reply) return { status: e.reply.status ?? "error", ename: e.reply.ename, evalue: e.reply.evalue };
        throw e;
      },
    );
    return { reply: asReply, collected };
  }

  interrupt(): boolean {
    const k = this.nb.getKernel?.() ?? this.nb.kernel;
    if (!k?.isBusy?.()) return false;
    k.interrupt();
    return true;
  }

  focusCell(cellId: string): boolean {
    this.cell(cellId);
    this.nb.focusCell(cellId);
    return true;
  }

  showReview(review: ReviewInfo): { decided: Promise<boolean>; resolve(accept: boolean): void } {
    const cell = this.cell(review.cellId);
    this.nb.focusCell?.(review.cellId);
    // Colab's inline diff: the cell shows `after`, with Accept / Reject buttons.
    const shown: Promise<boolean> = cell.showInlineDiffTo(review.after, {});
    const decided = shown.then((accepted) => {
      if (review.kind === "insert" && !accepted) this.nb.removeCells([cell]);
      if (review.kind === "delete" && accepted) this.nb.removeCells([cell]);
      return accepted;
    });
    return {
      decided,
      resolve: (accept) => {
        const diff = cell.getInlineDiff?.();
        if (!diff) return;
        if (accept) diff.accept();
        else diff.reject();
      },
    };
  }

  onSelectionChange(cb: () => void): void {
    let last = "";
    const fire = () => {
      try {
        const i = this.info();
        const key = `${i.activeCellId}|${i.selectedCellIds.join(",")}`;
        if (key !== last) {
          last = key;
          cb();
        }
      } catch {
        // notebook reloading
      }
    };
    try {
      this.nb.getElement?.()?.addEventListener("focusChanged", fire);
    } catch {
      // fall back to polling below
    }
    setInterval(fire, 1000);
  }
}
