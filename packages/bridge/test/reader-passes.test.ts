// Easy-read's passes 1–2 (ER-2) with a scripted author and checker: the goal
// starts the map; pass 2 has each unit's checkpoint written one step ahead,
// solved blind by a checker, sent back when it disagrees; the reader answers
// (points by confidence, wrong-and-sure into the misconception book, back
// until right), writes (graded by the tutor against a reference it gets only
// then), skips, reports. Neither the tab nor the tutor sees an answer still
// waiting for the reader.

import { afterAll, describe, expect, it, vi } from "vitest";
import { READER_FIVE_C } from "@ainb/protocol";
import { ReaderChat } from "../src/reader/chat.js";
import type { ReaderCheckerRole } from "../src/reader/checker.js";
import { itemId, rightChoice, type ReaderItem } from "../src/reader/items.js";
import { cleanShelves, LORA, LORA_ID, testHub } from "./fixtures/reader/fake-arxiv.js";
import { checkerAnswer, FORWARD_TWOTIER, lightPack, MAP, PACK_S4, PARAMS_NUMERIC, scriptedAuthor, toolCtx, ZERO_MCQ, type ScriptCall } from "./fixtures/reader/lora-guide.js";

afterAll(() => cleanShelves());

const ZERO_ID = itemId("S4", ZERO_MCQ);
const NUMERIC_ID = itemId("S4", PARAMS_NUMERIC);
const FIXED_ZERO = { ...structuredClone(ZERO_MCQ), stem: "Ngay khi bắt đầu huấn luyện, tích $BA$ của LoRA bằng gì?" };

interface Behaviour {
  /** Questions the checker answers wrong, each time it sees them. */
  wrong?: Set<string>;
  /** The author fixes what the checker gave back. */
  fixes?: boolean;
  /** The checker does not answer at all. */
  silentChecker?: boolean;
}

function author(b: Behaviour = {}) {
  const checked: string[][] = [];
  const script = async (c: ScriptCall) => {
    if (c.kind === "checker") {
      const role = c.role as ReaderCheckerRole;
      checked.push(role.batch.map((i) => i.id));
      if (b.silentChecker) return;
      // It reads the table question as understanding, not recall (E.6 check 4).
      await c.run("reader_check_write", { answers: role.batch.map((i: ReaderItem) => ({ ...checkerAnswer(i, rightChoice(i), !!b.wrong?.has(i.id)), ...(i.id === NUMERIC_ID ? { bloom: "understand" } : {}) })) });
      return;
    }
    if (c.context.includes('kind="map"')) await c.run("reader_map_write", MAP);
    const unit = c.context.match(/kind="checkpoint" unit="([^"]+)"/)?.[1];
    if (unit) await c.run("reader_items_write", unit === "S4" ? PACK_S4 : lightPack(unit, unit === "S1" ? "S1.p1" : "S2.p1"));
    if (c.context.includes('kind="fix"') && b.fixes) await c.run("reader_items_fix", { unit: "S4", fixes: [{ id: ZERO_ID, item: FIXED_ZERO }] });
  };
  return { ...scriptedAuthor(script), checked };
}

async function reading(b: Behaviour = {}) {
  const a = author(b);
  const misconception = vi.fn();
  const t = testHub(undefined, { author: () => a.host, misconception });
  await t.hub.open({ arxiv: LORA });
  const idle = () => vi.waitFor(() => expect(t.hub.author.status(LORA_ID).state).not.toBe("running"), { timeout: 3000, interval: 10 });
  return { ...t, a, misconception, idle, passes: t.hub.passes };
}

/** Choose a goal, let the map be written, go to pass 2, reach §4, let its checkpoint be written. */
async function inPass2(b: Behaviour = {}) {
  const r = await reading(b);
  r.passes.goal(LORA_ID, "deep");
  await r.idle();
  r.passes.pass(LORA_ID, 2);
  await r.idle();
  r.hub.progress(LORA_ID, "S4.SS1", 1000);
  await r.idle();
  return r;
}

describe("pass 1: the map", () => {
  it("is written by the author once the reader says why they read; the tab sees each part", async () => {
    const r = await reading();
    expect(r.passes.guide(LORA_ID)).toMatchObject({ pass: 1, author: { state: "idle", queued: 0 }, map: { has: { roles: false, pretest: false } } });
    r.passes.goal(LORA_ID, "use");
    await r.idle();
    const g = r.passes.guide(LORA_ID);
    expect(g.goal).toBe("use");
    expect(g.map.has).toEqual({ roles: true, fivec: true, concepts: true, notation: true, background: true, pretest: true, units: true });
    expect(g.map.concepts.map((c) => c.id)).toEqual(["zero-init", "low-rank-update", "frozen-weights"].sort((x, y) => MAP.concepts!.findIndex((c) => c.id === x) - MAP.concepts!.findIndex((c) => c.id === y)));
    expect(r.a.sent).toEqual([expect.objectContaining({ kind: "author", text: "Soạn bản đồ paper." })]);
    expect(r.a.open()).toBe(0);
    expect(r.hub.view(LORA_ID)).toMatchObject({ goal: "use", pass: 1 });
  });

  it("refuses a part that breaks a rule, keeps the others, and says what is still missing", async () => {
    const r = await reading();
    const text = r.hub.author.writeMap(LORA_ID, { concepts: MAP.concepts, roles: [{ anchor: "S9.p1", role: "result" }, ...MAP.roles!.slice(1)] });
    expect(text).toContain("Saved: concepts");
    expect(text).toContain('roles: no paragraph "S9.p1"');
    expect(text).toContain("Still missing: roles, fivec, notation, background, pretest.");
    expect(r.hub.author.writeMap(LORA_ID, { units: [{ title: "x", sections: ["S1"] }] })).toContain("its units are its top sections");
  });

  it("gives up after three turns without the map, says why, and tries again when asked", async () => {
    const a = scriptedAuthor(() => {});
    const t = testHub(undefined, { author: () => a.host });
    await t.hub.open({ arxiv: LORA });
    t.hub.passes.goal(LORA_ID, "gist");
    await vi.waitFor(() => expect(t.hub.author.status(LORA_ID).state).toBe("failed"), { timeout: 3000, interval: 10 });
    expect(a.sent.map((s) => s.text)).toEqual(["Soạn bản đồ paper.", expect.stringContaining("Bản đồ còn thiếu: roles"), expect.stringContaining("Bản đồ còn thiếu")]);
    expect(t.hub.author.status(LORA_ID).error).toContain("Bản đồ paper: chưa viết xong bản đồ");
    t.hub.author.retry(LORA_ID);
    expect(t.hub.author.status(LORA_ID).state).toBe("running");
    t.hub.author.stop(LORA_ID);
    await vi.waitFor(() => expect(t.hub.author.status(LORA_ID).state).toBe("stopped"), { timeout: 3000, interval: 10 });
  });

  it("opens a pretest answer once its section is read; a guess is kept", async () => {
    const r = await reading();
    r.passes.goal(LORA_ID, "use");
    await r.idle();
    const [pre] = r.passes.guide(LORA_ID).map.pretest;
    expect(pre!.answer).toBeUndefined();
    expect(JSON.stringify(pre)).not.toContain("B = 0, nên");
    r.passes.pretest(LORA_ID, pre!.id, { option: 1 });
    r.hub.mark(LORA_ID, "S4.SS1", true);
    const opened = r.passes.guide(LORA_ID).map.pretest[0]!;
    expect(opened.guess).toEqual({ option: 1 });
    expect(opened.options![opened.answer!.right!]).toBe("Bằng 0");
  });
});

describe("pass 2: checkpoints, one step ahead, solved blind", () => {
  it("writes the first units when pass 2 starts, and the next one as the reader reaches it", async () => {
    const r = await inPass2();
    const g = r.passes.guide(LORA_ID);
    expect(g.passed).toEqual([1]);
    expect(g.units.map((u) => [u.id, u.state, u.items.length])).toEqual([["S1", "ready", 0], ["S2", "ready", 0], ["S4", "ready", 3]]);
    expect(r.a.sent.filter((s) => s.kind === "author").map((s) => s.text)).toEqual([
      "Soạn bản đồ paper.", "Soạn checkpoint §1 Introduction.", "Soạn checkpoint §2 Problem Statement.", "Soạn checkpoint §4 Our Method.",
    ]);
    // The checker saw §4's three questions, and never their answers.
    expect(r.a.checked).toEqual([[ZERO_ID, itemId("S4", FORWARD_TWOTIER), NUMERIC_ID]]);
    const toChecker = r.a.sent.find((s) => s.kind === "checker")!.context;
    expect(toChecker).toContain("[S4.SS1.p2] We use a random Gaussian initialization");
    expect(toChecker).not.toMatch(/"correct"|B = 0 nên BA = 0|Nghĩ A ngẫu nhiên/);
    const s4 = g.units[2]!;
    expect(s4).toMatchObject({ guide: "Đọc mục này để trả lời: vì sao B được khởi tạo bằng 0?", explain: { anchor: "S4.E3" }, qalmri: false, read: false, done: false });
    expect(s4.figures).toEqual([{ id: "S4.F2", label: "Figure 2", questions: [] }]);
    expect(s4.predicts).toEqual([{ id: "S4.T1", label: "Table 1", question: "LoRA cần nhiều hay ít tham số so với fine-tune toàn bộ?" }]);
  });

  it("sends a question the checker answers otherwise back to the author, and keeps the fixed one", async () => {
    const r = await inPass2({ wrong: new Set([ZERO_ID]), fixes: true });
    const fix = r.a.sent.find((s) => s.context.includes('kind="fix"'))!;
    expect(fix.context).toContain(`${ZERO_ID} “Lúc bắt đầu huấn luyện`);
    expect(fix.context).toContain("the checker answered");
    const fixedId = itemId("S4", FIXED_ZERO);
    expect(r.a.checked.slice(-1)).toEqual([[fixedId]]);
    const ids = r.passes.guide(LORA_ID).units[2]!.items.map((i) => i.id);
    expect(ids).toContain(fixedId);
    expect(ids).not.toContain(ZERO_ID);
    expect(r.passes.pack(LORA_ID, "S4")!.checked).toBe(true);
  });

  it("relabels a question's level as the checker sees it", async () => {
    const r = await inPass2();
    const numeric = r.passes.pack(LORA_ID, "S4")!.items.find((i) => i.id === NUMERIC_ID)!;
    expect([numeric.bloom, numeric.authorBloom]).toEqual(["understand", "remember"]);
    expect(r.passes.guide(LORA_ID).units[2]!.items.find((i) => i.id === NUMERIC_ID)!.bloom).toBe("understand");
  });

  it("drops a question the author does not fix", async () => {
    const r = await inPass2({ wrong: new Set([NUMERIC_ID]) });
    const pack = r.passes.pack(LORA_ID, "S4")!;
    expect(pack.items.map((i) => i.id)).toEqual([ZERO_ID, itemId("S4", FORWARD_TWOTIER)]);
  });

  it("marks the questions unchecked when the checker cannot answer", async () => {
    const r = await inPass2({ silentChecker: true });
    const pack = r.passes.pack(LORA_ID, "S4")!;
    expect(pack.checked).toBe(false);
    expect(pack.items.every((i) => i.unchecked)).toBe(true);
    expect(r.a.sent.filter((s) => s.kind === "checker").map((s) => s.text)).toEqual(["Giải mù các câu hỏi này.", "Write your answers with reader_check_write."]);
  });
});

describe("the reader's answers", () => {
  it("are graded with points by confidence; wrong and sure goes to the misconception book and Mentor's; a wrong one comes back until right", async () => {
    const r = await inPass2();
    const view = r.passes.guide(LORA_ID).units[2]!.items.find((i) => i.id === ZERO_ID)!;
    expect(view.result).toBeUndefined();
    const right = view.options!.indexOf("Ma trận 0");
    const wrong = view.options!.indexOf("Một ma trận ngẫu nhiên");
    const first = r.passes.answer(LORA_ID, ZERO_ID, { options: [wrong] }, 3);
    expect(first).toMatchObject({ correct: false, points: -6, right: { options: [right] } });
    expect(first.why![wrong]).toBe("Nghĩ A ngẫu nhiên thì BA cũng ngẫu nhiên");
    let g = r.passes.guide(LORA_ID);
    expect(g.again).toEqual([ZERO_ID]);
    expect(g.misses).toEqual([expect.objectContaining({ concept: "zero-init", name: "Khởi tạo B = 0", note: "Nghĩ A ngẫu nhiên thì BA cũng ngẫu nhiên", item: ZERO_ID })]);
    expect(r.misconception).toHaveBeenCalledWith({ paperId: LORA_ID, title: "LoRA: Low-Rank Adaptation of Large Language Models", concept: "zero-init", note: "Nghĩ A ngẫu nhiên thì BA cũng ngẫu nhiên" });
    // A guess that missed is not a misconception.
    r.passes.answer(LORA_ID, NUMERIC_ID, { value: 7 }, 1);
    expect(r.passes.guide(LORA_ID).misses).toHaveLength(1);
    r.passes.answer(LORA_ID, ZERO_ID, { options: [right] }, 2);
    g = r.passes.guide(LORA_ID);
    expect(g.again).toEqual([NUMERIC_ID]);
    expect(g.units[2]!.score).toEqual({ answered: 2, total: 3, firstRight: 0, points: -6 + 0 + 2, max: 9, sureWrong: 1, luckyRight: 0 });
    expect(g.map.concepts.find((c) => c.id === "zero-init")).toMatchObject({ mastery: 1, answers: 2 });
    expect(() => r.passes.answer(LORA_ID, ZERO_ID, { options: [9] }, 2)).toThrow("Chọn một phương án.");
  });

  it("a reported question is withdrawn; a skipped one shows its answer and counts for nothing", async () => {
    const r = await inPass2();
    r.passes.report(LORA_ID, NUMERIC_ID, "Bảng không ghi đơn vị");
    r.passes.skip(LORA_ID, `item:${ZERO_ID}`);
    const s4 = r.passes.guide(LORA_ID).units[2]!;
    expect(s4.items.map((i) => i.id)).toEqual([ZERO_ID, itemId("S4", FORWARD_TWOTIER)]);
    expect(s4.items[0]).toMatchObject({ skipped: true, result: { points: 0, right: { options: [s4.items[0]!.options!.indexOf("Ma trận 0")] } } });
    expect(s4.score.answered).toBe(0);
    expect(() => r.passes.answer(LORA_ID, NUMERIC_ID, { value: 4.7 }, 1)).toThrow("rút khỏi bộ");
    expect(() => r.passes.skip(LORA_ID, "rm -rf")).toThrow("Không rõ việc");
  });

  it("the checkpoint is through once each step is done or skipped", async () => {
    const r = await inPass2();
    const done = () => r.passes.guide(LORA_ID).units[2]!.done;
    r.passes.write(LORA_ID, { kind: "recall", unit: "S4", text: "LoRA học BA hạng thấp." });
    r.passes.skip(LORA_ID, "S4:explain");
    for (const id of [ZERO_ID, itemId("S4", FORWARD_TWOTIER)]) r.passes.skip(LORA_ID, `item:${id}`);
    expect(done()).toBe(false);
    r.passes.answer(LORA_ID, NUMERIC_ID, { value: 4.7 }, 2);
    expect(done()).toBe(true);
  });
});

describe("what the tab and the tutor see", () => {
  it("no answer, reference or key point of a task still waiting; after the reader's turn, all of it", async () => {
    const r = await inPass2();
    const before = JSON.stringify(r.passes.guide(LORA_ID));
    for (const secret of ['"correct"', "B = 0 nên BA = 0", "Nghĩ A ngẫu nhiên", "huấn luyện bắt đầu đúng từ mô hình gốc", "Các hướng học được", "Rất ít: 4.7M", "Phương pháp mới cho fine-tuning"]) expect(before).not.toContain(secret);
    const tutor = new ReaderChat(r.hub, LORA_ID);
    const state = tutor.state(true);
    expect(state).toContain("Goal: Hiểu sâu");
    expect(state).toContain(`question ${ZERO_ID}: “Lúc bắt đầu huấn luyện`);
    expect(state).toContain("do NOT give these answers");
    for (const secret of ["Ma trận 0", "B = 0 nên BA = 0", "huấn luyện bắt đầu đúng từ mô hình gốc", "W₀ giữ nguyên"]) expect(state).not.toContain(secret);
    const right = r.passes.guide(LORA_ID).units[2]!.items[0]!.options!.indexOf("Ma trận 0");
    r.passes.answer(LORA_ID, ZERO_ID, { options: [right] }, 3);
    const after = tutor.state(false);
    expect(after).toContain(`${ZERO_ID} “Lúc bắt đầu huấn luyện`);
    expect(after).toContain("right (sure 3/3); right answer: Ma trận 0");
    expect(after).not.toContain(`question ${ZERO_ID}:`);
    // Nothing changed: the state is not repeated.
    expect(tutor.state(false)).toBe("");
  });

  it("the reader's writing goes to the tutor with its rubric and reference; reader_grade records the grade, and the reference opens", async () => {
    const r = await inPass2();
    const send = vi.fn();
    const { id, graded } = r.passes.write(LORA_ID, { kind: "recall", unit: "S4", text: "Cập nhật là BA hạng thấp, B = 0 lúc đầu." }, { send });
    expect(graded).toBe(true);
    const [text, context] = send.mock.calls[0]! as [string, string];
    expect(text).toBe("📝 Nhớ lại §4 Our Method:\n\nCập nhật là BA hạng thấp, B = 0 lúc đầu.");
    expect(context).toContain(`<reader-grade write="${id}" kind="recall" unit="S4">`);
    expect(context).toContain("- B = 0 nên huấn luyện bắt đầu đúng từ mô hình gốc [[S4.SS1.p2]]");
    let s4 = r.passes.guide(LORA_ID).units[2]!;
    expect(s4.recall).toMatchObject({ id, grading: true });
    expect(s4.points).toBeUndefined();
    expect(new ReaderChat(r.hub, LORA_ID).state(true)).toContain(`Writes still to grade with reader_grade: ${id} (Nhớ lại)`);
    const tutor = new ReaderChat(r.hub, LORA_ID);
    const res = await tutor.runTool(toolCtx(), "reader_grade", { write: id, grade: 1, missing: ["chứng cứ"], feedback: "Bạn nói “BA hạng thấp” đúng, thiếu chứng cứ [[S4.SS1.p2]]." });
    expect(res.text).toContain("Graded");
    s4 = r.passes.guide(LORA_ID).units[2]!;
    expect(s4.recall).toMatchObject({ grade: 1, missing: ["chứng cứ"] });
    expect(s4.recall!.grading).toBeUndefined();
    expect(s4.points).toEqual(PACK_S4.points);
    expect((await tutor.runTool(toolCtx(), "reader_grade", { write: "w-nope", grade: 2, feedback: "x" })).isError).toBe(true);
  });

  it("a 5C goes to the tutor field by field; with no tutor it is kept and the reference opens at once", async () => {
    const r = await reading();
    r.passes.goal(LORA_ID, "gist");
    await r.idle();
    const send = vi.fn();
    const fields = Object.fromEntries(READER_FIVE_C.map((c) => [c.key, `ý của tôi về ${c.label}`]));
    r.passes.write(LORA_ID, { kind: "5c", fields }, { send });
    expect(send.mock.calls[0]![0]).toContain("**Category**: ý của tôi về Category\n**Context**:");
    expect(send.mock.calls[0]![1]).toContain("parts: one per C (category, context, correctness, contributions, clarity)");
    expect(send.mock.calls[0]![1]).toContain("Contributions: Một mô hình dùng chung");
    expect(r.passes.guide(LORA_ID).map.fivec).toBeUndefined();
    r.passes.write(LORA_ID, { kind: "5c", fields });
    expect(r.passes.guide(LORA_ID).map.fivec).toEqual(MAP.fivec);
    expect(() => r.passes.write(LORA_ID, { kind: "5c", text: "   " })).toThrow("Bài viết trống.");
  });

  it("the misconception the tutor saw goes into both books", async () => {
    const r = await reading();
    const tutor = new ReaderChat(r.hub, LORA_ID);
    await tutor.runTool(toolCtx(), "reader_misconception", { concept: "low-rank-update", note: "Nghĩ LoRA giảm hạng của W₀" });
    expect(r.passes.guide(LORA_ID).misses).toEqual([expect.objectContaining({ concept: "low-rank-update", note: "Nghĩ LoRA giảm hạng của W₀" })]);
    expect(r.misconception).toHaveBeenCalledTimes(1);
  });
});

describe("the passes' rules", () => {
  it("need a goal first; passes 3–4 come later; a finished pass is kept", async () => {
    const r = await reading();
    expect(() => r.passes.pass(LORA_ID, 2)).toThrow("Chọn mục tiêu đọc trước đã.");
    r.passes.goal(LORA_ID, "gist");
    await r.idle();
    expect(() => r.passes.pass(LORA_ID, 3)).toThrow("bước sau");
    expect(r.passes.pass(LORA_ID, 1, true).passed).toEqual([1]);
    expect(() => r.passes.goal(LORA_ID, "all" as never)).toThrow("Không rõ mục tiêu");
  });
});
