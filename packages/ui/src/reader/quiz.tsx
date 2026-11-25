// A checkpoint question (E.6) and a pretest guess (D.3): the reader answers,
// says how sure they are (points by Gardner-Medwin), and then sees why each
// option is right or wrong, with the paper's words. "Cho xem luôn" shows the
// answer without counting; "Báo câu sai" withdraws a bad question.

import { useEffect, useState } from "preact/hooks";
import { READER_BLOOM_LABEL, type ReaderAnchor, type ReaderAnswerResult, type ReaderChoice, type ReaderItemView, type ReaderPretestView, type ReaderSectionView } from "@ainb/protocol";
import { Cite, Md } from "./bits.js";

const LETTERS = "ABCDEFGH";
const CONFIDENCE: { level: 1 | 2 | 3; label: string; points: string }[] = [
  { level: 1, label: "Đoán", points: "+1 / 0" },
  { level: 2, label: "Khá chắc", points: "+2 / −2" },
  { level: 3, label: "Rất chắc", points: "+3 / −6" },
];

export function ItemCard({ item, n, retry, sections, onAnswer, onSkip, onReport, onCite }: {
  item: ReaderItemView;
  n: number;
  /** Asked again (it was wrong): the last answer is hidden until answered anew. */
  retry?: boolean;
  sections: ReaderSectionView[];
  onAnswer: (choice: ReaderChoice, confidence: 1 | 2 | 3) => Promise<unknown>;
  onSkip: () => void;
  onReport: (reason: string) => void;
  onCite: (a: ReaderAnchor) => void;
}) {
  const [options, setOptions] = useState<number[]>([]);
  const [reason, setReason] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const [steps, setSteps] = useState<number[]>(() => item.steps?.map((_, i) => i) ?? []);
  const [pairs, setPairs] = useState<(number | null)[]>(() => item.lefts?.map(() => null) ?? []);
  const [confidence, setConfidence] = useState<1 | 2 | 3 | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(!!retry);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState("");
  useEffect(() => setAsking(!!retry), [retry, item.id]);
  const result = asking ? undefined : item.result;

  const choice = (): ReaderChoice | null => {
    switch (item.kind) {
      case "mcq":
      case "multi":
        return options.length ? { options } : null;
      case "twotier":
        return options.length && reason !== null ? { options, reason } : null;
      case "numeric": {
        const v = Number(value.replace(",", "."));
        return value.trim() && Number.isFinite(v) ? { value: v } : null;
      }
      case "order":
        return { steps };
      case "match":
        return pairs.every((p) => p !== null) ? { pairs: pairs as number[] } : null;
    }
  };
  const ready = !!choice() && confidence !== null;
  const submit = async () => {
    const c = choice();
    if (!c || confidence === null || busy) return;
    setBusy(true);
    try {
      await onAnswer(c, confidence);
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };
  const pick = (i: number) => setOptions(item.kind === "multi" ? (options.includes(i) ? options.filter((x) => x !== i) : [...options, i].sort()) : [i]);
  const move = (at: number, by: number) => {
    const next = [...steps];
    const to = at + by;
    if (to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to]!, next[at]!];
    setSteps(next);
  };

  const optionList = (list: string[], chosen: number[], onPick: (i: number) => void, right?: number[], why?: string[], multi = false) => (
    <div class="er-options" role={multi ? "group" : "radiogroup"}>
      {list.map((text, i) => {
        const isRight = right?.includes(i);
        const isChosen = chosen.includes(i);
        return (
          <div key={i} class={`er-option${isChosen ? " chosen" : ""}${right ? (isRight ? " right" : isChosen ? " wrong" : "") : ""}`}>
            <label>
              <input type={multi ? "checkbox" : "radio"} name={`${item.id}-${list === item.reasons ? "r" : "o"}`} checked={isChosen} disabled={!!right} onChange={() => onPick(i)} />
              <span class="er-letter">{LETTERS[i]}</span>
              <Md text={text} class="er-inline" />
              {right && (isRight ? <span class="er-mark ok">✓</span> : isChosen ? <span class="er-mark bad">✗</span> : null)}
            </label>
            {right && why?.[i] && (isRight || isChosen) && <div class="er-why small">{isRight ? "Vì sao đúng: " : "Hiểu sai: "}<Md text={why[i]!} class="er-inline" /></div>}
          </div>
        );
      })}
    </div>
  );

  const r = result;
  return (
    <div class={`er-item${r ? (item.skipped ? " shown" : r.correct ? " right" : " wrong") : ""}`}>
      <div class="er-item-head">
        <span class="er-item-no">Câu {n}</span>
        <span class="er-tag" title="Mức Bloom">{READER_BLOOM_LABEL[item.bloom]}</span>
        {item.kind === "twotier" && <span class="er-tag">hai tầng</span>}
        {item.again && !asking && <span class="er-tag warn">sẽ hỏi lại</span>}
      </div>
      <Md text={item.stem} onCite={onCite} />
      {(item.kind === "mcq" || item.kind === "multi" || item.kind === "twotier") && item.options && (
        <>
          {item.kind === "multi" && !r && <div class="er-muted small">Chọn mọi phương án đúng.</div>}
          {optionList(item.options, r ? r.choice.options ?? [] : options, pick, r?.right.options, r?.why, item.kind === "multi")}
        </>
      )}
      {item.kind === "twotier" && item.reasons && (
        <>
          <div class="er-sub">Vì sao?</div>
          {optionList(item.reasons, r ? (r.choice.reason !== undefined ? [r.choice.reason] : []) : reason !== null ? [reason] : [], (i) => setReason(i), r && r.right.reason !== undefined ? [r.right.reason] : undefined, r?.reasonsWhy)}
        </>
      )}
      {item.kind === "numeric" && (
        <div class="er-row">
          <input class="er-input" inputMode="decimal" value={r ? String(r.choice.value ?? "") : value} disabled={!!r} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
          {item.measure && <span>{item.measure}</span>}
          {r && <span class="small">Đáp án: <b>{r.right.value}</b>{r.right.tolerance ? ` ± ${r.right.tolerance}` : ""}</span>}
        </div>
      )}
      {item.kind === "order" && item.steps && (
        <ol class="er-steps">
          {(r ? r.right.steps ?? [] : steps).map((s, at) => (
            <li key={s}>
              <Md text={item.steps![s]!} class="er-inline" />
              {!r && <span class="er-step-move"><button class="er-icon" aria-label="Lên" onClick={() => move(at, -1)}>↑</button><button class="er-icon" aria-label="Xuống" onClick={() => move(at, 1)}>↓</button></span>}
            </li>
          ))}
          {r && !r.correct && <div class="er-muted small">(Thứ tự đúng ở trên.)</div>}
        </ol>
      )}
      {item.kind === "match" && item.lefts && item.rights && (
        <div class="er-match">
          {item.lefts.map((left, i) => (
            <div key={i} class="er-row">
              <Md text={left} class="er-inline er-left" />
              <span>↔</span>
              {r
                ? <span class={r.choice.pairs?.[i] === r.right.pairs?.[i] ? "er-ok" : "er-bad"}><Md text={item.rights![r.right.pairs![i]!]!} class="er-inline" /></span>
                : (
                  <select value={pairs[i] ?? ""} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; const next = [...pairs]; next[i] = v === "" ? null : Number(v); setPairs(next); }}>
                    <option value="">—</option>
                    {item.rights!.map((right, j) => <option key={j} value={j}>{right.replace(/\$/g, "")}</option>)}
                  </select>
                )}
            </div>
          ))}
        </div>
      )}
      {!r && (
        <>
          <div class="er-confidence" role="radiogroup" aria-label="Bạn chắc đến đâu?">
            <span class="er-muted small">Bạn chắc đến đâu?</span>
            {CONFIDENCE.map((c) => (
              <button key={c.level} class={`er-conf${confidence === c.level ? " on" : ""}`} title={`Đúng / sai: ${c.points}`} onClick={() => setConfidence(c.level)}>
                {c.level} {c.label}
              </button>
            ))}
          </div>
          <div class="er-row">
            <button class="er-btn primary" disabled={!ready || busy} onClick={() => void submit()}>Trả lời</button>
            {!retry && <button class="er-link small" title="Mở đáp án; câu này không tính điểm" onClick={onSkip}>Cho xem luôn</button>}
          </div>
        </>
      )}
      {r && <ResultBox result={r} skipped={!!item.skipped} sections={sections} onCite={onCite} />}
      {r && !reporting && (
        <div class="er-row small">
          {item.again && <button class="er-link" onClick={() => { setAsking(true); setOptions([]); setReason(null); setValue(""); setConfidence(null); }}>Trả lời lại</button>}
          <button class="er-link danger" onClick={() => setReporting(true)}>Báo câu sai</button>
        </div>
      )}
      {reporting && (
        <div class="er-report">
          <textarea rows={2} value={report} placeholder="Câu này sai ở đâu? (hai đáp án đúng, paper không nói vậy…)" onInput={(e) => setReport((e.target as HTMLTextAreaElement).value)} />
          <div class="er-row">
            <button class="er-btn" disabled={!report.trim()} onClick={() => { onReport(report.trim()); setReporting(false); }}>Rút câu này</button>
            <button class="er-link small" onClick={() => setReporting(false)}>Hủy</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultBox({ result, skipped, sections, onCite }: { result: ReaderAnswerResult; skipped: boolean; sections: ReaderSectionView[]; onCite: (a: ReaderAnchor) => void }) {
  const head = skipped
    ? "Đã xem đáp án (không tính điểm)"
    : result.correct
      ? `✓ Đúng · ${result.points > 0 ? "+" : ""}${result.points} điểm${result.confidence === 1 ? " · bạn đoán đúng: câu này sẽ còn được hỏi lại" : ""}`
      : `✗ ${result.partly ? "Đúng một tầng" : "Sai"} · ${result.points} điểm${result.confidence === 3 ? " · chắc mà sai: điều này vào Sổ lỗi sai" : ""}`;
  return (
    <div class="er-result">
      <div class={`er-result-head${skipped ? "" : result.correct ? " ok" : " bad"}`}>{head}</div>
      <Md text={result.explain} onCite={onCite} />
      {result.evidence.length > 0 && (
        <div class="er-evidence">
          {result.evidence.map((e, i) => (
            <div key={i} class="er-quote-line">
              <Cite anchor={{ id: e.anchor, quote: e.quote }} sections={sections} onCite={onCite} />
              <Md text={`“${e.quote}”`} class="er-inline er-muted small" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A pretest question: a guess, then the answer once its section is read. */
export function PretestCard({ item, n, sections, onGuess, onSkip, onCite }: {
  item: ReaderPretestView;
  n: number;
  sections: ReaderSectionView[];
  onGuess: (guess: { option?: number; text?: string }) => Promise<unknown>;
  onSkip: () => void;
  onCite: (a: ReaderAnchor) => void;
}) {
  const [option, setOption] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const where = sections.find((s) => s.id === item.section);
  const guess = async () => {
    setBusy(true);
    try {
      await onGuess(item.options ? { option: option! } : { text });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="er-item">
      <div class="er-item-head"><span class="er-item-no">Đoán {n}</span></div>
      <Md text={item.stem} onCite={onCite} />
      {item.options && (
        <div class="er-options">
          {item.options.map((o, i) => {
            const chosen = (item.guess?.option ?? option) === i;
            const right = item.answer?.right === i;
            return (
              <div key={i} class={`er-option${chosen ? " chosen" : ""}${item.answer ? (right ? " right" : chosen ? " wrong" : "") : ""}`}>
                <label>
                  <input type="radio" name={item.id} checked={chosen} disabled={!!item.guess || !!item.answer} onChange={() => setOption(i)} />
                  <span class="er-letter">{LETTERS[i]}</span>
                  <Md text={o} class="er-inline" />
                </label>
              </div>
            );
          })}
        </div>
      )}
      {!item.options && item.guess?.text && <div class="er-mine small">Bạn đoán: <Md text={item.guess.text} class="er-inline" /></div>}
      {!item.guess && !item.answer && (
        <>
          {!item.options && <textarea rows={2} value={text} placeholder="Đoán của bạn (sai cũng có ích)…" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />}
          <div class="er-row">
            <button class="er-btn" disabled={busy || (item.options ? option === null : !text.trim())} onClick={() => void guess()}>Đoán</button>
            <button class="er-link small" onClick={onSkip}>Cho xem luôn</button>
          </div>
        </>
      )}
      {item.guess && !item.answer && <p class="er-muted small">Đáp án mở khi bạn đọc xong {where ? (where.number ? `§${where.number}` : where.title) : "mục chứa nó"}.</p>}
      {item.answer && (
        <div class="er-result">
          <div class="er-result-head">Đáp án: <Md text={item.answer.text} onCite={onCite} class="er-inline" /></div>
          <Md text={item.answer.explain} onCite={onCite} />
          {item.answer.evidence.map((e, i) => (
            <div key={i} class="er-quote-line">
              <Cite anchor={{ id: e.anchor, quote: e.quote }} sections={sections} onCite={onCite} />
              <Md text={`“${e.quote}”`} class="er-inline er-muted small" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
