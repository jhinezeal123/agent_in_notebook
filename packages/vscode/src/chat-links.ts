import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { chatImageDataUrl, MAX_CHAT_IMAGE_BASE64 } from "@ainb/protocol";
import * as vscode from "vscode";
import { chatFileLink, externalChatUrl } from "../../ui/src/chat-links.js";

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function* workspaceFiles(file: string, notebook?: vscode.Uri): AsyncGenerator<string> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === "file");
  const notebookDir = notebook?.scheme === "file" ? dirname(notebook.fsPath) : undefined;
  const workspaceDir = notebook && vscode.workspace.getWorkspaceFolder(notebook)?.uri.fsPath;
  const allowed = folders.length ? folders.map(({ uri }) => uri.fsPath) : notebookDir ? [notebookDir] : [];
  const bases = [...new Set([notebookDir, workspaceDir, ...allowed].filter((path): path is string => !!path))];
  const candidates = isAbsolute(file) ? [file] : bases.map((base) => resolve(base, file));
  const roots = (await Promise.all(allowed.map((root) => realpath(root).catch(() => undefined)))).filter((root) => root !== undefined);
  for (const candidate of candidates) {
    if (!allowed.some((root) => contains(root, candidate))) continue;
    const path = await realpath(candidate).catch(() => undefined);
    if (!path || !roots.some((root) => contains(root, path)) || !(await stat(path).catch(() => undefined))?.isFile()) continue;
    yield path;
  }
}

export async function openChatLink(target: string, notebook?: vscode.Uri): Promise<boolean> {
  const url = externalChatUrl(target);
  if (url) return vscode.env.openExternal(vscode.Uri.parse(url));
  const file = chatFileLink(target);
  if (!file) return false;

  for await (const path of workspaceFiles(file.path, notebook)) {
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

const maxImageBytes = MAX_CHAT_IMAGE_BASE64 / 4 * 3;

function rasterMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const gif = bytes.toString("ascii", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}

export async function readChatImage(target: string, notebook?: vscode.Uri): Promise<string | undefined> {
  const file = chatFileLink(target);
  if (!file || file.line !== undefined || !/\.(?:png|jpe?g|gif|webp)$/i.test(file.path)) return;
  for await (const path of workspaceFiles(file.path, notebook)) {
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const { size } = await handle.stat();
      if (size <= 0 || size > maxImageBytes) continue;
      const bytes = Buffer.alloc(size);
      // Read at most the initial size even if the file grows concurrently.
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== size) continue;
      const mime = rasterMime(bytes);
      if (mime) return chatImageDataUrl(mime, bytes.toString("base64"));
    } catch { /* Try the next workspace-relative candidate. */ }
    finally { await handle.close(); }
  }
}
