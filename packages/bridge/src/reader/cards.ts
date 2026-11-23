import { randomBytes } from "node:crypto";
import type { ReaderCardGrade, ReaderCardView, ReaderGoal } from "@ainb/protocol";
import { z } from "zod";
import type { ReaderHub } from "./index.js";
import { EvidenceSchema } from "./items.js";
import { lintEvidence, nearDuplicate } from "./lint.js";

export const DAY_MS = 86_400_000;
const intervals = [5, 14, 30, 60, 120];

export const CardSchema = z.object({
  front: z.string().trim().min(8).max(220),
  back: z.string().trim().min(3).max(360),
  evidence: EvidenceSchema,
});
export const CardBatchSchema = z.array(CardSchema).min(5).max(30);
type CardInput = z.infer<typeof CardSchema>;

export interface ReaderCard extends CardInput {
  id: string;
  kept: boolean;
  at: number;
}

export interface CardReview { at: number; grade: ReaderCardGrade }

export function scheduleCard(card: Pick<ReaderCard, "at">, reviews: CardReview[], goal?: ReaderGoal): number | undefined {
  const limit = goal === "use" ? 3 : intervals.length;
  let rung = -1;
  let due: number | undefined = card.at;
  for (const { at, grade } of reviews) {
    rung = grade === "again" ? 0 : grade === "hard" ? Math.max(0, rung) : rung + 1;
    due = rung >= limit ? undefined : at + intervals[rung]! * DAY_MS;
  }
  return due;
}

export class ReaderCards {
  constructor(private readonly hub: ReaderHub) {}

  hasProposals(paperId: string): boolean {
    return this.hub.store.state(paperId).cardsPrepared;
  }

  propose(paperId: string, inputs: CardInput[]): void {
    const state = this.hub.store.state(paperId);
    if (state.cardsPrepared) return;
    const parsed = CardBatchSchema.parse(inputs);
    const max = state.goal === "use" ? 20 : 30;
    if (parsed.length > max) throw new Error(`Propose at most ${max} cards for this reading goal.`);
    const errors = this.validate(paperId, parsed, [...state.cards.values()]);
    if (errors.length) throw new Error(errors.join("\n"));
    const at = Date.now();
    this.hub.store.append(paperId, { t: "r.cardsProposed", at, cards: parsed.map((input) => ({ ...input, id: randomBytes(8).toString("hex"), at, kept: false })) });
    this.hub.touch(paperId);
  }

  keep(paperId: string, id?: string, edit?: { front?: string; back?: string; evidence?: CardInput["evidence"] }): void {
    const state = this.hub.store.state(paperId);
    const previous = id ? state.cards.get(id) : undefined;
    if (id && !previous) throw new Error("Không còn thẻ này.");
    const input = CardSchema.parse({ ...previous, ...edit });
    if (state.goal === "use" && !previous?.kept && [...state.cards.values()].filter((c) => c.kept).length >= 20) throw new Error("Mục tiêu Hiểu để dùng giữ tối đa 20 thẻ.");
    const errors = this.validate(paperId, [input], [...state.cards.values()].filter((c) => c.id !== id));
    if (errors.length) throw new Error(errors.join("\n"));
    const at = Date.now();
    const card = { ...input, id: id ?? randomBytes(8).toString("hex"), at: previous?.kept ? previous.at : at, kept: true };
    this.hub.store.append(paperId, { t: "r.cardKeep", at, card });
    this.hub.touch(paperId);
  }

  drop(paperId: string, id: string): void {
    this.hub.meta(paperId);
    this.hub.store.append(paperId, { t: "r.cardDrop", at: Date.now(), id });
    this.hub.touch(paperId);
  }

  review(paperId: string, id: string, grade: ReaderCardGrade, now = Date.now()): void {
    const state = this.hub.store.state(paperId);
    const card = state.cards.get(id);
    if (!card?.kept || !["again", "hard", "good"].includes(grade)) throw new Error("Thẻ ôn hoặc mức độ nhớ không hợp lệ.");
    const due = scheduleCard(card, state.cardReviews.get(id) ?? [], state.goal);
    if (due === undefined || due > now) throw new Error("Thẻ này chưa đến hạn.");
    this.hub.store.append(paperId, { t: "r.card", at: now, id, grade });
    this.hub.learning(paperId, now);
    this.hub.touch(paperId);
  }

  views(paperId: string): ReaderCardView[] {
    const title = this.hub.meta(paperId).title;
    const state = this.hub.store.state(paperId);
    return [...state.cards.values()].map((card) => {
      const reviews = state.cardReviews.get(card.id) ?? [];
      const due = card.kept ? scheduleCard(card, reviews, state.goal) : undefined;
      return { id: card.id, paperId, title, front: card.front, back: card.back, anchor: { id: card.evidence.anchor, quote: card.evidence.quote },
        kept: card.kept, reviewed: reviews.length, ...(due === undefined ? {} : { due }) };
    });
  }

  due(now = Date.now()): ReaderCardView[] {
    const groups = this.hub.store.ids().map((paperId) => {
      try {
        return this.views(paperId).filter((card) => card.due !== undefined && card.due <= now).sort((a, b) => a.due! - b.due!);
      } catch {
        return [];
      }
    }).filter((g) => g.length).sort((a, b) => a[0]!.due! - b[0]!.due!);
    const result: ReaderCardView[] = [];
    while (result.length < 10 && groups.some((g) => g.length)) {
      for (const g of groups) if (g.length && result.length < 10) result.push(g.shift()!);
    }
    return result;
  }

  private validate(paperId: string, cards: CardInput[], existing: CardInput[]): string[] {
    const complaints = lintEvidence(cards.map((card) => card.evidence), this.hub.doc(paperId));
    for (const [i, card] of cards.entries()) {
      if (/^(?:có phải|liệu|đúng hay sai|is |are |does |do |did |can |was |were )/i.test(card.front) || /(?:hay không|đúng không)\??$/i.test(card.front)) complaints.push(`Thẻ ${i + 1}: đặt câu hỏi mở, mỗi thẻ một ý.`);
      if ([...existing, ...cards.slice(0, i)].some((c) => nearDuplicate(c.front, card.front))) complaints.push(`Thẻ ${i + 1} trùng câu hỏi đã có.`);
    }
    return complaints;
  }
}
