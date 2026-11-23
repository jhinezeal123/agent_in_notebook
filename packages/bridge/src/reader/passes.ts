// Passes 1–2 of a paper (ER-2; docs/easy-read.md D.3, D.4, E.8): the goal
// and the passes, the map and the units' checkpoints the hidden author wrote,
// what the reader answered and wrote, the tutor's grades, the paper's
// misconception book. What the tab sees of it (`guide`) has no answer to a
// task still waiting; what the tutor sees of it (`tutorState`) neither: a
// reference reaches the tutor only with the reader's own write, for grading.

import { randomBytes } from "node:crypto";
import {
  READER_FIVE_C,
  READER_BLOOMS,
  READER_GOALS,
  READER_PASS_LABEL,
  READER_QALMRI,
  readerCiteLabel,
  type ReaderAnswerResult,
  type ReaderChoice,
  type ReaderExerciseKind,
  type ReaderGoal,
  type ReaderGrade,
  type ReaderGuide,
  type ReaderItemView,
  type ReaderPass,
  type ReaderScore,
  type ReaderUnitView,
  type ReaderView,
  type ReaderWriteKind,
  type ReaderWriteView,
  type MentorPaper,
} from "@ainb/protocol";
import { descendants, type ReaderDoc } from "./doc.js";
import type { ReaderHub } from "./index.js";
import { answerResult, gradeChoice, itemView, misconceptionOf, pretestView, type ReaderItem, type ReaderMap, type ReaderPack, type ReaderUnitDef } from "./items.js";
import { conceptMastery, isAgain, latestWrite, scoreOf, type ReaderState, type ReaderWrite } from "./model.js";
import type { ReaderTask } from "./author.js";
import { DAY_MS } from "./cards.js";

/** What the passes ask of the hidden author (author.ts). */
export interface ReaderAuthorQueue {
  /** Write the paper's map; a unit's checkpoint. Already done, queued or running: nothing. */
  enqueue(paperId: string, task: ReaderTask): void;
  status(paperId: string): ReaderGuide["author"];
  unitState(paperId: string, unit: string): { state: "preparing" | "failed" | "waiting"; error?: string };
}

/** Where the reader's own words go to be graded: the paper's tutor chat. */
export interface ReaderTutorPort {
  send(text: string, context: string): void;
}

export interface ReaderPassesHost {
  /** A misconception into Mentor's book (it asks again in two days). */
  misconception?(p: { paperId: string; title: string; concept: string; note: string }): void;
}

const EXERCISES: ReadonlySet<ReaderWriteKind> = new Set(["deep", "derive", "find-flaws", "review", "outline", "feynman", "synthesis"]);
const GRADED: ReadonlySet<ReaderWriteKind> = new Set(["5c", "recall", "explain", "qalmri", "summary", ...[...EXERCISES].filter((kind) => kind !== "synthesis")]);
const WRITE_MAX = 6000;
const FIELD_MAX = 1500;
/** The map's parts every paper needs (a PDF also needs its units). */
const MAP_PARTS = ["roles", "fivec", "concepts", "notation", "background", "pretest"] as const;

const WRITE_LABEL: Record<ReaderWriteKind, string> = {
  "5c": "5C của tôi",
  recall: "Nhớ lại",
  explain: "Tự giải thích",
  qalmri: "Phiếu QALMRI",
  summary: "Tóm tắt lượt 2",
  figure: "Thông điệp của hình",
  predict: "Đoán kết quả",
  deep: "Câu đào sâu",
  derive: "Dẫn lại công thức",
  "find-flaws": "Tìm chỗ sai",
  review: "Review một trang",
  outline: "Dựng lại sườn paper",
  feynman: "Giải thích Feynman",
  synthesis: "Ghi chú 5 câu",
};

export class ReaderPasses {
  constructor(private readonly hub: ReaderHub, private readonly author: ReaderAuthorQueue, private readonly host: ReaderPassesHost = {}) {}

  // ------------------------------------------------------------------ what the author wrote

  map(paperId: string): ReaderMap {
    return this.hub.store.readJson<ReaderMap>(paperId, "map.json") ?? { at: 0 };
  }

  saveMap(paperId: string, map: ReaderMap): void {
    this.hub.store.writeJsonFile(paperId, "map.json", { ...map, at: Date.now() });
    this.hub.touch(paperId);
  }

  /** The map's parts still missing. */
  mapMissing(paperId: string): string[] {
    const map = this.map(paperId);
    // Each part once written counts (a paper may need no background: an empty list).
    const missing: string[] = MAP_PARTS.filter((p) => map[p] === undefined || (p !== "background" && p !== "fivec" && !(map[p] as unknown[]).length));
    if (pagedDoc(this.hub.doc(paperId)) && !map.units?.length) missing.push("units");
    return missing;
  }

  /** The units of pass 2: the paper's top sections; for a PDF, the author's grouping of its pages. */
  units(paperId: string): ReaderUnitDef[] {
    const doc = this.hub.doc(paperId);
    if (pagedDoc(doc)) return this.map(paperId).units ?? [];
    return defaultUnits(doc);
  }

  pack(paperId: string, unit: string): ReaderPack | null {
    return this.hub.store.readJson<ReaderPack>(paperId, packFile(unit));
  }

  savePack(paperId: string, pack: ReaderPack): void {
    this.hub.store.writeJsonFile(paperId, packFile(pack.unit), pack);
    this.hub.touch(paperId);
  }

  /** Every question written so far, withdrawn ones too. */
  items(paperId: string): ReaderItem[] {
    return this.units(paperId).flatMap((u) => this.pack(paperId, u.id)?.items ?? []);
  }

  private item(paperId: string, id: string): ReaderItem {
    const item = this.items(paperId).find((i) => i.id === id);
    if (!item) throw new Error("Không còn câu hỏi đó.");
    return item;
  }

  // ------------------------------------------------------------------ what the reader does

  goal(paperId: string, goal: ReaderGoal): ReaderGuide {
    if (!READER_GOALS.some((g) => g.id === goal)) throw new Error(`Không rõ mục tiêu ${goal}.`);
    const state = this.state(paperId);
    const at = Date.now();
    this.hub.store.append(paperId, { t: "r.goal", at, goal });
    if (!state.passed.size && state.pass === 1) this.hub.store.append(paperId, { t: "r.pass", at, pass: 1, what: "start" });
    this.prepareMap(paperId);
    this.hub.touch(paperId);
    return this.guide(paperId);
  }

  /** The author starts on the map once there is a goal and text to read. */
  prepareMap(paperId: string): void {
    if (!this.state(paperId).goal || this.hub.meta(paperId).needsText) return;
    if (this.mapMissing(paperId).length) this.author.enqueue(paperId, { kind: "map" });
  }

  pass(paperId: string, pass: ReaderPass, done = false): ReaderGuide {
    if (![1, 2, 3, 4].includes(pass)) throw new Error(`Không có lượt ${pass}.`);
    const state = this.state(paperId);
    if (!state.goal) throw new Error("Chọn mục tiêu đọc trước đã.");
    const at = Date.now();
    if (done) {
      if (pass !== state.pass && !state.passed.has(pass)) throw new Error("Chỉ kết thúc lượt đang đọc.");
      if ((pass === 3 || pass === 4) && !this.canFinish(paperId, pass)) throw new Error("Hoàn thành hoặc bỏ qua các phần cần làm để kết thúc lượt này.");
      this.hub.store.append(paperId, { t: "r.pass", at, pass, what: "done" });
    } else {
      if (pass >= 3 && (state.goal === "gist" || !state.passed.has((pass - 1) as ReaderPass))) throw new Error("Kết thúc lượt trước và chọn mục tiêu đọc phù hợp.");
      for (let p = state.pass; p < pass; p++) if (!state.passed.has(p as ReaderPass)) this.hub.store.append(paperId, { t: "r.pass", at, pass: p as ReaderPass, what: "done" });
      this.hub.store.append(paperId, { t: "r.pass", at, pass, what: "start" });
      if (pass === 2) {
        const units = this.units(paperId);
        const ahead = units.findIndex((u) => !this.unitDone(paperId, u));
        for (const u of units.slice(Math.max(0, ahead), Math.max(0, ahead) + 2)) this.author.enqueue(paperId, { kind: "unit", unit: u.id });
      }
      this.prepareLater(paperId);
    }
    this.hub.touch(paperId);
    return this.guide(paperId);
  }

  prepareLater(paperId: string): void {
    const pass = this.state(paperId).pass;
    if (pass === 3) this.author.enqueue(paperId, { kind: "deep" });
    if (pass === 4) this.author.enqueue(paperId, { kind: "cards" });
  }

  private canFinish(paperId: string, pass: 3 | 4): boolean {
    const state = this.state(paperId);
    if (pass === 3 && !this.hub.deep.read(paperId) && !state.skipped.has("exercise:deep-plan")) return false;
    const required = pass === 4 ? ["feynman", "synthesis"] : state.goal === "use"
      ? ["review", ...this.hub.deep.visible(paperId).filter((e) => e.bloom === "evaluate").map((e) => e.id)]
      : ["review", "outline"];
    return required.every((id) => {
      const w = [...state.writes.values()].filter((x) => x.key === id).at(-1);
      return state.skipped.has(`exercise:${id}`) || (!!w && (w.kind === "synthesis" || (w.grade ?? 0) >= 1 && !w.appealPending));
    });
  }

  /** The reader is in a section now: in pass 2, its unit and the next one get their checkpoints (one step ahead, not the whole paper). */
  sectionEntered(paperId: string, section: string): void {
    const state = this.state(paperId);
    if (state.pass !== 2) return;
    const units = this.units(paperId);
    const i = units.findIndex((u) => u.sections.includes(section));
    if (i < 0) return;
    for (const u of units.slice(i, i + 2)) if (!this.pack(paperId, u.id)) this.author.enqueue(paperId, { kind: "unit", unit: u.id });
  }

  answer(paperId: string, itemId: string, choice: ReaderChoice, confidence: 1 | 2 | 3): ReaderAnswerResult {
    const item = this.item(paperId, itemId);
    const state = this.state(paperId);
    if (state.reports.has(item.id)) throw new Error("Câu này đã bị báo sai và rút khỏi bộ.");
    if (![1, 2, 3].includes(confidence)) throw new Error("Chọn độ chắc chắn 1–3.");
    const clean = cleanChoice(item, choice);
    const { correct, partly } = gradeChoice(item, clean);
    const at = Date.now();
    const sections = this.units(paperId).find((u) => u.id === item.unit)?.sections ?? [item.unit];
    const readAt = Math.max(...sections.map((s) => state.readAt.get(s) ?? 0));
    this.hub.store.append(paperId, { t: "r.answer", at, item: item.id, unit: item.unit, concept: item.concept, bloom: item.bloom, correct, ...(partly ? { partly } : {}), confidence, choice: clean, ...(readAt > 0 ? { readAt } : {}) });
    this.hub.learning(paperId, at);
    // Wrong while fairly sure: a misconception, not a guess (E.8). A guess that missed is not one.
    if (!correct && confidence >= 2) this.recordMiss(paperId, item.concept, misconceptionOf(item, clean) ?? `Trả lời sai: “${clip(item.stem, 120)}”`, item.id);
    this.hub.touch(paperId);
    return answerResult(item, { correct, ...(partly ? { partly } : {}), confidence, choice: clean, at });
  }

  pretest(paperId: string, itemId: string, choice: { option?: number; text?: string }): void {
    const p = this.map(paperId).pretest?.find((x) => x.id === itemId);
    if (!p) throw new Error("Không còn câu đoán trước đó.");
    const option = Number.isInteger(choice.option) && p.options && choice.option! >= 0 && choice.option! < p.options.length ? choice.option : undefined;
    const text = typeof choice.text === "string" ? choice.text.trim().slice(0, 1000) : "";
    if (option === undefined && !text) throw new Error("Đoán một phương án, hoặc viết điều bạn đoán.");
    this.hub.store.append(paperId, { t: "r.pre", at: Date.now(), item: p.id, ...(option !== undefined ? { option } : {}), ...(text ? { text } : {}) });
    this.hub.touch(paperId);
  }

  /** Something the reader wrote. The kinds the tutor grades go to it with their reference; the others are kept. */
  write(paperId: string, input: { kind: ReaderWriteKind; unit?: string; key?: string; text?: string; fields?: Record<string, string> }, tutor?: ReaderTutorPort): { id: string; graded: boolean } {
    const { kind } = input;
    if (!Object.hasOwn(WRITE_LABEL, kind)) throw new Error(`Không rõ loại bài viết ${kind}.`);
    if (EXERCISES.has(kind)) this.hub.deep.task(paperId, kind as ReaderExerciseKind, input.key);
    if (kind === "deep") {
      const previous = [...this.state(paperId).writes.values()].filter((w) => w.kind === kind && w.key === input.key);
      if (previous.length >= 2 || previous.some((w) => w.grade === 2 || w.appealPending || (w.sent && w.grade === undefined))) throw new Error("Mỗi câu đào sâu được sửa một lần sau khi có nhận xét.");
    }
    const units = this.units(paperId);
    const unit = input.unit ? units.find((u) => u.id === input.unit) : undefined;
    if ((kind === "recall" || kind === "explain" || kind === "qalmri") && !unit) throw new Error("Không rõ mục của checkpoint.");
    const doc = this.hub.doc(paperId);
    if ((kind === "figure" || kind === "predict") && !doc.blocks.some((b) => b.id === input.key)) throw new Error("Không rõ hình hay bảng nào.");
    const fields = input.fields && typeof input.fields === "object"
      ? Object.fromEntries(Object.entries(input.fields).filter(([k, v]) => typeof v === "string" && v.trim() && /^[a-z]{1,20}$/.test(k)).map(([k, v]) => [k, v.trim().slice(0, FIELD_MAX)]))
      : undefined;
    const labels = kind === "5c" ? READER_FIVE_C : kind === "qalmri" ? READER_QALMRI : [];
    const text = (fields && Object.keys(fields).length
      ? labels.filter((l) => fields[l.key]).map((l) => `**${l.label}**: ${fields[l.key]}`).join("\n")
      : String(input.text ?? "")).trim().slice(0, WRITE_MAX);
    if (!text) throw new Error("Bài viết trống.");
    if (kind === "feynman" && text.split(/\s+/).length > 200) throw new Error("Bài Feynman tối đa 200 từ.");
    const id = `w-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const at = Date.now();
    const graded = GRADED.has(kind) && !!tutor;
    this.hub.store.append(paperId, {
      t: "r.write", at, id, kind, ...(unit ? { unit: unit.id } : {}), ...(input.key ? { key: input.key } : {}), text,
      ...(fields && Object.keys(fields).length ? { fields } : {}), ...(graded ? { sent: true } : {}),
    });
    if (graded) {
      const where = unit ? ` ${unitLabel(unit)}` : "";
      tutor!.send(`📝 ${WRITE_LABEL[kind]}${where}:\n\n${text}`, this.gradingBlock(paperId, id, kind, unit, input.key));
    }
    this.hub.learning(paperId, at);
    this.hub.touch(paperId);
    return { id, graded };
  }

  summary(paperId: string): MentorPaper["reader"] {
    if (!this.hub.has(paperId)) return undefined;
    const guide = this.guide(paperId);
    const view = this.hub.view(paperId);
    const sections = view.sections.filter((s) => !s.empty);
    const measured = guide.map.concepts.filter((c) => c.mastery !== undefined);
    const synthesis = guide.exercises?.find((t) => t.kind === "synthesis")?.write?.text;
    return {
      pass: guide.pass, total: sections.length, done: sections.filter((s) => s.read).length,
      ...(measured.length ? { mastery: measured.reduce((sum, c) => sum + c.mastery!, 0) / measured.length } : {}),
      weak: measured.filter((c) => c.mastery! < 0.6).sort((a, b) => a.mastery! - b.mastery!).slice(0, 3).map((c) => c.name),
      due: guide.cards?.filter((c) => c.due !== undefined && c.due <= Date.now()).length ?? 0,
      ...(synthesis ? { synthesis } : {}), ...(guide.deepUnderstood ? { deep: true } : {}),
    };
  }

  appeal(paperId: string, id: string, reason: string, tutor: ReaderTutorPort): void {
    const w = this.state(paperId).writes.get(id);
    if (!w || !GRADED.has(w.kind) || w.grade === undefined || w.appealed) throw new Error("Bài này chưa có điểm hoặc đã yêu cầu chấm lại.");
    const clean = String(reason ?? "").trim().slice(0, 1600);
    if (!clean) throw new Error("Viết lý do bạn muốn chấm lại.");
    const unit = w.unit ? this.units(paperId).find((u) => u.id === w.unit) : undefined;
    const rubric = this.gradingBlock(paperId, id, w.kind, unit, w.key);
    this.hub.store.append(paperId, { t: "r.appeal", at: Date.now(), write: id });
    tutor.send(`Chấm lại bài của mình.\n\nBài gốc:\n${w.text}\n\nĐiểm cũ: ${w.grade}/2\n\nLý do: ${clean}`, rubric);
    this.hub.touch(paperId);
  }

  /** The tutor's grade of a write (its `reader_grade`). */
  grade(paperId: string, writeId: string, g: { grade: ReaderGrade; parts?: { key: string; grade: ReaderGrade; note?: string }[]; missing?: string[]; feedback?: string }): ReaderWrite {
    const w = this.state(paperId).writes.get(writeId);
    if (!w) throw new Error(`No write "${writeId}" of the reader: grade the id given in <reader-grade write=…>.`);
    if (!GRADED.has(w.kind)) throw new Error(`A ${w.kind} write is not graded.`);
    if (w.grade !== undefined && !w.appealPending) throw new Error("Bài này đã có điểm và chưa có yêu cầu chấm lại.");
    this.hub.store.append(paperId, {
      t: "r.grade", at: Date.now(), write: w.id, grade: g.grade,
      ...(g.parts?.length ? { parts: g.parts.map((p) => ({ key: p.key, grade: p.grade, ...(p.note ? { note: p.note.slice(0, 400) } : {}) })) } : {}),
      ...(g.missing?.length ? { missing: g.missing.map((m) => m.slice(0, 300)).slice(0, 8) } : {}),
      ...(g.feedback ? { feedback: g.feedback.slice(0, 2000) } : {}),
    });
    this.hub.touch(paperId);
    return this.state(paperId).writes.get(w.id)!;
  }

  /** "Cho xem luôn": the answer of a waiting task, shown; the task does not count. */
  skip(paperId: string, task: string): ReaderGuide {
    const state = this.state(paperId);
    const exercise = task.startsWith("exercise:") && (task === "exercise:deep-plan" && state.pass === 3 || this.hub.deep.visible(paperId).some((t) => task === `exercise:${t.id}`));
    const widget = task.startsWith("widget:") && !!this.hub.widgets.read(paperId, task.slice(7))?.prediction;
    if (!exercise && !widget && !/^(5c|summary|(pretest|item|fig|predict):[\w.:-]{1,160}|[\w.-]{1,120}:(recall|explain|qalmri))$/.test(task)) throw new Error(`Không rõ việc "${task}".`);
    this.hub.store.append(paperId, { t: "r.skip", at: Date.now(), task });
    this.hub.touch(paperId);
    return this.guide(paperId);
  }

  report(paperId: string, itemId: string, reason: string): ReaderGuide {
    if (itemId.startsWith("widget:")) {
      if (!this.hub.widgets.read(paperId, itemId.slice(7))) throw new Error("Không còn ví dụ đó.");
    } else this.item(paperId, itemId);
    this.hub.store.append(paperId, { t: "r.report", at: Date.now(), item: itemId, reason: String(reason ?? "").trim().slice(0, 1000) || "(không nói lý do)" });
    this.hub.touch(paperId);
    return this.guide(paperId);
  }

  /** A misconception the tutor saw (its `reader_misconception`). */
  miss(paperId: string, concept: string, note: string): void {
    this.recordMiss(paperId, concept, note);
    this.hub.touch(paperId);
  }

  private recordMiss(paperId: string, concept: string, note: string, item?: string): void {
    const c = concept.trim().slice(0, 60) || "chung";
    const n = note.trim().slice(0, 400);
    if (!n) return;
    this.hub.store.append(paperId, { t: "r.miss", at: Date.now(), concept: c, note: n, ...(item ? { item } : {}) });
    try {
      this.host.misconception?.({ paperId, title: this.hub.meta(paperId).title, concept: c, note: n });
    } catch {
      // Mentor's book is extra: the paper's own book has it.
    }
  }

  // ------------------------------------------------------------------ what the tab sees

  guide(paperId: string): ReaderGuide {
    const view = this.hub.view(paperId);
    const state = this.state(paperId);
    const map = this.map(paperId);
    const doc = this.hub.doc(paperId);
    const readIds = new Set(view.sections.filter((s) => s.read).map((s) => s.id));
    const fivec = latestWrite(state, "5c");
    const mastery = conceptMastery(state, true);
    const units = this.units(paperId).map((u) => this.unitView(paperId, u, view, state, doc));
    const live = units.flatMap((u) => u.items.map((i) => i.id));
    const exercises = this.hub.deep.visible(paperId).map((exercise) => {
      const { id, kind, bloom, prompt, anchors } = exercise;
      const w = latestWrite(state, kind, undefined, id);
      return { id, kind, ...(bloom ? { bloom } : {}), prompt, anchors, ...this.hub.deep.references(paperId, exercise),
        ...(w ? { write: writeView(w) } : {}), ...(state.skipped.has(`exercise:${id}`) ? { skipped: true } : {}) };
    });
    const cards = this.hub.cards.views(paperId);
    const firstSpacedGrades = cards.filter((c) => c.kept).map((c) => state.cardReviews.get(c.id)?.[1]?.grade);
    const understood = state.goal === "deep" && state.passed.size === 4 && units.length > 0
      && units.every((u) => u.state === "ready" && (u.score.total === 0 ? !!u.light : u.score.firstRight / u.score.total >= 0.7))
      && exercises.filter((e) => e.kind === "deep" && e.write?.grade === 2 && !e.write.grading && !e.skipped).length >= 3
      && ["outline", "feynman", "review"].every((kind) => exercises.some((e) => e.kind === kind && (e.write?.grade ?? 0) >= 1 && !e.write?.grading && !e.skipped))
      && firstSpacedGrades.length >= 5 && firstSpacedGrades.every(Boolean)
      && firstSpacedGrades.filter((g) => g === "hard" || g === "good").length / firstSpacedGrades.length >= 0.8;
    const next = this.nextQuestion(state, units, mastery);
    const name = (id: string) => map.concepts?.find((c) => c.id === id)?.name ?? id;
    return {
      paperId,
      ...(state.goal ? { goal: state.goal } : {}),
      pass: state.pass,
      passed: [...state.passed].sort(),
      author: this.author.status(paperId),
      map: {
        has: {
          roles: !!map.roles?.length, fivec: !!map.fivec, concepts: !!map.concepts?.length, notation: !!map.notation?.length,
          background: map.background !== undefined, pretest: !!map.pretest?.length, units: !pagedDoc(doc) || !!map.units?.length,
        },
        roles: map.roles ?? [],
        concepts: (map.concepts ?? []).map((c) => {
          const m = mastery.get(c.id);
          return { id: c.id, name: c.name, ...(c.anchor ? { anchor: c.anchor } : {}), ...(m ? { mastery: m.mastery } : {}), answers: m?.answers ?? 0 };
        }),
        notation: map.notation ?? [],
        background: map.background ?? [],
        pretest: (map.pretest ?? []).map((p) => pretestView(p, state.pre.get(p.id), readIds.has(p.section) || state.skipped.has(`pretest:${p.id}`))),
        ...(map.fivec && fivec && (fivec.grade !== undefined || !fivec.sent) || state.skipped.has("5c") ? { fivec: map.fivec } : {}),
      },
      ...(fivec ? { fivec: writeView(fivec) } : {}),
      ...(latestWrite(state, "summary") ? { summary: writeView(latestWrite(state, "summary")!) } : {}),
      units,
      misses: state.misses.map((m) => ({ concept: m.concept, name: name(m.concept), note: m.note, at: m.at, ...(m.item ? { item: m.item } : {}) })).reverse(),
      again: live.filter((id) => isAgain(state.answers.get(id))),
      score: scoreOf(state, live),
      skipped: [...state.skipped].filter((t) => t === "5c" || t === "summary" || t.startsWith("pretest:") || t.startsWith("exercise:")),
      widgets: this.hub.widgets.views(paperId),
      widgetRequests: this.hub.widgets.requests(paperId).filter((r) => !this.hub.widgets.read(paperId, r.id)),
      exercises, cards, deepUnderstood: understood,
      ...(state.pass === 3 || state.pass === 4 ? { canFinish: this.canFinish(paperId, state.pass) } : {}),
      ...(next ? { nextQuestion: next } : {}),
    };
  }

  private nextQuestion(state: ReaderState, units: ReaderUnitView[], mastery: ReturnType<typeof conceptMastery>): string | undefined {
    const items = units.filter((u) => u.read && u.state === "ready").flatMap((u) => u.items);
    const since = Date.now() - DAY_MS;
    const target = new Map<string, number>();
    for (const item of items) {
      const delayed = (state.answers.get(item.id) ?? []).filter((a) => a.readAt !== undefined && a.at - a.readAt >= DAY_MS).at(-1);
      if (delayed?.correct && delayed.confidence >= 2) {
        const level = Math.min(READER_BLOOMS.length - 1, READER_BLOOMS.indexOf(item.bloom) + 1);
        target.set(item.concept, Math.max(level, target.get(item.concept) ?? 0));
      }
    }
    const distance = (item: ReaderItemView) => Math.abs(READER_BLOOMS.indexOf(item.bloom) - (target.get(item.concept) ?? 0));
    return items.filter((i) => !i.skipped && (!i.result || i.again || i.result.at <= since))
      .sort((a, b) => (mastery.get(a.concept)?.mastery ?? 0) - (mastery.get(b.concept)?.mastery ?? 0) || distance(a) - distance(b) || Number(!!b.again) - Number(!!a.again))[0]?.id;
  }

  private unitView(paperId: string, u: ReaderUnitDef, view: ReaderView, state: ReaderState, doc: ReaderDoc): ReaderUnitView {
    const pack = this.pack(paperId, u.id);
    const own = view.sections.filter((s) => u.sections.includes(s.id) && !s.empty);
    const read = own.length > 0 && own.every((s) => s.read);
    const author = pack ? { state: "ready" as const } : this.author.unitState(paperId, u.id);
    const skipped = (step: string) => state.skipped.has(`${u.id}:${step}`);
    const recall = latestWrite(state, "recall", u.id);
    const explained = latestWrite(state, "explain", u.id);
    const qalmriWrite = latestWrite(state, "qalmri", u.id);
    const open = (w: ReaderWrite | undefined, step: string) => skipped(step) || (!!w && (w.grade !== undefined || !w.sent));
    const items: ReaderItemView[] = (pack?.items ?? []).filter((i) => !state.reports.has(i.id)).map((i) => {
      const answers = state.answers.get(i.id);
      const last = answers?.[answers.length - 1];
      const skip = !last && state.skipped.has(`item:${i.id}`);
      return {
        ...itemView(i),
        ...(last ? { result: answerResult(i, last) } : skip ? { result: answerResult(i, { correct: false, confidence: 1, choice: {}, at: 0 }), skipped: true as const } : {}),
        ...(isAgain(answers) ? { again: true as const } : {}),
      };
    });
    const label = (id: string) => {
      const b = doc.blocks.find((x) => x.id === id);
      return b?.caption?.match(/^(Figure|Fig\.|Table)\s*[A-Z]?\d+/i)?.[0] ?? readerCiteLabel({ id }, view.sections);
    };
    const score: ReaderScore = scoreOf(state, items.map((i) => i.id));
    const done = !!pack && (!!recall || skipped("recall"))
      && (!pack.explain || !!explained || skipped("explain"))
      && (!pack.qalmri || !!qalmriWrite || skipped("qalmri"))
      && items.every((i) => i.result);
    return {
      id: u.id, ...(u.number ? { number: u.number } : {}), title: u.title, sections: u.sections, read,
      state: author.state === "preparing" || author.state === "failed" ? author.state : pack ? "ready" : "waiting",
      ...("error" in author && author.error ? { error: author.error } : {}),
      ...(pack ? { guide: pack.guide } : {}),
      ...(pack?.explain ? { explain: { anchor: pack.explain.anchor, prompt: pack.explain.prompt } } : {}),
      figures: (pack?.figures ?? []).map((f) => ({
        id: f.id, label: label(f.id), questions: f.questions,
        ...(latestWrite(state, "figure", undefined, f.id) || state.skipped.has(`fig:${f.id}`) ? { message: f.message } : {}),
      })),
      predicts: (pack?.predicts ?? []).map((p) => ({
        id: p.id, label: label(p.id), question: p.question,
        ...(latestWrite(state, "predict", undefined, p.id) || state.skipped.has(`predict:${p.id}`) ? { answer: p.answer } : {}),
      })),
      qalmri: !!pack?.qalmri,
      ...(pack?.qalmri && open(qalmriWrite, "qalmri") ? { qalmriRef: pack.qalmri } : {}),
      ...(pack && open(recall, "recall") ? { points: pack.points } : {}),
      ...(pack?.light ? { light: pack.light } : {}),
      items,
      ...(recall ? { recall: writeView(recall) } : {}),
      ...(explained ? { explained: writeView(explained) } : {}),
      ...(qalmriWrite ? { qalmriWrite: writeView(qalmriWrite) } : {}),
      skipped: ["recall", "explain", "qalmri"].filter(skipped),
      score,
      done,
    };
  }

  private unitDone(paperId: string, u: ReaderUnitDef): boolean {
    const view = this.hub.view(paperId);
    return this.unitView(paperId, u, view, this.state(paperId), this.hub.doc(paperId)).done;
  }

  // ------------------------------------------------------------------ what the tutor sees

  /**
   * The passes for the tutor's <reader-state>: the goal and pass, the tasks
   * waiting for the reader (their questions without the answers), the answers
   * already given (with what was right: the reader has seen it), writes still
   * to grade, weak concepts, misconceptions.
   */
  tutorState(paperId: string): string[] {
    const state = this.state(paperId);
    if (!state.goal) return ["Passes: the reader has not chosen why they read the paper yet (the reading tab asks them)."];
    const g = this.guide(paperId);
    const goal = READER_GOALS.find((x) => x.id === state.goal)!;
    const lines = [`Goal: ${goal.label} (${goal.detail}). Pass ${g.pass}: ${READER_PASS_LABEL[g.pass]}${g.passed.length ? `; done: ${g.passed.join(", ")}` : ""}.`];
    const waiting: string[] = [];
    if (g.pass === 1) {
      if (!g.fivec && !g.skipped.includes("5c")) waiting.push("their 5C (not written yet)");
      const guesses = g.map.pretest.filter((p) => !p.guess && !p.answer).length;
      if (guesses) waiting.push(`${guesses} pretest guess(es)`);
    }
    const unit = g.pass >= 2 ? this.currentUnit(g, state) : undefined;
    if (unit) {
      lines.push(`Unit in progress: ${unit.number ? `${unit.number} ` : ""}${unit.title} [[${unit.id}]]${unit.guide ? `; its guide question: “${unit.guide}”` : ""}.`);
      if (unit.state === "ready") {
        if (!unit.recall && !unit.skipped.includes("recall")) waiting.push("the recall of this unit (writing what it says from memory, the unit hidden)");
        if (unit.explain && !unit.explained && !unit.skipped.includes("explain")) waiting.push(`explaining [[${unit.explain.anchor}]] in their own words: “${unit.explain.prompt}”`);
        if (unit.qalmri && !unit.qalmriWrite && !unit.skipped.includes("qalmri")) waiting.push("the QALMRI sheet of this unit's experiment");
      }
    }
    // Every question still open, this unit's first: the reader may ask about any of them.
    if (g.pass >= 2) {
      for (const u of [...(unit ? [unit] : []), ...g.units.filter((x) => x !== unit)]) {
        for (const i of u.items.filter((x) => !x.result)) waiting.push(`question ${i.id}${u === unit ? "" : ` (${u.number ? `§${u.number}` : u.title})`}: “${clip(i.stem, 200)}”`);
      }
    }
    const exercises = (g.exercises ?? []).filter((e) => !e.skipped && (!e.write || e.kind === "deep" && !e.reference));
    waiting.unshift(...exercises.map((e) => `${e.kind} ${e.id}: “${clip(e.prompt, 200)}”`));
    if (waiting.length) {
      lines.push("Waiting for the reader (do NOT give these answers or the right option; if asked, help one rung at a time on the hint ladder: 0 a guiding question, 1 a direction, 2 part of the explanation, 3 the full explanation with an example — the reader can also press “Cho xem luôn”):");
      for (const w of waiting.slice(0, 16)) lines.push(`- ${w}`);
      if (waiting.length > 16) lines.push(`- … and ${waiting.length - 16} more`);
    }
    const answered = this.recentAnswers(paperId, state, 5);
    if (answered.length) {
      lines.push("Answered lately (the reader has seen the right answer; explain freely):");
      lines.push(...answered);
    }
    const grading = [...state.writes.values()].filter((w) => w.sent && w.grade === undefined || w.appealPending);
    if (grading.length) lines.push(`Writes still to grade with reader_grade: ${grading.map((w) => `${w.id} (${WRITE_LABEL[w.kind]})`).join(", ")}.`);
    const weak = g.map.concepts.filter((c) => c.mastery !== undefined && c.mastery < 0.6);
    if (weak.length) lines.push(`Weak concepts: ${weak.map((c) => `${c.name} (${Math.round(c.mastery! * 100)} %)`).join(", ")}.`);
    const due = g.cards?.filter((c) => c.kept && c.due !== undefined && c.due <= Date.now()).length ?? 0;
    if (due) lines.push(`Review cards due for this paper: ${due}. Ask the reader to recall before they flip a card.`);
    if (g.misses.length) lines.push(`Misconceptions shown: ${g.misses.slice(0, 5).map((m) => `${m.name}: ${clip(m.note, 120)}`).join(" · ")}.`);
    return lines;
  }

  /** The unit the reader is in, else the first not done. */
  private currentUnit(g: ReaderGuide, state: ReaderState): ReaderUnitView | undefined {
    return g.units.find((u) => state.at && u.sections.includes(state.at)) ?? g.units.find((u) => !u.done);
  }

  private recentAnswers(paperId: string, state: ReaderState, n: number): string[] {
    const items = new Map(this.items(paperId).map((i) => [i.id, i]));
    const last = [...state.answers].map(([id, list]) => ({ id, a: list[list.length - 1]! })).sort((x, y) => y.a.at - x.a.at).slice(0, n);
    return last.flatMap(({ id, a }) => {
      const item = items.get(id);
      if (!item) return [];
      const right = item.kind === "numeric" ? `${item.numeric?.value}` : item.options?.filter((o) => o.correct).map((o) => o.text).join(" / ") ?? "(see the question)";
      const miss = a.correct ? "" : misconceptionOf(item, a.choice);
      return [`- ${id} “${clip(item.stem, 140)}”: ${a.correct ? "right" : a.partly ? "half right" : "wrong"} (sure ${a.confidence}/3); right answer: ${clip(right, 160)}${miss ? `; their pick shows: ${clip(miss, 160)}` : ""}`];
    });
  }

  /** What the tutor gets with a write to grade: the rubric and the reference, now that the reader has written theirs. */
  private gradingBlock(paperId: string, id: string, kind: ReaderWriteKind, unit?: ReaderUnitDef, key?: string): string {
    const map = this.map(paperId);
    const pack = unit ? this.pack(paperId, unit.id) : null;
    const ref: string[] = [];
    let parts = "";
    let rubric = "2 = complete and right, with the why; 1 = partly (main idea there, pieces missing or vague); 0 = missing or wrong.";
    if (EXERCISES.has(kind)) {
      const task = this.hub.deep.task(paperId, kind as ReaderExerciseKind, key);
      rubric += `\n${task.rubric?.join("\n") ?? ""}`;
      if (task.reference) ref.push(task.reference);
      if (kind === "review") rubric += "\nGive your own brief review and compare it with theirs. A passing review identifies one assumption and one gap.";
      if (kind === "feynman") rubric += "\nRespond as a third-year student and ask a follow-up at the point that is still unclear.";
    }
    switch (kind) {
      case "5c":
        parts = ` parts: one per C (${READER_FIVE_C.map((c) => c.key).join(", ")}), each 0/1/2;`;
        rubric = "per C: 2 = says what the reference says in the reader's own words; 1 = partly; 0 = missing or wrong. The overall grade: 2 when most Cs are 2, 0 when most are 0.";
        if (map.fivec) for (const c of READER_FIVE_C) ref.push(`${c.label}: ${map.fivec[c.key]}`);
        break;
      case "recall":
        rubric = "2 = the unit's key points, in the reader's words, with what supports them; 1 = some key points, or no evidence; 0 = little of it, or wrong. Recall from memory is the point: do not grade wording.";
        for (const p of pack?.points ?? []) ref.push(`- ${p.text} [[${p.anchor}]]`);
        break;
      case "explain":
        rubric = "2 = explains WHY (what the line does and why it is needed, tied to what came before), covering the rubric; 1 = restates what it says without the why, or covers part of the rubric; 0 = wrong. Say plainly when the reader restated instead of explaining.";
        if (pack?.explain) {
          ref.push(`The place: [[${pack.explain.anchor}]] — “${pack.explain.prompt}”`);
          ref.push(...pack.explain.rubric.map((r) => `- must say: ${r}`));
          for (const m of pack.explain.misconceptions ?? []) ref.push(`- common misconception: ${m}`);
        }
        break;
      case "qalmri":
        parts = ` parts: one per field (${READER_QALMRI.map((q) => q.key).join(", ")}), each 0/1/2;`;
        if (pack?.qalmri) for (const q of READER_QALMRI) ref.push(`${q.label}: ${pack.qalmri[q.key]}`);
        break;
      case "summary":
        rubric = "2 = at most ~250 words, not the abstract retold, and it answers: the problem and why earlier ways fall short · the solution and why it is better · the evidence · the contributions · what is still open; 1 = some of these; 0 = few, or the abstract copied.";
        if (map.fivec) ref.push(`Contributions (reference): ${map.fivec.contributions}`);
        for (const u of this.units(paperId)) {
          const p = this.pack(paperId, u.id);
          if (p?.points.length) ref.push(`${unitLabel(u)}: ${p.points.map((x) => x.text).join(" · ")}`);
        }
        break;
    }
    return [
      `<reader-grade write="${id}" kind="${kind}"${unit ? ` unit="${unit.id}"` : ""}>`,
      `The reader wrote the above in their own words (${WRITE_LABEL[kind]}${unit ? `, ${unitLabel(unit)}` : ""}). Grade it, then call reader_grade(write: "${id}", grade,${parts} missing, feedback).`,
      `Rubric: ${rubric}`,
      ref.length ? `Reference (for grading only; the reader opens the example from the reading tab):\n${ref.join("\n")}` : "There is no written reference: grade against the paper (read it first).",
      "How: solve it yourself first; for each point quote the reader's own words (present / missing / wrong); length earns nothing; be specific about what is missing, with [[anchors]]; end with one follow-up question about the biggest gap instead of handing over the full answer. Reply in Vietnamese.",
      "</reader-grade>",
    ].join("\n");
  }

  private state(paperId: string): ReaderState {
    return this.hub.store.state(paperId);
  }
}

/** A paper whose sections are its PDF pages: its units come from the author. */
export function pagedDoc(doc: Pick<ReaderDoc, "sections">): boolean {
  return doc.sections.length > 0 && doc.sections.every((s) => s.id.startsWith("page-"));
}

/** Not read in pass 2: front matter, appendices, references, acknowledgements. */
function outOfPass(s: { id: string; title: string }): boolean {
  return s.id === "abstract" || s.id === "front" || /^A\d/.test(s.id) || /^bib/i.test(s.id) || /^(acknowledg|references|bibliography)/i.test(s.title.trim());
}

/** The units of an HTML paper: its numbered top sections with their subsections. */
export function defaultUnits(doc: Pick<ReaderDoc, "sections">): ReaderUnitDef[] {
  return doc.sections
    .filter((s) => s.level === 1 && !outOfPass(s))
    .map((s) => ({ id: s.id, title: s.title, ...(s.number ? { number: s.number } : {}), sections: [s.id, ...descendants(doc.sections, s.id)] }))
    .filter((u) => u.sections.some((id) => doc.sections.find((x) => x.id === id)!.blocks.length > 0));
}

function packFile(unit: string): string {
  return `items/${unit.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function unitLabel(u: Pick<ReaderUnitDef, "number" | "title">): string {
  return u.number ? `§${u.number} ${u.title}` : u.title;
}

function writeView(w: ReaderWrite): ReaderWriteView {
  return {
    id: w.id, kind: w.kind, ...(w.unit ? { unit: w.unit } : {}), ...(w.key ? { key: w.key } : {}), text: w.text, ...(w.fields ? { fields: w.fields } : {}), at: w.at,
    ...(w.grade !== undefined ? { grade: w.grade } : {}), ...(w.parts ? { parts: w.parts } : {}), ...(w.missing ? { missing: w.missing } : {}), ...(w.feedback ? { feedback: w.feedback } : {}),
    ...(w.sent && w.grade === undefined || w.appealPending ? { grading: true as const } : {}),
    ...(w.appealed ? { appealed: true } : {}),
  };
}

/** A choice as the item allows it: indices in range, the fields of its kind only. */
function cleanChoice(item: ReaderItem, c: ReaderChoice): ReaderChoice {
  const idx = (v: unknown, n: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < n ? (v as number) : null);
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => idx(x, n)).filter((x): x is number => x !== null) : []);
  switch (item.kind) {
    case "mcq":
    case "multi": {
      const options = [...new Set(list(c.options, item.options!.length))];
      if (!options.length) throw new Error("Chọn một phương án.");
      return { options: item.kind === "mcq" ? options.slice(0, 1) : options.sort((a, b) => a - b) };
    }
    case "twotier": {
      const options = list(c.options, item.options!.length).slice(0, 1);
      const reason = idx(c.reason, item.reasons!.length);
      if (!options.length || reason === null) throw new Error("Chọn cả đáp án và lý do.");
      return { options, reason };
    }
    case "numeric": {
      const value = Number(c.value);
      if (!Number.isFinite(value)) throw new Error("Nhập một con số.");
      return { value };
    }
    case "order": {
      const steps = list(c.steps, item.steps!.length);
      if (new Set(steps).size !== item.steps!.length) throw new Error("Xếp đủ các bước.");
      return { steps };
    }
    case "match": {
      const pairs = list(c.pairs, item.pairs!.length);
      if (pairs.length !== item.pairs!.length) throw new Error("Ghép đủ các cặp.");
      return { pairs };
    }
  }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
