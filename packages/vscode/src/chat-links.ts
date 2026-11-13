import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { chatFileLink, externalChatUrl } from "../../extension/src/shared/chat-links.js";

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function openChatLink(target: string, notebook?: vscode.Uri): Promise<boolean> {
  const url = externalChatUrl(target);
  if (url) return vscode.env.openExternal(vscode.Uri.parse(url));
  const file = chatFileLink(target);
  if (!file) return false;

  const folders = (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === "file");
  const notebookDir = notebook?.scheme === "file" ? dirname(notebook.fsPath) : undefined;
  const workspaceDir = notebook && vscode.workspace.getWorkspaceFolder(notebook)?.uri.fsPath;
  const allowed = folders.length ? folders.map(({ uri }) => uri.fsPath) : notebookDir ? [notebookDir] : [];
  const bases = [...new Set([notebookDir, workspaceDir, ...allowed].filter((path): path is string => !!path))];
  const candidates = isAbsolute(file.path) ? [file.path] : bases.map((base) => resolve(base, file.path));
  const roots = (await Promise.all(allowed.map((root) => realpath(root).catch(() => undefined)))).filter((root) => root !== undefined);
  for (const candidate of candidates) {
    if (!allowed.some((root) => contains(root, candidate))) continue;
    const path = await realpath(candidate).catch(() => undefined);
    if (!path || !roots.some((root) => contains(root, path)) || !(await stat(path).catch(() => undefined))?.isFile()) continue;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      const point = file.line === undefined ? undefined : document.validatePosition(new vscode.Position(file.line - 1, (file.column ?? 1) - 1));
      await vscode.window.showTextDocument(document, { selection: point && new vscode.Range(point, point) });
      return true;
    } catch { /* Try the next workspace-relative candidate. */ }
  }
  void vscode.window.showWarningMessage(`Agent in Notebook could not open a local file for ${file.path}.`);
  return false;
}
