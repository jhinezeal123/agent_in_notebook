// Zoom a notebook's text, code and markdown together. Ctrl+mouse wheel
// (`editor.mouseWheelZoom`) only zooms the code editors: rendered markdown is
// drawn apart and follows `editor.fontSize` (120% of it while
// `notebook.markup.fontSize` is 0), never the wheel zoom. These commands
// change the font sizes themselves, so both follow.

import * as vscode from "vscode";

const MIN = 6;
const MAX = 48;
const DEFAULT_EDITOR_SIZE = 14;

export async function zoomNotebook(step: 1 | -1 | 0): Promise<void> {
  const editor = vscode.workspace.getConfiguration("editor");
  const notebook = vscode.workspace.getConfiguration("notebook");
  const global = vscode.ConfigurationTarget.Global;
  // The wheel zoom sits on top of the font size: start from none.
  await vscode.commands.executeCommand("editor.action.fontZoomReset");
  if (step === 0) {
    await editor.update("fontSize", undefined, global);
    if (notebook.inspect<number>("markup.fontSize")?.globalValue !== undefined) await notebook.update("markup.fontSize", undefined, global);
    return;
  }
  const size = editor.get<number>("fontSize") ?? DEFAULT_EDITOR_SIZE;
  const next = Math.min(MAX, Math.max(MIN, size + step));
  if (next === size) return;
  await editor.update("fontSize", next, global);
  // A markdown size set by hand does not follow the editor's: move it too.
  const markup = notebook.get<number>("markup.fontSize") ?? 0;
  if (markup > 0) await notebook.update("markup.fontSize", Math.min(MAX, Math.max(MIN, markup + step)), global);
}
