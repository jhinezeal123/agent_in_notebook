import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseLaunchCommand } from "@ainb/protocol";
import { dataDir, loadCustomAgents, saveCustomAgent } from "../config.js";
import { AcpAgent } from "./acp-agent.js";
import { describeAgents, which, type LaunchSpec } from "./registry.js";

function launch(commandLine: string): LaunchSpec {
  const parsed = parseLaunchCommand(commandLine);
  if (/[\\/]/.test(parsed.command) && !isAbsolute(parsed.command)) throw new Error("Use an executable on PATH or an absolute path.");
  const command = isAbsolute(parsed.command) ? parsed.command : which(parsed.command);
  if (!command || !existsSync(command) || !statSync(command).isFile()) throw new Error(`Executable '${parsed.command}' was not found. Use an installed command on PATH or an absolute executable path.`);
  return { command, args: parsed.args };
}

export function saveAgent(input: { id?: string; name?: string; launchCommand: string }) {
  const parsed = parseLaunchCommand(input.launchCommand);
  const name = input.name?.trim() || parsed.command.split(/[\\/]/).at(-1)!;
  if (name.includes("\0")) throw new Error("Agent name cannot contain null characters.");
  const id = input.id ?? `custom-${randomUUID()}`;
  if (input.id && !loadCustomAgents().some((a) => a.id === id)) throw new Error("That custom agent no longer exists.");
  launch(input.launchCommand);
  saveCustomAgent({ id, name, command: parsed.command, args: parsed.args });
  return describeAgents().find((a) => a.id === id)!;
}

export async function testAgent(commandLine: string) {
  const spec = launch(commandLine);
  const cwd = join(dataDir(), "workspaces", `probe-${randomUUID()}`);
  mkdirSync(cwd, { recursive: true });
  const agent = new AcpAgent(spec, {
    onUpdate() {}, onExit() {},
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  try {
    await agent.start(cwd, []);
    return { name: agent.init?.agentInfo?.title ?? agent.init?.agentInfo?.name ?? "ACP agent", options: agent.options() };
  } finally {
    agent.dispose();
    // The agent may still hold the directory for a moment on Windows; the
    // bridge prunes leftovers at startup.
    setTimeout(() => {
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // pruned later
      }
    }, 500).unref();
  }
}
