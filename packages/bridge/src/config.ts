import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_DEFAULT_PORT } from "@ainb/protocol";

export const BRIDGE_VERSION = "0.1.0";

/** `serve --log` ends its log with this when it exits on an error. */
export const STOPPED_MARK = "[bridge exited]";

export function dataDir(): string {
  const dir = process.env.AINB_HOME ?? join(homedir(), ".agent-in-notebook");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface BridgeConfig {
  /** Shared secret the extension presents when it connects. */
  token: string;
  port: number;
}

/** Load the config file, creating it (with a fresh pairing token) on first run. */
export function loadConfig(): BridgeConfig {
  const file = join(dataDir(), "config.json");
  let cfg: Partial<BridgeConfig> = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      cfg = {};
    }
  }
  const full: BridgeConfig = {
    token: typeof cfg.token === "string" && cfg.token.length >= 16 ? cfg.token : randomBytes(18).toString("base64url"),
    port: typeof cfg.port === "number" ? cfg.port : BRIDGE_DEFAULT_PORT,
  };
  if (full.token !== cfg.token || full.port !== cfg.port) {
    writeFileSync(file, JSON.stringify(full, null, 2), { mode: 0o600 });
  }
  if (process.env.AINB_PORT) full.port = Number(process.env.AINB_PORT);
  return full;
}

export function resetToken(): BridgeConfig {
  const file = join(dataDir(), "config.json");
  const cfg = loadConfig();
  const next = { ...cfg, token: randomBytes(18).toString("base64url") };
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** OpenResearch settings, in research.json. */
export interface ResearchConfig {
  /** The orx binary to run; unset: look on PATH and in the usual install places. */
  orxPath?: string;
}

export function loadResearchConfig(): ResearchConfig {
  const file = join(dataDir(), "research.json");
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return typeof cfg?.orxPath === "string" && cfg.orxPath ? { orxPath: cfg.orxPath } : {};
  } catch {
    return {};
  }
}

export function saveResearchConfig(cfg: ResearchConfig): void {
  writeFileSync(join(dataDir(), "research.json"), JSON.stringify(cfg, null, 2));
}

/** A user-defined ACP agent from agents.json. */
export interface CustomAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Longest a notebook tool call may block before returning "still pending". */
  toolWaitSeconds?: number;
  /** Send plot images in tool results (default: what the agent declares over ACP). */
  images?: boolean;
}

export function loadCustomAgents(): CustomAgentConfig[] {
  const file = join(dataDir(), "agents.json");
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    const arr = Array.isArray(list) ? list : Array.isArray(list?.agents) ? list.agents : [];
    return arr.filter((a: any) => a && typeof a.id === "string" && typeof a.command === "string");
  } catch (e) {
    console.error(`agents.json is not valid JSON: ${(e as Error).message}`);
    return [];
  }
}

/** Preserve existing env settings and unknown fields when editing the catalog. */
export function saveCustomAgent(agent: CustomAgentConfig): void {
  updateCustomAgents((agents) => {
    const index = agents.findIndex((a) => a.id === agent.id);
    if (index < 0) agents.push(agent);
    else agents[index] = { ...agents[index], ...agent };
  });
}

export function removeCustomAgent(id: string): boolean {
  let removed = false;
  updateCustomAgents((agents) => {
    const index = agents.findIndex((a) => a.id === id);
    if (index >= 0) { agents.splice(index, 1); removed = true; }
  });
  return removed;
}

function updateCustomAgents(update: (agents: CustomAgentConfig[]) => void): void {
  const file = join(dataDir(), "agents.json");
  const document = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const agents = Array.isArray(document) ? document : document?.agents;
  if (!Array.isArray(agents) || agents.some((a) => !a || typeof a.id !== "string" || typeof a.command !== "string")) {
    throw new Error(`Cannot update ${file}: expected an array of agent definitions (or an object with an agents array).`);
  }
  update(agents);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
