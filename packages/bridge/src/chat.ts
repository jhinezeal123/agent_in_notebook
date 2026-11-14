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
  type CellInfo,
  type ChatMessage,
  type ChatProject,
  type ChatSettings,
  type ChatSnapshot,
  type ChatStatus,
  type ChatUsage,
  type MessagePatch,
  type NotebookEvent,
  type NotebookInfo,
  type NotebookOpName,
  type NotebookOpOf,
  type NotebookOpResults,
  type OutputImage,
  type Part,
  type PartOp,
  type ReviewInfo,
  type UndoResult,
} from "@ainb/protocol";
import { AcpAgent, AgentStartError } from "./agents/acp-agent.js";
import type { AgentSpec } from "./agents/registry.js";
import { litReview, playbook, projectContext, projectUnavailable, projectUpdate, recap, turnContext } from "./instructions.js";
import { RecentRuns } from "./notebook/exec.js";
import { NotebookMirror, notebookPath } from "./notebook/nbfile.js";
import { ShellSessions } from "./notebook/shell.js";
import { callTool, Denied, type ReviewOutcome, type ToolContext, type ToolResult } from "./notebook/tools.js";
import { PROJECT_TOOLS, saveNotebook, type ProjectToolContext } from "./project/tools.js";
import { redactTokens, remoteOf } from "./project/github.js";
import { CodeSync } from "./project/vmrepo.js";
import type { ProjectBrief, ProjectLinks, ProjectResolution } from "./research/links.js";
import type { ProjectCache } from "./store.js";
import { ensureWorktree } from "./project/worktree.js";
import { describeFailure, type OrxProject, type ResearchProjects } from "./research/projects.js";
import { keyHash } from "./store.js";

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
}

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
  private turn: { controller: AbortController; prompting: boolean } | null = null;
  private queue: string[] = [];
  private turnTargets: string[] = [];
  private reviews = new Map<string, ReviewState>();
  private prompts = new Map<string, (optionId: string) => void>();
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
  /** Artifacts this chat wrote (it may replace them without asking). */
  private readonly createdArtifacts = new Set<string>();
  /** The project's code on the notebook's machine (a clone of the chat's branch). */
  private readonly code: CodeSync | null;
  /** The project as OpenResearch last described it. */
  private lastOrx: ProjectCache | null = null;
  /** What the agent was last told about the code, and what the user was. */
  private lastCodeNote = "";
  private lastCodeShown = "";
  /** Parts of each message as last sent to the extension, to send only what changed. */
  private sent = new Map<string, SentPart[]>();

  constructor(
    readonly tabId: number,
    readonly spec: AgentSpec,
    public settings: ChatSettings,
    private readonly host: ChatHost,
    opts: ChatOptions = {},
  ) {
    this.notebookKey = opts.notebookKey;
    this.project = opts.project;
    this.code = host.project && opts.notebookKey ? new CodeSync((op, ms) => this.call(op as never, ms) as Promise<unknown>, opts.notebookKey) : null;
    for (const [id, changes] of Object.entries(opts.journal ?? {})) if (Array.isArray(changes) && changes.length) this.journal.set(id, changes);
    const carried = opts.carried ?? [];
    // Offer undo only where the journal to do it is still at hand.
    for (const m of carried) if (m.changes && !this.journal.has(m.id)) delete m.changes;
    if (carried.length) {
      this.messages = carried;
      for (const message of carried) {
        for (const part of message.parts) if (part.type === "image") this.imageBytes += part.data.length;
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
      ...(this.project ? { project: this.project } : {}),
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
    this.turn?.controller.abort();
    this.queue = [];
    this.failPrompts();
    for (const r of this.reviews.values()) r.waiters.forEach((w) => w("pending"));
    this.agent?.dispose();
    this.agent = null;
    this.setStatus("closed");
    this.persistNow();
  }

  // ------------------------------------------------------------ turns

  send(text: string): void {
    const msg = this.newMessage("user", [{ type: "text", text }]);
    this.touch(msg);
    if (this.status === "running" || this.current) {
      this.queue.push(text);
      return;
    }
    void this.runTurn(text);
  }

  private async runTurn(text: string): Promise<void> {
    const reply = this.newMessage("agent", []);
    this.current = reply;
    const turn = { controller: new AbortController(), prompting: false };
    this.turn = turn;
    this.setStatus("running");
    try {
      await this.ensureStarted();
      turn.controller.signal.throwIfAborted();
      const prompt = await this.buildPrompt(text);
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
      void this.syncCode(firstLine(text, 72));
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

  private async buildPrompt(text: string): Promise<string> {
    let cells: CellInfo[] | null = null;
    let file: string | null = null;
    try {
      this.notebook = (await this.call({ op: "info" })) as NotebookInfo;
      cells = (await this.call({ op: "get_cells", summary: true })).cells;
    } catch {
      this.notebook = null;
    }
    if (this.notebook) file = await notebookPath(this.toolContext(), this.notebook).catch(() => null);
    this.turnTargets = this.settings.targetCellIds.length
      ? this.settings.targetCellIds
      : this.notebook?.selectedCellIds.length
        ? this.notebook.selectedCellIds
        : this.notebook?.activeCellId
          ? [this.notebook.activeCellId]
          : [];
    const blocks: string[] = [];
    const rules = this.sessionFresh || this.rulesDue;
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
    const project = await this.projectBlock(rules || !!this.pendingRecap);
    if (project) blocks.push(project);
    const code = await this.codeBlock(rules || !!this.pendingRecap);
    if (code) blocks.push(code);
    const lit = this.host.project ? litReview(text) : null;
    if (lit) blocks.push(lit);
    blocks.push(turnContext(this.notebook, cells, this.settings, this.turnTargets, unchanged, file));
    blocks.push(text);
    return blocks.join("\n\n");
  }

  // ------------------------------------------------------------ project

  /**
   * What the agent is told about the project this turn: everything on a
   * fresh session (or after a compaction or a move), else what changed since
   * its last message, else nothing. Never waits on OpenResearch to start.
   */
  private async projectBlock(full: boolean): Promise<string | null> {
    if (!this.host.project) return null;
    const res = await this.host.project.resolve(false).catch((e): ProjectResolution | null => {
      if (this.project) this.project = { ...this.project, state: "unavailable", error: describeFailure(e) };
      return null;
    });
    if (res) this.setProject(res);
    this.lastOrx = res?.orx ? { id: res.orx.id, name: res.orx.name, repoPath: res.orx.repoPath, githubUrl: res.orx.githubUrl ?? null, artifactsDir: res.orx.artifactsDir } : this.host.project?.cached() ?? null;
    if (res?.orx) {
      try {
        const brief = await this.host.project.links.brief(res.orx);
        const before = this.lastBrief;
        let text: string | null;
        if (full || this.projectMoved || !before || before.id !== brief.id) {
          const note = this.projectMoved ? `The user moved this notebook to the project ${brief.name}. What you were told about another project no longer applies.` : undefined;
          text = projectContext(brief, note);
        } else text = brief.digest === before.digest ? null : projectUpdate(before, brief);
        this.lastBrief = brief;
        this.projectMoved = false;
        this.lastProjectNote = "";
        return text;
      } catch (e) {
        if (this.project) this.project = { ...this.project, state: "unavailable", error: describeFailure(e) };
      }
    }
    if (!this.project) return null;
    const note = projectUnavailable(this.project);
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
    const orx = this.lastOrx;
    if (!this.code || !orx || !this.notebookKey) return null;
    const key = this.notebookKey;
    const title = this.notebook?.title?.replace(/\.ipynb$/i, "") || "notebook";
    if (!this.code.current && remoteOf(orx)) this.show("Putting the project's code on the notebook's machine…", "preparing");
    const st = await this.code.ensure(orx, async () => {
      const wt = await ensureWorktree(orx.repoPath, orx.id, key, title);
      this.showWorktree(orx.id, wt.path);
      return wt;
    });
    let note: string;
    if (st.state === "ready") {
      const p = st.place;
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

  /** A notice about the code, once for each state. */
  private show(text: string, key: string): void {
    if (key === this.lastCodeShown) return;
    this.lastCodeShown = key;
    this.system(text);
  }

  /** After a turn: what changed on the machine goes to the branch and the user's computer. */
  private async syncCode(subject: string): Promise<void> {
    if (!this.code?.current) return;
    const r = await this.code.syncBack(`Notebook chat: ${subject}`).catch((e: Error) => ({ changed: false, text: `Could not save the code from the notebook's machine: ${e.message}` }));
    if (this.closed || !r) return;
    if (r.text) this.system(r.text);
    if (r.changed && this.project?.id) this.host.project?.links.markDirty(this.project.id);
  }

  /** The project as OpenResearch just described it; a change reaches the chat UI. */
  setProject(res: ProjectResolution, moved = false): void {
    const before = this.project;
    if (moved || (before?.id && res.project.id && before.id !== res.project.id)) this.projectMoved = true;
    this.project = res.project;
    if (res.notice) this.system(res.notice);
    if (JSON.stringify(before) !== JSON.stringify(res.project)) this.host.emit("chat.snapshot", this.snapshot());
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
    if (res.orx) return { id: res.orx.id, name: res.orx.name, repoPath: res.orx.repoPath, githubUrl: res.orx.githubUrl ?? null, artifactsDir: res.orx.artifactsDir };
    const p = res.project;
    if (p.state === "missing") throw new Denied(p.error ?? `The project ${p.name} no longer exists.`);
    const cached = host.cached();
    if (cached) return cached;
    throw new Denied(`The project is not available right now: ${p.error ?? "OpenResearch is not running."}`);
  }

  private projectToolContext(): ProjectToolContext {
    const host = this.host.project;
    if (!host) throw new Denied("This chat has no project: its notebook has no stable address.");
    const ctx = this.toolContext();
    return Object.assign(ctx, {
      research: host.research,
      links: host.links,
      project: () => this.requireProject(),
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
    const r = await saveNotebook(this.projectToolContext(), { user: true });
    this.system(`Saved the notebook to ${r.path} in ${r.project.name}.`);
    return r.path;
  }

  async cancel(): Promise<boolean> {
    this.queue = [];
    this.failPrompts();
    if (!this.current) return false;
    this.turn?.controller.abort();
    if (this.turn?.prompting) await this.agent?.cancel().catch(() => {});
    return true;
  }

  // ------------------------------------------------------------ settings

  updateSettings(settings: ChatSettings): void {
    this.settings = settings;
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

  private failPrompts(): void {
    for (const p of [...this.prompts.values()]) p("cancelled");
  }

  // ------------------------------------------------------------ notebook

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
    }
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

  private system(text: string): void {
    this.touch(this.newMessage("system", [{ type: "notice", level: "info", text }]));
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

function findTool(msg: ChatMessage, id: string) {
  return msg.parts.find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.toolCallId === id);
}

/** Our MCP servers are registered as "notebook" and "project"; agents spell the tool name differently. */
export function isNotebookTool(title: string | undefined, meta: unknown): boolean {
  const t = title ?? "";
  if (/mcp__(notebook|project)__|notebook[_./:]|\bnotebook\b.*\(|\bproject[./:]|^(read_output|run_cells|run_all|shell_wait|shell_input|shell_interrupt|run_code|wait_for_code|wait_for_cells|interrupt_kernel|notebook_info|await_review|artifact_\w+|paper_search|paper_read|run_result|save_notebook)\b/i.test(t)) return true;
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

/** A tool's result with the GitHub token hidden (it is on the notebook's machine for git). */
function hideTokens(r: ToolResult): ToolResult {
  const text = redactTokens(r.text);
  return text === r.text ? r : { ...r, text };
}
