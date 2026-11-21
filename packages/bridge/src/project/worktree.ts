// A notebook chat's worktree: its own checkout of the project's repository,
// on a branch of its own, made by the bridge with git (no OpenResearch session
// behind it). It lives in the bridge's data folder, one per notebook and
// project. The notebook's machine clones the branch from GitHub, and the
// bridge brings what is pushed back here (vmrepo.ts).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dataDir } from "../config.js";
import { keyHash } from "../store.js";
import { git } from "./github.js";

export interface Worktree {
  path: string;
  branch: string;
}

/** Where a git worktree records where its branch started (VS Code's Changes view compares against it). */
export const BASE_FILE = "ainb-base";

/** Worktrees already found, by repository, project and notebook: every turn asks for the same one. */
const found = new Map<string, Worktree>();

/**
 * Whether the worktree is still on the branch it was found on, by reading git's
 * own files (the `.git` file points at the git dir, whose HEAD names the branch).
 * No git process: a cache hit must cost less than the spawn it saves.
 */
async function stillOnBranch(path: string, branch: string): Promise<boolean> {
  try {
    const m = /^gitdir: (.+)$/.exec((await readFile(join(path, ".git"), "utf8")).trim());
    if (!m) return false;
    const gitDir = resolve(path, m[1]!.trim());
    if (!existsSync(gitDir)) return false;
    return (await readFile(join(gitDir, "HEAD"), "utf8")).trim() === `ref: refs/heads/${branch}`;
  } catch {
    return false; // anything unreadable: let git itself answer
  }
}

function slug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\.ipynb$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "notebook";
}

/** The folder of a notebook's worktree in a project. */
export function worktreePath(projectId: string, notebookKey: string): string {
  return join(dataDir(), "worktrees", projectId.replace(/[^A-Za-z0-9_-]/g, "_"), keyHash(notebookKey));
}

/**
 * The notebook chat's worktree in the project's repository: made on a new
 * branch `notebook/<title>-<id>` from what the repository has checked out,
 * or found again.
 */
export async function ensureWorktree(repoPath: string, projectId: string, notebookKey: string, title: string): Promise<Worktree> {
  if (!repoPath || !existsSync(repoPath)) throw new Error(`The project's repository is not at ${repoPath || "a known place"} on this computer.`);
  const path = worktreePath(projectId, notebookKey);
  const suffix = keyHash(notebookKey).slice(0, 6);
  const key = JSON.stringify([repoPath, projectId, notebookKey]);
  const cached = found.get(key);
  if (cached && cached.path === path && await stillOnBranch(path, cached.branch)) return cached;
  if (existsSync(join(path, ".git"))) {
    const branch = await git(path, ["branch", "--show-current"]);
    if (branch.startsWith("notebook/") && branch.endsWith(`-${suffix}`)) {
      found.set(key, { path, branch });
      return { path, branch };
    }
    throw new Error(`Check out the notebook branch in ${path} before syncing its code.`);
  }
  await git(repoPath, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new Error("The project's repository has no commit yet; a branch for the notebook needs one.");
  });
  // A worktree folder deleted by hand is still registered: forget it first.
  await git(repoPath, ["worktree", "prune"]).catch(() => {});
  await mkdir(dirname(path), { recursive: true });
  const branch = `notebook/${slug(title)}-${suffix}`;
  const exists = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) await git(repoPath, ["worktree", "add", "-q", path, branch]);
  else {
    const base = await git(repoPath, ["rev-parse", "HEAD"]);
    const from = (await git(repoPath, ["branch", "--show-current"]).catch(() => "")) || base.slice(0, 7);
    await git(repoPath, ["worktree", "add", "-q", "-b", branch, path, base]);
    const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"]);
    await writeFile(join(gitDir, BASE_FILE), `${base} ${from}\n`);
  }
  found.set(key, { path, branch });
  return { path, branch };
}
