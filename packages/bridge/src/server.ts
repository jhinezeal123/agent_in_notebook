// The bridge's one listener, bound to loopback:
// - WebSocket /vscode the VS Code extension host: the chat UI, and VS Code's
//                     own notebooks (no browser Origin, token-checked)
// - WebSocket /ext   the browser extension: serves the notebooks open in
//                     Chrome tabs, has no UI (origin- and token-checked)
// - POST /mcp/*      tool relays from agents' MCP servers (per-chat bearer token)
// - POST /mentor/verify  check Mentor exercises on a notebook open in Chrome
//                     (`ainb mentor verify`; pairing token; answers in NDJSON lines)
// - POST /mentor/reload  read the Mentor catalog again (`ainb mentor reload`; pairing token)
// - GET  /health     liveness

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  ATTACHED_CELLS_MAX,
  DEFAULT_SETTINGS,
  FINAL_RUN_STATUSES,
  isBrowserOp,
  RpcPeer,
  WIRE_VERSION,
  type AppliedChange,
  type ExecResult,
  type AttachedCell,
  type BridgeMethods,
  type ChatMessage,
  type ChatSettings,
  type Envelope,
  type ExtensionEvents,
  type MentorHome,
  type MentorPaper,
  type MentorToday,
  type NotebookInfo,
  type NotebookOp,
  type ParamsOf,
  type ResearchRun,
  readerChatKey,
} from "@ainb/protocol";
import { describeAgents, findAgent } from "./agents/registry.js";
import { Chat, type ChatHost, type ChatProjectHost } from "./chat.js";
import { BRIDGE_VERSION, dataDir, loadResearchConfig, removeCustomAgent, saveResearchConfig } from "./config.js";
import { Orx, type OrxOptions } from "./research/orx.js";
import { saveAgent, testAgent } from "./agents/manage.js";
import { listTools } from "./notebook/tools.js";
import { PROJECT_TOOLS } from "./project/tools.js";
import { ProjectLinks } from "./research/links.js";
import { describeFailure, ResearchProjects } from "./research/projects.js";
import { KaggleQuotaWatcher } from "./research/quota.js";
import { forgetSetup, runSetup } from "./notebook/setup.js";
import { ChatStore, pruneDir } from "./store.js";
import { MentorChat, WorkshopChat, mentorOf, requireMentor, workshopOf } from "./mentor/chat.js";
import { Mentor } from "./mentor/index.js";
import { MentorPlaces } from "./mentor/place.js";
import { MentorSession } from "./mentor/session.js";
import { loadCatalog } from "./mentor/catalog.js";
import { referenceContext, trainsOnGpu, verifyExercise } from "./mentor/verify.js";
import { KernelPool } from "./mentor/pool.js";
import { fetchArxiv, paperIdFor, parseArxivId, pdfChunkCode, pdfExtractCode, pdfMarked, readSliceCode, type PaperSource } from "./mentor/fetch.js";
import { authorChatKey } from "./mentor/place.js";
import { WorkshopHub, WorkshopSession, type AuthorChat } from "./mentor/workshop.js";
import { slugOf } from "./mentor/papers.js";
import { ReaderHub } from "./reader/index.js";
import { readerLab } from "./reader/lab.js";
import { qualityStats, runPaperQuiz } from "./reader/eval.js";
import { ReaderChat, readerOf } from "./reader/chat.js";
import { paperEventId } from "./mentor/model.js";
import type { ChatRole } from "./chat-role.js";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** Saved transcripts and agent working directories untouched this long are deleted at startup. */
const KEEP_MS = 30 * 24 * 3600_000;
/** Which project a notebook belongs to is kept longer than its conversation. */
const META_KEEP_MS = 180 * 24 * 3600_000;
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
  /** How OpenResearch is found and run (tests replace orx with a stand-in). */
  research?: Pick<OrxOptions, "locate" | "knownPorts" | "startTimeoutMs">;
}

type ClientKind = "browser" | "vscode";
interface ClientConnection {
  ws: WebSocket;
  rpc: RpcPeer;
  missedPongs: number;
  snapshotPending: boolean;
}
interface Client {
  connection?: ClientConnection;
}

const WS_DROP_PATCH_BYTES = 8 * 1024 * 1024;
const WS_CLOSE_BACKPRESSURE_BYTES = 64 * 1024 * 1024;
const WS_MAX_MISSED_PONGS = 3;

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
  /** Last boot id seen per chat, so adoptRenamed runs on open / boot change instead of every poll. */
  private readonly seenBoot = new WeakMap<Chat, string>();
  /** Debounced mentor.updated timer (A7.1) so rapid events trigger one home/status refresh. */
  private mentorUpdateTimer?: ReturnType<typeof setTimeout>;
  private emitMentorUpdated(): void {
    if (this.mentorUpdateTimer) clearTimeout(this.mentorUpdateTimer);
    this.mentorUpdateTimer = setTimeout(() => {
      this.mentorUpdateTimer = undefined;
      this.toEditor("mentor.updated", {});
    }, 300);
    this.mentorUpdateTimer.unref?.();
  }
  private readonly notifiedRuns = new Set<string>();
  /** Proactive Kaggle quota & idle session watcher (never starts orx). */
  readonly quota: KaggleQuotaWatcher;
  /** Notebooks open in Chrome tabs, for the editor's picker. */
  private readonly browserNotebooks = new Map<number, NotebookInfo>();
  private readonly verifying = new Set<string>();
  private byToken = new Map<string, Chat>();
  private pingTimer: ReturnType<typeof setInterval>;
  private readonly log: (msg: string) => void;
  private readonly store: ChatStore;
  /** OpenResearch, run hidden for the editor's research views; started on first use. */
  readonly orx: Orx;
  /** The OpenResearch projects notebooks belong to. */
  readonly links: ProjectLinks;
  /** Mentor: exercises, the learner's log and ratings. */
  readonly mentor: Mentor;
  /** The notebooks in Chrome exercises are written into. */
  readonly mentorPlaces: MentorPlaces;
  /** Paper workshops: plans, and the exercises being written. */
  readonly workshops: WorkshopHub;
  /** Easy-read: papers being read, beside their tutor's chat. */
  readonly reader: ReaderHub;
  port = 0;

  constructor(private readonly opts: BridgeOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.store = new ChatStore(join(dataDir(), "chats"));
    this.orx = new Orx({
      ...opts.research,
      log: (m) => this.log(m),
      onStatus: (status) => {
        this.toEditor("research.status", status);
        if (status.state === "ready") void this.quota.check(false).catch(() => {});
      },
      onRun: (run) => this.onResearchRun(run),
    });
    this.links = new ProjectLinks(this.store, new ResearchProjects(this.orx, (m) => this.log(m)), (m) => this.log(m));
    this.quota = new KaggleQuotaWatcher(this.orx, {
      onUpdate: (status) => this.toEditor("research.quota", status),
      log: (m) => this.log(m),
    });
    this.quota.start();
    this.mentor = new Mentor({ dir: join(dataDir(), "mentor"), onChange: () => this.emitMentorUpdated(), log: (m) => this.log(m) });
    this.workshops = new WorkshopHub(this.mentor, {
      readerProgress: (paperId) => {
        const p = this.reader.passes.summary(paperId);
        if (!p) return "";
        return `Easy Read progress: pass ${p.pass}; ${p.done}/${p.total} sections read.${p.mastery !== undefined ? ` Delayed checkpoint mastery: ${Math.round(100 * p.mastery)}%.` : ""}${p.weak.length ? ` Concepts flagged for review: ${JSON.stringify(p.weak)}.` : ""} Use this to tailor the reproduction plan.`;
      },
      authorChat: (paperId, tabId) => this.authorChat(paperId, tabId),
      exec: async (tabId, code, waitMs) => {
        const target: Target = { kind: "browser", tabId };
        const r = await this.notebookOp(target, { op: "execute", code, waitMs }, waitMs + 30_000) as ExecResult;
        if (r.status === "running") await this.notebookOp(target, { op: "interrupt" }).catch(() => {});
        return r;
      },
      say: (paperId, text) => [...this.chats.values()].find((c) => workshopOf(c)?.paperId === paperId && workshopOf(c)!.role === "plan")?.notice(text),
      changed: () => this.toEditor("mentor.updated", {}),
      log: (m) => this.log(m),
    });
    this.reader = new ReaderHub({
      root: this.mentor.shelf.root,
      shelf: {
        paperFor: (arxiv) => this.mentor.papers().find((p) => {
          const id = this.mentor.paperPackage(p.id)?.info.arxiv ?? (p.url ? parseArxivId(p.url) : null);
          return !!id && paperIdFor(id) === paperIdFor(arxiv);
        })?.id,
        arxivOf: (paperId) => {
          const info = this.mentor.paperPackage(paperId)?.info;
          return info?.arxiv ?? (info?.url ? parseArxivId(info.url) ?? undefined : undefined);
        },
        shelve: (p) => {
          if (this.mentor.paperPackage(p.id) || this.mentor.shelf.has(p.id)) return;
          this.mentor.shelf.create({ ...p, status: "shelved" });
          this.mentor.reloadPapers();
          this.emitMentorUpdated();
        },
      },
      emit: (event, params) => this.toEditor(event, params),
      log: (m) => this.log(m),
      // The hidden author and checker of a paper (ER-2), shown nowhere.
      author: () => ({ chat: (paperId, role, kind) => this.readerHiddenChat(paperId, role, kind), log: (m) => this.log(m) }),
      // A misconception about a paper goes into Mentor's book too (asked again in two days).
      misconception: ({ paperId, title, concept, note }) => this.mentor.record({ t: "misconception", attemptId: paperEventId(paperId), tag: `paper:${paperId}:${concept}`.slice(0, 80), note, title: title.slice(0, 200) }),
      learning: (paperId) => {
        if (!this.mentor.status().activeToday) this.mentor.record({ t: "paper", attemptId: paperEventId(paperId), paperId, what: "read" });
      },
    });
    this.mentorPlaces = new MentorPlaces(this.mentor, {
      notebooks: () => this.browserNotebooks,
      op: (tabId, op, timeoutMs) => this.notebookOp({ kind: "browser", tabId }, op, timeoutMs) as never,
      closeChats: (tabId) => {
        for (const chat of this.chatsOn("browser", tabId)) {
          this.dropChat(chat);
          this.toEditor("chat.snapshot", chat.snapshot());
        }
      },
      chats: this.store,
      log: (m) => this.log(m),
    });
    try {
      this.store.prune(KEEP_MS, META_KEEP_MS);
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
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 4 },
    });
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
      for (const [kind, client] of Object.entries(this.clients)) {
        const conn = client.connection;
        if (!conn) continue;
        if (++conn.missedPongs > WS_MAX_MISSED_PONGS) {
          this.log(`${kind} extension stopped answering pings: closing so it can reconnect.`);
          conn.ws.close(4002, "ping timeout");
          continue;
        }
        conn.rpc.emit("ping", { t: Date.now() });
        if (conn.ws.readyState === WebSocket.OPEN) {
          try { conn.ws.ping(); } catch { /* closing */ }
        }
      }
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
    clearTimeout(this.mentorUpdateTimer);
    clearInterval(this.pingTimer);
    this.quota.stop();
    this.dropAllChats();
    this.orx.close();
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
    let conn: ClientConnection | undefined;
    const rpc = new RpcPeer({
      send: (env: Envelope) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const buffered = ws.bufferedAmount;
        if (buffered > WS_CLOSE_BACKPRESSURE_BYTES) {
          this.log(`${kind} socket backed up (${Math.round(buffered / (1024 * 1024))} MB): closing so it can reconnect.`);
          ws.close(4002, "backpressure");
          return;
        }
        if (buffered > WS_DROP_PATCH_BYTES && env.kind === "evt") {
          // Drop intermediate streaming patches under pressure; the UI resyncs via chat.get on any gap.
          if (env.method === "chat.patch") return;
          if (env.method === "chat.snapshot") {
            if (conn?.snapshotPending) return;
            if (conn) conn.snapshotPending = true;
          }
        } else if (conn?.snapshotPending && buffered <= WS_DROP_PATCH_BYTES) {
          conn.snapshotPending = false;
        }
        ws.send(JSON.stringify(env));
      },
      timeoutMs: 30_000,
    });
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
        else {
          this.forgetBrowserNotebooks();
          this.toEditor("browser.status", { connected: false });
        }
        previous.ws.close(4000, "replaced");
      }
      conn = { ws, rpc, missedPongs: 0, snapshotPending: false };
      client.connection = conn;
      if (kind === "vscode") {
        clearTimeout(this.editorGone);
        this.editorGone = undefined;
      } else {
        this.toEditor("browser.status", { connected: true });
      }
      this.log(`${kind} extension connected.`);
      return { bridgeVersion: BRIDGE_VERSION, agents: describeAgents(), browserConnected: !!this.clients.browser.connection };
    });
    const isCurrent = () => client.connection?.rpc === rpc;
    if (kind === "vscode") this.registerEditor(rpc, isCurrent);
    this.registerNotebookHost(kind, rpc, isCurrent);

    ws.on("pong", () => {
      if (conn) conn.missedPongs = 0;
    });
    ws.on("message", (data) => {
      if (conn) conn.missedPongs = 0;
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
        else {
          this.forgetBrowserNotebooks();
          this.toEditor("browser.status", { connected: false });
        }
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

    const changed = () => this.toEditor("agents.changed", { agents: describeAgents(true) });
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
      const agents = describeAgents(!!p.refresh);
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
        // A paper's tutor (easy-read): its chat follows the paper, beside the paper's tab.
        const readerId = typeof p.reader?.paperId === "string" && p.reader.paperId ? p.reader.paperId : undefined;
        if (readerId && !this.reader.has(readerId)) throw new Error(`Không có paper ${readerId} để đọc.`);
        const key = readerId ? readerChatKey(readerId) : typeof p.notebookKey === "string" && p.notebookKey ? p.notebookKey.slice(0, 2000) : undefined;
        const target: Target = !readerId && Number.isSafeInteger(p.browserTab) ? { kind: "browser", tabId: p.browserTab! } : { kind: "vscode", tabId: p.tabId };
        const existing = this.chats.get(p.tabId);
        const sameTarget = !!existing && sameAs(this.targets.get(existing), target);
        const override = typeof p.projectId === "string" && p.projectId ? p.projectId : undefined;
        if (existing && sameTarget && existing.spec.id === p.agentId && existing.notebookKey === key && existing.status !== "closed") {
          if (key && override && override !== existing.project?.id) await this.linkNotebook(key, override);
          return existing.snapshot();
        }
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
        const info = target.kind === "browser" ? this.browserNotebooks.get(target.tabId) : undefined;
        // A Mentor exercise's notebook: the agent coaches; it belongs to no project.
        const mentor = readerId ? undefined : this.mentorSession(target, key);
        const workshop = mentor || readerId ? undefined : this.workshopSession(target, key);
        const tutor = !!mentor || !!workshop || !!readerId;
        // The bridge decides the notebook's project (its meta file); the editor only overrides it.
        const project = key && !tutor ? this.links.initial(key, { projectId: override, title: info?.title, url: info?.url, platform: p.platform, agentId: p.agentId }) : undefined;
        const chat = new Chat(p.tabId, spec, sanitizeSettings(p.settings), this.chatHost(target, key, tutor), { notebookKey: key, carried, note, journal, project, role: mentor ? new MentorChat(mentor) : workshop ? new WorkshopChat(workshop) : readerId ? new ReaderChat(this.reader, readerId) : undefined });
        this.chats.set(p.tabId, chat);
        this.targets.set(chat, target);
        if (target.kind === "browser") chat.notebook = this.browserNotebooks.get(target.tabId) ?? null;
        this.byToken.set(chat.mcpToken, chat);
        // A Mentor notebook's kernel is left free for the learner and the judge (no machine polling).
        if (!tutor) void chat.refreshMachine();
        chat.ensureStarted().catch((e) => this.log(`${spec.name} failed to start: ${(e as Error).message.split("\n")[0]}`));
        if (key && !tutor) void this.refreshProject(chat);
        return chat.snapshot();
      }),
    );
    rpc.handle(
      "notebook.link",
      guard<"notebook.link">(async (p) => {
        if (typeof p.notebookKey !== "string" || !p.notebookKey || typeof p.projectId !== "string" || !p.projectId) throw new Error("A notebook and a project are needed.");
        const project = await this.linkNotebook(p.notebookKey.slice(0, 2000), p.projectId, { title: p.title, url: p.url, platform: p.platform });
        return { project };
      }),
    );
    rpc.handle("notebook.project", guard<"notebook.project">((p) => ({ projectId: this.store.loadMeta(String(p.notebookKey))?.projectId ?? this.links.projects.scratchId() ?? null })));
    rpc.handle(
      "chats.list",
      guard<"chats.list">((p) => {
        const open = new Map([...this.chats.values()].filter((c) => c.notebookKey).map((c) => [c.notebookKey!, c.tabId]));
        const chats = this.links.list(String(p.projectId))
          .filter((c) => !this.isMentorNotebook(c.notebookKey))
          .map((c) => (open.has(c.notebookKey) ? { ...c, tabId: open.get(c.notebookKey) } : c));
        return { chats };
      }),
    );
    rpc.handle("chats.search", guard<"chats.search">((p) => ({ hits: this.store.search(String(p.query ?? ""), p.limit) })));
    rpc.handle("chat.saveNotebook", guard<"chat.saveNotebook">(async (p) => ({ path: await this.chatById(p.chatId).saveNotebookNow() })));
    rpc.handle("chat.verifyNotebook", guard<"chat.verifyNotebook">(async (p) => {
      await this.chatById(p.chatId).verifyAndSave();
      return { started: true };
    }));
    rpc.handle("chat.pushCode", guard<"chat.pushCode">((p) => this.chatById(p.chatId).pushCode()));
    rpc.handle("chat.get", guard<"chat.get">((p) => this.chats.get(p.tabId)?.snapshot() ?? null));
    rpc.handle(
      "chat.send",
      guard<"chat.send">((p) => {
        const chat = this.chatById(p.chatId);
        if (!p.text.trim()) throw new Error("empty message");
        const cells = sanitizeCells(p.cells);
        chat.send(p.text, cells.length ? { cells } : {});
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
    rpc.handle("chat.changes", guard<"chat.changes">((p) => ({ changes: this.chatById(p.chatId).journalEntries()[String(p.messageId)] ?? [] })));
    rpc.handle("chat.pin", guard<"chat.pin">((p) => ({ pinned: this.chatById(p.chatId).pin(String(p.messageId), !!p.pinned) })));
    rpc.handle("chat.dequeue", guard<"chat.dequeue">((p) => ({ removed: this.chatById(p.chatId).dequeueMessage(String(p.messageId)) })));
    rpc.handle("chat.cardAction", guard<"chat.cardAction">((p) => ({ accepted: this.chatById(p.chatId).cardAction(String(p.cardId), String(p.actionId)) })));
    rpc.handle("notebook.setup", guard<"notebook.setup">((p) => {
      const target: Target = Number.isSafeInteger(p.browserTab) ? { kind: "browser", tabId: p.browserTab! } : { kind: "vscode", tabId: p.tabId };
      const waitMs = Math.min(110, Math.max(5, Number(p.waitSeconds) || 90)) * 1000;
      return runSetup((op, timeoutMs) => this.notebookOp(target, op, timeoutMs), `${target.kind}:${target.tabId}`, String(p.script ?? ""), waitMs);
    }));
    rpc.handle("mentor.home", guard<"mentor.home">(() => this.mentorHome()));
    rpc.handle("mentor.status", guard<"mentor.status">(() => this.mentor.status()));
    rpc.handle("mentor.places", guard<"mentor.places">(() => this.mentorPlaces.list()));
    rpc.handle("mentor.start", guard<"mentor.start">((p) => this.mentorPlaces.start({
      exerciseId: typeof p?.exerciseId === "string" && p.exerciseId ? p.exerciseId : undefined,
      kind: p?.kind === "review" ? "review" : p?.kind === "interview" ? "interview" : "learn",
      tabId: Number.isSafeInteger(p?.tabId) ? p.tabId : undefined,
      replace: p?.replace === true,
    })));
    rpc.handle("mentor.judge", guard<"mentor.judge">(async (p) => {
      // The verdict arrives in the chat; the request only says it started.
      const running = requireMentor(this.chatById(p.chatId)).judge();
      running.catch(() => {});
      await Promise.race([running, new Promise((r) => setTimeout(r, 50))]);
      return { started: true };
    }));
    rpc.handle("mentor.hint", guard<"mentor.hint">((p) => ({ level: requireMentor(this.chatById(p.chatId)).hint() })));
    rpc.handle("mentor.codeReview", guard<"mentor.codeReview">((p) => {
      requireMentor(this.chatById(p.chatId)).codeReview();
      return { started: true };
    }));
    rpc.handle("mentor.stage", guard<"mentor.stage">((p) => {
      const mentor = requireMentor(this.chatById(p.chatId));
      mentor.stage(p.stage);
      return mentor.session.view();
    }));
    rpc.handle("mentor.paper.add", guard<"mentor.paper.add">(async (p) => {
      if (!this.browserNotebooks.has(p.tabId)) throw new Error("Notebook này không còn mở trong Chrome.");
      // Already on the shelf (the same arXiv paper): its workshop moves here.
      const arxiv = "arxiv" in p.source ? parseArxivId(p.source.arxiv) : null;
      const known = arxiv ? paperIdFor(arxiv) : undefined;
      if (known && this.mentor.shelf.has(known)) return this.mentorPlaces.openWorkshop(known, p.tabId, p.replace);
      const src = await this.paperSource(p.source, p.tabId);
      const paperId = this.mentor.shelf.create({
        ...(src.id ? { id: src.id } : {}), title: src.title, ...(src.authors ? { authors: src.authors } : {}), ...(src.year ? { year: src.year } : {}),
        ...(src.url ? { url: src.url } : {}), ...(src.arxiv ? { arxiv: src.arxiv } : {}), source: src.text, kind: src.kind,
      });
      this.mentor.reloadPapers();
      return this.mentorPlaces.openWorkshop(paperId, p.tabId, p.replace);
    }));
    rpc.handle("mentor.paper.open", guard<"mentor.paper.open">((p) => this.mentorPlaces.openWorkshop(p.paperId, p.tabId, p.replace)));
    rpc.handle("mentor.paper.get", guard<"mentor.paper.get">((p) => {
      const pkg = this.mentor.paperPackage(p.paperId);
      if (!pkg) throw new Error(`Không có paper ${p.paperId}.`);
      return this.placedPaper(this.mentor.paperView(pkg));
    }));
    rpc.handle("mentor.paper.approve", guard<"mentor.paper.approve">((p) => {
      const { ws, chat } = this.workshopChat(p.chatId);
      if (chat.isBusy()) throw new Error("Đợi mentor trả lời xong rồi hãy duyệt.");
      const view = this.workshops.approve(ws.paperId);
      this.startAuthoring(p.chatId);
      return view;
    }));
    rpc.handle("mentor.paper.author", guard<"mentor.paper.author">((p) => {
      const { ws } = this.workshopChat(p.chatId);
      this.startAuthoring(p.chatId, { ...(typeof p.slug === "string" ? { slug: p.slug } : {}), retry: !!p.retry });
      return this.workshops.view(ws.paperId);
    }));
    rpc.handle("mentor.paper.stopAuthoring", guard<"mentor.paper.stopAuthoring">(async (p) => {
      const { chat, ws } = this.workshopChat(p.chatId);
      await chat.cancel();
      return this.workshops.view(ws.paperId);
    }));
    rpc.handle("mentor.paper.notes", guard<"mentor.paper.notes">((p) => {
      if (!this.mentor.paperPackage(p.paperId)) throw new Error(`Không có paper ${p.paperId}.`);
      this.mentor.shelf.saveNotes(p.paperId, String(p.notes ?? ""));
      this.toEditor("mentor.updated", {});
      return { ok: true as const };
    }));
    rpc.handle("mentor.paper.archive", guard<"mentor.paper.archive">((p) => {
      if (!this.mentor.shelf.has(p.paperId)) throw new Error("Chỉ cất được paper bạn tự thêm.");
      this.mentor.shelf.write(p.paperId, { archived: !!p.archived });
      this.mentor.reloadPapers();
      return { ok: true as const };
    }));
    rpc.handle("mentor.focus", guard<"mentor.focus">((p) => {
      this.mentor.setFocus(p.focus ?? null);
      return { ok: true as const };
    }));
    rpc.handle("mentor.report", guard<"mentor.report">((p) => {
      const chat = this.chatById(p.chatId);
      this.reportExercise(chat, String(p.reason ?? "").slice(0, 1000));
      return { ok: true as const };
    }));
    rpc.handle("mentor.attempts", guard<"mentor.attempts">((p) => ({
      attempts: this.mentor.attemptHistory({
        ...(typeof p?.exerciseId === "string" && p.exerciseId ? { exerciseId: p.exerciseId } : {}),
        ...(typeof p?.limit === "number" ? { limit: p.limit } : {}),
      }),
    })));
    rpc.handle("mentor.export", guard<"mentor.export">((p) => this.mentor.exportProfile({
      format: p?.format === "json" ? "json" : "markdown",
      includeMistakes: p?.includeMistakes !== false,
    })));
    rpc.handle("mentor.import", guard<"mentor.import">((p) => this.mentor.importProfile(String(p?.data ?? ""))));

    // ---------------------------------------------------------------- easy-read
    rpc.handle("reader.open", guard<"reader.open">((p) => {
      const src = p?.source as Record<string, unknown> | undefined;
      if (typeof src?.arxiv === "string") return this.reader.open({ arxiv: src.arxiv });
      if (typeof src?.pdfPath === "string") return this.reader.open({ pdfPath: src.pdfPath });
      if (typeof src?.paperId === "string") return this.reader.open({ paperId: src.paperId });
      throw new Error("Cần link arXiv, file PDF, hoặc một paper đã đọc.");
    }));
    rpc.handle("reader.get", guard<"reader.get">((p) => this.reader.view(String(p.paperId))));
    rpc.handle("reader.session", guard<"reader.session">((p) => {
      if (p.action !== "start" && p.action !== "end") throw new Error("Chọn bắt đầu hoặc kết thúc buổi đọc.");
      return this.reader.studySession(String(p.paperId), p.action);
    }));
    rpc.handle("reader.list", guard<"reader.list">(() => ({ papers: this.reader.list() })));
    rpc.handle("reader.related", guard<"reader.related">((p) => this.reader.related.get(String(p.paperId))));
    rpc.handle("reader.lab.open", guard<"reader.lab.open">((p) => {
      const paperId = String(p.paperId);
      const widget = String(p.widget);
      return this.mentorPlaces.appendReaderLab(p.tabId, `reader: lab ${paperId} ${widget}`, readerLab(this.reader, paperId, widget));
    }));
    rpc.handle("reader.progress", guard<"reader.progress">((p) => {
      this.readerAgent(String(p.paperId), p.agentId);
      this.reader.progress(String(p.paperId), String(p.section), Number(p.ms));
      return { ok: true as const };
    }));
    rpc.handle("reader.mark", guard<"reader.mark">((p) => this.reader.mark(String(p.paperId), String(p.section), !!p.read)));
    rpc.handle("reader.note", guard<"reader.note">((p) => this.reader.note(String(p.paperId), { ...(p.note ? { note: p.note } : {}), ...(typeof p.remove === "string" ? { remove: p.remove } : {}) })));
    rpc.handle("reader.pdfText", guard<"reader.pdfText">((p) => this.reader.pdfText(String(p.paperId), p.pages, p.title)));
    rpc.handle("reader.rendered", guard<"reader.rendered">((p) => {
      this.reader.rendered(String(p.paperId), p);
      return { ok: true as const };
    }));
    rpc.handle("reader.ask", guard<"reader.ask">((p) => {
      const tutor = readerOf(this.chatById(p.chatId));
      if (!tutor) throw new Error("Chat này không phải gia sư của một paper.");
      tutor.ask(p.kind, p.anchor ?? {}, String(p.quote ?? ""));
      return { accepted: true as const };
    }));
    // Passes 1–2 (ER-2): the goal, the passes, answers, the reader's writing graded by the tutor.
    rpc.handle("reader.guide", guard<"reader.guide">((p) => {
      const paperId = String(p.paperId);
      this.reader.meta(paperId);
      this.readerAgent(paperId, p.agentId);
      this.reader.passes.prepareLater(paperId);
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.appeal", guard<"reader.appeal">((p) => {
      const paperId = String(p.paperId);
      const tutor = readerOf(this.chatById(p.chatId));
      if (!tutor || tutor.paperId !== paperId) throw new Error("Mở chat gia sư của paper này trước.");
      this.reader.passes.appeal(paperId, String(p.write), p.reason, tutor.tutorPort());
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.cards.due", guard<"reader.cards.due">(() => this.reader.cards.due()));
    rpc.handle("reader.cards.keep", guard<"reader.cards.keep">((p) => {
      const paperId = String(p.paperId);
      this.reader.cards.keep(paperId, p.card, p.edit);
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.cards.drop", guard<"reader.cards.drop">((p) => {
      const paperId = String(p.paperId);
      this.reader.cards.drop(paperId, String(p.card));
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.cards.review", guard<"reader.cards.review">((p) => {
      const paperId = String(p.paperId);
      this.reader.cards.review(paperId, String(p.card), p.grade);
      this.emitMentorUpdated();
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.widget.request", guard<"reader.widget.request">((p) => {
      const paperId = String(p.paperId);
      this.readerAgent(paperId, p.agentId);
      this.reader.widgets.request(paperId, p.anchor, p.goal);
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.peer", guard<"reader.peer">((p) => {
      const paperId = String(p.paperId);
      this.reader.meta(paperId);
      this.readerAgent(paperId, p.agentId);
      this.reader.peers.start(paperId, String(p.note), p.persona, (role) => this.readerHiddenChat(paperId, role, `peer:${p.persona}`));
      return { accepted: true };
    }));
    rpc.handle("reader.widget.answer", guard<"reader.widget.answer">((p) => {
      const paperId = String(p.paperId);
      this.reader.requireStudySession(paperId);
      this.reader.widgets.answer(paperId, String(p.id), p.choice);
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("reader.goal", guard<"reader.goal">((p) => {
      this.reader.requireStudySession(String(p.paperId));
      this.readerAgent(String(p.paperId), p.agentId);
      return this.reader.passes.goal(String(p.paperId), p.goal);
    }));
    rpc.handle("reader.pass", guard<"reader.pass">((p) => {
      this.reader.requireStudySession(String(p.paperId));
      this.readerAgent(String(p.paperId), p.agentId);
      return this.reader.passes.pass(String(p.paperId), Number(p.pass) as 1 | 2 | 3 | 4, !!p.done);
    }));
    rpc.handle("reader.answer", guard<"reader.answer">((p) => {
      const paperId = String(p.paperId);
      this.reader.requireStudySession(paperId);
      const choice = p.choice ?? {};
      if (p.pretest) {
        this.reader.passes.pretest(paperId, String(p.item), { ...(choice.options?.length ? { option: choice.options[0] } : {}), ...(typeof choice.text === "string" ? { text: choice.text } : {}) });
        return { guide: this.reader.passes.guide(paperId) };
      }
      const result = this.reader.passes.answer(paperId, String(p.item), choice, Number(p.confidence) as 1 | 2 | 3);
      return { result, guide: this.reader.passes.guide(paperId) };
    }));
    rpc.handle("reader.write", guard<"reader.write">((p) => {
      const paperId = String(p.paperId);
      this.reader.requireStudySession(paperId);
      // The paper's tutor grades: the chat given, else any open chat of the paper.
      const given = typeof p.chatId === "string" ? [...this.chats.values()].find((c) => c.id === p.chatId) : undefined;
      const chat = given && readerOf(given)?.paperId === paperId ? given : [...this.chats.values()].find((c) => readerOf(c)?.paperId === paperId && c.status !== "closed");
      const tutor = chat ? readerOf(chat) : undefined;
      let port;
      try {
        port = tutor?.tutorPort();
      } catch {
        port = undefined;
      }
      const { id, graded } = this.reader.passes.write(paperId, { kind: p.kind, ...(p.unit ? { unit: String(p.unit) } : {}), ...(p.key ? { key: String(p.key) } : {}), ...(typeof p.text === "string" ? { text: p.text } : {}), ...(p.fields ? { fields: p.fields } : {}) }, port);
      return { id, graded, guide: this.reader.passes.guide(paperId) };
    }));
    rpc.handle("reader.skip", guard<"reader.skip">((p) => {
      this.reader.requireStudySession(String(p.paperId));
      return this.reader.passes.skip(String(p.paperId), String(p.task));
    }));
    rpc.handle("reader.report", guard<"reader.report">((p) => this.reader.passes.report(String(p.paperId), String(p.item), String(p.reason ?? ""))));
    rpc.handle("reader.author", guard<"reader.author">((p) => {
      const paperId = String(p.paperId);
      this.reader.meta(paperId);
      this.readerAgent(paperId, p.agentId);
      if (p.action === "stop") this.reader.author.stop(paperId);
      else this.reader.author.retry(paperId);
      return this.reader.passes.guide(paperId);
    }));
    rpc.handle("research.status", guard<"research.status">((p) => (p?.start ? this.orx.start() : this.orx.status)));
    rpc.handle("research.configure", guard<"research.configure">((p) => {
      if (p?.orxPath !== undefined) {
        const orxPath = typeof p.orxPath === "string" && p.orxPath.trim() ? p.orxPath.trim() : undefined;
        // Choosing another orx keeps the rest of research.json (its env).
        const { orxPath: _old, ...rest } = loadResearchConfig();
        saveResearchConfig(orxPath ? { ...rest, orxPath } : rest);
      }
      return this.orx.restart();
    }));
    rpc.handle("research.quota", guard<"research.quota">((p) => (p?.refresh ? this.quota.check(true) : this.quota.last.checkedAt ? this.quota.last : this.quota.check(false))));
    rpc.handle("research.closeSession", guard<"research.closeSession">((p) => this.quota.closeSession(String(p.sessionId))));
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
      forgetSetup(`${kind}:${p.tabId}`);
      return { ok: true as const };
    });
    rpc.on("notebook.event", (p: ExtensionEvents["notebook.event"]) => {
      if (!authed()) return;
      if (browser && p.event.type === "kernel_changed") {
        const info = this.browserNotebooks.get(p.tabId);
        if (info) this.setBrowserNotebook(p.tabId, { ...info, kernel: p.event.kernel });
      }
      for (const chat of this.chatsOn(kind, p.tabId)) chat.onNotebookEvent(p.event);
    });
    rpc.on("notebook.attached", (p: ExtensionEvents["notebook.attached"]) => {
      if (!authed()) return;
      const was = browser ? this.browserNotebooks.get(p.tabId)?.key : undefined;
      if (browser) this.setBrowserNotebook(p.tabId, p.info);
      // A Mentor exercise's notebook renamed on Kaggle: the exercise follows its new address.
      if (browser && was && p.info?.key && was !== p.info.key && this.isMentorNotebook(was)) {
        void this.mentorPlaces.followRename(p.tabId, was, p.info.key).catch((e) => this.log(`Mentor: ${(e as Error).message}`));
      }
      for (const chat of this.chatsOn(kind, p.tabId)) {
        if (chat.notebookKey && p.info?.key && chat.notebookKey !== p.info.key) {
          // Another notebook now fills this tab. The chat belongs to the old one:
          // save and close it so its agent cannot edit the new notebook.
          this.dropChat(chat);
          this.toEditor("chat.snapshot", chat.snapshot());
          continue;
        }
        chat.notebook = p.info;
        if (chat.notebookKey && p.info?.key === chat.notebookKey && !mentorOf(chat)) {
          try {
            this.store.saveMeta(chat.notebookKey, { title: p.info.title, url: p.info.url, platform: p.info.platform });
          } catch (e) {
            this.log(`Could not save what is known of the notebook: ${(e as Error).message}`);
          }
        }
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
    const was = this.browserNotebooks.get(tabId)?.key;
    if (info) this.browserNotebooks.set(tabId, info);
    else if (!this.browserNotebooks.delete(tabId)) return;
    this.toEditor("browser.notebook", { tabId, info });
    // A notebook holding an exercise opened or closed: the home page shows where each exercise is.
    if (was !== info?.key && [was, info?.key].some((k) => k && this.isMentorNotebook(k))) this.toEditor("mentor.updated", {});
  }

  /** Mentor's home, with the notebook open in Chrome that holds each unfinished exercise. */
  private mentorHome(): MentorHome {
    const home = this.mentor.home();
    const placed = (t: MentorToday | null): MentorToday | null => {
      const key = t?.attemptId ? this.mentor.attempt(t.attemptId)?.notebook : undefined;
      const tabId = key ? this.mentorPlaces.tabOf(key) : undefined;
      return t && tabId !== undefined ? { ...t, place: { tabId, title: this.browserNotebooks.get(tabId)?.title ?? "" } } : t;
    };
    return { ...home, today: placed(home.today), warmup: placed(home.warmup), readerCards: this.reader.cards.due(), papers: home.papers.map((p) => this.placedPaper(p)) };
  }

  /** A paper with the Chrome tab of its workshop, when it is open. */
  private placedPaper(p: MentorPaper): MentorPaper {
    const key = this.mentor.workshopOf(p.id);
    const tabId = key ? this.mentorPlaces.tabOf(key) : undefined;
    const running = this.workshops.running(p.id);
    const reader = this.reader.passes.summary(p.id);
    const out = { ...p, ...(reader ? { reader } : {}), ...(tabId !== undefined ? { place: { tabId, title: this.browserNotebooks.get(tabId)?.title ?? "" } } : {}) };
    return running ? { ...out, components: out.components.map((c) => (c.status === "planned" ? { ...c, status: "authoring" as const } : c)) } : out;
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

  /** Forward OpenResearch run updates to the editor, refresh project briefs, and notify open project notebook chats on completion (C4). */
  private onResearchRun(run: ResearchRun): void {
    this.toEditor("research.run", run);
    if (run.projectId) this.links.markDirty(run.projectId);
    if (!run.projectId || !FINAL_RUN_STATUSES.includes(run.status)) return;
    const key = `${run.id}:${run.status}`;
    if (this.notifiedRuns.has(key)) return;
    this.notifiedRuns.add(key);
    if (this.notifiedRuns.size > 200) this.notifiedRuns.delete(this.notifiedRuns.values().next().value!);
    for (const chat of this.chats.values()) {
      if (chat.status !== "closed" && chat.project?.id === run.projectId) chat.onProjectRunFinished(run);
    }
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

  /**
   * Kaggle gives a new notebook an address like /code/<user>/notebook5e1f…,
   * and moves it to /code/<user>/<title> once renamed, seen at the next page
   * load: the notebook's key changes, and it would come back as a new notebook
   * with an empty chat. Its machine tells: a fresh chat whose notebook runs on
   * the machine of a saved conversation (not open elsewhere) takes it over.
   */
  private adoptRenamed(target: Target, key: string, boot: string): void {
    const chat = [...this.chats.values()].find((c) => c.notebookKey === key && sameAs(this.targets.get(c), target));
    if (!chat || this.seenBoot.get(chat) === boot) return;
    this.seenBoot.set(chat, boot);
    // Only Kaggle gives every notebook a machine of its own; Colab and Jupyter servers share one.
    if (!key.startsWith("kaggle:") || chat.messages.some((m) => m.role === "user")) return;
    const open = new Set([...this.chats.values()].map((c) => c.notebookKey));
    for (const info of this.browserNotebooks.values()) open.add(info.key);
    const from = this.store.listMeta()
      .filter((m) => m.key !== key && m.key.startsWith("kaggle:") && m.machine?.boot === boot && !open.has(m.key))
      .filter((m) => this.store.load(m.key)?.messages.some((x) => x.role === "user"))
      .sort((a, b) => (b.machine?.seenAt ?? 0) - (a.machine?.seenAt ?? 0))[0];
    if (!from) return;
    this.log(`The notebook ${from.key} now answers as ${key} (renamed): its conversation follows it.`);
    this.dropChat(chat, { forget: true });
    this.store.move(from.key, key);
    // The editor sees the chat closed and opens it again, from the moved conversation.
    this.toEditor("chat.snapshot", chat.snapshot());
  }

  private dropAllChats(): void {
    for (const chat of [...this.chats.values()]) {
      const target = this.targets.get(chat);
      this.dropChat(chat);
      if (target) forgetSetup(`${target.kind}:${target.tabId}`);
    }
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

  /** Ask OpenResearch about a chat's project (it may take a while to start), and show the answer. */
  private async refreshProject(chat: Chat): Promise<void> {
    if (!chat.notebookKey) return;
    try {
      chat.setProject(await this.links.resolve(chat.notebookKey, true));
    } catch (e) {
      this.log(`Could not find the project of ${chat.notebook?.title ?? "a notebook"}: ${describeFailure(e)}`);
    }
  }

  /** Move a notebook to another project; its open chats follow from their next turn. */
  private async linkNotebook(key: string, projectId: string, info: { title?: string; url?: string; platform?: NotebookInfo["platform"] } = {}) {
    const res = await this.links.link(key, projectId, info);
    for (const chat of this.chats.values()) if (chat.notebookKey === key) chat.setProject(res, true);
    return res.project;
  }

  /** The Mentor attempt a notebook in Chrome holds, for its chat. */
  private mentorSession(target: Target, key: string | undefined): MentorSession | undefined {
    if (!key || target.kind !== "browser") return undefined;
    try {
      const attempt = this.mentor.attemptIn(key);
      return attempt ? new MentorSession(this.mentor, attempt.attemptId) : undefined;
    } catch (e) {
      this.log(`Mentor: ${(e as Error).message}`);
      return undefined;
    }
  }

  private isMentorNotebook(key: string): boolean {
    try {
      return !!this.mentor.attemptIn(key) || !!this.mentor.workshopIn(key);
    } catch {
      return false;
    }
  }

  /** The paper workshop a notebook in Chrome is, for its chat. */
  private workshopSession(target: Target, key: string | undefined): WorkshopSession | undefined {
    if (!key || target.kind !== "browser") return undefined;
    try {
      const paperId = this.mentor.workshopIn(key);
      return paperId && this.mentor.shelf.has(paperId) ? new WorkshopSession(this.workshops, paperId, "plan") : undefined;
    } catch (e) {
      this.log(`Mentor: ${(e as Error).message}`);
      return undefined;
    }
  }

  private authorSeq = 0;

  /** The hidden chat that writes a paper's exercises: same agent as the workshop's chat, on the same notebook, shown nowhere. */
  private authorChat(paperId: string, tabId: number): AuthorChat {
    const target: Target = { kind: "browser", tabId };
    const shown = this.chatsOn("browser", tabId).find((c) => workshopOf(c)?.paperId === paperId);
    const spec = shown?.spec ?? findAgent("claude");
    if (!spec) throw new Error("No agent to write the exercises.");
    const key = authorChatKey(paperId);
    const host: ChatHost = { ...this.chatHost(target, key, true), emit: () => {} };
    const chat = new Chat(-1_000_000_000 - ++this.authorSeq, spec, DEFAULT_SETTINGS, host, { notebookKey: key, role: new WorkshopChat(new WorkshopSession(this.workshops, paperId, "author")) });
    chat.notebook = this.browserNotebooks.get(tabId) ?? null;
    this.byToken.set(chat.mcpToken, chat);
    return {
      send: (text, context) => chat.send(text, { context }),
      whenIdle: async (signal) => {
        await new Promise((r) => setTimeout(r, 200));
        await chat.whenIdle(signal);
        if (signal.aborted) await chat.cancel().catch(() => false);
      },
      close: () => {
        chat.close();
        this.byToken.delete(chat.mcpToken);
      },
    };
  }

  private readerSeq = 0;
  /** The agent the reader uses, per paper (the editor says), for hidden chats when no tutor chat is open. */
  private readonly readerAgents = new Map<string, string>();

  private readerAgent(paperId: string, agentId: unknown): void {
    if (typeof agentId === "string" && findAgent(agentId)) this.readerAgents.set(paperId, agentId);
  }

  /**
   * A hidden chat of easy-read (the author or the checker of a paper): the
   * same agent as the paper's tutor, on no notebook, its events to no one.
   */
  private readerHiddenChat(paperId: string, role: ChatRole, kind: "author" | "checker" | "peer:experimentalist" | "peer:theorist"): AuthorChat {
    const tutor = [...this.chats.values()].find((c) => readerOf(c)?.paperId === paperId && c.status !== "closed");
    const spec = tutor?.spec ?? findAgent(this.readerAgents.get(paperId) ?? "claude") ?? findAgent("claude");
    if (!spec) throw new Error("No agent to prepare the paper.");
    const key = kind.startsWith("peer:") ? `reader-peer:${paperId}:${kind.slice(5)}` : `reader-${kind}:${paperId}`;
    const target: Target = { kind: "vscode", tabId: -2_000_000_000 - ++this.readerSeq };
    const host: ChatHost = { ...this.chatHost(target, key, true), emit: () => {} };
    const chat = new Chat(target.tabId, spec, DEFAULT_SETTINGS, host, { notebookKey: key, role });
    this.byToken.set(chat.mcpToken, chat);
    const inheritedModel = tutor?.options().find((option) => option.category === "model")?.value;
    const model = kind === "checker" ? process.env.AINB_READER_CHECKER_MODEL || inheritedModel : inheritedModel;
    let ready = Promise.resolve();
    if (typeof model === "string" && model) {
      ready = chat.ensureStarted().then(async () => {
        const option = chat.options().find((o) => o.category === "model" && o.kind === "select");
        if (option?.choices?.some((choice) => choice.value === model) && option.value !== model) await chat.setOption(option.id, model);
      }).catch((e: Error) => this.log(`Reader: cannot select the ${kind} model: ${e.message}`));
    }
    return {
      send: (text, context) => {
        ready = ready.then(() => { if (chat.status !== "closed") chat.send(text, context ? { context } : {}); });
      },
      whenIdle: async (signal) => {
        await ready;
        await new Promise((r) => setTimeout(r, 200));
        await chat.whenIdle(signal);
        if (signal.aborted) await chat.cancel().catch(() => false);
      },
      close: () => {
        chat.close();
        this.byToken.delete(chat.mcpToken);
      },
    };
  }

  /** A chat of a paper's workshop (the shown one), and the Chrome tab it is on. */
  private workshopChat(chatId: string): { chat: Chat; ws: WorkshopSession; tabId: number } {
    const chat = this.chatById(chatId);
    const target = this.targets.get(chat);
    const ws = workshopOf(chat);
    if (!ws || ws.role !== "plan" || target?.kind !== "browser") throw new Error("Chat này không phải xưởng của một paper.");
    return { chat, ws, tabId: target.tabId };
  }

  /** The exercises of the workshop's paper are written, as the chat's job. */
  private startAuthoring(chatId: string, opts: { slug?: string; retry?: boolean } = {}): void {
    const { chat, ws, tabId } = this.workshopChat(chatId);
    if (this.workshops.running(ws.paperId)) throw new Error("Mentor đang soạn bài cho paper này.");
    if (chat.isBusy()) throw new Error("Đợi mentor trả lời xong rồi bấm lại.");
    void chat.runJob((signal) => this.workshops.author(ws.paperId, tabId, { ...opts, signal }))
      .catch((e) => {
        // The learner pressed a button and nothing would happen: say why, where they are looking.
        this.log(`Mentor: writing the exercises of ${ws.paperId}: ${(e as Error).message}`);
        chat.notice(`Chưa soạn được bài: ${(e as Error).message}`);
      });
  }

  /** A paper's text: from arXiv, or out of a PDF on the notebook's machine. */
  private async paperSource(source: { arxiv: string } | { pdfPath: string }, tabId: number): Promise<PaperSource & { id?: string }> {
    if ("arxiv" in source) {
      const arxiv = parseArxivId(source.arxiv);
      if (!arxiv) throw new Error(`"${source.arxiv}" không phải link hay id arXiv (ví dụ 2006.11239 hoặc https://arxiv.org/abs/2006.11239).`);
      const src = await fetchArxiv(arxiv, { orxPaper: (id) => this.orx.cli(["paper", "--full", "--", id], { timeoutMs: 120_000 }), log: (m) => this.log(m) });
      return { ...src, id: paperIdFor(arxiv) };
    }
    const size = statSync(source.pdfPath).size;
    if (size > 40 * 1024 * 1024) throw new Error("File PDF lớn quá (tối đa 40 MB).");
    const data = readFileSync(source.pdfPath).toString("base64");
    const target: Target = { kind: "browser", tabId };
    const exec = async (code: string, waitMs = 120_000) => {
      const r = await this.notebookOp(target, { op: "execute", code, waitMs }, waitMs + 30_000) as ExecResult;
      if (r.status === "error") throw new Error(`Máy của notebook báo lỗi: ${r.outputs.find((o) => o.kind === "error")?.evalue ?? r.message ?? ""}`);
      return r.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
    };
    const stamp = randomBytes(4).toString("hex");
    const pdf = `/tmp/ainb-paper-${stamp}.pdf`;
    const txt = `/tmp/ainb-paper-${stamp}.txt`;
    const CHUNK = 700_000;
    for (let at = 0; at < data.length; at += CHUNK) await exec(pdfChunkCode(pdf, data.slice(at, at + CHUNK), at === 0));
    const meta = JSON.parse(pdfMarked(await exec(pdfExtractCode(pdf, txt), 300_000)) ?? "{}") as { chars?: number; pages?: number; title?: string; error?: string };
    if (meta.error || !meta.chars) throw new Error(meta.error ?? "Không rút được chữ từ PDF (PDF chỉ có ảnh?).");
    let text = "";
    for (let at = 0; at < Math.min(meta.chars, 600_000); at += 100_000) {
      const b64 = pdfMarked(await exec(readSliceCode(txt, at, 100_000)));
      text += b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    }
    const name = source.pdfPath.split(/[\\/]/).pop()!.replace(/\.pdf$/i, "");
    const title = meta.title?.trim() || name;
    return { title, kind: "pdf", text: `<!-- source: text taken out of the PDF ${name}.pdf (${meta.pages} pages); formulas may be garbled: check them against the PDF -->\n# ${title}\n\n${text}` };
  }

  /**
   * "Báo bài sai": the attempt no longer counts. An exercise the mentor wrote
   * for one of the learner's papers waits to be written again, with what the
   * learner said (the paper's workshop shows it); a curated one is noted for
   * the catalog's author.
   */
  private reportExercise(chat: Chat, reason: string): void {
    const s = requireMentor(chat).session;
    s.report(reason);
    if (s.exercise.paper) this.workshops.report(s.exercise.paper, s.exercise.id, reason);
    const dir = join(dataDir(), "mentor");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "reports.jsonl"), `${JSON.stringify({ at: Date.now(), exerciseId: s.exercise.id, attemptId: s.attemptId, author: s.exercise.author, reason })}\n`);
  }

  private chatHost(target: Target, key?: string, mentor = false): ChatHost {
    const project: ChatProjectHost | undefined = key && !mentor
      ? {
          links: this.links,
          research: this.links.projects,
          resolve: (wait) => this.links.resolve(key, wait),
          cached: () => this.links.cached(key),
        }
      : undefined;
    return {
      project,
      meta: key ? {
        load: () => this.store.loadMeta(key),
        save: (patch) => { this.store.saveMeta(key, patch); },
      } : undefined,
      machineReset: () => forgetSetup(`${target.kind}:${target.tabId}`),
      machineSeen: (boot) => { if (key) this.adoptRenamed(target, key, boot); },
      projectMcpServer: (chatToken): McpServer => ({
        name: "project",
        command: this.opts.mcpCommand.command,
        args: this.opts.mcpCommand.args,
        env: [
          { name: "AINB_URL", value: `http://127.0.0.1:${this.port}` },
          { name: "AINB_CHAT_TOKEN", value: chatToken },
          { name: "AINB_MCP_SERVER", value: "project" },
          ...(process.platform === "win32" && process.env.SystemRoot ? [{ name: "SystemRoot", value: process.env.SystemRoot }] : []),
        ],
      }),
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

  // ------------------------------------------------------------ Mentor: verify

  /**
   * `ainb mentor verify`: check exercises (of the caller's catalog, a dev
   * checkout's) on a notebook open in Chrome, one NDJSON line per step and
   * per report. A line every 20 s keeps the request alive through long checks.
   */
  private async mentorVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { exerciseIds?: unknown; tabId?: unknown; catalogDir?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "bad json" });
    }
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
    const tick = setInterval(() => line({ t: "tick" }), 20_000);
    let claimed: string | undefined;
    try {
      const catalog = loadCatalog(typeof body.catalogDir === "string" ? body.catalogDir : undefined, { unverified: true });
      const tabs = [...this.browserNotebooks.keys()];
      const tabId = typeof body.tabId === "number" ? body.tabId : tabs.length === 1 ? tabs[0] : undefined;
      if (tabId === undefined || !this.browserNotebooks.has(tabId)) {
        throw new Error(tabs.length ? `Several notebooks are open in Chrome; name one with --tab (${tabs.map((t) => `${t}: ${this.browserNotebooks.get(t)?.title}`).join(", ")}).` : "No notebook is open in Chrome: open a Kaggle notebook and turn its machine on.");
      }
      const key = this.browserNotebooks.get(tabId)?.key || `tab:${tabId}`;
      if (this.verifying.has(key)) throw new Error("Another Mentor verification is using this notebook.");
      this.verifying.add(key);
      claimed = key;
      const wanted = Array.isArray(body.exerciseIds) && body.exerciseIds.length ? body.exerciseIds.map(String) : catalog.exercises.filter((e) => e.requires.includes("torch")).map((e) => e.id);
      line({ t: "start", tabId, title: this.browserNotebooks.get(tabId)?.title ?? "", exercises: wanted });
      const target: Target = { kind: "browser", tabId };
      const exec = async (code: string, waitMs: number) => {
        const r = await this.notebookOp(target, { op: "execute", code, waitMs }, waitMs + 30_000) as ExecResult;
        if (r.status === "running") await this.notebookOp(target, { op: "interrupt" }).catch(() => {});
        return r;
      };
      // Every exercise at once, through one queue of the machine's GPUs (see mentor/pool.ts).
      const pool = new KernelPool(exec);
      const info = await pool.start();
      line({ t: "step", exerciseId: "máy", text: info.gpus ? `${info.gpus} GPU, ${info.slots} việc chạy cùng lúc` : `không có GPU, ${info.slots} việc chạy cùng lúc` });
      try {
        await Promise.all(wanted.map(async (id) => {
          const ex = catalog.exercise(id);
          if (!ex) return line({ t: "error", exerciseId: id, message: `No exercise ${id}.` });
          try {
            const context = referenceContext(catalog, ex);
            const report = await verifyExercise(ex, pool.exec(id, trainsOnGpu(ex, context)), { context, concurrent: true, onStep: (text) => line({ t: "step", exerciseId: id, text }) });
            line({ t: "report", report });
          } catch (e) {
            line({ t: "error", exerciseId: id, message: (e as Error).message });
          }
        }));
      } finally {
        await pool.close();
      }
    } catch (e) {
      line({ t: "error", message: (e as Error).message });
    } finally {
      if (claimed !== undefined) this.verifying.delete(claimed);
      clearInterval(tick);
      res.end();
    }
  }

  // ------------------------------------------------------------ MCP relay

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, version: BRIDGE_VERSION, extension: !!(this.clients.browser.connection || this.clients.vscode.connection) });
    }
    if (!isLoopback(req) || req.method !== "POST" || !(url.pathname.startsWith("/mcp/") || ["/shutdown", "/mentor/verify", "/mentor/reload", "/reader/eval"].includes(url.pathname))) return json(res, 404, { error: "not found" });
    // Browsers attach Origin to cross-site requests; the relay is for local processes only.
    if (req.headers.origin) return json(res, 403, { error: "forbidden" });
    const auth = req.headers.authorization ?? "";
    if (url.pathname === "/reader/eval") {
      if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), this.opts.token)) return json(res, 401, { error: "bad token" });
      try {
        const input = JSON.parse(await readBody(req)) as { paper?: unknown; quiz?: boolean; agent?: unknown };
        const wanted = String(input.paper ?? "");
        const arxiv = parseArxivId(wanted);
        const paperId = this.reader.has(wanted) ? wanted : arxiv ? this.reader.store.ids().find((id) => {
          try {
            const known = this.reader.meta(id).arxiv;
            return known && paperIdFor(known) === paperIdFor(arxiv);
          } catch { return false; }
        }) : undefined;
        if (!paperId) return json(res, 404, { error: "Mở paper và soạn nội dung trong Easy Read trước khi đo." });
        this.readerAgent(paperId, input.agent);
        const items = this.reader.passes.items(paperId);
        const stats = qualityStats(this.reader.store.state(paperId), items);
        const quiz = input.quiz === true
          ? await runPaperQuiz(this.reader, paperId, items, (role) => this.readerHiddenChat(paperId, role, "checker"))
          : undefined;
        return json(res, 200, { paperId, title: this.reader.meta(paperId).title, ...stats, ...(quiz ? { quiz } : {}) });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (url.pathname === "/shutdown") {
      // `ainb stop`, for a bridge running in the background with no console to Ctrl+C.
      if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), this.opts.token)) return json(res, 401, { error: "bad token" });
      json(res, 200, { ok: true });
      setTimeout(() => this.opts.onShutdown?.(), 50);
      return;
    }
    if (url.pathname === "/mentor/verify") {
      if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), this.opts.token)) return json(res, 401, { error: "bad token" });
      return this.mentorVerify(req, res);
    }
    if (url.pathname === "/mentor/reload") {
      // Content was added (a topic pack, an exercise, questions, hints): the catalog is read again.
      if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), this.opts.token)) return json(res, 401, { error: "bad token" });
      try {
        this.mentor.reloadCatalog();
        const c = this.mentor.catalog;
        return json(res, 200, { ok: true, exercises: c.exercises.length, packs: c.packs.map((p) => ({ id: p.id, exercises: p.exercises.length })), problems: c.problems });
      } catch (e) {
        return json(res, 500, { error: (e as Error).message });
      }
    }
    const chat = this.byToken.get(auth.replace(/^Bearer\s+/i, ""));
    if (!chat) return json(res, 401, { error: "unknown chat token" });

    let body: any;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "bad json" });
    }
    if (url.pathname === "/mcp/list") return json(res, 200, { tools: listTools(chat.tools()) });
    if (url.pathname === "/mcp/call") {
      const result = await chat.runTool(String(body.name), body.arguments ?? {});
      return json(res, 200, result);
    }
    if (url.pathname === "/mcp/project/list") return json(res, 200, { tools: listTools(PROJECT_TOOLS) });
    if (url.pathname === "/mcp/project/call") {
      const result = await chat.runProjectTool(String(body.name), body.arguments ?? {});
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

/** Cells attached to a message, as the panel sent them: well-formed, short, one entry per cell. */
export function sanitizeCells(raw: unknown): AttachedCell[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cells: AttachedCell[] = [];
  for (const c of raw as Partial<AttachedCell>[]) {
    if (!c || typeof c.cellId !== "string" || !c.cellId || c.cellId.length > 200 || seen.has(c.cellId)) continue;
    seen.add(c.cellId);
    const index = typeof c.index === "number" && Number.isSafeInteger(c.index) && c.index >= 0 ? c.index : 0;
    cells.push({ cellId: c.cellId, index, label: typeof c.label === "string" ? c.label.slice(0, 120) : "" });
    if (cells.length >= ATTACHED_CELLS_MAX) break;
  }
  return cells;
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
