import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState } from "preact/hooks";
import { diffLines, diffStats, withContext, type ChatMessage, type Part, type ReviewInfo } from "@ainb/protocol";

marked.setOptions({ gfm: true, breaks: true });

export interface PartActions {
  answer(promptId: string, optionId: string): void;
  review(reviewId: string, accept: boolean): void;
  focusCell(cellId: string): void;
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  }, [text]);
  return (
    <div
      class="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Links open in a new tab, never inside the panel.
        const a = (e.target as HTMLElement).closest("a");
        if (a?.href) {
          e.preventDefault();
          void chrome.tabs.create({ url: a.href });
        }
      }}
    />
  );
}

export function Message({ msg, actions }: { msg: ChatMessage; actions: PartActions }) {
  if (msg.role === "user") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return <div class="msg user">{text}</div>;
  }
  if (!msg.parts.length) return null;
  return (
    <div class={`msg ${msg.role}`}>
      {msg.parts.map((p, i) => (
        <PartView key={i} part={p} actions={actions} />
      ))}
    </div>
  );
}

function PartView({ part, actions }: { part: Part; actions: PartActions }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} />;
    case "thought":
      return <Thought text={part.text} />;
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
      return <Prompt part={part} actions={actions} />;
    case "review":
      return <Review review={part.review} status={part.status} actions={actions} />;
    case "notice":
      return <div class={`notice ${part.level}`}>{part.text}</div>;
  }
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="thought">
      <button class="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▾" : "▸"} Thinking
      </button>
      {open && <div class="thought-body">{text}</div>}
    </div>
  );
}

const STATUS_ICON: Record<string, string> = { pending: "○", in_progress: "◐", completed: "✓", failed: "✕" };

function toolLabel(part: Extract<Part, { type: "tool" }>): string {
  if (part.notebookCalls?.length) return `notebook · ${part.notebookCalls.join(", ")}`;
  const m = part.title.match(/(?:mcp__notebook__|mcp\.notebook\.|notebook[./:_]{1,2})(\w+)/);
  if (m) return `notebook · ${m[1]}`;
  return part.title;
}

function Tool({ part }: { part: Extract<Part, { type: "tool" }> }) {
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

function Prompt({ part, actions }: { part: Extract<Part, { type: "prompt" }>; actions: PartActions }) {
  const answered = part.answer !== undefined;
  const chosen = part.options.find((o) => o.id === part.answer)?.name ?? (part.answer === "cancelled" ? "Cancelled" : part.answer);
  return (
    <div class={`card prompt ${answered ? "done" : "waiting"}`}>
      <div class="card-title">{part.title}</div>
      {part.detail && <pre class="card-detail">{part.detail}</pre>}
      {answered ? (
        <div class="card-status">→ {chosen}</div>
      ) : (
        <div class="card-actions">
          {part.options.map((o) => (
            <button key={o.id} class={o.kind.startsWith("allow") ? "primary" : "secondary"} onClick={() => actions.answer(part.promptId, o.id)}>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const REVIEW_TITLE: Record<ReviewInfo["kind"], string> = { update: "Change", insert: "New cell", delete: "Delete cell" };

export function Review({ review, status, actions }: { review: ReviewInfo; status: "pending" | "accepted" | "rejected"; actions: PartActions }) {
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
        {status !== "pending" && <span class={`badge ${status}`}>{status === "accepted" ? "Applied" : "Rejected"}</span>}
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
