import { READER_PASS_LABEL, type ReaderGuide } from "@ainb/protocol";

export function ReaderBar({ guide, quiz }: { guide: ReaderGuide; quiz: () => void }) {
  return <div class="banner reader-bar">
    <div>
      <div aria-label="Tiến độ đọc">{guide.goal ? ([1, 2, 3, 4] as const).map((pass) => {
        const label = `${"①②③④"[pass - 1]} ${READER_PASS_LABEL[pass]}${guide.passed.includes(pass) ? " ✓" : ""}`;
        return <span key={pass} class="small">{pass === guide.pass ? <b>{label}</b> : label}{" "}</span>;
      }) : "Chọn mục tiêu trong tab đọc"}</div>
      {guide.author.state === "running" && <div class="muted small">Đang soạn · {guide.author.task}</div>}
      {guide.pass === 2 && <div class="muted small">{guide.units.filter((u) => u.done).length}/{guide.units.length} checkpoint · {guide.again.length} câu cần làm lại</div>}
      {guide.pass >= 3 && !!guide.cards?.filter((c) => c.kept && c.due !== undefined && c.due <= Date.now()).length && <div class="muted small">Có thẻ đến hạn ôn</div>}
    </div>
    {guide.goal && <button class="linkish" onClick={quiz}>Hỏi tôi một câu</button>}
  </div>;
}
