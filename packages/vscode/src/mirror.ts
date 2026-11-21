// A notebook open in a Chrome tab (Colab, Kaggle, Jupyter), shown and edited
// in VS Code. The browser keeps the notebook and runs it; VS Code holds a live
// copy:
// - browser to VS Code: every second the cells are read as digests (a hash of
//   each source and a fingerprint of its outputs, no payload); only what
//   changed is fetched — a changed source without its outputs, changed outputs
//   with them. Cells added, removed or moved in the browser are followed with
//   the fewest edits (cells that stay put keep their place and their spinner);
//   the whole notebook is rebuilt only when most of it changed. The outputs
//   follow the page whatever it says about runs; a running cell printing more
//   than 100 KB of text is shown live at most every 2 s;
// - a reload of the page (or of the extension) pauses the copy; it follows the
//   notebook again when the same notebook comes back in that tab;
// - VS Code to browser: the user's edits are sent as they type (a short pause
//   first) as a compare-and-set from the browser text the edit started from:
//   if the cell changed in Chrome meanwhile, nothing is sent, the cell is read
//   again, and the user is told their unsent edit stays in the editor until
//   they edit it again. Cells added, removed or moved are sent in order, and
//   running a cell runs it in the browser.
// A cell the user is still editing keeps the user's text. Saving does nothing
// (Colab and Kaggle save the notebook themselves); the dirty mark is cleared
// once per poll, when no push is on its way.

import * as vscode from "vscode";
import { textHash, type BrowserOp, type CellInfo, type CellType, type NotebookInfo } from "@ainb/protocol";
import { planPull, planPush, pullAction, sameOrder, toEditorOutputs, type LocalCell, type PullStep } from "./mirror-sync.js";

export const MIRROR_TYPE = "ainb-chrome-notebook";
const SCHEME = "ainb-chrome";
const POLL_MS = 1000;
const PUSH_DELAY_MS = 400;
/** A run started from VS Code waits this long for a quick answer; longer runs are followed by polling. */
const RUN_WAIT_MS = 1500;
/** How long a mirror waits for its tab's notebook to come back (a reload) before letting go. */
const AWAY_MS = 3 * 60_000;
/** A running cell printing more text than this is shown live at most every LIVE_THROTTLE_MS. */
const LIVE_THROTTLE_TEXT = 100_000;
const LIVE_THROTTLE_MS = 2000;

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
  /** Mirrors whose kernel is this controller: only then can it show runs and outputs. */
  private readonly bound = new Set<vscode.NotebookDocument>();

  constructor(private readonly request: Request, private readonly extensionId: string) {
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
      this.controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
        if (selected) this.bound.add(notebook);
        else this.bound.delete(notebook);
      }),
      vscode.window.onDidChangeActiveNotebookEditor((editor) => void this.bind(editor)),
      vscode.workspace.onDidOpenNotebookDocument((document) => this.attach(document)),
      vscode.workspace.onDidCloseNotebookDocument((document) => {
        this.mirrors.get(document)?.dispose();
        this.mirrors.delete(document);
        this.bound.delete(document);
      }),
      vscode.workspace.onDidChangeNotebookDocument((event) => this.mirrors.get(event.notebook)?.localChanged(event)),
    );
    for (const document of vscode.workspace.notebookDocuments) this.attach(document);
    void this.bind(vscode.window.activeNotebookEditor);
  }

  /**
   * Make this controller the mirror's kernel. A cell execution, the only way
   * to show a run and its outputs, can be created only by the selected
   * controller, and VS Code selects one by itself only when a cell is run here:
   * a mirror that only watches runs started in the browser would stay idle and empty.
   */
  private async bind(editor: vscode.NotebookEditor | undefined): Promise<void> {
    const document = editor?.notebook;
    if (!document || !this.mirrors.has(document) || this.bound.has(document)) return;
    await vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor: editor, id: this.controller.id, extension: this.extensionId })
      .then(undefined, () => {});
  }

  op(tab: number, op: BrowserOp): Promise<unknown> {
    return this.request("browser.op", { tabId: tab, op });
  }

  /** Open (or show again) the notebook of a Chrome tab in VS Code. */
  async open(tab: number, info: NotebookInfo): Promise<void> {
    const stem = info.title.replace(/\.ipynb$/i, "").replace(/[\\/:*?"<>|]+/g, "_") || "notebook";
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${tab}/${stem} (${PLATFORM[info.platform]}).ainb` });
    const document = await vscode.workspace.openNotebookDocument(uri);
    await this.bind(await vscode.window.showNotebookDocument(document, { preview: false }));
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
  /** textHash(source): compared with the digest a poll reads, so an unchanged source is never fetched. */
  sourceHash: string;
  executionCount: number | null;
  running: boolean;
  /** Fingerprint of the outputs shown here; null: not read yet, read them. */
  outputsHash: string | null;
}

export class Mirror {
  private known: Known[] = [];
  private readonly pushes = new Map<vscode.NotebookCell, ReturnType<typeof setTimeout>>();
  private structure?: ReturnType<typeof setTimeout>;
  private structurePush: Promise<void> = Promise.resolve();
  private readonly executions = new Map<string, vscode.NotebookCellExecution>();
  /** The browser source each cell's unsent edit started from: the compare-and-set base of its push. */
  private readonly editBase = new Map<string, string>();
  /** Cells whose push lost a compare-and-set: their text stays in the editor, unsent, until the user edits again. */
  private readonly conflicted = new Set<string>();
  /** When a running cell's large output was last shown live (see LIVE_THROTTLE_MS). */
  private readonly liveShownAt = new Map<string, number>();
  /** Set while the tab's notebook is away (reloading): when it fires, the mirror lets go. */
  private awayTimer?: ReturnType<typeof setTimeout>;
  private awayNote?: vscode.Disposable;
  private readonly timer: ReturnType<typeof setInterval>;
  /** Pushes to the browser, one at a time and in order. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Tasks on the queue, waiting or running: the document is saved only when it is 0. */
  private pending = 0;
  private polling = false;
  private editVersion = 0;
  /** Runs started here whose run_cells has not answered, and a count of those started: a poll read across one is stale. */
  private runsInFlight = 0;
  private runsStarted = 0;
  private detached = false;
  private language = "python";

  constructor(
    readonly tab: number,
    private readonly document: vscode.NotebookDocument,
    private readonly host: Pick<ChromeMirrors, "op">,
    private readonly controller: vscode.NotebookController,
  ) {
    this.known = document.getCells().flatMap((cell) => {
      const id = idOf(cell);
      if (!id) return [];
      const source = cell.document.getText();
      return [{ id, type: typeOf(cell), source, sourceHash: textHash(source), executionCount: cell.executionSummary?.executionOrder ?? null, running: false, outputsHash: null }];
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
    this.editBase.clear();
    this.conflicted.clear();
    this.liveShownAt.clear();
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
    this.pending++;
    const next = this.queue.then(task, task);
    this.queue = next.then(() => { this.pending--; }, () => { this.pending--; });
    return next;
  }

  private busy(): boolean {
    return this.pushes.size > 0 || this.structure !== undefined;
  }

  /** Forget the per-cell state of cells the browser no longer has. */
  private pruneCellState(): void {
    const ids = new Set(this.known.map((k) => k.id));
    for (const id of [...this.editBase.keys()]) if (!ids.has(id)) this.editBase.delete(id);
    for (const id of [...this.conflicted]) if (!ids.has(id)) this.conflicted.delete(id);
    for (const id of [...this.liveShownAt.keys()]) if (!ids.has(id)) this.liveShownAt.delete(id);
  }

  // ---------------------------------------------------------------- VS Code -> browser

  localChanged(event: vscode.NotebookDocumentChangeEvent): void {
    if (this.detached) return;
    if (event.contentChanges.length || event.cellChanges.some((change) => change.document)) this.editVersion++;
    if (event.contentChanges.length) {
      clearTimeout(this.structure);
      this.structure = setTimeout(() => {
        this.structure = undefined;
        this.structurePush = this.enqueue(() => this.pushStructure());
        void this.structurePush.catch((e) => this.failed(e));
      }, PUSH_DELAY_MS);
    }
    for (const change of event.cellChanges) {
      if (!change.document) continue;
      const cell = change.cell;
      const id = idOf(cell);
      if (id) {
        // A new edit may send the cell again, from the browser text it now starts from.
        this.conflicted.delete(id);
        if (!this.editBase.has(id)) {
          const known = this.known.find((k) => k.id === id);
          if (known) this.editBase.set(id, known.source);
        }
      }
      clearTimeout(this.pushes.get(cell));
      this.pushes.set(cell, setTimeout(() => void this.flush(cell).catch((e) => this.failed(e)), PUSH_DELAY_MS));
    }
  }

  /** Send a cell's text now if it differs from the browser's, as a compare-and-set from the edit's base. */
  private flush(cell: vscode.NotebookCell): Promise<void> {
    clearTimeout(this.pushes.get(cell));
    this.pushes.delete(cell);
    return this.enqueue(async () => {
      const id = idOf(cell);
      const known = id ? this.known.find((k) => k.id === id) : undefined;
      if (!id || !known || cell.index < 0) return;
      const source = cell.document.getText();
      if (source === known.source) {
        this.editBase.delete(id);
        this.conflicted.delete(id);
        return;
      }
      // A lost compare-and-set keeps the text here unsent: pushing it again would
      // overwrite what the browser now holds with a stale edit. Only a new edit sends it.
      if (this.conflicted.has(id)) return;
      const expectedSource = this.editBase.get(id) ?? known.source;
      const res = await this.op({ op: "update_cell", cellId: id, source, review: false, byUser: true, expectedSource }) as { applied: boolean; conflict?: boolean };
      if (res.conflict) {
        this.editBase.delete(id);
        this.conflicted.add(id);
        await this.readConflicted(cell, id, known);
        if (cell.index >= 0) void vscode.window.showWarningMessage(`Cell ${cell.index + 1} changed in Chrome; your unsent edit was kept in the editor but not pushed. Edit it again to send.`);
        return;
      }
      this.editVersion++;
      known.source = source;
      known.sourceHash = textHash(source);
      this.editBase.delete(id);
    });
  }

  /** A push lost its compare-and-set: read the cell again (text and outputs) so the mirror knows what the browser holds. */
  private async readConflicted(cell: vscode.NotebookCell, id: string, known: Known): Promise<void> {
    const { cells } = await this.op({ op: "get_cells", cellIds: [id], includeOutputs: true, outputsHash: true }) as { cells: CellInfo[] };
    const now = cells[0];
    if (!now || cell.index < 0) return;
    known.source = now.source;
    known.sourceHash = textHash(now.source);
    known.outputsHash = now.outputsHash ?? null;
    known.running = !!now.running;
    const outputs = now.outputs ?? [];
    const count = now.executionCount ?? null;
    if (now.running) {
      this.started(cell, id);
      if (this.executions.has(id)) {
        this.showLive(id, outputs);
        this.liveShownAt.set(id, Date.now());
      }
    } else {
      known.executionCount = count;
      this.finished(cell, id, count, outputs, count === null ? undefined : !outputs.some((o) => o.kind === "error"));
    }
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
    this.editVersion++;
    const previous = new Map(this.known.map((k) => [k.id, k.outputsHash]));
    this.known = remote.map((c) => ({ id: c.id, type: c.type, source: c.source, sourceHash: textHash(c.source), executionCount: c.executionCount ?? null, running: !!c.running, outputsHash: previous.get(c.id) ?? null }));
    this.pruneCellState();
  }

  /** The browser has every edit: nothing is left to save. Called once per poll, when the queue is idle. */
  private async saved(): Promise<void> {
    if (this.detached || this.awayTimer || this.document.isClosed) return;
    if (this.document.isDirty && !this.busy() && this.pending === 0) await this.document.save();
  }

  // ---------------------------------------------------------------- runs

  async run(cells: vscode.NotebookCell[]): Promise<void> {
    if (this.detached) return;
    if (this.structure !== undefined) {
      clearTimeout(this.structure);
      this.structure = undefined;
      this.structurePush = this.enqueue(() => this.pushStructure());
    }
    try {
      await this.structurePush;
    } catch (e) {
      return this.failed(e);
    }
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      try {
        await this.flush(cell);
      } catch (e) {
        return this.failed(e);
      }
      const id = idOf(cell);
      if (!id) continue;
      // The cell's text lost a compare-and-set: running would execute the browser's
      // text, not what the editor shows. The user was told; a new edit sends it again.
      if (this.conflicted.has(id)) return;
      this.started(cell, id, true);
      this.runsInFlight++;
      this.runsStarted++;
      try {
        const { results } = await this.op({ op: "run_cells", cellIds: [id], timeoutMs: RUN_WAIT_MS, stopOnError: true }) as { results: { status: string; executionCount?: number | null; outputs: CellInfo["outputs"] }[] };
        const result = results[0];
        // Still running: polling sees it finish.
        if (result && result.status !== "timeout") this.finished(cell, id, result.executionCount ?? null, result.outputs ?? [], result.status !== "error");
        else if (result) {
          this.showLive(id, result.outputs ?? []);
          this.liveShownAt.set(id, Date.now());
        }
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
    this.liveShownAt.delete(id);
    if (executionCount) execution.executionOrder = executionCount;
    void execution.replaceOutput(editorOutputs(outputs));
    execution.end(success, timed ? Date.now() : undefined);
    return true;
  }

  /** What a running cell has printed so far, shown as it comes. */
  private showLive(id: string, outputs: CellInfo["outputs"]): void {
    void this.executions.get(id)?.replaceOutput(editorOutputs(outputs));
  }

  /** A running cell printing a lot of text is shown live at most every LIVE_THROTTLE_MS; small outputs follow every poll. */
  private throttledLive(id: string, outputs: CellInfo["outputs"]): boolean {
    const last = this.liveShownAt.get(id);
    if (last === undefined) return false; // never shown: the first live output always goes out
    const textLength = (outputs ?? []).reduce((n, o) => n + (o.text?.length ?? 0), 0);
    if (textLength <= LIVE_THROTTLE_TEXT) return false;
    return Date.now() - last < LIVE_THROTTLE_MS;
  }

  /** Stop showing a cell's run (it left the notebook, or its cell object is being replaced). */
  private endExecution(id: string): void {
    const execution = this.executions.get(id);
    if (execution) {
      execution.end(undefined);
      this.executions.delete(id);
    }
    this.liveShownAt.delete(id);
  }

  // ---------------------------------------------------------------- browser -> VS Code

  private async poll(): Promise<void> {
    if (this.polling || this.detached || this.awayTimer || this.document.isClosed) return;
    this.polling = true;
    try {
      const version = this.editVersion;
      const runs = this.runsStarted;
      const current = () => version === this.editVersion && !this.busy() && !this.awayTimer && !this.detached && !this.document.isClosed && !this.runsInFlight && runs === this.runsStarted;
      // Digests only: a hash of each source and a fingerprint of its outputs.
      // No source, no outputs and no image crosses the wire for an unchanged cell.
      const { cells: remote } = await this.op({ op: "get_cells", sourceHash: true, outputsHash: true }) as { cells: CellInfo[] };
      // Read before a run started here reached the browser: it would end that run's spinner.
      if (current()) await this.enqueue(async () => {
        if (current()) await this.pull(remote, current);
      });
    } catch {
      // Not reachable now (bridge or tab away for a moment): try again on the next tick.
    } finally {
      this.polling = false;
    }
    // One save per cycle, once every push has landed — not after each flush.
    await this.saved().catch(() => {});
  }

  private async pull(remote: CellInfo[], current: () => boolean): Promise<void> {
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
      await this.rebuild(current);
      return;
    }
    this.structurePush = Promise.resolve(); // The cell order agrees again after a failed push.
    if (action === "diff") {
      const steps = planPull(knownOrder, remoteOrder);
      // Most of the notebook changed, or its ids cannot be matched: rebuild instead.
      if (!steps) {
        await this.rebuild(current);
        return;
      }
      await this.applyStructure(steps, remote, current);
    }
    if (current()) await this.syncCells(remote);
  }

  /**
   * Cells were added, removed or moved in the browser: edit only what changed.
   * A cell that stays put keeps its cell object, its metadata and its running
   * execution; a moved or new cell that is running gets a fresh spinner.
   */
  private async applyStructure(steps: PullStep[], remote: CellInfo[], current: () => boolean): Promise<void> {
    // New cells (added, or retyped) are inserted with their real text and outputs: read just those.
    const newIds = steps.flatMap((s) => (s.op === "insert" ? [s.id] : []));
    const fetched = new Map<string, CellInfo>();
    if (newIds.length) {
      const { cells } = await this.op({ op: "get_cells", cellIds: newIds, includeOutputs: true, outputsHash: true }) as { cells: CellInfo[] };
      for (const c of cells) fetched.set(c.id, c);
      // One vanished again: the next poll plans from what is there then.
      if (newIds.some((id) => !fetched.has(id))) return;
    }
    if (!current()) return;
    const remoteById = new Map(remote.map((c) => [c.id, c]));
    const previous = new Map(this.known.map((k) => [k.id, k]));
    for (const step of steps) {
      if (step.op === "insert") {
        const edit = new vscode.WorkspaceEdit();
        edit.set(this.document.uri, [vscode.NotebookEdit.insertCells(step.index, [cellData(fetched.get(step.id)!, this.language)])]);
        if (!(await vscode.workspace.applyEdit(edit))) return;
      } else {
        const cell = this.document.getCells().find((c) => idOf(c) === step.id);
        if (!cell || cell.index < 0) return;
        // The cell object goes away: its run ends here; one still running gets a new spinner below.
        this.endExecution(step.id);
        const edit = new vscode.WorkspaceEdit();
        edit.set(this.document.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1))]);
        if (!(await vscode.workspace.applyEdit(edit))) return;
        if (step.op === "move") {
          // NotebookEdit has no move: splice the one cell out and back in, carrying
          // its text (even an unsent edit), its outputs and its browser id.
          const data = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
          data.metadata = { ...cell.metadata };
          data.outputs = [...cell.outputs];
          data.executionSummary = cell.executionSummary;
          const insert = new vscode.WorkspaceEdit();
          insert.set(this.document.uri, [vscode.NotebookEdit.insertCells(step.index, [data])]);
          if (!(await vscode.workspace.applyEdit(insert))) return;
        }
      }
      if (step.op !== "delete" && remoteById.get(step.id)?.running) {
        const cell = this.document.getCells().find((c) => idOf(c) === step.id);
        if (cell) this.started(cell, step.id);
      }
    }
    // What the browser holds, in its order: kept cells carry what we already know
    // (the digest sync fetches whatever changed); new cells come from the read above.
    this.known = remote.map((r) => {
      const kept = previous.get(r.id);
      if (kept && kept.type === r.type) return kept;
      const full = fetched.get(r.id);
      return full
        ? { id: r.id, type: r.type, source: full.source, sourceHash: textHash(full.source), executionCount: full.executionCount ?? null, running: !!full.running, outputsHash: full.outputsHash ?? null }
        : { id: r.id, type: r.type, source: "", sourceHash: textHash(""), executionCount: r.executionCount ?? null, running: !!r.running, outputsHash: null };
    });
    this.pruneCellState();
  }

  /** Same cells in both: fetch only what the digests say changed, and follow runs. */
  private async syncCells(remote: CellInfo[]): Promise<void> {
    const local = this.document.getCells();
    const sourceOnly: { cell: vscode.NotebookCell; known: Known; remote: CellInfo }[] = [];
    const withOutputs: { cell: vscode.NotebookCell; known: Known; remote: CellInfo }[] = [];
    for (const [i, r] of remote.entries()) {
      const known = this.known[i];
      const cell = local[i];
      if (!known || !cell || known.id !== r.id) continue;
      const running = !!r.running;
      const count = r.executionCount ?? null;
      // Also after a structural edit, which ends the runs it replaces: one still running gets its spinner back.
      if (running) this.started(cell, r.id);
      const ended = !running && this.executions.has(r.id);
      const outputsChanged = r.outputsHash !== undefined && r.outputsHash !== known.outputsHash;
      const countChanged = !running && count !== known.executionCount;
      known.running = running;
      // Compared on what the browser answers, not on run events: whatever the
      // page says about runs, a changed output is read and shown.
      if (ended || outputsChanged || countChanged) withOutputs.push({ cell, known, remote: r });
      else {
        known.executionCount = count;
        if (r.sourceHash !== known.sourceHash) sourceOnly.push({ cell, known, remote: r });
      }
    }
    if (sourceOnly.length) {
      // Only the text changed: read it without the outputs.
      const { cells } = await this.op({ op: "get_cells", cellIds: sourceOnly.map((c) => c.remote.id) }) as { cells: CellInfo[] };
      const read = new Map(cells.map((c) => [c.id, c]));
      const edit = new vscode.WorkspaceEdit();
      let edits = 0;
      for (const { cell, known, remote: r } of sourceOnly) {
        const now = read.get(r.id);
        if (!now || cell.index < 0) continue;
        const base = known.source;
        // Changed in the browser (by the agent or in the page), not being edited here.
        if (now.source !== base && cell.document.getText() === base) {
          edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), now.source);
          edits++;
        }
        // The browser's text is what we know from now on, even while the user edits
        // this cell: its push compares against the base the edit started from.
        known.source = now.source;
        known.sourceHash = textHash(now.source);
      }
      if (edits) await vscode.workspace.applyEdit(edit);
    }
    if (!withOutputs.length) return;
    const { cells } = await this.op({ op: "get_cells", cellIds: withOutputs.map((c) => c.remote.id), includeOutputs: true, outputsHash: true }) as { cells: CellInfo[] };
    const read = new Map(cells.map((c) => [c.id, c]));
    const edit = new vscode.WorkspaceEdit();
    let edits = 0;
    for (const { cell, known, remote: r } of withOutputs) {
      const now = read.get(r.id);
      if (!now || cell.index < 0) continue;
      const base = known.source;
      if (now.source !== base && cell.document.getText() === base) {
        edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), now.source);
        edits++;
      }
      known.source = now.source;
      known.sourceHash = textHash(now.source);
      const outputs = now.outputs ?? [];
      const count = now.executionCount ?? null;
      if (now.running) {
        // Shown as running nowhere (another kernel selected): try again on the next tick.
        if (!this.executions.has(r.id)) continue;
        // A large live output is shown at most every 2 s; the hash still advances,
        // and the finished run always shows everything.
        if (!this.throttledLive(r.id, outputs)) {
          this.showLive(r.id, outputs);
          this.liveShownAt.set(r.id, Date.now());
        }
      } else if (!this.finished(cell, r.id, count, outputs, count === null ? undefined : !outputs.some((o) => o.kind === "error"))) {
        continue;
      }
      known.outputsHash = now.outputsHash ?? null;
      if (!now.running) known.executionCount = count;
    }
    if (edits) await vscode.workspace.applyEdit(edit);
  }

  /** Most of the notebook changed, or the mirror lost track of it: read the whole notebook again. */
  private async rebuild(current: () => boolean): Promise<void> {
    const { cells } = await this.op({ op: "get_cells", includeOutputs: true, outputsHash: true }) as { cells: CellInfo[] };
    if (!current()) return;
    // An edit that lost its compare-and-set stays in the editor, as the user was told.
    const keptText = new Map<string, string>();
    for (const cell of this.document.getCells()) {
      const id = idOf(cell);
      if (id && this.conflicted.has(id)) keptText.set(id, cell.document.getText());
    }
    for (const execution of this.executions.values()) execution.end(undefined);
    this.executions.clear();
    this.liveShownAt.clear();
    this.editBase.clear();
    const ids = new Set(cells.map((c) => c.id));
    for (const id of [...this.conflicted]) if (!ids.has(id)) this.conflicted.delete(id);
    this.known = cells.map((c) => ({ id: c.id, type: c.type, source: c.source, sourceHash: textHash(c.source), executionCount: c.executionCount ?? null, running: !!c.running, outputsHash: c.outputsHash ?? null }));
    const edit = new vscode.WorkspaceEdit();
    edit.set(this.document.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, this.document.cellCount), cells.map((c) => {
      const data = cellData(c, this.language);
      const text = keptText.get(c.id);
      if (text !== undefined) data.value = text;
      return data;
    }))]);
    if (await vscode.workspace.applyEdit(edit)) this.structurePush = Promise.resolve();
  }

  private failed(e: unknown): void {
    void vscode.window.showErrorMessage(`Agent in Notebook: the notebook in Chrome did not take the change: ${(e as Error).message}`);
  }
}
