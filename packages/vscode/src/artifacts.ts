// The right side bar's Artifacts: the current project's artifacts folder (on
// this computer: OpenResearch runs here) as VS Code's Explorer shows a folder.
// Files open in VS Code's own editors; the tree follows the disk as runs and
// agents write to it.

import { basename, relative } from "node:path";
import * as vscode from "vscode";
import type { OrxProject, Studio } from "./studio-host.js";

const VIEW = "ainb.artifacts";
const MOVE_MIME = "application/vnd.code.tree.ainb.artifacts";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** What the empty tree says (the view's welcome text keys off it). */
type State = "off" | "none" | "ready";

export class ArtifactsTree implements vscode.TreeDataProvider<vscode.Uri>, vscode.TreeDragAndDropController<vscode.Uri>, vscode.Disposable {
  readonly dragMimeTypes = ["text/uri-list", MOVE_MIME];
  readonly dropMimeTypes = [MOVE_MIME];
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<vscode.Uri>;
  private readonly subscriptions: vscode.Disposable[];
  private project: OrxProject | null = null;
  private root: vscode.Uri | null = null;
  /** Folder or file, for each entry listed. */
  private readonly dirs = new Map<string, boolean>();
  private watcher?: vscode.FileSystemWatcher;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private loading = 0;

  constructor(private readonly studio: Studio) {
    this.view = vscode.window.createTreeView(VIEW, { treeDataProvider: this, dragAndDropController: this, showCollapseAll: true, canSelectMany: true });
    const command = (id: string, fn: (uri?: vscode.Uri, uris?: vscode.Uri[]) => unknown) =>
      vscode.commands.registerCommand(`ainb.artifacts.${id}`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => Promise.resolve(fn(uri, uris)).catch((e: Error) => void vscode.window.showErrorMessage(e.message)));
    this.subscriptions = [
      this.view,
      this.changed,
      studio.onDidChangeProject(() => void this.load()),
      studio.onDidChangeResearchStatus((s) => { if (s.state === "ready" || this.root) void this.load(); }),
      this.view.onDidChangeVisibility((e) => { if (e.visible) void this.load(); }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("files.exclude")) this.changed.fire(); }),
      command("refresh", () => this.load()),
      command("newFile", () => this.create(false)),
      command("newFolder", () => this.create(true)),
      command("revealFolder", () => this.root && vscode.commands.executeCommand("revealFileInOS", this.root)),
      command("openToSide", (uri) => uri && vscode.commands.executeCommand("vscode.open", uri, { viewColumn: vscode.ViewColumn.Beside, preview: false })),
      command("revealInOS", (uri) => vscode.commands.executeCommand("revealFileInOS", uri ?? this.root)),
      command("openInTerminal", (uri) => { const dir = uri ?? this.root; if (dir) vscode.window.createTerminal({ cwd: this.isDir(dir) ? dir : vscode.Uri.joinPath(dir, "..") }).show(); }),
      command("copyPath", (uri, uris) => vscode.env.clipboard.writeText(this.targets(uri, uris).map((u) => u.fsPath).join("\n"))),
      command("copyRelativePath", (uri, uris) => vscode.env.clipboard.writeText(this.targets(uri, uris).map((u) => this.relative(u)).join("\n"))),
      command("rename", (uri) => this.rename(uri ?? this.view.selection[0])),
      command("delete", (uri, uris) => this.remove(this.targets(uri, uris))),
    ];
    void this.load();
  }

  // ------------------------------------------------------------ which folder

  /** Follow the current project: its artifacts folder, watched. */
  private async load(): Promise<void> {
    const ticket = ++this.loading;
    let project: OrxProject | null = null;
    let state: State = "off";
    try {
      project = await this.studio.currentProject();
      if (this.studio.researchStatus().state === "ready") state = project ? "ready" : "none";
    } catch {
      // OpenResearch went away: show nothing until it is back
    }
    if (ticket !== this.loading) return;
    this.project = project;
    void vscode.commands.executeCommand("setContext", "ainb.artifacts.state", state);
    this.view.description = project?.name;
    const root = project?.artifactsDir ? vscode.Uri.file(project.artifactsDir) : null;
    if (root?.toString() !== this.root?.toString()) {
      this.root = root;
      this.dirs.clear();
      this.watch();
    }
    this.changed.fire();
  }

  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!this.root) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, "**/*"));
    const soon = () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.changed.fire(), 200);
    };
    watcher.onDidCreate(soon);
    watcher.onDidDelete(soon);
    this.watcher = watcher;
  }

  // ------------------------------------------------------------ the tree

  async getChildren(element?: vscode.Uri): Promise<vscode.Uri[]> {
    const dir = element ?? this.root;
    if (!dir) return [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return []; // not there yet: the agent has saved nothing
    }
    const hidden = excluded();
    return entries
      .filter(([name]) => !hidden.has(name))
      .map(([name, type]) => ({ name, dir: (type & vscode.FileType.Directory) !== 0 }))
      // As the Explorer sorts by default: folders first, then by name, numbers in order.
      .sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name))
      .map(({ name, dir: isDir }) => {
        const uri = vscode.Uri.joinPath(dir, name);
        this.dirs.set(uri.toString(), isDir);
        return uri;
      });
  }

  getTreeItem(uri: vscode.Uri): vscode.TreeItem {
    const dir = this.isDir(uri);
    const item = new vscode.TreeItem(uri, dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString();
    // The file icon theme's icon for this name, as in the Explorer.
    item.iconPath = dir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    item.tooltip = uri.fsPath;
    item.contextValue = dir ? "artifactFolder" : "artifactFile";
    if (!dir) item.command = { command: "vscode.open", title: "Open", arguments: [uri] };
    return item;
  }

  getParent(uri: vscode.Uri): vscode.Uri | undefined {
    const parent = vscode.Uri.joinPath(uri, "..");
    return this.root && this.inside(parent) && !same(parent, this.root) ? parent : undefined;
  }

  // ------------------------------------------------------------ drag and drop

  handleDrag(uris: readonly vscode.Uri[], data: vscode.DataTransfer): void {
    // Out of the tree (into an editor, a chat) as files; inside it, to move them.
    data.set("text/uri-list", new vscode.DataTransferItem(uris.map((u) => u.toString()).join("\r\n")));
    data.set(MOVE_MIME, new vscode.DataTransferItem(uris));
  }

  async handleDrop(target: vscode.Uri | undefined, data: vscode.DataTransfer): Promise<void> {
    const moving = data.get(MOVE_MIME)?.value as vscode.Uri[] | undefined;
    const into = target ? (this.isDir(target) ? target : this.getParent(target) ?? this.root) : this.root;
    if (!moving?.length || !into) return;
    for (const uri of moving) {
      const to = vscode.Uri.joinPath(into, basename(uri.fsPath));
      // Not onto itself, not into its own folder again, not into itself.
      if (same(to, uri) || same(into, uri) || into.fsPath.toLowerCase().startsWith(`${uri.fsPath.toLowerCase()}${sep()}`)) continue;
      try {
        await vscode.workspace.fs.rename(uri, to, { overwrite: false });
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not move ${basename(uri.fsPath)}: ${(e as Error).message}`);
      }
    }
    this.changed.fire();
  }

  // ------------------------------------------------------------ file actions

  /** A new file or folder in the selected folder (or the selected file's), else at the top. */
  private async create(folder: boolean): Promise<void> {
    if (!this.root) { void vscode.window.showInformationMessage("Open a project first."); return; }
    const at = this.view.selection[0];
    const parent = at ? (this.isDir(at) ? at : this.getParent(at) ?? this.root) : this.root;
    const name = await vscode.window.showInputBox({
      title: folder ? "New Folder" : "New File",
      prompt: `In ${this.relative(parent) || basename(this.root.fsPath)}`,
      validateInput: (v) => nameProblem(v, true),
    });
    if (!name) return;
    const uri = vscode.Uri.joinPath(parent, ...name.trim().split(/[\\/]+/));
    if (await exists(uri)) throw new Error(`${name} already exists.`);
    if (folder) {
      await vscode.workspace.fs.createDirectory(uri);
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    }
    this.changed.fire();
    if (!folder) await vscode.commands.executeCommand("vscode.open", uri);
    this.dirs.set(uri.toString(), folder);
    await this.view.reveal(uri, { select: true, focus: !folder }).then(undefined, () => {});
  }

  private async rename(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) return;
    const name = basename(uri.fsPath);
    const dot = this.isDir(uri) ? -1 : name.lastIndexOf(".");
    const next = await vscode.window.showInputBox({
      title: `Rename ${name}`,
      value: name,
      valueSelection: [0, dot > 0 ? dot : name.length],
      validateInput: (v) => nameProblem(v, false),
    });
    if (!next || next.trim() === name) return;
    await vscode.workspace.fs.rename(uri, vscode.Uri.joinPath(uri, "..", next.trim()), { overwrite: false });
    this.changed.fire();
  }

  private async remove(uris: vscode.Uri[]): Promise<void> {
    if (!uris.length) return;
    const bin = process.platform === "win32" ? "Recycle Bin" : "Trash";
    const what = uris.length === 1 ? `'${basename(uris[0]!.fsPath)}'` : `these ${uris.length} items`;
    const ok = `Move to ${bin}`;
    if (await vscode.window.showWarningMessage(`Move ${what} to the ${bin}?`, { modal: true, detail: "You can restore it from there." }, ok) !== ok) return;
    for (const uri of uris) await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
    this.changed.fire();
  }

  // ------------------------------------------------------------ helpers

  /** What a context-menu command acts on: the selection when the clicked item is in it. */
  private targets(uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined): vscode.Uri[] {
    if (uris?.length) return uris;
    if (uri) return [uri];
    return [...this.view.selection];
  }

  private isDir(uri: vscode.Uri): boolean {
    return (this.root !== null && same(uri, this.root)) || this.dirs.get(uri.toString()) === true;
  }

  private inside(uri: vscode.Uri): boolean {
    if (!this.root) return false;
    const rel = relative(this.root.fsPath, uri.fsPath);
    return !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
  }

  private relative(uri: vscode.Uri): string {
    return this.root ? relative(this.root.fsPath, uri.fsPath) : uri.fsPath;
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}

/** Names the Explorer hides (`files.exclude`): its simple `**\/name` and `name` patterns. */
function excluded(): Set<string> {
  const config = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude") ?? {};
  const out = new Set<string>();
  for (const [glob, on] of Object.entries(config)) {
    const name = on === true ? glob.replace(/^\*\*\//, "") : "";
    if (name && !/[*?{}[\]/]/.test(name)) out.add(name);
  }
  return out;
}

function nameProblem(value: string, nested: boolean): string | undefined {
  const v = value.trim();
  if (!v) return "A name is needed.";
  if (!nested && /[\\/]/.test(v)) return "A name cannot contain / or \\.";
  if (v.split(/[\\/]+/).some((part) => part === "." || part === "..")) return "Not a valid name.";
  if (/[<>:"|?*]/.test(v) && process.platform === "win32") return "A name cannot contain < > : \" | ? *.";
  return undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function same(a: vscode.Uri, b: vscode.Uri): boolean {
  return process.platform === "win32" ? a.fsPath.toLowerCase() === b.fsPath.toLowerCase() : a.fsPath === b.fsPath;
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
