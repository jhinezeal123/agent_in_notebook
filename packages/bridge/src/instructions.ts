// What the agent is told. The playbook rides the first turn of a session (every
// agent accepts plain prompt text, not every agent has a system prompt
// channel); a short context block rides every turn, so mode changes reach the
// agent without restarting it.

import { capText, firstLine, SCOPE_HINT, SCOPE_LABEL, type CellInfo, type ChatMessage, type ChatSettings, type NotebookInfo } from "@ainb/protocol";

const PLATFORM_NAME = { colab: "Google Colab", kaggle: "Kaggle", jupyter: "Jupyter" } as const;

export function playbook(info: NotebookInfo | null): string {
  const where = info ? PLATFORM_NAME[info.platform] : "Colab/Kaggle";
  return `<agent-in-notebook>
You are helping the user with a ${where} notebook that is open in their browser. You reach it only through the tools of the MCP server named "notebook":
- list_cells, read_cells, notebook_info: read the notebook and its outputs.
- edit_cell (exact snippet replacement), update_cell (whole source), insert_cell, delete_cell, move_cell: change it.
- run_cells, run_all, wait_for_cells, interrupt_kernel: execute it (Autonomous mode only).
- await_review: wait for the user's decision on a change awaiting review.

Rules:
1. The notebook is not a file on this computer. Never search for, create or edit an .ipynb file, and do not use your shell or file tools to work on the notebook.
2. Address cells by id. Indexes shift when cells are added, moved or removed.
3. Read a cell before changing it; the user edits the notebook too.
4. Follow the mode given in <notebook-context>. The tools refuse what the mode forbids; do not work around a refusal, tell the user what you would do instead.
5. With review on, every change is shown to the user as a diff. A rejected change was not applied: do not retry it unchanged.
6. Code runs on the notebook's kernel in the cloud, not on this computer. Shell commands belong in a code cell, prefixed with "!".
7. Keep each code cell to one logical step. Use markdown cells for prose when the user asks for explanations or a write-up.
8. When done, answer briefly in the user's language and name the cells you changed.
</agent-in-notebook>`;
}

const OUTLINE_MAX_CELLS = 80;

export function turnContext(info: NotebookInfo | null, cells: CellInfo[] | null, settings: ChatSettings, targets: string[]): string {
  if (!info) {
    return `<notebook-context>\nNo notebook is attached right now (the tab may have navigated or reloaded). Tools will fail until it is back.\n</notebook-context>`;
  }
  const lines = [
    `Notebook: ${info.title} (${PLATFORM_NAME[info.platform]})`,
    `Kernel: ${info.kernel}. Language: ${info.language}.`,
    `Mode: ${SCOPE_LABEL[settings.scope]}. ${SCOPE_HINT[settings.scope]}${settings.review ? " Review is ON: each change waits for the user's approval." : ""}`,
  ];
  if (settings.scope === "cell") lines.push(`Editable cell(s): ${targets.length ? targets.join(", ") : "none — ask the user to select one"}.`);
  if (settings.notebookOnly) lines.push("Notebook only: requests to use your own tools on this computer (shell, file edits, web) are refused. Work through the notebook tools.");
  lines.push(`Active cell: ${info.activeCellId ?? "none"}.`);
  if (cells) {
    lines.push(`Outline (${cells.length} cells):`);
    for (const c of cells.slice(0, OUTLINE_MAX_CELLS)) {
      lines.push(`[${c.index}] ${c.id} ${c.type}: ${firstLine(c.source, 70) || "(empty)"}`);
    }
    if (cells.length > OUTLINE_MAX_CELLS) lines.push(`… ${cells.length - OUTLINE_MAX_CELLS} more; call list_cells.`);
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
