import { afterAll, describe, expect, it } from "vitest";
import { DAY_MS, scheduleCard } from "../src/reader/cards.js";
import { DeepSchema } from "../src/reader/deep.js";
import { readerLab } from "../src/reader/lab.js";
import { checkWidget, WidgetSchema } from "../src/reader/widgets.js";
import { cleanShelves, LORA, LORA_ID, testHub } from "./fixtures/reader/fake-arxiv.js";
import { ZERO_MCQ } from "./fixtures/reader/lora-guide.js";

afterAll(cleanShelves);

const evidence = ZERO_MCQ.evidence[0]!;
const widget = WidgetSchema.parse({
  title: "Rank và tham số LoRA",
  explanation: "Đây là kích thước đồ chơi. Số tham số thay đổi tuyến tính theo rank.",
  evidence: [evidence],
  tryThis: ["Tăng rank từ 1 lên 2."],
  prediction: { question: "Số tham số biến đổi thế nào khi tăng rank gấp đôi?", choices: ["Tăng gấp đôi", "Giữ nguyên"], right: 0 },
  model: { params: [{ name: "r", label: "Rank", min: 1, max: 4, step: 1, init: 1 }], outputs: [{ label: "Tham số", expression: ["*", "r", 8] }] },
  tests: [{ name: "rank 1", inputs: { r: 1 }, output: 0, expected: 8 }, { name: "rank 2", inputs: { r: 2 }, output: 0, expected: 16 }],
});

describe("interactive examples", () => {
  it("keeps the model and answer private until the guess, then exposes a Python lab and allows reporting", async () => {
    const { hub } = testHub();
    await hub.open({ arxiv: LORA });
    const req = hub.widgets.request(LORA_ID, { id: evidence.anchor }, "Ảnh hưởng của rank");
    hub.widgets.save(LORA_ID, req, structuredClone(widget));
    expect(hub.passes.guide(LORA_ID).widgets?.[0]).not.toHaveProperty("model");
    expect(hub.passes.guide(LORA_ID).widgets?.[0]?.prediction).not.toHaveProperty("right");
    expect(() => readerLab(hub, LORA_ID, req.id)).toThrow("Mở ví dụ");
    expect(() => hub.widgets.answer(LORA_ID, req.id, 2)).toThrow("không hợp lệ");
    hub.widgets.answer(LORA_ID, req.id, 0);
    hub.widgets.answer(LORA_ID, req.id, 1);
    expect(hub.passes.guide(LORA_ID).widgets?.[0]).toMatchObject({ model: widget.model, result: { choice: 0, correct: true } });
    const lab = readerLab(hub, LORA_ID, req.id);
    expect(lab.map((c) => c.type)).toEqual(["markdown", "markdown", "code"]);
    expect(lab[2]?.source).toContain('(params["r"] * 8)');
    hub.passes.report(LORA_ID, `widget:${req.id}`, "Sai hình minh họa");
    expect(hub.passes.guide(LORA_ID).widgets).toEqual([]);
    expect(() => readerLab(hub, LORA_ID, req.id)).toThrow("Mở ví dụ");
  });

  it("rejects unknown operators, recursive depth and a failed invariant", () => {
    const unsafe = structuredClone(widget);
    unsafe.model.outputs[0]!.expression = ["eval", "r", 8];
    expect(() => checkWidget(unsafe)).toThrow("bounded expressions");
    let nested = unsafe.model.outputs[0]!.expression;
    for (let i = 0; i < 30; i++) nested = ["abs", nested];
    unsafe.model.outputs[0]!.expression = nested;
    expect(() => checkWidget(unsafe)).toThrow("bounded expressions");
    const wrong = structuredClone(widget);
    wrong.tests[1]!.expected = 24;
    expect(() => checkWidget(wrong)).toThrow("expected 24, got 16");
  });
});

describe("deep reading and recall", () => {
  it("advances to the later passes, withholds the sample until feedback, and permits one appeal", async () => {
    const { hub } = testHub();
    await hub.open({ arxiv: LORA });
    const { passes } = hub;
    passes.goal(LORA_ID, "deep");
    passes.pass(LORA_ID, 2);
    passes.pass(LORA_ID, 2, true);
    expect(() => passes.pass(LORA_ID, 4)).toThrow("Kết thúc lượt trước");
    passes.pass(LORA_ID, 3);
    const prompts = [
      "Vì sao khởi tạo ma trận B bằng 0 giữ được đầu ra?",
      "Dữ liệu cần thỏa điều kiện nào để dùng xấp xỉ rank thấp?",
      "Thí nghiệm nào phân biệt hiệu ứng rank và số bước?",
      "Cần kiểm tra tác động của ma trận tham số nào?",
      "Giải thích lý do có thể gộp hai ma trận lúc suy luận.",
    ];
    hub.deep.save(LORA_ID, DeepSchema.parse({
      questions: prompts.map((prompt, i) => ({
        prompt, bloom: ["analyze", "evaluate", "create"][i % 3], reference: "PHẦN MẪU CHỈ CHO SAU KHI LÀM XONG.",
        anchors: [evidence], rubric: ["Nêu cơ chế chính xác.", "Giải thích được nguyên nhân."],
      })),
      derivation: { prompt: "Dẫn lại số tham số của phép cập nhật.", steps: ["Đếm chiều của A.", "Cộng số phần tử của A và B."], anchors: [evidence] },
      flaws: { passage: "Tác giả đặt cả hai ma trận bằng 1 và thay đổi giá trị ban đầu của mô hình.", mistakes: [
        { correction: "Ma trận B bắt đầu bằng 0.", evidence },
        { correction: "Phần cập nhật ban đầu bằng 0.", evidence },
      ] },
    }));
    const guide = () => passes.guide(LORA_ID);
    const first = () => guide().exercises?.find((e) => e.id === "deep-1");
    expect(first()?.reference).toBeUndefined();
    expect(passes.tutorState(LORA_ID).join(" ")).not.toContain("PHẦN MẪU");
    const messages: string[] = [];
    const tutor = { send: (_: string, context: string) => messages.push(context) };
    const { id } = passes.write(LORA_ID, { kind: "deep", key: "deep-1", text: "Phép nhân với B ban đầu bằng 0." }, tutor);
    expect(messages[0]).toContain("PHẦN MẪU");
    expect(first()?.reference).toBeUndefined();
    passes.grade(LORA_ID, id, { grade: 1, feedback: "Nêu thêm cách gộp ma trận." });
    expect(first()?.reference).toBeUndefined();
    expect(() => passes.grade(LORA_ID, id, { grade: 2 })).toThrow("chấm lại");
    passes.appeal(LORA_ID, id, "Mình muốn kiểm tra nhận xét này.", tutor);
    passes.grade(LORA_ID, id, { grade: 2 });
    expect(first()?.reference).toContain("PHẦN MẪU");
    expect(() => passes.appeal(LORA_ID, id, "Lần nữa", tutor)).toThrow("đã yêu cầu");
    expect(guide().canFinish).toBe(false);
    passes.skip(LORA_ID, "exercise:review");
    passes.skip(LORA_ID, "exercise:outline");
    passes.pass(LORA_ID, 3, true);
    expect(passes.pass(LORA_ID, 4).exercises?.find((e) => e.kind === "feynman")).toBeDefined();
    expect(guide().deepUnderstood).toBe(false);
  });

  it("schedules review after five days and does not allow a premature second review", async () => {
    const { hub } = testHub();
    await hub.open({ arxiv: LORA });
    hub.cards.keep(LORA_ID, undefined, { front: "Rank liên hệ thế nào với số hệ số?", back: "Số hệ số tỉ lệ tuyến tính với rank.", evidence });
    const first = hub.cards.due()[0]!;
    const at = first.due!;
    hub.cards.review(LORA_ID, first.id, "good", at);
    expect(hub.cards.due(at + 4 * DAY_MS)).toEqual([]);
    expect(hub.cards.due(at + 5 * DAY_MS)[0]?.id).toBe(first.id);
    expect(() => hub.cards.review(LORA_ID, first.id, "good", at + DAY_MS)).toThrow("chưa đến hạn");
    hub.cards.review(LORA_ID, first.id, "again", at + 5 * DAY_MS);
    expect(hub.cards.due(at + 10 * DAY_MS)[0]?.id).toBe(first.id);
    expect(scheduleCard({ at }, [{ at, grade: "good" }, { at: at + 5 * DAY_MS, grade: "good" }])).toBe(at + 19 * DAY_MS);
  });
});
