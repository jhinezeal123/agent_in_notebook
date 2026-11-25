import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

/** Write through a temporary file and rename it into place, so a crash never leaves half a config. */
function writeAtomic(file: string, text: string, mode: number): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Set a broken config file aside as <name>.bak, best effort: the data in it is the user's. */
function keepBroken(file: string, error: unknown): void {
  const name = basename(file);
  let kept = false;
  try {
    renameSync(file, `${file}.bak`);
    kept = true;
  } catch {
    try {
      copyFileSync(file, `${file}.bak`);
      kept = true;
    } catch {
      // Could not be set aside; the caller still writes a fresh, valid config.
    }
  }
  console.error(`${name} is not valid JSON${kept ? ` (kept as ${name}.bak)` : ""}: ${(error as Error).message}`);
}

/** Load the config file, creating it (with a fresh pairing token) on first run. */
export function loadConfig(): BridgeConfig {
  const file = join(dataDir(), "config.json");
  let cfg: Partial<BridgeConfig> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") cfg = parsed;
    } catch (e) {
      // A broken config must not cost the user their pairing quietly: keep the file, make a new one.
      keepBroken(file, e);
    }
  }
  const full: BridgeConfig = {
    token: typeof cfg.token === "string" && cfg.token.length >= 16 ? cfg.token : randomBytes(18).toString("base64url"),
    port: typeof cfg.port === "number" ? cfg.port : BRIDGE_DEFAULT_PORT,
  };
  if (full.token !== cfg.token || full.port !== cfg.port) {
    writeAtomic(file, JSON.stringify(full, null, 2), 0o600);
  }
  if (process.env.AINB_PORT) full.port = Number(process.env.AINB_PORT);
  return full;
}

export function resetToken(): BridgeConfig {
  const file = join(dataDir(), "config.json");
  const cfg = loadConfig();
  const next = { ...cfg, token: randomBytes(18).toString("base64url") };
  writeAtomic(file, JSON.stringify(next, null, 2), 0o600);
  return next;
}

function loadJsonObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {}; // none yet
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    keepBroken(file, e);
    return {};
  }
}

/** Write a config object atomically, keeping fields this version does not know. */
function saveJsonObject(file: string, known: readonly string[], cfg: Record<string, unknown>): void {
  const old = loadJsonObject(file);
  const kept = Object.fromEntries(Object.entries(old).filter(([k]) => !known.includes(k)));
  writeAtomic(file, JSON.stringify({ ...kept, ...cfg }, null, 2), 0o600);
}

/** OpenResearch settings, in research.json. */
export interface ResearchConfig {
  /** The orx binary to run; unset: look on PATH and in the usual install places. */
  orxPath?: string;
  /**
   * Environment for the `orx up` the bridge starts, e.g. ORX_DATA_DIR and
   * ORX_CACHE_DIR, so it opens the same storage as the OpenResearch you run
   * yourself (its database, Kaggle runtime, account profiles).
   */
  env?: Record<string, string>;
  /** The OpenResearch project notebook chats go to when none was chosen. */
  scratchProjectId?: string;
}

export function loadResearchConfig(): ResearchConfig {
  const cfg = loadJsonObject(join(dataDir(), "research.json"));
  const out: ResearchConfig = {};
  if (typeof cfg.orxPath === "string" && cfg.orxPath) out.orxPath = cfg.orxPath;
  if (cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)) {
    const env = Object.fromEntries(Object.entries(cfg.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    if (Object.keys(env).length) out.env = env;
  }
  if (typeof cfg.scratchProjectId === "string" && cfg.scratchProjectId) out.scratchProjectId = cfg.scratchProjectId;
  return out;
}

/** Write research.json, keeping fields this version does not know. */
export function saveResearchConfig(cfg: ResearchConfig): void {
  saveJsonObject(join(dataDir(), "research.json"), ["orxPath", "env", "scratchProjectId"], cfg as Record<string, unknown>);
}

/** Easy-read settings, in reader.json. */
/** Easy-read's background agents always run on the paper's tutor's agent and settings: only when they run is configured here. */
export interface ReaderConfig {
  /** When background agents run: "ask" (default) waits for the reader's click. */
  agentMode?: "ask" | "auto" | "off";
  /** The blind checker runs with each checkpoint (default true). */
  checker?: boolean;
  /** Times the checker's disagreements go back to the author, 0–2 (default 2). */
  checkerRounds?: number;
}

/** What the hidden author goes by, with the defaults filled in. */
export interface ReaderAgentSettings {
  mode: "ask" | "auto" | "off";
  checker: boolean;
  rounds: number;
}

export function readerAgentSettings(cfg: ReaderConfig): ReaderAgentSettings {
  return { mode: cfg.agentMode ?? "ask", checker: cfg.checker ?? true, rounds: cfg.checkerRounds ?? 2 };
}

export function loadReaderConfig(): ReaderConfig {
  const cfg = loadJsonObject(join(dataDir(), "reader.json"));
  const out: ReaderConfig = {};
  if (cfg.agentMode === "ask" || cfg.agentMode === "auto" || cfg.agentMode === "off") out.agentMode = cfg.agentMode;
  if (typeof cfg.checker === "boolean") out.checker = cfg.checker;
  if (typeof cfg.checkerRounds === "number" && [0, 1, 2].includes(cfg.checkerRounds)) out.checkerRounds = cfg.checkerRounds;
  return out;
}

/** Write reader.json, keeping fields this version does not know (the checker's own agent and model of older versions are dropped). */
export function saveReaderConfig(cfg: ReaderConfig): void {
  saveJsonObject(join(dataDir(), "reader.json"), ["checkerAgentId", "checkerModel", "agentMode", "checker", "checkerRounds"], cfg as Record<string, unknown>);
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

let agentsGen = 0;

/** Monotonic bump whenever saveCustomAgent/removeCustomAgent writes agents.json. */
export function customAgentsGeneration(): number {
  return agentsGen;
}

function updateCustomAgents(update: (agents: CustomAgentConfig[]) => void): void {
  const file = join(dataDir(), "agents.json");
  const document = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const agents = Array.isArray(document) ? document : document?.agents;
  if (!Array.isArray(agents) || agents.some((a) => !a || typeof a.id !== "string" || typeof a.command !== "string")) {
    throw new Error(`Cannot update ${file}: expected an array of agent definitions (or an object with an agents array).`);
  }
  update(agents);
  writeAtomic(file, JSON.stringify(document, null, 2), 0o600);
  agentsGen++;
}
