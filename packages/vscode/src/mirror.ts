// A notebook open in a Chrome tab (Colab, Kaggle, Jupyter), shown and edited
// in VS Code. The browser keeps the notebook and runs it; VS Code holds a live
// copy:
// - browser to VS Code: the cells are read every second, each with a
//   fingerprint of its outputs; changed sources, cells added, removed or
//   moved, runs, and any output that changed (also while a cell runs) show up.
//   The outputs follow the page whatever it says about runs;
// - a reload of the page (or of the extension) pauses the copy; it follows the
//   notebook again when the same notebook comes back in that tab;
// - VS Code to browser: the user's edits are sent as they type (a short pause
//   first), cells added, removed or moved are sent in order, and running a
//   cell runs it in the browser.
// A cell the user is still editing keeps the user's text. Saving does
// nothing: Colab and Kaggle save the notebook themselves.

import * as vscode from "vscode";
import type { BrowserOp, CellInfo, CellType, NotebookInfo } from "@ainb/protocol";
import { planPush, pullAction, sameOrder, toEditorOutputs, type LocalCell } from "./mirror-sync.js";

export const MIRROR_TYPE = "ainb-chrome-notebook";
const SCHEME = "ainb-chrome";
const POLL_MS = 1000;
const PUSH_DELAY_MS = 400;
/** A run started from VS Code waits this long for a quick answer; longer runs are followed by polling. */
const RUN_WAIT_MS = 1500;
/** How long a mirror waits for its tab's notebook to come back (a reload) before letting go. */
const AWAY_MS = 3 * 60_000;

type Request = (method: string, params: unknown) => Promise<unknown>;

interface Snapshot {
  language: string;
  cells: CellInfo[];
}

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

/** The Chrome tab a mirror's URI stands for. */
export function mirrorTab(uri: vscode.Uri): number | null {
  if (uri.scheme !== SCHEME) return null;
  const tab = Number(uri.path.split("/")[1]);
  return Number.isSafeInteger(tab) ? tab : null;
}

export class ChromeMirrors implements vscode.Disposable {
  private readonly mirrors = new Map<vscode.NotebookDocument, Mirror>();
  private readonly controller: vscode.NotebookController;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly epoch = Date.now();

  constructor(private readonly request: Request) {
    this.controller = vscode.notebooks.createNotebookController("ainb-chrome-kernel", MIRROR_TYPE, "Chrome tab (Colab / Kaggle)");
    this.controller.description = "Runs the cells in the notebook's browser tab";
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, document) => this.mirrors.get(document)?.run(cells);
    this.controller.interruptHandler = (document) => this.mirrors.get(document)?.interrupt();
    this.subscriptions.push(
      this.controller,
      vscode.workspace.registerFileSystemProvider(SCHEME, this.files(), { isCaseSensitive: true }),
      vscode.workspace.registerNotebookSerializer(MIRROR_TYPE, this.serializer(), {
        transientOutputs: true,
        transientCellMetadata: { id: true },
      }),
      vscode.workspace.onDidOpenNotebookDocument((document) => this.attach(document)),
      vscode.workspace.onDidCloseNotebookDocument((document) => {
        this.mirrors.get(document)?.dispose();
        this.mirrors.delete(document);
      }),
      vscode.workspace.onDidChangeNotebookDocument((event) => this.mirrors.get(event.notebook)?.localChanged(event)),
    );
    for (const document of vscode.workspace.notebookDocuments) this.attach(document);
  }

  op(tab: number, op: BrowserOp): Promise<unknown> {
    return this.request("browser.op", { tabId: tab, op });
  }

  /** Open (or show again) the notebook of a Chrome tab in VS Code. */
  async open(tab: number, info: NotebookInfo): Promise<void> {
    const stem = info.title.replace(/\.ipynb$/i, "").replace(/[\\/:*?"<>|]+/g, "_") || "notebook";
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${tab}/${stem} (${PLATFORM[info.platform]}).ainb` });
    const document = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(document, { preview: false });
  }

  /** The notebook each tab last showed, so a reload is told from going to another notebook. */
  private readonly keys = new Map<number, string>();

  /**
   * A Chrome tab's notebook went away (a reload, the extension reloading, the
   * tab closed) or came (back): its mirror pauses, then follows it again when
   * the same notebook returns, or lets go when another one does.
   */
  browserChanged(tab: number, info: NotebookInfo | null): void {
    const before = this.keys.get(tab);
    if (info?.key) this.keys.set(tab, info.key);
    for (const mirror of this.mirrors.values()) {
      if (mirror.tab !== tab) continue;
      if (!info) mirror.away();
      else if (before && info.key && before !== info.key) mirror.detach("The Chrome tab now shows another notebook; this copy no longer follows it.");
      else mirror.back();
    }
  }

  private attach(document: vscode.NotebookDocument): void {
    if (document.notebookType !== MIRROR_TYPE || this.mirrors.has(document)) return;
    const tab = mirrorTab(document.uri);
    if (tab === null) return;
    this.controller.updateNotebookAffinity(document, vscode.NotebookControllerAffinity.Preferred);
    this.mirrors.set(document, new Mirror(tab, document, this, this.controller));
  }

  private files(): vscode.FileSystemProvider {
    const changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    const denied = () => { throw vscode.FileSystemError.NoPermissions("A notebook in Chrome is only opened and saved."); };
    return {
      onDidChangeFile: changed.event,
      watch: () => new vscode.Disposable(() => {}),
      stat: (uri) => {
        if (mirrorTab(uri) === null) throw vscode.FileSystemError.FileNotFound(uri);
        return { type: vscode.FileType.File, ctime: this.epoch, mtime: this.epoch, size: 0 };
      },
      readFile: async (uri) => {
        const tab = mirrorTab(uri);
        if (tab === null) throw vscode.FileSystemError.FileNotFound(uri);
        try {
          const info = await this.op(tab, { op: "info" }) as NotebookInfo;
          const { cells } = await this.op(tab, { op: "get_cells", includeOutputs: true }) as { cells: CellInfo[] };
          return new TextEncoder().encode(JSON.stringify({ language: info.language, cells } satisfies Snapshot));
        } catch (e) {
          throw vscode.FileSystemError.Unavailable(`The notebook in Chrome could not be read: ${(e as Error).message}`);
        }
      },
      // The browser holds the notebook (Colab and Kaggle save it); edits already went there.
      writeFile: () => {},
      readDirectory: denied,
      createDirectory: denied,
      delete: denied,
      rename: denied,
    };
  }

  private serializer(): vscode.NotebookSerializer {
    return {
      deserializeNotebook: (content) => {
        const snapshot = JSON.parse(new TextDecoder().decode(content) || '{"language":"python","cells":[]}') as Snapshot;
        return new vscode.NotebookData(snapshot.cells.map((cell) => cellData(cell, snapshot.language)));
      },
      serializeNotebook: () => new Uint8Array(),
    };
  }

  dispose(): void {
    for (const mirror of this.mirrors.values()) mirror.dispose();
    this.mirrors.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

function cellData(cell: CellInfo, language: string): vscode.NotebookCellData {
  const code = cell.type === "code";
  const data = new vscode.NotebookCellData(code ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup, cell.source, code ? language : "markdown");
  data.metadata = { id: cell.id };
  if (cell.outputs) data.outputs = editorOutputs(cell.outputs);
  if (cell.executionCount) data.executionSummary = { executionOrder: cell.executionCount };
  return data;
}

function editorOutputs(outputs: CellInfo["outputs"]): vscode.NotebookCellOutput[] {
  return toEditorOutputs(outputs ?? []).map((o) => new vscode.NotebookCellOutput(o.items.map((i) => new vscode.NotebookCellOutputItem(i.data, i.mime)), o.metadata));
}

const idOf = (cell: vscode.NotebookCell): string | null => (typeof cell.metadata.id === "string" ? cell.metadata.id : null);
const typeOf = (cell: vscode.NotebookCell): CellType => (cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown");

/** What the browser held when last read or written, by cell. */
interface Known {
  id: string;
  type: CellType;
  source: string;
  executionCount: number | null;
  running: boolean;
  /** Fingerprint of the outputs shown here; null: not read yet, read them. */
  outputsHash: string | null;
}

class Mirror {
  private known: Known[] = [];
  private readonly pushes = new Map<vscode.NotebookCell, ReturnType<typeof setTimeout>>();
  private structure?: ReturnType<typeof setTimeout>;
  private readonly executions = new Map<string, vscode.NotebookCellExecution>();
  /** Set while the tab's notebook is away (reloading): when it fires, the mirror lets go. */
  private awayTimer?: ReturnType<typeof setTimeout>;
  private awayNote?: vscode.Disposable;
  private readonly timer: ReturnType<typeof setInterval>;
  /** Pushes to the browser, one at a time and in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private polling = false;
  /** Runs started here whose run_cells has not answered, and a count of those started: a poll read across one is stale. */
  private runsInFlight = 0;
  private runsStarted = 0;
  private detached = false;
  private language = "python";

  constructor(
    readonly tab: number,
    private readonly document: vscode.NotebookDocument,
    private readonly host: ChromeMirrors,
    private readonly controller: vscode.NotebookController,
  ) {
    this.known = document.getCells().flatMap((cell) => {
      const id = idOf(cell);
      return id ? [{ id, type: typeOf(cell), source: cell.document.getText(), executionCount: cell.executionSummary?.executionOrder ?? null, running: false, outputsHash: null }] : [];
    });
    this.language = document.getCells().find((cell) => cell.kind === vscode.NotebookCellKind.Code)?.document.languageId ?? "python";
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.structure);
    for (const timer of this.pushes.values()) clearTimeout(timer);
    clearTimeout(this.awayTimer);
    this.awayNote?.dispose();
    for (const execution of this.executions.values()) execution.end(undefined);
    this.executions.clear();
  }

  detach(message: string): void {
    if (this.detached) return;
    this.detached = true;
    this.dispose();
    void vscode.window.showWarningMessage(message);
  }

  /** The tab's notebook went away (often a reload): wait for it before letting go. */
  away(): void {
    if (this.detached || this.awayTimer) return;
    this.awayNote = vscode.window.setStatusBarMessage("$(sync~spin) Notebook in Chrome is reloading: waiting for it");
    this.awayTimer = setTimeout(() => this.detach("The notebook's Chrome tab was closed or left the notebook; this copy no longer follows it."), AWAY_MS);
  }

  /** The tab shows the notebook (again): follow it. Outputs are read again in case the page lost some. */
  back(): void {
    if (!this.awayTimer) return;
    clearTimeout(this.awayTimer);
    this.awayTimer = undefined;
    this.awayNote?.dispose();
    this.awayNote = undefined;
    for (const known of this.known) known.outputsHash = null;
  }

  private op(op: BrowserOp): Promise<unknown> {
    return this.host.op(this.tab, op);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private busy(): boolean {
    return this.pushes.size > 0 || this.structure !== undefined;
  }

  // ---------------------------------------------------------------- VS Code -> browser

  localChanged(event: vscode.NotebookDocumentChangeEvent): void {
    if (this.detached) return;
    if (event.contentChanges.length) {
      clearTimeout(this.structure);
      this.structure = setTimeout(() => {
        this.structure = undefined;
        void this.enqueue(() => this.pushStructure()).catch((e) => this.failed(e));
      }, PUSH_DELAY_MS);
    }
    for (const change of event.cellChanges) {
      if (!change.document) continue;
      const cell = change.cell;
      clearTimeout(this.pushes.get(cell));
      this.pushes.set(cell, setTimeout(() => void this.flush(cell).catch((e) => this.failed(e)), PUSH_DELAY_MS));
    }
  }

  /** Send a cell's text now if it differs from the browser's. */
  private flush(cell: vscode.NotebookCell): Promise<void> {
    clearTimeout(this.pushes.get(cell));
    this.pushes.delete(cell);
    return this.enqueue(async () => {
      const id = idOf(cell);
      const known = id ? this.known.find((k) => k.id === id) : undefined;
      if (!id || !known || cell.index < 0) return;
      const source = cell.document.getText();
      if (source === known.source) return;
      await this.op({ op: "update_cell", cellId: id, source, review: false, byUser: true });
      known.source = source;
      await this.saved();
    });
  }

  /** Bring the browser's cells in line with the mirror's: removed, moved and new cells. */
  private async pushStructure(): Promise<void> {
    const cells = this.document.getCells();
    const local: LocalCell[] = cells.map((cell) => ({ id: idOf(cell), type: typeOf(cell) }));
    if (sameOrder(local, this.known)) return;
    for (const step of planPush(local, this.known)) {
      if (step.op === "delete") {
        await this.op({ op: "delete_cell", cellId: step.id, review: false, byUser: true });
      } else if (step.op === "move") {
        await this.op({ op: "move_cell", cellId: step.id, index: step.index, byUser: true });
      } else {
        const cell = cells[step.localIndex]!;
        const res = await this.op({ op: "insert_cell", index: step.localIndex, cellType: typeOf(cell), source: cell.document.getText(), review: false, byUser: true }) as { cellId: string | null };
        if (res.cellId && cell.index >= 0) {
          const edit = new vscode.WorkspaceEdit();
          edit.set(this.document.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, id: res.cellId })]);
          await vscode.workspace.applyEdit(edit);
        }
      }
    }
    const { cells: remote } = await this.op({ op: "get_cells" }) as { cells: CellInfo[] };
    const previous = new Map(this.known.map((k) => [k.id, k.outputsHash]));
    this.known = remote.map((c) => ({ id: c.id, type: c.type, source: c.source, executionCount: c.executionCount ?? null, running: !!c.running, outputsHash: previous.get(c.id) ?? null }));
    await this.saved();
  }

  /** The browser has every edit: nothing is left to save. */
  private async saved(): Promise<void> {
    if (this.document.isDirty && !this.busy()) await this.document.save();
  }

  // ---------------------------------------------------------------- runs

  async run(cells: vscode.NotebookCell[]): Promise<void> {
    if (this.detached) return;
    if (this.structure !== undefined) {
      clearTimeout(this.structure);
      this.structure = undefined;
      await this.enqueue(() => this.pushStructure()).catch((e) => this.failed(e));
    }
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      await this.flush(cell).catch((e) => this.failed(e));
      const id = idOf(cell);
      if (!id) continue;
      this.started(cell, id, true);
      this.runsInFlight++;
      this.runsStarted++;
      try {
        const { results } = await this.op({ op: "run_cells", cellIds: [id], timeoutMs: RUN_WAIT_MS, stopOnError: true }) as { results: { status: string; executionCount?: number | null; outputs: CellInfo["outputs"] }[] };
        const result = results[0];
        // Still running: polling sees it finish.
        if (result && result.status !== "timeout") this.finished(cell, id, result.executionCount ?? null, result.outputs ?? [], result.status !== "error");
        else if (result) this.showLive(id, result.outputs ?? []);
        const known = this.known.find((k) => k.id === id);
        if (known) {
          known.running = result?.status === "timeout";
          if (!known.running && result?.executionCount != null) known.executionCount = result.executionCount;
          // Polling compares the browser's outputs from here.
          known.outputsHash = null;
        }
      } catch (e) {
        this.executions.get(id)?.end(false, Date.now());
        this.executions.delete(id);
        this.failed(e);
      } finally {
        this.runsInFlight--;
      }
    }
  }

  async interrupt(): Promise<void> {
    await this.op({ op: "interrupt" }).catch((e) => this.failed(e));
  }

  /**
   * Show a cell as running. `clear`: a run started here, which starts from no
   * output; a run seen in the browser keeps what is shown, and its outputs
   * follow the browser's.
   */
  private started(cell: vscode.NotebookCell, id: string, clear = false): void {
    if (this.executions.has(id)) return;
    try {
      const execution = this.controller.createNotebookCellExecution(cell);
      execution.start(Date.now());
      if (clear) void execution.clearOutput();
      this.executions.set(id, execution);
      if (clear) {
        const known = this.known.find((k) => k.id === id);
        if (known) known.outputsHash = null;
      }
    } catch {
      // Another kernel is selected for this notebook.
    }
  }

  /**
   * A cell's run ended, or its outputs or count changed in the browser
   * without a run seen here (a fast run, outputs cleared): show what it holds.
   */
  private finished(cell: vscode.NotebookCell, id: string, executionCount: number | null, outputs: CellInfo["outputs"], success: boolean | undefined): boolean {
    let execution = this.executions.get(id);
    const timed = !!execution;
    if (!execution) {
      try {
        execution = this.controller.createNotebookCellExecution(cell);
        execution.start();
      } catch {
        return false; // Another kernel is selected for this notebook.
      }
    }
    this.executions.delete(id);
    if (executionCount) execution.executionOrder = executionCount;
    void execution.replaceOutput(editorOutputs(outputs));
    execution.end(success, timed ? Date.now() : undefined);
    return true;
  }

  /** What a running cell has printed so far, shown as it comes. */
  private showLive(id: string, outputs: CellInfo["outputs"]): void {
    void this.executions.get(id)?.replaceOutput(editorOutputs(outputs));
  }

  // ---------------------------------------------------------------- browser -> VS Code

  private async poll(): Promise<void> {
    if (this.polling || this.detached || this.awayTimer || this.document.isClosed) return;
    this.polling = true;
    try {
      const runs = this.runsStarted;
      const { cells: remote } = await this.op({ op: "get_cells", outputsHash: true }) as { cells: CellInfo[] };
      // Read before a run started here reached the browser: it would end that run's spinner.
      if (this.busy() || this.awayTimer || this.runsInFlight || runs !== this.runsStarted) return;
      await this.enqueue(() => this.pull(remote));
    } catch {
      // Not reachable now (bridge or tab away for a moment): try again on the next tick.
    } finally {
      this.polling = false;
    }
  }

  private async pull(remote: CellInfo[]): Promise<void> {
    const local = this.document.getCells();
    const localCells: LocalCell[] = local.map((cell) => ({ id: idOf(cell), type: typeOf(cell) }));
    const knownOrder = this.known.map((k) => ({ id: k.id, type: k.type }));
    const remoteOrder = remote.map((c) => ({ id: c.id, type: c.type }));
    // A mirror that no longer matches what the browser was last known to hold,
    // with no change of the user's on its way, takes the browser's notebook:
    // waiting would leave it stuck for good.
    const action = pullAction(localCells, knownOrder, remoteOrder, this.structure !== undefined);
    if (action === "wait") return;
    if (action === "rebuild") {
      await this.rebuild();
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    let edits = 0;
    const changed: { cell: vscode.NotebookCell; known: Known; remote: CellInfo }[] = [];
    for (const [i, r] of remote.entries()) {
      const known = this.known[i]!;
      const cell = local[i]!;
      if (r.source !== known.source && cell.document.getText() === known.source) {
        // Changed in the browser (by the agent or in the page), not being edited here.
        edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), r.source);
        edits++;
      }
      known.source = r.source;
      const running = !!r.running;
      const count = r.executionCount ?? null;
      // Also after a rebuild, which ends the runs it shows: one still running gets its spinner back.
      if (running) this.started(cell, r.id);
      const ended = !running && this.executions.has(r.id);
      const outputsChanged = r.outputsHash !== undefined && r.outputsHash !== known.outputsHash;
      const countChanged = !running && count !== known.executionCount;
      known.running = running;
      // Compared on what the browser answers, not on run events: whatever the
      // page says about runs, a changed output is read and shown.
      if (ended || outputsChanged || countChanged) changed.push({ cell, known, remote: r });
      else known.executionCount = count;
    }
    if (edits) {
      await vscode.workspace.applyEdit(edit);
      await this.saved();
    }
    if (!changed.length) return;
    const { cells } = await this.op({ op: "get_cells", cellIds: changed.map((c) => c.remote.id), includeOutputs: true, outputsHash: true }) as { cells: CellInfo[] };
    const read = new Map(cells.map((c) => [c.id, c]));
    for (const { cell, known, remote: r } of changed) {
      const now = read.get(r.id);
      if (!now || cell.index < 0) continue;
      const outputs = now.outputs ?? [];
      const count = now.executionCount ?? null;
      if (now.running) {
        // Shown as running nowhere (another kernel selected): try again on the next tick.
        if (!this.executions.has(r.id)) continue;
        this.showLive(r.id, outputs);
      } else if (!this.finished(cell, r.id, count, outputs, count === null ? undefined : !outputs.some((o) => o.kind === "error"))) {
        continue;
      }
      known.outputsHash = now.outputsHash ?? null;
      if (!now.running) known.executionCount = count;
    }
  }

  /** Cells were added, removed or moved in the browser: read the whole notebook again. */
  private async rebuild(): Promise<void> {
    const { cells } = await this.op({ op: "get_cells", includeOutputs: true, outputsHash: true }) as { cells: CellInfo[] };
    for (const execution of this.executions.values()) execution.end(undefined);
    this.executions.clear();
    this.known = cells.map((c) => ({ id: c.id, type: c.type, source: c.source, executionCount: c.executionCount ?? null, running: !!c.running, outputsHash: c.outputsHash ?? null }));
    const edit = new vscode.WorkspaceEdit();
    edit.set(this.document.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, this.document.cellCount), cells.map((c) => cellData(c, this.language)))]);
    await vscode.workspace.applyEdit(edit);
    await this.saved();
  }

  private failed(e: unknown): void {
    void vscode.window.showErrorMessage(`Agent in Notebook: the notebook in Chrome did not take the change: ${(e as Error).message}`);
  }
}
