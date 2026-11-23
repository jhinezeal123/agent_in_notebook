import { useState } from "preact/hooks";
import type { ReaderCardGrade, ReaderCardView, ReaderGuide } from "@ainb/protocol";
import { Cite } from "./bits.js";
import type { GuideActions } from "./guide.js";

export function ReviewCard({ card, grade, buttonClass = "er-btn" }: { card: ReaderCardView; grade: (g: ReaderCardGrade) => Promise<unknown>; buttonClass?: string }) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function review(g: ReaderCardGrade) {
    setBusy(true);
    try {
      await grade(g);
      setRevealed(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <div class="er-review-card">
    <p><b>{card.front}</b></p>
    {revealed ? <>
      <p>{card.back}</p>
      <div class="er-row">
        <button class={buttonClass} disabled={busy} onClick={() => void review("again")}>Quên</button>{" "}
        <button class={buttonClass} disabled={busy} onClick={() => void review("hard")}>Khó</button>{" "}
        <button class={`${buttonClass} primary`} disabled={busy} onClick={() => void review("good")}>Nhớ</button>
      </div>
    </> : <button class={buttonClass} onClick={() => setRevealed(true)}>Nhớ lại rồi lật thẻ</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function ReaderCards({ guide, actions }: { guide: ReaderGuide; actions: GuideActions }) {
  const cards = guide.cards ?? [];
  const due = cards.find((c) => c.kept && c.due !== undefined && c.due <= Date.now());
  const [edit, setEdit] = useState<ReaderCardView | "new" | null>(null);
  return <section>
    <h4>Thẻ ôn</h4>
    {due && <ReviewCard key={due.id} card={due} grade={(grade) => actions.act("reader.cards.review", { card: due.id, grade })} />}
    {cards.map((card) => <div class="er-step" key={card.id}>
      <b>{card.front}</b>{card.kept && <span class="er-muted"> · {card.due ? `ôn ${new Date(card.due).toLocaleDateString("vi")}` : "đã qua lịch ôn"}</span>}
      {!card.kept && <p>{card.back}</p>}
      <div class="er-row">
        <Cite anchor={card.anchor} onCite={actions.cite} />
        {!card.kept && <button class="er-btn" onClick={() => void actions.act("reader.cards.keep", { card: card.id }).catch(() => {})}>Giữ</button>}
        <button class="er-link" onClick={() => setEdit(card)}>Sửa</button>
        <button class="er-link" onClick={() => void actions.act("reader.cards.drop", { card: card.id }).catch(() => {})}>Bỏ</button>
      </div>
    </div>)}
    {edit ? <CardEditor key={edit === "new" ? "new" : edit.id} card={edit === "new" ? undefined : edit} actions={actions} close={() => setEdit(null)} />
      : <button class="er-btn" onClick={() => setEdit("new")}>Tự viết thẻ</button>}
  </section>;
}

function CardEditor({ card, actions, close }: { card?: ReaderCardView; actions: GuideActions; close: () => void }) {
  const [front, setFront] = useState(card?.front ?? "");
  const [back, setBack] = useState(card?.back ?? "");
  const [anchor, setAnchor] = useState(card?.anchor.id ?? "");
  const [quote, setQuote] = useState(card?.anchor.quote ?? "");
  return <form class="er-step" onSubmit={(e) => {
    e.preventDefault();
    void actions.act("reader.cards.keep", { card: card?.id, edit: { front, back, evidence: { anchor, quote } } }).then(close, () => {});
  }}>
    <label class="er-field">Câu hỏi<textarea rows={2} required value={front} onInput={(e) => setFront(e.currentTarget.value)} /></label>
    <label class="er-field">Đáp án<textarea rows={2} required value={back} onInput={(e) => setBack(e.currentTarget.value)} /></label>
    <label class="er-field">Mốc trích dẫn (ví dụ S2.E1 hoặc page-4)<input required value={anchor} onInput={(e) => setAnchor(e.currentTarget.value)} /></label>
    <label class="er-field">Câu trích nguyên văn<textarea rows={2} required value={quote} onInput={(e) => setQuote(e.currentTarget.value)} /></label>
    <button class="er-btn primary" type="submit">Lưu thẻ</button>
    <button class="er-link" type="button" onClick={close}>Hủy</button>
  </form>;
}
