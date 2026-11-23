import type { ReaderExerciseKind, ReaderExerciseView } from "@ainb/protocol";
import { z } from "zod";
import type { ReaderHub } from "./index.js";
import { EvidenceSchema } from "./items.js";
import { lintEvidence, nearDuplicate } from "./lint.js";
import { latestWrite } from "./model.js";

const rubric = z.array(z.string().trim().min(3).max(400)).min(2).max(8);
const anchors = z.array(EvidenceSchema).min(1).max(8);
const question = z.object({
  bloom: z.enum(["analyze", "evaluate", "create"]),
  prompt: z.string().trim().min(12).max(1600), reference: z.string().trim().min(12).max(3000), rubric, anchors,
});

export const DeepSchema = z.object({
  questions: z.array(question).min(5).max(8),
  derivation: z.object({
    prompt: z.string().trim().min(12).max(1600),
    steps: z.array(z.string().trim().min(3).max(600)).min(2).max(8),
    anchors,
  }).optional(),
  flaws: z.object({
    passage: z.string().trim().min(30).max(2800),
    mistakes: z.array(z.object({ correction: z.string().trim().min(5).max(450), evidence: EvidenceSchema })).min(2).max(3),
  }),
});

export interface Exercise extends Omit<ReaderExerciseView, "write" | "skipped"> {
  pass: 3 | 4;
  steps?: string[];
}

export class ReaderDeep {
  constructor(private readonly hub: ReaderHub) {}

  read(paperId: string) {
    return this.hub.store.readJson<z.infer<typeof DeepSchema>>(paperId, "deep.json");
  }

  save(paperId: string, draft: z.infer<typeof DeepSchema>): void {
    if (new Set(draft.questions.map((q) => q.bloom)).size !== 3) throw new Error("Include analyze, evaluate and create questions.");
    if (draft.questions.some((q, i) => draft.questions.slice(0, i).some((p) => nearDuplicate(p.prompt, q.prompt)))) throw new Error("Some questions duplicate each other.");
    const doc = this.hub.doc(paperId);
    if (doc.equations.length && !draft.derivation) throw new Error("Provide a worked derivation for an equation in the paper.");
    const errors = lintEvidence([...draft.questions.flatMap((q) => q.anchors), ...draft.flaws.mistakes.map((m) => m.evidence), ...(draft.derivation?.anchors ?? [])], doc);
    if (errors.length) throw new Error(errors.join("\n"));
    this.hub.store.writeJsonFile(paperId, "deep.json", draft);
    this.hub.touch(paperId);
  }

  exercises(paperId: string): Exercise[] {
    const doc = this.hub.doc(paperId);
    const d = this.read(paperId);
    const tasks: Exercise[] = (d?.questions ?? []).map((q, i) => ({ ...q, id: `deep-${i + 1}`, kind: "deep", pass: 3 }));
    if (d?.derivation) {
      const { prompt, anchors, steps } = d.derivation;
      tasks.unshift({ id: "derive", pass: 3, kind: "derive", prompt, anchors, steps, reference: steps.map((step, i) => `${i + 1}. ${step}`).join("\n"),
        rubric: ["Giải thích được vì sao từng bước đúng.", "Dẫn lại được phép biến đổi và nêu điều kiện áp dụng." ] });
    }
    if (d) tasks.push({
      id: "find-flaws", pass: 3, kind: "find-flaws", prompt: d.flaws.passage, anchors: [],
      reference: d.flaws.mistakes.map(({ correction, evidence }) => `- ${correction} [[${evidence.anchor}]]`).join("\n"),
      rubric: d.flaws.mistakes.map(({ correction }) => correction),
    });
    tasks.push(
      { id: "review", pass: 3, kind: "review", prompt: "Viết review một trang. Tóm tắt đóng góp, trình bày giả định, lập luận, dữ liệu và kết luận. Nêu hạn chế, hướng mở rộng và đánh giá tác động.", anchors: [],
        rubric: ["Tóm đúng đóng góp và chỉ ra ít nhất một giả định ngầm.", "Đánh giá bằng chứng và nêu một lỗ hổng thí nghiệm hoặc phân tích.", "Đề xuất hướng mở rộng cụ thể." ] },
      { id: "outline", pass: 3, kind: "outline", prompt: "Gập paper. Dựng lại sườn từ trí nhớ, ý chính mỗi mục, công thức và bảng then chốt.", anchors: [],
        reference: doc.sections.filter((s) => s.level === 1).map((s) => `- ${s.title} [[${s.id}]]`).join("\n"),
        rubric: ["Nhớ đúng thứ tự và lập luận chính.", "Đặt công thức và bảng then chốt vào đúng chỗ." ] },
      { id: "feynman", pass: 4, kind: "feynman", prompt: "Trong tối đa 200 từ, giải thích paper cho sinh viên năm ba. Định nghĩa mỗi thuật ngữ mới và đưa một ví dụ.", anchors: [],
        rubric: ["Nói đúng ý tưởng và lý do nó hoạt động.", "Định nghĩa thuật ngữ mới và dùng ví dụ cụ thể.", "Chỉ ra giới hạn của ví dụ." ] },
      { id: "synthesis", pass: 4, kind: "synthesis", prompt: "Viết 5 câu cho Tủ paper. Paper làm gì, mấu chốt là gì, bạn hiểu ra gì, còn nghi ngờ gì và sẽ thử gì tiếp?", anchors: [] },
    );
    return tasks;
  }

  task(paperId: string, kind: ReaderExerciseKind, id: string | undefined): Exercise {
    const state = this.hub.store.state(paperId);
    const task = this.exercises(paperId).find((x) => x.kind === kind && x.id === id);
    if (!task || state.pass < task.pass) throw new Error("Bài này chưa mở.");
    return task;
  }

  visible(paperId: string): Exercise[] {
    const state = this.hub.store.state(paperId);
    const exercises = this.exercises(paperId).filter((t) => t.pass <= state.pass);
    if (state.goal !== "use") return exercises;
    return exercises.filter((t) => t.pass === 4 || t.kind === "review" || (t.bloom === "evaluate" && t === exercises.find((e) => e.bloom === "evaluate")));
  }

  references(paperId: string, task: Exercise): Pick<ReaderExerciseView, "reference" | "rubric"> {
    const state = this.hub.store.state(paperId);
    const show = { ...(task.reference ? { reference: task.reference } : {}), ...(task.rubric ? { rubric: task.rubric } : {}) };
    if (state.skipped.has(`exercise:${task.id}`)) return show;
    const writes = [...state.writes.values()].filter((w) => w.key === task.id && w.kind === task.kind);
    const w = latestWrite(state, task.kind, undefined, task.id);
    if (task.steps) {
      const hidden = Math.min(task.steps.length, writes.filter((x) => x.grade !== undefined && x.grade >= 1).reduce((n, x) => n + (x.grade === 2 ? 2 : 1), 0));
      return { reference: task.steps.map((step, i) => `${i + 1}. ${i < task.steps!.length - hidden ? step : "…"}`).join("\n") };
    }
    if (!w || (w.sent && (w.grade === undefined || w.appealPending))) return {};
    if (task.kind === "deep" && w.grade !== 2 && writes.length < 2 && w.sent) return {};
    return show;
  }
}
