// The bridge's one listener, bound to loopback:
// - WebSocket /vscode the VS Code extension host: the chat UI, and VS Code's
//                     own notebooks (no browser Origin, token-checked)
// - WebSocket /ext   the browser extension: serves the notebooks open in
//                     Chrome tabs, has no UI (origin- and token-checked)
// - POST /mcp/*      tool relays from agents' MCP servers (per-chat bearer token)
// - GET  /health     liveness

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  DEFAULT_SETTINGS,
  isBrowserOp,
  RpcPeer,
  WIRE_VERSION,
  type AppliedChange,
  type BridgeMethods,
  type ChatMessage,
  type ChatSettings,
  type Envelope,
  type ExtensionEvents,
  type NotebookInfo,
  type NotebookOp,
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
  /** Called on an authorized POST /shutdown, and when the bridge stops for want of VS Code. */
  onShutdown?: () => void;
  /**
   * A bridge started in the background serves VS Code's chat: with no VS Code
   * connected for this long (it closed), it stops. Unset: runs until stopped.
   */
  stopWithoutEditorMs?: number;
}

type ClientKind = "browser" | "vscode";
interface Client {
  connection?: { ws: WebSocket; rpc: RpcPeer };
}

/** Where a chat's notebook is: VS Code's own, or a Chrome tab the browser extension serves. */
interface Target {
  kind: ClientKind;
  tabId: number;
}

export class Bridge {
  private server: Server;
  private wss: WebSocketServer;
  private readonly clients: Record<ClientKind, Client> = { browser: {}, vscode: {} };
  /**
   * Chats live with the editor (VS Code), by the editor's id for their
   * notebook. The browser extension has no chat UI: it only serves the
   * notebooks open in Chrome tabs.
   */
  private readonly chats = new Map<number, Chat>();
  private readonly targets = new Map<Chat, Target>();
  /** Notebooks open in Chrome tabs, for the editor's picker. */
  private readonly browserNotebooks = new Map<number, NotebookInfo>();
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
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const kind = path === "/ext" && this.originAllowed(req.headers.origin) ? "browser"
        : path === "/vscode" && req.headers.origin === undefined ? "vscode" : undefined;
      if (!isLoopback(req) || !kind) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws, kind));
    });
    // Keeps the extension's service worker alive and detects dead sockets.
    this.pingTimer = setInterval(() => {
      for (const client of Object.values(this.clients)) client.connection?.rpc.emit("ping", { t: Date.now() });
    }, 20_000);
    this.pingTimer.unref();
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, "127.0.0.1", () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.watchEditor();
        resolve(this.port);
      });
    });
  }

  /** While no VS Code is connected: count down to stopping (background bridges only). */
  private editorGone?: ReturnType<typeof setTimeout>;

  private watchEditor(): void {
    const ms = this.opts.stopWithoutEditorMs;
    if (ms === undefined || this.clients.vscode.connection || this.editorGone) return;
    this.editorGone = setTimeout(() => {
      this.editorGone = undefined;
      if (this.clients.vscode.connection) return;
      this.log(`No VS Code connected for ${Math.round(ms / 1000)} s: stopping.`);
      this.opts.onShutdown?.();
    }, ms);
  }

  async close(): Promise<void> {
    clearTimeout(this.editorGone);
    clearInterval(this.pingTimer);
    this.dropAllChats();
    for (const client of Object.values(this.clients)) {
      // Tells the extensions not to reconnect (or start a new bridge) by themselves.
      client.connection?.ws.close(4001, "stopped");
    }
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private originAllowed(origin: string | undefined): boolean {
    if (!origin) return false;
    if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return true;
    return this.opts.allowOrigins?.includes(origin) ?? false;
  }

  // ------------------------------------------------------------ extension link

  private onExtension(ws: WebSocket, kind: ClientKind): void {
    const client = this.clients[kind];
    let authed = false;
    const rpc = new RpcPeer({ send: (env: Envelope) => ws.send(JSON.stringify(env)), timeoutMs: 30_000 });
    const authTimer = setTimeout(() => !authed && ws.close(4401, "no hello"), 10_000);

    rpc.handle("hello", (p: ParamsOf<BridgeMethods, "hello">) => {
      if (authed) throw new Error("Already paired.");
      if (typeof p?.token !== "string" || !safeEqual(p.token, this.opts.token)) {
        setTimeout(() => ws.close(4401, "bad token"), 50);
        throw new Error("Pairing token does not match. Copy it from the bridge's console (or run `ainb token`).");
      }
      if (p.wire !== WIRE_VERSION) {
        setTimeout(() => ws.close(4400, "version"), 50);
        throw new Error(`Extension speaks wire v${p.wire}, bridge speaks v${WIRE_VERSION}. Update both to the same release.`);
      }
      authed = true;
      clearTimeout(authTimer);
      const previous = client.connection;
      if (previous) {
        this.log(`A newer ${kind} connection replaced the previous one.`);
        if (kind === "vscode") this.dropAllChats();
        else this.forgetBrowserNotebooks();
        previous.ws.close(4000, "replaced");
      }
      client.connection = { ws, rpc };
      if (kind === "vscode") {
        clearTimeout(this.editorGone);
        this.editorGone = undefined;
      }
      this.log(`${kind} extension connected.`);
      return { bridgeVersion: BRIDGE_VERSION, agents: describeAgents() };
    });
    const isCurrent = () => client.connection?.rpc === rpc;
    if (kind === "vscode") this.registerEditor(rpc, isCurrent);
    this.registerNotebookHost(kind, rpc, isCurrent);

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
      if (client.connection?.ws === ws) {
        client.connection = undefined;
        // The chats are the editor's: they go with it. Chats on Chrome tabs
        // wait for the browser to come back (it announces its tabs again).
        if (kind === "vscode") this.dropAllChats();
        else this.forgetBrowserNotebooks();
        this.log(`${kind} extension disconnected.`);
        if (kind === "vscode") this.watchEditor();
      }
    });
    ws.on("error", () => {});
  }

  /** The editor: chats, agents, and the notebooks open in Chrome tabs. */
  private registerEditor(rpc: RpcPeer, authed: () => boolean): void {
    const guard =
      <K extends keyof BridgeMethods>(fn: (p: ParamsOf<BridgeMethods, K>) => unknown) =>
      (p: ParamsOf<BridgeMethods, K>) => {
        if (!authed()) throw new Error("not paired");
        return fn(p);
      };

    const changed = () => this.toEditor("agents.changed", { agents: describeAgents() });
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
        this.toEditor("chat.snapshot", chat.snapshot());
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
        const target: Target = Number.isSafeInteger(p.browserTab) ? { kind: "browser", tabId: p.browserTab! } : { kind: "vscode", tabId: p.tabId };
        const existing = this.chats.get(p.tabId);
        const sameTarget = !!existing && sameAs(this.targets.get(existing), target);
        if (existing && sameTarget && existing.spec.id === p.agentId && existing.notebookKey === key && existing.status !== "closed") return existing.snapshot();
        let carried: ChatMessage[] = [];
        let journal: Record<string, AppliedChange[]> | undefined;
        let note: string | undefined;
        if (existing) {
          this.dropChat(existing);
          // Same notebook, other agent: hand the conversation over.
          if (existing.notebookKey === key) {
            carried = existing.messages;
            journal = existing.journalEntries();
          }
        }
        if (!carried.length && key) {
          const stored = this.store.load(key);
          if (stored?.messages.length) {
            carried = stored.messages;
            journal = stored.journal;
            note = `Restored the earlier conversation about this notebook. ${spec.name} starts a new session and gets a summary of it.`;
          }
        }
        const chat = new Chat(p.tabId, spec, sanitizeSettings(p.settings), this.chatHost(target), { notebookKey: key, carried, note, journal });
        this.chats.set(p.tabId, chat);
        this.targets.set(chat, target);
        if (target.kind === "browser") chat.notebook = this.browserNotebooks.get(target.tabId) ?? null;
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
    rpc.handle("chat.undo", guard<"chat.undo">((p) => this.chatById(p.chatId).undo(String(p.messageId))));
    rpc.handle(
      "browser.notebooks",
      guard<"browser.notebooks">(() => ({ notebooks: [...this.browserNotebooks].map(([tabId, info]) => ({ tabId, info })) })),
    );
    rpc.handle(
      "browser.op",
      guard<"browser.op">((p) => {
        if (!isBrowserOp(p.op)) throw new Error("This operation is not available on a browser notebook.");
        if (!this.browserNotebooks.has(p.tabId)) throw new Error("That notebook is no longer open in Chrome.");
        return this.notebookOp({ kind: "browser", tabId: p.tabId }, p.op);
      }),
    );
  }

  /** Events and requests from whoever holds notebooks: VS Code for its own, the browser for its tabs. */
  private registerNotebookHost(kind: ClientKind, rpc: RpcPeer, authed: () => boolean): void {
    const browser = kind === "browser";
    rpc.handle("tab.closed", (p: ParamsOf<BridgeMethods, "tab.closed">) => {
      if (!authed()) throw new Error("not paired");
      if (browser) this.setBrowserNotebook(p.tabId, null);
      for (const chat of this.chatsOn(kind, p.tabId)) this.dropChat(chat);
      return { ok: true as const };
    });
    rpc.on("notebook.event", (p: ExtensionEvents["notebook.event"]) => {
      if (!authed()) return;
      for (const chat of this.chatsOn(kind, p.tabId)) chat.onNotebookEvent(p.event);
    });
    rpc.on("notebook.attached", (p: ExtensionEvents["notebook.attached"]) => {
      if (!authed()) return;
      if (browser) this.setBrowserNotebook(p.tabId, p.info);
      for (const chat of this.chatsOn(kind, p.tabId)) {
        if (chat.notebookKey && p.info?.key && chat.notebookKey !== p.info.key) {
          // Another notebook now fills this tab. The chat belongs to the old one:
          // save and close it so its agent cannot edit the new notebook.
          this.dropChat(chat);
          this.toEditor("chat.snapshot", chat.snapshot());
          continue;
        }
        chat.notebook = p.info;
      }
    });
    rpc.on("notebook.detached", (p: ExtensionEvents["notebook.detached"]) => {
      if (!authed()) return;
      if (browser) this.setBrowserNotebook(p.tabId, null);
      for (const chat of this.chatsOn(kind, p.tabId)) chat.onNotebookDetached();
    });
    rpc.on("notebook.focused", (p: ExtensionEvents["notebook.focused"]) => {
      if (authed() && browser && this.browserNotebooks.has(p.tabId)) this.toEditor("browser.focused", { tabId: p.tabId });
    });
  }

  private setBrowserNotebook(tabId: number, info: NotebookInfo | null): void {
    if (info) this.browserNotebooks.set(tabId, info);
    else if (!this.browserNotebooks.delete(tabId)) return;
    this.toEditor("browser.notebook", { tabId, info });
  }

  private forgetBrowserNotebooks(): void {
    for (const tabId of [...this.browserNotebooks.keys()]) this.setBrowserNotebook(tabId, null);
  }

  private chatsOn(kind: ClientKind, tabId: number): Chat[] {
    return [...this.chats.values()].filter((chat) => sameAs(this.targets.get(chat), { kind, tabId }));
  }

  private toEditor(event: string, params: unknown): void {
    this.clients.vscode.connection?.rpc.emit(event, params);
  }

  private chatById(id: string): Chat {
    for (const c of this.chats.values()) if (c.id === id) return c;
    throw new Error("This chat no longer exists. Start a new one.");
  }

  private dropChat(chat: Chat, opts: { forget?: boolean } = {}): void {
    chat.close(opts);
    this.byToken.delete(chat.mcpToken);
    this.targets.delete(chat);
    if (this.chats.get(chat.tabId) === chat) this.chats.delete(chat.tabId);
  }

  private dropAllChats(): void {
    for (const chat of [...this.chats.values()]) this.dropChat(chat);
  }

  private notebookOp(target: Target, op: NotebookOp, timeoutMs?: number): Promise<unknown> {
    const connection = this.clients[target.kind].connection;
    if (!connection) {
      return Promise.reject(new Error(target.kind === "browser"
        ? "The browser extension is not connected to the bridge. Open Chrome with the notebook's tab."
        : "The notebook editor is not connected to the bridge."));
    }
    return connection.rpc.request("notebook.op", { tabId: target.tabId, op }, timeoutMs);
  }

  private chatHost(target: Target): ChatHost {
    return {
      workspaceRoot: join(dataDir(), "workspaces"),
      notebookOp: (_tabId, op, timeoutMs) => this.notebookOp(target, op as NotebookOp, timeoutMs),
      emit: (event, params) => this.toEditor(event, params),
      persist: (chat, sync) => {
        if (!chat.notebookKey || !chat.messages.length) return;
        const data = { key: chat.notebookKey, agentId: chat.spec.id, title: chat.notebook?.title, messages: chat.messages, journal: chat.journalEntries() };
        const failed = (e: unknown) => this.log(`Could not save the chat transcript: ${(e as Error).message}`);
        try {
          if (sync) this.store.save(data);
          else this.store.saveAsync(data).catch(failed);
        } catch (e) {
          failed(e);
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
      return json(res, 200, { ok: true, version: BRIDGE_VERSION, extension: !!(this.clients.browser.connection || this.clients.vscode.connection) });
    }
    if (!isLoopback(req) || req.method !== "POST" || !(url.pathname.startsWith("/mcp/") || url.pathname === "/shutdown")) return json(res, 404, { error: "not found" });
    // Browsers attach Origin to cross-site requests; the relay is for local processes only.
    if (req.headers.origin) return json(res, 403, { error: "forbidden" });
    const auth = req.headers.authorization ?? "";
    if (url.pathname === "/shutdown") {
      // `ainb stop`, for a bridge running in the background with no console to Ctrl+C.
      if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), this.opts.token)) return json(res, 401, { error: "bad token" });
      json(res, 200, { ok: true });
      setTimeout(() => this.opts.onShutdown?.(), 50);
      return;
    }
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

function sameAs(a: Target | undefined, b: Target): boolean {
  return !!a && a.kind === b.kind && a.tabId === b.tabId;
}

function sanitizeSettings(s: Partial<ChatSettings> | undefined): ChatSettings {
  const scope = s?.scope === "cell" || s?.scope === "write" || s?.scope === "auto" ? s.scope : DEFAULT_SETTINGS.scope;
  return {
    scope,
    review: typeof s?.review === "boolean" ? s.review : DEFAULT_SETTINGS.review,
    targetCellIds: Array.isArray(s?.targetCellIds) ? s!.targetCellIds.filter((x) => typeof x === "string").slice(0, 50) : [],
    notebookOnly: typeof s?.notebookOnly === "boolean" ? s.notebookOnly : DEFAULT_SETTINGS.notebookOnly,
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
