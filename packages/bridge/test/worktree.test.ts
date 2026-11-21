// ensureWorktree: a worktree already found is verified by reading git's own
// files (no git process per turn); anything unexpected goes back to git.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../src/project/github.js";
import { ensureWorktree, worktreePath } from "../src/project/worktree.js";

// The real git runs; the spy only counts the spawns ensureWorktree makes.
vi.mock("../src/project/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/project/github.js")>();
  return { ...actual, git: vi.fn(actual.git) };
});

let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.AINB_HOME;
  home = mkdtempSync(join(tmpdir(), "ainb-worktree-home-"));
  process.env.AINB_HOME = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.AINB_HOME;
  else process.env.AINB_HOME = savedHome;
});

beforeEach(() => {
  vi.mocked(git).mockClear();
});

/** A real repository with one commit, for the bridge's git to work on. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ainb-worktree-repo-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test");
  g("config", "user.email", "test@example.com");
  writeFileSync(join(dir, "a.py"), "x = 1\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  return dir;
}

const realGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

describe("ensureWorktree cache", () => {
  it("finds the worktree again without git while it is as it was left", async () => {
    const repo = makeRepo();
    const first = await ensureWorktree(repo, "proj_w", "colab:/drive/wt", "test.ipynb");
    expect(first.path).toBe(worktreePath("proj_w", "colab:/drive/wt"));
    expect(first.branch).toMatch(/^notebook\/test-[0-9a-f]{6}$/);
    expect(vi.mocked(git)).toHaveBeenCalled(); // made with git the first time
    vi.mocked(git).mockClear();
    expect(await ensureWorktree(repo, "proj_w", "colab:/drive/wt", "test.ipynb")).toEqual(first);
    expect(vi.mocked(git)).not.toHaveBeenCalled();
    // A changed title does not rename the branch that exists: still no git.
    expect(await ensureWorktree(repo, "proj_w", "colab:/drive/wt", "another title")).toEqual(first);
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });

  it("goes back to git when HEAD moved, and trusts the files again once it is back", async () => {
    const repo = makeRepo();
    const wt = await ensureWorktree(repo, "proj_h", "colab:/drive/head", "test.ipynb");
    realGit(wt.path, "checkout", "-q", "-b", "unexpected");
    vi.mocked(git).mockClear();
    await expect(ensureWorktree(repo, "proj_h", "colab:/drive/head", "test.ipynb")).rejects.toThrow(`Check out the notebook branch in ${wt.path} before syncing its code.`);
    expect(vi.mocked(git)).toHaveBeenCalled();
    realGit(wt.path, "checkout", "-q", wt.branch);
    vi.mocked(git).mockClear();
    expect(await ensureWorktree(repo, "proj_h", "colab:/drive/head", "test.ipynb")).toEqual(wt);
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });

  it("makes the worktree again when its folder was deleted by hand", async () => {
    const repo = makeRepo();
    const wt = await ensureWorktree(repo, "proj_d", "colab:/drive/deleted", "test.ipynb");
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path], { stdio: "pipe" });
    vi.mocked(git).mockClear();
    expect(await ensureWorktree(repo, "proj_d", "colab:/drive/deleted", "test.ipynb")).toEqual(wt);
    expect(vi.mocked(git)).toHaveBeenCalled();
    vi.mocked(git).mockClear();
    expect(await ensureWorktree(repo, "proj_d", "colab:/drive/deleted", "test.ipynb")).toEqual(wt);
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });

  it("keeps two notebooks' worktrees apart", async () => {
    const repo = makeRepo();
    const a = await ensureWorktree(repo, "proj_k", "colab:/drive/one", "test.ipynb");
    const b = await ensureWorktree(repo, "proj_k", "colab:/drive/two", "test.ipynb");
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
    vi.mocked(git).mockClear();
    expect(await ensureWorktree(repo, "proj_k", "colab:/drive/one", "test.ipynb")).toEqual(a);
    expect(await ensureWorktree(repo, "proj_k", "colab:/drive/two", "test.ipynb")).toEqual(b);
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });
});