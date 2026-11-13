// Pure helpers for laying out a transcript message.

import type { Part } from "@ainb/protocol";

export type ToolPart = Extract<Part, { type: "tool" }>;
export type Item = { kind: "part"; part: Part } | { kind: "tools"; tools: ToolPart[] };

/** Consecutive tool calls become one group, so a busy turn reads as a few lines. */
export function groupParts(parts: Part[]): Item[] {
  const items: Item[] = [];
  for (const part of parts) {
    const last = items.at(-1);
    if (part.type === "tool" && last?.kind === "tools") last.tools.push(part);
    else if (part.type === "tool") items.push({ kind: "tools", tools: [part] });
    else items.push({ kind: "part", part });
  }
  return items;
}

/** Our notebook tools a call reached, however the agent spelled it. */
export function notebookNames(part: ToolPart): string[] {
  if (part.notebookCalls?.length) return part.notebookCalls;
  const m = part.title.match(/(?:mcp__notebook__|mcp\.notebook\.|notebook[./:_]{1,2})(\w+)/);
  return m ? [m[1]!] : [];
}

export function toolLabel(part: ToolPart): string {
  const names = notebookNames(part);
  return names.length ? `notebook · ${names.join(", ")}` : part.title;
}

const ACTION: Record<string, string> = {
  list_cells: "Read",
  read_cells: "Read",
  notebook_info: "Read",
  update_cell: "Edited",
  edit_cell: "Edited",
  insert_cell: "Added",
  delete_cell: "Deleted",
  move_cell: "Moved",
  run_cells: "Ran",
  run_all: "Ran",
  wait_for_cells: "Waited",
  await_review: "Waited",
  interrupt_kernel: "Interrupted",
};

/** "Read ×2 · Edited · Ran ×3", in the order the actions first happened. */
export function summarizeTools(tools: ToolPart[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const names = notebookNames(t);
    for (const action of names.length ? names.map((n) => ACTION[n] ?? "Used notebook") : ["Used tool"]) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  return [...counts].map(([action, n]) => (n > 1 ? `${action} ×${n}` : action)).join(" · ");
}
