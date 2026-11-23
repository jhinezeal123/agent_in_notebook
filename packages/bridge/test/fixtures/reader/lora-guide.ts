// What an author would write for the LoRA mini paper (latexml-mini.html):
// its map, and checkpoints of its units (S1, S2, S4), every quote the
// paper's own words; and an author host whose "agent" is a script.

import type { ReaderBloom } from "@ainb/protocol";
import type { ChatRole } from "../../../src/chat-role.js";
import type { ToolContext, ToolResult } from "../../../src/notebook/tools.js";
import type { ReaderAuthorHost } from "../../../src/reader/author.js";
import { READER_SETTINGS } from "../../../src/reader/chat.js";
import type { ItemInput, MapInput, PackInput } from "../../../src/reader/items.js";

const why = (s: string) => s;

export const MAP: MapInput = {
  roles: [
    { anchor: "abstract1.1", role: "objective" },
    { anchor: "S1.p2", role: "contribution" },
    { anchor: "S4.SS1.p1", role: "method" },
  ],
  fivec: {
    category: "Phương pháp mới cho fine-tuning hiệu quả [[S4]].",
    context: "Dựa trên việc thích nghi một mô hình lớn cho nhiều ứng dụng [[S1.p1]].",
    correctness: "Giả định cập nhật có hạng thấp [[S4.SS1.p1]].",
    contributions: "Một mô hình dùng chung với nhiều module LoRA nhỏ, không thêm độ trễ [[S1.p2]].",
    clarity: "Rõ, có công thức (3) [[S4.E3]].",
  },
  concepts: [
    { id: "low-rank-update", name: "Cập nhật hạng thấp ΔW = BA", anchor: "S4.SS1.p1" },
    { id: "zero-init", name: "Khởi tạo B = 0", anchor: "S4.SS1.p2" },
    { id: "frozen-weights", name: "Trọng số gốc đóng băng", anchor: "abstract1.1" },
  ],
  notation: [
    { symbol: "W_0", meaning: "trọng số đã huấn luyện trước, đóng băng", shape: "d×k", anchor: "S4.SS1.p1" },
    { symbol: "\\Delta W = BA", meaning: "phần cập nhật, hạng thấp", anchor: "S4.E3" },
  ],
  background: [{ name: "Hạng của ma trận", why: "ΔW được giả định có hạng thấp", explain: "Số cột độc lập tuyến tính." }],
  pretest: [
    {
      section: "S4.SS1",
      stem: "Theo bạn, ma trận B của LoRA nên được khởi tạo thế nào?",
      options: [
        { text: "Bằng 0", correct: true, why: why("Để ΔW = 0 lúc đầu") },
        { text: "Ngẫu nhiên Gaussian", correct: false, why: why("Nhầm cách khởi tạo của A với B") },
        { text: "Bằng chính W₀", correct: false, why: why("Nhầm phần cập nhật với trọng số gốc") },
      ],
      answer: "B = 0, nên ΔW = BA = 0 lúc bắt đầu.",
      explain: "Paper khởi tạo A ngẫu nhiên, B bằng 0 [[S4.SS1.p2]].",
      evidence: [{ anchor: "S4.SS1.p2", quote: "zero for $B$, so $\\Delta W=BA$ is zero at the beginning of training" }],
    },
    {
      section: "S1",
      stem: "Dùng chung một mô hình cho nhiều tác vụ thì mỗi tác vụ cần thêm gì?",
      answer: "Một module LoRA nhỏ.",
      explain: "Đóng góp đầu tiên của paper [[S1.p2]].",
      evidence: [{ anchor: "S1.p2", quote: "A shared model with many small LoRA modules." }],
    },
  ],
};

export const ZERO_MCQ: ItemInput = {
  concept: "zero-init", bloom: "understand", kind: "mcq",
  stem: "Lúc bắt đầu huấn luyện, phần cập nhật $\\Delta W$ của LoRA bằng gì?",
  options: [
    { text: "Ma trận 0", correct: true, why: "B = 0 nên BA = 0" },
    { text: "Một ma trận ngẫu nhiên", correct: false, why: "Nghĩ A ngẫu nhiên thì BA cũng ngẫu nhiên" },
    { text: "Chính ma trận $W_0$", correct: false, why: "Nhầm phần cập nhật với trọng số gốc" },
  ],
  evidence: [{ anchor: "S4.SS1.p2", quote: "so $\\Delta W=BA$ is zero at the beginning of training" }],
  explain: "B = 0 nên ΔW = BA = 0 [[S4.SS1.p2]].", difficulty: 2,
};

export const FORWARD_TWOTIER: ItemInput = {
  concept: "low-rank-update", bloom: "apply", kind: "twotier",
  stem: "Với đầu vào $x$, lúc bắt đầu fine-tune đầu ra $h$ của lớp so với mô hình gốc thế nào?",
  options: [
    { text: "Giống hệt mô hình gốc", correct: true, why: "BAx = 0" },
    { text: "Lệch một chút vì nhiễu", correct: false, why: "Quên rằng B = 0" },
    { text: "Bằng 0 vì chưa học", correct: false, why: "Quên rằng $W_0 x$ vẫn còn" },
  ],
  reasons: [
    { text: "Vì $h = W_0x + BAx$ và $BA = 0$", correct: true, why: "Đúng công thức (3)" },
    { text: "Vì $A = 0$ nên $BA = 0$", correct: false, why: "Nhầm vai trò A và B" },
    { text: "Vì hệ số scale làm $BA$ rất nhỏ", correct: false, why: "Nhầm scale với khởi tạo" },
  ],
  evidence: [{ anchor: "S4.SS1.p1", quote: "our modified forward pass yields: $$h=W_{0}x+\\Delta Wx=W_{0}x+BAx$$" }],
  explain: "h = W₀x + BAx [[S4.E3]] và BA = 0 lúc đầu [[S4.SS1.p2]].", difficulty: 3,
};

export const PARAMS_NUMERIC: ItemInput = {
  concept: "low-rank-update", bloom: "remember", kind: "numeric",
  stem: "Theo Bảng 1, LoRA có bao nhiêu triệu tham số huấn luyện?",
  numeric: { value: 4.7, tolerance: 0.05, measure: "triệu" },
  evidence: [{ anchor: "S4.T1", quote: "Table 1: Trainable parameters." }],
  explain: "Bảng 1 ghi 4.7M [[S4.T1]].", difficulty: 1,
};

export const PACK_S4: PackInput = {
  unit: "S4",
  guide: "Đọc mục này để trả lời: vì sao B được khởi tạo bằng 0?",
  points: [
    { text: "Cập nhật được viết thành tích hai ma trận hạng thấp BA", anchor: "S4.SS1.p1" },
    { text: "B = 0 nên huấn luyện bắt đầu đúng từ mô hình gốc", anchor: "S4.SS1.p2" },
  ],
  explain: { anchor: "S4.E3", prompt: "Dòng (3) làm gì, vì sao cần?", rubric: ["W₀ giữ nguyên, chỉ BA được học", "BA có hạng thấp nên ít tham số"] },
  figures: [{ id: "S4.F2", questions: [], message: "Các hướng học được ở hạng thấp trùng nhau nhiều." }],
  predicts: [{ id: "S4.T1", question: "LoRA cần nhiều hay ít tham số so với fine-tune toàn bộ?", answer: "Rất ít: 4.7M." }],
  items: [ZERO_MCQ, FORWARD_TWOTIER, PARAMS_NUMERIC],
};

/** A unit with nothing to check, as an author would write it. */
export function lightPack(unit: string, anchor: string): PackInput {
  return {
    unit, guide: "Mục này đặt bài toán gì?", light: "Mục ngắn, chỉ giới thiệu bối cảnh.",
    points: [{ text: "Bối cảnh của paper", anchor }, { text: "Vấn đề cần giải", anchor }],
    figures: [], predicts: [], items: [],
  };
}

/** What a tool needs of a chat; the notebook is never there. */
export function toolCtx(): ToolContext {
  return {
    settings: () => READER_SETTINGS, targets: () => [], waitMs: 1000, images: false,
    call: () => Promise.reject(new Error("no notebook here")),
    awaitReview: async () => "pending", confirmRun: async () => false,
  } as unknown as ToolContext;
}

export interface ScriptCall {
  kind: "author" | "checker";
  text: string;
  context: string;
  role: ChatRole;
  run(name: string, args: unknown): Promise<ToolResult>;
}

/** An author host whose agent is a script: each message sent runs it, in order. */
export function scriptedAuthor(script: (call: ScriptCall) => Promise<void> | void) {
  const sent: { kind: "author" | "checker"; text: string; context: string }[] = [];
  const results: ToolResult[] = [];
  let open = 0;
  const host: ReaderAuthorHost = {
    chat(_paperId, role, kind) {
      let turn: Promise<void> = Promise.resolve();
      open++;
      return {
        send(text, context) {
          sent.push({ kind, text, context });
          turn = turn.then(() => script({
            kind, text, context, role,
            run: async (name, args) => {
              const r = await role.runTool(toolCtx(), name, args);
              results.push(r);
              return r;
            },
          }));
        },
        whenIdle: async (signal) => {
          await Promise.race([turn, new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]);
        },
        close() {
          open--;
        },
      };
    },
  };
  return { host, sent, results, open: () => open };
}

/** The checker's blind answer to a question as it shows it: the right one, or the first wrong one. */
export function checkerAnswer(item: { id: string; kind: string; bloom: ReaderBloom }, right: { options?: number[]; reason?: number; value?: number; steps?: number[]; pairs?: number[] }, wrong = false) {
  const L = "ABCDEFGH";
  const pick = (i: number | undefined, n = 3) => L[wrong ? ((i ?? 0) + 1) % n : (i ?? 0)]!;
  return {
    id: item.id, bloom: item.bloom, note: wrong ? "The passage does not say this." : "From the passage.",
    ...(right.options ? { options: right.options.map((i) => pick(i)) } : {}),
    ...(right.reason !== undefined ? { reason: L[right.reason]! } : {}),
    ...(right.value !== undefined ? { value: wrong ? right.value + 1 : right.value } : {}),
    ...(right.steps ? { steps: right.steps.map((i) => i + 1) } : {}),
    ...(right.pairs ? { pairs: right.pairs.map((i) => L[i]!) } : {}),
  };
}
