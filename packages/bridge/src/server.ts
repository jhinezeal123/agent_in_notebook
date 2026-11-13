// The bridge's one listener, bound to loopback:
// - WebSocket /ext   the browser extension (origin- and token-checked)
// - POST /mcp/*      tool relays from agents' MCP servers (per-chat bearer token)
// - GET  /health     liveness

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  DEFAULT_SETTINGS,
  RpcPeer,
  WIRE_VERSION,
  type BridgeMethods,
  type ChatMessage,
  type ChatSettings,
  type Envelope,
  type ExtensionEvents,
  type ParamsOf,
} from "@ainb/protocol";
import { describeAgents, findAgent } from "./agents/registry.js";
import { Chat, type ChatHost } from "./chat.js";
import { BRIDGE_VERSION, dataDir, removeCustomAgent } from "./config.js";
import { saveAgent, testAgent } from "./agents/manage.js";
import { listTools } from "./notebook/tools.js";
import { ChatStore, pruneDir } from "./store.js";

/** Saved transcripts and agent working directories untouched this long are deleted at startup. */
const KEEP_MS = 30 * 24 * 3600_000;
/** Leftovers of "Test connection" (normally removed right away). */
const PROBE_KEEP_MS = 3600_000;

export interface BridgeOptions {
  port: number;
  token: string;
  /** How agents launch the MCP relay: normally `node <cli.js> mcp`. */
  mcpCommand: { command: string; args: string[] };
  /** Extra allowed WebSocket origins besides chrome-extension://. */
  allowOrigins?: string[];
  log?: (msg: string) => void;
}

export class Bridge {
  private server: Server;
  private wss: WebSocketServer;
  private ext: { ws: WebSocket; rpc: RpcPeer } | null = null;
  private chats = new Map<number, Chat>();
  private byToken = new Map<string, Chat>();
  private pingTimer: ReturnType<typeof setInterval>;
  private readonly log: (msg: string) => void;
  private readonly store: ChatStore;
  port = 0;

  constructor(private readonly opts: BridgeOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.store = new ChatStore(join(dataDir(), "chats"));
    try {
      this.store.prune(KEEP_MS);
      const workspaces = join(dataDir(), "workspaces");
      pruneDir(workspaces, KEEP_MS);
      pruneDir(workspaces, PROBE_KEEP_MS, (name) => !name.startsWith("probe-"));
    } catch (e) {
      this.log(`Could not clean old data: ${(e as Error).message}`);
    }
    this.server = createServer((req, res) => void this.onHttp(req, res));
    // Tool calls can wait on the user for minutes.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    this.server.on("upgrade", (req, socket, head) => {
      if (!isLoopback(req) || new URL(req.url ?? "/", "http://x").pathname !== "/ext" || !this.originAllowed(req.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws));
    });
    // Keeps the extension's service worker alive and detects dead sockets.
    this.pingTimer = setInterval(() => this.ext?.rpc.emit("ping", { t: Date.now() }), 20_000);
    this.pingTimer.unref();
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, "127.0.0.1", () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : this.opts.port;
        resolve(this.port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const c of this.chats.values()) c.close();
    this.chats.clear();
    this.ext?.ws.close();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private originAllowed(origin: string | undefined): boolean {
    if (!origin) return false;
    if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return true;
    return this.opts.allowOrigins?.includes(origin) ?? false;
  }

  // ------------------------------------------------------------ extension link

  private onExtension(ws: WebSocket): void {
    let authed = false;
    const rpc = new RpcPeer({ send: (env: Envelope) => ws.send(JSON.stringify(env)), timeoutMs: 30_000 });
    const authTimer = setTimeout(() => !authed && ws.close(4401, "no hello"), 10_000);

    rpc.handle("hello", (p: ParamsOf<BridgeMethods, "hello">) => {
      if (!safeEqual(p?.token ?? "", this.opts.token)) {
        setTimeout(() => ws.close(4401, "bad token"), 50);
        throw new Error("Pairing token does not match. Copy it from the bridge's console (or run `ainb token`).");
      }
      if (p.wire !== WIRE_VERSION) {
        setTimeout(() => ws.close(4400, "version"), 50);
        throw new Error(`Extension speaks wire v${p.wire}, bridge speaks v${WIRE_VERSION}. Update both to the same release.`);
      }
      authed = true;
      clearTimeout(authTimer);
      if (this.ext && this.ext.ws !== ws) {
        this.log("A newer extension connection replaced the previous one.");
        this.ext.ws.close(4000, "replaced");
      }
      this.ext = { ws, rpc };
      this.log("Extension connected.");
      return { bridgeVersion: BRIDGE_VERSION, agents: describeAgents() };
    });
    this.registerMethods(rpc, () => authed);

    ws.on("message", (data) => {
      let env: Envelope;
      try {
        env = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed && !(env.kind === "req" && env.method === "hello")) return;
      void rpc.receive(env);
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      rpc.failAll("extension disconnected");
      if (this.ext?.ws === ws) {
        this.ext = null;
        this.log("Extension disconnected.");
      }
    });
    ws.on("error", () => {});
  }

  private registerMethods(rpc: RpcPeer, authed: () => boolean): void {
    const guard =
      <K extends keyof BridgeMethods>(fn: (p: ParamsOf<BridgeMethods, K>) => unknown) =>
      (p: ParamsOf<BridgeMethods, K>) => {
        if (!authed()) throw new Error("not paired");
        return fn(p);
      };

    const changed = () => this.ext?.rpc.emit("agents.changed", { agents: describeAgents() });
    const checkIdle = (id: string | undefined) => {
      for (const chat of this.chats.values()) {
        if (chat.spec.id === id && (chat.status === "running" || chat.status === "starting")) throw new Error("Wait for this agent to finish starting or stop its turn before editing it.");
      }
    };
    const invalidate = (id: string) => {
      for (const chat of this.chats.values()) {
        if (chat.spec.id !== id) continue;
        chat.close();
        this.byToken.delete(chat.mcpToken);
        this.ext?.rpc.emit("chat.snapshot", chat.snapshot());
      }
    };
    rpc.handle("agents.list", guard<"agents.list">((p) => {
      const agents = describeAgents();
      if (p.refresh) changed();
      return { agents };
    }));
    rpc.handle("agents.save", guard<"agents.save">((p) => {
      checkIdle(p.id);
      const agent = saveAgent(p);
      if (p.id) invalidate(p.id);
      changed();
      return { agent };
    }));
    rpc.handle("agents.remove", guard<"agents.remove">((p) => {
      checkIdle(p.id);
      const removed = removeCustomAgent(p.id);
      if (removed) invalidate(p.id);
      changed();
      return { removed };
    }));
    rpc.handle("agents.test", guard<"agents.test">((p) => testAgent(p.launchCommand)));

    rpc.handle(
      "chat.open",
      guard<"chat.open">(async (p) => {
        const spec = findAgent(p.agentId);
        if (!spec) throw new Error(`Unknown agent ${p.agentId}`);
        const key = typeof p.notebookKey === "string" && p.notebookKey ? p.notebookKey.slice(0, 2000) : undefined;
        const existing = this.chats.get(p.tabId);
        if (existing && existing.spec.id === p.agentId && existing.notebookKey === key && existing.status !== "closed") return existing.snapshot();
        let carried: ChatMessage[] = [];
        let note: string | undefined;
        if (existing) {
          this.dropChat(existing);
          // Same notebook, other agent: hand the conversation over.
          if (existing.notebookKey === key) carried = existing.messages;
        }
        if (!carried.length && key) {
          const stored = this.store.load(key);
          if (stored?.messages.length) {
            carried = stored.messages;
            note = `Restored the earlier conversation about this notebook. ${spec.name} starts a new session and gets a summary of it.`;
          }
        }
        const chat = new Chat(p.tabId, spec, sanitizeSettings(p.settings), this.chatHost(), { notebookKey: key, carried, note });
        this.chats.set(p.tabId, chat);
        this.byToken.set(chat.mcpToken, chat);
        chat.ensureStarted().catch((e) => this.log(`${spec.name} failed to start: ${(e as Error).message.split("\n")[0]}`));
        return chat.snapshot();
      }),
    );
    rpc.handle("chat.get", guard<"chat.get">((p) => this.chats.get(p.tabId)?.snapshot() ?? null));
    rpc.handle(
      "chat.send",
      guard<"chat.send">((p) => {
        const chat = this.chatById(p.chatId);
        if (!p.text.trim()) throw new Error("empty message");
        chat.send(p.text);
        return { accepted: true };
      }),
    );
    rpc.handle("chat.cancel", guard<"chat.cancel">(async (p) => ({ cancelled: await this.chatById(p.chatId).cancel() })));
    rpc.handle(
      "chat.close",
      guard<"chat.close">((p) => {
        // "New chat": the user starts over, so the saved transcript goes too.
        const chat = this.chatById(p.chatId);
        this.dropChat(chat, { forget: true });
        if (chat.notebookKey) this.store.remove(chat.notebookKey);
        return { closed: true };
      }),
    );
    rpc.handle(
      "chat.settings",
      guard<"chat.settings">((p) => {
        const chat = this.chatById(p.chatId);
        chat.updateSettings(sanitizeSettings(p.settings));
        return chat.snapshot();
      }),
    );
    rpc.handle(
      "chat.option",
      guard<"chat.option">(async (p) => {
        const chat = this.chatById(p.chatId);
        await chat.setOption(p.optionId, p.value);
        return chat.snapshot();
      }),
    );
    rpc.handle("chat.answer", guard<"chat.answer">((p) => ({ answered: this.chatById(p.chatId).answer(p.promptId, p.optionId) })));
    rpc.handle("chat.review", guard<"chat.review">(async (p) => ({ resolved: await this.chatById(p.chatId).resolveReview(p.reviewId, p.accept) })));
    rpc.handle(
      "tab.closed",
      guard<"tab.closed">((p) => {
        const chat = this.chats.get(p.tabId);
        if (chat) this.dropChat(chat);
        return { ok: true as const };
      }),
    );

    rpc.on("notebook.event", (p: ExtensionEvents["notebook.event"]) => {
      if (authed()) this.chats.get(p.tabId)?.onNotebookEvent(p.event);
    });
    rpc.on("notebook.attached", (p: ExtensionEvents["notebook.attached"]) => {
      const chat = authed() ? this.chats.get(p.tabId) : undefined;
      if (!chat) return;
      if (chat.notebookKey && p.info?.key && chat.notebookKey !== p.info.key) {
        // Another notebook now fills this tab. The chat belongs to the old one:
        // save and close it so its agent cannot edit the new notebook.
        this.dropChat(chat);
        this.ext?.rpc.emit("chat.snapshot", chat.snapshot());
        return;
      }
      chat.notebook = p.info;
    });
    rpc.on("notebook.detached", (p: ExtensionEvents["notebook.detached"]) => {
      const chat = authed() ? this.chats.get(p.tabId) : undefined;
      chat?.onNotebookDetached();
    });
  }

  private chatById(id: string): Chat {
    for (const c of this.chats.values()) if (c.id === id) return c;
    throw new Error("This chat no longer exists. Start a new one.");
  }

  private dropChat(chat: Chat, opts: { forget?: boolean } = {}): void {
    chat.close(opts);
    this.byToken.delete(chat.mcpToken);
    if (this.chats.get(chat.tabId) === chat) this.chats.delete(chat.tabId);
  }

  private chatHost(): ChatHost {
    return {
      workspaceRoot: join(dataDir(), "workspaces"),
      notebookOp: (tabId, op, timeoutMs) => {
        if (!this.ext) return Promise.reject(new Error("The browser extension is not connected to the bridge."));
        return this.ext.rpc.request("notebook.op", { tabId, op }, timeoutMs);
      },
      emit: (event, params) => this.ext?.rpc.emit(event, params),
      persist: (chat) => {
        if (!chat.notebookKey || !chat.messages.length) return;
        try {
          this.store.save({ key: chat.notebookKey, agentId: chat.spec.id, title: chat.notebook?.title, messages: chat.messages });
        } catch (e) {
          this.log(`Could not save the chat transcript: ${(e as Error).message}`);
        }
      },
      mcpServer: (chatToken): McpServer => ({
        name: "notebook",
        command: this.opts.mcpCommand.command,
        args: this.opts.mcpCommand.args,
        env: [
          { name: "AINB_URL", value: `http://127.0.0.1:${this.port}` },
          { name: "AINB_CHAT_TOKEN", value: chatToken },
          ...(process.platform === "win32" && process.env.SystemRoot ? [{ name: "SystemRoot", value: process.env.SystemRoot }] : []),
        ],
      }),
    };
  }

  // ------------------------------------------------------------ MCP relay

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, version: BRIDGE_VERSION, extension: !!this.ext });
    }
    if (!isLoopback(req) || req.method !== "POST" || !url.pathname.startsWith("/mcp/")) return json(res, 404, { error: "not found" });
    // Browsers attach Origin to cross-site requests; the relay is for local processes only.
    if (req.headers.origin) return json(res, 403, { error: "forbidden" });
    const auth = req.headers.authorization ?? "";
    const chat = this.byToken.get(auth.replace(/^Bearer\s+/i, ""));
    if (!chat) return json(res, 401, { error: "unknown chat token" });

    let body: any;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "bad json" });
    }
    if (url.pathname === "/mcp/list") return json(res, 200, { tools: listTools() });
    if (url.pathname === "/mcp/call") {
      const result = await chat.runTool(String(body.name), body.arguments ?? {});
      return json(res, 200, result);
    }
    return json(res, 404, { error: "not found" });
  }
}

function sanitizeSettings(s: Partial<ChatSettings> | undefined): ChatSettings {
  const scope = s?.scope === "cell" || s?.scope === "write" || s?.scope === "auto" ? s.scope : DEFAULT_SETTINGS.scope;
  return {
    scope,
    review: typeof s?.review === "boolean" ? s.review : DEFAULT_SETTINGS.review,
    targetCellIds: Array.isArray(s?.targetCellIds) ? s!.targetCellIds.filter((x) => typeof x === "string").slice(0, 50) : [],
  };
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
