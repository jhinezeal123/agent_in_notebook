// Notebook chats in OpenResearch projects, through the real bridge, a scripted
// agent and a stand-in for OpenResearch's API: which project a notebook
// belongs to, what the agent is told about it, and the project tools.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSettings, ChatSnapshot, Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { ChatStore, keyHash } from "../src/store.js";
import { worktreePath } from "../src/project/worktree.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";
import { FakeOrx } from "./fixtures/fake-orx-api.js";

const TOKEN = "test-token-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
const MISSING = () => ({ missing: "OpenResearch is not used in these tests." });

let home: string;
let orx: FakeOrx;
let bridge: Bridge;
let port: number;
let nextTab = 500;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ainb-projects-"));
  process.env.AINB_HOME = home;
  process.env.AINB_SCRATCH_DIR = join(home, "OpenResearch", "scratch");
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 5 }]));
  orx = new FakeOrx();
  const orxPort = await orx.start();
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: { knownPorts: [orxPort], locate: MISSING }, log: () => {} });
  port = await bridge.listen();
});

afterAll(async () => {
  await bridge?.close();
  await orx?.close();
  delete process.env.AINB_SCRATCH_DIR;
});

const script = (steps: unknown[]) => `SCRIPT: ${JSON.stringify(steps)}`;

async function open(key: string, opts: { projectId?: string; settings?: Partial<ChatSettings>; port?: number; ready?: boolean } = {}) {
  const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
  const ext = new FakeExtension(nb, nextTab++);
  await ext.connect(opts.port ?? port, TOKEN);
  const snap = await ext.request<ChatSnapshot>("chat.open", {
    tabId: ext.tabId,
    agentId: "fake",
    settings: { scope: "write", review: false, targetCellIds: [], notebookOnly: true, ...opts.settings },
    platform: "colab",
    notebookKey: key,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });
  await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");
  if (opts.ready !== false) await ext.waitFor(() => project(ext, snap)?.state === "ready", 15_000, "project ready");
  return { nb, ext, chatId: snap.chatId, first: snap };
}

/** The chat's project as last sent. */
function project(ext: FakeExtension, first?: ChatSnapshot) {
  return (ext.snapshots.at(-1) ?? first)?.project;
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
});

describe("what the agent is told about the project", () => {
  it("gives the whole project on the first turn, then only what changed", async () => {
    const p = orx.addProject("Speech", { code: { "README.md": "# Speech\nTrain a small ASR model.", "src/train.py": "lr = 0.1\n" } });
    orx.experiments.push({ id: "exp_1", projectId: p.id, slug: "baseline", branchName: "orx/baseline", title: "Baseline", description: "The paper's setup", archived: false, createdAt: 1, updatedAt: 1 });
    const { ext, chatId } = await open("colab:/drive/speech", { projectId: p.id });
    const first = await turn(ext, chatId, "ECHO_PROJECT");
    expect(first).toContain("<project-context>");
    expect(first).toContain("Project: Speech");
    expect(first).toContain("baseline \"Baseline\" [not run] branch orx/baseline");
    expect(first).toContain("Train a small ASR model.");
    expect(await turn(ext, chatId, "ECHO_PROJECT")).toContain("[no project block]");

    const run = { id: "run_1", experimentId: "exp_1", projectId: p.id, status: "done", resultMarkdown: "WER 12.3%", createdAt: 2, startedAt: 2, endedAt: 3 };
    orx.runs.push(run);
    mkdirSync(join(p.artifactsDir, "figures"), { recursive: true });
    writeFileSync(join(p.artifactsDir, "figures", "wer.png"), "png");
    orx.emit("run.updated", { run });
    await sleep(300);
    const update = await turn(ext, chatId, "ECHO_PROJECT");
    expect(update).toContain("<project-update>");
    expect(update).toContain("Experiment baseline: not run → done");
    expect(update).toContain("WER 12.3%");
    expect(update).toContain("artifacts/figures/wer.png");
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
});

describe("the project's code on the notebook's machine", () => {
  const TOKEN_GH = "ghp_testtoken_0123456789";
  beforeAll(() => {
    process.env.AINB_GITHUB_TOKEN = TOKEN_GH;
  });
  afterAll(() => {
    delete process.env.AINB_GITHUB_TOKEN;
  });

  /** A file as text, whatever line ends git checked it out with (Windows). */
  const fileText = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  /** git on this computer, for the test's own checks. */
  const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

  /**
   * The machine's side, as a real one would do it: the clone script answers
   * ready; the push script stands for the agent's work, committing `change`
   * to the branch on "GitHub".
   */
  function machine(nb: FakeNotebook, remote: string, change: () => Record<string, string> | null) {
    const seen: string[] = [];
    nb.vm.run = (command) => {
      seen.push(command);
      if (command.includes("git clone") || command.includes("git fetch -q origin")) return { output: "ainb-ready abc1234\n", status: 0 };
      if (command.includes("git push")) {
        const files = change();
        const branch = /refs\/heads\/'([^']+)'/.exec(command)![1]!;
        if (files) {
          const work = mkdtempSync(join(tmpdir(), "vm-clone-"));
          g(work, "clone", "-q", "--branch", branch, remote, ".");
          g(work, "config", "user.name", "VM");
          g(work, "config", "user.email", "vm@example.com");
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(work, path)), { recursive: true });
            writeFileSync(join(work, path), content);
          }
          g(work, "add", "-A");
          g(work, "commit", "-q", "-m", "work on the machine");
          g(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        }
        return { output: `${files ? "ainb-committed\n" : ""}ainb-pushed def5678\n`, status: 0 };
      }
      return undefined;
    };
    return seen;
  }

  it("clones the chat's branch there with OpenResearch's token, and brings the work back after each turn", async () => {
    const p = orx.addProject("Remote", { code: { "src/train.py": "lr = 0.1\n" }, git: true });
    const remote = orx.remotes.get(p.id)!;
    const { nb, ext, chatId } = await open("colab:/drive/remote", { projectId: p.id, settings: { scope: "auto", review: false } });
    let next: Record<string, string> | null = { "src/train.py": "lr = 0.05\n", "notes/run.md": "# Run\n" };
    const seen = machine(nb, remote, () => {
      const c = next;
      next = null;
      return c;
    });
    const text = await turn(ext, chatId, "ECHO_PROJECT");
    // The agent is told where the code is.
    expect(text).toMatch(/<project-code>\nThe project's code is cloned on the notebook's machine at \/content\/remote: git, branch notebook\/test-\w+/);
    // The chat's branch is on "GitHub", in a worktree the bridge made (no OpenResearch session behind it).
    const wt = worktreePath(p.id, "colab:/drive/remote");
    const branch = g(wt, "branch", "--show-current");
    expect(branch).toMatch(/^notebook\/test-[0-9a-f]{6}$/);
    expect(orx.sessions.filter((s) => s.projectId === p.id)).toHaveLength(0);
    expect(g(remote, "branch", "--list", branch)).toContain(branch);
    // The machine clones it, signed in by a file the token goes to; the token is in no command.
    const clone = seen.find((c) => c.includes("git clone"))!;
    expect(clone).toContain(`git clone -q --branch '${branch}' 'https://github.com/test/remote.git' '/content/remote'`);
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
    nb.vm.write("/content/remote/.git/HEAD", "ref: refs/heads/x\n");
    const before = seen.filter((c) => c.includes("git clone")).length;
    await turn(ext, chatId, "again");
    expect(seen.filter((c) => c.includes("git clone"))).toHaveLength(before);
    // What the agent reads never shows the token.
    nb.vm.write("/content/leak.txt", `token=${TOKEN_GH}\n`);
    const read = await turn(ext, chatId, script([{ tool: "Read", args: { file_path: "/content/leak.txt" } }]));
    expect(read).toContain("token=***");
    expect(read).not.toContain(TOKEN_GH);
    ext.close();
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
