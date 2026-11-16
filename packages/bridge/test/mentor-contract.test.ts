// What Mentor takes from the rest of the app, pinned down: the core's tool
// names, the error sentences Mentor explains to the learner, and the one
// OpenResearch command it calls. Mentor reads all of these by name or by
// wording, so a change over there would not fail to compile; it would only
// make Mentor quietly worse. A failure here says what moved and where
// Mentor's side of it lives.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KERNEL_BUSY } from "@ainb/protocol";
import { fetchArxiv } from "../src/mentor/fetch.js";
import { kernelProblem } from "../src/mentor/judge.js";
import { MENTOR_CHAT_TOOLS } from "../src/mentor/tools.js";
import { AUTHOR_CHAT_TOOLS, PLAN_CHAT_TOOLS } from "../src/mentor/workshop.js";
import { TOOLS } from "../src/notebook/tools.js";

const ROOT = resolve(__dirname, "../../..");
const source = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("the core's tools a Mentor chat keeps", () => {
  // Read the kernel, run a snippet outside the cells, stop it. Nothing that edits a cell or a file.
  const KEPT = ["interrupt_kernel", "kernel_state", "read_output", "run_code", "wait_for_code"];
  const core = new Set(TOOLS.map((t) => t.name));
  const lists = { "the mentor's chat": MENTOR_CHAT_TOOLS, "the paper plan's chat": PLAN_CHAT_TOOLS, "the exercise author's chat": AUTHOR_CHAT_TOOLS };

  for (const [who, tools] of Object.entries(lists)) {
    it(`${who}: exactly those five`, () => {
      // A core tool renamed drops out of Mentor's list without a word (mentor/tools.ts and mentor/workshop.ts: KEPT).
      const kept = tools.map((t) => t.name).filter((n) => core.has(n)).sort();
      expect(kept, "a core tool was renamed or removed; update KEPT in mentor/tools.ts and mentor/workshop.ts, and the playbooks that name it").toEqual(KEPT);
    });
  }

  it("the mentor cannot write the learner's code", () => {
    const names = MENTOR_CHAT_TOOLS.map((t) => t.name);
    for (const n of names) expect(KEPT.includes(n) || n.startsWith("mentor_"), `${n} is in the mentor's chat`).toBe(true);
  });
});

describe("the core's error sentences Mentor explains", () => {
  // Each sentence as the core writes it, the file that writes it, and the advice the learner must get.
  const SENTENCES: { from: string; says: string; advice: RegExp }[] = [
    { from: "packages/protocol/src/adapter.ts", says: KERNEL_BUSY, advice: /Kernel đang bận/ },
    { from: "packages/extension/src/page/jupyter.ts", says: "The Kaggle session is not running. Ask the user to start it (the power button), then try again.", advice: /Máy Kaggle chưa bật/ },
    { from: "packages/extension/src/page/colab.ts", says: "Colab is not connected to a runtime. Ask the user to connect it (the Connect button), then try again.", advice: /Colab chưa nối máy/ },
    { from: "packages/extension/src/background/background.ts", says: "The notebook page is not reachable (it may have reloaded). Try again.", advice: /Không tới được notebook/ },
    { from: "packages/bridge/src/server.ts", says: "The browser extension is not connected to the bridge. Open Chrome with the notebook's tab.", advice: /Không tới được notebook/ },
  ];

  for (const s of SENTENCES) {
    it(`"${s.says.slice(0, 48)}…"`, () => {
      expect(source(s.from).includes(s.says), `${s.from} no longer says this; put its new wording here and make sure kernelProblem (mentor/judge.ts) still recognises it`).toBe(true);
      expect(kernelProblem(s.says)).toMatch(s.advice);
    });
  }

  it("says an unknown failure as it is", () => {
    expect(kernelProblem("Something new went wrong.")).toBe("Chưa chấm được: Something new went wrong.");
  });
});

describe("OpenResearch, used once: a paper's text when arXiv has no LaTeX", () => {
  const noArxiv = (async () => ({ ok: false, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
  const long = "Attention is all you need. ".repeat(200);

  it("takes orx's text when it has one", async () => {
    const asked: string[] = [];
    const src = await fetchArxiv("1706.03762", { fetch: noArxiv, orxPaper: async (id) => (asked.push(id), long) });
    expect(asked).toEqual(["1706.03762"]);
    expect(src.kind).toBe("alphaxiv");
    expect(src.text).toContain("Attention is all you need.");
  });

  it("without orx, or with an orx that fails or answers nothing, asks for the PDF", async () => {
    const pdf = /Tải PDF về rồi thêm paper bằng file PDF/;
    await expect(fetchArxiv("1706.03762", { fetch: noArxiv })).rejects.toThrow(pdf);
    await expect(fetchArxiv("1706.03762", { fetch: noArxiv, orxPaper: async () => Promise.reject(new Error("orx: unknown command paper")) })).rejects.toThrow(pdf);
    await expect(fetchArxiv("1706.03762", { fetch: noArxiv, orxPaper: async () => "usage: orx …" })).rejects.toThrow(pdf);
  });

  it("calls the command as the bridge writes it", () => {
    expect(source("packages/bridge/src/server.ts")).toContain('this.orx.cli(["paper", "--full", "--", id]');
  });

  // The submodule is the OpenResearch this app ships with; when it moves, the command must still be there.
  it.skipIf(!existsSync(resolve(ROOT, "openresearch/src/main.rs")))("which the OpenResearch in this repo still has", () => {
    const main = source("openresearch/src/main.rs");
    expect(main, "orx has no `paper` command any more; change the call in server.ts (mentor.paper.add) or drop the fallback").toMatch(/\bPaper\(PaperArgs\)/);
    const args = main.slice(main.indexOf("pub struct PaperArgs"));
    expect(args.slice(0, args.indexOf("\n}")), "`orx paper` lost its --full flag").toMatch(/#\[arg\(long\)\]\s*pub full: bool/);
    expect(args.slice(0, args.indexOf("\n}"))).toMatch(/pub id: String/);
  });
});
