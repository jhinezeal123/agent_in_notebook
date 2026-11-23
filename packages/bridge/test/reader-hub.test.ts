// Easy-read (ER-1) in the bridge: opening a paper (arXiv's HTML, its PDF when
// arXiv could not convert it, a PDF on this computer), what the reader did
// (time per section, marks, notes) kept in the paper's own log, and pages or
// figures drawn by the reading tab for the tutor. arXiv is faked
// (fixtures/reader/fake-arxiv.ts); everything else is real, on a temp shelf.

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { foldReader, cleanNote, safeId, type ReaderEvent } from "../src/reader/store.js";
import { pdfPaperId } from "../src/reader/ingest.js";
import type { ReaderDoc } from "../src/reader/doc.js";
import { cleanShelves, JPEG, LORA, LORA_ID, loraRoutes, PNG, testHub } from "./fixtures/reader/fake-arxiv.js";

afterAll(cleanShelves);

const files = mkdtempSync(join(tmpdir(), "ainb-reader-files-"));
afterAll(() => rmSync(files, { recursive: true, force: true }));

function pdfFile(name: string, body = "%PDF-1.4\n% a paper\n"): string {
  const path = join(files, name);
  writeFileSync(path, body);
  return path;
}

const TEX = `\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n${"We adapt large models with low-rank updates. ".repeat(80)}\n\\end{document}\n`;

describe("opening an arXiv paper", () => {
  it("fetches arXiv's HTML once, keeps the page and its images, and puts the paper on the shelf", async () => {
    const { hub, root, fetched, shelved } = testHub();
    const view = await hub.open({ arxiv: "https://arxiv.org/abs/2106.09685" });
    expect(view).toMatchObject({
      paperId: LORA_ID, title: "LoRA: Low-Rank Adaptation of Large Language Models", authors: "Edward J. Hu, Yelong Shen", year: 2021,
      arxiv: LORA, url: `https://arxiv.org/abs/${LORA}`, view: "html", text: "html", file: "doc.html", notes: [],
    });
    expect(view.dir).toBe(join(root, LORA_ID, "reader"));
    expect(view.sections.map((s) => s.id)).toEqual(["abstract", "S1", "S2", "S4", "S4.SS1", "A1"]);
    expect(view.sections.every((s) => !s.read && s.readMs === 0)).toBe(true);
    expect(view.warnings).toEqual([expect.stringContaining("LaTeXML")]);
    for (const f of ["doc.html", "doc.json", "reader.json", "events.jsonl", "assets/1-figure1.svg"]) expect(existsSync(join(view.dir, f)), f).toBe(true);
    expect(readFileSync(join(view.dir, "assets/2-qv8_qv64.png"))).toEqual(PNG);
    // On Mentor's shelf with the text the workshop would read, anchors and all.
    expect(shelved).toHaveLength(1);
    expect(shelved[0]).toMatchObject({ id: LORA_ID, arxiv: LORA, year: 2021, kind: "latex" });
    expect(shelved[0]!.source).toMatch(/^<!-- source: arXiv HTML \(LaTeXML\) of 2106\.09685/);
    expect(shelved[0]!.source).toContain("### 4.1 Low-Rank-Parametrized Update Matrices  [[S4.SS1]]");
    // Polite: the API, the page, two images; and the agent identifies as what it is, no more.
    expect(fetched).toEqual(Object.keys(loraRoutes()));

    const again = await hub.open({ arxiv: "2106.09685v2" });
    expect(again.paperId).toBe(LORA_ID);
    expect(fetched).toHaveLength(4);
    expect(readFileSync(join(view.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).t)).toEqual(["r.open", "r.open"]);
  });

  it("fetches once when the paper is opened twice at the same time", async () => {
    const { hub, fetched } = testHub();
    const [a, b] = await Promise.all([hub.open({ arxiv: LORA }), hub.open({ arxiv: `arXiv:${LORA}` })]);
    expect(a.paperId).toBe(b.paperId);
    expect(fetched.filter((u) => u === `https://arxiv.org/html/${LORA}`)).toHaveLength(1);
  });

  it("reads a landmark paper of the shelf in its own folder, and opens a shelf paper by its id", async () => {
    const shelf = { paperFor: (a: string) => (a.startsWith(LORA) ? "lora" : undefined), arxivOf: (id: string) => (id === "lora" ? LORA : undefined) };
    const first = testHub(loraRoutes(), { shelf });
    expect((await first.hub.open({ arxiv: LORA })).paperId).toBe("lora");
    expect(existsSync(join(first.root, "lora", "reader", "doc.html"))).toBe(true);

    const second = testHub(loraRoutes(), { shelf });
    expect((await second.hub.open({ paperId: "lora" })).arxiv).toBe(LORA);
    await expect(second.hub.open({ paperId: "unknown" })).rejects.toThrow(/Không có paper unknown/);
  });

  it("says what a link should look like when it is not one", async () => {
    const { hub, fetched } = testHub();
    await expect(hub.open({ arxiv: "https://example.com/paper" })).rejects.toThrow(/không phải link hay id arXiv/);
    expect(fetched).toEqual([]);
  });

  it("goes on without the images it could not get, and says so", async () => {
    const routes = loraRoutes();
    routes[`https://arxiv.org/html/${LORA}v2/qv8_qv64.png`] = () => new Response("oops", { status: 500 });
    const { hub } = testHub(routes);
    const view = await hub.open({ arxiv: LORA });
    expect(view.warnings).toContain("1 hình không tải được.");
    expect(existsSync(join(view.dir, "assets/2-qv8_qv64.png"))).toBe(false);
  });

  it("falls back to ar5iv, then to the PDF with the authors' LaTeX for the tutor", async () => {
    const routes = loraRoutes();
    delete routes[`https://arxiv.org/html/${LORA}`];
    // ar5iv answers 200 with a page that is not a converted paper.
    routes[`https://ar5iv.labs.arxiv.org/html/${LORA}`] = () => new Response('<html><body><div class="ltx_page_main"><article class="ltx_document"><h1>Untitled Document</h1></article></div></body></html>');
    routes[`https://arxiv.org/pdf/${LORA}`] = () => new Response("%PDF-1.5\n%…");
    routes[`https://arxiv.org/e-print/${LORA}`] = () => new Response(TEX);
    const { hub, fetched, shelved } = testHub(routes);
    const view = await hub.open({ arxiv: LORA });
    expect(view).toMatchObject({ view: "pdf", text: "latex", needsText: true, file: "paper.pdf", sections: [] });
    expect(view.warnings[0]).toMatch(/chưa chuyển được paper này sang HTML/);
    expect(fetched).toContain(`https://ar5iv.labs.arxiv.org/html/${LORA}`);
    expect(hub.latex(LORA_ID)).toContain("low-rank updates");
    expect(readFileSync(join(view.dir, "paper.pdf"), "latin1").startsWith("%PDF")).toBe(true);
    expect(shelved[0]).toMatchObject({ kind: "latex" });
    expect(shelved[0]!.source).toMatch(/^<!-- source: arXiv LaTeX of 2106\.09685/);
  });

  it("fails clearly when arXiv has neither HTML nor PDF", async () => {
    const routes = loraRoutes();
    delete routes[`https://arxiv.org/html/${LORA}`];
    const { hub } = testHub(routes);
    await expect(hub.open({ arxiv: LORA })).rejects.toThrow(/Không lấy được arXiv 2106\.09685: không có bản HTML, và PDF HTTP 404/);
    expect(hub.has(LORA_ID)).toBe(false);
  });
});

describe("opening a PDF from this computer", () => {
  it("copies it once under an id of its content, titled by its file name", async () => {
    const { hub } = testHub();
    const path = pdfFile("Attention_is_all_you_need.pdf");
    const view = await hub.open({ pdfPath: path });
    expect(view.paperId).toBe(pdfPaperId(readFileSync(path)));
    expect(view.paperId).toMatch(/^pdf-[0-9a-f]{12}$/);
    expect(view).toMatchObject({ title: "Attention is all you need", view: "pdf", text: "pdf", needsText: true, file: "paper.pdf" });
    // The same file again (renamed): the same paper, its reading resumes.
    const copy = pdfFile("renamed.pdf");
    expect((await hub.open({ pdfPath: copy })).title).toBe("Attention is all you need");
  });

  it("refuses a file that is not a PDF", async () => {
    const { hub } = testHub();
    await expect(hub.open({ pdfPath: pdfFile("notes.pdf", "hello") })).rejects.toThrow(/không phải PDF/);
  });

  it("takes the PDF's text from the tab: a section per page, a better title, the arXiv id it shows", async () => {
    const { hub, shelved, emit } = testHub();
    const { paperId } = await hub.open({ pdfPath: pdfFile("scan_0001.pdf", "%PDF-1.7\n% another\n") });
    const pages = ["Attention Is All You Need\narXiv:1706.03762v7 [cs.CL] 2 Aug 2023", "3 Model Architecture\nscaled dot-product attention"];
    const view = hub.pdfText(paperId, pages, "Attention Is All You Need");
    expect(view.needsText).toBeUndefined();
    expect(view.title).toBe("Attention Is All You Need");
    expect(view.arxivHint).toBe("1706.03762v7");
    expect(view.sections.map((s) => s.id)).toEqual(["page-1", "page-2"]);
    expect(hub.text(paperId)).toContain("[page-2] 3 Model Architecture");
    expect(shelved.at(-1)).toMatchObject({ id: paperId, kind: "pdf", title: "Attention Is All You Need" });
    expect(shelved.at(-1)!.source).toMatch(/^<!-- source: text taken out of the PDF/);
    expect(emit).toHaveBeenCalledWith("reader.updated", expect.objectContaining({ paperId }));
  });

  it("keeps the file's name when the PDF calls itself after a word processor", async () => {
    const { hub } = testHub();
    const { paperId } = await hub.open({ pdfPath: pdfFile("Diffusion_models.pdf", "%PDF-1.7\n% third\n") });
    expect(hub.pdfText(paperId, ["Denoising Diffusion"], "Microsoft Word - ddpm_final.docx").title).toBe("Diffusion models");
  });

  it("refuses a PDF with no text, and text for a paper that is not a PDF", async () => {
    const { hub } = testHub();
    const { paperId } = await hub.open({ pdfPath: pdfFile("images.pdf", "%PDF-1.7\n% fourth\n") });
    expect(() => hub.pdfText(paperId, ["", "  "])).toThrow(/không có chữ/);
    expect(() => hub.pdfText(paperId, "not pages")).toThrow(/không đọc được/);
    await hub.open({ arxiv: LORA });
    expect(() => hub.pdfText(LORA_ID, ["x"])).toThrow(/không phải PDF/);
  });
});

describe("what the reader did", () => {
  it("counts a section read at 40 % of its time, and tells the tab only then", async () => {
    const { hub, emit } = testHub();
    await hub.open({ arxiv: LORA });
    const s = hub.view(LORA_ID).sections.find((x) => x.id === "S4.SS1")!;
    const need = s.minutes * 60_000 * 0.4;
    emit.mockClear();
    hub.progress(LORA_ID, "S4.SS1", need / 2);
    expect(hub.view(LORA_ID).sections.find((x) => x.id === "S4.SS1")).toMatchObject({ readMs: need / 2, read: false });
    expect(emit).not.toHaveBeenCalled();
    hub.progress(LORA_ID, "S4.SS1", need / 2);
    expect(hub.view(LORA_ID).sections.find((x) => x.id === "S4.SS1")!.read).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    hub.progress(LORA_ID, "S4.SS1", 1000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(hub.view(LORA_ID).at).toBe("S4.SS1");
    // A section the paper does not have, and a slice too long to be reading: ignored, capped.
    hub.progress(LORA_ID, "S9", 5000);
    hub.progress(LORA_ID, "S2", 3_600_000);
    expect(hub.view(LORA_ID).sections.find((x) => x.id === "S2")!.readMs).toBe(600_000);
  });

  it("lets the reader mark a section read or not, over the time spent", async () => {
    const { hub, emit } = testHub();
    await hub.open({ arxiv: LORA });
    expect(hub.mark(LORA_ID, "S2", true).sections.find((x) => x.id === "S2")!.read).toBe(true);
    hub.progress(LORA_ID, "A1", 3_600_000);
    expect(hub.mark(LORA_ID, "A1", false).sections.find((x) => x.id === "A1")!.read).toBe(false);
    expect(emit).toHaveBeenCalledWith("reader.updated", expect.objectContaining({ paperId: LORA_ID }));
    expect(() => hub.mark(LORA_ID, "S9", true)).toThrow(/không có mục S9/);
  });

  it("counts a section with only subsections read when they all are", async () => {
    const { hub } = testHub();
    await hub.open({ arxiv: LORA });
    const doc: ReaderDoc = {
      ...hub.doc(LORA_ID),
      sections: [
        { id: "S3", number: "3", title: "Method", level: 1, blocks: [], minutes: 1 },
        { id: "S3.SS1", number: "3.1", title: "One", level: 2, parent: "S3", blocks: ["S3.SS1.p1"], minutes: 1 },
        { id: "S3.SS2", number: "3.2", title: "Two", level: 2, parent: "S3", blocks: ["S3.SS2.p1"], minutes: 1 },
      ],
      blocks: [{ id: "S3.SS1.p1", section: "S3.SS1", kind: "p", text: "one" }, { id: "S3.SS2.p1", section: "S3.SS2", kind: "p", text: "two" }],
    };
    hub.store.writeDoc(doc);
    hub.mark(LORA_ID, "S3.SS1", true);
    expect(hub.view(LORA_ID).sections.find((x) => x.id === "S3")!.read).toBe(false);
    hub.mark(LORA_ID, "S3.SS2", true);
    expect(hub.view(LORA_ID).sections.find((x) => x.id === "S3")!.read).toBe(true);
    hub.mark(LORA_ID, "S3", false);
    expect(hub.view(LORA_ID).sections.find((x) => x.id === "S3")!.read).toBe(false);
    // The reading list counts sections with text of their own.
    expect(hub.list()[0]).toMatchObject({ paperId: LORA_ID, read: 2, total: 2 });
  });

  it("keeps notes and questions: add, edit, close, remove", async () => {
    const { hub } = testHub();
    await hub.open({ arxiv: LORA });
    let view = hub.note(LORA_ID, { note: { kind: "question", text: "  Vì sao B = 0?  ", anchor: { id: "S4.SS1.p2", quote: "zero for B", page: -1 } } });
    const q = view.notes[0]!;
    expect(q).toMatchObject({ kind: "question", text: "Vì sao B = 0?", anchor: { id: "S4.SS1.p2", quote: "zero for B" } });
    expect(q.id).toMatch(/^n-/);
    view = hub.note(LORA_ID, { note: { id: q.id, kind: "question", text: "Vì sao B bằng 0?", done: true } });
    expect(view.notes).toEqual([{ ...q, text: "Vì sao B bằng 0?", done: true }]);
    hub.note(LORA_ID, { note: { kind: "note", text: "ΔW = BA, rank r" } });
    expect(hub.view(LORA_ID).notes.map((n) => n.kind)).toEqual(["question", "note"]);
    expect(hub.note(LORA_ID, { remove: q.id }).notes.map((n) => n.text)).toEqual(["ΔW = BA, rank r"]);
    expect(() => hub.note(LORA_ID, { remove: q.id })).toThrow(/Không còn ghi chú đó/);
    expect(() => hub.note(LORA_ID, { note: { id: "n-gone", kind: "note", text: "x" } })).toThrow(/Không còn ghi chú đó/);
    expect(() => hub.note(LORA_ID, { note: { kind: "note", text: "   " } })).toThrow(/Ghi chú trống/);
  });

  it("is the same after a restart, from the paper's own log; a torn line or a later version's event is skipped", async () => {
    const first = testHub();
    await first.hub.open({ arxiv: LORA });
    first.hub.progress(LORA_ID, "S4", 30_000);
    first.hub.mark(LORA_ID, "S2", true);
    first.hub.note(LORA_ID, { note: { kind: "question", text: "α/r?" } });
    const before = first.hub.view(LORA_ID);
    appendFileSync(join(before.dir, "events.jsonl"), '{"t":"r.future","at":1}\n{"t":"r.sect');
    const second = testHub(loraRoutes(), { root: first.root });
    // guideRev only counts changes since the bridge started (the tab asks again when it moves).
    expect({ ...second.hub.view(LORA_ID), guideRev: 0 }).toEqual({ ...before, guideRev: 0 });
    expect(second.fetched).toEqual([]);
  });

  it("lists the papers being read, last read first", async () => {
    const { hub } = testHub();
    await hub.open({ pdfPath: pdfFile("a.pdf", "%PDF-1.7\n% list a\n") });
    await new Promise((r) => setTimeout(r, 5));
    await hub.open({ arxiv: LORA });
    expect(hub.list().map((p) => [p.paperId.startsWith("pdf-") ? "pdf" : p.paperId, p.view])).toEqual([[LORA_ID, "html"], ["pdf", "pdf"]]);
    expect(hub.list()[0]).toMatchObject({ read: 0, total: 6 });
  });
});

describe("the log and the notes, as data", () => {
  it("folds events in order and skips what it does not know", () => {
    const events = [
      { t: "r.section", at: 1, section: "S1", ms: 1000 },
      { t: "r.section", at: 2, section: "S1", ms: -5 },
      { t: "r.section", at: 3, section: "S2", ms: 2000 },
      { t: "r.mark", at: 4, section: "S1", read: true },
      { t: "r.note", at: 5, note: { id: "n1", kind: "note", text: "x", at: 5 } },
      { t: "r.noteRemove", at: 6, id: "n1" },
      { t: "r.later", at: 7 },
      null,
    ] as unknown as ReaderEvent[];
    const s = foldReader(events);
    expect([...s.readMs]).toEqual([["S1", 1000], ["S2", 2000]]);
    expect(s.at).toBe("S2");
    expect(s.marked.get("S1")).toBe(true);
    expect(s.notes.size).toBe(0);
    expect(s.lastAt).toBe(7);
  });

  it("checks a note from the tab: kind, text length, anchor fields", () => {
    const n = cleanNote({ kind: "weird", text: "a".repeat(5000), anchor: { id: "x".repeat(200), page: 2.5, quote: 42, prefix: "before" } });
    expect(n.kind).toBe("note");
    expect(n.text).toHaveLength(4000);
    expect(n.anchor).toEqual({ id: "x".repeat(120), prefix: "before" });
    expect(cleanNote({ text: "ok", anchor: "nope" }).anchor).toBeUndefined();
  });

  it("makes a folder name of a paper id, and refuses one that has none", () => {
    expect(safeId("arxiv-2106-09685")).toBe("arxiv-2106-09685");
    expect(safeId("../../etc/passwd")).toBe("etcpasswd");
    expect(() => safeId("../..")).toThrow(/trống/);
  });
});

describe("pages and figures drawn by the tab, for the tutor", () => {
  async function pdfHub(renderWaitMs = 2000) {
    const t = testHub(loraRoutes(), { renderWaitMs });
    const { paperId } = await t.hub.open({ pdfPath: pdfFile(`render-${renderWaitMs}.pdf`, `%PDF-1.7\n% ${renderWaitMs}\n`) });
    t.emit.mockClear();
    return { ...t, paperId };
  }

  it("asks the tab once for a page two calls want, and keeps the JPEG it sends", async () => {
    const { hub, emit, paperId } = await pdfHub();
    const a = hub.render(paperId, { page: 3 });
    const b = hub.render(paperId, { page: 3 });
    expect(emit.mock.calls).toEqual([["reader.render", { paperId, page: 3 }]]);
    hub.rendered(paperId, { page: 3, jpeg: JPEG.toString("base64") });
    expect(await a).toEqual(JPEG);
    expect(await b).toEqual(JPEG);
    expect(readFileSync(join(hub.view(paperId).dir, "pages/3.jpg"))).toEqual(JPEG);
    // Kept: the tab is not asked again.
    expect(await hub.render(paperId, { page: 3 })).toEqual(JPEG);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("draws a figure the agent cannot read as it is (SVG) beside it", async () => {
    const { hub, emit, paperId } = await pdfHub();
    const fig = hub.render(paperId, { asset: "assets/1-figure1.svg" });
    expect(emit).toHaveBeenCalledWith("reader.render", { paperId, asset: "assets/1-figure1.svg" });
    hub.rendered(paperId, { asset: "assets/1-figure1.svg", jpeg: JPEG.toString("base64") });
    expect(await fig).toEqual(JPEG);
    expect(existsSync(join(hub.view(paperId).dir, "assets/1-figure1.svg.jpg"))).toBe(true);
  });

  it("refuses what is not a JPEG, passes the tab's error on, and stops waiting for a closed tab", async () => {
    const { hub, paperId } = await pdfHub(50);
    const notJpeg = hub.render(paperId, { page: 1 });
    hub.rendered(paperId, { page: 1, jpeg: PNG.toString("base64") });
    await expect(notJpeg).rejects.toThrow(/không phải JPEG/);
    const failed = hub.render(paperId, { page: 2 });
    hub.rendered(paperId, { page: 2, error: "Trang 2 không vẽ được." });
    await expect(failed).rejects.toThrow("Trang 2 không vẽ được.");
    await expect(hub.render(paperId, { page: 4 })).rejects.toThrow(/không trả ảnh về/);
    // Nothing asked: ignored.
    hub.rendered(paperId, { jpeg: JPEG.toString("base64") });
  });

  it("writes only where render could have asked: a page, an image under assets/", async () => {
    const { hub, root, paperId } = await pdfHub();
    const dir = hub.view(paperId).dir;
    for (const asset of ["../../../escaped", "assets/../../escaped", "/tmp/escaped", "assets/sub/escaped"]) {
      hub.rendered(paperId, { asset, jpeg: JPEG.toString("base64") });
    }
    hub.rendered(paperId, { page: -1, jpeg: JPEG.toString("base64") });
    expect(existsSync(join(root, "escaped.jpg"))).toBe(false);
    expect(existsSync(join(dir, "..", "escaped.jpg"))).toBe(false);
    expect(existsSync(join(dir, "pages", "-1.jpg"))).toBe(false);
  });
});
