import { useEffect, useState } from "preact/hooks";
import { READER_BLOOM_LABEL, type ReaderExerciseKind, type ReaderExerciseView, type ReaderGuide, type ReaderView } from "@ainb/protocol";
import { Cite, Fold, GradeBadge, Md, WriteBox } from "./bits.js";
import { ReaderCards } from "./cards.js";
import type { GuideActions } from "./guide.js";

const TITLES: Record<ReaderExerciseKind, string> = {
  deep: "Câu đào sâu", derive: "Dẫn lại công thức", "find-flaws": "Tìm chỗ sai",
  review: "Review một trang", outline: "Dựng lại sườn paper", feynman: "Giải thích Feynman", synthesis: "Ghi chú 5 câu",
};

export function LaterPass({ guide, view, actions }: { guide: ReaderGuide; view: ReaderView; actions: GuideActions }) {
  const { pass } = guide;
  const [cover, setCover] = useState(false);
  useEffect(() => () => actions.cover(null), []);
  function foldPaper(hide: boolean) {
    setCover(hide);
    actions.cover(hide ? view.sections.map((s) => s.id) : null);
  }
  const exercises = (guide.exercises ?? []).filter((e) => (pass === 4) === (e.kind === "feynman" || e.kind === "synthesis"));
  return <>
    {pass === 3 && !exercises.some((e) => e.kind === "deep") && !guide.skipped.includes("exercise:deep-plan") && <>
      <p class="er-muted small">Đang chờ bộ câu đào sâu, dẫn công thức và tìm chỗ sai.</p>
      {guide.author.state !== "running" && <button class="er-link" onClick={() => void actions.act("reader.skip", { task: "exercise:deep-plan" }).catch(() => {})}>Bỏ qua bộ câu soạn sẵn</button>}
    </>}
    {exercises.map((exercise, i) => <Exercise key={exercise.id} exercise={exercise} index={i + 1} view={view} actions={actions} cover={cover} foldPaper={foldPaper} />)}
    {pass === 4 && <ReaderCards guide={guide} actions={actions} />}
    <div class="er-pass-end">
      {guide.deepUnderstood && <p>✓ Đã hiểu sâu</p>}
      {guide.passed.includes(pass) ? pass === 3
        ? <button class="er-btn primary" onClick={() => void actions.act("reader.pass", { pass: 4 }).catch(() => {})}>Sang lượt 4 · Ghi nhớ</button>
        : <p>✓ Đã xong lượt 4. Thẻ đến hạn hiện ở Khởi động của Mentor.</p>
        : <button class="er-btn primary" disabled={!guide.canFinish} onClick={() => void actions.act("reader.pass", { pass, done: true }).catch(() => {})}>Xong lượt {pass}</button>}
      <button class="er-btn" onClick={() => void actions.act("reproduce").catch(() => {})}>Reproduce</button>
    </div>
  </>;
}

function Exercise({ exercise: e, index, view, actions, cover, foldPaper }: {
  exercise: ReaderExerciseView; index: number; view: ReaderView; actions: GuideActions; cover: boolean; foldPaper: (hide: boolean) => void;
}) {
  const [appeal, setAppeal] = useState(false);
  const [reason, setReason] = useState("");
  const w = e.write;
  const title = e.bloom ? `${index} · ${READER_BLOOM_LABEL[e.bloom]}` : TITLES[e.kind];
  return <Fold title={title} badge={w ? <GradeBadge grade={w.grade} /> : null}>
    {e.kind === "find-flaws" && <p><b>Bài tập có lỗi cài sẵn.</b> Tìm từng lỗi và dẫn câu trong paper bác bỏ nó.</p>}
    <Md text={e.prompt} onCite={actions.cite} />
    <div class="er-row">{e.anchors.map(({ anchor, quote }) => <Cite key={`${anchor}-${quote}`} anchor={{ id: anchor, quote }} sections={view.sections} onCite={actions.cite} />)}</div>
    {e.kind === "outline" && <button class="er-btn" onClick={() => foldPaper(!cover)}>{cover ? "Mở lại mục" : "Gập paper để nhớ lại"}</button>}
    <WriteBox write={w} skipped={e.skipped} onCite={actions.cite} canRewrite={!w?.grading && (e.kind !== "deep" || !e.reference)}
      onSubmit={async (input) => {
        await actions.act("write", { ...input, kind: e.kind, key: e.id });
        if (e.kind === "outline") foldPaper(false);
      }} busyLabel={e.kind === "synthesis" ? "Lưu vào Tủ paper" : undefined}
      onSkip={() => { if (e.kind === "outline") foldPaper(false); void actions.act("reader.skip", { task: `exercise:${e.id}` }).catch(() => {}); }} />
    {w?.grade !== undefined && !w.appealed && (appeal ? <form onSubmit={(event) => {
      event.preventDefault();
      void actions.act("appeal", { write: w.id, reason }).then(() => setAppeal(false), () => {});
    }}><label class="er-field">Bạn muốn gia sư xem lại điểm nào?<textarea value={reason} required onInput={(event) => setReason(event.currentTarget.value)} /></label>
      <button class="er-btn primary" type="submit">Yêu cầu chấm lại</button><button class="er-link" type="button" onClick={() => setAppeal(false)}>Hủy</button>
    </form> : <button class="er-link" onClick={() => setAppeal(true)}>Phản đối điểm</button>)}
    {e.reference && <div class="er-reference">
      <b>{e.kind === "derive" ? "Các bước mẫu còn hiện" : "Bài tham chiếu"}</b><Md text={e.reference} onCite={actions.cite} />
    </div>}
  </Fold>;
}
