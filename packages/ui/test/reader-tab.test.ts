// Easy-read's reading tab in Chromium, with a fake host: the paper's HTML as
// the bridge cleans it (fixtures/reader-doc.html, from the LoRA fixture of the
// bridge's tests), formulas drawn, the outline, a selection asked about, a
// citation revealed, a figure drawn for the tutor, a question kept; and the
// passes (ER-2): a goal chosen, the skim's roles on the paper, a checkpoint
// question answered with how sure, a results table hidden, a unit hidden
// while recalled.
// Run with E2E_MARKDOWN=1 (or E2E_READER=1), like the chat renderer's test.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReaderGuide, ReaderUnitView, ReaderView } from "@ainb/protocol";

const DOC = readFileSync(join(__dirname, "fixtures", "reader-doc.html"), "utf8");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=", "base64");
const section = (id: string, title: string, level: 1 | 2, number?: string, parent?: string) => ({ id, title, level, minutes: 1, readMs: 0, read: false, ...(number ? { number } : {}), ...(parent ? { parent } : {}) });
const VIEW: ReaderView = {
  paperId: "arxiv-2106-09685", title: "LoRA: Low-Rank Adaptation of Large Language Models", authors: "Edward J. Hu, Yelong Shen", year: 2021, arxiv: "2106.09685",
  view: "html", text: "html", dir: "/papers/arxiv-2106-09685/reader", file: "doc.html", notes: [], warnings: [], openedAt: 1, lastAt: 1,
  sections: [
    section("abstract", "Abstract", 1), section("S1", "Introduction", 1, "1"), section("S2", "Problem Statement", 1, "2"),
    section("S4", "Our Method", 1, "4"), section("S4.SS1", "Low-Rank-Parametrized Update Matrices", 2, "4.1", "S4"), section("A1", "Large Language Models Still Need Parameter Updates", 1, "A"),
  ],
};

const SCORE = { answered: 0, total: 1, firstRight: 0, points: 0, max: 0, sureWrong: 0, luckyRight: 0 };
const UNIT: ReaderUnitView = {
  id: "S4", number: "4", title: "Our Method", sections: ["S4", "S4.SS1"], read: true, state: "ready", guide: "Vì sao $B$ được khởi tạo bằng 0?",
  explain: { anchor: "S4.E3", prompt: "Dòng (3) làm gì, vì sao cần?" }, figures: [], predicts: [{ id: "S4.T1", label: "Table 1", question: "LoRA cần nhiều hay ít tham số?" }], qalmri: false,
  items: [{ id: "q-1", unit: "S4", concept: "zero-init", bloom: "understand", kind: "mcq", stem: "Lúc bắt đầu, $\\Delta W$ bằng gì?", options: ["Một ma trận ngẫu nhiên", "Ma trận 0", "Chính $W_0$"], difficulty: 2 }],
  skipped: [], score: SCORE, done: false,
};
const GUIDE: ReaderGuide = {
  paperId: "arxiv-2106-09685", pass: 1, passed: [], author: { state: "idle", queued: 0 },
  map: {
    has: { roles: true, fivec: true, concepts: true, notation: true, background: true, pretest: true, units: true },
    roles: [{ anchor: "S4.SS1.p1", role: "method" }, { anchor: "S2.p1", role: "objective" }], concepts: [{ id: "zero-init", name: "Khởi tạo B = 0", answers: 0 }],
    notation: [{ symbol: "W_0", meaning: "trọng số gốc", anchor: "S4.SS1.p1" }], background: [], pretest: [],
  },
  units: [UNIT], misses: [], again: [], score: SCORE, skipped: [],
};

declare global {
  interface Window {
    startReader(view: ReaderView, guide: ReaderGuide): void;
    calls: [string, any][];
    emit(event: string, params?: unknown): void;
    guide: ReaderGuide;
    answer: unknown;
  }
}

describe.skipIf(!process.env.E2E_MARKDOWN && !process.env.E2E_READER)("the reading tab in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const { outputFiles } = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
          import { h, render } from "preact";
          import { ReaderApp } from "./src/reader/app.tsx";
          const listeners = new Set();
          window.calls = [];
          window.emit = (event, params) => { for (const l of listeners) l({ event, params }); };
          window.startReader = (view, guide) => {
            window.guide = guide;
            window.view = view;
            const host = {
              async request(method, params) {
                window.calls.push([method, params ?? {}]);
                if (method === "init") return { view, base: location.origin + "/paper/", pdfjs: "", pdfWorker: "" };
                if (method === "reader.get" || method === "reader.mark" || method === "reader.note") return view;
                if (method === "reader.guide") return window.guide;
                if (method === "reader.goal") {
                  window.guide = { ...window.guide, goal: params.goal };
                  return window.guide;
                }
                if (method === "reader.answer") return { result: window.answer, guide: window.guide };
                if (method === "reader.widget.answer") {
                  const widget = window.guide.widgets[0];
                  window.guide = { ...window.guide, widgets: [{ ...widget, result: { choice: params.choice, correct: true }, model: {
                    params: [{ name: "r", label: "Rank", min: 1, max: 4, step: 1, init: 1 }],
                    outputs: [{ label: "Tham số", expression: ["*", "r", 8] }],
                  } }] };
                  return window.guide;
                }
                if (method === "write") return { id: "w-1", graded: true, guide: window.guide };
                return { ok: true };
              },
              on(l) { listeners.add(l); return () => listeners.delete(l); },
            };
            render(h(ReaderApp, { host }), document.getElementById("root"));
          };`,
      },
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      jsxImportSource: "preact",
    });
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
    await page.route("https://reader.test/**", (route) => {
      const url = route.request().url();
      if (url.endsWith("/index.html")) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body style="margin:0;height:800px"><div id="root" style="height:800px"></div></body></html>' });
      if (url.endsWith("/paper/doc.html")) return route.fulfill({ contentType: "text/html", body: DOC });
      if (url.endsWith(".png")) return route.fulfill({ contentType: "image/png", body: PNG });
      if (url.endsWith(".svg")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>' });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("https://reader.test/index.html");
    // The tab's own stylesheet: the selection bar floats, the paper scrolls in its column.
    await page.addStyleTag({ content: readFileSync(join(__dirname, "..", "reader.css"), "utf8") });
    await page.addScriptTag({ content: outputFiles[0]!.text });
    await page.evaluate(([view, guide]) => window.startReader(view, guide), [VIEW, GUIDE] as const);
    await page.locator(".er-doc-html #S4\\.SS1").waitFor();
  }, 120_000);

  afterAll(async () => { await browser?.close(); });

  it("shows the paper with its outline; formulas drawn from the authors' TeX; nothing active kept", async () => {
    expect(await page.locator(".er-sec-title").allTextContents()).toEqual(["Abstract", "1Introduction", "2Problem Statement", "4Our Method", "4.1Low-Rank-Parametrized Update Matrices", "ALarge Language Models Still Need Parameter Updates"]);
    expect(await page.locator(".er-progress").innerText()).toContain("0/6 mục");
    await page.waitForFunction(() => document.querySelectorAll(".er-math .katex").length > 5);
    expect(await page.locator('.er-math[data-tex="h=W_{0}x+\\\\Delta Wx=W_{0}x+BAx"]').count()).toBe(1);
    expect(await page.locator(".er-doc script, .er-doc button, .er-doc [onclick], .er-doc [onmouseover]").count()).toBe(0);
    expect(await page.locator(".er-doc img").first().getAttribute("src")).toBe("https://reader.test/paper/assets/1-figure1.svg");
  });

  it("asks the tutor about a selection, with its anchor and its formulas as TeX", async () => {
    await page.evaluate(() => {
      const p = document.getElementById("S4.SS1.p2")!.querySelector("p")!;
      p.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const bar = page.locator(".er-selbar");
    await bar.waitFor();
    expect(await bar.locator("button").allTextContents()).toEqual(["Giải thích", "Ví dụ cụ thể", "Ký hiệu", "Vì sao?", "Tạo ví dụ tương tác", "+ Câu hỏi", "+ Ghi chú"]);
    await bar.getByText("Vì sao?").click();
    const ask = await page.waitForFunction(() => window.calls.find((c) => c[0] === "ask")?.[1]);
    const p = await ask.jsonValue() as { kind: string; anchor: { id: string; quote: string }; quote: string };
    expect(p.kind).toBe("why");
    expect(p.anchor.id).toBe("S4.SS1.p2");
    expect(p.quote).toContain("random Gaussian initialization for $A$ and zero for $B$, so $\\Delta W=BA$ is zero");
    expect(p.quote).not.toMatch(/A\s*A|ΔW\s*=\s*BA\s*Δ/);
    await bar.waitFor({ state: "detached" });
  });

  it("brings a cited phrase into view and marks it", async () => {
    await page.evaluate(() => window.emit("reveal", { id: "S4.SS1.p2", quote: "zero for" }));
    await page.waitForFunction(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has("er-cite"));
    await page.evaluate(() => window.emit("reveal", { id: "S9.p1" }));
    await page.locator(".er-toast").getByText("Không thấy chỗ").waitFor();
  });

  it("marks a section read from the outline", async () => {
    await page.locator(".er-sec").nth(2).locator(".er-dot").click();
    expect(await page.evaluate(() => window.calls.filter((c) => c[0] === "reader.mark").map((c) => c[1]))).toEqual([{ section: "S2", read: true }]);
  });

  it("draws a figure the tutor wants as JPEG", async () => {
    await page.evaluate(() => window.emit("render", { asset: "assets/1-figure1.svg" }));
    const sent = await page.waitForFunction(() => window.calls.find((c) => c[0] === "reader.rendered")?.[1]);
    const r = await sent.jsonValue() as { asset: string; jpeg?: string; error?: string };
    expect(r.error).toBeUndefined();
    expect(r.asset).toBe("assets/1-figure1.svg");
    expect(Buffer.from(r.jpeg!, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("keeps a question about a passage", async () => {
    await page.evaluate(() => {
      const p = document.getElementById("A1.p1")!;
      p.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(p);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.locator(".er-selbar").getByText("+ Câu hỏi").click();
    await page.locator(".er-draft textarea").fill("Few-shot thì sao?");
    await page.locator(".er-draft").getByText("Lưu").click();
    const note = await page.waitForFunction(() => window.calls.find((c) => c[0] === "reader.note")?.[1]);
    expect(await note.jsonValue()).toEqual({ note: { kind: "question", text: "Few-shot thì sao?", anchor: { id: "A1.p1", quote: "Few-shot learning is advantageous with few samples." } } });
  });

  it("asks why the reader reads the paper, then lights up the paragraphs' roles and dims the rest for the skim", async () => {
    // The last test left the notes open beside the paper: the passes take their place.
    await page.locator(".er-head").getByText("Các lượt").click();
    await page.locator(".er-tabs").getByText("Bắt đầu").click();
    expect(await page.locator(".er-goal b").allTextContents()).toEqual(["Nắm ý", "Hiểu để dùng", "Hiểu sâu"]);
    await page.locator(".er-goal").getByText("Hiểu để dùng").click();
    expect(await page.evaluate(() => window.calls.filter((c) => c[0] === "reader.goal").map((c) => c[1]))).toEqual([{ goal: "use" }]);
    await page.locator(".er-passbar").getByText("① Định hướng").waitFor();
    await page.waitForFunction(() => document.getElementById("S4.SS1.p1")?.getAttribute("data-er-role") === "method");
    expect(await page.evaluate(() => document.querySelector(".er-doc-html")!.classList.contains("er-skim"))).toBe(true);
    // The introduction stays lit; the problem statement's paragraph is lit by its role.
    expect(await page.evaluate(() => document.getElementById("S1")!.classList.contains("er-skim-keep"))).toBe(true);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("S4.p1")!).opacity === "0.32");
    expect(await page.evaluate(() => getComputedStyle(document.getElementById("S4.SS1.p1")!).opacity)).toBe("1");
    await page.locator(".er-toggle").getByText("Làm mờ phần chưa cần").click();
    await page.waitForFunction(() => !document.querySelector(".er-doc-html")!.classList.contains("er-skim"));
  });

  it("in pass 2, hides a results table until the guess, and answers a question with how sure", async () => {
    await page.evaluate(() => {
      window.guide = { ...window.guide, pass: 2, passed: [1] };
      window.emit("updated", { ...(window as unknown as { view: ReaderView }).view, guideRev: 9 });
    });
    await page.locator(".er-unitcard h4").getByText("§4 Our Method").waitFor();
    await page.waitForFunction(() => document.getElementById("S4.T1")?.classList.contains("er-hidden-result"));
    expect(await page.evaluate(() => document.querySelector(".er-doc-html [data-er-role]"))).toBeNull();
    const item = page.locator(".er-item").first();
    await item.locator(".er-option").nth(1).locator("label").click();
    await item.getByText("3 Rất chắc").click();
    await page.evaluate(() => {
      window.answer = { correct: true, confidence: 3, points: 3, choice: { options: [1] }, right: { options: [1] }, why: ["Nghĩ A ngẫu nhiên thì BA cũng ngẫu nhiên", "$B = 0$ nên $BA = 0$", "Nhầm với W0"], explain: "B = 0 nên $\\Delta W = BA = 0$ [[S4.SS1.p2]].", evidence: [{ anchor: "S4.SS1.p2", quote: "zero for $B$" }], at: 1 };
      const unit = window.guide.units[0]!;
      window.guide = { ...window.guide, units: [{ ...unit, items: [{ ...unit.items[0]!, result: window.answer as never }] }] };
    });
    await item.getByText("Trả lời").click();
    expect(await page.evaluate(() => window.calls.filter((c) => c[0] === "reader.answer").map((c) => c[1]))).toEqual([{ item: "q-1", choice: { options: [1] }, confidence: 3 }]);
    await item.locator(".er-result-head").getByText("✓ Đúng · +3 điểm").waitFor();
    // Every part of the panel draws its formulas: the reasons and the paper's words too, not only the stem.
    const why = item.locator(".er-why");
    expect(await why.count()).toBe(1);
    expect(await why.locator(".katex").count()).toBe(2);
    expect(await why.innerText()).not.toContain("$");
    expect(await item.locator(".er-quote-line .katex").count()).toBe(1);
    expect(await item.locator(".er-result").innerText()).not.toContain("$");
    await item.locator(".er-result .cite-chip").first().click();
    await page.waitForFunction(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has("er-cite"));
  });

  it("hides the unit while the reader recalls it, and sends the recall to be graded", async () => {
    await page.getByText("Gập mục và viết").click();
    await page.waitForFunction(() => document.getElementById("S4")?.classList.contains("er-covered"));
    await page.locator(".er-step textarea").first().fill("BA hạng thấp; B = 0 lúc đầu.");
    await page.locator(".er-step").first().getByText("Gửi gia sư chấm").click();
    expect(await page.evaluate(() => window.calls.filter((c) => c[0] === "write").map((c) => c[1]))).toEqual([{ kind: "recall", text: "BA hạng thấp; B = 0 lúc đầu.", unit: "S4" }]);
    await page.waitForFunction(() => !document.getElementById("S4")?.classList.contains("er-covered"));
    await page.locator(".er-toast").getByText("Đã gửi gia sư chấm").waitFor();
  });

  it("reveals the inline interactive model only after a prediction", async () => {
    await page.evaluate(() => {
      window.guide = { ...window.guide, widgets: [{
        id: "lora-rank", anchor: { id: "S4.E3" }, title: "Số tham số theo rank", goal: "Đổi rank để hiểu kích thước",
        tryThis: [], prediction: { question: "Tăng rank $r$ gấp đôi thì sao?", choices: ["Tăng gấp đôi", "Giữ nguyên"] },
      }] };
      window.emit("updated", { ...(window as unknown as { view: ReaderView }).view, guideRev: 10 });
    });
    const widget = page.locator(".er-widget-slot .er-widget");
    await widget.getByText("Số tham số theo rank").click();
    expect(await widget.locator("input[type=range]").count()).toBe(0);
    expect(await widget.locator(".katex").count()).toBe(1);
    await widget.getByLabel("Tăng gấp đôi").check();
    await widget.getByRole("button", { name: "Chốt dự đoán" }).click();
    await widget.getByText("Dự đoán đúng.").waitFor();
    await widget.locator("input[type=range]").fill("2");
    expect(await widget.locator("tbody td").textContent()).toBe("16");
    expect(await page.evaluate(() => window.calls.filter(([method]) => method === "reader.widget.answer").at(-1)?.[1])).toEqual({ id: "lora-rank", choice: 0 });
  });
});
