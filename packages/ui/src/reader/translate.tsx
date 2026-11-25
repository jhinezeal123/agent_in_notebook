// The paper in Vietnamese (docs/easy-read.md, "Dịch paper"): the switch
// between the English and the translation in the tab's header, and the line
// above the paper that starts, follows and stops the translator — a hidden
// chat on the tutor's agent, run only on the reader's click, with the agent
// turns it takes said before it starts.

import { useState } from "preact/hooks";
import type { ReaderTranslationView, ReaderView } from "@ainb/protocol";

export type ReaderLang = "en" | "vi";

/** EN | VI in the header; before any translation, the button that offers one. */
export function LangSwitch({ view, lang, setLang, offer }: { view: ReaderView; lang: ReaderLang; setLang: (l: ReaderLang) => void; offer: () => void }) {
  const t = view.translation;
  if (view.view !== "html" || !t) {
    return <button class="er-btn" disabled title="Chỉ dịch được paper hiện bằng HTML của arXiv: chữ của PDF không đặt lại vào trang được (mở bản arXiv của paper để dịch).">Dịch tiếng Việt</button>;
  }
  if (t.state === "none") return <button class="er-btn" onClick={offer} title="Dịch cả paper sang tiếng Việt, giữ nguyên công thức, hình, bảng số liệu và trích dẫn">Dịch tiếng Việt</button>;
  return (
    <span class="er-seg" role="group" aria-label="Ngôn ngữ của paper">
      <button class={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")} title="Bản gốc tiếng Anh">EN</button>
      <button class={lang === "vi" ? "on" : ""} aria-pressed={lang === "vi"} onClick={() => setLang("vi")} title={`Bản dịch tiếng Việt: ${t.done}/${t.total ?? "?"} đoạn. Alt+bấm vào một đoạn để xem bản gốc.`}>VI</button>
    </span>
  );
}

/**
 * The translator's line: an offer with the turns it takes, what runs now,
 * what is left (to go on), what failed (to try again). Nothing once the
 * whole paper is translated.
 */
export function TranslateLine({ t, offered, lang, act, close, onStarted }: {
  t: ReaderTranslationView;
  /** The reader pressed "Dịch tiếng Việt": the offer, with its estimate. */
  offered: ReaderTranslationView | null;
  lang: ReaderLang;
  act: <T>(method: string, params?: unknown) => Promise<T>;
  close: () => void;
  onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: "start" | "retry" | "stop") => {
    setBusy(true);
    try {
      await act("reader.translate", { action });
      if (action !== "stop") onStarted();
    } catch {
      // act said why.
    } finally {
      setBusy(false);
    }
  };
  const total = t.total ?? offered?.total;
  const progress = total ? `${t.done}/${total} đoạn` : `${t.done} đoạn`;
  if (offered && t.state === "none") {
    return (
      <div class="er-notice er-translate">
        <div class="er-row small">
          <span>
            Dịch cả paper sang tiếng Việt: <b>{offered.total ?? "?"} đoạn</b> (đoạn văn, tiêu đề, chú thích hình và bảng, footnote), khoảng <b>{offered.turnsLeft ?? "?"} lượt agent</b>,
            chạy trên agent và cấu hình của gia sư. Công thức, hình, bảng số liệu, trích dẫn và tài liệu tham khảo giữ nguyên.
          </span>
          <button class="er-btn primary" disabled={busy} onClick={() => void run("start")}>Dịch</button>
          <button class="er-link" onClick={close}>Hủy</button>
        </div>
      </div>
    );
  }
  if (t.state === "none" || (t.state === "done" && !t.failed)) return null;
  return (
    <div class={`er-notice er-translate${t.state === "running" ? " running" : ""}`}>
      <div class="er-row small">
        <b>Bản dịch tiếng Việt</b>
        <span class="er-translate-bar" aria-hidden="true"><span style={{ width: `${total ? Math.round((t.done / total) * 100) : 0}%` }} /></span>
        <span>{progress}</span>
        {t.state === "running" && <>
          <span>· đang dịch trên agent của gia sư…</span>
          <button class="er-link" disabled={busy} onClick={() => void run("stop")}>Dừng</button>
        </>}
        {t.state !== "running" && !!t.failed && <span>· {t.failed} đoạn chưa dịch được (giữ tiếng Anh)</span>}
        {t.state === "failed" && t.error && <span class="er-err-text">· {t.error}</span>}
        {t.state !== "running" && total !== undefined && t.done + t.failed < total && (
          <button class="er-link" disabled={busy} onClick={() => void run("start")}>Dịch tiếp{t.turnsLeft ? ` (~${t.turnsLeft} lượt agent)` : ""}</button>
        )}
        {t.state !== "running" && !!t.failed && <button class="er-link" disabled={busy} onClick={() => void run("retry")}>Dịch lại đoạn lỗi</button>}
        {lang === "vi" && <span class="er-muted">· Alt+bấm vào một đoạn để xem bản gốc</span>}
      </div>
    </div>
  );
}
