// One ACP agent process with one session. Every supported agent goes through
// this class; the registry only decides how to launch it.

import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import spawn from "cross-spawn";
import type { AgentOption } from "@ainb/protocol";
import { BRIDGE_VERSION } from "../config.js";
import type { LaunchSpec } from "./registry.js";

export interface AcpAgentHandlers {
  onUpdate(n: SessionNotification): void;
  onPermission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  onExit(code: number | null, stderrTail: string): void;
}

export class AgentStartError extends Error {
  constructor(message: string, readonly authRequired = false) {
    super(message);
  }
}

const STDERR_KEEP = 8_000;
const DEBUG = !!process.env.AINB_DEBUG;

function debug(what: string, data?: unknown): void {
  if (!DEBUG) return;
  const t = new Date().toISOString().slice(11, 23);
  const body = data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data);
  console.error(`[acp ${t}] ${what} ${body.length > 600 ? `${body.slice(0, 600)}…` : body}`);
}

export class AcpAgent {
  private child: ChildProcess | null = null;
  private conn: ClientConnection | null = null;
  private stderr = "";
  private exited = false;
  sessionId: string | null = null;
  init: InitializeResponse | null = null;
  modes: SessionModeState | null = null;
  configOptions: SessionConfigOption[] = [];

  constructor(
    private readonly launch: LaunchSpec,
    private readonly handlers: AcpAgentHandlers,
  ) {}

  get running(): boolean {
    return !!this.child && !this.exited;
  }

  stderrTail(): string {
    return this.stderr.trim();
  }

  /** `meta`: the agent's own session options (see AgentSpec.sessionMeta). */
  async start(cwd: string, mcpServers: McpServer[], meta?: Record<string, unknown>): Promise<NewSessionResponse> {
    const child = spawn(this.launch.command, this.launch.args, {
      cwd,
      env: { ...process.env, ...this.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group on POSIX, so stopping it also stops what it spawned.
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_KEEP);
      debug("stderr", d.trimEnd());
    });
    debug("spawn", [this.launch.command, ...this.launch.args].join(" "));
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (e) => reject(new AgentStartError(`Could not start ${this.launch.command}: ${e.message}`)));
      child.once("exit", (code) => {
        this.exited = true;
        reject(new AgentStartError(`Agent exited during startup (code ${code}).${this.stderr ? `\n${this.stderrTail()}` : ""}`));
      });
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.conn?.close();
      this.handlers.onExit(code, this.stderrTail());
    });

    const app = client({ name: "agent-in-notebook" })
      .onNotification("session/update", ({ params }) => {
        debug("update", params.update);
        if (params.sessionId === this.sessionId) this.handlers.onUpdate(params);
      })
      .onRequest("session/request_permission", ({ params, signal }) => {
        debug("permission", params.toolCall);
        return this.handlers.onPermission(params, signal);
      })
      .onRequest("*", ({ method }) => {
        debug("unsupported request", method);
        throw Object.assign(new Error(`Method not supported by this client: ${method}`), { code: -32601 });
      })
      .onNotification("*", ({ method, params }) => debug("notification", { method, params }));

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = app.connect(stream);

    const handshake = async () => {
      this.init = await this.conn!.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // `session.compaction`: the agent reports compacting its context (compaction_update),
        // after which the notebook rules are sent again.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
        clientInfo: { name: "agent-in-notebook", title: "Agent in Notebook", version: BRIDGE_VERSION },
      });
      try {
        return await this.conn!.agent.request("session/new", { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
      } catch (e) {
        const err = e as { code?: number; message?: string };
        if (err.code === -32000 || /auth/i.test(err.message ?? "")) {
          throw new AgentStartError(`The agent needs you to sign in. ${err.message ?? ""}`.trim(), true);
        }
        throw e;
      }
    };

    try {
      const session = await Promise.race([handshake(), spawnFailed, timeout(120_000, "Agent did not start within 2 minutes.")]);
      this.sessionId = session.sessionId;
      this.modes = session.modes ?? null;
      this.configOptions = session.configOptions ?? [];
      return session;
    } catch (e) {
      this.dispose();
      if (e instanceof AgentStartError) throw e;
      const tail = this.stderrTail();
      throw new AgentStartError(`${(e as Error).message}${tail ? `\n${tail.slice(-1500)}` : ""}`);
    }
  }

  async prompt(text: string): Promise<PromptResponse> {
    if (!this.conn || !this.sessionId) throw new Error("agent is not running");
    debug("prompt", `${text.length} chars`);
    const res = await this.conn.agent.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    debug("prompt done", res);
    return res;
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    await this.conn.agent.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** The agent's own settings (models, modes, effort), merged into one list for the UI. */
  options(): AgentOption[] {
    const out: AgentOption[] = [];
    for (const o of this.configOptions) {
      if (o.type === "select") {
        const choices = flattenChoices((o as any).options);
        out.push({ id: o.id, name: o.name, category: o.category, kind: "select", value: String(o.currentValue), choices });
      } else if (o.type === "boolean") {
        out.push({ id: o.id, name: o.name, category: o.category, kind: "boolean", value: !!o.currentValue });
      }
    }
    // Older agents expose session modes without a matching config option.
    if (this.modes && !out.some((o) => o.category === "mode")) {
      out.push({
        id: "__mode",
        name: "Agent mode",
        category: "mode",
        kind: "select",
        value: this.modes.currentModeId,
        viaMode: true,
        choices: this.modes.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })),
      });
    }
    return out;
  }

  async setOption(optionId: string, value: string | boolean): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error("agent is not running");
    if (optionId === "__mode") {
      await this.conn.agent.request("session/set_mode", { sessionId: this.sessionId, modeId: String(value) });
      if (this.modes) this.modes = { ...this.modes, currentModeId: String(value) };
      return;
    }
    const res = await this.conn.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: optionId,
      ...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
    } as any);
    if ((res as any)?.configOptions) this.configOptions = (res as any).configOptions;
  }

  applyConfigUpdate(options: SessionConfigOption[]): void {
    this.configOptions = options;
  }

  applyModeUpdate(modeId: string): void {
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
  }

  dispose(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    if (this.child && !this.exited) {
      killTree(this.child);
    }
    this.conn = null;
  }
}

function flattenChoices(options: any): { value: string; name: string; description?: string | null }[] {
  if (!Array.isArray(options)) return [];
  const out: { value: string; name: string; description?: string | null }[] = [];
  for (const o of options) {
    if (o && Array.isArray(o.options)) {
      // A group of options.
      for (const g of o.options) out.push({ value: String(g.value), name: g.name ?? String(g.value), description: g.description });
    } else if (o) out.push({ value: String(o.value), name: o.name ?? String(o.value), description: o.description });
  }
  return out;
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new AgentStartError(message)), ms).unref());
}

/** Kill the agent and anything it spawned. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  // The agent leads its own process group (spawned detached): signal the whole
  // group, then make sure nothing is left after a grace period.
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // gone
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 3000).unref();
}
