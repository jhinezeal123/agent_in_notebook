// Slash commands & contextual empty-state suggestions (B5.1).

import type { ChatUsage, NotebookInfo } from "@ainb/protocol";
import type { CustomSlashTemplate } from "./panel-messages.js";
import type { IconName } from "./icons.js";

export type SlashAction =
  | { kind: "prompt"; text: string; needsArg?: boolean }
  | { kind: "action"; action: "save" | "verify" | "clear" | "compact" };

export interface SlashCommand {
  name: string;
  description: string;
  custom?: boolean;
  run: SlashAction;
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/fix", description: "Fix the error in the selected or attached cell", run: { kind: "prompt", text: "Fix the error in the selected cell. If there is no error yet, ask which issue to fix instead of guessing." } },
  { name: "/explain", description: "Explain the selected or attached cell", run: { kind: "prompt", text: "Explain what the selected cell does step by step." } },
  { name: "/summarize", description: "Summarize this notebook and its results", run: { kind: "prompt", text: "Summarize what this notebook does, its key results, and any open issues." } },
  { name: "/lit-review", description: "Run a literature review with OpenResearch", run: { kind: "prompt", text: "/lit-review ", needsArg: true } },
  { name: "/save", description: "Save this notebook with outputs to project artifacts", run: { kind: "action", action: "save" } },
  { name: "/verify", description: "Run all cells cleanly from scratch and save if passing", run: { kind: "action", action: "verify" } },
  { name: "/compact", description: "Start a fresh chat carrying a short summary of this one", run: { kind: "action", action: "compact" } },
  { name: "/clear", description: "Clear this chat transcript and start fresh", run: { kind: "action", action: "clear" } },
];

export function allSlashCommands(custom?: CustomSlashTemplate[]): SlashCommand[] {
  const extras: SlashCommand[] = (custom ?? [])
    .filter((c) => c.name.trim() && c.prompt.trim())
    .map((c) => ({
      name: c.name.startsWith("/") ? c.name.trim() : `/${c.name.trim()}`,
      description: c.prompt.trim().slice(0, 80),
      custom: true,
      run: { kind: "prompt", text: c.prompt.trim() },
    }));
  return [...BUILTIN_SLASH_COMMANDS, ...extras];
}

/** Match commands when the composer starts with `/`. Returns [] when not a slash prefix. */
export function matchSlashCommands(input: string, custom?: CustomSlashTemplate[]): SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const q = input.toLowerCase();
  return allSlashCommands(custom).filter((c) => c.name.toLowerCase().startsWith(q));
}

export interface SuggestionItem {
  icon: IconName;
  label: string;
  text: string;
}

/** Dynamic suggestions for an empty chat based on kernel state, pending reviews, and context usage. */
export function contextualSuggestions(opts: {
  notebook?: NotebookInfo | null;
  pendingReviews?: number;
  usage?: ChatUsage;
  hasAttached?: boolean;
}): SuggestionItem[] {
  const out: SuggestionItem[] = [];
  if (opts.hasAttached) {
    out.push({ icon: "wand", label: "Explain attached cells", text: "Explain what the attached cells do and check for bugs." });
    out.push({ icon: "check", label: "Improve attached cells", text: "Review the attached cells and suggest improvements." });
  } else {
    out.push({ icon: "notebook", label: "Explain this notebook", text: "Explain what this notebook does" });
    out.push({ icon: "wand", label: "Fix the selected cell", text: "Fix the error in the selected cell. If there is no error yet, ask me what to fix." });
  }
  if (opts.notebook && opts.notebook.kernel === "disconnected") {
    out.push({ icon: "sparkle", label: "Review code without running", text: "Review the code in this notebook statically (kernel is disconnected)." });
  } else {
    out.push({ icon: "chart", label: "Plot the training loss", text: "Add a section that plots the training loss" });
  }
  if (opts.usage && opts.usage.size > 0 && opts.usage.used / opts.usage.size >= 0.8) {
    out.unshift({ icon: "sparkle", label: "Summarize before starting new chat", text: "Summarize our findings and next steps concisely so I can continue in a fresh chat." });
  }
  return out.slice(0, 4);
}
