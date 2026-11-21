// Export a chat transcript to Markdown (B4.1).

import { diffLines, type ChatSnapshot, type NotebookInfo, type Part } from "@ainb/protocol";
import { groupParts, summarizeTools } from "./transcript.js";

export function exportChatMarkdown(chat: ChatSnapshot, notebook?: NotebookInfo | null): string {
  const title = notebook?.title || chat.notebookKey || "Notebook Chat";
  const header = [
    `# ${title}`,
    "",
    `- **Agent:** ${chat.agentName}`,
    notebook ? `- **Platform:** ${notebook.platform}` : "",
    notebook?.url ? `- **URL:** ${notebook.url}` : "",
    `- **Exported:** ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].filter((l) => l !== undefined);

  const blocks: string[] = [header.join("\n")];
  for (const m of chat.messages) {
    const when = new Date(m.createdAt).toLocaleString();
    const roleLabel = m.role === "user" ? "User" : m.role === "agent" ? chat.agentName : "System";
    const pinMark = m.pinned ? " [Pinned]" : "";
    const partsOut: string[] = [];
    for (const item of groupParts(m.parts)) {
      if (item.kind === "tools") {
        partsOut.push(`> *Tools:* ${summarizeTools(item.tools)}`);
      } else {
        const rendered = renderPartMarkdown(item.part);
        if (rendered) partsOut.push(rendered);
      }
    }
    if (!partsOut.length) continue;
    blocks.push(`## ${roleLabel}${pinMark} · ${when}\n\n${partsOut.join("\n\n")}\n`);
  }
  return blocks.join("\n");
}

function renderPartMarkdown(part: Part): string {
  switch (part.type) {
    case "text":
      return part.text.trim();
    case "thought":
      return `<details><summary>Thought</summary>\n\n${part.text.trim()}\n\n</details>`;
    case "cells":
      return `> *Attached cells:* ${part.cells.map((c) => `[${c.index}] ${c.label || c.cellId}`).join(", ")}`;
    case "image":
      return `![${part.alt ?? "Plot image"}](data:${part.mime};base64,${part.data})`;
    case "notice":
      return `> **${part.level === "error" ? "Error" : "Notice"}:** ${part.text}`;
    case "card":
      return `> **${part.card.title}**${part.card.detail ? `\n> ${part.card.detail.replace(/\n/g, "\n> ")}` : ""}${part.card.outcome ? `\n> _${part.card.outcome}_` : ""}`;
    case "review": {
      const diff = diffLines(part.review.before, part.review.after)
        .map((l) => `${l.op === "add" ? "+" : l.op === "del" ? "-" : " "}${l.text}`)
        .join("\n");
      const label = part.review.index !== undefined ? `cell [${part.review.index}]` : part.review.cellId;
      return `**Review (${part.review.kind} ${label}, ${part.status})**\n\n\`\`\`diff\n${diff}\n\`\`\``;
    }
    case "prompt":
      return `> **Prompt:** ${part.title}${part.answer ? ` → _${part.answer}_` : ""}`;
    case "plan":
      return part.entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`).join("\n");
    default:
      return "";
  }
}
