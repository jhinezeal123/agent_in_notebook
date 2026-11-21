import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { chatImageDataUrl, diffLines, diffStats, withContext, type AppliedChange, type AttachedCell, type ChatCard, type ChatMessage, type Part, type ReviewInfo, type ReviewStatus } from "@ainb/protocol";
import { externalChatUrl } from "./chat-links.js";
import { chatImageSource } from "./images.js";
import { renderMarkdown, splitMarkdownBlocks, thoughtLine } from "./markdown.js";
import { groupParts, messageTime, messageTitle, summarizeTools, toolLabel, type ToolPart } from "./transcript.js";

import { usePanelHost, type PanelHost } from "./host.js";
import { Icon } from "./icons.js";
import { MentorCardBody } from "./mentor-bar.js";

export interface PartActions {
  answer(promptId: string, optionId: string): void;
  review(reviewId: string, accept: boolean): void;
  cardAction(cardId: string, actionId: string): void;
  focusCell(cellId: string): void;
  /** Insert code from the transcript as a new cell below the selected one. */
  insertCell(source: string, cellType: "code" | "markdown"): void;
  /** Revert the notebook changes of one agent turn. */
  undo(messageId: string): Promise<void>;
  /** Fetch the notebook changes one agent turn applied, from the journal (B2.1). */
  changes?(messageId: string): Promise<AppliedChange[]>;
  /** Pin or unpin a message so it survives 200-message trimming (B4.3). */
  pin?(messageId: string, pinned: boolean): void;
  /** Remove a single queued user message before its turn starts (B1.3). */
  dequeue?(messageId: string): void;
  /** Open a plot image in a zoomable VS Code editor tab (B5.2). */
  openImage?(mime: string, data: string, alt?: string): void;
  /** Open a review's before/after in VS Code's side-by-side diff editor (B2.2). */
  openReviewDiff?(review: ReviewInfo): void;
  /** Put a sent user message back in the composer: its text and attached cells. */
  edit(text: string, cells: AttachedCell[]): void;
  /** Send a user message again as a new one; the old message stays in the transcript. */
  resend(text: string, cells: AttachedCell[]): void;
}

type PromptPart = Extract<Part, { type: "prompt" }>;

export async function copyText(host: PanelHost, text: string, button?: HTMLElement): Promise<void> {
  try {
    await host.copy(text);
    if (button) {
      const old = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = old), 1200);
    }
  } catch {
    // clipboard unavailable
  }
}

export function Markdown({ text, actions }: { text: string; actions?: PartActions }) {
  const host = usePanelHost();
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    for (const image of root.querySelectorAll<HTMLImageElement>("img[data-local-image]")) {
      const target = image.dataset.localImage;
      if (!target) continue;
      delete image.dataset.localImage;
      void host.request<string | null>("image.resolve", { target }).then((data) => {
        if (!root.contains(image)) return;
        const src = data && chatImageSource(data);
        if (src?.startsWith("data:")) image.src = src;
        else showImageFallback(image);
      }, () => showImageFallback(image));
    }
    // Cached broken images can complete before the first effect runs.
    for (const image of root.querySelectorAll<HTMLImageElement>("img[src]")) {
      if (image.complete && image.naturalWidth === 0) showImageFallback(image);
    }
  }, [blocks, host]);
  const openLink = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const target = anchor.dataset.fileLink ?? externalChatUrl(anchor.getAttribute("href") ?? "");
    if (target) void host.openLink(target).catch(() => {});
  };
  return (
    <div
      ref={content}
      class={`md${actions ? " can-insert" : ""}`}
      onErrorCapture={(event) => { if (event.target instanceof HTMLImageElement) showImageFallback(event.target); }}
      onAuxClick={(event) => { if (event.button === 1) openLink(event); }}
      onClick={(e) => {
        const act = (e.target as Element).closest<HTMLElement>("[data-code-act]");
        if (!act) return openLink(e);
        const box = act.closest<HTMLElement>(".code");
        const code = box?.querySelector("code")?.textContent ?? "";
        if (act.dataset.codeAct === "copy") void copyText(host, code, act);
        else if (act.dataset.codeAct === "insert") actions?.insertCell(code.replace(/\n$/, ""), /^(md|markdown)$/i.test(box?.dataset.lang ?? "") ? "markdown" : "code");
      }}
    >
      {blocks.map((b, i) => (
        // An unchanged block keeps the same HTML string, so Preact leaves its DOM alone.
        <div key={i} class="md-block" dangerouslySetInnerHTML={{ __html: renderMarkdown(b, true) }} />
      ))}
    </div>
  );
}

function showImageFallback(image: HTMLImageElement): void {
  image.closest(".chat-image")?.classList.add("image-unavailable");
}

function ChatImage({ mime, data, alt = "Image from agent", onOpen }: Extract<Part, { type: "image" }> & { onOpen?: () => void }) {
  const src = chatImageDataUrl(mime, data);
  return (
    <div class={`chat-image${src ? "" : " image-unavailable"}${onOpen ? " zoomable" : ""}`}>
      {src && (
        <img
          src={src}
          alt={alt}
          title={onOpen ? "Click to zoom in VS Code" : undefined}
          loading="lazy"
          decoding="async"
          onClick={onOpen}
          onError={(event) => showImageFallback(event.currentTarget)}
        />
      )}
      <span class="image-fallback">Image unavailable</span>
    </div>
  );
}

/** Text parts of a message, for copying. */
function messageText(msg: ChatMessage): string {
  return msg.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** A cell attached to a message: its position and first line; click to show it, x to take it off. */
export function AttachedChip({ cell, onFocus, onRemove }: { cell: AttachedCell; onFocus: () => void; onRemove?: () => void }) {
  return (
    <span class="ctx-chip attached" title={`Cell [${cell.index}] · id ${cell.cellId}${cell.label ? `\n${cell.label}` : ""}\nClick to show it in the notebook.`}>
      <Icon name="attach" />
      <button class="ctx-name ctx-link" onClick={onFocus}>
        <span class="attached-index">[{cell.index}]</span> {cell.label || "(empty cell)"}
      </button>
      {onRemove && (
        <button class="ctx-btn" title="Remove from this message" aria-label={`Remove cell ${cell.index}`} onClick={onRemove}><Icon name="close" /></button>
      )}
    </span>
  );
}

/**
 * One message. Memoized: streaming replaces only the message that changed, so
 * the rest of a long transcript is not rendered again on every update.
 */
export const Message = memo(MessageView);

function MessageView({
  msg,
  actions,
  live = false,
  queued = false,
  highlight = false,
  activeHit = false,
}: {
  msg: ChatMessage;
  actions: PartActions;
  live?: boolean;
  queued?: boolean;
  highlight?: boolean;
  activeHit?: boolean;
}) {
  const host = usePanelHost();
  const hitCls = `${highlight ? " search-hit" : ""}${activeHit ? " search-active" : ""}${msg.pinned ? " is-pinned" : ""}`;
  if (msg.role === "user") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const cells = msg.parts.flatMap((p) => (p.type === "cells" ? p.cells : []));
    return (
      <div class={`msg user${hitCls}`} data-msg-id={msg.id} title={messageTitle(msg.createdAt)}>
        <Markdown text={text} />
        {cells.length > 0 && (
          <div class="msg-cells">
            {cells.map((cell) => <AttachedChip key={cell.cellId} cell={cell} onFocus={() => actions.focusCell(cell.cellId)} />)}
          </div>
        )}
        <div class="msg-foot">
          <span class="msg-time">{messageTime(msg.createdAt)}</span>
          {queued && (
            <span class="badge queued" title="Waiting for the agent to finish the current turn">
              queued
              {actions.dequeue && (
                <button class="queued-remove" title="Remove from queue" aria-label="Remove queued message" onClick={() => actions.dequeue?.(msg.id)}>×</button>
              )}
            </span>
          )}
          {msg.pinned && <span class="badge pinned-badge">pinned</span>}
          <button class="linkish" title="Put this message back in the input box, with its cells" onClick={() => actions.edit(text, cells)}>Edit</button>
          <button class="linkish" title="Send this message again as a new one; this one stays" onClick={() => actions.resend(text, cells)}>Resend</button>
          {actions.pin && (
            <button
              class={`icon pin-btn${msg.pinned ? " active" : ""}`}
              title={msg.pinned ? "Unpin message" : "Pin message (survives 200-message trim)"}
              aria-label={msg.pinned ? "Unpin message" : "Pin message"}
              onClick={() => actions.pin?.(msg.id, !msg.pinned)}
            >
              <Icon name="pin" />
            </button>
          )}
        </div>
      </div>
    );
  }
  // A card the user dismissed is gone from the chat.
  // (Older transcripts only say so in the outcome.)
  const parts = msg.parts.filter((p) => !(p.type === "card" && (p.card.dismissed || (p.card.state !== "open" && p.card.outcome === "Dismissed"))));
  if (!parts.length) return null;
  const items = groupParts(parts);
  const text = msg.role === "agent" && !live ? messageText(msg) : "";
  return (
    <div class={`msg ${msg.role}${hitCls}`} data-msg-id={msg.id} title={messageTitle(msg.createdAt)}>
      {items.map((item, i) =>
        item.kind === "tools" ? (
          <ToolGroup key={i} tools={item.tools} />
        ) : (
          <PartView key={i} part={item.part} actions={actions} liveThought={live && i === items.length - 1} />
        ),
      )}
      {!live && (text || msg.changes || msg.pinned) && (
        <div class="msg-foot">
          <span class="msg-time">{messageTime(msg.createdAt)}</span>
          {msg.pinned && <span class="badge pinned-badge">pinned</span>}
          {text && <CopyButton host={host} text={text} />}
          {actions.pin && msg.role === "agent" && (
            <button
              class={`icon pin-btn${msg.pinned ? " active" : ""}`}
              title={msg.pinned ? "Unpin message" : "Pin message (survives 200-message trim)"}
              aria-label={msg.pinned ? "Unpin message" : "Pin message"}
              onClick={() => actions.pin?.(msg.id, !msg.pinned)}
            >
              <Icon name="pin" />
            </button>
          )}
          {msg.changes && <Changes msg={msg} count={msg.changes.count} undone={!!msg.changes.undone} actions={actions} />}
        </div>
      )}
    </div>
  );
}

function CopyButton({ host, text }: { host: PanelHost; text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [done]);
  const label = done ? "Copied" : "Copy this reply";
  return (
    <button class={`icon${done ? " done" : ""}`} title={label} aria-label={label} onClick={() => void host.copy(text).then(() => setDone(true), () => {})}>
      <Icon name={done ? "check" : "copy"} />
    </button>
  );
}

/** What the turn changed in the notebook, with an audit diff view (B2.1) and undo that asks once before acting. */
function Changes({ msg, count, undone, actions }: { msg: ChatMessage; count: number; undone: boolean; actions: PartActions }) {
  const [step, setStep] = useState<"idle" | "confirm" | "working">("idle");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<AppliedChange[] | null>(null);
  const label = `${count} notebook change${count === 1 ? "" : "s"}`;

  const toggleView = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (entries !== null || !actions.changes) return;
    setLoading(true);
    void actions.changes(msg.id).then((list) => setEntries(list), () => setEntries([])).finally(() => setLoading(false));
  };

  return (
    <div class="changes-wrap">
      <div class={`changes${undone ? " muted" : ""}`}>
        {step === "confirm" ? (
          <>
            <span title="Cells edited since this turn are kept as they are.">Undo {label}?</span>
            <button
              class="primary small"
              onClick={() => {
                setStep("working");
                void actions.undo(msg.id).finally(() => setStep("idle"));
              }}
            >
              Undo
            </button>
            <button class="secondary small" onClick={() => setStep("idle")}>
              Keep
            </button>
          </>
        ) : (
          <>
            <span class="muted">{label}{undone ? " · undone" : ""}</span>
            {actions.changes && (
              <button class="linkish" aria-expanded={open} title="View the cell diffs applied in this turn" onClick={toggleView}>
                {open ? "Hide" : "View"}
              </button>
            )}
            {!undone && (
              <button class="linkish" disabled={step === "working"} title="Put the notebook back as it was before this turn" onClick={() => setStep("confirm")}>
                {step === "working" ? "Undoing…" : "Undo"}
              </button>
            )}
          </>
        )}
      </div>
      {open && (
        <div class="audit-drawer">
          {loading && <div class="muted small">Loading changes…</div>}
          {!loading && entries && !entries.length && <div class="muted small">Change details are no longer stored.</div>}
          {!loading && entries?.map((ch, idx) => <AuditEntry key={idx} change={ch} actions={actions} />)}
        </div>
      )}
    </div>
  );
}

function AuditEntry({ change, actions }: { change: AppliedChange; actions: PartActions }) {
  const before = change.kind === "insert" ? "" : change.kind === "move" ? "" : change.before;
  const after = change.kind === "delete" ? "" : change.kind === "move" ? "" : change.after;
  const lines = useMemo(() => (change.kind === "move" ? [] : diffLines(before, after)), [change.kind, before, after]);
  const stats = diffStats(lines);
  const rows = useMemo(() => withContext(lines, 2), [lines]);
  return (
    <div class="audit-entry">
      <div class="audit-head">
        <span class="audit-kind">{change.kind}</span>
        <button class="cell-ref" onClick={() => actions.focusCell(change.cellId)}>
          {change.cellType} [{change.index}]
        </button>
        {change.kind === "move" ? (
          <span class="muted small">[{change.index}] → [{change.toIndex ?? change.index}]</span>
        ) : (
          <span class="stats">
            <span class="add">+{stats.added}</span> <span class="del">−{stats.removed}</span>
          </span>
        )}
      </div>
      {change.kind !== "move" && rows.length > 0 && (
        <div class="diff">
          {rows.slice(0, 120).map((r, i) =>
            r.op === "skip" ? (
              <div key={i} class="row s">⋯ {r.count} unchanged</div>
            ) : (
              <div key={i} class={`row ${r.op === "add" ? "a" : r.op === "del" ? "d" : ""}`}>
                <span class="sign">{r.op === "add" ? "+" : r.op === "del" ? "−" : " "}</span>
                <span class="text">{r.text || " "}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function PartView({ part, actions, liveThought }: { part: Part; actions: PartActions; liveThought: boolean }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} actions={actions} />;
    case "image":
      return <ChatImage {...part} onOpen={actions.openImage ? () => actions.openImage!(part.mime, part.data, part.alt) : undefined} />;
    case "thought":
      return <Thought text={part.text} live={liveThought} />;
    case "tool":
      return <Tool part={part} />;
    case "plan":
      return (
        <ul class="plan">
          {part.entries.map((e, i) => (
            <li key={i} class={`plan-${e.status}`}>
              <span class="plan-mark">{e.status === "in_progress" ? <span class="spinner tool-spin" aria-hidden="true" /> : <Icon name={e.status === "completed" ? "check" : "circle"} />}</span>
              {e.content}
            </li>
          ))}
        </ul>
      );
    case "prompt":
      return <Prompt part={part} />;
    case "review":
      return <Review review={part.review} status={part.status} actions={actions} />;
    case "card":
      return <Card card={part.card} actions={actions} />;
    case "notice":
      return <div class={`notice ${part.level}`}>{part.text}</div>;
  }
}

function Thought({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const line = live && !open ? thoughtLine(text) : "";
  return (
    <div class="thought">
      <button class="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chev-d" : "chev-r"} /> {live ? "Thinking" : "Thought"}
        {line && <span class="thought-line">: {line}</span>}
      </button>
      {open && <div class="thought-body">{text}</div>}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "in_progress" || status === "pending") return <span class="spinner tool-spin" aria-hidden="true" />;
  return <Icon name={status === "failed" ? "close" : status === "completed" ? "check" : "circle"} />;
}

function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) return <Tool part={tools[0]!} />;
  const running = tools.filter((t) => t.status === "pending" || t.status === "in_progress");
  const failed = tools.filter((t) => t.status === "failed").length;
  const status = running.length ? "in_progress" : failed ? "failed" : "completed";
  const notebook = tools.some((t) => t.notebook);
  return (
    <div class={`tool group ${status} ${notebook ? "nb" : ""}`}>
      <button class="tool-head group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="tool-icon" aria-label={status}>
          <StatusIcon status={status} />
        </span>
        <span class="tool-summary" title={`${tools.length} tool calls`}>{running.length ? `${toolLabel(running.at(-1)!)}…` : summarizeTools(tools)}</span>
        {failed > 0 && <span class="tool-failed">{failed} failed</span>}
        <Icon name={open ? "chev-d" : "chev-r"} class="tool-chev" />
      </button>
      {open && (
        <div class="tool-group-body">
          {tools.map((t) => (
            <Tool key={t.toolCallId} part={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function Tool({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`tool ${part.status} ${part.notebook ? "nb" : ""}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!part.detail}>
        <span class="tool-icon" aria-label={part.status}>
          <StatusIcon status={part.status} />
        </span>
        <span class="tool-title">{toolLabel(part)}</span>
        {part.detail && <Icon name={open ? "chev-d" : "chev-r"} class="tool-chev" />}
      </button>
      {open && part.detail && <pre class="tool-detail">{part.detail}</pre>}
    </div>
  );
}

function chosenLabel(part: PromptPart): string | undefined {
  return part.options.find((o) => o.id === part.answer)?.name ?? (part.answer === "cancelled" ? "Cancelled" : part.answer === "expired" ? "Expired" : part.answer);
}

/** In the transcript a waiting question only points at the bar above the composer, where it is answered. */
function Prompt({ part }: { part: PromptPart }) {
  const answered = part.answer !== undefined;
  return (
    <div class={`card prompt ${answered ? "done" : "asked"}`}>
      <div class="card-title">{part.title}</div>
      <div class="card-status">{answered ? chosenLabel(part) : "Waiting for your answer below"}</div>
    </div>
  );
}

function Card({ card, actions }: { card: ChatCard; actions: PartActions }) {
  return (
    <div class={`card event tone-${card.tone} ${card.state}`}>
      <div class="card-title">
        <span class="card-heading">{card.title}</span>
        {card.cellId && (
          <button class="cell-ref" title="Show this cell in the notebook" onClick={() => actions.focusCell(card.cellId!)}>
            [{card.cellId.slice(0, 10)}]
          </button>
        )}
      </div>
      {card.detail && <div class="card-status">{card.detail}</div>}
      {card.mentor && <MentorCardBody body={card.mentor} />}
      {card.progress && (
        <div class="card-status card-progress">
          <progress max={card.progress.total} value={card.progress.done} />
          <span>{card.progress.done}/{card.progress.total}</span>
        </div>
      )}
      {card.state === "open" ? (
        <div class="card-actions">
          {card.actions.map((action) => (
            <button
              key={action.id}
              class={action.id === "dismiss" ? "linkish" : action.primary ? "primary" : "secondary"}
              onClick={() => actions.cardAction(card.cardId, action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        card.outcome && <div class="card-status card-outcome">{card.outcome}</div>
      )}
    </div>
  );
}

/** The oldest unanswered question, pinned above the composer so it cannot scroll out of sight. */
export function PendingPrompt({ part, more, actions }: { part: PromptPart; more: number; actions: PartActions }) {
  return (
    <div class="card prompt waiting dock" role="alertdialog" aria-label={part.title}>
      <div class="card-title">
        {part.title}
        {more > 0 && <span class="muted small"> (+{more} more)</span>}
      </div>
      {part.detail && <pre class="card-detail">{part.detail}</pre>}
      <div class="card-actions">
        {part.options.map((o) => (
          <button key={o.id} class={o.kind.startsWith("allow") ? "primary" : "secondary"} onClick={() => actions.answer(part.promptId, o.id)}>
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

const REVIEW_TITLE: Record<ReviewInfo["kind"], string> = { update: "Change", insert: "New cell", delete: "Delete cell" };
const REVIEW_BADGE: Record<Exclude<ReviewStatus, "pending">, { text: string; title?: string }> = {
  accepted: { text: "Applied" },
  rejected: { text: "Rejected" },
  discarded: { text: "Discarded", title: "The notebook page reloaded before this change was decided; it was not applied." },
};

export function Review({ review, status, actions }: { review: ReviewInfo; status: ReviewStatus; actions: PartActions }) {
  const lines = useMemo(() => diffLines(review.before, review.after), [review]);
  const stats = diffStats(lines);
  const rows = useMemo(() => withContext(lines, review.kind === "update" ? 2 : 1_000_000), [lines, review.kind]);
  const [expanded, setExpanded] = useState(status === "pending");
  const cellLabel = review.index !== undefined ? `[${review.index}] ${review.label || review.cellId.slice(0, 10)}` : review.cellId.slice(0, 10);
  return (
    <div
      class={`card review ${status}`}
      data-review-id={review.reviewId}
      tabIndex={status === "pending" ? 0 : undefined}
      onKeyDown={(e) => {
        if (status !== "pending") return;
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        if (e.key === "a" || e.key === "A") { e.preventDefault(); actions.review(review.reviewId, true); }
        else if (e.key === "r" || e.key === "R") { e.preventDefault(); actions.review(review.reviewId, false); }
      }}
    >
      <div class="review-head">
        <button class="linkish" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={expanded ? "Hide the diff" : "Show the diff"}>
          <Icon name={expanded ? "chev-d" : "chev-r"} />
        </button>
        <span class="card-title">
          {REVIEW_TITLE[review.kind]} ·{" "}
          <button class="cell-ref" title="Show this cell in the notebook" onClick={() => actions.focusCell(review.cellId)}>
            {review.cellType} {cellLabel}
          </button>
        </span>
        <span class="stats">
          <span class="add">+{stats.added}</span> <span class="del">−{stats.removed}</span>
        </span>
        {actions.openReviewDiff && (
          <button class="linkish small" title="Open side-by-side diff in VS Code" onClick={() => actions.openReviewDiff?.(review)}>
            Diff
          </button>
        )}
        {status !== "pending" && (
          <span class={`badge ${status}`} title={REVIEW_BADGE[status].title}>
            {REVIEW_BADGE[status].text}
          </span>
        )}
      </div>
      {expanded && (
        <div class="diff">
          {rows.map((r, i) =>
            r.op === "skip" ? (
              <div key={i} class="row s">
                ⋯ {r.count} unchanged
              </div>
            ) : (
              <div key={i} class={`row ${r.op === "add" ? "a" : r.op === "del" ? "d" : ""}`}>
                <span class="sign">{r.op === "add" ? "+" : r.op === "del" ? "−" : " "}</span>
                <span class="text">{r.text || " "}</span>
              </div>
            ),
          )}
        </div>
      )}
      {status === "pending" && (
        <div class="card-actions">
          <button class="primary" title="Apply (shortcut: A when card is focused)" onClick={() => actions.review(review.reviewId, true)}>
            {review.kind === "delete" ? "Delete" : "Apply"}
          </button>
          <button class="secondary" title="Reject (shortcut: R when card is focused)" onClick={() => actions.review(review.reviewId, false)}>
            Reject
          </button>
          <span class="muted small review-hint">A / R</span>
        </div>
      )}
    </div>
  );
}
