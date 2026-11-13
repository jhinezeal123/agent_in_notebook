// The right side bar's Code and Artifacts: a folder of the current project
// (its repository, its artifacts folder; on this computer, where OpenResearch
// runs) as VS Code's Explorer shows a folder. Files open in VS Code's own
// editors; the tree follows the disk as runs and agents write to it.

import { basename, relative, sep } from "node:path";
import * as vscode from "vscode";
import { CHANGE_SCHEME, changeItem, changeUri, openChange, toFile, type ChangeSet, type ChangedFile } from "./changes.js";
import type { OrxProject, Studio } from "./studio-host.js";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** What the empty tree says (the view's welcome text keys off it). */
type State = "off" | "none" | "ready";
/** Why the Changes list is as it is (context key `<id>.changes`, for its welcome text). */
type ChangesState = "noChat" | "pending" | "clean" | "some" | "error";

/** Which folder a tree shows, and what its header says about it. */
export interface Place {
  path: string;
  description?: string;
  /** Another folder is expected soon (a chat's worktree, made on its first turn): look again. */
  pending?: boolean;
  /** The research chat whose worktree this is. */
  sessionId?: string;
}

/** One of the project's folders, shown as a tree. */
export interface FolderSpec {
  /** The tree view's id; its commands are `<id>.<action>` and its state is the context key `<id>.state`. */
  view: string;
  locate(project: OrxProject, studio: Studio): Promise<Place | null>;
  /** Also look again when the chat panel shows another chat. */
  followsChat?: boolean;
  /** Can show what a chat changed in its worktree instead of the files (context key `<id>.mode`). */
  changes?: boolean;
}

/**
 * The code the research chat in front works on: its own worktree (made on
 * its first turn, on its experiment branch); else, and with no research chat
 * of this project in front, the project's repository.
 */
export const CODE: FolderSpec = {
  view: "ainb.code",
  followsChat: true,
  changes: true,
  async locate(project, studio) {
    const chat = studio.researchChatOf(project.id);
    const checkout = await studio.codeCheckout(project.id, chat).catch(() => null);
    if (!checkout) return { path: project.repoPath, description: "project repository" };
    const worktree = checkout.root === "worktree";
    return {
      path: checkout.path,
      description: `${checkout.branch ?? "detached"} · ${worktree ? "this chat's worktree" : "project repository"}`,
      pending: !!chat && !worktree,
      ...(worktree && chat ? { sessionId: chat } : {}),
    };
  },
};

/** Files the project's agents save outside the repository: reports, figures, results. */
export const ARTIFACTS: FolderSpec = {
  view: "ainb.artifacts",
  locate: async (project) => (project.artifactsDir ? { path: project.artifactsDir } : null),
};

/** How long to wait before looking again for a folder that is on its way. */
const PENDING_MS = 4000;

export class FolderTree implements vscode.TreeDataProvider<vscode.Uri>, vscode.TreeDragAndDropController<vscode.Uri>, vscode.Disposable {
  readonly dragMimeTypes: string[];
  readonly dropMimeTypes: string[];
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
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private loading = 0;
  private place: Place | null = null;
  /** Files, or (a tree with `changes`) what the chat changed. */
  private mode: "files" | "changes" = "files";
  private changeSet: ChangeSet | null = null;
  /** The change behind each entry listed. */
  private readonly changeFiles = new Map<string, ChangedFile>();
  private changesTicket = 0;
  private changesTimer?: ReturnType<typeof setTimeout>;
  private readonly subscriptionsExtra: vscode.Disposable[] = [];

  private readonly moveMime: string;

  constructor(private readonly studio: Studio, private readonly spec: FolderSpec) {
    this.moveMime = `application/vnd.code.tree.${spec.view}`;
    this.dragMimeTypes = ["text/uri-list", this.moveMime];
    this.dropMimeTypes = [this.moveMime];
    this.view = vscode.window.createTreeView(spec.view, { treeDataProvider: this, dragAndDropController: this, showCollapseAll: true, canSelectMany: true });
    // A change entry stands for its file: commands act on the file.
    const command = (id: string, fn: (uri?: vscode.Uri, uris?: vscode.Uri[]) => unknown, raw = false) =>
      vscode.commands.registerCommand(`${spec.view}.${id}`, (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
        Promise.resolve(raw ? fn(uri, uris) : fn(uri && toFile(uri), uris?.map(toFile))).catch((e: Error) => void vscode.window.showErrorMessage(e.message)));
    if (spec.changes) {
      this.setContext("mode", "files");
      this.subscriptionsExtra.push(
        command("showChanges", () => this.setMode("changes")),
        command("showFiles", () => this.setMode("files")),
        command("openChange", (uri) => {
          const file = uri && this.changeFiles.get(uri.toString());
          return file && this.changeSet ? openChange(this.changeSet, file) : undefined;
        }, true),
        command("openFile", (uri) => uri && vscode.commands.executeCommand("vscode.open", uri)),
      );
    }
    this.subscriptions = [
      this.view,
      this.changed,
      studio.onDidChangeProject(() => void this.load()),
      studio.onDidChangeChat(() => { if (spec.followsChat) void this.load(); }),
      studio.onDidChangeResearchStatus((s) => { if (s.state === "ready" || this.root) void this.load(); }),
      this.view.onDidChangeVisibility((e) => { if (e.visible) void this.load(); }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("files.exclude")) this.changed.fire(); }),
      command("refresh", () => this.load(true)),
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

  /** Follow the current project (and chat): its folder, watched. `force`: list it again even if it is the same folder. */
  private async load(force = false): Promise<void> {
    const ticket = ++this.loading;
    clearTimeout(this.pendingTimer);
    let project: OrxProject | null = null;
    let place: Place | null = null;
    let state: State = "off";
    try {
      project = await this.studio.currentProject();
      if (this.studio.researchStatus().state === "ready") state = project ? "ready" : "none";
      if (project) place = await this.spec.locate(project, this.studio);
    } catch {
      // OpenResearch went away: show nothing until it is back
    }
    if (ticket !== this.loading) return;
    this.project = project;
    this.place = place;
    this.setContext("state", state);
    this.describe();
    const root = place ? vscode.Uri.file(place.path) : null;
    const moved = root?.toString() !== this.root?.toString();
    if (moved) {
      this.root = root;
      this.dirs.clear();
      this.watch();
    }
    if (this.mode === "changes") void this.loadChanges();
    else if (moved || force) this.changed.fire();
    // Look again while it is on its way, as long as someone is looking at the tree.
    if (place?.pending) this.pendingTimer = setTimeout(() => { if (this.view.visible) void this.load(); }, PENDING_MS);
  }

  private setContext(key: string, value: unknown): void {
    void vscode.commands.executeCommand("setContext", `${this.spec.view}.${key}`, value);
  }

  /** The header: which folder (branch, whose), or in Changes how many and against what. */
  private describe(): void {
    const set = this.mode === "changes" ? this.changeSet : null;
    this.view.description = set
      ? `${set.files.length} changed · ${set.branch ?? "detached"} vs ${set.baselineBranch}`
      : this.place?.description ?? this.project?.name;
  }

  // ------------------------------------------------------------ changes

  private setMode(mode: "files" | "changes"): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.setContext("mode", mode);
    this.changeSet = null;
    this.view.badge = undefined;
    this.describe();
    if (mode === "changes") void this.loadChanges();
    else this.changed.fire();
  }

  /** What the chat changed in its worktree, against where it branched off the baseline. */
  private async loadChanges(): Promise<void> {
    const ticket = ++this.changesTicket;
    const place = this.place;
    let set: ChangeSet | null = null;
    let state: ChangesState;
    if (!place?.sessionId) {
      state = place?.pending ? "pending" : "noChat";
    } else {
      try {
        const found = await this.studio.worktreeChanges(place.sessionId);
        set = found && { ...found, root: place.path };
        state = !set ? "pending" : set.files.length ? "some" : "clean";
      } catch {
        state = "error";
      }
    }
    if (ticket !== this.changesTicket || this.mode !== "changes") return;
    this.changeSet = set;
    this.changeFiles.clear();
    this.setContext("changes", state);
    this.view.badge = set?.files.length ? { value: set.files.length, tooltip: `${set.files.length} changed in this chat's worktree` } : undefined;
    this.describe();
    this.changed.fire();
  }

  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!this.root) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, "**/*"));
    // git's own bookkeeping changes all the time and is not shown.
    const ours = (uri: vscode.Uri) => !uri.fsPath.includes(`${sep}.git${sep}`);
    const soon = (uri: vscode.Uri) => {
      if (!ours(uri)) return;
      if (this.mode === "changes") { this.changesSoon(); return; }
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.changed.fire(), 200);
    };
    watcher.onDidCreate(soon);
    watcher.onDidDelete(soon);
    // An edited file changes the Changes list, not the files.
    watcher.onDidChange((uri) => { if (ours(uri) && this.mode === "changes") this.changesSoon(); });
    this.watcher = watcher;
  }

  private changesSoon(): void {
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.loadChanges(), 600);
  }

  // ------------------------------------------------------------ the tree

  async getChildren(element?: vscode.Uri): Promise<vscode.Uri[]> {
    if (this.mode === "changes") {
      // A flat list, as Source Control shows changes.
      const set = this.changeSet;
      if (element || !set) return [];
      return [...set.files].sort((a, b) => collator.compare(a.path, b.path)).map((file) => {
        const uri = changeUri(set, file);
        this.changeFiles.set(uri.toString(), file);
        return uri;
      });
    }
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
    const change = uri.scheme === CHANGE_SCHEME ? this.changeFiles.get(uri.toString()) : undefined;
    if (change) return changeItem(uri, change, `${this.spec.view}.openChange`);
    const dir = this.isDir(uri);
    const item = new vscode.TreeItem(uri, dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString();
    // The file icon theme's icon for this name, as in the Explorer.
    item.iconPath = dir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    item.tooltip = uri.fsPath;
    item.contextValue = dir ? "projectFolder" : "projectFile";
    if (!dir) item.command = { command: "vscode.open", title: "Open", arguments: [uri] };
    return item;
  }

  getParent(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme === CHANGE_SCHEME) return undefined;
    const parent = vscode.Uri.joinPath(uri, "..");
    return this.root && this.inside(parent) && !same(parent, this.root) ? parent : undefined;
  }

  // ------------------------------------------------------------ drag and drop

  handleDrag(uris: readonly vscode.Uri[], data: vscode.DataTransfer): void {
    // Out of the tree (into an editor, a chat) as files; inside it, to move them (not from Changes).
    data.set("text/uri-list", new vscode.DataTransferItem(uris.map((u) => toFile(u).toString()).join("\r\n")));
    if (this.mode === "files") data.set(this.moveMime, new vscode.DataTransferItem(uris));
  }

  async handleDrop(target: vscode.Uri | undefined, data: vscode.DataTransfer): Promise<void> {
    if (this.mode !== "files") return;
    const moving = data.get(this.moveMime)?.value as vscode.Uri[] | undefined;
    const into = target ? (this.isDir(target) ? target : this.getParent(target) ?? this.root) : this.root;
    if (!moving?.length || !into) return;
    for (const uri of moving) {
      const to = vscode.Uri.joinPath(into, basename(uri.fsPath));
      // Not onto itself, not into its own folder again, not into itself.
      if (same(to, uri) || same(into, uri) || into.fsPath.toLowerCase().startsWith(`${uri.fsPath.toLowerCase()}${sep}`)) continue;
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
    clearTimeout(this.pendingTimer);
    clearTimeout(this.changesTimer);
    this.watcher?.dispose();
    for (const s of [...this.subscriptions, ...this.subscriptionsExtra]) s.dispose();
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
