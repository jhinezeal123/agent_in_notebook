import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { BRIDGE_DEFAULT_PORT, RpcPeer, WIRE_VERSION, type AgentInfo, type Envelope, type ExtensionMethods } from "@ainb/protocol";
import type { BridgeConfig, BridgeState, PanelEvent } from "../../extension/src/shared/panel-messages.js";

export class BridgeLink {
  private socket?: WebSocket;
  private rpc?: RpcPeer;
  private attempt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private config?: BridgeConfig;
  private state: BridgeState = {
    conn: "disconnected", agents: [], config: { port: BRIDGE_DEFAULT_PORT, token: "" }, extensionId: "",
  };

  constructor(
    private readonly version: string,
    private readonly publish: (event: PanelEvent) => void,
    private readonly runOp: (params: ExtensionMethods["notebook.op"]["params"]) => Promise<unknown>,
  ) {}

  snapshot(): BridgeState { return this.state; }

  private setState(update: Partial<BridgeState>): void {
    this.state = { ...this.state, ...update };
    this.publish({ event: "state", params: this.state });
  }

  async connect(manual?: BridgeConfig): Promise<void> {
    this.dispose();
    const attempt = this.attempt;
    this.setState({ conn: "connecting", error: undefined, agents: [] });
    let config: BridgeConfig;
    try {
      const path = join(process.env.AINB_HOME ?? join(homedir(), ".agent-in-notebook"), "config.json");
      config = manual ?? JSON.parse(await readFile(path, "utf8"));
      const port = !manual && process.env.AINB_PORT ? Number(process.env.AINB_PORT) : config.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof config.token !== "string" || !config.token) {
        throw new Error("The bridge configuration needs a valid port and pairing token.");
      }
      config = { port, token: config.token };
    } catch (error) {
      if (attempt === this.attempt) this.setState({ conn: "unpaired", error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Start the bridge, then retry the connection." : (error as Error).message });
      return;
    }
    if (attempt !== this.attempt) return;
    this.config = config;
    this.setState({ config: { port: config.port, token: "", source: manual ? "manual" : undefined } });
    let error: string | undefined;
    let paired = false;
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/vscode`, { handshakeTimeout: 4000, maxPayload: 32 * 1024 * 1024 });
    this.socket = socket;
    const rpc = new RpcPeer({ send: (envelope) => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error("The bridge is disconnected.");
      socket.send(JSON.stringify(envelope));
    }, timeoutMs: 120_000 });
    rpc.handle("notebook.op", (params: ExtensionMethods["notebook.op"]["params"]) => {
      if (this.rpc !== rpc) throw new Error("The bridge connection is no longer active.");
      return this.runOp(params);
    });
    rpc.on("agents.changed", ({ agents }: { agents: AgentInfo[] }) => {
      if (this.rpc === rpc) this.setState({ agents });
    });
    for (const method of ["chat.snapshot", "chat.patch", "chat.status", "chat.usage"]) {
      rpc.on(method, (params: unknown) => {
        if (this.rpc === rpc) this.publish({ event: "bridge", params: { method, params } });
      });
    }
    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      try { void rpc.receive(JSON.parse(data.toString()) as Envelope); } catch { /* malformed message */ }
    });
    socket.on("error", (cause) => { error ??= cause.message; });
    socket.on("close", (code) => {
      rpc.failAll("The bridge disconnected.");
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.rpc = undefined;
      if (code === 4000) {
        this.setState({ conn: "replaced", error: "Another VS Code window connected to the bridge." });
      } else if (code === 4001) {
        this.setState({ conn: "disconnected", error: "The bridge stopped." });
      } else {
        this.setState({ conn: code === 4401 || code === 4400 ? "unpaired" : "disconnected", error: error ?? `Could not connect to the bridge on port ${config.port}.` });
        if (paired) this.retry = setTimeout(() => void this.connect(manual), 1000);
      }
    });
    socket.on("open", async () => {
      try {
        const { agents, bridgeVersion } = await rpc.request<{ agents: AgentInfo[]; bridgeVersion: string }>("hello", {
          token: config.token, wire: WIRE_VERSION, extensionVersion: this.version,
        }, 6000);
        if (this.socket !== socket) return;
        paired = true;
        this.rpc = rpc;
        this.setState({ conn: "connected", agents, bridgeVersion });
      } catch (cause) {
        error = (cause as Error).message;
        socket.close(4401);
      }
    });
  }

  get port(): number { return this.config?.port ?? BRIDGE_DEFAULT_PORT; }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.rpc) return Promise.reject(new Error("Not connected to the bridge."));
    return this.rpc.request(method, params);
  }

  emit(method: string, params: unknown): void { this.rpc?.emit(method, params); }

  dispose(): void {
    this.attempt++;
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    this.rpc = undefined;
    socket?.close();
  }
}
