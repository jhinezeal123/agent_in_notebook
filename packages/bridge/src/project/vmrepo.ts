// A notebook chat's code, worked on where the notebook runs. When the chat
// starts working, its project gets a branch of its own (in the chat's
// worktree on the user's computer, worktree.ts), pushed to the project's
// GitHub repository; the notebook's machine clones that branch with
// OpenResearch's GitHub token, and the agent works there with its usual tools.
// After each turn the bridge commits what changed on the machine, pushes it,
// and brings it into the worktree.

import type { NotebookInfo, NotebookOp } from "@ainb/protocol";
import { capText } from "@ainb/protocol";
import { posix } from "node:path";
import { Unreachable, type KernelExec } from "../notebook/kernel.js";
import { reachable } from "../notebook/nbfile.js";
import { runInSession } from "../notebook/setup.js";
import { hello, readFile, stat, writeFile } from "../notebook/vmfs.js";
import { keyHash } from "../store.js";
import { git, GitFailed, githubToken, identity, redact, remoteOf, signsIn } from "./github.js";
import type { Worktree } from "./worktree.js";

/** What the sync needs of a project (OpenResearch's record, or the copy a notebook keeps). */
export interface CodeProject {
  id: string;
  name: string;
  repoPath: string;
  githubUrl: string | null;
}

/** Files bigger than this stay on the machine (GitHub refuses files over 100 MB). */
const BIG_MB = 50;
const CLONE_WAIT_MS = 180_000;
const PUSH_WAIT_MS = 120_000;
/** A push still running after PUSH_WAIT_MS is watched this much longer, then left to the machine. */
const PUSH_EXTRA_WAIT_MS = 180_000;

export interface CodePlace {
  projectId: string;
  /** The clone on the notebook's machine. */
  dir: string;
  branch: string;
  remote: string;
  session: string;
  /** The chat's worktree on the user's computer. */
  worktree: string;
}

export type CodeState =
  | { state: "ready"; place: CodePlace }
  /** No code on the machine, and why (the project has no GitHub repository, say). */
  | { state: "none"; why: string }
  | { state: "error"; why: string };

export interface SyncResult {
  /** False when saving failed or is still busy; autosave retries quietly. */
  ok: boolean;
  /** Something was committed or pushed. */
  changed: boolean;
  /** Short, for the chat. */
  text: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Stop unless the clone is as the bridge left it: a git checkout of the
 * project's repository, on the chat's branch. It is never switched or repaired
 * here (the work in it is the agent's); the line it prints says what to do.
 */
function verifyCheckout(dir: string, branch: string, remote: string): string[] {
  const stop = (format: string, ...args: string[]) => `{ printf ${q(`ainb-checkout: ${format}\\n`)} ${args.join(" ")}; exit 1; }`;
  return [
    `cd ${q(dir)}`,
    `[ -d .git ] || ${stop("%s is not a git checkout any more.", q(dir))}`,
    `[ "$(git config --get remote.origin.url)" = ${q(remote)} ] || ${stop("The remote origin of %s is no longer the project repository. Nothing is saved from it until origin is set back.", q(dir))}`,
    'ainb_head="$(git symbolic-ref -q --short HEAD || echo "no branch")"',
    `[ "$ainb_head" = ${q(branch)} ] || ${stop("The checkout at %s is on %s, not on the branch of this chat. Nothing is saved from it until that branch is checked out again: git -C %s checkout %s", q(dir), '"$ainb_head"', q(dir), q(branch))}`,
  ];
}

/** What verifyCheckout said is wrong with the clone, if it stopped the script. */
function checkoutProblem(out: string): string | null {
  return out.match(/^ainb-checkout: (.+)$/m)?.[1]?.trim() ?? null;
}

const credentialLine = (token: string) => Buffer.from(`https://x-access-token:${token}@github.com\n`, "utf8");

export class CodeSync {
  private place: CodePlace | null = null;
  /** Clones and pushes one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The file on the machine git reads the GitHub token from, and the token last written to it. */
  private credentials: { file: string; token: string } | null = null;

  constructor(
    private readonly call: (op: NotebookOp, timeoutMs?: number) => Promise<unknown>,
    /** Names the notebook's machine, for its terminal sessions. */
    private readonly target: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get current(): CodePlace | null {
    return this.place;
  }

  /** The notebook's machine was replaced: nothing verified on the old one may be restored (a busy kernel must not bring it back). */
  invalidate(): void {
    this.place = null;
    this.credentials = null;
  }

  private exec(): KernelExec {
    return (code, wait) => this.call({ op: "machine_exec", code, waitMs: wait }, wait + 15_000) as ReturnType<KernelExec>;
  }

  /**
   * Have the project's code on the notebook's machine: the chat's branch and
   * worktree here, a clone of the branch there. Cheap once done (it checks the
   * clone is still there: a Colab machine is replaced after a while).
   *
   * The read-only check of a clone already there runs OUTSIDE the serial chain:
   * a push (syncBack) can hold the chain for minutes, and the next turn must not
   * wait behind it just to learn the clone is still on the branch. Only the
   * writing path (clone, publish, credentials) queues behind a push.
   */
  ensure(project: CodeProject, worktree: () => Promise<Worktree>): Promise<CodeState> {
    return this.fastPath(project, worktree).then((st) => st ?? this.serial(() => this.ensureNow(project, worktree)));
  }

  /**
   * One small read (.git/HEAD) tells whether the clone verified on an earlier
   * turn is still on the chat's branch. Reading HEAD while a push commits is
   * safe: git writes HEAD to a lock file and renames it into place, so a reader
   * sees either the old or the new whole value, never a half-written one. The
   * worktree is only read here too (ensureWorktree hits its cache and reads git's
   * files), so this does not race the push's git in the worktree. Null means the
   * full, serialized check must decide.
   */
  private async fastPath(project: CodeProject, worktree: () => Promise<Worktree>): Promise<CodeState | null> {
    const previous = this.place;
    if (!previous) return null;
    const remote = remoteOf(project);
    if (!remote || previous.projectId !== project.id || previous.remote !== remote) return null;
    let wt: Worktree;
    try {
      wt = await worktree();
    } catch {
      return null;
    }
    if (previous.worktree !== wt.path || previous.branch !== wt.branch) return null;
    try {
      const head = (await readFile(this.exec(), `${previous.dir}/.git/HEAD`, 4096)).data.toString("utf8").trim();
      if (head !== `ref: refs/heads/${previous.branch}`) return null;
    } catch (e) {
      // The machine answers "busy" (a cell running on Colab) or cannot be reached:
      // the clone was verified earlier and nothing says it changed. Keep it
      // unverified (busy-restore); the next turn that reaches the machine checks
      // again. A replaced machine was invalidated, so its place is already gone.
      if (!(e instanceof Unreachable)) return null; // HEAD gone or another failure: the full check decides.
    }
    // invalidate() (the machine was replaced) may have cleared the place while we read.
    if (this.place !== previous) return null;
    return { state: "ready", place: previous };
  }

  private async ensureNow(project: CodeProject, worktree: () => Promise<Worktree>): Promise<CodeState> {
    const previous = this.place;
    this.place = null;
    const remote = remoteOf(project);
    if (!remote) {
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
      // Nothing changed since the last turn and the clone is still on the chat's branch (one small read on
      // the machine): no terminal script. syncBack checks the rest (the remote, a new token) before it pushes.
      if (previous && previous.projectId === project.id && previous.remote === remote && previous.worktree === wt.path && previous.branch === wt.branch) {
        try {
          const head = (await readFile(this.exec(), `${previous.dir}/.git/HEAD`, 4096)).data.toString("utf8").trim();
          if (head === `ref: refs/heads/${previous.branch}`) {
            this.place = previous;
            return { state: "ready", place: previous };
          }
        } catch (e) {
          // The machine itself answers "busy" (a cell running on Colab) or cannot be reached right now:
          // the clone was verified on an earlier turn and nothing says it changed. Keep it unverified;
          // the next turn that reaches the machine checks it again. A replaced machine is invalidated.
          if (e instanceof Unreachable) {
            this.place = previous;
            return { state: "ready", place: previous };
          }
          // Any other failure (HEAD gone, say) falls through to the full check below.
        }
      }
      token = signsIn(remote) ? await githubToken() : undefined;
      const exec = this.exec();
      const branch = wt.branch;
      const h = await hello(exec);
      if (!h.posix) return { state: "none", why: "The notebook's machine does not run Linux or macOS; the project's code is put only on those." };
      const name = remote.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.git$/i, "") || "project";
      const key = keyHash(JSON.stringify([this.target, project.id, remote, branch]));
      const dir = posix.join(h.home, ".ainb-projects", `${key}-${name}`);
      const session = `project-${key.slice(0, 16)}`;
      const known = previous?.worktree === wt.path && previous.dir === dir;
      if (!known) await this.publish(wt, remote, token);
      const credentials = `${h.home.replace(/\/+$/, "")}/.ainb-git-credentials`;
      const [checkout] = await stat(exec, [`${dir}/.git`]);
      // Written again when the token changed (the user signed in again), or the machine may have been replaced.
      const configureCredentials = !!token && (!known || !checkout?.dir || this.credentials?.file !== credentials || this.credentials.token !== token);
      if (token && configureCredentials) {
        await writeFile(exec, credentials, credentialLine(token));
        this.credentials = { file: credentials, token };
      }
      const who = checkout?.dir ? null : await identity(wt.path);
      const script = [
        "(",
        "set -e",
        // A refused token fails the command; git never waits for a name typed in the terminal.
        "export GIT_TERMINAL_PROMPT=0",
        ...(configureCredentials ? [`chmod 600 ${q(credentials)}`, `git config --global credential.helper ${q(`store --file=${credentials}`)}`] : []),
        ...(who ? [
          `if [ ! -d ${q(dir)}/.git ]; then`,
          // What a clone that was cut short left is set aside, and the clone made again.
          `  if [ -e ${q(dir)} ]; then mv ${q(dir)} ${q(dir)}.broken-$(date +%s); fi`,
          `  rm -rf ${q(dir)}.tmp-*`,
          `  mkdir -p ${q(posix.dirname(dir))}`,
          // Cloned beside its place and moved there whole, so a clone cut short is never taken for the checkout.
          `  git clone -q --branch ${q(branch)} ${q(remote)} ${q(dir)}.tmp-$$`,
          `  git -C ${q(dir)}.tmp-$$ config --local user.name ${q(who.name)}`,
          `  git -C ${q(dir)}.tmp-$$ config --local user.email ${q(who.email)}`,
          `  mv ${q(dir)}.tmp-$$ ${q(dir)}`,
          "fi",
        ] : []),
        ...verifyCheckout(dir, branch, remote),
        'echo "ainb-ready $(git rev-parse --short HEAD)"',
        ")",
      ].join("\n");
      const r = await runInSession(this.call, this.target, session, script, CLONE_WAIT_MS);
      const out = redact(r.output, token);
      if (r.running) return { state: "error", why: `Cloning the project's code is still running on the notebook's machine (terminal session "${session}"). It is used once it finishes.` };
      const problem = checkoutProblem(out);
      if (problem) return { state: "error", why: problem };
      if (r.exitCode !== 0 || !/ainb-ready/.test(out)) {
        const offline = /could not resolve host|network is unreachable|temporary failure in name resolution/i.test(out);
        const hint = offline && info.platform === "kaggle" ? " Turn on Internet in the Kaggle notebook's settings (Session options), then try again." : "";
        return { state: "error", why: `Could not clone the project's code on the notebook's machine:\n${capText(out, 1500)}${hint}` };
      }
      this.place = { projectId: project.id, dir, branch, remote, session, worktree: wt.path };
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
    if (await git(wt.path, ["branch", "--show-current"]) !== wt.branch) throw new Error(`Check out ${wt.branch} in the local worktree.`);
    if (fetched) await git(wt.path, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    const ref = `refs/heads/${wt.branch}`;
    await git(wt.path, ["push", "-q", remote, `${ref}:${ref}`], token);
  }

  /**
   * After a turn: commit what changed on the machine (big files stay there),
   * push the branch, and bring it into the worktree on the user's computer.
   */
  syncBack(place: CodePlace, message: string, onWaiting: () => void): Promise<SyncResult> {
    return this.serial(async () => {
      const token = signsIn(place.remote) ? await githubToken().catch(() => undefined) : undefined;
      // The user signed in to GitHub again since the clone: the machine gets the new token before it pushes.
      let renewed: string[] = [];
      if (token && this.credentials && this.credentials.token !== token) {
        const { file } = this.credentials;
        try {
          await writeFile(this.exec(), file, credentialLine(token));
          this.credentials = { file, token };
          renewed = [`chmod 600 ${q(file)}`];
        } catch {
          // The push says what is wrong if the old token no longer works.
        }
      }
      const script = [
        "(",
        "set -e",
        "export GIT_TERMINAL_PROMPT=0",
        ...renewed,
        ...verifyCheckout(place.dir, place.branch, place.remote),
        // Big files git does not track already are kept out of commits, on the machine.
        `find . -path ./.git -prune -o -type f -size +${BIG_MB}M -print | sed 's|^\\./||' | while IFS= read -r f; do`,
        '  if ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then',
        '    grep -qxF -- "/$f" .git/info/exclude 2>/dev/null || echo "/$f" >> .git/info/exclude',
        '    echo "ainb-big $f"',
        "  fi",
        "done",
        "git add -A",
        `if ! git diff --cached --quiet; then git commit -q -m ${q(message)}; echo ainb-committed; fi`,
        ...verifyCheckout(place.dir, place.branch, place.remote),
        `git push -q origin ${q(`refs/heads/${place.branch}:refs/heads/${place.branch}`)} 2>&1`,
        'echo "ainb-pushed $(git rev-parse --short HEAD)"',
        ")",
      ].join("\n");
      let r;
      try {
        r = await runInSession(this.call, this.target, place.session, script, PUSH_WAIT_MS, onWaiting, PUSH_EXTRA_WAIT_MS);
      } catch (e) {
        return { ok: false, changed: false, text: `Could not save the code from the notebook's machine: ${(e as Error).message}` };
      }
      const out = redact(r.output, token);
      const bigs = [...out.matchAll(/^ainb-big (.+)$/gm)].map((m) => m[1]!.trim());
      const note = bigs.length ? ` Left on the machine (over ${BIG_MB} MB): ${bigs.slice(0, 10).join(", ")}${bigs.length > 10 ? "…" : ""}.` : "";
      if (r.running) return { ok: false, changed: false, text: `Pushing the code from the notebook's machine is still not done; it goes on there (terminal session "${place.session}"). What it pushes reaches this computer after a later message.` };
      const problem = checkoutProblem(out);
      if (problem) return { ok: false, changed: false, text: `The code on the notebook's machine was not saved. ${problem}` };
      if (r.exitCode !== 0 || !/ainb-pushed/.test(out)) {
        if (/no such file or directory/i.test(out) && out.includes(place.dir)) {
          // The machine was replaced: ensure() clones the branch again next turn.
          if (this.place === place) this.place = null;
          return { ok: false, changed: false, text: "The project's code is no longer on the notebook's machine (it was restarted). It is cloned again on the next message; what was not pushed before is lost." };
        }
        return { ok: false, changed: false, text: `Could not push the code from the notebook's machine:\n${capText(out, 1200)}` };
      }
      let before = "";
      try {
        before = await git(place.worktree, ["rev-parse", "HEAD"]);
        await git(place.worktree, ["fetch", "-q", place.remote, `refs/heads/${place.branch}`], token);
        if (await git(place.worktree, ["branch", "--show-current"]) !== place.branch) throw new Error(`Check out ${place.branch} in the local worktree.`);
        await git(place.worktree, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
      } catch (e) {
        return { ok: false, changed: true, text: `The code was pushed to GitHub (branch ${place.branch}), but not brought into the worktree on this computer: ${(e as Error).message}` };
      }
      const after = await git(place.worktree, ["rev-parse", "HEAD"]).catch(() => before);
      const changed = after !== before;
      return { ok: true, changed, text: changed ? `Saved the code from the notebook's machine to branch ${place.branch}.${note}` : note.trim() };
    });
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }
}
