// Mentor's home page: the star map of what the learner has mastered, today's
// exercise, ratings per skill, the streak and its heatmap, and the machine
// check. A night sky of its own, whatever the editor's theme.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MENTOR_SKILL_LABEL, mentorRank, type MentorEnv, type MentorHome, type MentorKind, type MentorMistake, type MentorSkill, type MentorStarView, type MentorToday } from "@ainb/protocol";
import { heatWeeks, layout, MAP_H, MAP_W, ratingShare, type MapStar } from "./constellation.js";

export interface MentorHomeHost {
  request<T>(method: string, params?: unknown): Promise<T>;
  on(listener: (event: { event: string; params?: unknown }) => void): () => void;
}

type Env = MentorEnv & { jupyter?: boolean };

const REASON: Record<MentorToday["reason"], string> = {
  diagnostic: "Chẩn đoán",
  continue: "Làm tiếp",
  redo: "Làm lại từ trang trắng",
  next: "Tiếp theo trên bản đồ",
  review: "Ôn lại",
  variant: "Biến thể",
};

const STATE_LABEL: Record<MentorStarView["state"], string> = {
  locked: "chưa mở",
  open: "đã mở",
  learning: "đang học",
  mastered: "đã vững",
};

export function MentorHomeApp({ host }: { host: MentorHomeHost }) {
  const [home, setHome] = useState<MentorHome | null>(null);
  const [env, setEnv] = useState<Env | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const load = () => host.request<MentorHome>("mentor.home").then((h) => { setHome(h); setError(null); }, (e: Error) => setError(e.message));
  const check = (refresh = false) => host.request<Env>("mentor.env", { refresh }).then(setEnv, () => {});
  useEffect(() => {
    void load();
    void check();
    return host.on((e) => {
      if (e.event === "updated") void load();
      if (e.event === "connected") {
        void load();
        void check();
      }
    });
  }, []);

  const start = (exerciseId?: string, kind: MentorKind = "learn") => {
    setStarting(`${kind}:${exerciseId ?? "today"}`);
    host.request("mentor.start", { ...(exerciseId ? { exerciseId } : {}), kind }).then(() => setError(null), (e: Error) => setError(e.message)).finally(() => setStarting(null));
  };

  if (!home) {
    return (
      <div class="mh mh-loading">
        <Sky />
        <div class="mh-center">
          {error ? (
            <>
              <p>{error}</p>
              <button class="mh-btn" onClick={() => void load()}>Thử lại</button>
            </>
          ) : <p class="mh-muted">Đang mở bản đồ sao…</p>}
        </div>
      </div>
    );
  }

  const rank = home.overall === null ? null : mentorRank(home.overall);
  const star = selected ? home.stars.find((s) => s.id === selected) ?? null : null;
  return (
    <div class="mh">
      <Sky />
      <header class="mh-header">
        <div class="mh-brand"><span class="mh-brand-mark">✦</span> Mentor</div>
        <div class="mh-stats">
          <span class={`mh-streak${home.streak.doneToday ? " lit" : ""}`} title={home.streak.doneToday ? "Hôm nay đã học" : "Hôm nay chưa học"}>
            <span class="mh-flame" aria-hidden="true">🔥</span>
            <b>{home.streak.current}</b> ngày
            {home.streak.freezes > 0 && <span class="mh-freeze" title={`${home.streak.freezes} ngày nghỉ phép: tự dùng khi bạn lỡ một ngày`}>❄{home.streak.freezes}</span>}
          </span>
          <span class={`mh-rating ${rank ? `rank-${rank.tone}` : ""}`} title={rank ? rank.name : "Chưa có rating: làm bài chẩn đoán trước"}>
            ◆ <b><Count value={home.overall} /></b>{rank && <span class="mh-rank">{rank.name}</span>}
          </span>
        </div>
      </header>

      {error && <div class="mh-banner mh-error" role="alert">{error}<button class="mh-x" aria-label="Đóng" onClick={() => setError(null)}>×</button></div>}
      {env && <EnvBanner env={env} host={host} onRecheck={() => void check(true)} />}

      <section class="mh-map-wrap">
        <StarMap home={home} selected={selected} onSelect={setSelected} />
        {star && <StarCard star={star} starting={starting} onStart={start} onClose={() => setSelected(null)} />}
        <div class="mh-legend" aria-hidden="true">
          <span><i class="lg mastered" />đã vững</span>
          <span><i class="lg fading" />cần ôn</span>
          <span><i class="lg learning" />đang học</span>
          <span><i class="lg open" />đã mở</span>
          <span><i class="lg locked" />chưa mở</span>
        </div>
      </section>

      <div class="mh-grid">
        {home.warmup && <WarmupCard home={home} warmup={home.warmup} starting={starting} onStart={(id) => start(id, "review")} onShow={(id) => setSelected(id)} />}
        <TodayCard home={home} starting={starting} onStart={start} onShow={(id) => setSelected(id)} />
        <SkillsCard home={home} />
        <StreakCard home={home} />
        <ShelfCard home={home} />
        <MistakesCard mistakes={home.mistakes} />
        <RecentCard home={home} onStart={start} />
        <section class="mh-card mh-settings">
          <h3>Thư mục bài làm</h3>
          <code class="mh-path" title={home.workDir}>{home.workDir}</code>
          <div class="mh-row">
            <button class="mh-btn ghost" onClick={() => void host.request("mentor.pickWorkDir").then(() => load(), (e: Error) => setError(e.message))}>Đổi thư mục</button>
            <button class="mh-btn ghost" onClick={() => void host.request("mentor.revealWorkDir").catch(() => {})}>Mở thư mục</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/** A number that counts from its last value to the new one (at once when motion is reduced). */
function Count({ value }: { value: number | null }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (value === null || start === null || start === value || reducedMotion()) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      const eased = 1 - (1 - k) ** 3;
      setShown(Math.round(start + (value - start) * eased));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{shown ?? "—"}</>;
}

const SEEN_KEY = "mentor.seenStars";

/**
 * Stars that became bright since this viewer last looked (mastered, or lit
 * again by a review): they flare once. What was seen is kept in this
 * browser only; without storage nothing flares.
 */
function useJustLit(home: MentorHome): Set<string> {
  const [lit, setLit] = useState<Set<string>>(new Set());
  useEffect(() => {
    const now: Record<string, string> = {};
    for (const s of home.stars) now[s.id] = s.state === "mastered" ? (s.fade > 0 ? "faded" : "bright") : s.state;
    let before: Record<string, string> | null = null;
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      before = raw ? JSON.parse(raw) : null;
      localStorage.setItem(SEEN_KEY, JSON.stringify(now));
    } catch {
      return;
    }
    if (!before || reducedMotion()) return;
    const fresh = new Set(Object.keys(now).filter((id) => now[id] === "bright" && before![id] !== "bright"));
    if (!fresh.size) return;
    setLit(fresh);
    const timer = setTimeout(() => setLit(new Set()), 2600);
    return () => clearTimeout(timer);
  }, [home]);
  return lit;
}

function Sky() {
  return <div class="mh-sky" aria-hidden="true"><div class="mh-nebula a" /><div class="mh-nebula b" /></div>;
}

function StarMap({ home, selected, onSelect }: { home: MentorHome; selected: string | null; onSelect: (id: string | null) => void }) {
  const map = useMemo(() => layout(home), [home]);
  const lit = useJustLit(home);
  const pick = (s: MapStar) => onSelect(selected === s.id ? null : s.id);
  return (
    <svg class="mh-map" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="group" aria-label="Bản đồ chòm sao kỹ năng">
      <defs>
        <radialGradient id="mh-glow">
          <stop offset="0%" stop-color="#fff6d6" stop-opacity="0.95" />
          <stop offset="35%" stop-color="#f2c94c" stop-opacity="0.55" />
          <stop offset="100%" stop-color="#f2c94c" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="mh-glow-cool">
          <stop offset="0%" stop-color="#cfe0ff" stop-opacity="0.8" />
          <stop offset="100%" stop-color="#7c8cff" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="mh-lit" x1="0" x2="1">
          <stop offset="0%" stop-color="#f2c94c" stop-opacity="0.9" />
          <stop offset="100%" stop-color="#ffe7a3" stop-opacity="0.9" />
        </linearGradient>
      </defs>
      {map.dust.map((d, i) => <circle key={i} class="mh-dust" cx={d.x} cy={d.y} r={d.r} opacity={d.o} style={{ animationDelay: `${(i % 13) * 0.37}s` }} />)}
      {map.labels.map((l) => (
        <text key={l.id} class="mh-const-label" x={l.x} y={l.y} text-anchor="middle">
          {l.name.toUpperCase()} <tspan class="mh-const-count">{l.mastered}/{l.total}</tspan>
        </text>
      ))}
      {map.links.map((l) => (
        <line key={`${l.from}-${l.to}`} class={`mh-link${l.lit ? " lit" : l.near ? " near" : ""}`} style={l.lit && l.fade ? { opacity: 1 - 0.7 * l.fade } : undefined} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
      ))}
      {map.stars.map((s, i) => (
        <g
          key={s.id}
          class={`mh-star ${s.state}${s.fade > 0 ? " fading" : ""}${s.today ? " today" : ""}${selected === s.id ? " selected" : ""}${lit.has(s.id) ? " just-lit" : ""}`}
          style={s.fade > 0 ? { "--fade": String(s.fade) } : undefined}
          transform={`translate(${s.cx} ${s.cy})`}
          tabIndex={s.state === "locked" && !s.exercises.length ? -1 : 0}
          role="button"
          aria-label={`${s.name}: ${STATE_LABEL[s.state]}${s.fade > 0 ? ", cần ôn" : ""}`}
          onClick={() => pick(s)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(s); } }}
        >
          <title>{`${s.name} · ${STATE_LABEL[s.state]}${s.fade > 0 ? " · đang mờ dần: có bài quá hạn ôn" : ""}${s.exercises.length ? "" : " · sắp có bài"}`}</title>
          <circle class="mh-hit" r={16} />
          {s.state === "mastered" && <circle class="mh-halo" r={s.r * 3.4} fill="url(#mh-glow)" style={{ animationDelay: `${(i % 7) * 0.5}s` }} />}
          {s.state === "learning" && <circle class="mh-halo cool" r={s.r * 2.6} fill="url(#mh-glow-cool)" />}
          {s.today && <circle class="mh-target" r={s.r + 8} />}
          {lit.has(s.id) && <circle class="mh-burst" r={s.r * 4} />}
          <circle class="mh-core" r={s.r} />
          {s.state !== "locked" && <text class="mh-star-label" y={-s.r - 7} text-anchor="middle">{s.name}</text>}
        </g>
      ))}
    </svg>
  );
}

function StarCard({ star, starting, onStart, onClose }: { star: MentorStarView; starting: string | null; onStart: (id: string) => void; onClose: () => void }) {
  return (
    <aside class="mh-star-card" aria-label={star.name}>
      <div class="mh-row">
        <h3>{star.name}</h3>
        <span class={`mh-chip ${star.fade > 0 ? "fading" : star.state}`}>{star.fade > 0 ? "cần ôn" : STATE_LABEL[star.state]}</span>
        <button class="mh-x" aria-label="Đóng" onClick={onClose}>×</button>
      </div>
      {star.fade > 0 && <p class="mh-muted">Sao đang mờ dần vì có bài quá hạn ôn. Ôn xong (ở thẻ Khởi động) là sáng lại.</p>}
      {star.exercises.length ? (
        <ul class="mh-ex-list">
          {star.exercises.map((e) => (
            <li key={e.id}>
              <div>
                <div class="mh-ex-title">{e.done && <span class="mh-done">✓ </span>}{e.variant && <span class="mh-chip small reason-variant">biến thể</span>} {e.title}</div>
                <div class="mh-muted">độ khó {e.difficulty} · ~{e.minutes} phút</div>
              </div>
              <button class="mh-btn small" disabled={!!starting} onClick={() => onStart(e.id)}>{starting === `learn:${e.id}` ? "Đang mở…" : e.done ? "Làm lại" : "Bắt đầu"}</button>
            </li>
          ))}
        </ul>
      ) : <p class="mh-muted">Ngôi sao này chưa có bài. Bài mới sẽ được thêm dần theo lộ trình.</p>}
    </aside>
  );
}

function WarmupCard({ home, warmup, starting, onStart, onShow }: { home: MentorHome; warmup: MentorToday; starting: string | null; onStart: (id: string) => void; onShow: (star: string) => void }) {
  const more = home.reviews.due - (warmup.reason === "review" ? 1 : 0);
  return (
    <section class="mh-card mh-warmup">
      <h3>Khởi động</h3>
      <span class="mh-chip fading">
        {warmup.reason === "continue" ? "Ôn dở" : warmup.overdue ? `Quá hạn ôn ${warmup.overdue} ngày` : "Đến hạn ôn hôm nay"}
      </span>
      <div class="mh-today-title">{warmup.title}</div>
      <div class="mh-muted">
        <button class="mh-link-btn" onClick={() => onShow(warmup.star)}>{home.stars.find((s) => s.id === warmup.star)?.name ?? warmup.star}</button> · cài lại từ cell trống · ~{warmup.minutes} phút
      </div>
      <button class="mh-btn primary" disabled={!!starting} onClick={() => onStart(warmup.exerciseId)}>
        {starting === `review:${warmup.exerciseId}` ? "Đang mở notebook…" : warmup.reason === "continue" ? "Ôn tiếp ▶" : "Ôn ngay ▶"}
      </button>
      <p class="mh-muted">Ôn trước, rồi làm bài hôm nay. Nhớ được thì lần ôn sau giãn ra: 3 → 10 → 30 ngày.{more > 0 ? ` Còn ${more} bài khác đến hạn.` : ""}</p>
    </section>
  );
}

function TodayCard({ home, starting, onStart, onShow }: { home: MentorHome; starting: string | null; onStart: (id?: string) => void; onShow: (star: string) => void }) {
  const t = home.today;
  const diag = home.diagnostic;
  return (
    <section class="mh-card mh-today">
      <h3>Bài hôm nay</h3>
      {t ? (
        <>
          <span class={`mh-chip reason-${t.reason}`}>{REASON[t.reason]}{t.reason === "diagnostic" ? ` · ${diag.done + 1}/${diag.total}` : ""}</span>
          <div class="mh-today-title">{t.title}</div>
          <div class="mh-muted">
            <button class="mh-link-btn" onClick={() => onShow(t.star)}>{home.stars.find((s) => s.id === t.star)?.name ?? t.star}</button> · độ khó {t.difficulty} · ~{t.minutes} phút
          </div>
          <button class={`mh-btn ${home.warmup ? "" : "primary "}big`} disabled={!!starting} onClick={() => onStart(t.exerciseId)}>
            {starting === `learn:${t.exerciseId}` ? "Đang mở notebook…" : t.reason === "continue" ? "Làm tiếp ▶" : "Bắt đầu ▶"}
          </button>
        </>
      ) : <p class="mh-muted">Bạn đã làm hết các bài hiện có. Bài mới sẽ được bổ sung.</p>}
      {diag.total > 0 && diag.done < diag.total && (
        <div class="mh-diag">
          <div class="mh-row"><span>Chẩn đoán</span><span class="mh-muted">{diag.done}/{diag.total} bài</span></div>
          <div class="mh-bar"><i style={{ width: `${(diag.done / diag.total) * 100}%` }} /></div>
          <p class="mh-muted">Vài bài ngắn trải đều các kỹ năng, để biết bạn mạnh và yếu ở đâu.</p>
        </div>
      )}
      {diag.weakest.length > 0 && (
        <p class="mh-muted">Nên luyện thêm: {diag.weakest.map((s) => MENTOR_SKILL_LABEL[s]).join(" · ")}</p>
      )}
      {home.reviews.upcoming.length > 0 && (
        <div class="mh-upcoming">
          <div class="mh-muted">Lịch ôn sắp tới</div>
          <ul>
            {home.reviews.upcoming.map((r) => <li key={r.exerciseId}><span>{r.title}</span><span class="mh-muted">{dayLabel(r.day)}</span></li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(d)}/${Number(m)}`;
}

const MISTAKE_STATUS: Record<MentorMistake["status"], string> = { due: "hỏi lại hôm nay", waiting: "chờ hỏi lại", solid: "đã vững" };

function MistakesCard({ mistakes }: { mistakes: MentorMistake[] }) {
  const open = mistakes.filter((m) => m.status !== "solid").length;
  return (
    <section class="mh-card mh-mistakes">
      <h3>Sổ lỗi sai</h3>
      {mistakes.length ? (
        <>
          <p class="mh-muted">{open ? `${open} hiểu nhầm đang theo dõi.` : "Mọi hiểu nhầm đã vững."} Mentor hỏi lại ở đầu buổi học; đúng 2 lần liền là vững.</p>
          <ul>
            {mistakes.slice(0, 8).map((m) => (
              <li key={m.tag} class={m.status}>
                <div class="mh-row">
                  <code class="mh-tag">{m.tag}</code>
                  <span class={`mh-chip small mistake-${m.status}`}>{MISTAKE_STATUS[m.status]}{m.status === "waiting" && m.due ? ` · ${dayLabel(m.due)}` : ""}</span>
                </div>
                <div class="mh-mistake-note">{m.note}</div>
                <div class="mh-muted">{m.title}{m.seen > 1 ? ` · gặp ${m.seen} lần` : ""}</div>
              </li>
            ))}
          </ul>
        </>
      ) : <p class="mh-muted">Chưa có gì. Khi bạn trả lời sai một câu hỏi vặn, hiểu nhầm đó được ghi ở đây và được hỏi lại sau 2 ngày.</p>}
    </section>
  );
}

function SkillsCard({ home }: { home: MentorHome }) {
  return (
    <section class="mh-card mh-skills">
      <h3>Kỹ năng</h3>
      <ul>
        {home.skills.map((s) => {
          const rank = s.rating === null ? null : mentorRank(s.rating);
          return (
            <li key={s.skill}>
              <span class="mh-skill-name">{s.label}</span>
              <span class="mh-bar"><i class={rank ? `bg-${rank.tone}` : ""} style={{ width: `${ratingShare(s.rating) * 100}%` }} /></span>
              <span class={`mh-skill-num ${rank ? `rank-${rank.tone}` : "mh-muted"}`} title={rank ? `${rank.name} · ${s.games} kết quả` : "Chưa có kết quả"}><Count value={s.rating} /></span>
            </li>
          );
        })}
      </ul>
      {home.history.length > 1 && <Sparkline points={home.history.map((h) => h.overall)} />}
    </section>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const w = 260;
  const h = 46;
  const lo = Math.min(...points) - 20;
  const hi = Math.max(...points) + 20;
  const xy = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - lo) / (hi - lo)) * h}`).join(" ");
  return (
    <svg class="mh-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Lịch sử rating">
      <polyline points={xy} />
    </svg>
  );
}

function StreakCard({ home }: { home: MentorHome }) {
  const weeks = heatWeeks(home.heatmap);
  return (
    <section class="mh-card mh-streak-card">
      <h3>Chuỗi ngày học</h3>
      <div class="mh-row mh-streak-nums">
        <div><b>{home.streak.current}</b><span class="mh-muted">hiện tại</span></div>
        <div><b>{home.streak.best}</b><span class="mh-muted">dài nhất</span></div>
        <div><b>{home.streak.freezes}</b><span class="mh-muted">ngày nghỉ phép</span></div>
      </div>
      <div class="mh-heat" role="img" aria-label="Lịch học 16 tuần">
        {weeks.map((w, i) => (
          <div key={i} class="mh-heat-col">
            {w.map((d, j) => (d ? <i key={j} class={`h${Math.min(3, d.count)}`} title={`${d.day}: ${d.count} chặng`} /> : <i key={j} class="pad" />))}
          </div>
        ))}
      </div>
      <p class="mh-muted">Một ngày được tính khi bạn xong ít nhất một chặng. Ngày đổi lúc 4 giờ sáng. Cứ 7 ngày liền được 1 ngày nghỉ phép.</p>
    </section>
  );
}

function ShelfCard({ home }: { home: MentorHome }) {
  return (
    <section class="mh-card mh-shelf">
      <h3>Tủ paper</h3>
      <p class="mh-muted">Mỗi chòm sao khép lại bằng một paper bạn tự reproduce.</p>
      <ul>
        {home.constellations.map((c) => (
          <li key={c.id}>
            <div class="mh-row"><span class="mh-shelf-name">{c.name}</span><span class="mh-muted">{c.mastered}/{c.stars.length} sao</span></div>
            {c.paper && <div class="mh-shelf-paper">📜 {c.paper}</div>}
            <div class="mh-bar thin"><i style={{ width: `${(c.mastered / Math.max(1, c.stars.length)) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentCard({ home, onStart }: { home: MentorHome; onStart: (id: string) => void }) {
  if (!home.recent.length) return null;
  const when = (ms: number) => new Date(ms).toLocaleDateString("vi-VN", { day: "numeric", month: "numeric" });
  return (
    <section class="mh-card mh-recent">
      <h3>Gần đây</h3>
      <ul>
        {home.recent.map((r) => (
          <li key={r.attemptId}>
            <span class="mh-muted">{when(r.at)}</span>
            <button class="mh-link-btn" onClick={() => onStart(r.exerciseId)}>{r.title}</button>
            <span class={`mh-chip small ${r.stage === "done" ? "mastered" : "learning"}`}>
              {r.kind === "review" ? "ôn · " : ""}
              {r.stage === "done" ? (r.revealed ? "đã xem lời giải" : r.score !== undefined ? `${Math.round(r.score * 100)} điểm` : "xong") : "đang làm"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EnvBanner({ env, host, onRecheck }: { env: Env; host: MentorHomeHost; onRecheck: () => void }) {
  const missing = Object.entries(env.modules).filter(([, ok]) => !ok).map(([m]) => m);
  if (!env.error && !missing.length && env.jupyter !== false) return null;
  return (
    <div class="mh-banner mh-env" role="status">
      <div>
        <b>Chuẩn bị máy</b>
        {env.error ? <p>{env.error}</p> : (
          <p>
            {env.python && <>Python {env.python.version} · </>}
            {missing.length > 0 && <>thiếu {missing.join(", ")}{missing.includes("torch") ? " (PyTorch bản CPU là đủ cho các bài ngắn)" : ""}. </>}
            {env.jupyter === false && <>Cần extension Jupyter của Microsoft để chạy notebook trong VS Code.</>}
          </p>
        )}
        {env.install && <code class="mh-cmd">{env.install}</code>}
      </div>
      <div class="mh-row">
        {env.jupyter === false && <button class="mh-btn small" onClick={() => void host.request("mentor.installJupyter")}>Cài Jupyter</button>}
        {env.install && <button class="mh-btn small" onClick={() => void host.request("mentor.install", { command: env.install })}>Chạy lệnh cài</button>}
        <button class="mh-btn ghost small" onClick={onRecheck}>Kiểm tra lại</button>
      </div>
    </div>
  );
}

export type { MentorSkill };
