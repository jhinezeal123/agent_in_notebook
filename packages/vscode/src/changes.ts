// Changes of a research chat's worktree, as OpenResearch's Files › Changes has
// them (the worktree against the merge-base with the baseline branch,
// untracked files included), drawn the way VS Code's Source Control does:
// a flat list with the git letter and color, and a click opens VS Code's diff.

import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";

export type ChangedStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  /** Repo-relative, `/`-separated. */
  path: string;
  status: ChangedStatus;
  /** Before a rename. */
  oldPath?: string;
}

/** A chat's worktree and what changed in it (OpenResearch's session worktree, without the diff text). */
export interface ChangeSet {
  root: string;
  branch: string | null;
  baselineBranch: string;
  baseSha: string;
  files: ChangedFile[];
}

/** Tree entries for changed files: the file's path in this scheme, its status in the query. */
export const CHANGE_SCHEME = "ainb-change";
/** A file as it was at the base commit: `ainb-base:/<path>?<root and sha>`. */
const BASE_SCHEME = "ainb-base";

const LETTER: Record<ChangedStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };
const LABEL: Record<ChangedStatus, string> = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", untracked: "Untracked" };
const COLOR: Record<ChangedStatus, string> = {
  added: "gitDecoration.addedResourceForeground",
  modified: "gitDecoration.modifiedResourceForeground",
  deleted: "gitDecoration.deletedResourceForeground",
  renamed: "gitDecoration.renamedResourceForeground",
  untracked: "gitDecoration.untrackedResourceForeground",
};

const isStatus = (s: string): s is ChangedStatus => s in LETTER;

export function changeUri(set: ChangeSet, file: ChangedFile): vscode.Uri {
  return vscode.Uri.file(join(set.root, file.path)).with({ scheme: CHANGE_SCHEME, query: file.status });
}

/** The real file behind a tree entry (a change entry, or already a file). */
export function toFile(uri: vscode.Uri): vscode.Uri {
  return uri.scheme === CHANGE_SCHEME ? uri.with({ scheme: "file", query: "" }) : uri;
}

export function changeItem(uri: vscode.Uri, file: ChangedFile, command: string): vscode.TreeItem {
  const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
  item.id = `change:${file.path}`;
  item.iconPath = vscode.ThemeIcon.File;
  const dir = dirname(file.path);
  // As Source Control lists them: the name, then its folder (and where a renamed file came from).
  item.description = [dir !== "." ? dir : "", file.oldPath ? `← ${file.oldPath}` : ""].filter(Boolean).join("  ");
  item.tooltip = `${file.path} · ${LABEL[file.status]}`;
  item.contextValue = file.status === "deleted" ? "changeDeleted" : "change";
  item.command = { command, title: "Open Changes", arguments: [uri] };
  return item;
}

/** Open a change: the diff against the base commit; an added file as it is; a deleted one as it was. */
export async function openChange(set: ChangeSet, file: ChangedFile): Promise<void> {
  const current = vscode.Uri.file(join(set.root, file.path));
  const name = basename(file.path);
  if (file.status === "added" || file.status === "untracked") {
    await vscode.commands.executeCommand("vscode.open", current);
  } else if (file.status === "deleted") {
    await vscode.commands.executeCommand("vscode.open", baseUri(set, file.path), { preview: true }, `${name} (deleted, as on ${set.baselineBranch})`);
  } else {
    await vscode.commands.executeCommand("vscode.diff", baseUri(set, file.oldPath ?? file.path), current, `${name} (${set.baselineBranch} ↔ chat worktree)`);
  }
}

function baseUri(set: ChangeSet, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${path}`, query: JSON.stringify({ root: set.root, sha: set.baseSha }) });
}

function gitOut(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  });
}

const NAME_STATUS: Record<string, ChangedStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", C: "added" };

/**
 * What a notebook chat changed in its worktree, read with git here: against
 * the commit its branch started from (the bridge wrote it to the worktree's
 * git folder, `ainb-base`), untracked files included. Null: not a worktree
 * the bridge made.
 */
export async function localChanges(root: string): Promise<Omit<ChangeSet, "root"> | null> {
  const baseFile = await gitOut(root, ["rev-parse", "--path-format=absolute", "--git-path", "ainb-base"]).catch(() => "");
  if (!baseFile) return null;
  let base: string;
  try {
    base = (await vscode.workspace.fs.readFile(vscode.Uri.file(baseFile))).toString().trim();
  } catch {
    return null;
  }
  const [baseSha, baselineBranch] = base.split(/\s+/);
  if (!baseSha) return null;
  const [branch, diff, untracked] = await Promise.all([
    gitOut(root, ["branch", "--show-current"]).catch(() => ""),
    gitOut(root, ["diff", "--name-status", "-M", baseSha]),
    gitOut(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const files: ChangedFile[] = [];
  for (const line of diff.split("\n").filter(Boolean)) {
    const [code, a, b] = line.split("\t");
    const status = NAME_STATUS[code![0]!] ?? "modified";
    files.push(status === "renamed" && b ? { path: b, status, oldPath: a } : { path: a!, status });
  }
  for (const path of untracked.split("\n").filter(Boolean)) files.push({ path, status: "untracked" });
  return { branch: branch || null, baselineBranch: baselineBranch || baseSha.slice(0, 7), baseSha, files };
}

/** Read-only documents of files at the base commit, and the git letters on change entries. */
export function registerChangeProviders(): vscode.Disposable {
  const base: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri) {
      const { root, sha } = JSON.parse(uri.query) as { root: string; sha: string };
      const path = uri.path.replace(/^\//, "");
      return new Promise((resolve, reject) => {
        // cat-file, not show: show first stats the argument as a path, which fails on long Windows paths.
        execFile("git", ["-C", root, "cat-file", "-p", `${sha}:${path}`],{ encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) reject(new Error(`Could not read ${path} at ${sha.slice(0, 7)}: ${error.message}`));
          else resolve(stdout.toString("utf8"));
        });
      });
    },
  };
  const decorations: vscode.FileDecorationProvider = {
    provideFileDecoration(uri) {
      if (uri.scheme !== CHANGE_SCHEME || !isStatus(uri.query)) return undefined;
      return new vscode.FileDecoration(LETTER[uri.query], LABEL[uri.query], new vscode.ThemeColor(COLOR[uri.query]));
    },
  };
  return vscode.Disposable.from(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, base),
    vscode.window.registerFileDecorationProvider(decorations),
  );
}
