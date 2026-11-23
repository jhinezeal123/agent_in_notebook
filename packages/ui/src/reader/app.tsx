// The reading tab (docs/easy-read.md D.2, E.10): the outline with what is
// read, the paper (arXiv's HTML or its PDF), a bar over a selection that asks
// the tutor (Giải thích · Ví dụ cụ thể · Ký hiệu · Vì sao?) or keeps a
// question or a note, and beside it either the passes (guide.tsx: goal, pass
// 1, pass 2's checkpoints, notation, misconceptions) or the reader's
// questions and notes. Time spent in each section goes to the bridge, which
// says when one is read.

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { READER_ASK_LABEL, readerCiteLabel, readerSessionRemaining, type ReaderAnchor, type ReaderAskKind, type ReaderGuide, type ReaderNote, type ReaderSectionView, type ReaderStudySession, type ReaderView } from "@ainb/protocol";
import { anchorFor, selectionText } from "./anchors.js";
import { HtmlDoc } from "./doc-html.js";
import { PdfDoc } from "./doc-pdf.js";
import { AuthorLine, GuidePanel, PassBar, type GuideActions } from "./guide.js";
import type { DocHandle, ReaderInit, ReaderPageHost } from "./host.js";
import { ReaderWidgets } from "./widget-host.js";
import { Cite, Md } from "./bits.js";
import { EquationNotation } from "./notation.js";
import { StudyClock } from "./session.js";

/** How often time spent is sent to the bridge, and how long without a sign of the reader it stops counting. */
const FLUSH_MS = 15_000;
const IDLE_MS = 3 * 60_000;
const ASKS: ReaderAskKind[] = ["explain", "example", "notation", "why"];

export function ReaderApp({ host }: { host: ReaderPageHost }) {
  const [init, setInit] = useState<ReaderInit | null>(null);
  const [view, setView] = useState<ReaderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [textState, setTextState] = useState<{ done: number; total: number } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  /** Beside the paper: the passes, or the reader's questions and notes. */
  const [aside, setAside] = useState<"guide" | "notes" | null>("guide");
  const notesOpen = aside === "notes";
  const [guide, setGuide] = useState<ReaderGuide | null>(null);
  const [quizRequest, setQuizRequest] = useState(0);
  /** Pass 1's skim: dim what a first pass skips, light up the paragraphs' roles. */
  const [skim, setSkim] = useState({ on: true, roles: true });
  /** The sections hidden while the reader recalls them. */
  const [cover, setCover] = useState<string[] | null>(null);
  const [docReady, setDocReady] = useState(0);
  /** A note being written: from a selection (its anchor and words) or from scratch. */
  const [draft, setDraft] = useState<{ kind: ReaderNote["kind"]; anchor?: ReaderAnchor; text: string; id?: string } | null>(null);
  const [bar, setBar] = useState<{ x: number; y: number; anchor: ReaderAnchor; quote: string } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<DocHandle | null>(null);
  const currentRef = useRef<string | undefined>(undefined);
  currentRef.current = current;
  const sessionRef = useRef<ReaderStudySession>();
  sessionRef.current = view?.session;

  const say = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 3500);
  }, []);

  const load = useCallback(() => {
    void host.request<ReaderInit>("init").then((i) => {
      setInit(i);
      setView(i.view);
      setError(null);
    }, (e: Error) => setError(e.message));
  }, [host]);

  useEffect(() => {
    load();
    return host.on((e) => {
      if (e.event === "updated") setView(e.params as ReaderView);
      else if (e.event === "connected") load();
      else if (e.event === "quiz") {
        setAside("guide");
        setQuizRequest((n) => n + 1);
      }
      else if (e.event === "reveal") {
        const anchor = e.params as ReaderAnchor;
        if (!docRef.current?.reveal(anchor)) say(`Không thấy chỗ ${readerCiteLabel(anchor)} trong paper.`);
      } else if (e.event === "render") {
        const what = e.params as { page: number } | { asset: string };
        const doc = docRef.current;
        const send = (extra: { jpeg: string } | { error: string }) => void host.request("reader.rendered", { ...what, ...extra }).catch(() => {});
        if (!doc) send({ error: "Tab đọc chưa mở xong paper. Thử lại sau vài giây." });
        else doc.render(what).then((jpeg) => send({ jpeg }), (err: Error) => send({ error: err.message }));
      }
    });
  }, [host]);

  usePageTime(host, currentRef, sessionRef, () => void host.request<ReaderView>("reader.get").then(setView, () => {}));

  // The passes: asked again whenever the bridge says they changed.
  const loadGuide = useCallback(() => {
    void host.request<ReaderGuide>("reader.guide").then(setGuide, () => {});
  }, [host]);
  useEffect(() => {
    if (view) loadGuide();
  }, [view?.paperId, view?.guideRev]);

  /** A request of the passes: the answer carries the guide as it now is. */
  const act = useCallback(async <T,>(method: string, params?: unknown): Promise<T> => {
    try {
      const r = await host.request<T>(method, params);
      const o = r as { guide?: ReaderGuide; units?: unknown; paperId?: string } | null;
      const next = o && typeof o === "object" ? (o.guide ?? (Array.isArray(o.units) && o.paperId ? (o as unknown as ReaderGuide) : null)) : null;
      if (next) setGuide(next);
      return r;
    } catch (e) {
      say((e as Error).message);
      throw e;
    }
  }, [host, say]);

  // What the passes show on the paper.
  useEffect(() => {
    if (!view || !guide) return;
    const skimming = guide.pass === 1 && !!guide.goal && !guide.passed.includes(1);
    docRef.current?.decorate({
      roles: skimming && skim.roles ? guide.map.roles : [],
      skim: skimming && skim.on,
      hidden: guide.pass >= 2 ? guide.units.flatMap((u) => u.predicts.filter((p) => !p.answer).map((p) => p.id)) : [],
      cover: cover ?? [],
      sections: view.sections,
    });
  }, [guide, skim, cover, docReady, view?.sections]);

  // The bar over a selection in the paper.
  useEffect(() => {
    const onUp = () => setTimeout(() => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setBar(null);
      const range = sel.getRangeAt(0);
      const doc = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement)?.closest(".er-doc");
      if (!doc) return setBar(null);
      const quote = selectionText(range);
      if (quote.length < 2) return setBar(null);
      const rect = range.getBoundingClientRect();
      setBar({ x: Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2)), y: rect.top, anchor: anchorFor(range, quote), quote });
    }, 0);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".er-selbar")) setBar(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const ask = (kind: ReaderAskKind) => {
    if (!bar) return;
    const { anchor, quote } = bar;
    setBar(null);
    document.getSelection()?.removeAllRanges();
    void host.request("ask", { kind, anchor, quote }).then(() => say(`Đã hỏi gia sư: ${READER_ASK_LABEL[kind]}`), (e: Error) => say(e.message));
  };

  const keep = (kind: ReaderNote["kind"]) => {
    if (!bar) return;
    setDraft({ kind, anchor: bar.anchor, text: "" });
    setAside("notes");
    setBar(null);
    // The words are kept with the note: the selection would only bring the bar back.
    document.getSelection()?.removeAllRanges();
  };

  const saveNote = async () => {
    if (!draft || !draft.text.trim()) return;
    try {
      const v = await host.request<ReaderView>("reader.note", { note: { ...(draft.id ? { id: draft.id } : {}), kind: draft.kind, text: draft.text, ...(draft.anchor ? { anchor: draft.anchor } : {}) } });
      setView(v);
      setDraft(null);
    } catch (e) {
      say((e as Error).message);
    }
  };

  const noteAction = async (note: ReaderNote, action: "done" | "remove" | "ask" | "go" | "edit") => {
    try {
      if (action === "go" && note.anchor) {
        if (!docRef.current?.reveal(note.anchor)) say("Không thấy đoạn đó nữa.");
      } else if (action === "edit") setDraft({ id: note.id, kind: note.kind, text: note.text, ...(note.anchor ? { anchor: note.anchor } : {}) });
      else if (action === "remove") setView(await host.request<ReaderView>("reader.note", { remove: note.id }));
      else if (action === "done") setView(await host.request<ReaderView>("reader.note", { note: { id: note.id, kind: note.kind, text: note.text, done: !note.done } }));
      else if (action === "ask") {
        await host.request("askText", { text: note.text, ...(note.anchor ? { anchor: note.anchor } : {}) });
        say("Đã gửi câu hỏi cho gia sư.");
      }
    } catch (e) {
      say((e as Error).message);
    }
  };

  const mark = async (s: ReaderSectionView) => {
    try {
      setView(await host.request<ReaderView>("reader.mark", { section: s.id, read: !s.read }));
    } catch (e) {
      say((e as Error).message);
    }
  };

  const ready = useCallback((doc: DocHandle) => {
    docRef.current = doc;
    setDocReady((n) => n + 1);
  }, []);
  const scroller = useCallback(() => scrollerRef.current, []);
  /** Sections with text of their own: what "x/y mục" counts (as the reading list does). */
  const own = useMemo(() => (view?.sections ?? []).filter((s) => !s.empty), [view]);

  if (error) return <div class="er-center"><p>{error}</p><button class="er-btn" onClick={load}>Thử lại</button></div>;
  if (!init || !view) return <div class="er-center er-muted">Đang mở paper…</div>;

  const readCount = own.filter((s) => s.read).length;
  const actions: GuideActions = {
    act,
    cite: (anchor) => { if (!docRef.current?.reveal(anchor)) say(`Không thấy chỗ ${readerCiteLabel(anchor, view.sections)} trong paper.`); },
    scrollTo: (id) => docRef.current?.scrollTo(id),
    say,
    cover: setCover,
    ask: (text) => void host.request("askText", { text }).then(() => say("Đã gửi gia sư."), (e: Error) => say(e.message)),
  };
  const questions = view.notes.filter((n) => n.kind === "question");
  const notes = view.notes.filter((n) => n.kind === "note");
  const openQuestions = questions.filter((q) => !q.done).length;

  return (
    <div class={`er-app${outlineOpen ? "" : " no-outline"}${aside ? ` with-${aside}` : ""}`}>
      <header class="er-head">
        <button class="er-icon" title={outlineOpen ? "Ẩn mục lục" : "Hiện mục lục"} onClick={() => setOutlineOpen((v) => !v)}>☰</button>
        <div class="er-title">
          <div class="er-title-main" title={view.title}>{view.title}</div>
          <div class="er-title-meta">
            {[view.authors, view.year].filter(Boolean).join(" · ")}
            {view.arxiv && <> · <a href="#" onClick={(e) => { e.preventDefault(); void host.request("link.open", { url: `https://arxiv.org/abs/${view.arxiv}` }); }}>arXiv {view.arxiv}</a></>}
            <> · {view.view === "html" ? "HTML arXiv" : "PDF"}</>
          </div>
        </div>
        {guide && <PassBar guide={guide} onOpen={() => setAside((a) => (a === "guide" ? null : "guide"))} />}
        <StudyClock session={view.session} change={async (action) => {
          try { setView(await host.request<ReaderView>("reader.session", { action })); }
          catch (e) { say((e as Error).message); }
        }} />
        <div class="er-progress" title="Mục đã đọc: đủ khoảng 40 % thời gian ước tính, hoặc bạn tự đánh dấu">
          <span class="er-progress-bar"><span style={{ width: `${own.length ? Math.round((readCount / own.length) * 100) : 0}%` }} /></span>
          {readCount}/{own.length} mục
        </div>
        <button class={`er-btn${aside === "guide" ? " on" : ""}`} onClick={() => setAside((a) => (a === "guide" ? null : "guide"))} title="Các lượt đọc: mục tiêu, lượt 1, checkpoint của lượt 2">Các lượt</button>
        <button class={`er-btn${notesOpen ? " on" : ""}`} onClick={() => setAside((a) => (a === "notes" ? null : "notes"))} title="Câu hỏi của tôi và ghi chú">
          Câu hỏi & ghi chú{openQuestions ? ` (${openQuestions})` : ""}
        </button>
        <button class="er-btn primary" onClick={() => void host.request("chat.focus")} title="Khung chat bên cạnh là gia sư của paper này">Hỏi gia sư</button>
      </header>
      {(view.warnings.length > 0 || view.arxivHint || textState || cover || (guide && guide.author.state !== "idle")) && (
        <div class="er-notices">
          {cover && <div class="er-notice">Mục đang được gập để bạn nhớ lại. Viết xong (hoặc bấm “Mở lại mục”) thì nó hiện lại.</div>}
          {guide && <AuthorLine guide={guide} act={act} />}
          {textState && <div class="er-notice">Đang rút chữ của PDF cho gia sư… {textState.done}/{textState.total} trang</div>}
          {view.arxivHint && (
            <div class="er-notice">
              PDF này có trên arXiv ({view.arxivHint}). Bản HTML của arXiv đọc tốt hơn: công thức đúng như tác giả viết.{" "}
              <button class="er-link" onClick={() => void host.request("openArxiv", { arxiv: view.arxivHint })}>Mở bản arXiv</button>
            </div>
          )}
          {view.warnings.map((w) => <div key={w} class="er-notice muted">{w}</div>)}
        </div>
      )}
      <div class="er-body">
        {outlineOpen && (
          <nav class="er-outline" aria-label="Mục lục">
            {view.sections.map((s) => (
              <div key={s.id} class={`er-sec lvl-${s.level}${s.id === current ? " current" : ""}`}>
                <button
                  class={`er-dot ${s.read ? "read" : s.readMs > 0 ? "started" : ""}`}
                  title={s.read ? "Đã đọc (bấm để bỏ đánh dấu)" : "Bấm để đánh dấu đã đọc"}
                  aria-label={s.read ? "Bỏ đánh dấu đã đọc" : "Đánh dấu đã đọc"}
                  onClick={() => void mark(s)}
                >{s.read ? "●" : s.readMs > 0 ? "◐" : "○"}</button>
                <button class="er-sec-title" title={`${s.title} · ~${s.minutes} phút`} onClick={() => docRef.current?.scrollTo(s.id)}>
                  {s.number && <span class="er-sec-no">{s.number}</span>}{s.title}
                </button>
              </div>
            ))}
          </nav>
        )}
        <main class="er-scroll" ref={scrollerRef}>
          {view.view === "html"
            ? <HtmlDoc init={init} host={host} scroller={scroller} onReady={ready} onSection={setCurrent} />
            : <PdfDoc init={init} host={host} scroller={scroller} onReady={ready} onSection={setCurrent} onTextProgress={setTextState} />}
          <ReaderWidgets widgets={guide?.widgets ?? []} root={scrollerRef.current} version={docReady} actions={actions} />
        </main>
        {aside === "guide" && guide && <GuidePanel guide={guide} view={view} current={current} actions={actions} quizRequest={quizRequest}
          onQuizHandled={() => setQuizRequest(0)} skim={{ ...skim, set: (next) => setSkim({ ...skim, ...next }) }} />}
        {notesOpen && (
          <aside class="er-notes" aria-label="Câu hỏi của tôi và ghi chú">
            <div class="er-notes-head">
              <b>Câu hỏi của tôi</b>
              <button class="er-link" onClick={() => setDraft({ kind: "question", text: "", ...(current ? { anchor: { id: current } } : {}) })}>+ Thêm</button>
            </div>
            {draft && (
              <div class="er-draft">
                <div class="er-draft-kind">
                  <label><input type="radio" checked={draft.kind === "question"} onChange={() => setDraft({ ...draft, kind: "question" })} /> Câu hỏi</label>
                  <label><input type="radio" checked={draft.kind === "note"} onChange={() => setDraft({ ...draft, kind: "note" })} /> Ghi chú</label>
                </div>
                {draft.anchor?.quote && <blockquote class="er-quote">{clip(draft.anchor.quote, 220)}</blockquote>}
                <textarea
                  autoFocus
                  rows={3}
                  value={draft.text}
                  placeholder={draft.kind === "question" ? "Điều bạn chưa hiểu, để quay lại sau hoặc hỏi gia sư…" : "Ý bạn rút ra, bằng lời của bạn…"}
                  onInput={(e) => setDraft({ ...draft, text: (e.target as HTMLTextAreaElement).value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void saveNote(); if (e.key === "Escape") setDraft(null); }}
                />
                <div class="er-row">
                  <button class="er-btn primary" disabled={!draft.text.trim()} onClick={() => void saveNote()}>Lưu</button>
                  <button class="er-btn" onClick={() => setDraft(null)}>Hủy</button>
                </div>
              </div>
            )}
            {!questions.length && !draft && <p class="er-muted small">Chọn một đoạn trong paper rồi bấm “+ Câu hỏi” để giữ lại điều chưa hiểu.</p>}
            {questions.map((n) => <NoteItem key={n.id} note={n} sections={view.sections} onAction={noteAction} />)}
            <div class="er-notes-head"><b>Ghi chú</b></div>
            {!notes.length && <p class="er-muted small">Chưa có ghi chú.</p>}
            {notes.map((n) => <NoteItem key={n.id} note={n} sections={view.sections} onAction={noteAction} peer={view.pass && view.pass >= 3 ? actions : undefined} />)}
          </aside>
        )}
      </div>
      {bar && (
        <div class="er-selbar" style={{ left: `${bar.x}px`, top: `${Math.max(8, bar.y - 44)}px` }} onMouseDown={(e) => e.preventDefault()}>
          {ASKS.map((k) => <button key={k} onClick={() => ask(k)}>{READER_ASK_LABEL[k]}</button>)}
          <button onClick={() => {
            const { anchor, quote } = bar;
            setBar(null);
            document.getSelection()?.removeAllRanges();
            void actions.act("reader.widget.request", { anchor, goal: `Minh họa: ${clip(quote, 170)}` })
              .then(() => say("Đã yêu cầu ví dụ tương tác."), () => {});
          }}>Tạo ví dụ tương tác</button>
          <span class="er-sep" />
          <button onClick={() => keep("question")} title="Giữ lại điều chưa hiểu">+ Câu hỏi</button>
          <button onClick={() => keep("note")}>+ Ghi chú</button>
        </div>
      )}
      {toast && <div class="er-toast" role="status">{toast}</div>}
      {view.view === "html" && !!guide?.map.notation.length && <EquationNotation root={scrollerRef.current} notation={guide.map.notation} />}
    </div>
  );
}

function NoteItem({ note, sections, onAction, peer }: { note: ReaderNote; sections: ReaderSectionView[]; onAction: (n: ReaderNote, a: "done" | "remove" | "ask" | "go" | "edit") => void; peer?: GuideActions }) {
  const where = note.anchor && (note.anchor.id || note.anchor.page) ? readerCiteLabel(note.anchor, sections) : null;
  return (
    <div class={`er-note${note.done ? " done" : ""}`}>
      {note.anchor?.quote && <blockquote class="er-quote" onClick={() => onAction(note, "go")} title="Tới đoạn này">{clip(note.anchor.quote, 160)}</blockquote>}
      <div class="er-note-text">{note.text}</div>
      <div class="er-row small">
        {where && <button class="er-chip" onClick={() => onAction(note, "go")}>{where}</button>}
        {note.kind === "question" && <button class="er-link" onClick={() => onAction(note, "ask")}>Hỏi gia sư</button>}
        {note.kind === "question" && <button class="er-link" onClick={() => onAction(note, "done")}>{note.done ? "Mở lại" : "Đã hiểu"}</button>}
        <button class="er-link" onClick={() => onAction(note, "edit")}>Sửa</button>
        <button class="er-link danger" onClick={() => onAction(note, "remove")}>Xóa</button>
      </div>
      {peer && note.anchor && <div class="er-step">
        {(["experimentalist", "theorist"] as const).map((persona) => {
          const label = persona === "experimentalist" ? "Thực nghiệm" : "Lý thuyết";
          const reply = note.replies?.find((r) => r.persona === persona);
          const status = note.peerStatus?.[persona];
          return <div key={persona}>
            {reply ? <><b>{label}</b><Md text={reply.text} onCite={peer.cite} />
              {reply.evidence.map(({ anchor, quote }, i) => <Cite key={i} anchor={{ id: anchor, quote }} sections={sections} onCite={peer.cite} />)}</>
              : <button class="er-link" disabled={status?.pending} onClick={() => void peer.act("reader.peer", { note: note.id, persona }).catch(() => {})}>
                {status?.pending ? `${label} đang đọc ghi chú…` : `Mời đồng nghiệp · ${label}`}
              </button>}
            {status?.error && <p role="alert">{status.error}</p>}
          </div>;
        })}
      </div>}
    </div>
  );
}

/**
 * Time spent reading, per section: counted while the tab is shown and the
 * reader has done something in the last few minutes; sent every 15 seconds.
 */
function usePageTime(host: ReaderPageHost, current: { current: string | undefined }, session: { current: ReaderStudySession | undefined }, refresh: () => void): void {
  useEffect(() => {
    let lastSign = Date.now();
    const pending = new Map<string, number>();
    const sign = () => { lastSign = Date.now(); };
    const flush = () => {
      if (!pending.size) return;
      const slices = [...pending];
      pending.clear();
      void Promise.all(slices.map(([section, ms]) => host.request("reader.progress", { section, ms }).catch(() => {}))).then(refresh);
    };
    const tick = setInterval(() => {
      const at = current.current;
      const now = Date.now();
      if (session.current && !readerSessionRemaining(session.current, now)) {
        flush();
        return;
      }
      if (!at || document.visibilityState !== "visible" || now - lastSign > IDLE_MS) return;
      pending.set(at, (pending.get(at) ?? 0) + 1000);
    }, 1000);
    const send = setInterval(flush, FLUSH_MS);
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    for (const ev of ["scroll", "mousemove", "keydown", "mousedown", "wheel"]) window.addEventListener(ev, sign, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onHide);
    return () => {
      flush();
      clearInterval(tick);
      clearInterval(send);
      for (const ev of ["scroll", "mousemove", "keydown", "mousedown", "wheel"]) window.removeEventListener(ev, sign, { capture: true });
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [host]);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
