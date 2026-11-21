// `ainb mentor stats`: print per-exercise learning analytics and human-reviewed
// difficulty calibration suggestions (never mutates meta.json automatically, C9).

import { join } from "node:path";
import { dataDir } from "../config.js";
import { Mentor } from "./index.js";

export async function mentorStats(): Promise<number> {
  const mentor = new Mentor({ dir: join(dataDir(), "mentor") });
  const status = mentor.status();
  const rows = mentor.analytics();
  console.log(`Mentor stats — overall ${status.overall} · streak ${status.streak} · due reviews ${status.dueReviews}`);
  console.log("(Active minutes are approximate: sum of inter-event gaps capped at 10m.)\n");
  if (!rows.length) {
    console.log("Chưa có dữ liệu làm bài nào.");
    return 0;
  }
  console.log("Exercise                      Diff  Att  Pass%  Hint  Fails  Active/Decl(m)  Suggestion");
  console.log("─".repeat(96));
  for (const r of rows) {
    const id = r.exerciseId.padEnd(28).slice(0, 28);
    const diff = String(r.difficulty).padStart(4);
    const att = String(r.attempts).padStart(4);
    const pass = `${Math.round(r.passRate * 100)}%`.padStart(5);
    const hint = r.avgHints.toFixed(1).padStart(5);
    const fails = r.avgFailedBeforePass.toFixed(1).padStart(6);
    const mins = `${r.avgActiveMinutes.toFixed(1)}/${r.minutes}`.padStart(14);
    const sug = r.suggestedDifficulty ? `-> ${r.suggestedDifficulty} (${r.reason})` : "";
    console.log(`${id}  ${diff}  ${att}  ${pass}  ${hint}  ${fails}  ${mins}  ${sug}`);
  }
  const suggestions = rows.filter((r) => r.suggestedDifficulty !== undefined);
  if (suggestions.length) {
    console.log(`\n${suggestions.length} difficulty suggestion(s) above — review by hand before editing meta.json (changing meta changes the exercise hash).`);
  }
  return 0;
}
