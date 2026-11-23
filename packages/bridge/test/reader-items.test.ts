// Easy-read's questions (E.6): the rules a question must pass before the
// reader sees it (each one), quotes found in the paper however they are
// spaced or typeset, near-duplicates; the question as the tab shows it
// (shuffled, no answer) and the grading of an answer.

import { afterAll, describe, expect, it } from "vitest";
import { findQuote, lintItem, lintMapPart, lintPack, loose, nearDuplicate } from "../src/reader/lint.js";
import { answerResult, gradeChoice, itemId, itemView, misconceptionOf, PackSchema, rightChoice, shuffled, type ItemInput, type ReaderItem } from "../src/reader/items.js";
import { defaultUnits } from "../src/reader/passes.js";
import { cleanShelves, LORA, LORA_ID, testHub } from "./fixtures/reader/fake-arxiv.js";
import { FORWARD_TWOTIER, MAP, PACK_S4, PARAMS_NUMERIC, ZERO_MCQ } from "./fixtures/reader/lora-guide.js";

afterAll(() => cleanShelves());

async function loraDoc() {
  const { hub } = testHub();
  await hub.open({ arxiv: LORA });
  return hub.doc(LORA_ID);
}

const asItem = (i: ItemInput, unit = "S4"): ReaderItem => ({ ...structuredClone(i), id: itemId(unit, i), unit });

describe("quotes are the paper's own words", () => {
  it("are found however spaced, typeset as TeX or as letters, and hyphenated", async () => {
    const doc = await loraDoc();
    expect(loose("$W_{0}x$ + \\Delta W")).toBe(loose("W0x + ΔW"));
    expect(findQuote(doc, "S4.SS1.p2", "We use a random Gaussian initialization for A and zero for B")?.id).toBe("S4.SS1.p2");
    expect(findQuote(doc, "S4.SS1.p2", "so ΔW = BA is zero at the beginning of training")?.id).toBe("S4.SS1.p2");
    expect(findQuote(doc, "S4.SS1.p2", "we use a random-Gaussian   initialization")?.id).toBe("S4.SS1.p2");
    // Pointed at the section: found in its paragraph.
    expect(findQuote(doc, "S4", "zero at the beginning of training")?.id).toBe("S4.SS1.p2");
    // Made up, or too short to tell.
    expect(findQuote(doc, "S4.SS1.p2", "We use an orthogonal initialization for B")).toBeNull();
    expect(findQuote(doc, "S4.SS1.p2", "zero for B")).toBeNull();
  });

  it("an evidence anchor next to its words is moved onto them", async () => {
    const doc = await loraDoc();
    const item = structuredClone(ZERO_MCQ);
    item.evidence = [{ anchor: "S4.SS1", quote: "so $\\Delta W=BA$ is zero at the beginning of training" }];
    expect(lintItem(item, doc)).toEqual([]);
    expect(item.evidence[0]!.anchor).toBe("S4.SS1.p2");
  });
});

describe("the rules of a question (Haladyna; E.6 check 1)", () => {
  const issues = async (change: (i: ItemInput) => void, base: ItemInput = ZERO_MCQ) => {
    const doc = await loraDoc();
    const item = structuredClone(base);
    change(item);
    return lintItem(item, doc, new Set(["zero-init", "low-rank-update", "frozen-weights"]));
  };

  it("passes the good ones", async () => {
    for (const item of [ZERO_MCQ, FORWARD_TWOTIER, PARAMS_NUMERIC]) expect(await issues(() => {}, item)).toEqual([]);
  });

  it("three options, at most four, exactly one right", async () => {
    expect(await issues((i) => { i.options = i.options!.slice(0, 2); })).toEqual([expect.stringContaining("3–4 are needed")]);
    expect(await issues((i) => { i.options![1]!.correct = true; })).toEqual([expect.stringContaining("exactly one must be right (2 are)")]);
    expect(await issues((i) => { i.options!.push({ text: "a", correct: false, why: "một hiểu sai khác" }, { text: "b", correct: false, why: "một hiểu sai khác nữa" }); })).toEqual([expect.stringContaining("3–4 are needed (there are 5)")]);
  });

  it("no “all / none of the above”, in English or Vietnamese", async () => {
    expect(await issues((i) => { i.options![2]!.text = "Tất cả các đáp án trên"; })).toEqual([expect.stringContaining("all/none of the above")]);
    expect(await issues((i) => { i.options![2]!.text = "None of the above"; })).toEqual([expect.stringContaining("all/none of the above")]);
    expect(await issues((i) => { i.options![2]!.text = "Không có phương án nào"; })).toEqual([expect.stringContaining("all/none of the above")]);
  });

  it("each wrong option says the misconception it stands for", async () => {
    expect(await issues((i) => { i.options![1]!.why = ""; })).toEqual([expect.stringContaining("needs its why")]);
  });

  it("the right option is not much longer than the others", async () => {
    expect(await issues((i) => { i.options![0]!.text = "Ma trận 0, vì B được khởi tạo bằng 0 nên tích BA bằng 0 ngay từ đầu"; })).toEqual([expect.stringContaining("much longer")]);
  });

  it("a positive stem; no two options alike", async () => {
    expect(await issues((i) => { i.stem = "Điều nào sau đây KHÔNG đúng về $\\Delta W$ lúc đầu?"; })).toEqual([expect.stringContaining("positively")]);
    expect(await issues((i) => { i.options![2]!.text = "Một ma trận  ngẫu nhiên."; })).toEqual([expect.stringContaining("two options say the same")]);
  });

  it("a two-tier question has a reason tier with one right reason and two misconceptions", async () => {
    expect(await issues((i) => { i.reasons = i.reasons!.slice(0, 2); }, FORWARD_TWOTIER)).toEqual([expect.stringContaining("reasons: 3–4 are needed")]);
    expect(await issues((i) => { i.reasons![0]!.correct = false; }, FORWARD_TWOTIER)).toEqual([expect.stringContaining("reasons: exactly one must be right (0 are)")]);
  });

  it("a quote the paper does not have is refused (E.6 check 2); the concept must be the map's", async () => {
    expect(await issues((i) => { i.evidence = [{ anchor: "S4.SS1.p2", quote: "We initialize B with the identity matrix scaled by alpha" }]; })).toEqual([expect.stringContaining("is not in the paper")]);
    expect(await issues((i) => { i.concept = "attention"; })).toEqual([expect.stringContaining('concept "attention" is not one of the map\'s concepts')]);
  });

  it("order and match have enough distinct parts", async () => {
    const order: ItemInput = { ...structuredClone(PARAMS_NUMERIC), kind: "order", steps: ["Đóng băng W₀", "Đóng băng W₀"] };
    delete order.numeric;
    expect(await issues(() => {}, order)).toEqual(["order: 3–7 steps are needed.", "order: two steps say the same."]);
  });
});

describe("a unit's checkpoint (E.6 checks 1, 4, 5)", () => {
  const unit = { id: "S4", title: "Our Method", number: "4", sections: ["S4", "S4.SS1"] };

  it("passes a good one; at least one question at apply or above; 3–6 questions unless light", async () => {
    const doc = await loraDoc();
    const pack = PackSchema.parse(structuredClone(PACK_S4));
    expect(lintPack(pack, { doc, unit, others: [] })).toEqual([]);
    const low = PackSchema.parse({ ...structuredClone(PACK_S4), items: [ZERO_MCQ, PARAMS_NUMERIC, { ...structuredClone(FORWARD_TWOTIER), bloom: "understand" }] });
    expect(lintPack(low, { doc, unit, others: [] })).toEqual([expect.stringContaining("apply or higher")]);
    const few = PackSchema.parse({ ...structuredClone(PACK_S4), items: [FORWARD_TWOTIER] });
    expect(lintPack(few, { doc, unit, others: [] })).toEqual([expect.stringContaining("3–6 questions are needed (there are 1)")]);
  });

  it("its places are in the unit; no near-duplicate of a question already there", async () => {
    const doc = await loraDoc();
    const pack = PackSchema.parse({ ...structuredClone(PACK_S4), explain: { anchor: "S2.E1", prompt: "?", rubric: ["x"] }, figures: [{ id: "S1.F1", questions: [], message: "m" }] });
    expect(lintPack(pack, { doc, unit, others: [] })).toEqual([`explain: "S2.E1" is not in this unit.`, `figures: "S1.F1" is not a figure or table of this unit.`]);
    const twice = PackSchema.parse(structuredClone(PACK_S4));
    const other = asItem({ ...structuredClone(ZERO_MCQ), stem: "Lúc bắt đầu huấn luyện, phần cập nhật $\\Delta W$ của LoRA bằng bao nhiêu?" }, "S2");
    expect(lintPack(twice, { doc, unit, others: [other] })).toEqual([expect.stringContaining("says nearly the same as a question of unit S2")]);
    expect(nearDuplicate("Vì sao B bằng 0?", "LoRA có bao nhiêu tham số?")).toBe(false);
  });

  it("the units of an HTML paper are its numbered top sections, without the abstract and appendices", async () => {
    const doc = await loraDoc();
    expect(defaultUnits(doc).map((u) => [u.id, u.sections])).toEqual([["S1", ["S1"]], ["S2", ["S2"]], ["S4", ["S4", "S4.SS1"]]]);
  });

  it("the map's parts point at the paper", async () => {
    const doc = await loraDoc();
    expect(lintMapPart("roles", { roles: [{ anchor: "S9.p1", role: "result" }] }, doc)).toEqual([expect.stringContaining('no paragraph "S9.p1"')]);
    expect(lintMapPart("pretest", { pretest: [{ ...structuredClone(MAP.pretest![0]!), section: "S9" }] }, doc)).toEqual(['pretest 1: no section "S9".']);
    for (const part of ["roles", "concepts", "notation", "pretest"] as const) expect(lintMapPart(part, structuredClone(MAP), doc)).toEqual([]);
  });
});

describe("a question in the tab", () => {
  it("shows its options shuffled, the same way every time, never in the author's order, and with no answer", () => {
    const item = asItem(ZERO_MCQ);
    const view = itemView(item);
    expect(view.options).toHaveLength(3);
    expect(view.options).not.toEqual(ZERO_MCQ.options!.map((o) => o.text));
    expect(itemView(item)).toEqual(view);
    expect(JSON.stringify(view)).not.toMatch(/correct|why|B = 0 nên/);
    expect(shuffled("x", 1)).toEqual([0]);
    for (let n = 2; n < 6; n++) expect(shuffled(`id${n}`, n)).not.toEqual([...Array(n).keys()]);
  });

  it("grades an answer as the reader saw it: both tiers of a two-tier question, a number within its tolerance", () => {
    const mcq = asItem(ZERO_MCQ);
    const right = rightChoice(mcq).options![0]!;
    expect(gradeChoice(mcq, { options: [right] })).toEqual({ correct: true });
    expect(gradeChoice(mcq, { options: [(right + 1) % 3] })).toEqual({ correct: false });
    const two = asItem(FORWARD_TWOTIER);
    const r = rightChoice(two);
    expect(gradeChoice(two, { options: r.options, reason: r.reason })).toEqual({ correct: true });
    expect(gradeChoice(two, { options: r.options, reason: (r.reason! + 1) % 3 })).toEqual({ correct: false, partly: true });
    const num = asItem(PARAMS_NUMERIC);
    expect(gradeChoice(num, { value: 4.74 })).toEqual({ correct: true });
    expect(gradeChoice(num, { value: 4.8 })).toEqual({ correct: false });
  });

  it("once answered, says why each option is right or wrong, and the misconception of the one picked", () => {
    const mcq = asItem(ZERO_MCQ);
    const right = rightChoice(mcq).options![0]!;
    const wrong = [0, 1, 2].find((i) => i !== right)!;
    const result = answerResult(mcq, { correct: false, confidence: 3, choice: { options: [wrong] }, at: 1 });
    expect(result.points).toBe(-6);
    expect(result.right.options).toEqual([right]);
    expect(result.why![right]).toBe("B = 0 nên BA = 0");
    expect(misconceptionOf(mcq, { options: [wrong] })).toBe(result.why![wrong]);
    expect(misconceptionOf(mcq, { options: [right] })).toBeNull();
  });
});
