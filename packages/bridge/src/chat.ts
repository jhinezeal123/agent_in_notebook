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
  type MentorResult,
  type MentorVerdict,
  type Part,
  type PartOp,
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
import { keyHash } from "./store.js";
import { judgeCode, newNonce, parseVerdict } from "./mentor/judge.js";
import { isSolutionCell } from "./mentor/notebook.js";
import { codeReviewBlock, hintBlock, hintText, learnerCells, mentorPlaybook, mentorState, verdictBlock } from "./mentor/prompt.js";
import { StageRefused, type MentorSession } from "./mentor/session.js";
import { MENTOR_CHAT_TOOLS } from "./mentor/tools.js";
import type { WorkshopSession } from "./mentor/workshop.js";

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
  /** The Mentor exercise the notebook is: the agent coaches instead of editing. */
  mentor?: MentorSession;
  /** A paper's workshop: the agent plans the paper's reproduction (or, hidden, writes its exercises). */
  workshop?: WorkshopSession;
}

/** A Mentor chat's fixed mode: the agent may run scratch code; it has no tool that edits the notebook. */
const MENTOR_SETTINGS: ChatSettings = { scope: "auto", review: false, targetCellIds: [], notebookOnly: true };
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
  private queue: TurnInput[] = [];
  private turnTargets: string[] = [];
  private reviews = new Map<string, ReviewState>();
  private prompts = new Map<string, (optionId: string) => void>();
  private cards = new Map<string, { card: ChatCard; message: ChatMessage; onAction(actionId: string): void }>();
  private dirty = new Set<ChatMessage>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** The Mentor exercise this chat coaches, if it is one. */
  readonly mentor: MentorSession | undefined;
  /** The learner's cells as the agent last saw them. */
  private lastLearnerCells = "";
  private unsubscribeMentor: (() => void) | undefined;
  /** The paper workshop this chat plans in (or writes exercises for), if it is one. */
  readonly workshop: WorkshopSession | undefined;

  constructor(
    readonly tabId: number,
    readonly spec: AgentSpec,
    public settings: ChatSettings,
    private readonly host: ChatHost,
    opts: ChatOptions = {},
  ) {
    this.notebookKey = opts.notebookKey;
    this.project = opts.project;
    this.mentor = opts.mentor;
    if (this.mentor) {
      this.settings = MENTOR_SETTINGS;
      const attemptId = this.mentor.attemptId;
      this.unsubscribeMentor = this.mentor.mentor.subscribe((id) => {
        if (id === attemptId && !this.closed) this.host.emit("chat.mentor", { chatId: this.id, tabId: this.tabId, mentor: this.mentor!.view() });
      });
    }
    this.workshop = opts.workshop;
    if (this.workshop) {
      this.settings = MENTOR_SETTINGS;
      const ws = this.workshop;
      this.unsubscribeMentor = ws.hub.subscribe((paperId) => {
        if (paperId === ws.paperId && !this.closed && ws.role === "plan") this.host.emit("chat.workshop", { chatId: this.id, tabId: this.tabId, workshop: ws.view() });
      });
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
      ...(this.mentor ? { mentor: this.mentor.view() } : {}),
      ...(this.workshop?.role === "plan" ? { workshop: this.workshopView() } : {}),
    };
  }

  private workshopView(): NonNullable<ChatSnapshot["workshop"]> | undefined {
    try {
      return this.workshop!.view();
    } catch {
      return undefined;
    }
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
    this.unsubscribeMentor?.();
    this.setStatus("closed");
    this.persistNow();
  }

  // ------------------------------------------------------------ turns

  send(text: string, extra: Omit<TurnInput, "text"> = {}): void {
    if (this.closed) return;
    const parts: Part[] = [{ type: "text", text }];
    if (extra.cells?.length) parts.push({ type: "cells", cells: extra.cells });
    const msg = this.newMessage("user", parts);
    this.touch(msg);
    // Attached cells are what the `cell` scope may edit, unless the user pinned others.
    const input: TurnInput = { text, ...(extra.cells?.length ? { targets: extra.cells.map((c) => c.cellId) } : {}), ...extra };
    if (this.status === "running" || this.current || this.busyJob) {
      this.queue.push(input);
      return;
    }
    void this.runTurn(input);
  }

  private async runTurn(input: TurnInput): Promise<void> {
    const reply = this.newMessage("agent", []);
    this.current = reply;
    const turn: NonNullable<Chat["turn"]> = { controller: new AbortController(), prompting: false, project: null, code: null };
    this.turn = turn;
    this.setStatus("running");
    try {
      await this.ensureStarted();
      turn.controller.signal.throwIfAborted();
      const prompt = await this.buildPrompt(input);
      turn.controller.signal.throwIfAborted();
      turn.prompting = true;
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
      const next = this.queue.shift();
      if (next !== undefined && !this.closed) void this.runTurn(next);
    }
  }

  private async withBusyJob<T>(fn: (controller: AbortController) => Promise<T>): Promise<T> {
    if (this.current || this.busyJob) throw new Error("Wait for the agent's turn or the current notebook job to finish first.");
    const controller = new AbortController();
    this.busyJob = { controller };
    try {
      return await fn(controller);
    } finally {
      this.busyJob = null;
      const next = this.queue.shift();
      if (next !== undefined && !this.closed) void this.runTurn(next);
    }
  }

  private async buildPrompt(input: TurnInput): Promise<string> {
    if (this.mentor) return this.buildMentorPrompt(input, this.mentor);
    if (this.workshop) {
      const rules = this.sessionFresh || this.rulesDue;
      this.rulesDue = false;
      const blocks = [rules ? this.workshop.playbook() : "", this.pendingRecap, this.workshop.state(), input.context ?? "", input.text];
      return blocks.filter(Boolean).join("\n\n");
    }
    let machineTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.refreshMachine(),
      new Promise<void>((resolve) => { machineTimer = setTimeout(resolve, 1500); }),
    ]).finally(() => { if (machineTimer) clearTimeout(machineTimer); });
    const rules = this.sessionFresh || this.rulesDue;
    const project = await this.projectBlock(rules || !!this.pendingRecap);
    let cells: CellInfo[] | null = null;
    let file: string | null = null;
    try {
      this.notebook = (await this.call({ op: "info" })) as NotebookInfo;
      cells = (await this.call({ op: "get_cells", summary: true })).cells;
    } catch {
      this.notebook = null;
    }
    if (this.notebook) file = await notebookPath(this.toolContext(), this.notebook).catch(() => null);
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
    const code = await this.codeBlock(rules || !!this.pendingRecap);
    if (code) blocks.push(code);
    const lit = this.host.project ? litReview(input.text) : null;
    if (lit) blocks.push(lit);
    const activity = this.activityBlock();
    if (activity) blocks.push(activity);
    if (input.context) blocks.push(input.context);
    if (input.cells?.length) blocks.push(await this.attachedBlock(input.cells));
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

  /** A Mentor chat's prompt: its own rules, the exercise's state, and the learner's cells when they changed. */
  private async buildMentorPrompt(input: TurnInput, s: MentorSession): Promise<string> {
    const rules = this.sessionFresh || this.rulesDue;
    let cells: CellInfo[] | null = null;
    try {
      this.notebook = (await this.call({ op: "info" })) as NotebookInfo;
      cells = (await this.call({ op: "get_cells" })).cells;
    } catch {
      this.notebook = null;
    }
    const blocks: string[] = [];
    if (rules) blocks.push(mentorPlaybook(s.exercise, s.attempt.kind, s.view().variantOf));
    this.rulesDue = false;
    const full = rules || !!this.pendingRecap;
    if (this.pendingRecap) blocks.push(this.pendingRecap);
    const activity = this.activityBlock();
    if (activity) blocks.push(activity);
    if (input.context) blocks.push(input.context);
    if (input.cells?.length) blocks.push(await this.attachedBlock(input.cells));
    const seen = cells ? learnerCells(cells) : null;
    const shown = seen === null
      ? "The notebook could not be read this turn."
      : full || seen !== this.lastLearnerCells ? seen : "The learner's sketch and solution cells are unchanged since your last turn.";
    if (seen !== null) this.lastLearnerCells = seen;
    blocks.push(mentorState(s, shown, full ? s.mentor.learnerSummary(s.attemptId) : ""));
    blocks.push(input.text);
    return blocks.join("\n\n");
  }

  // ------------------------------------------------------------ mentor

  /** "Chấm bài": run the exercise's hidden tests on the learner's cells, show the verdict, and let the mentor react. */
  async judge(): Promise<void> {
    const s = this.requireMentor();
    if (this.current || this.busyJob) throw new Error("Đợi mentor trả lời xong (hoặc bấm dừng) rồi hãy chấm bài.");
    const card = this.addCard({ kind: "mentor", tone: "info", title: "Đang chấm bài…", actions: [] }, () => {});
    let verdict: MentorVerdict;
    let judged = "";
    try {
      verdict = await this.withBusyJob(async () => {
        const { cells } = await this.call({ op: "get_cells" });
        const source = cells.filter((c) => isSolutionCell(c)).map((c) => c.source).join("\n\n");
        if (!source.trim()) {
          return { at: Date.now(), ok: false, passed: 0, total: 0, tests: [], error: "Không thấy cell bài làm (cell bắt đầu bằng dòng `#| mentor: solution`)." };
        }
        judged = source;
        const nonce = newNonce();
        const waitMs = s.exercise.judgeSeconds * 1000;
        const code = judgeCode(s.exercise, source, nonce, s.mentor.judgeContext(s.exercise));
        const res = await this.exclusive("run", () => this.call({ op: "execute", code, waitMs }, waitMs + 30_000));
        if (res.status === "running") await this.call({ op: "interrupt" }).catch(() => {});
        return parseVerdict(res, nonce);
      });
    } catch (e) {
      card.title = "Chưa chấm được";
      this.closeCard(card.cardId, "done", kernelProblem((e as Error).message), "error");
      return;
    }
    if (this.closed) return;
    // A passing solution is what later exercises build on.
    if (verdict.ok && judged) s.mentor.store.saveSolution(s.exercise.id, judged);
    const result = s.judged(verdict);
    card.title = verdict.missing ? "Thiếu thư viện" : verdict.error ? "Bài làm chưa chạy được" : `Đạt ${verdict.passed}/${verdict.total} test`;
    card.tone = verdict.ok ? "ok" : "error";
    card.mentor = { type: "verdict", verdict };
    this.closeCard(card.cardId, "done");
    if (result) this.showResult(result);
    this.send("Chấm bài", { context: verdictBlock(verdict, s.stage, s.exercise) });
  }

  /** "Xin gợi ý": one hint level up, and the mentor gives a hint at it. */
  hint(): number {
    const s = this.requireMentor();
    if (s.stage === "done") throw new Error("Bài đã xong.");
    const level = s.raiseHint();
    this.send(hintText(level), { context: hintBlock(s.exercise, level) });
    return level;
  }

  /** "Nhận xét code": once the exercise is done, the mentor reviews the solution (no effect on the rating). */
  codeReview(): void {
    const s = this.requireMentor();
    if (s.stage !== "done") throw new Error("Nhận xét code mở ra sau khi xong bài.");
    if (this.current || this.busyJob) throw new Error("Đợi mentor trả lời xong rồi hãy xin nhận xét.");
    this.send("Nhận xét code giúp mình", { context: codeReviewBlock(s.exercise) });
  }

  /** The learner moved the exercise on themself (skipping the lab, say). */
  mentorStage(stage: Parameters<MentorSession["setStage"]>[0]): void {
    const s = this.requireMentor();
    try {
      const result = s.setStage(stage, "user");
      if (result) this.showResult(result);
    } catch (e) {
      if (e instanceof StageRefused) throw new Error(e.message);
      throw e;
    }
  }

  private requireMentor(): MentorSession {
    if (!this.mentor) throw new Error("Chat này không phải một bài Mentor.");
    return this.mentor;
  }

  /** The attempt is done: its rating change and the streak, as a card. */
  private showResult(result: MentorResult): void {
    const streak = this.mentor!.mentor.home().streak.current;
    const gained = result.deltas.reduce((sum, d) => sum + d.after - d.before, 0);
    const card = this.addCard({
      kind: "mentor",
      tone: "ok",
      title: `${this.mentor!.attempt.kind === "review" ? "Ôn xong" : "Xong bài"}${result.revealed ? " (đã xem lời giải mẫu)" : ` · ${gained >= 0 ? "+" : ""}${gained} rating`}`,
      actions: [],
      mentor: { type: "result", result, streak },
    }, () => {});
    this.closeCard(card.cardId, "done");
  }

  /** The tools this chat's agent gets. */
  tools(): readonly ToolDef<any, any>[] {
    return this.workshop ? this.workshop.tools() : this.mentor ? MENTOR_CHAT_TOOLS : TOOLS;
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

  /** The workshop's exercises are written as this chat's job: the learner's messages wait, Stop stops it. */
  runAuthoring(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return this.withBusyJob((controller) => fn(controller.signal));
  }

  /** The cells the user attached, read now with their outputs. */
  private async attachedBlock(attached: AttachedCell[]): Promise<string> {
    let found: CellInfo[] | null = null;
    if (this.notebook) {
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
    if (!this.closed) this.host.emit("chat.snapshot", this.snapshot());
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
    if (JSON.stringify(before) !== JSON.stringify(res.project) || codeBefore !== this.codeState) this.host.emit("chat.snapshot", this.snapshot());
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
    this.host.emit("chat.snapshot", this.snapshot());
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
      this.touch(entry.message);
      return;
    }
    entry.card.progress = { done: 0, total: ids.length };
    entry.card.actions = [{ id: "cancel", label: "Stop" }];
    entry.card.detail = "Running from a clean state (%reset -f, not a kernel restart).";
    this.touch(entry.message);
    try {
      await this.withBusyJob(async (controller) => {
        const reset = await this.call({ op: "execute", code: "%reset -f", waitMs: 15_000 }, 30_000);
        if (reset.status !== "ok") {
          this.closeCard(cardId, "done", `Could not clear variables with %reset -f${reset.message ? `: ${reset.message}.` : "."} Nothing was saved.`);
          return;
        }
        const result = await this.runCellsInOrder(ids, (done) => {
          entry.card.progress = { done, total: ids.length };
          this.touch(entry.message);
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
        this.touch(entry.message);
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
    this.settings = this.mentor || this.workshop ? MENTOR_SETTINGS : settings;
    this.host.emit("chat.snapshot", this.snapshot());
  }

  async setOption(optionId: string, value: string | boolean): Promise<void> {
    if (this.current) throw new Error("Wait for the turn to finish before changing the agent's settings.");
    await this.ensureStarted();
    await this.agent!.setOption(optionId, value);
    this.host.emit("chat.snapshot", this.snapshot());
  }

  // ------------------------------------------------------------ agent events

  private onUpdate(n: SessionNotification): void {
    const u = n.update;
    if (u.sessionUpdate === "config_option_update") {
      this.agent?.applyConfigUpdate((u as any).configOptions ?? []);
      this.host.emit("chat.snapshot", this.snapshot());
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
      this.host.emit("chat.snapshot", this.snapshot());
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
        this.touch(msg);
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
        this.touch(msg);
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
        this.touch(msg);
        return;
      }
      case "plan": {
        const entries = u.entries.map((e) => ({ content: e.content, status: e.status }));
        const existing = msg.parts.find((p) => p.type === "plan");
        if (existing && existing.type === "plan") existing.entries = entries;
        else msg.parts.push({ type: "plan", entries });
        this.touch(msg);
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
    this.touch(msg);
    return new Promise<string>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => done("cancelled");
      const done = (answer: string) => {
        if (!this.prompts.has(promptId)) return;
        this.prompts.delete(promptId);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        part.answer = answer;
        this.touch(msg);
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
    this.touch(entry.message);
    this.cards.delete(cardId);
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
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          cell = (await this.call({ op: "get_cells", cellIds: [id], includeOutputs: true })).cells[0];
          if (!cell?.running) break;
        }
        if (signal.aborted) return { ran, cancelled: true };
        if (!cell) result = { ...result, status: "error" };
        else if (cell.outputs?.some((output) => output.kind === "error")) result = { ...result, status: "error" };
        else result = { ...result, status: "ok" };
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
          this.machinePoll = setInterval(() => void this.refreshMachine(), MACHINE_POLL_MS);
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
    if (this.workshop) return callTool(Object.assign(this.toolContext(), { workshop: this.workshop }), name, args, this.workshop.tools());
    if (this.mentor) {
      const before = this.mentor.attempt.result;
      return callTool(Object.assign(this.toolContext(), { mentor: this.mentor }), name, args, MENTOR_CHAT_TOOLS).then((r) => {
        const after = this.mentor!.attempt.result;
        if (after && !before) this.showResult(after);
        return r;
      });
    }
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
    this.touch(msg);
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
        this.touch(msg);
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
        this.touch(msg);
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
    let card: ChatCard;
    if (run.status === "error") card = this.addRunCard(run);
    else if (run.status === "ok" && long && !this.busyJob && !this.mentor) card = this.addFinishedCard(run);
    else if (run.status === "ok" && long && !this.busyJob && this.mentor?.exercise.role === "experiment" && this.mentor.stage !== "done") card = this.addTrainedCard(run);
    else return;
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
      // A Mentor chat never fixes the learner's code: the mentor helps them find the bug.
      actions: this.mentor
        ? [{ id: "explain", label: "Hỏi mentor", primary: true }, { id: "dismiss", label: "Bỏ qua" }]
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

  /** An experiment's long cell finished (training, most likely): the judge measures what it left in the kernel. */
  private addTrainedCard(run: CellRun): ChatCard {
    let cardId = "";
    const card = this.addCard({
      kind: "run",
      tone: "ok",
      title: `Cell [${run.index}] chạy xong · ${runDuration(run.durationMs ?? 0)}`,
      detail: "Train xong thì bấm Chấm bài: máy chấm đo trên mô hình đang nằm trong máy.",
      cellId: run.cellId,
      actions: [{ id: "judge", label: "Chấm bài", primary: true }, { id: "dismiss", label: "Bỏ qua" }],
    }, () => {
      this.closeCard(cardId, "done", "Đã chấm bài");
      void this.judge().catch((e) => this.system((e as Error).message));
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
    const text = this.mentor
      ? `Cell [${run.index}] bị lỗi. Gợi ý giúp mình tìm ra lỗi (đừng sửa hộ).`
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
      for (const p of m.parts) {
        if (p.type === "review" && p.review.reviewId === reviewId && p.status === "pending") {
          p.status = outcome;
          this.touch(m);
        }
      }
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
    for (const c of [...changes].reverse()) {
      const id = ids.get(c.cellId) ?? c.cellId;
      const what = c.kind === "insert" ? `new cell ${id.slice(0, 10)}` : c.kind === "delete" ? `deleted cell ${id.slice(0, 10)}` : `${c.kind === "move" ? "move of" : "change to"} cell ${id.slice(0, 10)}`;
      try {
        const { cells } = await this.call({ op: "get_cells" });
        const cell = cells.find((x) => x.id === id);
        if (c.kind !== "delete" && !cell) {
          skipped.push(`${what}: the cell no longer exists`);
          continue;
        }
        if ((c.kind === "update" || c.kind === "insert") && cell!.source !== c.after) {
          skipped.push(`${what}: edited since, so it was kept`);
          continue;
        }
        if (c.kind === "update") await this.call({ op: "update_cell", cellId: id, source: c.before, review: false, byUser: true });
        else if (c.kind === "insert") await this.call({ op: "delete_cell", cellId: id, review: false, byUser: true });
        else if (c.kind === "move") await this.call({ op: "move_cell", cellId: id, index: c.index, byUser: true });
        else {
          const res = await this.call({ op: "insert_cell", index: Math.min(c.index, cells.length), cellType: c.cellType, source: c.before, review: false, byUser: true });
          if (res.cellId) ids.set(c.cellId, res.cellId);
        }
        undone++;
      } catch (e) {
        skipped.push(`${what}: ${(e as Error).message}`);
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
    this.touch(msg);
  }

  /** Tools still marked running when a turn ends never finished. */
  private closeOpenTools(msg: ChatMessage): void {
    for (const p of msg.parts) {
      if (p.type === "tool" && (p.status === "pending" || p.status === "in_progress")) {
        p.status = "failed";
        this.touch(msg);
      }
    }
  }

  private touch(msg: ChatMessage): void {
    this.dirty.add(msg);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirty.size) return;
    for (const m of this.dirty) {
      const patch = this.patchFor(m);
      if (patch) this.host.emit("chat.patch", patch);
    }
    this.dirty.clear();
    this.schedulePersist();
  }

  /** What changed in `m` since it was last sent: appended text, or whole parts. */
  private patchFor(m: ChatMessage): MessagePatch | null {
    const before = this.sent.get(m.id);
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
      const json = JSON.stringify(part);
      now.push({ type: part.type, json });
      if (old?.json !== json) ops.push({ i, part });
    });
    const changes = JSON.stringify(m.changes ?? null);
    const known = this.sentChanges.get(m.id);
    if (before && !ops.length && before.length === m.parts.length && known === changes) return null;
    this.sent.set(m.id, now);
    this.sentChanges.set(m.id, changes);
    return { chatId: this.id, tabId: this.tabId, id: m.id, role: m.role, createdAt: m.createdAt, changes: m.changes, length: m.parts.length, ops };
  }

  private sentChanges = new Map<string, string>();

  private schedulePersist(): void {
    if (!this.host.persist || this.persistTimer || this.forgotten) return;
    this.persistTimer = setTimeout(() => this.persistNow(false), PERSIST_MS);
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
  if (/mcp__(notebook|project)__|notebook[_./:]|\bnotebook\b.*\(|\bproject[./:]|^(read_output|run_cells|run_all|shell_wait|shell_input|shell_interrupt|run_code|wait_for_code|wait_for_cells|interrupt_kernel|notebook_info|kernel_state|await_review|artifact_\w+|mentor_\w+|paper_\w+|save_notebook)\b/i.test(t)) return true;
  const toolName = (meta as any)?.claudeCode?.toolName ?? (meta as any)?.toolName;
  return typeof toolName === "string" && (toolName.includes("notebook") || toolName.startsWith("mcp__project__"));
}

function toolDetail(rawInput?: unknown, content?: ToolCallContent[] | null, rawOutput?: unknown): string | undefined {
  const parts: string[] = [];
  if (rawInput !== undefined && rawInput !== null && !(typeof rawInput === "object" && Object.keys(rawInput as object).length === 0)) {
    parts.push(typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2));
  }
  for (const c of content ?? []) {
    if (c.type === "content" && c.content.type === "text") parts.push(c.content.text);
    else if (c.type === "diff") parts.push(`diff ${c.path}`);
    else if (c.type === "terminal") parts.push(`terminal ${c.terminalId}`);
  }
  if (!content?.length && rawOutput !== undefined && rawOutput !== null) {
    parts.push(typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2));
  }
  if (!parts.length) return undefined;
  // Image results echo back as long base64 strings; they mean nothing as text.
  return capText(parts.join("\n\n").replace(/[A-Za-z0-9+/]{400,}={0,2}/g, "[image data]"), TOOL_DETAIL_MAX);
}

/** The judge could not run: why, for the learner. */
function kernelProblem(message: string): string {
  if (/busy/i.test(message)) return "Kernel đang bận chạy một cell. Đợi cell chạy xong (hoặc dừng nó) rồi bấm Chấm bài lại.";
  if (/session is not running|power button/i.test(message)) {
    return "Máy Kaggle chưa bật. Trong tab Kaggle, bấm nút nguồn (Start session) và đợi máy chạy, rồi bấm Chấm bài lại.";
  }
  if (/not reachable|reloaded|not connected/i.test(message)) {
    return "Không tới được notebook trên Chrome (trang vừa tải lại, hoặc tab đã đóng). Mở lại tab Kaggle, đợi nó nối lại rồi bấm Chấm bài.";
  }
  return `Chưa chấm được: ${message}`;
}

/** A tool's result with the GitHub token hidden (it is on the notebook's machine for git). */
function hideTokens(r: ToolResult): ToolResult {
  const text = redactTokens(r.text);
  return text === r.text ? r : { ...r, text };
}
