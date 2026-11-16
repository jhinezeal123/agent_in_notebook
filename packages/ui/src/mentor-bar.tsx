// The Mentor parts of the notebook chat: the exercise's steps with the
// Judge and Hint buttons above the transcript, and the verdict and result
// cards inside it.

import { useState } from "preact/hooks";
import { MENTOR_HINT_LABEL, MENTOR_HINT_MAX, MENTOR_SKILL_LABEL, MENTOR_STAGE_LABEL, mentorRank, type MentorCardBody, type MentorChat, type MentorStage, type MentorWorkshop } from "@ainb/protocol";

const STEPS: MentorStage[] = ["lab", "build", "defend"];
const VARIANT_HINT = "Viết dự đoán vào cell Dự đoán và gửi mentor, trước khi code";
const REVIEW_HINT = "Cài lại từ trí nhớ, rồi bấm Chấm bài: qua máy chấm là xong buổi ôn";
const EXPERIMENT_HINT = "Viết dự đoán và gửi mentor; rồi chạy các cell để train, train xong bấm Chấm bài";

const STEP_HINT: Record<MentorStage, string> = {
  lab: "Chạy các cell công thức, rồi kể lại công thức bằng lời của bạn",
  build: "Phác thảo, rồi tự code trong cell bài làm và bấm Chấm bài",
  defend: "Trả lời các câu hỏi vặn của mentor",
  done: "Bài đã xong",
};

export function MentorBar({ mentor, busy, onJudge, onHint, onStage, onHome, onCodeReview, onReport }: {
  mentor: MentorChat;
  /** The agent is answering, or the judge is running: the buttons wait. */
  busy: boolean;
  onJudge: () => void;
  onHint: () => void;
  onStage: (stage: MentorStage) => void;
  onHome: () => void;
  onCodeReview: () => void;
  onReport: (reason: string) => void;
}) {
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const experiment = mentor.paper?.role === "experiment";
  const done = mentor.stage === "done";
  const review = mentor.kind === "review";
  const steps: MentorStage[] = review ? ["build"] : STEPS;
  const variant = !!mentor.variantOf;
  const stepLabel = (s: MentorStage) => (review ? "Cài lại từ cell trống" : (variant || experiment) && s === "lab" ? "Dự đoán" : experiment && s === "build" ? "Train" : MENTOR_STAGE_LABEL[s]);
  const stepHint = (s: MentorStage) => (review ? REVIEW_HINT : experiment && s !== "defend" && s !== "done" ? EXPERIMENT_HINT : variant && s === "lab" ? VARIANT_HINT : STEP_HINT[s]);
  const at = steps.indexOf(mentor.stage);
  const next = Math.min(MENTOR_HINT_MAX, mentor.hintLevel + 1);
  const v = mentor.verdict;
  const hint = () => {
    if (next === MENTOR_HINT_MAX && !confirmReveal) {
      setConfirmReveal(true);
      return;
    }
    setConfirmReveal(false);
    onHint();
  };
  return (
    <section class="mentor-bar" aria-label="Bài Mentor">
      <div class="mentor-bar-body chat-width">
        <div class="mentor-head">
          <span class="mentor-mark" aria-hidden="true">{review ? "🔁" : "✦"}</span>
          <span class="mentor-title" title={variant ? `Biến thể của: ${mentor.variantOf}` : mentor.title}>{review ? `Ôn lại: ${mentor.title}` : variant ? `Biến thể: ${mentor.title}` : mentor.title}</span>
          <button class="linkish mentor-home-link" onClick={onHome} title="Mở trang Mentor (bản đồ, rating, chuỗi ngày)">Trang Mentor</button>
        </div>
        {mentor.paper && (
          <div class="mentor-paper-line" title={mentor.paper.ai ? "Bài do mentor soạn cho paper này, đã qua máy kiểm chứng; rating đổi bằng một nửa bài soạn sẵn" : "Thành phần của paper mốc"}>
            📜 {mentor.paper.title} · {experiment ? "thí nghiệm" : `thành phần ${mentor.paper.index}/${mentor.paper.total}`}{mentor.paper.cites ? ` · ${mentor.paper.cites}` : ""}{mentor.paper.ai ? " · mentor soạn" : ""}
            <button class="linkish" onClick={() => setReporting(!reporting)} title="Đề lệch paper, hay test vô lý? Lượt làm này sẽ không tính.">Báo bài sai</button>
          </div>
        )}
        {reporting && (
          <div class="mentor-confirm" role="dialog">
            <textarea rows={2} placeholder="Chỗ nào sai? (đề lệch paper, test đòi điều vô lý…)" value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
            <button class="primary small" disabled={!reason.trim()} onClick={() => { onReport(reason.trim()); setReporting(false); setReason(""); }}>Gửi</button>
            <button class="linkish" onClick={() => setReporting(false)}>Thôi</button>
            <span class="muted small">Lượt làm này sẽ không tính rating.{mentor.paper?.ai ? " Mở xưởng của paper để mentor soạn lại bài." : ""}</span>
          </div>
        )}
        <ol class="mentor-steps">
          {steps.map((s, i) => (
            <li key={s} class={done || i < at ? "done" : i === at ? "current" : ""} title={stepHint(s)}>
              <span class="mentor-step-dot" aria-hidden="true">{done || i < at ? "✓" : i + 1}</span>
              <span>{stepLabel(s)}</span>
              {s === "defend" && (mentor.stage === "defend" || done) && <span class="mentor-step-count">{mentor.probes.done}/{mentor.probes.needed}</span>}
            </li>
          ))}
        </ol>
        {!done && <div class="mentor-now">{stepHint(mentor.stage)}</div>}
        {done && (
          <div class="mentor-actions">
            <button class="secondary small" disabled={busy} onClick={onCodeReview} title="Mentor nhận xét code của bạn như một đàn anh review; không ảnh hưởng rating">Nhận xét code</button>
            {mentor.result && !mentor.result.revealed && <span class="mentor-score ok">{Math.round(mentor.result.score * 100)} điểm</span>}
          </div>
        )}
        {!done && (
          <div class="mentor-actions">
            <button class="primary small" disabled={busy} onClick={onJudge} title="Chạy bộ test ẩn trên cell bài làm của bạn">Chấm bài</button>
            <button
              class="secondary small"
              disabled={busy || mentor.hintLevel >= MENTOR_HINT_MAX}
              onClick={hint}
              title={mentor.hintLevel >= MENTOR_HINT_MAX ? "Đã ở mức cao nhất" : `Mức tiếp theo: ${MENTOR_HINT_LABEL[next]}`}
            >
              Xin gợi ý <span class="mentor-hint-level">{mentor.hintLevel}/{MENTOR_HINT_MAX}</span>
            </button>
            {mentor.stage === "lab" && (
              <button class="linkish" disabled={busy} onClick={() => onStage("build")} title={variant ? "Bỏ qua phần dự đoán (được ghi lại)" : "Bỏ qua phần kể lại công thức (được ghi lại)"}>Sang Dựng</button>
            )}
            {v && (
              <span class={`mentor-score ${v.ok ? "ok" : "fail"}`} title={`${mentor.judges} lần chấm`}>
                {v.error || v.missing ? "chưa chạy" : `${v.passed}/${v.total}`}
              </span>
            )}
            {mentor.revealed && <span class="mentor-flag" title="Bài này không cộng rating và sẽ quay lại sau 3 ngày">đã xem lời giải</span>}
          </div>
        )}
        {confirmReveal && (
          <div class="mentor-confirm" role="alertdialog">
            <span>Xem lời giải mẫu? Bài này sẽ <b>không cộng rating</b> và quay lại sau 3 ngày để bạn tự cài lại từ trang trắng.</span>
            <button class="primary small" onClick={hint}>Xem</button>
            <button class="linkish" onClick={() => setConfirmReveal(false)}>Thôi</button>
          </div>
        )}
      </div>
    </section>
  );
}

export function MentorCardBody({ body }: { body: MentorCardBody }) {
  if (body.type === "verdict") {
    const v = body.verdict;
    return (
      <div class="mentor-card">
        {v.missing && <div class="card-status">Kernel thiếu thư viện: {v.missing.join(", ")}. Cài vào Python của kernel rồi khởi động lại kernel.</div>}
        {v.error && <div class="card-status mentor-error">{v.error}</div>}
        {v.metrics && v.metrics.length > 0 && (
          <div class="mentor-metrics">
            {v.metrics.map((m) => <span key={m.name}>{m.name} = <b>{Number(m.value.toPrecision(4))}</b></span>)}
          </div>
        )}
        {v.tests.length > 0 && (
          <ul class="mentor-tests">
            {v.tests.map((t) => (
              <li key={t.name} class={t.ok ? "ok" : "fail"}>
                <span class="mentor-test-mark" aria-label={t.ok ? "đạt" : "trượt"}>{t.ok ? "✓" : "✗"}</span>
                <span class="mentor-test-name">{t.name}</span>
                {t.message && <div class="mentor-test-msg">{t.message}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const r = body.result;
  return (
    <div class="mentor-card">
      <div class="mentor-result-score">
        <span>Điểm bài</span>
        <span class="mentor-meter" aria-hidden="true"><i style={{ width: `${Math.round(r.score * 100)}%` }} /></span>
        <b>{Math.round(r.score * 100)}</b>
      </div>
      <ul class="mentor-deltas">
        {r.deltas.map((d) => {
          const diff = d.after - d.before;
          const rank = mentorRank(d.after);
          return (
            <li key={d.skill}>
              <span>{MENTOR_SKILL_LABEL[d.skill]}</span>
              <span class={`rank-${rank.tone}`} title={rank.name}>{d.before} → <b>{d.after}</b></span>
              <span class={diff >= 0 ? "up" : "down"}>{diff >= 0 ? `+${diff}` : diff}</span>
            </li>
          );
        })}
      </ul>
      <div class="card-status">
        Chuỗi ngày học: {body.streak} ngày
        {r.nextReview === null ? " · bài này đã thuộc, không cần ôn nữa" : r.nextReview ? ` · ôn lại sau ${r.nextReview} ngày` : r.revealed ? " · bài sẽ quay lại sau 3 ngày" : ""}
      </div>
    </div>
  );
}

const WORKSHOP_STEPS: { id: MentorWorkshop["status"]; label: string; hint: string }[] = [
  { id: "reading", label: "Đọc paper", hint: "Trả lời hai câu hỏi của mentor: bạn muốn gì ở paper này, và dành bao nhiêu buổi" },
  { id: "planning", label: "Kế hoạch", hint: "Đọc kế hoạch, mặc cả trong chat, rồi bấm Duyệt kế hoạch" },
  { id: "authoring", label: "Soạn bài", hint: "Mentor đang soạn và kiểm chứng từng bài trên máy của notebook này" },
  { id: "ready", label: "Sẵn sàng", hint: "Các bài đã lên tủ paper: làm từ trang Mentor, ở một notebook khác" },
];

/** A paper's workshop chat: the plan, its approval, and the exercises being written. */
export function WorkshopBar({ workshop: w, busy, onApprove, onAuthor, onStop, onHome }: {
  workshop: MentorWorkshop;
  busy: boolean;
  onApprove: () => void;
  onAuthor: () => void;
  onStop: () => void;
  onHome: () => void;
}) {
  const [showPlan, setShowPlan] = useState(true);
  const at = WORKSHOP_STEPS.findIndex((s) => s.id === w.status);
  const a = w.authoring;
  const plan = w.plan;
  const left = a ? a.total - a.done - a.failed : 0;
  return (
    <section class="mentor-bar" aria-label="Xưởng paper">
      <div class="mentor-bar-body chat-width">
        <div class="mentor-head">
          <span class="mentor-mark" aria-hidden="true">📜</span>
          <span class="mentor-title" title={w.title}>Xưởng: {w.title}</span>
          <button class="linkish mentor-home-link" onClick={onHome} title="Mở trang Mentor (tủ paper)">Trang Mentor</button>
        </div>
        <ol class="mentor-steps">
          {WORKSHOP_STEPS.map((s, i) => (
            <li key={s.id} class={i < at ? "done" : i === at ? "current" : ""} title={s.hint}>
              <span class="mentor-step-dot" aria-hidden="true">{i < at ? "✓" : i + 1}</span>
              <span>{s.label}</span>
              {s.id === "authoring" && a && <span class="mentor-step-count">{a.done}/{a.total}</span>}
            </li>
          ))}
        </ol>
        <div class="mentor-now">
          {a?.running ? `Đang soạn: ${a.current ?? "…"}${a.note ? ` (${a.note})` : ""}` : WORKSHOP_STEPS[Math.max(0, at)]!.hint}
          {a && a.failed > 0 && !a.running && ` · ${a.failed} bài chưa soạn được`}
        </div>
        {plan && (
          <div class="mentor-plan">
            <button class="linkish" aria-expanded={showPlan} onClick={() => setShowPlan(!showPlan)}>{showPlan ? "▾" : "▸"} Kế hoạch reproduce ({plan.components.length} thành phần{plan.sessions ? `, ${plan.sessions} buổi` : ""})</button>
            {showPlan && (
              <div class="mentor-plan-body">
                <div><b>Mục tiêu:</b> {plan.goal}</div>
                {plan.requires.length > 0 && <div class="muted small">Nên vững trước: {plan.requires.join(", ")}</div>}
                <table class="mentor-plan-table">
                  <thead><tr><th>#</th><th>Thành phần</th><th>Loại</th><th>Trích</th><th>~phút</th><th>Độ khó</th></tr></thead>
                  <tbody>
                    {plan.components.map((c, i) => (
                      <tr key={c.slug} title={c.why}>
                        <td>{i + 1}</td>
                        <td>{c.title}</td>
                        <td>{c.mode === "given" ? "cho sẵn" : c.role === "experiment" ? "thí nghiệm" : c.role === "formula" ? "công thức" : "tự dựng"}</td>
                        <td>{c.cites}</td>
                        <td>{c.mode === "given" ? "—" : c.minutes}</td>
                        <td>{c.mode === "given" ? "—" : c.difficulty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div class="muted small">
                  Con số để so: {plan.experiment.metrics.map((m) => `${m.name}: paper ${m.paper} (${m.where}), bản thu nhỏ ${m.target.op} ${m.target.value}`).join("; ")}
                </div>
                <div class="muted small">
                  Máy: {plan.experiment.device === "gpu" ? "GPU" : "CPU"} · train ≈ {plan.experiment.trainMinutes} phút · dữ liệu: {plan.experiment.dataset}
                  {plan.machine && ` · notebook ${plan.machine.gpu ? "có" : "không có"} GPU, ${plan.machine.internet ? "có" : "không có"} Internet`}
                </div>
              </div>
            )}
          </div>
        )}
        <div class="mentor-actions">
          {plan && !w.approved && <button class="primary small" disabled={busy} onClick={onApprove} title="Mentor sẽ soạn bài theo kế hoạch này (chạy nền 15–30 phút)">Duyệt kế hoạch</button>}
          {w.approved && !a?.running && (left > 0 || (a?.failed ?? 0) > 0) && (
            <button class="secondary small" disabled={busy} onClick={onAuthor}>{left > 0 ? "Soạn tiếp" : "Soạn lại phần hỏng"}</button>
          )}
          {a?.running && <button class="secondary small" onClick={onStop}>Dừng soạn</button>}
        </div>
      </div>
    </section>
  );
}
