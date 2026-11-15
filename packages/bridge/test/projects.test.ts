// Notebook chats in OpenResearch projects, through the real bridge, a scripted
// agent and a stand-in for OpenResearch's API: which project a notebook
// belongs to, what the agent is told about it, and the project tools.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSettings, ChatSnapshot, Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { runInSession } from "../src/notebook/setup.js";
import { ChatStore, keyHash } from "../src/store.js";
import { worktreePath } from "../src/project/worktree.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";
import { FakeOrx } from "./fixtures/fake-orx-api.js";

const TOKEN = "test-token-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
const FAKE_ORX = resolve(__dirname, "fixtures/fake-orx.mjs");
const MISSING = () => ({ missing: "OpenResearch is not used in these tests." });

let home: string;
let orx: FakeOrx;
let orxPort: number;
let bridge: Bridge;
let port: number;
let nextTab = 500;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ainb-projects-"));
  process.env.AINB_HOME = home;
  process.env.AINB_SCRATCH_DIR = join(home, "OpenResearch", "scratch");
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 5 }]));
  orx = new FakeOrx();
  orxPort = await orx.start();
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: { knownPorts: [orxPort], locate: MISSING }, log: () => {} });
  port = await bridge.listen();
});

afterAll(async () => {
  await bridge?.close();
  await orx?.close();
  delete process.env.AINB_SCRATCH_DIR;
});

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

async function open(key: string, opts: { projectId?: string; settings?: Partial<ChatSettings>; port?: number; ready?: boolean; ext?: FakeExtension } = {}) {
  const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
  const tabId = nextTab++;
  const ext = opts.ext ?? new FakeExtension(nb, tabId);
  if (opts.ext) ext.attachNotebook(tabId, nb);
  else await ext.connect(opts.port ?? port, TOKEN);
  const snap = await ext.request<ChatSnapshot>("chat.open", {
    tabId,
    agentId: "fake",
    settings: { scope: "write", review: false, targetCellIds: [], notebookOnly: true, ...opts.settings },
    platform: "colab",
    notebookKey: key,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });
  await ext.waitFor(() => ext.snapshots.some((s) => s.chatId === snap.chatId && s.status === "idle"), 30_000, "agent start");
  if (opts.ready !== false) await ext.waitFor(() => project(ext, snap)?.state === "ready", 15_000, "project ready");
  return { nb, ext, chatId: snap.chatId, first: snap };
}

/** The chat's project as last sent. */
function project(ext: FakeExtension, first?: ChatSnapshot) {
  return (ext.snapshots.findLast((s) => !first || s.chatId === first.chatId) ?? first)?.project;
}

async function turn(ext: FakeExtension, chatId: string, text: string) {
  const before = ext.statuses.length;
  const start = ext.agentText().length;
  await ext.request("chat.send", { chatId, text });
  await ext.waitFor(() => ext.statuses.slice(before).includes("idle") || ext.statuses.slice(before).includes("error"), 60_000, "turn end");
  return ext.agentText().slice(start);
}

async function answer(ext: FakeExtension, chatId: string, optionId: "yes" | "no") {
  await ext.waitFor(() => ext.parts().some((p) => p.type === "prompt" && p.answer === undefined), 15_000, "question");
  const prompt = ext.parts().find((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt" && p.answer === undefined)!;
  await ext.request("chat.answer", { chatId, promptId: prompt.promptId, optionId });
  return prompt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("which project a notebook belongs to", () => {
  it("puts new notebooks in Scratch, made once and kept off GitHub", async () => {
    const a = await open("colab:/drive/a", { ready: false });
    // A second notebook opened at the same moment waits for the same Scratch.
    const otherTab = a.ext.tabId + 10_000;
    await a.ext.request("chat.open", { tabId: otherTab, agentId: "fake", settings: { scope: "write", review: false, targetCellIds: [], notebookOnly: true }, platform: "colab", notebookKey: "colab:/drive/b" });
    const of = (tabId: number) => a.ext.snapshots.filter((s) => s.tabId === tabId).at(-1)?.project;
    await a.ext.waitFor(() => of(a.ext.tabId)?.state === "ready" && of(otherTab)?.state === "ready", 15_000, "both projects");
    const pa = of(a.ext.tabId)!;
    expect(pa).toMatchObject({ name: "Scratch", state: "ready", scratch: true });
    expect(of(otherTab)!.id).toBe(pa.id);
    expect(orx.createdProjects).toHaveLength(1);
    expect(orx.createdProjects[0]).toMatchObject({ name: "Scratch", path: process.env.AINB_SCRATCH_DIR, githubSyncEnabled: false, initializeGit: true });
    expect(JSON.parse(readFileSync(join(home, "research.json"), "utf8")).scratchProjectId).toBe(pa.id);
    // New chat forgets the conversation, not the project.
    await turn(a.ext, a.chatId, "hello");
    await a.ext.request("chat.close", { chatId: a.chatId });
    const store = new ChatStore(join(home, "chats"));
    expect(existsSync(join(home, "chats", `${keyHash("colab:/drive/a")}.json`))).toBe(false);
    expect(store.loadMeta("colab:/drive/a")?.projectId).toBe(pa.id);
    a.ext.close();
  });

  it("puts a notebook an older bridge saved (no project) in Scratch", async () => {
    new ChatStore(join(home, "chats")).saveMeta("colab:/drive/old", { title: "old.ipynb" });
    const { ext } = await open("colab:/drive/old");
    expect(project(ext)).toMatchObject({ name: "Scratch", state: "ready" });
    const scratchId = project(ext)!.id!;
    const { chats } = await ext.request<{ chats: { notebookKey: string }[] }>("chats.list", { projectId: scratchId });
    expect(chats.map((c) => c.notebookKey)).toContain("colab:/drive/old");
    ext.close();
  });

  it("moves a notebook to another project and lists it there", async () => {
    const vision = orx.addProject("Vision");
    const { ext, chatId } = await open("colab:/drive/move");
    const moved = await ext.request<{ project: { id: string; name: string } }>("notebook.link", { notebookKey: "colab:/drive/move", projectId: vision.id });
    expect(moved.project).toMatchObject({ id: vision.id, name: "Vision", state: "ready" });
    await ext.waitFor(() => project(ext)?.id === vision.id, 5000, "snapshot with the new project");
    const { chats } = await ext.request<{ chats: { notebookKey: string; tabId?: number }[] }>("chats.list", { projectId: vision.id });
    expect(chats).toEqual([expect.objectContaining({ notebookKey: "colab:/drive/move", tabId: ext.tabId })]);
    // The agent hears of the move with the next message.
    expect(await turn(ext, chatId, "ECHO_PROJECT")).toMatch(/moved this notebook to the project Vision/);
    await expect(ext.request("notebook.link", { notebookKey: "colab:/drive/move", projectId: "proj_nope" })).rejects.toThrow(/project not found/);
    ext.close();
  });

  it("keeps project tool calls in the original project until the next turn", async () => {
    const a = orx.addProject("Move from");
    const b = orx.addProject("Move to");
    const key = "colab:/drive/move-mid-turn";
    const { ext, chatId } = await open(key, { projectId: a.id, settings: { notebookOnly: false } });
    try {
      const write = (path: string) => ({ server: "project", tool: "artifact_write", args: { path, content: path } });
      const sending = turn(ext, chatId, script([write("before.txt"), { permission: "Pause between writes" }, write("after.txt")]));
      await ext.waitFor(() => ext.parts().some((p) => p.type === "prompt" && !p.answer), 15_000, "pause after first write");
      expect(existsSync(join(a.artifactsDir, "before.txt"))).toBe(true);
      await ext.request("notebook.link", { notebookKey: key, projectId: b.id });
      const prompt = ext.parts().find((p) => p.type === "prompt" && !p.answer);
      if (prompt?.type === "prompt") await ext.request("chat.answer", { chatId, promptId: prompt.promptId, optionId: "deny" });
      expect(await sending).toContain("Wrote artifacts/after.txt");
      expect(existsSync(join(a.artifactsDir, "after.txt"))).toBe(true);
      expect(existsSync(join(b.artifactsDir, "after.txt"))).toBe(false);
      expect(await turn(ext, chatId, script([write("next.txt")]))).toContain("Wrote artifacts/next.txt");
      expect(existsSync(join(b.artifactsDir, "next.txt"))).toBe(true);
    } finally {
      ext.close();
    }
  });
});

describe("what the agent is told about the project", () => {
  it("gives the project once, without its experiments or runs, and nothing about later changes", async () => {
    const p = orx.addProject("Speech", { code: { "README.md": "# Speech\nTrain a small ASR model.", "src/train.py": "lr = 0.1\n" } });
    orx.experiments.push({ id: "exp_1", projectId: p.id, slug: "baseline", branchName: "orx/baseline", title: "Baseline", description: "The paper's setup", archived: false, createdAt: 1, updatedAt: 1 });
    mkdirSync(join(p.artifactsDir, "reports"), { recursive: true });
    writeFileSync(join(p.artifactsDir, "reports", "plan.md"), "# Plan");
    const { ext, chatId } = await open("colab:/drive/speech", { projectId: p.id });
    const first = await turn(ext, chatId, "ECHO_PROJECT");
    expect(first).toContain("<project-context>");
    expect(first).toContain("Project: Speech");
    expect(first).toContain("Train a small ASR model.");
    expect(first).toContain("artifacts/reports/plan.md");
    expect(first).not.toContain("orx/baseline");
    expect(first).not.toMatch(/## Experiments|Latest runs/);
    expect(await turn(ext, chatId, "ECHO_PROJECT")).toContain("[no project block]");

    // A run ends and a figure appears: the agent hears of it from the user, not from the bridge.
    const run = { id: "run_1", experimentId: "exp_1", projectId: p.id, status: "done", resultMarkdown: "WER 12.3%", createdAt: 2, startedAt: 2, endedAt: 3 };
    orx.runs.push(run);
    mkdirSync(join(p.artifactsDir, "figures"), { recursive: true });
    writeFileSync(join(p.artifactsDir, "figures", "wer.png"), "png");
    orx.emit("run.updated", { run });
    await sleep(300);
    expect(await turn(ext, chatId, "ECHO_PROJECT")).toContain("[no project block]");
    ext.close();
  });

  it("keeps the chat going while OpenResearch is not there, and says so", async () => {
    const lonely = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: { knownPorts: [], locate: MISSING }, log: () => {} });
    const lonelyPort = await lonely.listen();
    try {
      const { ext, chatId } = await open("colab:/drive/offline", { port: lonelyPort, ready: false });
      const text = await turn(ext, chatId, "ECHO_PROJECT");
      expect(text).toMatch(/Project context unavailable \(OpenResearch starting or not running\)/);
      expect(project(ext)?.state).not.toBe("ready");
      expect(project(ext)?.state).not.toBe("missing");
      const tool = await turn(ext, chatId, script([{ server: "project", tool: "artifact_list", args: {} }]));
      expect(tool).toMatch(/RESULT artifact_list \(error\): The project is not available right now/);
      ext.close();
    } finally {
      await lonely.close();
    }
  });

  it("still reaches the shared artifacts of a project seen before, while OpenResearch is not there", async () => {
    const p = orx.addProject("Remembered");
    const seen = await open("colab:/drive/remembered", { projectId: p.id });
    seen.ext.close();
    const lonely = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: { knownPorts: [], locate: MISSING }, log: () => {} });
    const lonelyPort = await lonely.listen();
    try {
      const { ext, chatId } = await open("colab:/drive/remembered", { port: lonelyPort, ready: false });
      const text = await turn(ext, chatId, script([{ server: "project", tool: "artifact_write", args: { path: "reports/offline.md", content: "written offline" } }]));
      expect(text).toContain("RESULT artifact_write: Wrote artifacts/reports/offline.md");
      expect(readFileSync(join(p.artifactsDir, "reports", "offline.md"), "utf8")).toBe("written offline");
      ext.close();
    } finally {
      await lonely.close();
    }
  });
});

describe("project tools", () => {
  it("reads and writes the shared artifacts, between them and the notebook's machine, and refuses secrets", async () => {
    const p = orx.addProject("Tools");
    mkdirSync(join(p.artifactsDir, "reports"), { recursive: true });
    writeFileSync(join(p.artifactsDir, "reports", "baseline.md"), "# Baseline\naccuracy 0.81\n");
    writeFileSync(join(p.artifactsDir, ".env"), "API_KEY=hunter2");
    const { nb, ext, chatId } = await open("colab:/drive/tools", { projectId: p.id, settings: { scope: "auto", review: false } });
    nb.vm.write("/content/out/loss.csv", "step,loss\n1,0.9\n");
    const text = await turn(ext, chatId, script([
      { server: "project", tool: "artifact_read", args: { path: "artifacts/reports/baseline.md" } },
      { server: "project", tool: "artifact_read", args: { path: ".env" } },
      { server: "project", tool: "artifact_write", args: { path: "reports/ablation.md", content: "# Ablation\nlr 0.05 wins." } },
      { server: "project", tool: "artifact_write", args: { path: "results/loss.csv", from_vm: "/content/out/loss.csv" } },
      { server: "project", tool: "artifact_write", args: { path: "../../escape.md", content: "no" } },
      { server: "project", tool: "artifact_read", args: { path: "reports/baseline.md", to_vm: "/content/baseline.md" } },
      { server: "project", tool: "save_notebook", args: {} },
      { server: "project", tool: "artifact_list", args: {} },
    ]));
    expect(text).toContain("RESULT artifact_read:      1\t# Baseline");
    expect(text).toMatch(/RESULT artifact_read \(error\): \.env looks like a secret/);
    expect(text).not.toContain("hunter2");
    expect(readFileSync(join(p.artifactsDir, "reports", "ablation.md"), "utf8")).toBe("# Ablation\nlr 0.05 wins.");
    expect(readFileSync(join(p.artifactsDir, "results", "loss.csv"), "utf8")).toBe("step,loss\n1,0.9\n");
    expect(text).toMatch(/RESULT artifact_write \(error\): .*not a path inside the shared artifacts/);
    expect(existsSync(join(p.artifactsDir, "..", "escape.md"))).toBe(false);
    expect(nb.vm.read("/content/baseline.md")).toBe("# Baseline\naccuracy 0.81\n");
    expect(text).toContain("RESULT save_notebook: Saved artifacts/notebooks/test.ipynb in Tools");
    const saved = JSON.parse(readFileSync(join(p.artifactsDir, "notebooks", "test.ipynb"), "utf8"));
    expect(saved.cells[0].source.join("")).toBe("x = 1");
    expect(text).toMatch(/artifacts\/results\/loss\.csv \(\d+ B/);
    // The project tools show as the chat's own tools (allowed with Notebook only on).
    const tools = ext.parts().filter((x): x is Extract<Part, { type: "tool" }> => x.type === "tool" && x.title.startsWith("mcp__project__"));
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.notebook)).toBe(true);
    ext.close();
  });

  it("follows the mode: no saving in Edit cell, asking with Review on, and never replacing others' files unasked", async () => {
    const p = orx.addProject("Modes");
    mkdirSync(join(p.artifactsDir, "notebooks"), { recursive: true });
    writeFileSync(join(p.artifactsDir, "notebooks", "theirs.ipynb"), "the user's notebook");
    const cell = await open("colab:/drive/modes-cell", { projectId: p.id, settings: { scope: "cell" } });
    expect(await turn(cell.ext, cell.chatId, script([{ server: "project", tool: "save_notebook", args: {} }]))).toMatch(/RESULT save_notebook \(error\): Mode is 'Edit cell'/);
    cell.ext.close();

    const reviewed = await open("colab:/drive/modes-review", { projectId: p.id, settings: { scope: "write", review: true } });
    const sending = turn(reviewed.ext, reviewed.chatId, script([{ server: "project", tool: "save_notebook", args: { name: "reviewed" } }]));
    const asked = await answer(reviewed.ext, reviewed.chatId, "yes");
    expect(asked.title).toMatch(/Save the notebook .* to artifacts\/notebooks\/reviewed\.ipynb/);
    expect(await sending).toContain("RESULT save_notebook: Saved artifacts/notebooks/reviewed.ipynb");
    reviewed.ext.close();

    const free = await open("colab:/drive/modes-free", { projectId: p.id, settings: { scope: "auto", review: false } });
    const replacing = turn(free.ext, free.chatId, script([{ server: "project", tool: "save_notebook", args: { name: "theirs" } }]));
    expect((await answer(free.ext, free.chatId, "no")).title).toMatch(/This chat did not write it/);
    expect(await replacing).toMatch(/RESULT save_notebook \(error\): The user declined/);
    expect(readFileSync(join(p.artifactsDir, "notebooks", "theirs.ipynb"), "utf8")).toBe("the user's notebook");
    // Copying to the notebook's machine changes files there: not in Write mode.
    const write = await open("colab:/drive/modes-write", { projectId: p.id, settings: { scope: "write", review: false } });
    expect(await turn(write.ext, write.chatId, script([{ server: "project", tool: "artifact_read", args: { path: "notebooks/theirs.ipynb", to_vm: "/content/x.ipynb" } }]))).toMatch(/RESULT artifact_read \(error\): Mode is 'Write'/);
    write.ext.close();
    free.ext.close();
  });

  it("saves the notebook when the user clicks Save to project, without asking", async () => {
    const p = orx.addProject("Button");
    const { ext, chatId } = await open("colab:/drive/button", { projectId: p.id, settings: { scope: "write", review: true } });
    expect(await ext.request("chat.saveNotebook", { chatId })).toEqual({ path: "artifacts/notebooks/test.ipynb" });
    expect(existsSync(join(p.artifactsDir, "notebooks", "test.ipynb"))).toBe(true);
    expect(ext.parts().some((x) => x.type === "prompt")).toBe(false);
    ext.close();
  });

  it("keeps one copy when the agent saves the notebook after the user did", async () => {
    const p = orx.addProject("Button then agent");
    const { ext, chatId } = await open("colab:/drive/button-agent", { projectId: p.id, settings: { scope: "auto", review: false } });
    const saved = { path: "artifacts/notebooks/test.ipynb" };
    expect(await ext.request("chat.saveNotebook", { chatId })).toEqual(saved);
    expect(await turn(ext, chatId, script([{ server: "project", tool: "save_notebook", args: {} }]))).toContain("RESULT save_notebook: Saved artifacts/notebooks/test.ipynb");
    expect(await ext.request("chat.saveNotebook", { chatId })).toEqual(saved);
    expect(readdirSync(join(p.artifactsDir, "notebooks"))).toEqual(["test.ipynb"]);
    ext.close();
  });

  it("keeps same-title notebook saves separate and leaves an existing legacy copy intact", async () => {
    const p = orx.addProject("Save collisions");
    mkdirSync(join(p.artifactsDir, "notebooks"), { recursive: true });
    const legacy = join(p.artifactsDir, "notebooks", "test.ipynb");
    writeFileSync(legacy, "legacy notebook");
    const a = await open("colab:/drive/same-title-a", { projectId: p.id });
    const b = await open("colab:/drive/same-title-b", { projectId: p.id, ext: a.ext });
    const save = (chat: typeof a) => chat.ext.request<{ path: string }>("chat.saveNotebook", { chatId: chat.chatId });
    const content = (path: string) => readFileSync(join(p.artifactsDir, path.slice("artifacts/".length)), "utf8");
    try {
      b.nb.cells[0]!.source = "x = 2";
      const [first, second] = await Promise.all([save(a), save(b)]);
      expect(first.path).not.toBe(second.path);
      expect(content(first.path)).toContain("x = 1");
      expect(content(second.path)).toContain("x = 2");
      expect(readFileSync(legacy, "utf8")).toBe("legacy notebook");
      a.nb.cells[0]!.source = "x = 3";
      expect(await save(a)).toEqual(first);
      expect(content(first.path)).toContain("x = 3");
      expect(content(second.path)).toContain("x = 2");
    } finally {
      a.ext.close();
    }
  });
});

describe("the research literature", () => {
  it("searches and reads papers with orx on the user's computer, and passes on what orx refuses", async () => {
    const withOrx = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: { knownPorts: [orxPort], locate: () => ({ path: "fake-orx", command: process.execPath, args: [FAKE_ORX] }) }, log: () => {} });
    const withOrxPort = await withOrx.listen();
    try {
      const p = orx.addProject("Papers");
      const { ext, chatId } = await open("colab:/drive/papers", { projectId: p.id, port: withOrxPort });
      const text = await turn(ext, chatId, script([
        { server: "project", tool: "paper_search", args: { source: "keyword", query: "--LoRA", published_after: "2021-01-01", prioritize: "recency", limit: 5 } },
        { server: "project", tool: "paper_search", args: { source: "openalex", query: "nothing at all" } },
        { server: "project", tool: "paper_search", args: { source: "pubmed", query: "lora" } },
        { server: "project", tool: "paper_read", args: { id: "2106.09685" } },
        { server: "project", tool: "paper_read", args: { id: "2106.09685", full: true } },
        { server: "project", tool: "paper_read", args: { id: "2106.09685", full: true, offset: 40000 } },
        { server: "project", tool: "paper_read", args: { id: "0000.00000" } },
      ]));
      expect(text).toContain("1. [alphaxiv 2106.09685] LoRA: Low-Rank Adaptation of Large Language Models (2021-06-17; 120 votes)");
      expect(text).toContain('match p. 4: "freeze the pretrained weights"');
      expect(text).toContain("2. [openalex W3000000001] QLoRA (2023-05-23; 900 citations)");
      // The flags reach orx, and a query that looks like a flag stays the query.
      expect(text).toContain("[asked: keyword --published-after 2021-01-01 --prioritize recency --limit 5 -- --LoRA]");
      expect(text).toMatch(/No openalex results for "nothing at all"/);
      expect(text).toMatch(/RESULT paper_search \(error\): PubMed is turned off in OpenResearch settings/);
      expect(text).toContain("# Report on 2106.09685");
      expect(text).toMatch(/FULL TEXT of 2106\.09685[\s\S]*\(characters 0-40000 of \d+; continue with offset=40000\)/);
      expect(text).toContain("THE END");
      expect(text).toMatch(/RESULT paper_read \(error\): alphaXiv has no paper 0000\.00000/);
      // /lit-review brings OpenResearch's workflow along with the message.
      expect(await turn(ext, chatId, "/lit-review compare LoRA variants")).toContain("[saw lit-review]");
      expect(await turn(ext, chatId, "/lit-review")).toContain("[saw lit-review, no topic]");
      expect(await turn(ext, chatId, "no review here, see a/lit-review/x")).not.toContain("[saw lit-review");
      ext.close();
    } finally {
      await withOrx.close();
    }
  });

  it("says when orx is not installed", async () => {
    const p = orx.addProject("No orx");
    const { ext, chatId } = await open("colab:/drive/no-orx", { projectId: p.id });
    const text = await turn(ext, chatId, script([{ server: "project", tool: "paper_search", args: { source: "keyword", query: "lora" } }]));
    expect(text).toMatch(/RESULT paper_search \(error\): OpenResearch is not used in these tests/);
    ext.close();
  });
});

describe("the project's code on the notebook's machine", () => {
  const TOKEN_GH = "ghp_testtoken_0123456789";
  beforeAll(() => {
    process.env.AINB_GITHUB_TOKEN = TOKEN_GH;
  });
  afterAll(() => {
    delete process.env.AINB_GITHUB_TOKEN;
  });

  it("keeps watching a push after its initial wait and returns the eventual result", async () => {
    const nb = new FakeNotebook([]);
    const session = "project-slow";
    let notify!: () => void;
    const waiting = new Promise<void>((resolve) => { notify = resolve; });
    const pending = runInSession(async (op) => nb.handle(op), "test-slow-project-sync", session, "forever", 20, notify);
    await waiting;
    nb.vm.background(session, "\r\nainb-pushed deadbeef\r\n\u001b]7770;prompt;0\u0007");
    expect(await pending).toMatchObject({ running: false, exitCode: 0, output: expect.stringContaining("ainb-pushed deadbeef") });
  });

  it("stops watching a push that never ends, so later turns are not held up", async () => {
    const nb = new FakeNotebook([]);
    let waited = false;
    const r = await runInSession(async (op) => nb.handle(op), "test-stuck-project-sync", "project-stuck", "forever", 20, () => { waited = true; }, 200);
    expect(waited).toBe(true);
    expect(r).toMatchObject({ running: true, exitCode: null });
  });

  /** A file as text, whatever line ends git checked it out with (Windows). */
  const fileText = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  /** git on this computer, for the test's own checks. */
  const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

  /** Run the bridge scripts with real Git, in a temporary simulated VM home. */
  function machine(nb: FakeNotebook, beforePush: (dir: string) => void = () => {}) {
    const seen: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "ainb-vm-git-")).replaceAll("\\", "/");
    const bash = process.platform === "win32" ? resolve(g(home, "--exec-path"), "../../../bin/bash.exe") : "bash";
    const onDisk = (path: string) => path.replace(/^\/root(?=\/)/, root);
    nb.vm.run = (command) => {
      seen.push(command);
      const dir = command.match(/^cd '(\/root\/[^']+)'$/m)?.[1];
      if (!dir) return undefined;
      const credentials = nb.vm.read("/root/.ainb-git-credentials");
      if (credentials) writeFileSync(join(root, ".ainb-git-credentials"), credentials);
      if (command.includes("git push")) beforePush(onDisk(dir));
      const result = spawnSync(bash, ["-s"], {
        input: command.replaceAll("/root/", `${root}/`),
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, ".gitconfig") },
        timeout: 15_000,
      });
      if (result.error) throw result.error;
      if (existsSync(join(onDisk(dir), ".git", "HEAD"))) nb.vm.write(`${dir}/.git/HEAD`, fileText(join(onDisk(dir), ".git", "HEAD")));
      return { output: result.stdout + result.stderr, status: result.status ?? 1 };
    };
    return { seen, onDisk };
  }

  it("clones the chat's branch there with OpenResearch's token, and brings the work back after each turn", async () => {
    const p = orx.addProject("Remote", { code: { "src/train.py": "lr = 0.1\n" }, git: true });
    const remote = orx.remotes.get(p.id)!;
    const { nb, ext, chatId } = await open("colab:/drive/remote", { projectId: p.id, settings: { scope: "auto", review: false } });
    let next = true;
    const { seen } = machine(nb, (dir) => {
      if (!next) return;
      next = false;
      writeFileSync(join(dir, "src", "train.py"), "lr = 0.05\n");
      mkdirSync(join(dir, "notes"), { recursive: true });
      writeFileSync(join(dir, "notes", "run.md"), "# Run\n");
    });
    const text = await turn(ext, chatId, "ECHO_PROJECT");
    // The agent is told where the code is.
    const dir = text.match(/<project-code>\nThe project's code is cloned on the notebook's machine at (\/root\/\.ainb-projects\/[\da-f]{32}-remote): git, branch notebook\/test-\w+/)?.[1];
    expect(dir).toBeDefined();
    // The chat's branch is on "GitHub", in a worktree the bridge made (no OpenResearch session behind it).
    const wt = worktreePath(p.id, "colab:/drive/remote");
    const branch = g(wt, "branch", "--show-current");
    expect(branch).toMatch(/^notebook\/test-[0-9a-f]{6}$/);
    expect(orx.sessions.filter((s) => s.projectId === p.id)).toHaveLength(0);
    expect(g(remote, "branch", "--list", branch)).toContain(branch);
    // The machine clones it, signed in by a file the token goes to; the token is in no command.
    const clone = seen.find((c) => c.includes("git clone"))!;
    expect(clone).toContain(`git clone -q --branch '${branch}' 'https://github.com/test/remote.git' '${dir}'`);
    expect(clone).toContain("credential.helper 'store --file=/root/.ainb-git-credentials'");
    expect(nb.vm.read("/root/.ainb-git-credentials")).toBe(`https://x-access-token:${TOKEN_GH}@github.com\n`);
    expect(seen.join("\n")).not.toContain(TOKEN_GH);
    // After the turn: committed and pushed there, and here in the worktree.
    await ext.waitFor(() => ext.parts().some((x) => x.type === "notice" && /Saved the code from the notebook's machine to branch/.test(x.text)), 30_000, "code saved");
    expect(fileText(join(wt, "src", "train.py"))).toBe("lr = 0.05\n");
    expect(fileText(join(wt, "notes", "run.md"))).toBe("# Run\n");
    // The project's own checkout is untouched.
    expect(fileText(join(p.repoPath, "src", "train.py"))).toBe("lr = 0.1\n");
    // The Chat Worktree view gets the worktree; its Changes compare with where the branch started.
    expect(project(ext)?.worktree).toBe(wt);
    const base = readFileSync(g(wt, "rev-parse", "--path-format=absolute", "--git-path", "ainb-base"), "utf8").trim().split(" ");
    expect(base[0]).toBe(g(p.repoPath, "rev-parse", "HEAD"));
    expect(base[1]).toBe("main");
    // The next turn does not clone again while the clone is there.
    const before = seen.filter((c) => c.includes("git clone")).length;
    await turn(ext, chatId, "again");
    expect(seen.filter((c) => c.includes("git clone"))).toHaveLength(before);
    // Nor does it run a script to look at the clone: one small read tells it is still on the branch.
    expect(seen.filter((c) => c.includes("ainb-ready"))).toHaveLength(1);
    // What the agent reads never shows the token.
    nb.vm.write("/content/leak.txt", `token=${TOKEN_GH}\n`);
    const read = await turn(ext, chatId, script([{ tool: "Read", args: { file_path: "/content/leak.txt" } }]));
    expect(read).toContain("token=***");
    expect(read).not.toContain(TOKEN_GH);
    ext.close();
  });

  it("isolates two notebook checkouts and syncs after the agent crashes", async () => {
    const p = orx.addProject("Shared VM", { code: { "base.txt": "base\n" }, git: true });
    const aKey = "colab:/drive/shared-vm-a";
    const bKey = "colab:/drive/shared-vm-b";
    const a = await open(aKey, { projectId: p.id });
    const b = await open(bKey, { projectId: p.id, ext: a.ext });
    b.nb.vm = a.nb.vm;
    const { seen, onDisk } = machine(a.nb);
    try {
      const vmPath = (text: string) => text.match(/at (\/root\/\.ainb-projects\/[^:]+): git/)![1]!;
      const path = (text: string) => onDisk(vmPath(text));
      const aText = await turn(a.ext, a.chatId, "ECHO_PROJECT");
      const aDir = path(aText);
      const bDir = path(await turn(b.ext, b.chatId, "ECHO_PROJECT"));
      expect(aDir).not.toBe(bDir);
      expect(new Set(a.nb.vm.shells.keys()).size).toBe(2);
      writeFileSync(join(aDir, "a.txt"), "A\n");
      writeFileSync(join(bDir, "b.txt"), "B\n");
      await turn(a.ext, a.chatId, "CRASH");
      const aWorktree = worktreePath(p.id, aKey);
      const bWorktree = worktreePath(p.id, bKey);
      await a.ext.waitFor(() => existsSync(join(aWorktree, "a.txt")), 15_000, "sync after crash");
      expect(existsSync(join(aWorktree, "b.txt"))).toBe(false);
      expect(existsSync(join(bWorktree, "a.txt"))).toBe(false);
      const aBranch = g(aDir, "branch", "--show-current");
      g(aDir, "checkout", "-qb", "unexpected");
      // The simulated machine's files follow the real checkout only when a script runs: show it the new HEAD.
      a.nb.vm.write(`${vmPath(aText)}/.git/HEAD`, fileText(join(aDir, ".git", "HEAD")));
      const pushes = () => seen.filter((command) => command.includes("git push")).length;
      const before = pushes();
      // The agent is told which branch the checkout is on and how to get back, not that a clone failed.
      const told = (await turn(a.ext, a.chatId, "ECHO_PROJECT")).replace(/\s+/g, " ");
      expect(told).toContain("is on unexpected, not on the branch of this chat");
      expect(told).toContain(`checkout ${aBranch}`);
      expect(told).not.toContain("Could not clone");
      expect(pushes()).toBe(before);
      expect(g(aDir, "branch", "--show-current")).toBe("unexpected");
      expect(g(orx.remotes.get(p.id)!, "rev-parse", aBranch)).toBe(g(aWorktree, "rev-parse", "HEAD"));
    } finally {
      a.ext.close();
    }
  });

  it("tells the agent the code stays read-only when the project has no GitHub repository", async () => {
    const p = orx.addProject("Local only", { code: { "a.py": "x = 1\n" } });
    const { ext, chatId } = await open("colab:/drive/local-only", { projectId: p.id });
    const text = await turn(ext, chatId, "ECHO_PROJECT");
    expect(text).toMatch(/<project-code>\nThe project Local only has no GitHub repository/);
    expect(ext.parts().some((x) => x.type === "notice" && /has no GitHub repository/.test(x.text))).toBe(true);
    expect(orx.sessions.filter((s) => s.projectId === p.id)).toHaveLength(0);
    ext.close();
  });
});
