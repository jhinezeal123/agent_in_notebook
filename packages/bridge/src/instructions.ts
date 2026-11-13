// What the agent is told. The playbook rides the first turn of a session (every
// agent accepts plain prompt text, not every agent has a system prompt
// channel); a short context block rides every turn, so mode changes reach the
// agent without restarting it.

import { capText, firstLine, SCOPE_HINT, SCOPE_LABEL, type CellInfo, type ChatMessage, type ChatSettings, type NotebookInfo } from "@ainb/protocol";

const PLATFORM_NAME = { colab: "Google Colab", kaggle: "Kaggle", jupyter: "Jupyter" } as const;

export function playbook(info: NotebookInfo | null, file: string | null = null): string {
  const where = info ? PLATFORM_NAME[info.platform] : "Colab/Kaggle";
  const nbFile = file ? `the file ${file}` : "an .ipynb file in the working directory (notebook_info names it)";
  return `<agent-in-notebook>
You are helping the user with a ${where} notebook open in their browser. You work on the machine the notebook runs on, through the tools of the MCP server named "notebook", as you would on your own computer:
- Bash (with shell_wait, shell_input, shell_interrupt): a terminal there. Sessions persist (cd, env, venv), commands run as long as they need, prompts can be answered.
- Read, Write, Edit, Glob, Grep: its files. Relative paths start in the notebook's working directory.
- The notebook is ${nbFile}, kept in step with the browser: Read shows it as cells with their outputs, current even while a cell runs; Edit changes text inside a cell; NotebookEdit replaces, inserts, deletes or moves cells; Write replaces it whole (.ipynb JSON). Commands may change the file too (nbformat, jupytext, jq); the change reaches the browser. Cells are matched by their ids: keep them.
- run_cells, run_all, wait_for_cells, interrupt_kernel: run the notebook's cells. read_output pages through a long output.
- run_code, wait_for_code: run code on the kernel, with the notebook's variables, without adding a cell.
- await_review: wait for the user's decision on a change awaiting review.

Rules:
1. Any shell or file tools of your own act on the user's computer, which holds nothing of this work. Use the notebook server's tools.
2. Read the notebook before changing it; the user edits it too.
3. Follow the mode given in <notebook-context>. The tools refuse what the mode forbids; do not work around a refusal, tell the user what you would do instead.
4. With review on, every change to the notebook is shown to the user as a diff, and commands wait for approval. A rejected change was not applied: do not retry it unchanged.
5. Steps the notebook needs in order to run again from the top (installs it imports, downloads it reads, data preparation) go in its cells, shell commands prefixed with "!"; everything else can happen in the terminal.
6. Keep each code cell to one logical step. Use markdown cells for prose when the user asks for explanations or a write-up.
7. When done, answer briefly in the user's language and name the cells you changed.
</agent-in-notebook>`;
}

const OUTLINE_MAX_CELLS = 80;

/** `outlineUnchanged`: the agent got this same outline with its previous message. */
/** `file`: the notebook's file on its machine. */
export function turnContext(info: NotebookInfo | null, cells: CellInfo[] | null, settings: ChatSettings, targets: string[], outlineUnchanged = false, file: string | null = null): string {
  if (!info) {
    return `<notebook-context>\nNo notebook is attached right now (the tab may have navigated or reloaded). Tools will fail until it is back.\n</notebook-context>`;
  }
  const lines = [
    `Notebook: ${info.title} (${PLATFORM_NAME[info.platform]})${file ? `, file ${file}` : ""}`,
    `Kernel: ${info.kernel}. Language: ${info.language}.`,
    `Mode: ${SCOPE_LABEL[settings.scope]}. ${SCOPE_HINT[settings.scope]}${settings.review ? " Review is ON: each change waits for the user's approval." : ""}`,
  ];
  if (settings.scope === "cell") lines.push(`Editable cell(s): ${targets.length ? targets.join(", ") : "none — ask the user to select one"}.`);
  if (settings.notebookOnly) lines.push("Notebook only: requests to use your own tools on the user's computer (shell, file edits, web) are refused. Work through the notebook server's tools.");
  lines.push(`Active cell: ${info.activeCellId ?? "none"}.`);
  if (cells && outlineUnchanged) {
    lines.push(`Outline: ${cells.length} cells, unchanged since your previous message.`);
  } else if (cells) {
    lines.push(`Outline (${cells.length} cells):`);
    for (const c of cells.slice(0, OUTLINE_MAX_CELLS)) {
      lines.push(`[${c.index}] ${c.id} ${c.type}: ${firstLine(c.source, 70) || "(empty)"}`);
    }
    if (cells.length > OUTLINE_MAX_CELLS) lines.push(`… ${cells.length - OUTLINE_MAX_CELLS} more; Read the notebook file.`);
  }
  return `<notebook-context>\n${lines.join("\n")}\n</notebook-context>`;
}

/**
 * A bounded recap of the conversation, for an agent that starts mid-chat
 * (after a switch or a crash) and has none of it in its own session.
 */
export function recap(messages: ChatMessage[], maxChars = 6000): string {
  const items: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = m.parts
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "tool" && p.notebook) return `[tool: ${p.title} — ${p.status}]`;
        if (p.type === "review") return `[change to cell ${p.review.cellId}: ${p.status}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) items.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  if (!items.length) return "";
  let body = items.join("\n\n");
  if (body.length > maxChars) body = capText(body, maxChars);
  return `<earlier-conversation>\nThis chat started before you joined; here is what happened so far. The notebook may have changed since — read it again before acting.\n\n${body}\n</earlier-conversation>`;
}
