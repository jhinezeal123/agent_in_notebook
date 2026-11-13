import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as vscode from "vscode";
import {
  KERNEL_BUSY, OpError, OutputCollector, notebookKey, within,
  type CellInfo, type CellType, type Execution, type NotebookAdapter, type NotebookInfo, type ReviewInfo, type RunResult,
} from "@ainb/protocol";
import { notebookOutputs, toIpynbOutput } from "./outputs.js";

interface JupyterKernel {
  readonly status: string;
  readonly onDidChangeStatus: vscode.Event<string>;
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<{ items: readonly vscode.NotebookCellOutputItem[] }>;
}

interface JupyterApi {
  kernels?: { getKernel(uri: vscode.Uri): Thenable<JupyterKernel | undefined> };
}

export class VSCodeNotebook implements NotebookAdapter {
  readonly platform = "vscode" as const;
  private readonly ids = new Map<string, string>();
  private readonly claimedIds = new Set<string>();
  private readonly reservations = new Map<string, { index: number; before?: string; after?: string }>();
  private readonly pendingRuns = new Set<string>();
  private readonly pendingReviews = new Set<() => void>();
  private readonly activeExecutions = new Set<vscode.CancellationTokenSource>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private kernel?: JupyterKernel;
  private kernelSubscription?: vscode.Disposable;
  private disposed = false;
  private lookup?: Promise<JupyterKernel | undefined>;

  constructor(readonly document: vscode.NotebookDocument, private readonly changed: () => void) {
    this.refreshKernel();
  }

  dispose(): void {
    this.disposed = true;
    this.kernelSubscription?.dispose();
    for (const reject of this.pendingReviews) reject();
    for (const execution of this.activeExecutions) execution.cancel();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private id(cell: vscode.NotebookCell): string {
    const uri = cell.document.uri.toString();
    const existing = this.ids.get(uri);
    if (existing) return existing;
    const metadataId: unknown = cell.metadata.id;
    const id = typeof metadataId === "string" && metadataId && !this.claimedIds.has(metadataId)
      ? metadataId : `vsc-${randomUUID()}`;
    this.ids.set(uri, id);
    this.claimedIds.add(id);
    return id;
  }

  private find(id: string): vscode.NotebookCell | undefined {
    return this.document.getCells().find((cell) => this.id(cell) === id);
  }

  private requireCell(id: string): vscode.NotebookCell {
    const cell = this.find(id);
    if (!cell) throw new OpError(`No cell with id "${id}".`);
    return cell;
  }

  private editor(): vscode.NotebookEditor | undefined {
    const active = vscode.window.activeNotebookEditor;
    return active?.notebook === this.document ? active : vscode.window.visibleNotebookEditors.find((editor) => editor.notebook === this.document);
  }

  info(): NotebookInfo {
    const editor = this.editor();
    const at = editor?.selection.start;
    const activeCellId = at !== undefined && at < this.document.cellCount ? this.id(this.document.cellAt(at)) : null;
    const selectedCellIds = (editor?.selections ?? []).flatMap((range) => this.document.getCells(range).map((cell) => this.id(cell)));
    return {
      platform: this.platform, title: basename(this.document.uri.path), url: this.document.uri.toString(),
      key: notebookKey(this.platform, this.document.uri.toString()),
      activeCellId, selectedCellIds, cellCount: this.document.cellCount, language: this.language(),
      kernel: this.kernelState(),
    };
  }

  private language(): string {
    const language: unknown = this.document.metadata.metadata?.language_info?.name;
    return this.document.getCells().find((cell) => cell.kind === vscode.NotebookCellKind.Code)?.document.languageId
      ?? (typeof language === "string" ? language : "python");
  }

  private kernelState(): NotebookInfo["kernel"] {
    if (this.pendingRuns.size || this.activeExecutions.size) return "busy";
    switch (this.kernel?.status) {
      case "idle": return "idle";
      case "busy": case "starting": case "restarting": case "autorestarting": return "busy";
      case "dead": case "terminating": return "disconnected";
      default: return "unknown";
    }
  }

  refreshKernel(): void {
    if (vscode.extensions.getExtension("ms-toolsai.jupyter")?.isActive) void this.lookupKernel().catch(() => {});
  }

  private lookupKernel(): Promise<JupyterKernel | undefined> {
    this.lookup ??= (async () => {
      const jupyter = vscode.extensions.getExtension<JupyterApi>("ms-toolsai.jupyter");
      const api = jupyter?.isActive ? jupyter.exports : await jupyter?.activate();
      const kernel = await api?.kernels?.getKernel(this.document.uri);
      if (!this.disposed && this.kernel !== kernel) {
        this.kernelSubscription?.dispose();
        this.kernel = kernel;
        this.kernelSubscription = kernel?.onDidChangeStatus(() => this.changed());
        this.changed();
      }
      return kernel;
    })().finally(() => { this.lookup = undefined; });
    return this.lookup;
  }

  getCells({ cellIds, start, end, includeOutputs }: { cellIds?: string[]; start?: number; end?: number; includeOutputs?: boolean }): CellInfo[] {
    const all = this.document.getCells();
    const byId = cellIds && new Map(all.map((cell) => [this.id(cell), cell]));
    const cells = cellIds && byId ? cellIds.map((id) => byId.get(id)).filter((cell) => cell !== undefined) : all.slice(start, end);
    return cells.map((cell) => ({
      id: this.id(cell), index: cell.index, type: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
      source: cell.document.getText(), executionCount: cell.executionSummary?.executionOrder ?? null,
      running: this.pendingRuns.has(this.id(cell)), ...(includeOutputs ? { outputs: notebookOutputs(cell.outputs) } : {}),
    }));
  }

  async setSource(cellId: string, source: string): Promise<boolean> {
    const { document } = this.requireCell(cellId);
    if (document.getText() === source) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.lineAt(document.lineCount - 1).range.end), source);
    await this.apply(edit);
    return true;
  }

  private async apply(edit: vscode.WorkspaceEdit): Promise<void> {
    if (this.document.isClosed || !await vscode.workspace.applyEdit(edit)) throw new OpError("VS Code could not apply the notebook edit. Read the notebook again and retry.");
  }

  async insertCell(index: number, type: CellType, source: string, id: string = randomUUID()): Promise<string> {
    const cell = new vscode.NotebookCellData(type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup, source, type === "code" ? this.language() : "markdown");
    cell.metadata = { id, metadata: {} };
    await this.replace(new vscode.NotebookRange(index, index), [cell]);
    const inserted = this.document.getCells().find((candidate) => candidate.metadata.id === id);
    if (!inserted) throw new OpError("The inserted cell is no longer in the notebook.");
    this.ids.set(inserted.document.uri.toString(), id);
    this.claimedIds.add(id);
    return id;
  }

  async deleteCell(cellId: string): Promise<void> {
    const { index } = this.requireCell(cellId);
    await this.replace(new vscode.NotebookRange(index, index + 1), []);
  }

  private replace(range: vscode.NotebookRange, cells: vscode.NotebookCellData[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.set(this.document.uri, [vscode.NotebookEdit.replaceCells(range, cells)]);
    return this.apply(edit);
  }

  async moveCell(cellId: string, index: number): Promise<number> {
    const cell = this.requireCell(cellId);
    const target = Math.max(0, Math.min(index, this.document.cellCount - 1));
    if (cell.index === target) return target;
    if (this.pendingRuns.has(cellId)) throw new OpError("Wait for the cell to finish running before moving it.");
    // The public NotebookEdit API exposes splice, so move the existing model
    // through the editor command to preserve IDs, outputs and execution state.
    const editor = await vscode.window.showNotebookDocument(this.document);
    const forward = target > cell.index;
    const command = forward ? "notebook.cell.moveDown" : "notebook.cell.moveUp";
    while (cell.index !== target) {
      const from = cell.index;
      if (vscode.window.activeNotebookEditor?.notebook !== this.document || from < 0 || (target > from) !== forward) {
        throw new OpError("The notebook changed while the move was in progress. Read the cells again.");
      }
      editor.selection = new vscode.NotebookRange(from, from + 1);
      await vscode.commands.executeCommand(command);
      if (cell.index !== from + (forward ? 1 : -1)) throw new OpError("VS Code could not move the cell to the requested position.");
    }
    return target;
  }

  async focusCell(cellId: string): Promise<boolean> {
    const cell = this.find(cellId);
    if (!cell) return false;
    const editor = await vscode.window.showNotebookDocument(this.document);
    if (cell.index < 0) return false;
    editor.selection = new vscode.NotebookRange(cell.index, cell.index + 1);
    editor.revealRange(editor.selection, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  onSelectionChange(cb: () => void): void {
    this.subscriptions.push(vscode.window.onDidChangeNotebookEditorSelection((event) => {
      if (event.notebookEditor === this.editor()) cb();
    }));
  }

  reserveCell(index: number): string {
    const id = randomUUID();
    const count = this.document.cellCount;
    this.reservations.set(id, {
      index, before: index > 0 ? this.id(this.document.cellAt(index - 1)) : undefined,
      after: index < count ? this.id(this.document.cellAt(index)) : undefined,
    });
    return id;
  }

  showReview(review: ReviewInfo) {
    const { cellId } = review;
    let settle!: (accept: boolean) => void;
    const choice = new Promise<boolean>((resolve) => { settle = resolve; });
    const reject = () => settle(false);
    this.pendingReviews.add(reject);
    const decided = choice.then(async (accept) => {
      if (!accept) return false;
      if (review.kind === "insert") {
        const position = this.reservations.get(cellId)!;
        const before = position.before ? this.find(position.before) : undefined;
        const after = position.after ? this.find(position.after) : undefined;
        const index = after?.index ?? (before ? before.index + 1 : Math.min(position.index, this.document.cellCount));
        await this.insertCell(index, review.cellType, review.after, cellId);
        return { index };
      }
      const cell = this.find(cellId);
      if (!cell || cell.document.getText() !== review.before) throw new OpError("The cell changed while the diff was pending. Ask the agent to propose the edit again.");
      const { index } = cell;
      if (review.kind === "update") await this.setSource(cellId, review.after);
      else await this.deleteCell(cellId);
      return { index };
    }).finally(() => {
      this.reservations.delete(cellId);
      this.pendingReviews.delete(reject);
    });
    return { decided, resolve: async (accept: boolean) => { settle(accept); await decided; } };
  }

  async runCell(cellId: string, timeoutMs: number): Promise<RunResult> {
    const cell = this.requireCell(cellId);
    if (cell.kind !== vscode.NotebookCellKind.Code) return { cellId, status: "skipped", outputs: [], message: "Not a code cell." };
    if (!this.editor()) throw new OpError("Reveal this notebook in VS Code before running cells.");
    if (this.pendingRuns.has(cellId)) return { cellId, status: "timeout", outputs: [], message: "The cell is already running." };
    const previous = cell.executionSummary;
    this.pendingRuns.add(cellId);
    this.changed();
    const options = { document: this.document.uri, ranges: [{ start: cell.index, end: cell.index + 1 }], autoReveal: false };
    const execution = Promise.resolve(vscode.commands.executeCommand("notebook.cell.execute", options)).then((): RunResult => {
      if (cell.index < 0) throw new OpError("The cell was removed during execution.");
      const summary = cell.executionSummary;
      if (previous === summary || !summary) throw new OpError("VS Code did not run the cell. Select a kernel in the notebook toolbar and try again.");
      const outputs = notebookOutputs(cell.outputs);
      return { cellId, status: summary.success === false || outputs.some((out) => out.kind === "error") ? "error" : "ok", executionCount: summary.executionOrder, outputs };
    }).finally(() => {
      this.pendingRuns.delete(cellId);
      this.refreshKernel();
      this.changed();
    });
    const result = await within(execution, timeoutMs);
    return result.done ? result.value : { cellId, status: "timeout", outputs: notebookOutputs(cell.outputs) };
  }

  async interrupt(): Promise<boolean> {
    const executing = this.activeExecutions.size > 0;
    for (const execution of this.activeExecutions) execution.cancel();
    const ranges = this.document.getCells().filter((cell) => this.pendingRuns.has(this.id(cell))).map(({ index }) => ({ start: index, end: index + 1 }));
    if (ranges.length && this.editor()) {
      await vscode.commands.executeCommand("notebook.cell.cancelExecution", { document: this.document.uri, ranges });
      return true;
    }
    if (this.kernel?.status !== "busy") return executing;
    await vscode.commands.executeCommand("jupyter.interruptkernel", { notebookEditor: { notebookUri: this.document.uri } });
    return true;
  }

  async startExecution(code: string): Promise<Execution> {
    if (this.info().kernel === "busy") throw new OpError(KERNEL_BUSY);
    const jupyter = vscode.extensions.getExtension<JupyterApi>("ms-toolsai.jupyter");
    if (!jupyter || !(await jupyter.activate())?.kernels) throw new OpError("Executing code outside a cell requires the Microsoft Jupyter extension and its kernel API. Run a cell instead.");
    const kernel = await this.lookupKernel();
    if (!kernel) throw new OpError("Start the Jupyter kernel by running a cell in this notebook, then grant kernel access if prompted.");
    if (kernel.status === "busy" || this.info().kernel === "busy") throw new OpError(KERNEL_BUSY);
    if (kernel.status !== "idle") throw new OpError(`The Jupyter kernel is ${kernel.status}. Wait for it to be idle and try again.`);
    if (this.document.isClosed) throw new OpError("The notebook was closed.");
    const token = new vscode.CancellationTokenSource();
    this.activeExecutions.add(token);
    this.changed();
    const collected = new OutputCollector();
    const reply = (async () => {
      try {
        for await (const output of kernel.executeCode(code, token.token)) collected.add(toIpynbOutput(output));
        return { status: token.token.isCancellationRequested || collected.outputs.some((output) => output.kind === "error") ? "error" : "ok" };
      } finally {
        this.activeExecutions.delete(token);
        token.dispose();
        this.changed();
      }
    })();
    return { reply, collected };
  }
}
