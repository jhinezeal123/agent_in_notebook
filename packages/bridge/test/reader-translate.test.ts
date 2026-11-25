// Easy-read's Vietnamese translation: the reader's HTML cut into units with
// markers for what must not change (translate.ts), put back from a
// translation; and the translator (translator.ts) on a hub, its hidden chat
// scripted: what it is sent, what it saves, the lock, mode "off", stopping,
// units it gets wrong, and the reader's question asked in Vietnamese.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ReaderTranslationView } from "@ainb/protocol";
import type { ChatRole } from "../src/chat-role.js";
import type { ReaderAgentSettings, ReaderAuthorHost } from "../src/reader/author.js";
import { parseArxivHtml } from "../src/reader/doc.js";
import { assemble, batches, translationSource, type TranslationUnit } from "../src/reader/translate.js";
import { TRANSLATION_PAGE, TranslatorRole } from "../src/reader/translator.js";
import { cleanShelves, LORA, LORA_ID, testHub } from "./fixtures/reader/fake-arxiv.js";
import { toolCtx } from "./fixtures/reader/lora-guide.js";

afterAll(cleanShelves);

const PAGE = readFileSync(join(__dirname, "fixtures", "reader", "latexml-mini.html"), "utf8");
const DOC = parseArxivHtml(PAGE, "https://arxiv.org/html/2106.09685").html;

describe("cutting the page into units", () => {
  const s = translationSource(DOC);
  const unit = (start: string) => s.units.find((u) => u.text.startsWith(start))!;

  it("takes the title, headings, paragraphs, captions and footnotes, in the page's order; not the authors, tables of numbers or references", () => {
    expect(s.units.map((u) => u.kind)).toEqual(["title", "heading", "p", "heading", "caption", "p", "note", "p", "p", "p", "heading", "p", "heading", "p", "heading", "p", "heading", "p", "p", "caption", "caption", "heading", "p"]);
    expect(s.units.map((u) => u.n)).toEqual(s.units.map((_, i) => i + 1));
    const all = s.units.map((u) => u.text).join("\n");
    for (const kept of ["Edward Hu", "Params", "4.7M", "Radford et al., 2019", "Intrinsic Dimensionality", "References"]) expect(all, kept).not.toContain(kept);
  });

  it("turns formulas, citations, footnotes, section numbers and errors into markers, and says what each stands for", () => {
    const p = unit("For a pre-trained weight matrix");
    expect(p.text).toBe("For a pre-trained weight matrix ⟦1⟧, we constrain its update with a low-rank decomposition. For ⟦2⟧, our modified forward pass yields:");
    expect(p.refs).toEqual({ 1: "$W_{0}\\in\\mathbb{R}^{d\\times k}$", 2: "$h=W_{0}x$" });
    expect(p.atoms["1"]).toMatch(/^<math [^>]*alttext="W_\{0\}\\in\\mathbb\{R\}\^\{d\\times k\}"/);
    const intro = unit("Many applications");
    expect(intro.text).toBe("Many applications rely on adapting ⟦1⟧one⟦/1⟧ large-scale model ⟦2⟧.⟦3⟧ See ⟦4⟧this⟦/4⟧ and ⟦5⟧.");
    expect(intro.refs).toMatchObject({ 2: "(Radford et al., 2019)", 3: "[footnote, translated on its own]" });
    expect(intro.pairs["1"]).toEqual({ open: '<em class="ltx_emph">', close: "</em>" });
    expect(unit("⟦1⟧Low-Rank-Parametrized").refs).toEqual({ 1: "4.1" });
    expect(unit("We use a random").refs["4"]).toBe("\\reportnumber");
  });

  it("numbers each unit's element on the page (a footnote inside a paragraph keeps its own number), and gives the same units for the same page", () => {
    expect(s.html).toContain('<p class="ltx_p" data-er-u="12">We call the input dimension');
    const intro = unit("Many applications");
    const note = s.units.find((u) => u.kind === "note")!;
    expect(intro.atoms["3"]).toContain(`data-er-u="${note.n}"`);
    const again = translationSource(DOC);
    expect(again.hash).toBe(s.hash);
    expect(again.units).toEqual(s.units);
    expect(translationSource(DOC.replace("Few-shot", "Many-shot")).hash).not.toBe(s.hash);
  });

  it("puts a translation back: the pieces as they were, the words escaped", () => {
    const p = unit("For a pre-trained weight matrix");
    const html = assemble(p, "Với ma trận trọng số đã huấn luyện ⟦1⟧, ta ràng buộc cập nhật của nó <bằng> phân rã hạng thấp (low-rank). Với ⟦2⟧, lượt truyền xuôi trở thành:");
    expect(html).toContain(p.atoms["1"]!);
    expect(html).toContain(p.atoms["2"]!);
    expect(html).toContain("&lt;bằng&gt;");
    expect(html).not.toContain("⟦");
  });

  it("refuses a translation that loses, repeats or invents a piece, or summarizes", () => {
    const p = unit("For a pre-trained weight matrix");
    expect(() => assemble(p, "Với ma trận ⟦1⟧, ta ràng buộc cập nhật bằng phân rã hạng thấp. Lượt truyền xuôi trở thành:")).toThrow(/thiếu ⟦2⟧ \(\$h=W_\{0\}x\$\)/);
    expect(() => assemble(p, "Với ⟦1⟧ và ⟦1⟧, ta ràng buộc cập nhật bằng phân rã hạng thấp. Với ⟦2⟧, lượt truyền xuôi trở thành:")).toThrow(/⟦1⟧ xuất hiện hơn một lần/);
    expect(() => assemble(p, "Với ⟦1⟧ ⟦7⟧, ta ràng buộc cập nhật bằng phân rã hạng thấp. Với ⟦2⟧, lượt truyền xuôi trở thành:")).toThrow(/⟦7⟧ mà bản gốc không có/);
    expect(() => assemble(p, "Ma trận ⟦1⟧, ⟦2⟧.")).toThrow(/ngắn hơn hẳn/);
    expect(() => assemble(p, "  ")).toThrow(/trống/);
  });

  it("keeps formatting that nests, and drops it (keeping the words) when it does not", () => {
    const intro = unit("Many applications");
    const good = assemble(intro, "Nhiều ứng dụng dựa vào việc điều chỉnh ⟦1⟧một⟦/1⟧ mô hình lớn ⟦2⟧.⟦3⟧ Xem ⟦4⟧ở đây⟦/4⟧ và ⟦5⟧.");
    expect(good).toContain('<em class="ltx_emph">một</em>');
    const bad = assemble(intro, "Nhiều ứng dụng dựa vào việc điều chỉnh ⟦1⟧một mô hình lớn ⟦2⟧.⟦3⟧ Xem ⟦4⟧ở đây⟦/1⟧ và ⟦5⟧.");
    expect(bad).toContain("điều chỉnh một mô hình lớn");
    expect(bad).not.toContain("<em");
    expect(bad).toContain(intro.atoms["5"]!);
  });

  it("makes batches of about the size asked, in order", () => {
    const units = [{ text: "a".repeat(40) }, { text: "b".repeat(40) }, { text: "c".repeat(40) }, { text: "d" }];
    expect(batches(units, 90, 10).map((b) => b.length)).toEqual([2, 2]);
    expect(batches(units, 1000, 3).map((b) => b.length)).toEqual([3, 1]);
    expect(batches([{ text: "x".repeat(500) }], 90, 10)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ the translator on a hub

/** "Translates" a unit as a scripted agent would: Vietnamese words around the same markers. */
function vi(u: { n: number; text: string }): string {
  return `[vi ${u.n}] ${u.text.replace(/[A-Za-z]+/g, (w) => `${w}ư`)}`;
}

interface Turn { kind: string; text: string; context: string; role: TranslatorRole }

/** A hub whose hidden chats run `script` for each turn. */
function translatorHub(script: (t: Turn) => Promise<void> | void, settings: ReaderAgentSettings = { mode: "ask", checker: true, rounds: 2 }) {
  const turns: Turn[] = [];
  let open = 0;
  let closed = 0;
  const host: ReaderAuthorHost = {
    chat(_paperId, role: ChatRole, kind) {
      open++;
      let turn: Promise<void> = Promise.resolve();
      return {
        send(text, context) {
          const t = { kind, text, context, role: role as TranslatorRole };
          turns.push(t);
          turn = turn.then(() => script(t));
        },
        whenIdle: async (signal) => {
          await Promise.race([turn, new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]);
        },
        close: () => { closed++; },
      };
    },
    settings: () => settings,
    log: () => {},
  };
  const t = testHub(undefined, { author: () => host });
  return { ...t, turns, chats: () => ({ open, closed }) };
}

const unitsOf = (context: string) => JSON.parse(context.split("\n").find((l) => l.startsWith("["))!) as { n: number; kind: string; text: string; refs?: Record<string, string> }[];
const saveAll = async (t: Turn, pick = (u: { n: number; text: string }) => vi(u)) => {
  await t.role.runTool(toolCtx(), "reader_translation_save", { units: unitsOf(t.context).map((u) => ({ n: u.n, vi: pick(u) })), terms: [{ en: "low-rank", vi: "hạng thấp (low-rank)" }] });
};

async function until(read: () => ReaderTranslationView, ok: (v: ReaderTranslationView) => boolean): Promise<ReaderTranslationView> {
  const end = Date.now() + 10_000;
  let v = read();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 10));
    v = read();
  }
  return v;
}

describe("the translator", () => {
  it("says nothing was started, then how much there is, before any agent runs", async () => {
    const t = translatorHub(() => {});
    const view = await t.hub.open({ arxiv: LORA });
    expect(view.translation).toEqual({ state: "none", done: 0, failed: 0, rev: 0 });
    const est = t.hub.translator.estimate(LORA_ID);
    expect(est).toMatchObject({ state: "none", done: 0, total: 23, turnsLeft: 1 });
    expect(t.turns).toEqual([]);
    expect(existsSync(join(view.dir, TRANSLATION_PAGE))).toBe(true);
  });

  it("translates the paper on a click, in batches with the rules, the glossary and each marker's meaning; saves each unit as it comes", async () => {
    const t = translatorHub((turn) => saveAll(turn));
    const { dir } = await t.hub.open({ arxiv: LORA });
    t.hub.translator.start(LORA_ID);
    const done = await until(() => t.hub.view(LORA_ID).translation!, (v) => v.state !== "running");
    expect(done).toMatchObject({ state: "done", done: 23, total: 23, failed: 0, turnsLeft: 0 });
    expect(t.turns).toHaveLength(1);
    const [turn] = t.turns;
    expect(turn!.kind).toBe("translator");
    const prompt = await turn!.role.prompt({ text: turn!.text, context: turn!.context, rules: true, recap: "", cells: async () => null, activity: () => null, attached: async () => null });
    expect(prompt).toContain("<reader-translate>");
    expect(prompt).toContain('You translate the research paper "LoRA: Low-Rank Adaptation of Large Language Models" into Vietnamese');
    expect(prompt).toContain("Glossary so far: none yet.");
    expect(unitsOf(turn!.context).find((u) => u.text.startsWith("For a pre-trained"))!.refs).toEqual({ 1: "$W_{0}\\in\\mathbb{R}^{d\\times k}$", 2: "$h=W_{0}x$" });
    const { units, rev } = t.hub.translator.units(LORA_ID);
    expect(rev).toBeGreaterThan(0);
    expect(Object.keys(units)).toHaveLength(23);
    expect(units["18"]).toMatch(/^\[vi 18\] Forư aư preư-trainedư /);
    expect(units["18"]).toContain('alttext="h=W_{0}x"');
    const saved = JSON.parse(readFileSync(join(dir, "translation", "vi.json"), "utf8"));
    expect(saved.terms).toEqual([{ en: "low-rank", vi: "hạng thấp (low-rank)" }]);
    // The tab heard the view change, with the translation's progress in it.
    await new Promise((r) => setTimeout(r, 200));
    expect(t.emit.mock.calls.some(([e, p]) => e === "reader.updated" && (p as { view: { translation?: { done: number } } }).view.translation?.done === 23)).toBe(true);
  });

  it("sends a unit it got wrong back to the agent, and leaves it in English after two turns", async () => {
    const t = translatorHub(async (turn) => {
      // Unit 18 always loses its second formula.
      await saveAll(turn, (u) => (u.n === 18 ? vi(u).replace("⟦2⟧", "") : vi(u)));
    });
    await t.hub.open({ arxiv: LORA });
    t.hub.translator.start(LORA_ID);
    const v = await until(() => t.hub.translator.view(LORA_ID)!, (x) => x.state !== "running");
    expect(v).toMatchObject({ state: "partial", done: 22, failed: 1, total: 23, turnsLeft: 1 });
    expect(t.turns).toHaveLength(2);
    expect(unitsOf(t.turns[1]!.context).map((u) => u.n)).toEqual([18]);
    expect(t.turns[1]!.context).toContain("low-rank → hạng thấp (low-rank)");
    // "Dịch lại": the failed unit again.
    t.hub.translator.start(LORA_ID, true);
    await until(() => t.hub.translator.view(LORA_ID)!, (x) => x.state !== "running");
    expect(unitsOf(t.turns[2]!.context).map((u) => u.n)).toEqual([18]);
  });

  it("tells the agent what to fix in the same turn", async () => {
    const t = translatorHub(() => {});
    await t.hub.open({ arxiv: LORA });
    t.hub.translator.estimate(LORA_ID);
    const role = new TranslatorRole("LoRA", () => {}, () => {});
    const p = translationSource(readFileSync(join(t.hub.store.dir(LORA_ID), "doc.html"), "utf8")).units.find((u) => u.n === 18) as TranslationUnit;
    role.begin([p]);
    const wrong = await role.runTool(toolCtx(), "reader_translation_save", { units: [{ n: 18, vi: "Với ⟦1⟧, ta ràng buộc cập nhật bằng một phân rã hạng thấp, rồi lượt truyền xuôi là như sau:" }, { n: 3, vi: "x" }] });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("unit 18: thiếu ⟦2⟧ ($h=W_{0}x$)");
    expect(wrong.text).toContain("unit 3: not in this batch");
    expect(wrong.text).toContain("Still to send: 18.");
    const right = await role.runTool(toolCtx(), "reader_translation_save", { units: [{ n: 18, vi: vi(p) }] });
    expect(right.text).toContain("Saved 1 unit(s): 18.\nThe batch is complete.");
  });

  it("does not run in mode off, nor while the paper is locked; the lock stops a run, what was saved stays", async () => {
    const off = translatorHub(() => {}, { mode: "off", checker: true, rounds: 2 });
    await off.hub.open({ arxiv: LORA });
    expect(() => off.hub.translator.start(LORA_ID)).toThrow(/Agent nền đang tắt/);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = translatorHub(async (turn) => {
      await saveAll(turn, (u) => vi(u));
      await gate;
    });
    await t.hub.open({ arxiv: LORA });
    t.hub.author.stop(LORA_ID);
    expect(() => t.hub.translator.start(LORA_ID)).toThrow(/khóa agent/);
    t.hub.author.unlock(LORA_ID);
    t.hub.translator.start(LORA_ID);
    await until(() => t.hub.translator.view(LORA_ID)!, (v) => v.done === 23);
    expect(t.hub.translator.view(LORA_ID)!.state).toBe("running");
    t.hub.translator.stop(LORA_ID);
    expect(t.hub.translator.view(LORA_ID)).toMatchObject({ state: "done", done: 23 });
    release();
  });

  it("stops saying why when the agent sends nothing twice", async () => {
    const t = translatorHub(() => {});
    await t.hub.open({ arxiv: LORA });
    t.hub.translator.start(LORA_ID);
    const v = await until(() => t.hub.translator.view(LORA_ID)!, (x) => x.state !== "running");
    expect(v.state).toBe("failed");
    expect(v.error).toMatch(/hai lượt liền/);
    expect(t.chats()).toEqual({ open: 2, closed: 2 });
  });

  it("has nothing to translate for a PDF", async () => {
    const t = translatorHub(() => {});
    const view = await t.hub.open({ arxiv: LORA });
    expect(view.translation).toBeDefined();
    const meta = t.hub.store.meta(LORA_ID);
    t.hub.store.writeMeta({ ...meta, view: "pdf", file: "paper.pdf" });
    expect(t.hub.view(LORA_ID).translation).toBeUndefined();
    expect(() => t.hub.translator.start(LORA_ID)).toThrow(/Chỉ dịch được paper hiện bằng HTML/);
  });
});
