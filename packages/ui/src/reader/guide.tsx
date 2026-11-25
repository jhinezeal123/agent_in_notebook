// The passes of a paper in its reading tab (docs/easy-read.md D.2–D.4):
// the bar of the four passes, choosing a goal, pass 1 (guess first, a guided
// skim, the reader's 5C graded by the tutor, background, notation), pass 2
// (per unit: the question to read it for, figures read, results guessed, the
// checkpoint — recall with the unit hidden, explain a key line, questions with
// how sure — a QALMRI sheet, the pass summary), the notation and the
// misconception book. Everything the reader does goes to the bridge, which
// answers with the guide as it now is.

import { useEffect, useMemo, useState } from "preact/hooks";
import {
  READER_FIGURE_QUESTIONS,
  READER_FIVE_C,
  READER_GOALS,
  READER_PASS_LABEL,
  READER_QALMRI,
  READER_ROLE_LABEL,
  readerLastPass,
  type ReaderAgentMode,
  type ReaderAnchor,
  type ReaderChoice,
  type ReaderGuide,
  type ReaderPass,
  type ReaderRole,
  type ReaderUnitView,
  type ReaderView,
  type ReaderWriteKind,
} from "@ainb/protocol";
import { Cite, Fold, GradeBadge, Md, WriteBox } from "./bits.js";
import { ItemCard, PretestCard } from "./quiz.js";
import { LaterPass } from "./deep.js";
import { Related } from "./related.js";

/** What the panel asks of the tab. */
export interface GuideActions {
  act<T = unknown>(method: string, params?: unknown): Promise<T>;
  cite(anchor: ReaderAnchor): void;
  scrollTo(section: string): void;
  say(text: string): void;
  /** Hide sections while the reader recalls them; null shows them again. */
  cover(sections: string[] | null): void;
  ask(text: string): void;
}

export const ROLES: ReaderRole[] = ["objective", "contribution", "method", "result", "limitation"];

const FIVE_C_LABELS = Object.fromEntries(READER_FIVE_C.map((c) => [c.key, c.label]));
const QALMRI_LABELS = Object.fromEntries(READER_QALMRI.map((c) => [c.key, c.label]));

/** ① Định hướng ✓ ② Hiểu ◐ 1/3 ③ ○ ④ ○ — and the goal. */
export function PassBar({ guide, onOpen }: { guide: ReaderGuide; onOpen: () => void }) {
  const last = readerLastPass(guide.goal);
  const units = guide.units.filter((u) => !u.light || u.items.length);
  const done = guide.units.filter((u) => u.done).length;
  return (
    <button class="er-passbar" onClick={onOpen} title="Các lượt đọc">
      {!guide.goal
        ? <span class="er-pass now">Chọn mục tiêu đọc</span>
        : ([1, 2, 3, 4] as ReaderPass[]).filter((p) => p <= last).map((p) => {
            const passed = guide.passed.includes(p);
            const now = guide.pass === p && !passed;
            return (
              <span key={p} class={`er-pass${passed ? " done" : now ? " now" : ""}`}>
                {"①②③④"[p - 1]} {READER_PASS_LABEL[p]}{passed ? " ✓" : now && p === 2 && units.length ? ` ${done}/${guide.units.length}` : ""}
              </span>
            );
          })}
      {guide.goal && <span class="er-muted"> · {READER_GOALS.find((g) => g.id === guide.goal)?.label}</span>}
    </button>
  );
}

const MODES: { value: ReaderAgentMode; label: string; hint: string }[] = [
  { value: "ask", label: "Hỏi trước", hint: "Mỗi việc chờ bạn bấm Soạn" },
  { value: "auto", label: "Tự động", hint: "Người soạn tự chuẩn bị trước một bước" },
  { value: "off", label: "Tắt", hint: "Không agent nền nào chạy" },
];
/** "Soạn tất cả" above this many agent turns asks once more. */
const CONFIRM_TURNS = 10;

/** Agent turns the hidden chats spent on this paper, always in the tab's header, for the reader to keep an eye on the bill. */
export function AgentTurns({ guide }: { guide: ReaderGuide }) {
  const t = guide.agentTurns ?? { author: 0, checker: 0, peer: 0 };
  const total = t.author + t.checker + t.peer;
  return (
    <span class="er-turns" title={`Lượt agent nền đã chạy cho paper này: soạn ${t.author} · kiểm ${t.checker} · đồng nghiệp lề ${t.peer}. Mỗi lượt là một yêu cầu tính phí theo nhà cung cấp của agent; không tính lượt chat với gia sư.`}>
      Agent nền: {total} lượt
    </span>
  );
}

/**
 * The background agents of this paper, always in view above it: when they
 * may run (the mode, for every paper), a lock for this paper (stops what runs
 * now; nothing runs until unlocked), what runs now, and the work waiting for
 * the reader's Soạn, folded into one line with the agent turns it may take.
 * A unit's checkpoint is started from its card in pass 2; here it is counted.
 */
export function AuthorLine({ guide, act }: { guide: ReaderGuide; act: GuideActions["act"] }) {
  const a = guide.author;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const proposals = a.proposals ?? [];
  const units = proposals.filter((p) => p.key.startsWith("unit:"));
  const others = proposals.filter((p) => !p.key.startsWith("unit:"));
  const total = proposals.reduce((n, p) => n + p.maxTurns, 0);
  const mode = a.mode ?? "ask";
  const blocked = a.locked ? "Paper đang khóa agent: bỏ khóa để soạn." : mode === "off" ? "Agent nền đang tắt: chọn Hỏi trước hoặc Tự động để soạn." : undefined;
  useEffect(() => setConfirming(false), [proposals.length, a.locked]);
  const run = (task: string) => {
    setConfirming(false);
    void act("reader.author", { action: "run", task }).catch(() => {});
  };
  const runAll = () => (total > CONFIRM_TURNS && !confirming ? setConfirming(true) : run("all"));
  const setMode = (value: string) => void act("reader.settings", { agentMode: value }).then(() => act("reader.guide")).catch(() => {});
  return (
    <div class={`er-notice er-authorbar${a.state === "running" ? " author" : ""}`}>
      <div class="er-row small">
        <b>Agent nền</b>
        <label title={MODES.find((m) => m.value === mode)?.hint}>
          Chạy:{" "}
          <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)} aria-label="Khi nào agent nền được chạy (mọi paper)">
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label class="er-toggle" title="Dừng ngay việc đang chạy; không agent nền nào chạy cho paper này (kể cả khi bấm Soạn hay khi khởi động lại) cho tới khi bỏ khóa.">
          <input type="checkbox" checked={!!a.locked} onChange={() => void act("reader.author", { action: a.locked ? "unlock" : "stop" }).catch(() => {})} /> Khóa agent cho paper này
        </label>
        {a.state === "running" && <span>· Người soạn đang chuẩn bị: <b>{a.task}</b>{a.note ? ` (${a.note})` : ""}{a.queued ? ` · còn ${a.queued} việc` : ""}…</span>}
        {a.state === "failed" && (
          <span>· Chưa làm xong: {a.error ?? ""} <button class="er-link" disabled={!!blocked} title={blocked} onClick={() => void act("reader.author", { action: "retry" }).catch(() => {})}>Soạn lại</button></span>
        )}
        {proposals.length > 0 && (
          <button class="er-link" aria-expanded={open} onClick={() => setOpen(!open)}>
            · {proposals.length} việc chờ duyệt · tối đa {total} lượt agent {open ? "▾" : "▸"}
          </button>
        )}
      </div>
      {open && proposals.length > 0 && (
        <div class="er-proposals">
          {blocked && <p class="er-muted small">{blocked}</p>}
          {others.map((p) => (
            <div key={p.key} class="er-row small">
              <span>{p.label} <span class="er-muted">· tối đa {p.maxTurns} lượt agent</span></span>
              <button class="er-btn" disabled={!!blocked} title={blocked} onClick={() => run(p.key)}>Soạn</button>
            </div>
          ))}
          {units.length > 0 && (
            <div class="er-row small">
              <span>{units.map((u) => u.label).join(", ")} <span class="er-muted">· tối đa {units.reduce((n, u) => n + u.maxTurns, 0)} lượt agent · soạn từ thẻ của từng mục ở lượt 2</span></span>
            </div>
          )}
          {proposals.length > 1 && (confirming
            ? (
              <div class="er-row small">
                <span>Soạn {proposals.length} việc, tối đa <b>{total}</b> lượt agent?</span>
                <button class="er-btn primary" onClick={() => run("all")}>Xác nhận</button>
                <button class="er-link" onClick={() => setConfirming(false)}>Hủy</button>
              </div>
            )
            : <button class="er-link small" disabled={!!blocked} title={blocked} onClick={runAll}>Soạn tất cả ({total} lượt tối đa)</button>)}
        </div>
      )}
    </div>
  );
}

type Tab = "pass" | "notation" | "misses" | "related";

export function GuidePanel({ guide, view, current, actions, skim, quizRequest, onQuizHandled }: {
  guide: ReaderGuide;
  view: ReaderView;
  current?: string;
  actions: GuideActions;
  quizRequest?: number;
  onQuizHandled?: () => void;
  skim: { on: boolean; roles: boolean; set(next: { on?: boolean; roles?: boolean }): void };
}) {
  const [tab, setTab] = useState<Tab>("pass");
  const [quiz, setQuiz] = useState<string | null>(null);
  const next = guide.units.flatMap((u) => u.items).find((i) => i.id === quiz);
  function askQuestion() {
    setTab("pass");
    if (guide.nextQuestion) setQuiz(guide.nextQuestion);
    else actions.ask("Hỏi mình một câu ngắn để nhớ lại phần vừa đọc, dẫn đúng mốc và đợi mình trả lời.");
  }
  useEffect(() => {
    if (!quizRequest) return;
    askQuestion();
    onQuizHandled?.();
  }, [quizRequest]);
  return (
    <aside class="er-guide" aria-label="Các lượt đọc">
      <div class="er-tabs" role="tablist">
        <button role="tab" class={tab === "pass" ? "on" : ""} onClick={() => setTab("pass")}>{guide.goal ? `Lượt ${guide.pass}` : "Bắt đầu"}</button>
        <button role="tab" class={tab === "notation" ? "on" : ""} onClick={() => setTab("notation")}>Ký hiệu</button>
        <button role="tab" class={tab === "misses" ? "on" : ""} onClick={() => setTab("misses")}>Sổ lỗi sai{guide.misses.length ? ` (${guide.misses.length})` : ""}</button>
        <button role="tab" class={tab === "related" ? "on" : ""} onClick={() => setTab("related")}>Bối cảnh</button>
      </div>
      <div class="er-guide-body">
        {guide.goal && <div class="er-row">
          <button class="er-btn" onClick={askQuestion}>Hỏi tôi một câu</button>
        </div>}
        {guide.widgetRequests?.map((r) => <div key={r.id} class="er-step">
          <p><Cite anchor={r.anchor} sections={view.sections} onCite={actions.cite} /> <Md text={r.goal} onCite={actions.cite} class="er-inline" /></p>
          {(r.offered || guide.author.state !== "running") && <button class="er-btn" onClick={() => void actions.act("reader.widget.request", r).catch(() => {})}>
            {r.offered ? "Tạo ví dụ gia sư đề xuất" : "Tiếp tục soạn ví dụ"}
          </button>}
        </div>)}
        {next && <Fold key={next.id} title="Ôn một câu" open>
          <ItemCard key={next.id} item={next} n={1} retry={!!next.result} sections={view.sections} onCite={actions.cite}
            onAnswer={(choice, confidence) => actions.act("reader.answer", { item: next.id, choice, confidence })}
            onSkip={() => void actions.act("reader.skip", { task: `item:${next.id}` }).then(() => setQuiz(null), () => {})}
            onReport={(reason) => void actions.act("reader.report", { item: next.id, reason }).then(() => setQuiz(null), () => {})} />
          <button class="er-link" onClick={() => setQuiz(null)}>Đóng câu hỏi</button>
        </Fold>}
        {tab === "pass" && (!guide.goal
          ? <GoalChooser actions={actions} />
          : guide.pass === 1 ? <Pass1 guide={guide} view={view} actions={actions} skim={skim} />
            : guide.pass === 2 ? <Pass2 guide={guide} view={view} current={current} actions={actions} />
              : <LaterPass key={guide.pass} guide={guide} view={view} actions={actions} />)}
        {tab === "notation" && <Notation guide={guide} view={view} actions={actions} />}
        {tab === "misses" && <Misses guide={guide} actions={actions} />}
        {tab === "related" && <Related actions={actions} />}
      </div>
    </aside>
  );
}

function GoalChooser({ actions }: { actions: GuideActions }) {
  return (
    <div class="er-goals">
      <p><b>Bạn đọc paper này để làm gì?</b></p>
      <p class="er-muted small">Mục tiêu quyết định đọc mấy lượt. Sau khi chọn, người soạn (agent nền) có thể làm bản đồ paper: vai trò từng đoạn, ký hiệu, khái niệm, kiến thức nền, câu đoán trước. Mặc định nó chờ bạn bấm Soạn ở thanh phía trên.</p>
      {READER_GOALS.map((g) => (
        <button key={g.id} class="er-goal" onClick={() => void actions.act("reader.goal", { goal: g.id })}>
          <b>{g.label}</b>
          <span class="er-muted small">{g.detail}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ pass 1

function Pass1({ guide, view, actions, skim }: { guide: ReaderGuide; view: ReaderView; actions: GuideActions; skim: { on: boolean; roles: boolean; set(next: { on?: boolean; roles?: boolean }): void } }) {
  const { map } = guide;
  const mapProposed = guide.author.proposals?.some((p) => p.key === "map");
  const writing = (part: keyof ReaderGuide["map"]["has"]) => !map.has[part] && <p class="er-muted small">{guide.author.state === "running" ? "Người soạn đang viết phần này…" : mapProposed ? "Chưa có: bấm Soạn “Bản đồ paper” ở thanh phía trên." : "Chưa có (người soạn chưa viết)."}</p>;
  const pretestOpen = map.pretest.filter((p) => !p.guess && !p.answer).length;
  const fivecDone = !!guide.fivec || guide.skipped.includes("5c");
  const gist = guide.goal === "gist";
  return (
    <div class="er-pass1">
      <p class="er-muted small">Lượt 1 (10–15 phút): biết paper nói gì và có đáng đọc kỹ không, chưa cần hiểu từng chi tiết.</p>
      <Fold title="① Đoán trước" open={pretestOpen > 0} badge={map.pretest.length ? <span class="er-count">{map.pretest.length - pretestOpen}/{map.pretest.length}</span> : null}>
        <p class="er-muted small">Đoán trước khi đọc (không tính điểm): sai vẫn có ích, miễn là sau đó bạn thấy đáp án. Mỗi câu tự mở đáp án khi bạn đọc xong mục chứa nó.</p>
        {writing("pretest")}
        {map.pretest.map((p, i) => (
          <PretestCard key={p.id} item={p} n={i + 1} sections={view.sections} onCite={actions.cite}
            onGuess={(g) => actions.act("reader.answer", { item: p.id, pretest: true, choice: g.option !== undefined ? { options: [g.option] } : { text: g.text } })}
            onSkip={() => void actions.act("reader.skip", { task: `pretest:${p.id}` })} />
        ))}
      </Fold>
      <Fold title="② Lướt có dẫn đường" open>
        <p class="er-muted small">Đọc tiêu đề, abstract, phần mở đầu, tiêu đề các mục, hình và bảng chính, kết luận; lướt danh sách tham khảo. Phần còn lại để lượt sau.</p>
        {view.view === "html" ? (
          <div class="er-row">
            <label class="er-toggle"><input type="checkbox" checked={skim.on} onChange={() => skim.set({ on: !skim.on })} /> Làm mờ phần chưa cần</label>
            <label class="er-toggle"><input type="checkbox" checked={skim.roles} onChange={() => skim.set({ roles: !skim.roles })} /> Tô vai trò đoạn</label>
          </div>
        ) : <p class="er-muted small">Với PDF, tab không làm mờ được từng đoạn: dùng danh sách vai trò bên dưới.</p>}
        {writing("roles")}
        {map.roles.length > 0 && (
          <div class="er-roles">
            {ROLES.filter((r) => map.roles.some((x) => x.role === r)).map((r) => (
              <div key={r} class="er-role-row">
                <span class={`er-role-dot role-${r}`} />
                <b>{READER_ROLE_LABEL[r]}</b>
                {map.roles.filter((x) => x.role === r).map((x) => <Cite key={x.anchor} anchor={{ id: x.anchor }} sections={view.sections} onCite={actions.cite} />)}
              </div>
            ))}
          </div>
        )}
      </Fold>
      <Fold title="③ Tự viết 5C" open={!fivecDone} badge={guide.fivec ? <GradeBadge grade={guide.fivec.grade} /> : null}>
        <p class="er-muted small">Mỗi ô 1–2 câu, bằng lời của bạn. Gia sư chấm từng ô so với bản tham chiếu, chỉ chỗ lệch kèm mốc trong paper, rồi mới cho xem bản tham chiếu.</p>
        <WriteBox fields={READER_FIVE_C} labels={FIVE_C_LABELS} write={guide.fivec} skipped={guide.skipped.includes("5c")} onCite={actions.cite}
          onSubmit={(input) => write(actions, "5c", input)} onSkip={() => void actions.act("reader.skip", { task: "5c" })} />
        {map.fivec && (
          <div class="er-reference">
            <div class="er-sub">Bản tham chiếu</div>
            {READER_FIVE_C.map((c) => map.fivec?.[c.key] && <div key={c.key} class="er-ref-row"><b>{c.label}:</b> <Md text={map.fivec[c.key]!} onCite={actions.cite} class="er-inline" /></div>)}
          </div>
        )}
      </Fold>
      <Fold title="④ Kiến thức nền" badge={map.background.length ? <span class="er-count">{map.background.length}</span> : null}>
        {writing("background")}
        {map.has.background && !map.background.length && <p class="er-muted small">Người soạn thấy paper này không đòi kiến thức nền gì đặc biệt.</p>}
        {map.background.map((b) => (
          <div key={b.name} class="er-bg">
            <b><Md text={b.name} onCite={actions.cite} class="er-inline" /></b> <span class="er-muted small">— <Md text={b.why} onCite={actions.cite} class="er-inline" /></span>
            <Md text={b.explain} onCite={actions.cite} />
            {b.link && <button class="er-link small" onClick={() => void actions.act("link.open", { url: b.link })}>Đọc bản dễ hơn ↗</button>}
          </div>
        ))}
      </Fold>
      <Fold title="⑤ Ký hiệu và thuật ngữ" badge={map.notation.length ? <span class="er-count">{map.notation.length}</span> : null}>
        <p class="er-muted small">Làm quen tên gọi trước (3 phút) giúp lượt sau đỡ quá tải. Bảng đầy đủ ở thẻ Ký hiệu.</p>
        <NotationTable guide={guide} view={view} actions={actions} />
      </Fold>
      <div class="er-pass-end">
        <p class="small">{fivecDone ? "Xong lượt 1: đọc tiếp, hay dừng ở đây?" : "Viết 5C trước khi qua lượt 2 (hoặc bấm “Cho xem luôn”)."}</p>
        <div class="er-row">
          {!gist || guide.passed.includes(1)
            ? <button class="er-btn primary" disabled={!fivecDone} onClick={() => void actions.act("reader.pass", { pass: 2 })}>Sang lượt 2: Hiểu</button>
            : <button class="er-btn primary" disabled={!fivecDone} onClick={() => void actions.act("reader.pass", { pass: 1, done: true }).then(() => actions.say("Xong lượt 1. Muốn đọc kỹ hơn thì chọn “Đọc tiếp lượt 2”."))}>Xong, dừng ở đây</button>}
          {gist && <button class="er-btn" disabled={!fivecDone} onClick={() => void actions.act("reader.goal", { goal: "use" }).then(() => actions.act("reader.pass", { pass: 2 }))}>Đọc tiếp lượt 2</button>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pass 2

function Pass2({ guide, view, current, actions }: { guide: ReaderGuide; view: ReaderView; current?: string; actions: GuideActions }) {
  const here = guide.units.find((u) => current && u.sections.includes(current));
  const [picked, setPicked] = useState<string | null>(null);
  const unit = guide.units.find((u) => u.id === picked) ?? here ?? guide.units.find((u) => !u.done) ?? guide.units[0];
  const allDone = guide.units.length > 0 && guide.units.every((u) => u.done);
  const questions = view.notes.filter((n) => n.kind === "question" && !n.done);
  return (
    <div class="er-pass2">
      {!guide.units.length && <p class="er-muted small">{guide.map.has.units ? "Paper không có mục nào để đọc kỹ." : "Người soạn đang chia paper (PDF) thành các mục…"}</p>}
      <div class="er-units">
        {guide.units.map((u) => (
          <button key={u.id} class={`er-unit${u.id === unit?.id ? " on" : ""}`} onClick={() => { setPicked(u.id); actions.scrollTo(u.id); }} title={u.title}>
            <span class={`er-unit-dot${u.done ? " done" : u.read ? " read" : ""}`}>{u.done ? "●" : u.read ? "◐" : "○"}</span>
            <span class="er-unit-title">{u.number ? `${u.number} ` : ""}{u.title}</span>
            <span class="er-muted small">{u.state === "preparing" ? "đang soạn…" : u.state === "failed" ? "lỗi" : u.items.length ? `${u.score.answered}/${u.items.length}` : ""}</span>
          </button>
        ))}
      </div>
      {unit && <UnitCard key={unit.id} unit={unit} guide={guide} view={view} actions={actions} />}
      {guide.score.answered > 0 && (
        <div class="er-score small">
          Điểm: <b>{guide.score.points}</b> / {guide.score.max} · đúng ngay lần đầu {guide.score.firstRight}/{guide.score.answered}
          {guide.score.sureWrong > 0 && <> · <span class="er-bad">chắc mà sai {guide.score.sureWrong}</span></>}
          {guide.score.luckyRight > 0 && <> · đoán mà đúng {guide.score.luckyRight}</>}
        </div>
      )}
      <Fold title="Cuối lượt 2" open={allDone} badge={guide.summary ? <GradeBadge grade={guide.summary.grade} /> : null}>
        <p class="er-muted small">Xong lượt 2 khi bạn tóm được ý chính của paper kèm chứng cứ cho người khác (≤ 250 chữ, không chép lại abstract): vấn đề và vì sao cách cũ chưa đủ · lời giải và vì sao tốt hơn · bằng chứng · đóng góp · bạn còn thắc mắc gì.</p>
        <WriteBox write={guide.summary} skipped={guide.skipped.includes("summary")} rows={8} placeholder="Tóm tắt của bạn…" onCite={actions.cite}
          onSubmit={(input) => write(actions, "summary", input)} onSkip={() => void actions.act("reader.skip", { task: "summary" })} />
        {questions.length > 0 && (
          <div class="er-row">
            <button class="er-btn" onClick={() => actions.ask(`Cùng mình đi qua ${questions.length} câu hỏi mình ghi lại khi đọc (“Câu hỏi của tôi”): câu nào paper trả lời được thì giải đáp có mốc, câu nào paper không nói thì nói rõ.`)}>
              Đi qua “Câu hỏi của tôi” với gia sư ({questions.length})
            </button>
          </div>
        )}
        <div class="er-row">
          {guide.passed.includes(2) ? <button class="er-btn primary" onClick={() => void actions.act("reader.pass", { pass: 3 }).catch(() => {})}>
            {guide.goal === "use" ? "Xem giả định và hạn chế" : "Sang lượt 3 · Đào sâu"}
          </button> : <button class="er-btn primary" disabled={!guide.summary && !guide.skipped.includes("summary")} onClick={() => void actions.act("reader.pass", { pass: 2, done: true }).catch(() => {})}>Xong lượt 2</button>}
        </div>
      </Fold>
    </div>
  );
}

function UnitCard({ unit, guide, view, actions }: { unit: ReaderUnitView; guide: ReaderGuide; view: ReaderView; actions: GuideActions }) {
  const [recalling, setRecalling] = useState(false);
  const [retry, setRetry] = useState(false);
  const [figure, setFigure] = useState<string | null>(null);
  const again = unit.items.filter((i) => i.again);
  const skip = (step: string) => void actions.act("reader.skip", { task: `${unit.id}:${step}` });
  const label = unit.number ? `§${unit.number}` : unit.title;

  if (unit.state !== "ready") {
    return (
      <div class="er-unitcard">
        <h4>{label} {unit.title}</h4>
        {unit.state === "preparing" && <p class="er-muted small">Người soạn đang đọc mục này và viết câu dẫn, checkpoint…</p>}
        {unit.state === "waiting" && <p class="er-muted small">Checkpoint của mục này được đề xuất soạn khi bạn đọc tới mục trước nó (soạn trước một bước, không soạn cả paper một lúc).</p>}
        {(unit.state === "waiting" || unit.state === "proposed") && guide.author.mode !== "off" && !guide.author.locked && (
          <div class="er-row">
            <button class="er-btn" onClick={() => void actions.act("reader.author", { action: "run", task: `unit:${unit.id}` }).catch(() => {})}>Soạn checkpoint mục này</button>
            {guide.author.proposals?.find((p) => p.key === `unit:${unit.id}`) && <span class="er-muted small">tối đa {guide.author.proposals.find((p) => p.key === `unit:${unit.id}`)!.maxTurns} lượt agent</span>}
          </div>
        )}
        {(unit.state === "waiting" || unit.state === "proposed") && guide.author.locked && <p class="er-muted small">Paper đang khóa agent: bỏ khóa trên thanh Agent nền để soạn checkpoint này.</p>}
        {unit.state === "failed" && (
          <p class="small">Người soạn chưa soạn được: {unit.error} <button class="er-link" onClick={() => void actions.act("reader.author", { action: "retry" })}>Soạn lại</button></p>
        )}
      </div>
    );
  }

  const startRecall = () => {
    setRecalling(true);
    actions.cover(unit.sections);
  };
  const endRecall = () => {
    setRecalling(false);
    actions.cover(null);
  };

  return (
    <div class="er-unitcard">
      <h4>{label} {unit.title}</h4>
      {unit.guide && <div class="er-guideq"><span class="er-sub">Đọc để trả lời</span><Md text={unit.guide} onCite={actions.cite} /></div>}
      {!unit.read && <p class="er-muted small">Đọc mục này trước (chấm ○ thành ◐ khi đủ thời gian, hoặc bấm chấm trong mục lục); checkpoint ở cuối.</p>}

      {unit.figures.length > 0 && (
        <Fold title="Đọc hình" badge={<span class="er-count">{unit.figures.filter((f) => f.message).length}/{unit.figures.length}</span>}>
          {unit.figures.map((f) => (
            <div key={f.id} class="er-figure">
              <div class="er-row">
                <Cite anchor={{ id: f.id }} sections={view.sections} onCite={actions.cite} />
                <button class="er-link small" onClick={() => setFigure(figure === f.id ? null : f.id)}>{figure === f.id ? "Thu lại" : f.message ? "Xem lại" : "Đọc hình này"}</button>
              </div>
              {figure === f.id && (
                <>
                  <ol class="er-questions small">{[...READER_FIGURE_QUESTIONS, ...f.questions].map((q) => <li key={q}><Md text={q} onCite={actions.cite} class="er-inline" /></li>)}</ol>
                  {!f.message && (
                    <WriteBox rows={2} placeholder="Thông điệp chính của hình, trong một câu…" busyLabel="Lưu" onCite={actions.cite}
                      onSubmit={(input) => write(actions, "figure", { ...input, key: f.id })} onSkip={() => void actions.act("reader.skip", { task: `fig:${f.id}` })} />
                  )}
                </>
              )}
              {f.message && <div class="er-reference small"><b>Thông điệp (tham chiếu):</b> <Md text={f.message} onCite={actions.cite} class="er-inline" /></div>}
            </div>
          ))}
        </Fold>
      )}

      {unit.predicts.length > 0 && (
        <Fold title="Đoán trước kết quả" open={unit.predicts.some((p) => !p.answer)} badge={<span class="er-count">{unit.predicts.filter((p) => p.answer).length}/{unit.predicts.length}</span>}>
          <p class="er-muted small">Số liệu trong bảng đang bị che. Đoán xu hướng trước, rồi mở ra so.</p>
          {unit.predicts.map((p) => (
            <div key={p.id} class="er-figure">
              <div class="er-row"><Cite anchor={{ id: p.id }} sections={view.sections} onCite={actions.cite} /> <Md text={p.question} class="er-inline" /></div>
              {p.answer
                ? <div class="er-reference small"><b>Kết quả:</b> <Md text={p.answer} onCite={actions.cite} class="er-inline" /></div>
                : <WriteBox rows={2} placeholder="Bạn đoán…" busyLabel="Đoán rồi mở bảng" onCite={actions.cite}
                    onSubmit={(input) => write(actions, "predict", { ...input, key: p.id })} onSkip={() => void actions.act("reader.skip", { task: `predict:${p.id}` })} />}
            </div>
          ))}
        </Fold>
      )}

      <Fold title={`Checkpoint cuối ${label}`} open={unit.read && !unit.done} badge={unit.done ? <span class="er-count ok">xong</span> : null}>
        <div class="er-step">
          <div class="er-sub">1 · Nhớ lại khi gập mục</div>
          {!unit.recall && !unit.skipped.includes("recall") && !recalling && (
            <div class="er-row">
              <button class="er-btn" onClick={startRecall}>Gập mục và viết</button>
              <button class="er-link small" onClick={() => skip("recall")}>Cho xem luôn</button>
            </div>
          )}
          {(recalling || unit.recall || unit.skipped.includes("recall")) && (
            <WriteBox rows={4} write={unit.recall} skipped={unit.skipped.includes("recall")} onCite={actions.cite}
              hint={recalling ? "Mục đang bị che. Viết 2–3 câu: mục này nói gì, chứng cứ là gì. Tự nhớ ra (không nhìn) là cách học có bằng chứng mạnh nhất." : undefined}
              placeholder="Mục này nói gì, chứng cứ là gì…"
              onSubmit={async (input) => {
                await write(actions, "recall", { ...input, unit: unit.id });
                endRecall();
              }} />
          )}
          {recalling && <button class="er-link small" onClick={endRecall}>Mở lại mục</button>}
          {unit.points && (
            <div class="er-reference">
              <div class="er-sub">Ý chính (tham chiếu)</div>
              <ul>{unit.points.map((p) => <li key={p.text}><Md text={p.text} onCite={actions.cite} class="er-inline" /> <Cite anchor={{ id: p.anchor }} sections={view.sections} onCite={actions.cite} /></li>)}</ul>
            </div>
          )}
        </div>

        {unit.explain && (
          <div class="er-step">
            <div class="er-sub">2 · Tự giải thích một chỗ then chốt</div>
            <div class="er-row"><Cite anchor={{ id: unit.explain.anchor }} sections={view.sections} onCite={actions.cite} /> <Md text={unit.explain.prompt} class="er-inline" /></div>
            <WriteBox rows={4} write={unit.explained} skipped={unit.skipped.includes("explain")} onCite={actions.cite}
              placeholder="Dòng này làm gì, và vì sao cần nó (không chỉ diễn đạt lại)…"
              onSubmit={(input) => write(actions, "explain", { ...input, unit: unit.id })} onSkip={() => skip("explain")} />
          </div>
        )}

        <div class="er-step">
          <div class="er-sub">{unit.explain ? "3" : "2"} · Câu hỏi</div>
          {unit.light && !unit.items.length && <Md text={unit.light} onCite={actions.cite} class="er-muted small" />}
          {unit.items.map((item, i) => (
            <ItemCard key={item.id} item={item} n={i + 1} retry={retry && !!item.again} sections={view.sections} onCite={actions.cite}
              onAnswer={(choice: ReaderChoice, confidence) => actions.act("reader.answer", { item: item.id, choice, confidence })}
              onSkip={() => void actions.act("reader.skip", { task: `item:${item.id}` })}
              onReport={(reason) => void actions.act("reader.report", { item: item.id, reason }).then(() => actions.say("Đã rút câu này khỏi bộ. Cảm ơn bạn."))} />
          ))}
          {again.length > 0 && !retry && (
            <button class="er-btn" onClick={() => setRetry(true)}>Ôn lại câu sai ({again.length})</button>
          )}
          {unit.items.length > 0 && (
            <div class="er-score small">
              Mục này: <b>{unit.score.points}</b> điểm · đúng ngay lần đầu {unit.score.firstRight}/{unit.score.answered}
              {unit.score.sureWrong > 0 && <> · <span class="er-bad">chắc mà sai {unit.score.sureWrong}</span></>}
              {unit.score.luckyRight > 0 && <> · đoán mà đúng {unit.score.luckyRight}</>}
            </div>
          )}
        </div>

        {unit.qalmri && (
          <div class="er-step">
            <div class="er-sub">{unit.explain ? "4" : "3"} · Phiếu QALMRI (phần thí nghiệm)</div>
            <WriteBox fields={READER_QALMRI} labels={QALMRI_LABELS} write={unit.qalmriWrite} skipped={unit.skipped.includes("qalmri")} onCite={actions.cite}
              onSubmit={(input) => write(actions, "qalmri", { ...input, unit: unit.id })} onSkip={() => skip("qalmri")} />
            {unit.qalmriRef && (
              <div class="er-reference">
                <div class="er-sub">Phiếu tham chiếu</div>
                {READER_QALMRI.map((q) => unit.qalmriRef?.[q.key] && <div key={q.key} class="er-ref-row"><b>{q.label}:</b> <Md text={unit.qalmriRef[q.key]!} onCite={actions.cite} class="er-inline" /></div>)}
              </div>
            )}
          </div>
        )}
      </Fold>
    </div>
  );
}

// ------------------------------------------------------------------ notation, misconceptions

function NotationTable({ guide, view, actions }: { guide: ReaderGuide; view: ReaderView; actions: GuideActions }) {
  if (!guide.map.notation.length) return <p class="er-muted small">{guide.author.state === "running" ? "Người soạn đang viết bảng ký hiệu…" : "Chưa có bảng ký hiệu."}</p>;
  return (
    <table class="er-notation">
      <tbody>
        {guide.map.notation.map((n) => (
          <tr key={n.symbol}>
            <td class="er-sym"><Md text={`$${n.symbol}$`} class="er-inline" /></td>
            <td><Md text={n.meaning} onCite={actions.cite} class="er-inline" />{n.shape && <span class="er-muted"> · <Md text={n.shape} class="er-inline" /></span>}</td>
            <td>{n.anchor && <Cite anchor={{ id: n.anchor }} sections={view.sections} onCite={actions.cite} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Notation({ guide, view, actions }: { guide: ReaderGuide; view: ReaderView; actions: GuideActions }) {
  const weakFirst = useMemo(() => [...guide.map.concepts].sort((a, b) => (a.mastery ?? 2) - (b.mastery ?? 2)), [guide]);
  return (
    <div>
      <div class="er-sub">Ký hiệu và thuật ngữ</div>
      <NotationTable guide={guide} view={view} actions={actions} />
      {weakFirst.length > 0 && (
        <>
          <div class="er-sub">Khái niệm chính</div>
          {weakFirst.map((c) => (
            <div key={c.id} class="er-concept">
              <span class="er-concept-name"><Md text={c.name} class="er-inline" /></span>
              {c.anchor && <Cite anchor={{ id: c.anchor }} sections={view.sections} onCite={actions.cite} />}
              <span class="er-meter" title={c.mastery === undefined ? "Chưa trả lời câu nào" : `Độ vững ${Math.round(c.mastery * 100)} % (${c.answers} lần trả lời)`}>
                <span style={{ width: `${Math.round((c.mastery ?? 0) * 100)}%` }} class={c.mastery === undefined ? "" : c.mastery < 0.6 ? "weak" : "ok"} />
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Misses({ guide, actions }: { guide: ReaderGuide; actions: GuideActions }) {
  if (!guide.misses.length) return <p class="er-muted small">Chưa có hiểu sai nào. Khi bạn trả lời sai mà khá chắc, hoặc gia sư thấy một hiểu sai, nó vào đây (và vào Sổ lỗi sai của Mentor, hỏi lại sau 2 ngày).</p>;
  return (
    <div>
      <p class="er-muted small">Những hiểu sai đã lộ ra khi đọc paper này. Mentor hỏi lại chúng sau 2 ngày.</p>
      {guide.misses.map((m, i) => (
        <div key={i} class="er-miss">
          <b><Md text={m.name} class="er-inline" /></b>
          <Md text={m.note} onCite={actions.cite} />
          <button class="er-link small" onClick={() => actions.ask(`Mình từng hiểu sai về “${m.name}”: ${m.note}. Giải thích lại giúp mình chỗ này, kèm mốc trong paper.`)}>Hỏi gia sư</button>
        </div>
      ))}
    </div>
  );
}

/** A write of the reader's, through the tab's host (it opens the tutor's chat for the kinds it grades). */
async function write(actions: GuideActions, kind: ReaderWriteKind, input: { text?: string; fields?: Record<string, string>; unit?: string; key?: string }): Promise<void> {
  const r = await actions.act<{ graded: boolean }>("write", { kind, ...input });
  if (r?.graded) actions.say("Đã gửi gia sư chấm: xem khung chat bên cạnh.");
}

