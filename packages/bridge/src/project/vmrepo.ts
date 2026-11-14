// A notebook chat's code, worked on where the notebook runs. When the chat
// starts working, its project gets a branch of its own (in the chat's
// worktree on the user's computer, worktree.ts), pushed to the project's
// GitHub repository; the notebook's machine clones that branch with
// OpenResearch's GitHub token, and the agent works there with its usual tools.
// After each turn the bridge commits what changed on the machine, pushes it,
// and brings it into the worktree.

import type { NotebookInfo, NotebookOp } from "@ainb/protocol";
import { capText } from "@ainb/protocol";
import type { KernelExec } from "../notebook/kernel.js";
import { reachable } from "../notebook/nbfile.js";
import { runInSession } from "../notebook/setup.js";
import { hello, stat, writeFile } from "../notebook/vmfs.js";
import { git, GitFailed, githubToken, identity, redact, remoteOf, signsIn } from "./github.js";
import type { Worktree } from "./worktree.js";

/** What the sync needs of a project (OpenResearch's record, or the copy a notebook keeps). */
export interface CodeProject {
  id: string;
  name: string;
  repoPath: string;
  githubUrl: string | null;
}

/** The terminal session on the notebook's machine the bridge clones and pushes in (the agent can look: shell_wait). */
export const CODE_SESSION = "project";
/** Files bigger than this stay on the machine (GitHub refuses files over 100 MB). */
const BIG_MB = 50;
const CLONE_WAIT_MS = 180_000;
const PUSH_WAIT_MS = 120_000;

export interface CodePlace {
  projectId: string;
  /** The clone on the notebook's machine. */
  dir: string;
  branch: string;
  remote: string;
  /** The chat's worktree on the user's computer. */
  worktree: string;
}

export type CodeState =
  | { state: "ready"; place: CodePlace }
  /** No code on the machine, and why (the project has no GitHub repository, say). */
  | { state: "none"; why: string }
  | { state: "error"; why: string };

export interface SyncResult {
  /** Something was committed or pushed. */
  changed: boolean;
  /** Short, for the chat. */
  text: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class CodeSync {
  private place: CodePlace | null = null;
  /** Clones and pushes one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly call: (op: NotebookOp, timeoutMs?: number) => Promise<unknown>,
    /** Names the notebook's machine, for its terminal sessions. */
    private readonly target: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get current(): CodePlace | null {
    return this.place;
  }

  private exec(): KernelExec {
    return (code, wait) => this.call({ op: "machine_exec", code, waitMs: wait }, wait + 15_000) as ReturnType<KernelExec>;
  }

  /**
   * Have the project's code on the notebook's machine: the chat's branch and
   * worktree here, a clone of the branch there. Cheap once done (it checks the
   * clone is still there: a Colab machine is replaced after a while).
   */
  ensure(project: CodeProject, worktree: () => Promise<Worktree>): Promise<CodeState> {
    return this.serial(() => this.ensureNow(project, worktree));
  }

  private async ensureNow(project: CodeProject, worktree: () => Promise<Worktree>): Promise<CodeState> {
    const remote = remoteOf(project);
    if (!remote) {
      this.place = null;
      return { state: "none", why: `The project ${project.name} has no GitHub repository, so its code is not put on the notebook's machine. Its shared artifacts can still be read and written.` };
    }
    let info: NotebookInfo;
    try {
      info = (await this.call({ op: "info" })) as NotebookInfo;
    } catch (e) {
      return { state: "error", why: `The notebook is not reachable: ${(e as Error).message}` };
    }
    if (!reachable(info)) return { state: "none", why: `The notebook's kernel runs ${info.language}; the project's code is put on its machine only through a Python kernel.` };
    let token: string | undefined;
    try {
      const wt = await worktree();
      token = signsIn(remote) ? await githubToken() : undefined;
      const exec = this.exec();
      const known = this.place?.worktree === wt.path && this.place.projectId === project.id ? this.place : null;
      if (known) {
        const [there] = await stat(exec, [`${known.dir}/.git`]);
        if (there?.dir) return { state: "ready", place: known };
      }
      const branch = wt.branch;
      if (!known) await this.publish(wt, remote, token);
      const h = await hello(exec);
      if (!h.posix) return { state: "none", why: "The notebook's machine does not run Linux or macOS; the project's code is put only on those." };
      const name = remote.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.git$/i, "") || "project";
      const dir = `${h.cwd.replace(/\/+$/, "")}/${name}`;
      const credentials = `${h.home.replace(/\/+$/, "")}/.ainb-git-credentials`;
      // The token goes to a file only git reads, never through a cell, the terminal's screen or the chat.
      if (token) await writeFile(exec, credentials, Buffer.from(`https://x-access-token:${token}@github.com\n`, "utf8"));
      const who = await identity(wt.path);
      const script = [
        "(",
        "set -e",
        ...(token ? [`chmod 600 ${q(credentials)}`, `git config --global credential.helper ${q(`store --file=${credentials}`)}`] : []),
        `git config --global user.name ${q(who.name)}`,
        `git config --global user.email ${q(who.email)}`,
        `if [ -d ${q(`${dir}/.git`)} ]; then`,
        `  cd ${q(dir)}`,
        `  git fetch -q origin ${q(branch)}`,
        // A clone left from another branch (the notebook moved to another project of the same repository) moves to this one.
        `  if [ "$(git branch --show-current)" != ${q(branch)} ]; then git checkout -q -B ${q(branch)} FETCH_HEAD; fi`,
        "else",
        `  git clone -q --branch ${q(branch)} ${q(remote)} ${q(dir)}`,
        `  cd ${q(dir)}`,
        "fi",
        `git branch -q --set-upstream-to=origin/${branch} 2>/dev/null || true`,
        'echo "ainb-ready $(git rev-parse --short HEAD)"',
        ")",
      ].join("\n");
      const r = await runInSession(this.call, this.target, CODE_SESSION, script, CLONE_WAIT_MS);
      const out = redact(r.output, token);
      if (r.running) return { state: "error", why: `Cloning the project's code is still running on the notebook's machine (terminal session "${CODE_SESSION}"). It is used once it finishes.` };
      if (r.exitCode !== 0 || !/ainb-ready/.test(out)) {
        const offline = /could not resolve host|network is unreachable|temporary failure in name resolution/i.test(out);
        const hint = offline && info.platform === "kaggle" ? " Turn on Internet in the Kaggle notebook's settings (Session options), then try again." : "";
        return { state: "error", why: `Could not clone the project's code on the notebook's machine:\n${capText(out, 1500)}${hint}` };
      }
      this.place = { projectId: project.id, dir, branch, remote, worktree: wt.path };
      this.log(`Code of ${project.name} on the notebook's machine at ${dir}, branch ${branch}.`);
      return { state: "ready", place: this.place };
    } catch (e) {
      const why = redact(e instanceof GitFailed ? e.message : (e as Error).message ?? String(e), token);
      return { state: "error", why };
    }
  }

  /** The chat's branch on GitHub, so the notebook's machine can clone it; what was pushed before (the bridge restarted) is brought here first. */
  private async publish(wt: Worktree, remote: string, token: string | undefined): Promise<void> {
    const fetched = await git(wt.path, ["fetch", "-q", remote, `refs/heads/${wt.branch}`], token).then(() => true, (e: Error) => {
      if (/couldn't find remote ref|could not find remote ref/i.test(e.message)) return false;
      throw e;
    });
    if (fetched) await git(wt.path, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    await git(wt.path, ["push", "-q", remote, `HEAD:refs/heads/${wt.branch}`], token);
  }

  /**
   * After a turn: commit what changed on the machine (big files stay there),
   * push the branch, and bring it into the worktree on the user's computer.
   */
  syncBack(message: string): Promise<SyncResult | null> {
    return this.serial(async () => {
      const place = this.place;
      if (!place) return null;
      const token = signsIn(place.remote) ? await githubToken().catch(() => undefined) : undefined;
      const script = [
        "(",
        "set -e",
        `cd ${q(place.dir)}`,
        // Big files git does not track already are kept out of commits, on the machine.
        `find . -path ./.git -prune -o -type f -size +${BIG_MB}M -print | sed 's|^\\./||' | while IFS= read -r f; do`,
        '  if ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then',
        '    grep -qxF -- "/$f" .git/info/exclude 2>/dev/null || echo "/$f" >> .git/info/exclude',
        '    echo "ainb-big $f"',
        "  fi",
        "done",
        "git add -A",
        `if ! git diff --cached --quiet; then git commit -q -m ${q(message)}; echo ainb-committed; fi`,
        `git push -q origin HEAD:refs/heads/${q(place.branch)} 2>&1`,
        'echo "ainb-pushed $(git rev-parse --short HEAD)"',
        ")",
      ].join("\n");
      let r;
      try {
        r = await runInSession(this.call, this.target, CODE_SESSION, script, PUSH_WAIT_MS);
      } catch (e) {
        return { changed: false, text: `Could not save the code from the notebook's machine: ${(e as Error).message}` };
      }
      const out = redact(r.output, token);
      const bigs = [...out.matchAll(/^ainb-big (.+)$/gm)].map((m) => m[1]!.trim());
      const note = bigs.length ? ` Left on the machine (over ${BIG_MB} MB): ${bigs.slice(0, 10).join(", ")}${bigs.length > 10 ? "…" : ""}.` : "";
      if (r.running) return { changed: false, text: `Pushing the code from the notebook's machine is taking long; it goes on there (terminal session "${CODE_SESSION}").` };
      if (r.exitCode !== 0 || !/ainb-pushed/.test(out)) {
        if (/no such file or directory/i.test(out) && out.includes(place.dir)) {
          // The machine was replaced: ensure() clones the branch again next turn.
          return { changed: false, text: "The project's code is no longer on the notebook's machine (it was restarted). It is cloned again on the next message; what was not pushed before is lost." };
        }
        return { changed: false, text: `Could not push the code from the notebook's machine:\n${capText(out, 1200)}` };
      }
      let before = "";
      try {
        before = await git(place.worktree, ["rev-parse", "HEAD"]);
        await git(place.worktree, ["fetch", "-q", place.remote, `refs/heads/${place.branch}`], token);
        await git(place.worktree, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
      } catch (e) {
        return { changed: true, text: `The code was pushed to GitHub (branch ${place.branch}), but not brought into the worktree on this computer: ${(e as Error).message}` };
      }
      const after = await git(place.worktree, ["rev-parse", "HEAD"]).catch(() => before);
      const changed = after !== before;
      return { changed, text: changed ? `Saved the code from the notebook's machine to branch ${place.branch}.${note}` : note.trim() };
    });
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }
}
