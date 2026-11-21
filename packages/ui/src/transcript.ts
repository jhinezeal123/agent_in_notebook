// Pure helpers for laying out a transcript message.

import type { AttachedCell, ChatMessage, ChatStatus, Part } from "@ainb/protocol";

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
  Read: "Read",
  read_output: "Read",
  Glob: "Searched",
  Grep: "Searched",
  Edit: "Edited",
  NotebookEdit: "Edited",
  Write: "Wrote",
  Bash: "Ran command",
  shell_input: "Typed",
  shell_wait: "Waited",
  shell_interrupt: "Interrupted",
  run_code: "Ran code",
  wait_for_code: "Waited",
  // Tools of earlier versions, still named in saved chats.
  list_cells: "Read",
  run_shell: "Ran command",
  read_cells: "Read",
  notebook_info: "Read",
  kernel_state: "Read",
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

/**
 * User messages that have not reached the agent yet. Wire v6 marks queued
 * messages explicitly (including those waiting behind a notebook job like
 * Verify/Judge); while a turn runs we also fall back to user messages after
 * the last agent message so older snapshots behave the same.
 */
export function queuedMessageIds(messages: ChatMessage[], status: ChatStatus): Set<string> {
  const queued = new Set<string>();
  for (const m of messages) {
    if (m.role === "user" && m.queued) queued.add(m.id);
  }
  if (status !== "running") return queued;
  let lastAgent = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "agent") { lastAgent = i; break; }
  }
  // No agent message yet (the turn's reply is still empty): nothing to be behind.
  if (lastAgent < 0) return queued;
  for (let i = lastAgent + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") queued.add(m.id);
  }
  return queued;
}

/** The last user message that has text, verbatim with its own attached cells, for "Send again". */
export function lastUserMessage(messages: ChatMessage[]): { text: string; cells: AttachedCell[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (text.trim()) return { text, cells: m.parts.flatMap((p) => (p.type === "cells" ? p.cells : [])) };
  }
  return null;
}

/** The local calendar day of a timestamp, for telling days apart. */
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** A day's label in a transcript: "Today", "Yesterday", else the local date. */
export function dayLabel(at: number, now: number = Date.now()): string {
  const day = dayKey(at);
  if (day === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayKey(yesterday.getTime())) return "Yesterday";
  return new Date(at).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

/**
 * Where a transcript crosses into a new local day: message id → the day's label.
 * The first message gets one only when it is from an earlier day, so a chat
 * that stays within today reads without dividers.
 */
export function dateSeparators(messages: ChatMessage[], now: number = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  let prev: string | null = null;
  for (const m of messages) {
    const day = dayKey(m.createdAt);
    if (prev === null ? day !== dayKey(now) : day !== prev) out.set(m.id, dayLabel(m.createdAt, now));
    prev = day;
  }
  return out;
}

/** When a message was sent, as a short local time (the user bubble's foot). */
export function messageTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A message's full local date and time, for its hover title. */
export function messageTitle(at: number): string {
  return new Date(at).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
