// The agents the bridge can drive. Every one of them speaks ACP over stdio, so
// an entry is only "how to launch it" plus "how to tell whether it is here".
// Adding an agent is one entry; a user can add more in agents.json.

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import type { AgentInfo } from "@ainb/protocol";
import { loadCustomAgents } from "../config.js";

const require = createRequire(import.meta.url);

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentSpec {
  id: string;
  name: string;
  builtin: boolean;
  /** Longest a notebook tool call may block (user review, long run) before it returns "still pending". */
  toolWaitMs: number;
  /** Shown when the agent needs a sign-in. */
  loginHint: string;
  resolve(): { launch: LaunchSpec } | { missing: string };
}

/** Find an executable on PATH, honoring PATHEXT on Windows. */
export function which(cmd: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === "win32" ? ["", ...exts] : exts) {
      const full = join(dir, cmd + ext);
      try {
        if (existsSync(full) && statSync(full).isFile()) {
          if (process.platform === "win32" && ext === "" && !/\.[a-z]+$/i.test(cmd)) continue;
          return full;
        }
      } catch {
        // unreadable entry
      }
    }
  }
  return null;
}

/** Resolve an npm package's bin script so it runs with this Node, no shell shim. */
function packageBin(pkg: string, bin: string): string | null {
  try {
    const manifest = require.resolve(`${pkg}/package.json`);
    const json = require(manifest);
    const rel = typeof json.bin === "string" ? json.bin : json.bin?.[bin];
    if (!rel) return null;
    const full = join(dirname(manifest), rel);
    return existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

function nodeScript(pkg: string, bin: string, missing: string) {
  return (): { launch: LaunchSpec } | { missing: string } => {
    const script = packageBin(pkg, bin);
    return script ? { launch: { command: process.execPath, args: [script] } } : { missing };
  };
}

function onPath(cmd: string, args: string[], missing: string) {
  return (): { launch: LaunchSpec } | { missing: string } => {
    const full = which(cmd);
    return full ? { launch: { command: full, args } } : { missing };
  };
}

const BUILTIN: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    builtin: true,
    toolWaitMs: 300_000,
    loginHint: "Sign in by running `claude` once in a terminal, or set ANTHROPIC_API_KEY.",
    resolve: nodeScript("@agentclientprotocol/claude-agent-acp", "claude-agent-acp", "The Claude ACP adapter is not installed (pnpm install in the bridge)."),
  },
  {
    id: "codex",
    name: "Codex",
    builtin: true,
    // Codex gives MCP tools 60s by default.
    toolWaitMs: 50_000,
    loginHint: "Sign in by running `codex login` in a terminal, or set OPENAI_API_KEY.",
    resolve: nodeScript("@agentclientprotocol/codex-acp", "codex-acp", "The Codex ACP adapter is not installed (pnpm install in the bridge)."),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    builtin: true,
    toolWaitMs: 300_000,
    loginHint: "Sign in by running `gemini` once in a terminal, or set GEMINI_API_KEY.",
    resolve: onPath("gemini", ["--acp"], "`gemini` is not on PATH. Install it with `npm i -g @google/gemini-cli`."),
  },
  {
    id: "opencode",
    name: "OpenCode",
    builtin: true,
    toolWaitMs: 120_000,
    loginHint: "Configure a provider by running `opencode auth login` in a terminal.",
    resolve: onPath("opencode", ["acp"], "`opencode` is not on PATH. Install it from https://opencode.ai."),
  },
];

export function allAgents(): AgentSpec[] {
  const custom: AgentSpec[] = loadCustomAgents().map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    builtin: false,
    toolWaitMs: (c.toolWaitSeconds ?? 120) * 1000,
    loginHint: "Check the agent's own sign-in.",
    resolve: () => {
      const full = existsSync(c.command) ? c.command : which(c.command);
      return full ? { launch: { command: full, args: c.args ?? [], env: c.env } } : { missing: `\`${c.command}\` was not found.` };
    },
  }));
  const ids = new Set(custom.map((c) => c.id));
  return [...BUILTIN.filter((b) => !ids.has(b.id)), ...custom];
}

export function findAgent(id: string): AgentSpec | undefined {
  return allAgents().find((a) => a.id === id);
}

export function describeAgents(): AgentInfo[] {
  return allAgents().map((a) => {
    const r = a.resolve();
    if ("missing" in r) return { id: a.id, name: a.name, available: false, reason: r.missing, command: "", builtin: a.builtin };
    return { id: a.id, name: a.name, available: true, command: [r.launch.command, ...r.launch.args].join(" "), builtin: a.builtin };
  });
}
