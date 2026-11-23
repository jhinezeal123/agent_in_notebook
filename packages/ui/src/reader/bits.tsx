// Small parts of the passes' panel (guide.tsx): Markdown with formulas and
// citation chips, a grade, a box for the reader's own words.

import { useEffect, useState } from "preact/hooks";
import { readerCiteLabel, type ReaderAnchor, type ReaderGrade, type ReaderSectionView, type ReaderWriteView } from "@ainb/protocol";
import { citeOf, renderMarkdown } from "../markdown.js";

/** Markdown with $TeX$; [[anchors]] become chips that bring the place into view. */
export function Md({ text, onCite, class: cls = "" }: { text: string; onCite?: (a: ReaderAnchor) => void; class?: string }) {
  return (
    <div
      class={`er-md ${cls}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text, false, true) }}
      onClick={(e) => {
        const anchor = citeOf(e.target as Element);
        if (anchor) {
          e.preventDefault();
          onCite?.(anchor);
        }
      }}
    />
  );
}

/** A place in the paper, as a chip. */
export function Cite({ anchor, sections, onCite }: { anchor: ReaderAnchor; sections?: ReaderSectionView[]; onCite: (a: ReaderAnchor) => void }) {
  return (
    <button class="er-chip" title={anchor.quote ? `“${anchor.quote}”` : "Xem trong paper"} onClick={() => onCite(anchor)}>
      {readerCiteLabel(anchor, sections)}
    </button>
  );
}

export function GradeBadge({ grade }: { grade?: ReaderGrade }) {
  if (grade === undefined) return null;
  return <span class={`er-grade g${grade}`}>{grade}/2</span>;
}

/** What the reader wrote, and the tutor's grade of it. */
export function WriteResult({ write, labels, onCite }: { write: ReaderWriteView; labels?: Record<string, string>; onCite: (a: ReaderAnchor) => void }) {
  return (
    <div class="er-written">
      <div class="er-row small">
        <b>Bạn viết</b>
        {write.grading ? <span class="er-muted">· gia sư đang chấm trong khung chat…</span> : <GradeBadge grade={write.grade} />}
      </div>
      <Md text={write.text} onCite={onCite} class="er-mine" />
      {write.parts && write.parts.length > 0 && (
        <div class="er-parts">
          {write.parts.map((p) => (
            <div key={p.key} class="er-row small"><GradeBadge grade={p.grade} /> <b>{labels?.[p.key] ?? p.key}</b>{p.note && <span class="er-muted"> {p.note}</span>}</div>
          ))}
        </div>
      )}
      {write.missing && write.missing.length > 0 && <div class="small"><b>Còn thiếu:</b> {write.missing.join(" · ")}</div>}
      {write.feedback && <Md text={write.feedback} onCite={onCite} class="er-feedback" />}
    </div>
  );
}

/**
 * A box for the reader's own words: a textarea, or one per field (5C,
 * QALMRI). Sent to the tutor to grade, or kept. After that, it shows what was
 * written and can be written again.
 */
export function WriteBox({ fields, placeholder, rows = 4, write, busyLabel = "Gửi gia sư chấm", onSubmit, onSkip, skipped, onCite, hint, labels }: {
  fields?: { key: string; label: string; prompt: string }[];
  placeholder?: string;
  rows?: number;
  write?: ReaderWriteView;
  busyLabel?: string;
  onSubmit: (input: { text?: string; fields?: Record<string, string> }) => Promise<unknown>;
  onSkip?: () => void;
  skipped?: boolean;
  onCite: (a: ReaderAnchor) => void;
  hint?: string;
  labels?: Record<string, string>;
}) {
  const [again, setAgain] = useState(false);
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(write?.fields ?? {}) }));
  const [busy, setBusy] = useState(false);
  useEffect(() => setAgain(false), [write?.id]);
  const editing = !write || again;
  const ready = fields ? fields.some((f) => values[f.key]?.trim()) : !!text.trim();
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSubmit(fields ? { fields: values } : { text });
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="er-writebox">
      {write && <WriteResult write={write} labels={labels} onCite={onCite} />}
      {write && !again && <button class="er-link small" onClick={() => setAgain(true)}>Viết lại</button>}
      {editing && !skipped && (
        <>
          {hint && <p class="er-muted small">{hint}</p>}
          {fields
            ? fields.map((f) => (
                <label key={f.key} class="er-field">
                  <span><b>{f.label}</b> <span class="er-muted">{f.prompt}</span></span>
                  <textarea rows={2} value={values[f.key] ?? ""} onInput={(e) => setValues({ ...values, [f.key]: (e.target as HTMLTextAreaElement).value })} />
                </label>
              ))
            : <textarea rows={rows} value={text} placeholder={placeholder} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit(); }} />}
          <div class="er-row">
            <button class="er-btn primary" disabled={!ready || busy} onClick={() => void submit()}>{busy ? "Đang gửi…" : busyLabel}</button>
            {again && <button class="er-btn" onClick={() => setAgain(false)}>Hủy</button>}
            {onSkip && !write && <button class="er-link small" title="Mở đáp án tham chiếu; việc này không tính vào tiến độ" onClick={onSkip}>Cho xem luôn</button>}
          </div>
        </>
      )}
      {skipped && !write && <p class="er-muted small">Đã xem đáp án (không tính vào tiến độ).</p>}
    </div>
  );
}

/** A part of the panel that opens and closes. */
export function Fold({ title, badge, open: initial = false, children }: { title: string; badge?: preact.ComponentChildren; open?: boolean; children: preact.ComponentChildren }) {
  const [open, setOpen] = useState(initial);
  return (
    <section class={`er-fold${open ? " open" : ""}`}>
      <button class="er-fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="er-fold-arrow">{open ? "▾" : "▸"}</span>
        <span class="er-fold-title">{title}</span>
        {badge}
      </button>
      {open && <div class="er-fold-body">{children}</div>}
    </section>
  );
}
