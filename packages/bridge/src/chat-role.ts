// A chat whose agent is not the notebook's coding agent plugs in here: it
// brings its own rules, prompt, tools and cards. The chat knows this interface
// and nothing of who implements it (Mentor's tutor and paper workshop do, in
// mentor/chat.ts), so the chat can change without reading their code, and
// they can change without touching the chat.

import type { CellInfo, CellRun, ChatCard, ChatSettings, ChatSnapshot, NotebookOpName, NotebookOpOf, NotebookOpResults } from "@ainb/protocol";
import type { ToolContext, ToolDef, ToolResult } from "./notebook/tools.js";

export interface ChatRole {
  /** The chat's mode, fixed: what the user picks in the chat does not apply. */
  readonly settings: ChatSettings;
  /** The chat exists: keep `port` and start listening. Returns how to stop, for when the chat closes. */
  attach(port: ChatPort): () => void;
  /** What the role adds to the chat's snapshot. */
  snapshot(): Partial<ChatSnapshot>;
  /** A turn's whole prompt, in place of the coding agent's. */
  prompt(turn: RoleTurn): Promise<string>;
  /** The tools the agent gets, in place of the notebook's. */
  tools(): readonly ToolDef<any, any>[];
  /** Run one of them. `ctx` is the chat's own, for the role to add to. */
  runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult>;
  /** A failed cell's card: what it offers in place of Fix / Explain / Dismiss, and what is then asked of the agent. */
  readonly failedRun?: { explain: string; dismiss: string; ask(run: CellRun): string };
  /** A long cell finished: its card in place of "Summarize result", or none. */
  longRun?(run: CellRun): RoleRunCard | null;
}

/** What a turn's prompt is made of, as the chat has it. */
export interface RoleTurn {
  text: string;
  /** Extra block that came with the message. */
  context?: string;
  /** The agent's session is new, or its context was compacted: it needs the rules again. */
  rules: boolean;
  /** The conversation so far, for an agent that has not seen it; "" when it has. */
  recap: string;
  /** The notebook's cells, read now; null when the notebook cannot be read. */
  cells(): Promise<CellInfo[] | null>;
  /** What the user did in the notebook since the last turn. */
  activity(): string | null;
  /** The cells the user attached to the message. */
  attached(): Promise<string | null>;
}

/** A card about a cell that finished: one action of the role's, and Dismiss. */
export interface RoleRunCard {
  title: string;
  detail: string;
  actions: ChatCard["actions"];
  /** What the card says once its action was taken. */
  done: string;
  act(): void;
}

/** What a role may do in its chat. */
export interface ChatPort {
  readonly chatId: string;
  readonly tabId: number;
  closed(): boolean;
  /** A turn or a notebook job is running. */
  busy(): boolean;
  /** An event to the chat's UI. */
  emit(event: string, params: unknown): void;
  /** An operation on the chat's notebook. */
  call<N extends NotebookOpName>(op: NotebookOpOf<N>, timeoutMs?: number): Promise<NotebookOpResults[N]>;
  /** Run `fn` alone under `lock` ("run": the kernel). */
  exclusive<T>(lock: string, fn: () => Promise<T>): Promise<T>;
  /** Run `fn` as the chat's job: messages wait for it, Stop aborts its signal. Refused while the chat is busy. */
  job<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  addCard(card: Omit<ChatCard, "cardId" | "state">, onAction: (actionId: string) => void): ChatCard;
  closeCard(cardId: string, state: "done" | "stale", outcome?: string, tone?: ChatCard["tone"]): void;
  /** A message to the agent, as if the user sent it. */
  send(text: string, extra?: { context?: string }): void;
  /** A line from the bridge, in the chat. */
  system(text: string): void;
}
