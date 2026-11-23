import { gradeChoice, type ReaderItem } from "./items.js";
import { checkerTask, choiceOf, ReaderCheckerRole } from "./checker.js";
import type { ReaderHub } from "./index.js";
import type { AuthorChat } from "../mentor/workshop.js";
import type { ReaderState } from "./model.js";

export type ReaderQuality = {
  ruleSeen: number;
  rulePassed: number;
  evidenceRejected: number;
  bloomRejected: number;
  blindSeen: number;
  blindPassed: number;
  bloomChanged: number;
  widgetsChecked: number;
  widgetsPassed: number;
};

export function emptyQuality(): ReaderQuality {
  return { ruleSeen: 0, rulePassed: 0, evidenceRejected: 0, bloomRejected: 0, blindSeen: 0, blindPassed: 0, bloomChanged: 0, widgetsChecked: 0, widgetsPassed: 0 };
}

export function measureRules(issues: string[], total: number): Partial<ReaderQuality> {
  const rejected = new Set(issues.flatMap((s) => s.match(/^item (\d+)/)?.[1] ?? []));
  return {
    ruleSeen: total, rulePassed: Math.max(0, total - rejected.size),
    evidenceRejected: new Set(issues.filter((s) => /: evidence .*not in the paper/.test(s)).flatMap((s) => s.match(/^item (\d+)/)?.[1] ?? [])).size,
    bloomRejected: issues.some((s) => s.startsWith("items: at least one question")) ? 1 : 0,
  };
}

export function qualityStats(state: ReaderState, items: ReaderItem[]) {
  const live = new Set(items.map((i) => i.id));
  const concepts: Record<string, { attempts: number; sureWrong: number }> = Object.create(null);
  for (const [id, answers] of state.answers) {
    if (!live.has(id)) continue;
    for (const a of answers) {
      const count = concepts[a.concept] ??= { attempts: 0, sureWrong: 0 };
      count.attempts++;
      if (a.confidence === 3 && !a.correct) count.sureWrong++;
    }
  }
  const firstReview = [...state.cardReviews.values()].flatMap((g) => g[1]?.grade ?? []);
  return {
    author: state.quality, total: items.length, unchecked: items.filter((i) => i.unchecked).length,
    reports: [...state.reports.keys()].filter((id) => live.has(id)).length, concepts,
    firstSpacedReview: { remembered: firstReview.filter((g) => g !== "again").length, attempts: firstReview.length },
  };
}

export async function runPaperQuiz(hub: ReaderHub, paperId: string, items: ReaderItem[], open: (role: ReaderCheckerRole) => AuthorChat) {
  const batch = items.filter((item) => !item.unchecked && !hub.store.state(paperId).reports.has(item.id)).slice(0, 24);
  if (!batch.length) throw new Error("Soạn checkpoint đã qua người kiểm trước khi chạy PaperQuiz.");
  const role = new ReaderCheckerRole(hub, paperId, batch, true);
  const map = hub.passes.map(paperId);
  const widgets = hub.widgets.requests(paperId).flatMap((req) => {
    const w = hub.widgets.read(paperId, req.id);
    return w ? [{ title: w.title, explanation: w.explanation, tryThis: w.tryThis, model: w.model }] : [];
  });
  const lesson = JSON.stringify({ concepts: map.concepts, notation: map.notation, background: map.background, fivec: map.fivec, widgets }).slice(0, 45_000);
  const chat = open(role);
  try {
    chat.send("Làm PaperQuiz chỉ dựa trên nội dung học được cung cấp.", `<reader-lesson>\n${lesson}\n</reader-lesson>\n${checkerTask(hub, paperId, batch, false)}`);
    await chat.whenIdle(AbortSignal.timeout(120_000));
    const correct = batch.reduce((sum, item) => {
      const answer = role.answers.get(item.id);
      return sum + (answer && gradeChoice(item, choiceOf(item, answer)).correct ? 1 : 0);
    }, 0);
    if (!role.answers.size) throw new Error("Agent PaperQuiz chưa trả lời qua reader_check_write.");
    return { total: batch.length, answered: batch.filter((item) => role.answers.has(item.id)).length, correct };
  } finally {
    chat.close();
  }
}
