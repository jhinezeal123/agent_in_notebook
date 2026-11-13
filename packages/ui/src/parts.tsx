import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { chatImageDataUrl, diffLines, diffStats, withContext, type ChatMessage, type Part, type ReviewInfo, type ReviewStatus } from "@ainb/protocol";
import { externalChatUrl } from "./chat-links.js";
import { chatImageSource } from "./images.js";
import { renderMarkdown, splitMarkdownBlocks, thoughtLine } from "./markdown.js";
import { groupParts, summarizeTools, toolLabel, type ToolPart } from "./transcript.js";

import { usePanelHost, type PanelHost } from "./host.js";

export interface PartActions {
  answer(promptId: string, optionId: string): void;
  review(reviewId: string, accept: boolean): void;
  focusCell(cellId: string): void;
  /** Insert code from the transcript as a new cell below the selected one. */
  insertCell(source: string, cellType: "code" | "markdown"): void;
  /** Revert the notebook changes of one agent turn. */
  undo(messageId: string): Promise<void>;
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

function ChatImage({ mime, data, alt = "Image from agent" }: Extract<Part, { type: "image" }>) {
  const src = chatImageDataUrl(mime, data);
  return (
    <div class={`chat-image${src ? "" : " image-unavailable"}`}>
      {src && <img src={src} alt={alt} loading="lazy" decoding="async" onError={(event) => showImageFallback(event.currentTarget)} />}
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

/**
 * One message. Memoized: streaming replaces only the message that changed, so
 * the rest of a long transcript is not rendered again on every update.
 */
export const Message = memo(MessageView);

function MessageView({ msg, actions, live = false }: { msg: ChatMessage; actions: PartActions; live?: boolean }) {
  const host = usePanelHost();
  if (msg.role === "user") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return <div class="msg user"><Markdown text={text} /></div>;
  }
  if (!msg.parts.length) return null;
  const items = groupParts(msg.parts);
  const text = msg.role === "agent" && !live ? messageText(msg) : "";
  return (
    <div class={`msg ${msg.role}`}>
      {items.map((item, i) =>
        item.kind === "tools" ? (
          <ToolGroup key={i} tools={item.tools} />
        ) : (
          <PartView key={i} part={item.part} actions={actions} liveThought={live && i === items.length - 1} />
        ),
      )}
      {text && (
        <div class="msg-actions">
          <button class="linkish" title="Copy this reply" onClick={(e) => void copyText(host, text, e.currentTarget)}>
            Copy
          </button>
        </div>
      )}
      {msg.changes && !live && <Changes msg={msg} count={msg.changes.count} undone={!!msg.changes.undone} actions={actions} />}
    </div>
  );
}

/** What the turn changed in the notebook, with an undo that asks once before acting. */
function Changes({ msg, count, undone, actions }: { msg: ChatMessage; count: number; undone: boolean; actions: PartActions }) {
  const [step, setStep] = useState<"idle" | "confirm" | "working">("idle");
  const label = `${count} notebook change${count === 1 ? "" : "s"}`;
  if (undone) return <div class="changes muted">{label} · undone</div>;
  return (
    <div class="changes">
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
          <span class="muted">{label}</span>
          <button class="linkish" disabled={step === "working"} title="Put the notebook back as it was before this turn" onClick={() => setStep("confirm")}>
            {step === "working" ? "Undoing…" : "Undo"}
          </button>
        </>
      )}
    </div>
  );
}

function PartView({ part, actions, liveThought }: { part: Part; actions: PartActions; liveThought: boolean }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} actions={actions} />;
    case "image":
      return <ChatImage {...part} />;
    case "thought":
      return <Thought text={part.text} live={liveThought} />;
    case "tool":
      return <Tool part={part} />;
    case "plan":
      return (
        <ul class="plan">
          {part.entries.map((e, i) => (
            <li key={i} class={`plan-${e.status}`}>
              <span class="plan-mark">{e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : "○"}</span>
              {e.content}
            </li>
          ))}
        </ul>
      );
    case "prompt":
      return <Prompt part={part} />;
    case "review":
      return <Review review={part.review} status={part.status} actions={actions} />;
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
        {open ? "▾" : "▸"} {live ? "Thinking" : "Thought"}
        {line && <span class="thought-line">: {line}</span>}
      </button>
      {open && <div class="thought-body">{text}</div>}
    </div>
  );
}

const STATUS_ICON: Record<string, string> = { pending: "○", in_progress: "◐", completed: "✓", failed: "✕" };

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
          {STATUS_ICON[status]}
        </span>
        <span class="tool-summary">{running.length ? `${toolLabel(running.at(-1)!)}…` : summarizeTools(tools)}</span>
        {failed > 0 && <span class="tool-failed">{failed} failed</span>}
        <span class="tool-count">{tools.length} calls</span>
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
          {STATUS_ICON[part.status] ?? "○"}
        </span>
        <span class="tool-title">{toolLabel(part)}</span>
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
      <div class="card-status">{answered ? `→ ${chosenLabel(part)}` : "Waiting for your answer below ↓"}</div>
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
  return (
    <div class={`card review ${status}`}>
      <div class="review-head">
        <button class="linkish" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? "▾" : "▸"}
        </button>
        <span class="card-title">
          {REVIEW_TITLE[review.kind]} ·{" "}
          <button class="cell-ref" title="Show this cell in the notebook" onClick={() => actions.focusCell(review.cellId)}>
            {review.cellType} {review.cellId.slice(0, 10)}
          </button>
        </span>
        <span class="stats">
          <span class="add">+{stats.added}</span> <span class="del">−{stats.removed}</span>
        </span>
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
          <button class="primary" onClick={() => actions.review(review.reviewId, true)}>
            {review.kind === "delete" ? "Delete" : "Apply"}
          </button>
          <button class="secondary" onClick={() => actions.review(review.reviewId, false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
