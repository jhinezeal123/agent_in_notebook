// A chat drives one agent for one notebook tab. The bridge's transcript is the
// record shown to the user; the agent's own session is only its context.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { McpServer, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import {
  capText,
  firstLine,
  chatImageDataUrl,
  isChatImageMime,
  type AgentOption,
  type AppliedChange,
  type AttachedCell,
  type CellInfo,
  type CellRun,
  type ChatCard,
  type ChatCode,
  type ChatMessage,
  type ChatProject,
  type ChatSettings,
  type ChatSnapshot,
  type ChatStatus,
  type ChatUsage,
  type MessagePatch,
  type MachineStats,
  type NotebookEvent,
  type NotebookInfo,
  type NotebookOpName,
  type NotebookOpOf,
  type NotebookOpResults,
  type OutputImage,
  type Part,
  type PartOp,
  type ResearchRun,
  type ReviewInfo,
  type UndoResult,
} from "@ainb/protocol";
import { AcpAgent, AgentStartError } from "./agents/acp-agent.js";
import type { AgentSpec } from "./agents/registry.js";
import { attachedCellsBlock, cellRunBlock, litReview, machineLine, playbook, projectContext, projectUnavailable, recap, runDuration, runState, turnContext } from "./instructions.js";
import { RecentRuns } from "./notebook/exec.js";
import { NotebookMirror, notebookPath } from "./notebook/nbfile.js";
import { ShellSessions } from "./notebook/shell.js";
import { stats } from "./notebook/vmfs.js";
import type { KernelExec } from "./notebook/kernel.js";
import { callTool, Denied, renderCell, TOOLS, type ReviewOutcome, type ToolContext, type ToolDef, type ToolResult } from "./notebook/tools.js";
import { PROJECT_TOOLS, saveNotebook, type ProjectToolContext } from "./project/tools.js";
import { redactTokens, remoteOf } from "./project/github.js";
import { CodeSync, type CodePlace, type CodeState } from "./project/vmrepo.js";
import { cacheOf as projectCache, type ProjectBrief, type ProjectLinks, type ProjectResolution } from "./research/links.js";
import type { NotebookMeta, ProjectCache } from "./store.js";
import { ensureWorktree } from "./project/worktree.js";
import { describeFailure, type ResearchProjects } from "./research/projects.js";
import { keyHash, MAX_MESSAGES, MAX_PINS, trimMessages } from "./store.js";
import type { ChatPort, ChatRole } from "./chat-role.js";

/** How the chat reaches its notebook and the chat UI. */
export interface ChatHost {
  notebookOp(tabId: number, op: unknown, timeoutMs: number): Promise<unknown>;
  emit(event: string, params: unknown): void;
  /** MCP server entry handed to the agent; it relays tool calls back to this chat. */
  mcpServer(chatToken: string): McpServer;
  /** The MCP server of the project tools, for chats that belong to a project. */
  projectMcpServer?(chatToken: string): McpServer;
  /** The notebook's OpenResearch project; absent for chats without a notebook key. */
  project?: ChatProjectHost;
  /** What is kept of the notebook between chats (its machine). */
  meta?: { load(): NotebookMeta | null; save(patch: Partial<Pick<NotebookMeta, "machine">>): void };
  /** Forget terminal screens tied to the old notebook machine. */
  machineReset?(): void;
  /** The notebook's machine was read (its boot id): a notebook renamed on Kaggle is found by it. */
  machineSeen?(boot: string): void;
  workspaceRoot: string;
  /** Save the transcript: debounced as it changes (in the background), and on close (`sync`). */
  persist?(chat: Chat, sync: boolean): void;
}

/** How a chat reaches its notebook's OpenResearch project. */
export interface ChatProjectHost {
  links: ProjectLinks;
  research: ResearchProjects;
  /** Ask OpenResearch about the notebook's project (`wait`: give it time to start). */
  resolve(wait: boolean): Promise<ProjectResolution>;
  /** The project as the notebook last saw it, for when OpenResearch does not answer. */
  cached(): ProjectCache | null;
}

export interface ChatOptions {
  /** The notebook the chat belongs to; it names the agent's working directory and the saved transcript. */
  notebookKey?: string;
  /** Transcript carried over from an earlier chat (agent switch or restore). */
  carried?: ChatMessage[];
  /** System notice explaining where the carried transcript came from. */
  note?: string;
  /** Undo journal of the carried transcript, by message id. */
  journal?: Record<string, AppliedChange[]>;
  /** The notebook's project as known when the chat opens. */
  project?: ChatProject;
  /** The chat's agent is not the notebook's coding agent: who it is instead (chat-role.ts). */
  role?: ChatRole;
}
/** Longest the judge waits for the tests before stopping them. */

const TOOL_DETAIL_MAX = 4000;
/** Bound the image data included in full chat snapshots and persisted transcripts. */
const CHAT_IMAGES_MAX = 8 * 1024 * 1024;
/** usage_update falling below this share of the last count (from at least the minimum) means a compaction. */
const COMPACTION_SHRINK = 0.6;
const COMPACTION_MIN_TOKENS = 20_000;
const FLUSH_MS = 80;
const OP_TIMEOUT_MS = 30_000;
/** Saving rewrites the whole transcript, so it waits for a pause of this long. */
const PERSIST_MS = 2_000;
/** ...but a turn that never pauses still saves at least this often, so a crash mid-turn does not lose it all. */
const PERSIST_MAX_MS = 10_000;
/** Messages waiting for the agent at once; past this the user is told to wait or Stop, not queued silently. */
const QUEUE_MAX = 20;
/** A turn with no session/update for this long gets one notice (the agent may be thinking, or stuck). */
const WATCHDOG_MS = 5 * 60_000;
/** No turn or cell run for this long: the machine poll slows to every MACHINE_IDLE_EVERY-th tick. */
const MACHINE_IDLE_MS = 2 * 60_000;
const MACHINE_IDLE_EVERY = 5;
/** Decided reviews kept so a late await_review still gets the answer. */
const REVIEWS_KEPT = 200;
const RUN_CARDS_OPEN = 5;
const LONG_RUN_MS = 60_000;
const MACHINE_MIN_MS = 20_000;
const MACHINE_SAVE_MS = 5 * 60_000;
const MACHINE_POLL_MS = 30_000;
const AUTOSAVE_MS = 10 * 60_000;

interface TurnInput {
  text: string;
  /** Extra block for the agent, before <notebook-context>. */
  context?: string;
  /** Cells the `cell` scope may edit this turn, when the user pinned none. */
  targets?: string[];
  /** Cells the user attached to the message: shown to the agent as they are when the turn starts. */
  cells?: AttachedCell[];
}

interface ReviewState {
  outcome: ReviewOutcome;
  waiters: Set<(o: ReviewOutcome) => void>;
}

export class Chat {
  readonly id = randomUUID();
  /** Bearer token the agent's MCP relay presents; identifies this chat. */
  readonly mcpToken = randomBytes(24).toString("base64url");
  status: ChatStatus = "starting";
  error: string | undefined;
  messages: ChatMessage[] = [];
  notebook: NotebookInfo | null = null;
  machine: MachineStats | undefined;
  readonly notebookKey: string | undefined;

  private imageBytes = 0;

  private agent: AcpAgent | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private sessionFresh = true;
  /**
   * The agent compacted its context, which may have dropped the playbook it got
   * on the session's first turn: send it (and the full outline) again.
   */
  private rulesDue = false;
  /** Recap to hand a session that joins mid-conversation. */
  private pendingRecap = "";
  private current: ChatMessage | null = null;
  private turn: { controller: AbortController; prompting: boolean; project: ProjectCache | null; code: CodePlace | null } | null = null;
  private queue: { input: TurnInput; messageId: string }[] = [];
  private turnTargets: string[] = [];
  private reviews = new Map<string, ReviewState>();
  private prompts = new Map<string, (optionId: string) => void>();
  private cards = new Map<string, { card: ChatCard; message: ChatMessage; onAction(actionId: string): void }>();
  private dirty = new Set<ChatMessage>();
  /** Part indices of each message changed since the last flush; a touch with no index marks them all. */
  private dirtyParts = new Map<string, Set<number>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current quiet-debounce cycle must save at the latest (first dirty + PERSIST_MAX_MS). */
  private persistDueAt = 0;
  /** Set when the user starts over: the transcript must not be saved again. */
  private forgotten = false;
  /** Notebook changes applied for the agent, by the agent message whose turn made them. */
  private journal = new Map<string, AppliedChange[]>();
  /** Undos the agent has not been told about yet. */
  private undoNotes: string[] = [];
  /** What the agent last reported about its context window. */
  private usage: ChatUsage | undefined;
  /** The outline sent with the last prompt, to skip resending it unchanged. */
  private lastOutline = "";
  /** Run diagnostics sent with the last prompt, to include only changes. */
  private lastRunState = "";
  /** Cells the user ran since the agent's last turn, oldest first. */
  private activity: CellRun[] = [];
  /** Last kernel event, kept apart from attached info that may overwrite it. */
  private lastKernel: NotebookInfo["kernel"] | undefined;
  /** Kernel reconnects the agent has not been told about yet. */
  private kernelNotes: string[] = [];
  private machineAt = 0;
  private machineRead: Promise<void> | null = null;
  private boot: string | undefined;
  private machineSavedAt = 0;
  /** Re-reads the machine's numbers while the chat is open, so the header follows a running cell. */
  private machinePoll: ReturnType<typeof setInterval> | null = null;
  /** Ticks counted while idle, to refresh only every MACHINE_IDLE_EVERY-th one. */
  private machineIdleTicks = 0;
  /** Last turn start or cell run: the machine poll slows down once this is older than MACHINE_IDLE_MS. */
  private lastActiveAt = 0;
  /** One notice per turn when the agent sends nothing for WATCHDOG_MS; never cancels it. */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogFired = false;
  private lastSyncAt = 0;
  /** Last attempt that confirmed the code is saved, not merely scheduled or attempted. */
  private lastSavedAt = 0;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtySinceSync = false;
  private lastUserRunAt = 0;
  private busyJob: { controller: AbortController } | null = null;
  /** Tail of each lock's queue (see ToolContext.exclusive). */
  private locks = new Map<string, Promise<unknown>>();
  /** Outputs of recent Bash / run_code calls, for read_output. */
  private runs = new RecentRuns();
  /** Terminal sessions on the notebook machine; their shells live on there, this keeps the screens. */
  private shells = new ShellSessions();
  /** The notebook's file on its machine. */
  private mirror = new NotebookMirror();
  /** The notebook's OpenResearch project, as last known. */
  project: ChatProject | undefined;
  /** The project brief the agent was last given (to send only what changed). */
  private lastBrief: ProjectBrief | null = null;
  /** The "project unavailable" note last sent, so it is not repeated. */
  private lastProjectNote = "";
  /** The notebook moved to another project: the agent gets the new one's full context. */
  private projectMoved = false;
  private projectRevision = 0;
  /** Artifacts this chat wrote (it may replace them without asking). */
  private readonly createdArtifacts = new Set<string>();
  /** The project's code on the notebook's machine (a clone of the chat's branch). */
  private readonly code: CodeSync | null;
  /** What the notebook header shows about the project's code on the machine. */
  private codeState: ChatCode | undefined;
  /** What the agent was last told about the code, and what the user was. */
  private lastCodeNote = "";
  private lastCodeShown = "";
  /** Parts of each message as last sent to the extension, to send only what changed. */
  private sent = new Map<string, SentPart[]>();
  /** The queued mark last sent for each message, so a patch carries it only when it changes. */
  private sentQueued = new Map<string, boolean>();
  /** Who the agent is in this chat, when not the notebook's coding agent. */
  readonly role: ChatRole | undefined;
  private detachRole: (() => void) | undefined;

  constructor(
    readonly tabId: number,
    readonly spec: AgentSpec,
    public settings: ChatSettings,
    private readonly host: ChatHost,
    opts: ChatOptions = {},
  ) {
    this.notebookKey = opts.notebookKey;
    this.project = opts.project;
    this.role = opts.role;
    if (this.role) {
      this.settings = this.role.settings;
      this.detachRole = this.role.attach(this.port());
    }
    this.code = host.project && opts.notebookKey ? new CodeSync((op, ms) => this.call(op as never, ms) as Promise<unknown>, opts.notebookKey) : null;
    this.codeState = this.code ? { state: "missing", why: "Not put on the notebook's machine since the chat opened." } : undefined;
    for (const [id, changes] of Object.entries(opts.journal ?? {})) if (Array.isArray(changes) && changes.length) this.journal.set(id, changes);
    const carried = opts.carried ?? [];
    // Offer undo only where the journal to do it is still at hand.
    for (const m of carried) if (m.changes && !this.journal.has(m.id)) delete m.changes;
    if (carried.length) {
      this.messages = carried;
      for (const message of carried) {
        if (message.pinned) this.sentPinned.set(message.id, true);
        for (const part of message.parts) {
          if (part.type === "image") this.imageBytes += part.data.length;
          // Action handlers belong to the old Chat; a carried card cannot still be pressed.
          if (part.type === "card" && part.card.state === "open") part.card = { ...part.card, state: "stale", actions: [] };
        }
      }
      this.pendingRecap = recap(carried);
      this.system(opts.note ?? `Switched to ${spec.name}. It gets a summary of the conversation so far.`);
    }
  }

  // ------------------------------------------------------------ lifecycle

  snapshot(): ChatSnapshot {
    return {
      chatId: this.id,
      tabId: this.tabId,
      agentId: this.spec.id,
      agentName: this.spec.name,
      notebookKey: this.notebookKey,
      status: this.status,
      error: this.error,
      settings: this.settings,
      options: this.options(),
      messages: this.messages,
      notebook: this.notebook,
      usage: this.usage,
      machine: this.machine,
      ...(this.project ? { project: this.project } : {}),
      ...(this.codeState ? { code: this.codeState } : {}),
      ...this.role?.snapshot(),
    };
  }

  /** What the chat's role may do in it. */
  private port(): ChatPort {
    return {
      chatId: this.id,
      tabId: this.tabId,
      closed: () => this.closed,
      busy: () => !!(this.current || this.busyJob),
      emit: (event, params) => this.host.emit(event, params),
      call: (op, timeoutMs) => this.call(op, timeoutMs),
      exclusive: (lock, fn) => this.exclusive(lock, fn),
      job: (fn) => this.runJob(fn),
      addCard: (card, onAction) => this.addCard(card, onAction),
      closeCard: (cardId, state, outcome, tone) => this.closeCard(cardId, state, outcome, tone),
      send: (text, extra) => this.send(text, extra),
      system: (text) => this.system(text),
    };
  }

  options(): AgentOption[] {
    return this.agent?.options() ?? [];
  }

  /** Start the agent if it is not running. Safe to call repeatedly. */
  ensureStarted(): Promise<void> {
    // A start in flight must be awaited: the process exists before its session does.
    if (this.starting) return this.starting;
    if (this.agent?.running && this.agent.sessionId) return Promise.resolve();
    this.starting = this.startAgent().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startAgent(): Promise<void> {
    const resolved = this.spec.resolve();
    if ("missing" in resolved) {
      this.setStatus("error", resolved.missing);
      throw new Error(resolved.missing);
    }
    this.setStatus("starting");
    // One working directory per notebook, so agents that key their own state by
    // directory see the same place each time. Touched so pruning spares it.
    const cwd = join(this.host.workspaceRoot, this.notebookKey ? keyHash(this.notebookKey) : this.id);
    mkdirSync(cwd, { recursive: true });
    try {
      const now = new Date();
      utimesSync(cwd, now, now);
    } catch {
      // best effort
    }
    const agent = new AcpAgent(resolved.launch, {
      onUpdate: (n) => this.onUpdate(n),
      onPermission: (req, signal) => this.onPermission(req, signal),
      onExit: (code, tail) => {
        if (this.agent !== agent || this.closed) return;
        this.agent = null;
        this.failPrompts();
        // A later message restarts the agent with a recap of the conversation.
        this.sessionFresh = true;
        this.pendingRecap = recap(this.messages);
        this.setStatus("error", `${this.spec.name} exited (code ${code}).${tail ? ` ${tail.slice(-600)}` : ""} Send a message to restart it.`);
      },
    });
    this.agent = agent;
    try {
      const servers = [this.host.mcpServer(this.mcpToken)];
      if (this.host.project && this.host.projectMcpServer) servers.push(this.host.projectMcpServer(this.mcpToken));
      await agent.start(cwd, servers, this.spec.sessionMeta);
      if (this.closed) {
        agent.dispose();
        return;
      }
      this.sessionFresh = true;
      this.rulesDue = false;
      // A new session starts with an empty context; the old count would read as a compaction.
      this.usage = undefined;
      this.setStatus(this.current ? "running" : "idle");
      this.host.emit("chat.snapshot", this.snapshot());
    } catch (e) {
      this.agent = null;
      if (this.closed) throw e;
      const msg = (e as Error).message;
      const hint = e instanceof AgentStartError && e.authRequired ? `\n${this.spec.loginHint}` : "";
      this.setStatus("error", `${msg}${hint}`);
      throw e;
    }
  }

  /** Stop the agent. `forget` drops the transcript instead of saving it (the user started a new chat). */
  close(opts: { forget?: boolean } = {}): void {
    if (opts.forget) this.forgotten = true;
    this.closed = true;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (this.machinePoll) clearInterval(this.machinePoll);
    this.machinePoll = null;
    this.turn?.controller.abort();
    if (this.busyJob) this.cancelCellJob();
    this.queue = [];
    this.failPrompts();
    for (const r of this.reviews.values()) r.waiters.forEach((w) => w("pending"));
    this.agent?.dispose();
    this.agent = null;
    this.detachRole?.();
    if (this.shells.names().length) {
      void this.shells.closeIdle((code, wait) => this.call({ op: "machine_exec", code, waitMs: wait }, Math.min(wait, 2_500))).catch(() => {});
    }
    this.setStatus("closed");
    this.persistNow();
  }

  // ------------------------------------------------------------ turns

  send(text: string, extra: Omit<TurnInput, "text"> = {}): void {
    if (this.closed) return;
    const willQueue = this.status === "running" || !!this.current || !!this.busyJob;
    if (willQueue && this.queue.length >= QUEUE_MAX) {
      // The queue is bounded: a new message past the cap is refused with a notice,
      // never piled up silently. What is already queued is left alone (Stop clears it).
      this.notice(`The message queue is full (${QUEUE_MAX}). Wait for the agent to catch up, or Stop it, then send again.`);
      return;
    }
    const parts: Part[] = [{ type: "text", text }];
    if (extra.cells?.length) parts.push({ type: "cells", cells: extra.cells });
    const msg = this.newMessage("user", parts);
    // Attached cells are what the `cell` scope may edit, unless the user pinned others.
    const input: TurnInput = { text, ...(extra.cells?.length ? { targets: extra.cells.map((c) => c.cellId) } : {}), ...extra };
    if (willQueue) {
      // The user sees this message waiting; the mark goes when its turn begins (dequeue).
      msg.queued = true;
      this.touch(msg);
      this.queue.push({ input, messageId: msg.id });
      return;
    }
    this.touch(msg);
    void this.runTurn(input);
  }

  /** Remove one queued user message before its turn starts (B1.3 phase 2). */
  dequeueMessage(messageId: string): boolean {
    const idx = this.queue.findIndex((q) => q.messageId === messageId);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    const msgIdx = this.messages.findIndex((m) => m.id === messageId);
    if (msgIdx >= 0) {
      const [removed] = this.messages.splice(msgIdx, 1);
      if (removed) {
        this.dirty.delete(removed);
        this.dirtyParts.delete(removed.id);
        this.sent.delete(removed.id);
        this.sentChanges.delete(removed.id);
        this.sentQueued.delete(removed.id);
        this.sentPinned.delete(removed.id);
      }
    }
    this.host.emit("chat.snapshot", this.snapshot());
    this.schedulePersist();
    return true;
  }

  /** Pin or unpin a message so it survives the 200-message transcript trim (B4.3). */
  pin(messageId: string, pinned: boolean): boolean {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg) throw new Error("Message not found in this chat.");
    if (pinned && !msg.pinned) {
      const count = this.messages.filter((m) => m.pinned).length;
      if (count >= MAX_PINS) throw new Error(`At most ${MAX_PINS} messages can be pinned per chat. Unpin one first.`);
    }
    if (!!msg.pinned === pinned) return !!msg.pinned;
    if (pinned) msg.pinned = true;
    else delete msg.pinned;
    this.touchMeta(msg);
    return !!msg.pinned;
  }

  /** Notify an open non-Mentor notebook chat when a run of its OpenResearch project finishes (C4). */
  onProjectRunFinished(run: ResearchRun, title?: string): void {
    if (this.closed || this.role) return;
    const label = title ? `"${title}"` : `experiment ${run.experimentId}`;
    const tone: ChatCard["tone"] = run.status === "done" ? "ok" : run.status === "failed" || run.status === "lost" ? "error" : "info";
    const statusWord = run.status === "done" ? "finished" : run.status;
    this.addCard(
      {
        kind: "run",
        tone,
        title: `Project run ${statusWord} (${label})`,
        detail: `Run ${run.id}${run.exitCode != null ? ` · exit ${run.exitCode}` : ""}${run.backend ? ` · ${run.backend}` : ""}`,
        actions: [
          { id: "inspect", label: "Inspect in chat" },
          { id: "dismiss", label: "Dismiss" },
        ],
      },
      (actionId) => {
        if (actionId === "inspect") {
          this.send(`Inspect the results of project run \`${run.id}\` (${label}, status: ${run.status}) using \`run_read\`.`);
        }
      },
    );
  }

  /** Take the next queued message: its turn begins, so the queued mark goes (a patch carries queued:false). */
  private dequeue(): TurnInput | undefined {
    const next = this.queue.shift();
    if (!next) return undefined;
    const msg = this.messages.find((m) => m.id === next.messageId);
    if (msg?.queued) {
      msg.queued = false;
      this.touchMeta(msg);
    }
    return next.input;
  }

  private async runTurn(input: TurnInput): Promise<void> {
    const reply = this.newMessage("agent", []);
    this.current = reply;
    this.lastActiveAt = Date.now();
    this.watchdogFired = false;
    const turn: NonNullable<Chat["turn"]> = { controller: new AbortController(), prompting: false, project: null, code: null };
    this.turn = turn;
    this.setStatus("running");
    try {
      await this.ensureStarted();
      turn.controller.signal.throwIfAborted();
      const prompt = await this.buildPrompt(input);
      turn.controller.signal.throwIfAborted();
      turn.prompting = true;
      this.armWatchdog();
      const res = await this.agent!.prompt(prompt);
      if (this.closed) return;
      this.sessionFresh = false;
      this.pendingRecap = "";
      if (res.stopReason === "cancelled" || turn.controller.signal.aborted) this.addPart(reply, { type: "notice", level: "info", text: "Stopped." });
      else if (res.stopReason === "refusal") this.addPart(reply, { type: "notice", level: "error", text: "The agent refused this request." });
      else if (res.stopReason === "max_tokens" || res.stopReason === "max_turn_requests") {
        this.addPart(reply, { type: "notice", level: "info", text: `The agent stopped early (${res.stopReason}). Say "continue" to go on.` });
      }
      this.setStatus("idle");
    } catch (e) {
      if (this.closed) return;
      const msg = (e as Error).message ?? String(e);
      if (turn.controller.signal.aborted) {
        this.addPart(reply, { type: "notice", level: "info", text: "Stopped." });
        if (this.status !== "error") this.setStatus("idle");
      } else if (this.status !== "error") {
        this.addPart(reply, { type: "notice", level: "error", text: capText(msg, 2000) });
        this.setStatus(this.agent?.running ? "idle" : "error", this.agent?.running ? undefined : msg);
      } else {
        this.addPart(reply, { type: "notice", level: "error", text: capText(this.error ?? msg, 2000) });
      }
    } finally {
      this.clearWatchdog();
      if (turn.prompting && turn.code) void this.syncCode(turn.code, firstLine(input.text, 72));
      this.closeOpenTools(reply);
      this.current = null;
      this.turn = null;
      this.rawInputs.clear();
      this.orphanCalls = [];
      this.flush();
      // Later changes to this turn's message (a review decided) are rare: send them whole.
      this.sent.clear();
      this.sentChanges.clear();
      this.trimTranscript();
      const next = this.dequeue();
      if (next !== undefined && !this.closed) void this.runTurn(next);
    }
  }

  private async withBusyJob<T>(fn: (controller: AbortController) => Promise<T>): Promise<T> {
    if (this.current || this.busyJob) throw new Error("Wait for the agent's turn or the current notebook job to finish first.");
    const controller = new AbortController();
    this.busyJob = { controller };
    this.lastActiveAt = Date.now();
    try {
      return await fn(controller);
    } finally {
      this.busyJob = null;
      const next = this.dequeue();
      if (next !== undefined && !this.closed) void this.runTurn(next);
    }
  }

  /**
   * Keep the transcript window the store keeps on disk (the last MAX_MESSAGES).
   * A message older than the window loses its undo journal here just as it would
   * after a restart, so what the chat offers matches what was saved. The UI keeps
   * its own local copy, so dropping old messages here does not jerk the view.
   * Only between turns: mid-turn the reply and its journal must stay whole.
   */
  private trimTranscript(): void {
    const { kept: next, dropped } = trimMessages(this.messages, MAX_MESSAGES);
    if (!dropped.length) return;
    this.messages = next;
    const kept = new Set(this.messages.map((m) => m.id));
    for (const id of [...this.journal.keys()]) if (!kept.has(id)) this.journal.delete(id);
    for (const m of dropped) {
      this.dirty.delete(m);
      this.dirtyParts.delete(m.id);
      this.sent.delete(m.id);
      this.sentChanges.delete(m.id);
      this.sentQueued.delete(m.id);
      this.sentPinned.delete(m.id);
    }
    // A card on a dropped message can no longer be pressed here (its handler is gone with it).
    for (const [id, entry] of [...this.cards]) if (!kept.has(entry.message.id)) this.cards.delete(id);
  }

  /** One notice when a turn hears nothing from the agent for WATCHDOG_MS. Notice only: never cancels. */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.watchdogFired || this.closed || !this.current) return;
      this.watchdogFired = true;
      // A long-thinking agent is legitimate; the user decides whether to Stop, not the bridge.
      this.addPart(this.current, {
        type: "notice",
        level: "info",
        text: `The agent has sent nothing for ${WATCHDOG_MS / 60_000} minutes. It may be thinking, or stuck. You can Stop it and send your message again.`,
      });
    }, WATCHDOG_MS);
    this.watchdogTimer.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async buildPrompt(input: TurnInput): Promise<string> {
    if (this.role) {
      const rules = this.sessionFresh || this.rulesDue;
      this.rulesDue = false;
      return this.role.prompt({
        text: input.text,
        ...(input.context ? { context: input.context } : {}),
        rules,
        recap: this.pendingRecap,
        cells: async () => {
          try {
            this.notebook = (await this.call({ op: "info" })) as NotebookInfo;
            return (await this.call({ op: "get_cells" })).cells;
          } catch {
            this.notebook = null;
            return null;
          }
        },
        activity: () => this.activityBlock(),
        attached: async () => (input.cells?.length ? this.attachedBlock(input.cells, this.notebook) : null),
      });
    }
    const signal = this.turn?.controller.signal;
    const rules = this.sessionFresh || this.rulesDue;
    const full = rules || !!this.pendingRecap;
    // The independent fetches run together; the blocks below keep their order and
    // meaning. The machine read is raced against 1.5s so a slow kernel never holds
    // the turn, and it no longer blocks the project, notebook or attached reads.
    let machineTimer: ReturnType<typeof setTimeout> | undefined;
    const machineP = Promise.race([
      this.refreshMachine(),
      new Promise<void>((resolve) => { machineTimer = setTimeout(resolve, 1500); }),
    ]).finally(() => { if (machineTimer) clearTimeout(machineTimer); });
    const projectP = this.projectBlock(full);
    // info then the outline; this.notebook is final once this resolves (null if either failed).
    const cellsP = (async (): Promise<CellInfo[] | null> => {
      try {
        this.notebook = (await this.call({ op: "info" })) as NotebookInfo;
        return (await this.call({ op: "get_cells", summary: true })).cells;
      } catch {
        this.notebook = null;
        return null;
      }
    })();
    // The file path and the attached cells need only the notebook; the code needs
    // the notebook and the project (turn.project). None waits on the machine read.
    const fileP = cellsP.then(() => (this.notebook ? notebookPath(this.toolContext(), this.notebook).catch(() => null) : null));
    const attachedP = cellsP.then(() => (input.cells?.length ? this.attachedBlock(input.cells, this.notebook) : null));
    const codeP = Promise.all([projectP, cellsP]).then(() => {
      signal?.throwIfAborted();
      return this.codeBlock(full);
    });
    const [project, cells, code, attached, file] = await Promise.all([projectP, cellsP, codeP, attachedP, fileP]);
    signal?.throwIfAborted();
    await machineP;
    signal?.throwIfAborted();
    const state = cells ? runState(cells).join("\n") : "";
    const runLines = state && (rules || state !== this.lastRunState) ? state.split("\n") : null;
    this.lastRunState = state;
    this.turnTargets = this.settings.targetCellIds.length
      ? this.settings.targetCellIds
      : input.targets ?? (this.notebook?.selectedCellIds.length
        ? this.notebook.selectedCellIds
        : this.notebook?.activeCellId
          ? [this.notebook.activeCellId]
          : []);
    const blocks: string[] = [];
    if (rules) blocks.push(playbook(this.notebook, file, !!this.host.project));
    this.rulesDue = false;
    if (this.pendingRecap) blocks.push(this.pendingRecap);
    if (this.undoNotes.length) {
      blocks.push(`<undo-note>\n${this.undoNotes.join("\n")}\n</undo-note>`);
      this.undoNotes = [];
    }
    // The outline is resent only when it changed; the agent still has the last one.
    const outline = cells ? JSON.stringify(cells.map((c) => [c.id, c.type, c.source])) : "";
    const unchanged = !!cells && !rules && !this.pendingRecap && outline === this.lastOutline;
    this.lastOutline = outline;
    if (project) blocks.push(project);
    if (code) blocks.push(code);
    const lit = this.host.project ? litReview(input.text) : null;
    if (lit) blocks.push(lit);
    const activity = this.activityBlock();
    if (activity) blocks.push(activity);
    if (input.context) blocks.push(input.context);
    if (attached) blocks.push(attached);
    blocks.push(turnContext(this.notebook, cells, this.settings, this.turnTargets, unchanged, file, runLines, this.machine ? machineLine(this.machine, Date.now()) : null));
    blocks.push(input.text);
    return blocks.join("\n\n");
  }

  /** Cells the user ran and kernel restarts since the agent's last turn. */
  private activityBlock(): string | null {
    if (!this.activity.length && !this.kernelNotes.length) return null;
    const runs = this.activity.map((run) => {
      const status = `${run.status}${run.durationMs === undefined ? "" : ` (${runDuration(run.durationMs)})`}`;
      const error = run.ename ? ` ${run.ename}${run.evalue ? `: ${firstLine(run.evalue, 100)}` : ""}` : "";
      return `[${run.index}] ${run.cellId} ${status}${error}`;
    });
    const activity = [
      this.activity.length ? `Since your last turn the user ran these cells themselves, oldest first:\n${runs.join(" · ")}` : "",
      ...this.kernelNotes,
    ].filter(Boolean).join("\n");
    this.activity = [];
    this.kernelNotes = [];
    return `<notebook-activity>\n${activity}\n</notebook-activity>`;
  }

  /** The tools this chat's agent gets. */
  tools(): readonly ToolDef<any, any>[] {
    return this.role ? this.role.tools() : TOOLS;
  }

  /** A turn or a notebook job is running (or waiting). */
  isBusy(): boolean {
    return !!(this.current || this.busyJob || this.queue.length);
  }

  /** Resolves once no turn runs or waits (polling: rare, long waits). */
  async whenIdle(signal?: AbortSignal): Promise<void> {
    while (!this.closed && (this.current || this.queue.length || this.status === "running") && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** Run `fn` as this chat's job: the user's messages wait for it, Stop aborts its signal. Refused while the chat is busy. */
  runJob<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withBusyJob((controller) => fn(controller.signal));
  }

  /** The cells the user attached, read now with their outputs. `info` is passed in (not read from
   * this.notebook) so the attached read does not race the notebook read when they run in parallel. */
  private async attachedBlock(attached: AttachedCell[], info: NotebookInfo | null): Promise<string> {
    let found: CellInfo[] | null = null;
    if (info) {
      try {
        found = (await this.call({ op: "get_cells", cellIds: attached.map((c) => c.cellId), includeOutputs: true })).cells;
      } catch {
        // The agent is told to read them itself.
      }
    }
    return attachedCellsBlock(attached, found, (c) => renderCell(c, true));
  }

  // ------------------------------------------------------------ project

  /**
   * What the agent is told about the project this turn: everything on a
   * fresh session (or after a compaction or a move), else what changed since
   * its last message, else nothing. Never waits on OpenResearch to start.
   */
  private async projectBlock(full: boolean): Promise<string | null> {
    const turn = this.turn;
    const host = this.host.project;
    if (!host || !turn) return null;
    let revision = this.projectRevision;
    let moved = this.projectMoved;
    const cached = host.cached();
    let project = this.project;
    const res = await host.resolve(false).catch((e): ProjectResolution | null => {
      if (project) project = { ...project, state: "unavailable", error: describeFailure(e) };
      return null;
    });
    if (res) {
      project = res.project;
      if (revision === this.projectRevision) {
        this.setProject(res);
        // A move this answer itself showed (Scratch was replaced) is told in this turn's brief.
        moved = this.projectMoved;
        revision = this.projectRevision;
      }
    }
    turn.project = usableProject(res?.orx, project, cached);
    if (res?.orx) {
      try {
        // Told once (again after a compaction or a move); changes later are the user's to mention.
        let text: string | null = null;
        if (full || moved || this.lastBrief?.id !== res.orx.id) {
          const brief = await host.links.brief(res.orx);
          const note = moved ? `The user moved this notebook to the project ${brief.name}. What you were told about another project no longer applies.` : undefined;
          text = projectContext(brief, note);
          this.lastBrief = brief;
        }
        if (revision === this.projectRevision) this.projectMoved = false;
        this.lastProjectNote = "";
        return text;
      } catch (e) {
        if (project) project = { ...project, state: "unavailable", error: describeFailure(e) };
      }
    }
    if (!project) return null;
    const note = projectUnavailable(project);
    if (!full && note === this.lastProjectNote) return null;
    this.lastProjectNote = note;
    return note;
  }

  /**
   * The project's code on the notebook's machine: cloned (the chat's branch)
   * before the first turn, and again if the machine was replaced. The agent
   * is told where, when that changes; the user sees it once.
   */
  private async codeBlock(full: boolean): Promise<string | null> {
    const turn = this.turn;
    const orx = turn?.project;
    if (!this.code || !turn || !orx || !this.notebookKey) return null;
    if (!this.code.current && remoteOf(orx)) this.show("Putting the project's code on the notebook's machine…", "preparing");
    const st = await this.ensureCode(orx);
    let note: string;
    if (st.state === "ready") {
      const p = st.place;
      turn.code = p;
      note = [
        "<project-code>",
        `The project's code is cloned on the notebook's machine at ${p.dir}: git, branch ${p.branch}, remote origin on GitHub (signed in, you may push this branch).`,
        "Change and run the code there with your usual tools; commit when a step is done. After each of your turns the bridge commits what is left and pushes the branch, " +
          "and it reaches the user's computer (files over 50 MB stay on the machine). Do not rewrite the branch's history or push other branches.",
        "</project-code>",
      ].join("\n");
      this.show(`The project's code is on the notebook's machine at ${p.dir} (branch ${p.branch}).`, `${p.dir}\n${p.branch}`);
    } else {
      note = `<project-code>\n${st.why}\n</project-code>`;
      this.show(st.state === "error" ? `Project code: ${st.why}` : st.why, st.why);
    }
    if (!full && note === this.lastCodeNote) return null;
    this.lastCodeNote = note;
    return note;
  }

  private async ensureCode(orx: ProjectCache): Promise<CodeState> {
    if (!this.code || !this.notebookKey) throw new Denied("This chat has no project code on the notebook's machine.");
    const key = this.notebookKey;
    const title = this.notebook?.title?.replace(/\.ipynb$/i, "") || "notebook";
    // Checking a clone already there is quick: the header shows "pushing" only when it is not.
    if (!this.code.current) this.setCodeState({ state: "pushing" });
    try {
      const st = await this.code.ensure(orx, async () => {
        const wt = await ensureWorktree(orx.repoPath, orx.id, key, title);
        this.showWorktree(orx.id, wt.path);
        return wt;
      });
      this.setCodeState(st.state === "ready"
        ? { state: "ready", dir: st.place.dir, branch: st.place.branch }
        : { state: st.state === "none" ? "none" : "missing", why: st.why });
      return st;
    } catch (e) {
      this.setCodeState({ state: "missing", why: describeFailure(e) });
      throw e;
    }
  }

  private setCodeState(next: ChatCode): void {
    if (!this.code || JSON.stringify(next) === JSON.stringify(this.codeState)) return;
    this.codeState = next;
    // A metadata change mid-session: send just the field, not the whole transcript again.
    if (!this.closed) this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, code: next });
  }

  /** The user's "put the code on the machine" (the notebook header): now, not waiting for the next message. */
  async pushCode(): Promise<ChatCode> {
    if (!this.code) throw new Denied("This chat has no project code on the notebook's machine.");
    if (this.codeState?.state === "pushing") return this.codeState;
    let st: CodeState;
    try {
      st = await this.ensureCode(await this.requireProject());
    } catch (e) {
      this.setCodeState({ state: "missing", why: describeFailure(e) });
      throw e;
    }
    if (st.state === "ready") this.show(`The project's code is on the notebook's machine at ${st.place.dir} (branch ${st.place.branch}).`, `${st.place.dir}
${st.place.branch}`);
    else this.show(st.state === "error" ? `Project code: ${st.why}` : st.why, st.why);
    return this.codeState!;
  }

  /** A notice about the code, once for each state. */
  private show(text: string, key: string): void {
    if (key === this.lastCodeShown) return;
    this.lastCodeShown = key;
    this.system(text);
  }

  /** After a turn: what changed on the machine goes to the branch and the user's computer. */
  private async syncCode(place: CodePlace, subject: string): Promise<void> {
    if (!this.code) return;
    const started = Date.now();
    const r = await this.code.syncBack(place, `Notebook chat: ${subject}`, () => {
      if (!this.closed) this.system(`Pushing the code from the notebook's machine is taking longer than usual (terminal session "${place.session}").`);
    }).catch((e: Error) => ({ ok: false, changed: false, text: `Could not save the code from the notebook's machine: ${e.message}` }));
    this.lastSyncAt = Date.now();
    if (r.ok) this.lastSavedAt = this.lastSyncAt;
    this.dirtySinceSync = !r.ok || this.lastUserRunAt > started;
    if (r.changed) this.host.project?.links.markDirty(place.projectId);
    if (!this.code.current && this.codeState?.state === "ready") this.setCodeState({ state: "missing", why: r.text || "The project's code is no longer on the notebook's machine." });
    if (this.closed) return;
    if (r.text) this.system(r.text);
  }

  private scheduleAutosave(): void {
    if (this.closed || !this.code?.current || this.autosaveTimer) return;
    const place = this.code.current;
    if (!this.lastSyncAt) this.lastSyncAt = Date.now();
    const wait = Math.max(0, this.lastSyncAt + AUTOSAVE_MS - Date.now());
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      if (this.closed) return;
      if (this.current) {
        // A turn cancelled before prompting cannot sync; try again after one interval.
        this.lastSyncAt = Date.now();
        this.scheduleAutosave();
        return;
      }
      if (!this.dirtySinceSync) return;
      void this.autosave(place);
    }, wait);
    this.autosaveTimer.unref?.();
  }

  private async autosave(place: CodePlace): Promise<void> {
    if (!this.code) return;
    const started = Date.now();
    let ok = false;
    try {
      const r = await this.code.syncBack(place, "Autosave", () => {});
      ok = r.ok;
      this.lastSyncAt = Date.now();
      if (r.ok) this.lastSavedAt = this.lastSyncAt;
      this.dirtySinceSync = !r.ok || this.lastUserRunAt > started;
      if (r.changed) this.host.project?.links.markDirty(place.projectId);
      if (r.ok && r.changed && !this.closed) this.system(r.text);
    } catch {
      this.lastSyncAt = Date.now();
      this.dirtySinceSync = true;
    }
    if (!ok) this.dirtySinceSync = true;
    this.scheduleAutosave();
  }

  /** The project as OpenResearch just described it; a change reaches the chat UI. */
  setProject(res: ProjectResolution, moved = false): void {
    const before = this.project;
    const codeBefore = this.codeState;
    if (moved || (before?.id && res.project.id && before.id !== res.project.id)) {
      this.projectMoved = true;
      this.projectRevision++;
      // What the header said about the old project's code (there, or never put there) no longer holds.
      if (this.code && this.codeState?.state !== "pushing") {
        this.codeState = { state: "missing", why: `The code of ${res.project.name} is not on the notebook's machine yet.` };
        this.lastCodeShown = "";
      }
    }
    this.project = res.project;
    if (res.notice) this.system(res.notice);
    if (JSON.stringify(before) !== JSON.stringify(res.project) || codeBefore !== this.codeState) {
      this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, project: this.project, ...(codeBefore !== this.codeState ? { code: this.codeState } : {}) });
    }
  }

  /**
   * The project, giving OpenResearch time to answer, else as the notebook
   * last saw it; a tool that needs it fails with why it is not there.
   */
  private async requireProject(): Promise<ProjectCache> {
    const host = this.host.project;
    if (!host) throw new Denied("This chat has no project: its notebook has no stable address.");
    const res = await host.resolve(true);
    this.setProject(res);
    const p = res.project;
    const usable = usableProject(res.orx, p, host.cached());
    if (usable) return usable;
    if (p.state === "missing") throw new Denied(p.error ?? `The project ${p.name} no longer exists.`);
    throw new Denied(`The project is not available right now: ${p.error ?? "OpenResearch is not running."}`);
  }

  private projectToolContext(turn = this.turn): ProjectToolContext {
    const host = this.host.project;
    if (!host) throw new Denied("This chat has no project: its notebook has no stable address.");
    const ctx = this.toolContext();
    return Object.assign(ctx, {
      research: host.research,
      links: host.links,
      notebookKey: this.notebookKey,
      project: async () => {
        // A turn stays in the project it started in, even if the notebook is moved meanwhile.
        if (turn?.project) return turn.project;
        // Not there when the turn started (OpenResearch was still starting): wait for it now.
        const project = await this.requireProject();
        if (turn) turn.project ??= project;
        return project;
      },
      created: this.createdArtifacts,
      confirm: async (summary: string, detail: string, yes: string, no: string) => {
        const answer = await this.ask(summary, detail, [
          { id: "yes", name: yes, kind: "allow_once" },
          { id: "no", name: no, kind: "reject_once" },
        ], undefined, ctx.waitMs);
        if (answer === "expired") throw new Denied("The question expired. Nothing was done. Ask the user before trying again.");
        return answer === "yes";
      },
    });
  }

  /** The chat's worktree became known: the Chat Worktree view shows it. */
  private showWorktree(projectId: string, path: string): void {
    if (!this.project || this.project.id !== projectId || this.project.worktree === path) return;
    this.project = { ...this.project, worktree: path };
    this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, project: this.project });
  }

  runProjectTool(name: string, args: unknown): Promise<ToolResult> {
    this.markNotebookCall(name, args, "project");
    try {
      return callTool(this.projectToolContext(), name, args, PROJECT_TOOLS).then(hideTokens);
    } catch (e) {
      return Promise.resolve({ text: (e as Error).message, isError: true });
    }
  }

  /** "Save notebook to project" in the chat. */
  async saveNotebookNow(): Promise<string> {
    if (!this.notebookKey) throw new Denied("This chat has no project: its notebook has no stable address.");
    const r = await saveNotebook(this.projectToolContext(null), { user: { notebookKey: this.notebookKey } });
    this.system(`Saved the notebook to ${r.path} in ${r.project.name}.`);
    return r.path;
  }

  /** Run every code cell from a reset Python namespace, and save only when all pass. */
  async verifyAndSave(): Promise<void> {
    if (this.current || this.busyJob) throw new Error("Wait for the agent's turn or the current notebook job to finish first.");
    if (!this.notebookKey) throw new Denied("This chat has no project: its notebook has no stable address.");
    await this.requireProject();
    const info = await this.call({ op: "info" });
    if (info.language.toLowerCase() !== "python") throw new Error("Verifying needs a Python kernel.");
    if (info.kernel !== "idle") throw new Error("The kernel is busy or not connected.");
    const { cells } = await this.call({ op: "get_cells" });
    const snapshot = cells.filter((c) => c.type === "code").map((c) => ({ id: c.id, source: c.source }));
    const ids = snapshot.map((c) => c.id);
    if (!ids.length) throw new Error("There are no code cells to verify.");
    let cardId = "";
    const card = this.addCard({
      kind: "verify",
      tone: "info",
      title: "Run the whole notebook from a clean state?",
      detail: `Variables in memory are cleared first; ${ids.length} code cells run in order. Installed packages and files stay. This uses %reset -f, not a kernel restart: imported modules stay cached. Python (IPython) only.`,
      actions: [{ id: "verify", label: "Verify", primary: true }, { id: "dismiss", label: "Cancel" }],
    }, (action) => {
      if (action === "verify") void this.verifyCells(cardId, snapshot);
      else if (action === "cancel") this.cancelCellJob();
    });
    cardId = card.cardId;
  }

  private async verifyCells(cardId: string, snapshot: { id: string; source: string }[]): Promise<void> {
    const entry = this.cards.get(cardId);
    if (!entry) return;
    const ids = snapshot.map((c) => c.id);
    if (this.current || this.busyJob) {
      entry.card.detail = "Wait for the agent's turn or the current notebook job to finish, then try Verify again.";
      this.touchCard(entry);
      return;
    }
    entry.card.progress = { done: 0, total: ids.length };
    entry.card.actions = [{ id: "cancel", label: "Stop" }];
    entry.card.detail = "Running from a clean state (%reset -f, not a kernel restart).";
    this.touchCard(entry);
    try {
      await this.withBusyJob(async (controller) => {
        const reset = await this.call({ op: "execute", code: "%reset -f", waitMs: 15_000 }, 30_000);
        if (reset.status !== "ok") {
          this.closeCard(cardId, "done", `Could not clear variables with %reset -f${reset.message ? `: ${reset.message}.` : "."} Nothing was saved.`);
          return;
        }
        const result = await this.runCellsInOrder(ids, (done) => {
          entry.card.progress = { done, total: ids.length };
          this.touchCard(entry);
        }, controller.signal);
        if (result.cancelled) {
          this.closeCard(cardId, "done", "Stopped by the user. Nothing was saved.");
          return;
        }
        if (result.failedAt) {
          this.closeCard(cardId, "done", `Stopped at cell [${result.failedAt.index}]: it failed. Nothing was saved.`);
          return;
        }
        if (controller.signal.aborted) {
          this.closeCard(cardId, "done", "Stopped by the user. Nothing was saved.");
          return;
        }
        if (this.closed) return;
        const { cells: current } = await this.call({ op: "get_cells" });
        const currentSnapshot = current.filter((c) => c.type === "code").map((c) => ({ id: c.id, source: c.source }));
        if (controller.signal.aborted) {
          this.closeCard(cardId, "done", "Stopped by the user. Nothing was saved.");
          return;
        }
        if (this.closed) return;
        if (JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot)) {
          this.closeCard(cardId, "done", "The notebook changed during verification. Nothing was saved.");
          return;
        }
        entry.card.actions = [];
        entry.card.detail = "Saving the verified notebook…";
        this.touchCard(entry);
        const saved = await saveNotebook(this.projectToolContext(null), { user: { notebookKey: this.notebookKey! } });
        this.closeCard(cardId, "done", `Verified: ${ids.length} cells ran from a clean state. Saved to ${saved.path}.`, "ok");
      });
    } catch (e) {
      if (!this.closed && this.cards.has(cardId)) this.closeCard(cardId, "done", `Verification failed: ${(e as Error).message}. Nothing was saved.`);
    }
  }

  async cancel(): Promise<boolean> {
    this.queue = [];
    this.failPrompts();
    if (this.busyJob) {
      this.cancelCellJob();
      return true;
    }
    if (!this.current) return false;
    this.turn?.controller.abort();
    if (this.turn?.prompting) await this.agent?.cancel().catch(() => {});
    return true;
  }

  // ------------------------------------------------------------ settings

  updateSettings(settings: ChatSettings): void {
    this.settings = this.role ? this.role.settings : settings;
    this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, settings: this.settings });
  }

  async setOption(optionId: string, value: string | boolean): Promise<void> {
    if (this.current) throw new Error("Wait for the turn to finish before changing the agent's settings.");
    await this.ensureStarted();
    await this.agent!.setOption(optionId, value);
    this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, options: this.options() });
  }

  // ------------------------------------------------------------ agent events

  private onUpdate(n: SessionNotification): void {
    // Any session/update means the agent is alive: restart the silence window (notice only, never cancel).
    if (this.watchdogTimer && !this.watchdogFired) this.armWatchdog();
    const u = n.update;
    if (u.sessionUpdate === "config_option_update") {
      this.agent?.applyConfigUpdate((u as any).configOptions ?? []);
      this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, options: this.options() });
      return;
    }
    if (u.sessionUpdate === "usage_update") {
      const x = u as unknown as { used?: unknown; size?: unknown; cost?: { amount?: unknown; currency?: unknown } | null };
      if (typeof x.used !== "number" || typeof x.size !== "number") return;
      // For agents that compact without saying so: a context that shrinks this much was compacted.
      const before = this.usage?.used;
      if (before !== undefined && before >= COMPACTION_MIN_TOKENS && x.used < before * COMPACTION_SHRINK) this.rulesDue = true;
      this.usage = { used: x.used, size: x.size };
      if (typeof x.cost?.amount === "number" && typeof x.cost.currency === "string") this.usage.cost = { amount: x.cost.amount, currency: x.cost.currency };
      this.host.emit("chat.usage", { chatId: this.id, tabId: this.tabId, usage: this.usage });
      return;
    }
    if (u.sessionUpdate === "compaction_update") {
      const status = (u as unknown as { status?: unknown }).status;
      if (status === "completed" && !this.rulesDue) {
        this.rulesDue = true;
        this.addPart(this.current ?? this.lastAgentMessage(), {
          type: "notice",
          level: "info",
          text: `${this.spec.name} compacted its context. The notebook rules go with your next message again.`,
        });
      }
      return;
    }
    if (u.sessionUpdate === "current_mode_update") {
      this.agent?.applyModeUpdate((u as any).currentModeId);
      this.host.emit("chat.meta", { chatId: this.id, tabId: this.tabId, options: this.options() });
      return;
    }
    if (!["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"].includes(u.sessionUpdate)) return;
    const msg = this.current ?? this.lastAgentMessage();
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "image") {
          const { mimeType, data } = u.content;
          this.addImage(msg, mimeType, data, "Image from agent");
          return;
        }
        if (u.content.type !== "text") return;
        const type = u.sessionUpdate === "agent_message_chunk" ? "text" : "thought";
        const last = msg.parts.at(-1);
        if (last && last.type === type) last.text += u.content.text;
        else msg.parts.push({ type, text: u.content.text });
        this.touch(msg, msg.parts.length - 1);
        return;
      }
      case "tool_call": {
        const existing = findTool(msg, u.toolCallId);
        const part: Part = {
          type: "tool",
          toolCallId: u.toolCallId,
          title: u.title,
          kind: u.kind ?? null,
          status: u.status ?? "pending",
          detail: toolDetail(u.rawInput, u.content),
          notebook: (existing?.notebook ?? false) || isNotebookTool(u.title, (u as any)._meta),
        };
        this.noteInput(u.toolCallId, u.rawInput);
        if (existing) Object.assign(existing, part);
        else {
          msg.parts.push(part);
          this.claimOrphans(part as Extract<Part, { type: "tool" }>);
        }
        this.touch(msg, msg.parts.indexOf(existing ?? part));
        return;
      }
      case "tool_call_update": {
        const part = findTool(msg, u.toolCallId);
        if (!part) return;
        this.noteInput(u.toolCallId, u.rawInput);
        if (u.title) {
          part.title = u.title;
          part.notebook ||= isNotebookTool(u.title, (u as any)._meta);
        }
        if (u.status) part.status = u.status;
        if (u.kind) part.kind = u.kind;
        const detail = toolDetail(u.rawInput ?? undefined, u.content ?? undefined, u.rawOutput);
        if (detail) part.detail = detail;
        this.touch(msg, msg.parts.indexOf(part));
        return;
      }
      case "plan": {
        const entries = u.entries.map((e) => ({ content: e.content, status: e.status }));
        const existing = msg.parts.find((p) => p.type === "plan");
        if (existing && existing.type === "plan") existing.entries = entries;
        else msg.parts.push({ type: "plan", entries });
        this.touch(msg, existing ? msg.parts.indexOf(existing) : msg.parts.length - 1);
        return;
      }
      default:
        return;
    }
  }

  private onPermission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const title = req.toolCall.title ?? "The agent wants to use a tool";
    const detail = toolDetail(req.toolCall.rawInput ?? undefined, req.toolCall.content ?? undefined);
    if (this.settings.notebookOnly && !this.isNotebookPermission(req)) {
      // Refuse without asking; the user sees what was refused and how to allow it.
      const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
      const msg = this.current ?? this.lastAgentMessage();
      this.addPart(msg, {
        type: "notice",
        level: "info",
        text: `Refused "${capText(title, 120)}": Notebook only is on. Turn it off to let the agent use its own tools on this computer.`,
      });
      return Promise.resolve(reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } });
    }
    if (!this.settings.review && this.isNotebookPermission(req)) {
      // Some agents (Antigravity) ask before every MCP call whatever their mode.
      // Our notebook tools have their own gate, Review: with it off the user
      // chose not to be asked, so a second question would only stall the turn.
      const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind === "allow_always");
      if (allow) return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    return this.ask(title, detail, req.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })), signal).then((answer) =>
      answer === "cancelled" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: answer } },
    );
  }

  /** A permission request for one of our notebook tools (some agents ask before any MCP call). */
  private isNotebookPermission(req: RequestPermissionRequest): boolean {
    const call = req.toolCall;
    if (isNotebookTool(call.title ?? undefined, (call as any)._meta)) return true;
    // The agent may have announced the call (with its real name) before asking.
    for (const m of [this.current, this.messages.at(-1)]) {
      const known = m && findTool(m, call.toolCallId);
      if (known?.notebook) return true;
    }
    return false;
  }

  /** Show a question in the transcript and wait for the user's choice. */
  private ask(title: string, detail: string | undefined, options: { id: string; name: string; kind: string }[], signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    const promptId = randomUUID();
    const msg = this.current ?? this.lastAgentMessage();
    const part: Part = { type: "prompt", promptId, title, detail, options };
    msg.parts.push(part);
    this.touch(msg, msg.parts.length - 1);
    return new Promise<string>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => done("cancelled");
      const done = (answer: string) => {
        if (!this.prompts.has(promptId)) return;
        this.prompts.delete(promptId);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        part.answer = answer;
        this.touch(msg, msg.parts.indexOf(part));
        resolve(answer);
      };
      this.prompts.set(promptId, done);
      if (timeoutMs !== undefined) timer = setTimeout(() => done("expired"), Math.max(0, timeoutMs));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  answer(promptId: string, optionId: string): boolean {
    const p = this.prompts.get(promptId);
    if (!p) return false;
    p(optionId);
    return true;
  }

  private addCard(partial: Omit<ChatCard, "cardId" | "state">, onAction: (actionId: string) => void): ChatCard {
    const card: ChatCard = { ...partial, cardId: randomUUID(), state: "open" };
    // During a turn it goes inside the reply, in order, like system notes: a
    // message of its own would stay pinned below everything the agent adds.
    let message: ChatMessage;
    if (this.current) {
      message = this.current;
      this.addPart(message, { type: "card", card });
    } else {
      message = this.newMessage("system", [{ type: "card", card }]);
      this.touch(message);
    }
    this.cards.set(card.cardId, { card, message, onAction });
    return card;
  }

  private closeCard(cardId: string, state: "done" | "stale", outcome?: string, tone?: ChatCard["tone"]): void {
    const entry = this.cards.get(cardId);
    if (!entry) return;
    entry.card.state = state;
    entry.card.outcome = outcome;
    entry.card.actions = [];
    if (tone) entry.card.tone = tone;
    this.touchCard(entry);
    this.cards.delete(cardId);
  }

  /** Mark just the card's part of its message dirty (the card object is the part's card). */
  private touchCard(entry: { card: ChatCard; message: ChatMessage }): void {
    const i = entry.message.parts.findIndex((p) => p.type === "card" && p.card === entry.card);
    this.touch(entry.message, i >= 0 ? i : undefined);
  }

  cardAction(cardId: string, actionId: string): boolean {
    if (this.closed) return false;
    const entry = this.cards.get(cardId);
    if (!entry || entry.card.state !== "open" || !entry.card.actions.some((a) => a.id === actionId)) return false;
    if (actionId === "dismiss") {
      entry.card.dismissed = true;
      this.closeCard(cardId, "done", "Dismissed");
      return true;
    }
    entry.onAction(actionId);
    return true;
  }

  private failPrompts(): void {
    for (const p of [...this.prompts.values()]) p("cancelled");
  }

  // ------------------------------------------------------------ notebook

  private onMachineReplaced(): void {
    // Machine-local paths and terminal screens cannot be reused on the new VM.
    this.mirror = new NotebookMirror();
    this.shells = new ShellSessions();
    // Setup terminals are kept per tab, which only the host knows.
    this.host.machineReset?.();
    if (this.code) {
      // The old machine's clone must not be restored by a busy kernel on the new one.
      this.code.invalidate();
      this.lastCodeShown = "";
      this.setCodeState({ state: "missing", why: "The notebook's machine was replaced: the code is put there again on the next message, or now from the header." });
    }
    if (this.busyJob) this.cancelCellJob();
    // The agent is told on its next turn; the user sees it in the header (code state, machine).
    this.kernelNotes.push(`The notebook's machine was replaced at ${new Date().toTimeString().slice(0, 8)}: installed packages, files outside the project's code, files over 50 MB and variables in memory are gone.`);
    // The editor runs the kernel setup again when the user asked for that on every new machine.
    this.host.emit("chat.machineReplaced", { chatId: this.id, tabId: this.tabId });
  }

  private cancelCellJob(): void {
    const job = this.busyJob;
    if (!job) return;
    job.controller.abort();
    void this.call({ op: "interrupt" }).catch(() => {});
  }

  private async runCellsInOrder(ids: string[], onProgress: (done: number) => void, signal: AbortSignal): Promise<{ ran: number; failedAt?: { id: string; index: number }; cancelled: boolean }> {
    let ran = 0;
    for (const id of ids) {
      if (signal.aborted) return { ran, cancelled: true };
      const { results } = await this.call({ op: "run_cells", cellIds: [id], timeoutMs: 50_000, stopOnError: true }, 60_000);
      if (signal.aborted) return { ran, cancelled: true };
      let result = results[0];
      if (result?.status === "timeout") {
        let cell: CellInfo | undefined;
        // No overall deadline on purpose: a notebook may train for hours; the user ends it with Stop.
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          // Poll only the run state: outputs (images can be megabytes) are read once, when it finishes.
          cell = (await this.call({ op: "get_cells", cellIds: [id], summary: true })).cells[0];
          if (!cell?.running) break;
        }
        if (signal.aborted) return { ran, cancelled: true };
        if (!cell) result = { ...result, status: "error" };
        else {
          const done = (await this.call({ op: "get_cells", cellIds: [id], includeOutputs: true })).cells[0];
          if (!done) result = { ...result, status: "error" };
          else if (done.outputs?.some((output) => output.kind === "error")) result = { ...result, status: "error" };
          // A kernel restart mid-run leaves the cell never run: no execution count, no outputs. Not a pass.
          else if (!done.running && done.executionCount == null && !done.outputs?.length) result = { ...result, status: "error" };
          else result = { ...result, status: "ok" };
        }
      }
      if (!result || result.status !== "ok") {
        const cell = (await this.call({ op: "get_cells", cellIds: [id] }).catch(() => ({ cells: [] }))).cells[0];
        return { ran, failedAt: { id, index: cell?.index ?? -1 }, cancelled: false };
      }
      ran++;
      onProgress(ran);
    }
    return { ran, cancelled: false };
  }

  async refreshMachine(force = false): Promise<void> {
    if (this.closed) return;
    if (this.machineRead) return force ? this.machineRead.finally(() => this.refreshMachine(true)) : this.machineRead;
    const now = Date.now();
    if (!force && now - this.machineAt < MACHINE_MIN_MS) return;
    this.machineAt = now;
    this.machineRead = (async () => {
      try {
        const exec: KernelExec = (code, wait) => this.call({ op: "machine_exec", code, waitMs: wait }, wait + 15_000);
        const result = await stats(exec);
        if (this.closed) return;
        if (result.boot) {
          const previous = this.host.meta?.load()?.machine;
          const known = this.boot ?? previous?.boot;
          if (known && known !== result.boot) this.onMachineReplaced();
          this.host.machineSeen?.(result.boot);
          const changed = this.boot !== result.boot;
          this.boot = result.boot;
          const now = Date.now();
          if (changed || now - this.machineSavedAt >= MACHINE_SAVE_MS) {
            this.host.meta?.save({ machine: { boot: result.boot, seenAt: now } });
            this.machineSavedAt = now;
          }
        }
        this.machine = {
          at: Date.now(),
          memTotal: result.memTotal,
          memAvailable: result.memAvailable,
          diskTotal: result.diskTotal,
          diskFree: result.diskFree,
          gpus: result.gpus,
        };
        this.host.emit("chat.machine", { chatId: this.id, tabId: this.tabId, machine: this.machine });
        if (!this.machinePoll) {
          this.machinePoll = setInterval(() => {
            if (this.closed) return;
            // A detached notebook has no machine to read; the next tick after it attaches reads again.
            if (!this.notebook) return;
            const active = !!this.current || !!this.busyJob || Date.now() - this.lastActiveAt <= MACHINE_IDLE_MS;
            if (active) this.machineIdleTicks = 0;
            // Idle: read only every MACHINE_IDLE_EVERY-th tick (~150s) instead of every 30s.
            else if (++this.machineIdleTicks % MACHINE_IDLE_EVERY !== 0) return;
            // Active again reads at once; refreshMachine still throttles to MACHINE_MIN_MS.
            void this.refreshMachine();
          }, MACHINE_POLL_MS);
          this.machinePoll.unref?.();
        }
      } catch {
        // A busy, disconnected or non-Python kernel leaves the last good numbers in place.
      }
    })().finally(() => { this.machineRead = null; });
    return this.machineRead;
  }

  private call<N extends NotebookOpName>(op: NotebookOpOf<N>, timeoutMs = OP_TIMEOUT_MS): Promise<NotebookOpResults[N]> {
    return this.host.notebookOp(this.tabId, op, timeoutMs) as Promise<NotebookOpResults[N]>;
  }

  private addImage(message: ChatMessage, mime: string, data: string, alt: string): void {
    if (this.closed || !isChatImageMime(mime) || !chatImageDataUrl(mime, data)) return;
    if (message.parts.some((part) => part.type === "image" && part.mime === mime && part.data === data)) return;
    if (this.imageBytes + data.length > CHAT_IMAGES_MAX) {
      const text = "Image omitted because this chat reached its image size limit.";
      if (!message.parts.some((part) => part.type === "notice" && part.text === text)) this.addPart(message, { type: "notice", level: "info", text });
      return;
    }
    this.imageBytes += data.length;
    this.addPart(message, { type: "image", mime, data, alt });
  }

  toolContext(): ToolContext {
    const message = this.current;
    const deadline = Date.now() + this.spec.toolWaitMs;
    return {
      settings: () => this.settings,
      targets: () => (this.settings.targetCellIds.length ? this.settings.targetCellIds : this.turnTargets),
      call: (op, timeoutMs) => this.call(op, timeoutMs),
      awaitReview: (id, ms) => this.awaitReview(id, ms),
      confirmRun: async (summary, detail) => {
        const answer = await this.ask(
          summary,
          detail ?? "Review is on, so running code waits for your approval.",
          [
            { id: "run", name: "Run", kind: "allow_once" },
            { id: "skip", name: "Don't run", kind: "reject_once" },
          ],
          undefined,
          Math.max(0, deadline - Date.now()),
        );
        if (answer === "expired") throw new Error("Run approval expired. Nothing was run. Ask the user before requesting it again.");
        return answer === "run";
      },
      get waitMs() {
        return Math.max(0, deadline - Date.now());
      },
      images: this.acceptsImages(),
      showOutputImage: (image: OutputImage) => {
        if (message === this.current && message) this.addImage(message, image.mime, image.data, "Notebook output image");
      },
      exclusive: (lock, fn) => this.exclusive(lock, fn),
      runs: this.runs,
      shells: this.shells,
      mirror: this.mirror,
    };
  }

  private exclusive<T>(lock: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(lock) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(
      lock,
      run.catch(() => {}),
    );
    return run;
  }

  /** Whether plot images go to this agent: its spec decides, else what it declared over ACP. */
  acceptsImages(): boolean {
    return this.spec.images ?? !!this.agent?.init?.agentCapabilities?.promptCapabilities?.image;
  }

  runTool(name: string, args: unknown): Promise<ToolResult> {
    this.markNotebookCall(name, args, "notebook");
    if (this.role) return this.role.runTool(this.toolContext(), name, args);
    // The GitHub token is on the machine (for git): what the agent reads never shows it.
    return callTool(this.toolContext(), name, args).then(hideTokens);
  }

  /**
   * Agents name tool calls their own way (mcp__notebook__x, mcp.notebook.x, or a
   * generic "execute" running code that calls the tool), so the bridge tags the
   * agent's in-flight call when one of our tools is actually reached.
   */
  private markNotebookCall(name: string, args: unknown, server: "notebook" | "project"): void {
    const msg = this.current;
    if (!msg) return;
    const inFlight = msg.parts.filter(
      (p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && (p.status === "pending" || p.status === "in_progress"),
    );
    // Best: the call whose input names this tool or carries these exact arguments
    // (OpenCode's code mode makes several notebook calls from one "execute").
    const argsJson = JSON.stringify(args ?? {});
    const byInput = inFlight.filter((p) => {
      const raw = this.rawInputs.get(p.toolCallId) ?? "";
      return raw.includes(`${server}.${name}`) || raw.includes(`${server}__${name}`) || (raw === argsJson && argsJson !== "{}");
    });
    // Otherwise a call not yet tied to any notebook tool. The agent announces
    // over ACP and calls over MCP, two pipes, so the call can arrive first: then
    // it waits for the next tool_call.
    const target = byInput.at(-1) ?? inFlight.filter((p) => !p.notebookCalls).at(-1) ?? null;
    if (!target) {
      this.orphanCalls.push({ name, at: Date.now() });
      return;
    }
    target.notebook = true;
    target.notebookCalls = [...(target.notebookCalls ?? []), name];
    this.touch(msg, msg.parts.indexOf(target));
  }

  /** Each tool call's input as JSON, for matching notebook calls to it. */
  private rawInputs = new Map<string, string>();

  private noteInput(id: string, rawInput: unknown): void {
    if (rawInput === undefined || rawInput === null) return;
    this.rawInputs.set(id, JSON.stringify(rawInput));
  }

  /** Notebook calls that reached the bridge before the agent announced them. */
  private orphanCalls: { name: string; at: number }[] = [];

  private claimOrphans(part: Extract<Part, { type: "tool" }>): void {
    const fresh = this.orphanCalls.filter((o) => Date.now() - o.at < 5_000);
    this.orphanCalls = [];
    if (!fresh.length) return;
    part.notebook = true;
    part.notebookCalls = [...(part.notebookCalls ?? []), ...fresh.map((o) => o.name)];
  }

  onNotebookEvent(event: NotebookEvent): void {
    switch (event.type) {
      case "review_opened": {
        this.reviewState(event.review.reviewId);
        const msg = this.current ?? this.lastAgentMessage();
        msg.parts.push({ type: "review", review: event.review, status: "pending" });
        this.touch(msg, msg.parts.length - 1);
        return;
      }
      case "review_closed":
        this.closeReview(event.reviewId, event.accepted ? "accepted" : "rejected");
        return;
      case "change_applied": {
        // A reviewed change belongs to the turn that proposed it, even if accepted later.
        const msg = (event.change.reviewId && this.messageWithReview(event.change.reviewId)) || this.current || this.lastAgentMessage();
        const changes = this.journal.get(msg.id) ?? [];
        changes.push(event.change);
        this.journal.set(msg.id, changes);
        msg.changes = { count: changes.length };
        this.touchMeta(msg);
        return;
      }
      case "selection_changed":
        if (this.notebook) {
          this.notebook = { ...this.notebook, activeCellId: event.activeCellId, selectedCellIds: event.selectedCellIds };
        }
        return;
      case "cell_run":
        this.onCellRun(event.run);
        return;
      case "kernel_changed": {
        const before = this.lastKernel;
        this.lastKernel = event.kernel;
        if (this.notebook) this.notebook = { ...this.notebook, kernel: event.kernel };
        if ((before === "disconnected" || before === "unknown") && event.kernel === "idle") {
          this.kernelNotes.push(`The kernel restarted or reconnected at ${new Date().toTimeString().slice(0, 8)}: variables from earlier runs may be gone.`);
          void this.refreshMachine(true);
        }
        return;
      }
    }
  }

  private onCellRun(run: CellRun): void {
    if (this.closed) return;
    this.lastActiveAt = Date.now();
    if (run.by === "user") {
      this.activity.push(run);
      if (this.activity.length > 20) this.activity.shift();
      this.lastUserRunAt = Date.now();
      this.dirtySinceSync = true;
      this.scheduleAutosave();
    }
    // Any later run of the cell replaces what an open card says about it.
    this.supersedeRunCards(run.cellId);
    // No machine read here: it runs on the kernel for a second or more, so the
    // agent's next tool call or the user's next cell would find the kernel busy.
    // Prompts and kernel reconnects read it instead.
    // During a turn the agent sees its own runs through its tools.
    if (this.current) return;
    const long = (run.durationMs ?? 0) >= LONG_RUN_MS;
    let card: ChatCard | null;
    if (run.status === "error") card = this.addRunCard(run);
    else if (run.status === "ok" && long && !this.busyJob) card = this.role?.longRun ? this.addRoleRunCard(run) : this.addFinishedCard(run);
    else return;
    if (!card) return;
    if (long) this.host.emit("chat.run", { chatId: this.id, tabId: this.tabId, cardId: card.cardId, run, title: this.notebook?.title ?? "" });
  }

  private supersedeRunCards(cellId: string): void {
    for (const [id, { card }] of [...this.cards]) {
      if (card.kind === "run" && card.cellId === cellId && card.state === "open") this.closeCard(id, "stale", "Superseded by a later run");
    }
  }

  private addRunCard(run: CellRun): ChatCard {
    const title = `Cell [${run.index}] failed · ${run.ename ?? "Error"}${run.evalue ? `: ${firstLine(run.evalue, 100)}` : ""}`;
    const detail = [run.head, run.durationMs === undefined ? "" : runDuration(run.durationMs)].filter(Boolean).join(" · ");
    let cardId = "";
    const card = this.addCard({
      kind: "run",
      tone: "error",
      title,
      detail,
      cellId: run.cellId,
      // A role may not want the agent fixing the code: it then only explains.
      actions: this.role?.failedRun
        ? [{ id: "explain", label: this.role.failedRun.explain, primary: true }, { id: "dismiss", label: this.role.failedRun.dismiss }]
        : [
            { id: "fix", label: "Fix", primary: true },
            { id: "explain", label: "Explain" },
            { id: "dismiss", label: "Dismiss" },
          ],
    }, (id) => void this.runCardAction(cardId, run, id as "fix" | "explain"));
    cardId = card.cardId;
    this.limitRunCards();
    return card;
  }

  private addFinishedCard(run: CellRun): ChatCard {
    let cardId = "";
    const card = this.addCard({
      kind: "run",
      tone: "ok",
      title: `Cell [${run.index}] finished · ${runDuration(run.durationMs ?? 0)}`,
      detail: run.head,
      cellId: run.cellId,
      actions: [{ id: "summarize", label: "Summarize result", primary: true }, { id: "dismiss", label: "Dismiss" }],
    }, () => void this.runCardAction(cardId, run, "summarize"));
    cardId = card.cardId;
    this.limitRunCards();
    return card;
  }

  /** A long cell finished in a chat with a role: the role's card for it, if it has one. */
  private addRoleRunCard(run: CellRun): ChatCard | null {
    const spec = this.role?.longRun?.(run);
    if (!spec) return null;
    let cardId = "";
    const card = this.addCard({ kind: "run", tone: "ok", title: spec.title, detail: spec.detail, cellId: run.cellId, actions: spec.actions }, () => {
      this.closeCard(cardId, "done", spec.done);
      spec.act();
    });
    cardId = card.cardId;
    this.limitRunCards();
    return card;
  }

  private limitRunCards(): void {
    const open = [...this.cards.values()].filter(({ card }) => card.kind === "run" && card.state === "open");
    if (open.length > RUN_CARDS_OPEN) this.closeCard(open[0]!.card.cardId, "stale", "Superseded");
  }

  private async runCardAction(cardId: string, run: CellRun, action: "fix" | "explain" | "summarize"): Promise<void> {
    const outcome = action === "fix" ? "Asked the agent to fix it" : action === "explain" ? "Asked the agent to explain it" : "Asked the agent to summarize it";
    this.closeCard(cardId, "done", outcome);
    let rendered: string | null = null;
    try {
      const { cells } = await this.call({ op: "get_cells", cellIds: [run.cellId], includeOutputs: true });
      if (cells[0]) rendered = renderCell(cells[0], true);
    } catch {
      // The saved run still gives the agent enough context if the cell is gone.
    }
    if (this.closed) return;
    const context = cellRunBlock(action, run, rendered);
    const text = this.role?.failedRun
      ? this.role.failedRun.ask(run)
      : action === "fix" ? `Fix the error in cell [${run.index}]` : action === "explain" ? `Explain the error in cell [${run.index}]` : `Summarize the result of cell [${run.index}]`;
    this.send(text, { context, targets: [run.cellId] });
  }

  /**
   * The page went away (reload, navigation): reviews it was showing are gone
   * with it and can never be decided, so tell whoever waits on them.
   */
  onNotebookDetached(): void {
    this.notebook = null;
    for (const [id, state] of this.reviews) if (state.outcome === "pending") this.closeReview(id, "discarded");
  }

  private closeReview(reviewId: string, outcome: Exclude<ReviewOutcome, "pending">): void {
    const state = this.reviewState(reviewId);
    if (state.outcome !== "pending") return;
    state.outcome = outcome;
    state.waiters.forEach((w) => w(outcome));
    state.waiters.clear();
    for (const m of this.messages) {
      m.parts.forEach((p, i) => {
        if (p.type === "review" && p.review.reviewId === reviewId && p.status === "pending") {
          p.status = outcome;
          this.touch(m, i);
        }
      });
    }
    this.pruneReviews();
  }

  private pruneReviews(): void {
    if (this.reviews.size <= REVIEWS_KEPT) return;
    for (const [id, state] of this.reviews) {
      if (this.reviews.size <= REVIEWS_KEPT) break;
      if (state.outcome !== "pending") this.reviews.delete(id);
    }
  }

  private messageWithReview(reviewId: string): ChatMessage | undefined {
    return this.messages.find((m) => m.parts.some((p) => p.type === "review" && p.review.reviewId === reviewId));
  }

  /** The undo journal, for saving with the transcript. */
  journalEntries(): Record<string, AppliedChange[]> {
    return Object.fromEntries(this.journal);
  }

  /**
   * Revert the changes of one agent turn, newest first. A cell the user (or a
   * later turn) changed since is left alone, so undo never overwrites newer work.
   */
  async undo(messageId: string): Promise<UndoResult> {
    if (this.current) throw new Error("Wait for the agent's turn to finish (or stop it) before undoing.");
    const msg = this.messages.find((m) => m.id === messageId);
    const changes = this.journal.get(messageId);
    if (!msg || !changes?.length) throw new Error("There are no notebook changes to undo for this message.");
    if (msg.changes?.undone) throw new Error("These changes were already undone.");
    if (msg.parts.some((p) => p.type === "review" && p.status === "pending")) throw new Error("Accept or reject the changes still awaiting review first.");
    if (this.undoing) throw new Error("An undo is already in progress.");
    this.undoing = true;
    try {
      return await this.undoChanges(msg, changes);
    } finally {
      this.undoing = false;
    }
  }

  private undoing = false;

  private async undoChanges(msg: ChatMessage, changes: AppliedChange[]): Promise<UndoResult> {
    // A deleted cell comes back with a new id; earlier changes to it follow the new one.
    const ids = new Map<string, string>();
    let undone = 0;
    const skipped: string[] = [];
    // Read the notebook once, then keep this local copy in step after each op that
    // succeeds; only a failed op sends us back to the notebook. The first read is
    // what catches cells the user edited since the turn (kept and listed below).
    let cells: CellInfo[] = (await this.call({ op: "get_cells" }).catch(() => ({ cells: [] as CellInfo[] }))).cells;
    for (const c of [...changes].reverse()) {
      const id = ids.get(c.cellId) ?? c.cellId;
      const what = c.kind === "insert" ? `new cell ${id.slice(0, 10)}` : c.kind === "delete" ? `deleted cell ${id.slice(0, 10)}` : `${c.kind === "move" ? "move of" : "change to"} cell ${id.slice(0, 10)}`;
      try {
        const cell = cells.find((x) => x.id === id);
        if (c.kind !== "delete" && !cell) {
          skipped.push(`${what}: the cell no longer exists`);
          continue;
        }
        if ((c.kind === "update" || c.kind === "insert") && cell!.source !== c.after) {
          skipped.push(`${what}: edited since, so it was kept`);
          continue;
        }
        if (c.kind === "update") {
          await this.call({ op: "update_cell", cellId: id, source: c.before, review: false, byUser: true });
          cell!.source = c.before;
        } else if (c.kind === "insert") {
          await this.call({ op: "delete_cell", cellId: id, review: false, byUser: true });
          cells = cells.filter((x) => x.id !== id);
        } else if (c.kind === "move") {
          await this.call({ op: "move_cell", cellId: id, index: c.index, byUser: true });
          const from = cells.findIndex((x) => x.id === id);
          if (from >= 0) {
            const [moved] = cells.splice(from, 1);
            cells.splice(Math.min(c.index, cells.length), 0, moved!);
          }
        } else {
          const index = Math.min(c.index, cells.length);
          const res = await this.call({ op: "insert_cell", index, cellType: c.cellType, source: c.before, review: false, byUser: true });
          if (res.cellId) {
            ids.set(c.cellId, res.cellId);
            cells.splice(index, 0, { id: res.cellId, index, type: c.cellType, source: c.before, executionCount: null });
          }
        }
        undone++;
      } catch (e) {
        skipped.push(`${what}: ${(e as Error).message}`);
        // After a failure the local copy may be out of step: read the notebook again.
        cells = (await this.call({ op: "get_cells" }).catch(() => ({ cells }))).cells;
      }
    }
    msg.changes = { count: changes.length, undone: true };
    const plural = (n: number) => `${n} change${n === 1 ? "" : "s"}`;
    this.addPart(msg, {
      type: "notice",
      level: skipped.length ? "error" : "info",
      text: `Undid ${plural(undone)}.${skipped.length ? ` Left ${skipped.length} alone:\n${skipped.map((x) => `- ${x}`).join("\n")}` : ""}`,
    });
    this.undoNotes.push(
      `The user undid ${undone} of the ${plural(changes.length)} you made to the notebook in an earlier turn${skipped.length ? `; ${skipped.length} were kept because the cells changed since` : ""}. ` +
        "Those cells are back as they were before your changes. Read the notebook again before building on that work.",
    );
    this.flush();
    return { undone, skipped };
  }

  async resolveReview(reviewId: string, accept: boolean): Promise<boolean> {
    const res = await this.call({ op: "resolve_review", reviewId, accept });
    return res.resolved;
  }

  private reviewState(id: string): ReviewState {
    let s = this.reviews.get(id);
    if (!s) this.reviews.set(id, (s = { outcome: "pending", waiters: new Set() }));
    return s;
  }

  private awaitReview(reviewId: string, waitMs: number): Promise<ReviewOutcome> {
    const state = this.reviewState(reviewId);
    if (state.outcome !== "pending") return Promise.resolve(state.outcome);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.waiters.delete(done);
        resolve("pending");
      }, waitMs);
      const done = (o: ReviewOutcome) => {
        clearTimeout(timer);
        resolve(o);
      };
      state.waiters.add(done);
    });
  }

  pendingReviews(): ReviewInfo[] {
    const out: ReviewInfo[] = [];
    for (const m of this.messages) for (const p of m.parts) if (p.type === "review" && p.status === "pending") out.push(p.review);
    return out;
  }

  // ------------------------------------------------------------ transcript

  private newMessage(role: ChatMessage["role"], parts: Part[]): ChatMessage {
    const m: ChatMessage = { id: randomUUID(), role, parts, createdAt: Date.now() };
    this.messages.push(m);
    return m;
  }

  /**
   * A note from the bridge. During a turn it goes inside the turn's reply, in
   * order: a separate message would sit after the reply (created when the turn
   * began) and stay pinned below everything the agent adds to it.
   */
  /** A line from the bridge for the person reading this chat (something happened outside a turn). */
  notice(text: string): void {
    if (!this.closed) this.system(text);
  }

  private system(text: string): void {
    const part: Part = { type: "notice", level: "info", text };
    if (this.current) this.addPart(this.current, part);
    else this.touch(this.newMessage("system", [part]));
  }

  private lastAgentMessage(): ChatMessage {
    const last = this.messages.at(-1);
    if (last && last.role === "agent") return last;
    return this.newMessage("agent", []);
  }

  private addPart(msg: ChatMessage, part: Part): void {
    msg.parts.push(part);
    this.touch(msg, msg.parts.length - 1);
  }

  /** Tools still marked running when a turn ends never finished. */
  private closeOpenTools(msg: ChatMessage): void {
    msg.parts.forEach((p, i) => {
      if (p.type === "tool" && (p.status === "pending" || p.status === "in_progress")) {
        p.status = "failed";
        this.touch(msg, i);
      }
    });
  }

  private partSet(msg: ChatMessage): Set<number> {
    let set = this.dirtyParts.get(msg.id);
    if (!set) this.dirtyParts.set(msg.id, (set = new Set()));
    return set;
  }

  /**
   * Mark a message for the next flush. With a part index, only that part is
   * re-serialized; without one, every part is marked (conservative: an unknown
   * mutation may have touched any of them). Text/thought always travel as appends
   * and images by reference, so the marking only saves work on tool/review/card parts.
   */
  private touch(msg: ChatMessage, index?: number): void {
    this.dirty.add(msg);
    const set = this.partSet(msg);
    if (index === undefined) for (let i = 0; i < msg.parts.length; i++) set.add(i);
    else set.add(index);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Only message-level fields moved (changes, the queued mark): no part needs re-serializing. */
  private touchMeta(msg: ChatMessage): void {
    this.dirty.add(msg);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirty.size) return;
    for (const m of this.dirty) {
      const patch = this.patchFor(m);
      this.dirtyParts.delete(m.id);
      if (patch) this.host.emit("chat.patch", patch);
    }
    this.dirty.clear();
    this.schedulePersist();
  }

  /** What changed in `m` since it was last sent: appended text, or whole parts. */
  private patchFor(m: ChatMessage): MessagePatch | null {
    const before = this.sent.get(m.id);
    const dirty = this.dirtyParts.get(m.id);
    const now: SentPart[] = [];
    const ops: PartOp[] = [];
    m.parts.forEach((part, i) => {
      const old = before?.[i];
      if (part.type === "text" || part.type === "thought") {
        now.push({ type: part.type, text: part.text });
        if (old?.type === part.type && old.text === part.text) return;
        if (old?.type === part.type && old.text !== undefined && part.text.startsWith(old.text)) {
          ops.push({ i, at: old.text.length, append: part.text.slice(old.text.length) });
        } else ops.push({ i, part });
        return;
      }
      if (part.type === "image") {
        now.push({ type: part.type, image: part });
        if (old?.image !== part) ops.push({ i, part });
        return;
      }
      // A clean part already sent keeps its cached JSON: a long turn no longer
      // re-serializes every tool/review/card part on each 80ms flush, only the dirty ones.
      if (old?.type === part.type && old.json !== undefined && !dirty?.has(i)) {
        now.push(old);
        return;
      }
      const json = JSON.stringify(part);
      now.push({ type: part.type, json });
      if (old?.json !== json) ops.push({ i, part });
    });
    const changes = JSON.stringify(m.changes ?? null);
    const known = this.sentChanges.get(m.id);
    const queued = !!m.queued;
    const knownQueued = this.sentQueued.get(m.id) ?? false;
    const pinned = !!m.pinned;
    const knownPinned = this.sentPinned.get(m.id) ?? false;
    if (before && !ops.length && before.length === m.parts.length && known === changes && knownQueued === queued && knownPinned === pinned) return null;
    this.sent.set(m.id, now);
    this.sentChanges.set(m.id, changes);
    this.sentQueued.set(m.id, queued);
    this.sentPinned.set(m.id, pinned);
    return {
      chatId: this.id,
      tabId: this.tabId,
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      changes: m.changes,
      ...(queued !== knownQueued ? { queued } : {}),
      ...(pinned !== knownPinned ? { pinned } : {}),
      length: m.parts.length,
      ops,
    };
  }

  private sentChanges = new Map<string, string>();
  private sentPinned = new Map<string, boolean>();

  /**
   * True quiet debounce: every change pushes the save PERSIST_MS out, but never
   * past the ceiling set when this cycle's first change arrived, so a turn that
   * streams without a pause still saves at least every PERSIST_MAX_MS and a crash
   * mid-turn does not lose it all. Closing the chat still saves synchronously.
   * (store.serialize is still synchronous; moving it to worker_threads is a later
   * stretch, not this batch.)
   */
  private schedulePersist(): void {
    if (!this.host.persist || this.forgotten) return;
    const now = Date.now();
    if (!this.persistTimer) this.persistDueAt = now + PERSIST_MAX_MS;
    const delay = Math.min(PERSIST_MS, Math.max(0, this.persistDueAt - now));
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(false), delay);
    this.persistTimer.unref?.();
  }

  /** Save now: synchronously on close, in the background when the debounce fires. */
  persistNow(sync = true): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.forgotten) return;
    this.host.persist?.(this, sync);
  }

  private setStatus(status: ChatStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.flush();
    this.host.emit("chat.status", { chatId: this.id, tabId: this.tabId, status, error });
  }
}

/** A part as last sent: text parts by their text (they grow by appending), others as JSON. */
interface SentPart {
  type: Part["type"];
  text?: string;
  json?: string;
  image?: Extract<Part, { type: "image" }>;
}

/**
 * The project the tools work in: OpenResearch's record when it answered, else
 * what the notebook kept of that same project (not of one it was in before);
 * null when the project is gone or was never seen.
 */
function usableProject(orx: ProjectResolution["orx"], project: ChatProject | undefined, cached: ProjectCache | null): ProjectCache | null {
  if (orx) return projectCache(orx);
  if (!project || project.state === "missing") return null;
  return cached && cached.id === project.id ? cached : null;
}

function findTool(msg: ChatMessage, id: string) {
  return msg.parts.find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.toolCallId === id);
}

/** Our MCP servers are registered as "notebook" and "project"; agents spell the tool name differently. */
export function isNotebookTool(title: string | undefined, meta: unknown): boolean {
  const t = title ?? "";
  if (/mcp__(notebook|project)__|notebook[_./:]|\bnotebook\b.*\(|\bproject[./:]|^(read_output|run_cells|run_all|shell_wait|shell_input|shell_interrupt|run_code|wait_for_code|wait_for_cells|interrupt_kernel|notebook_info|kernel_state|await_review|artifact_\w+|mentor_\w+|paper_\w+|reader_\w+|save_notebook)\b/i.test(t)) return true;
  const toolName = (meta as any)?.claudeCode?.toolName ?? (meta as any)?.toolName;
  return typeof toolName === "string" && (toolName.includes("notebook") || toolName.startsWith("mcp__project__"));
}

function stringifyDetail(value: unknown): string {
  if (typeof value === "string") {
    return capText(value.replace(/[A-Za-z0-9+/]{400,}={0,2}/g, "[image data]"), TOOL_DETAIL_MAX);
  }
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === "string" && v.length >= 400 ? v.replace(/[A-Za-z0-9+/]{400,}={0,2}/g, "[image data]") : v),
    2,
  );
  return text ? capText(text, TOOL_DETAIL_MAX) : "";
}

function toolDetail(rawInput?: unknown, content?: ToolCallContent[] | null, rawOutput?: unknown): string | undefined {
  const parts: string[] = [];
  if (rawInput !== undefined && rawInput !== null && !(typeof rawInput === "object" && Object.keys(rawInput as object).length === 0)) {
    parts.push(stringifyDetail(rawInput));
  }
  for (const c of content ?? []) {
    if (c.type === "content" && c.content.type === "text") parts.push(stringifyDetail(c.content.text));
    else if (c.type === "diff") parts.push(`diff ${c.path}`);
    else if (c.type === "terminal") parts.push(`terminal ${c.terminalId}`);
  }
  if (!content?.length && rawOutput !== undefined && rawOutput !== null) {
    parts.push(stringifyDetail(rawOutput));
  }
  if (!parts.length) return undefined;
  return capText(parts.join("\n\n"), TOOL_DETAIL_MAX);
}

/** A tool's result with the GitHub token hidden (it is on the notebook's machine for git). */
function hideTokens(r: ToolResult): ToolResult {
  const text = redactTokens(r.text);
  return text === r.text ? r : { ...r, text };
}
