// The Mentor parts of the notebook chat: the exercise's steps with the
// Judge and Hint buttons above the transcript, and the verdict and result
// cards inside it.

import { useState } from "preact/hooks";
import { MENTOR_HINT_LABEL, MENTOR_HINT_MAX, MENTOR_SKILL_LABEL, MENTOR_STAGE_LABEL, mentorRank, type MentorCardBody, type MentorChat, type MentorStage } from "@ainb/protocol";

const STEPS: MentorStage[] = ["lab", "build", "defend"];
const VARIANT_HINT = "Viết dự đoán vào cell Dự đoán và gửi mentor, trước khi code";
const REVIEW_HINT = "Cài lại từ trí nhớ, rồi bấm Chấm bài: qua máy chấm là xong buổi ôn";

const STEP_HINT: Record<MentorStage, string> = {
  lab: "Chạy các cell công thức, rồi kể lại công thức bằng lời của bạn",
  build: "Phác thảo, rồi tự code trong cell bài làm và bấm Chấm bài",
  defend: "Trả lời các câu hỏi vặn của mentor",
  done: "Bài đã xong",
};

export function MentorBar({ mentor, busy, onJudge, onHint, onStage, onHome, onCodeReview }: {
  mentor: MentorChat;
  /** The agent is answering, or the judge is running: the buttons wait. */
  busy: boolean;
  onJudge: () => void;
  onHint: () => void;
  onStage: (stage: MentorStage) => void;
  onHome: () => void;
  onCodeReview: () => void;
}) {
  const [confirmReveal, setConfirmReveal] = useState(false);
  const done = mentor.stage === "done";
  const review = mentor.kind === "review";
  const steps: MentorStage[] = review ? ["build"] : STEPS;
  const variant = !!mentor.variantOf;
  const stepLabel = (s: MentorStage) => (review ? "Cài lại từ cell trống" : variant && s === "lab" ? "Dự đoán" : MENTOR_STAGE_LABEL[s]);
  const stepHint = (s: MentorStage) => (review ? REVIEW_HINT : variant && s === "lab" ? VARIANT_HINT : STEP_HINT[s]);
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
