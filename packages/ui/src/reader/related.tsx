import { useEffect, useState } from "preact/hooks";
import type { ReaderRelated } from "@ainb/protocol";
import type { GuideActions } from "./guide.js";

export function Related({ actions }: { actions: GuideActions }) {
  const [context, setContext] = useState<ReaderRelated>();
  const [error, setError] = useState("");
  function load() {
    setError("");
    void actions.act<ReaderRelated>("reader.related").then(setContext, (e: Error) => setError(e.message));
  }
  useEffect(load, []);
  return <section>
    {error && <p role="alert">{error}</p>}
    {!context && !error && <p>Đang tra tài liệu liên quan…</p>}
    {context?.notice && <p>{context.notice}</p>}
    {(error || context?.notice) && <button class="er-btn" onClick={load}>Thử lại</button>}
    <h4>Tài liệu tham khảo</h4>
    {context?.references.map((r) => <div class="er-step" key={r.id}>
      {r.role && <b>{r.role} · </b>}{r.text}
      <div class="er-row">
        {!r.id.startsWith("ref-") && <button class="er-link" onClick={() => actions.cite({ id: r.id })}>Tới mục tham khảo</button>}
        {r.arxiv && <button class="er-link" onClick={() => void actions.act("openArxiv", { arxiv: r.arxiv }).catch(() => {})}>Đọc paper này</button>}
        {r.doi && <button class="er-link" onClick={() => void actions.act("link.open", { url: `https://doi.org/${r.doi}` }).catch(() => {})}>Mở DOI</button>}
      </div>
    </div>)}
    <h4>Paper trích dẫn bài này</h4>
    {context && !context.notice && !context.citations.length && <p>Chưa tìm thấy paper trích dẫn.</p>}
    {context?.citations.map((r, i) => <div class="er-step" key={i}>
      {r.title}
      <div class="er-row">
        <button class="er-link" onClick={() => void actions.act(r.arxiv ? "openArxiv" : "link.open", r.arxiv ? { arxiv: r.arxiv } : { url: r.url }).catch(() => {})}>
          {r.arxiv ? "Đọc paper này" : "Xem trên Semantic Scholar"}
        </button>
      </div>
    </div>)}
  </section>;
}
