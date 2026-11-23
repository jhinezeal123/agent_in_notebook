import { useEffect, useState } from "preact/hooks";
import { readerSessionRemaining, type ReaderStudySession } from "@ainb/protocol";

export function StudyClock({ session, change }: {
  session?: ReaderStudySession;
  change(action: "start" | "end"): Promise<void>;
}) {
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const remaining = session ? readerSessionRemaining(session, now) : 0;

  useEffect(() => {
    if (!session || !readerSessionRemaining(session, Date.now())) return;
    setNow(Date.now());
    const refresh = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (!readerSessionRemaining(session, at)) clearInterval(refresh);
    }, 1000);
    return () => clearInterval(refresh);
  }, [session?.startedAt, session?.endedAt]);

  async function update(action: "start" | "end") {
    setBusy(true);
    try { await change(action); }
    finally { setBusy(false); }
  }

  if (!session || !remaining) return <div class="er-session">
    {session && <span class="er-muted small" role="status">{session.endedAt !== undefined ? "Buổi đọc đã kết thúc" : "Đã hết 40 phút"}</span>}
    <button class="er-btn" disabled={busy} onClick={() => void update("start")}>{session ? "Bắt đầu buổi mới" : "Bắt đầu buổi đọc"}</button>
  </div>;

  const seconds = Math.ceil(remaining / 1000);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <div class="er-session">
    <span class="er-session-time" role="timer" title="Thời gian còn lại trong buổi đọc">{time}</span>
    <button class="er-link small" disabled={busy} onClick={() => void update("end")}>Kết thúc buổi</button>
  </div>;
}
