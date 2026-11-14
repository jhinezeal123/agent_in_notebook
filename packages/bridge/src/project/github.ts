// The project's GitHub repository, as the notebook chat uses it: the remote
// the notebook's machine clones from and pushes to, with OpenResearch's own
// GitHub sign-in (the GitHub CLI, `gh`), and git on the user's computer for the
// chat's worktree.

import { execFile } from "node:child_process";
import { firstLine } from "@ainb/protocol";
import type { OrxProject } from "../research/projects.js";

/** A token is asked of `gh` again after this long. */
const TOKEN_TTL_MS = 5 * 60_000;
const GIT_MS = 120_000;

let cached: { token: string; at: number } | undefined;
/** Tokens handed out, so what the agent reads never shows them. */
const known = new Set<string>();

export class GitFailed extends Error {}

/**
 * The GitHub token OpenResearch uses: the GitHub CLI's (`gh auth token`).
 * `AINB_GITHUB_TOKEN` stands in for it (tests, or a machine without gh).
 */
export async function githubToken(): Promise<string> {
  const env = process.env.AINB_GITHUB_TOKEN?.trim();
  if (env) {
    known.add(env);
    return env;
  }
  if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  const token = await new Promise<string>((resolve, reject) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 15_000, windowsHide: true, env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } },
      (err, stdout, stderr) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
          reject(new GitFailed(missing
            ? "The GitHub CLI (gh), which OpenResearch signs in to GitHub with, is not installed."
            : `OpenResearch is not signed in to GitHub (gh auth token: ${firstLine(String(stderr || err.message), 200)}). Run "gh auth login" once.`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
  if (!token) throw new GitFailed("The GitHub CLI gave no token. Run \"gh auth login\" once.");
  cached = { token, at: Date.now() };
  known.add(token);
  return token;
}

/**
 * The URL the notebook's machine clones: the project's GitHub repository
 * (https, so a token signs in), or null when the project has none. A local
 * path or file:// URL is taken as it is (a stand-in for GitHub in tests).
 */
export function remoteOf(project: Pick<OrxProject, "githubUrl">): string | null {
  const url = project.githubUrl?.trim();
  if (!url) return null;
  const gh = /^(?:https?:\/\/|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}.git`;
  if (/^file:\/\//i.test(url) || /^(?:[A-Za-z]:)?[\\/]/.test(url)) return url;
  return null;
}

/** Whether the token goes with requests to this remote (only GitHub's). */
export const signsIn = (remote: string) => /^https:\/\/github\.com\//i.test(remote);

/** git on this computer; with `token`, signed in to GitHub for this call only (not stored). */
export function git(cwd: string, args: string[], token?: string): Promise<string> {
  const auth = token ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...auth, ...args],
      { timeout: GIT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) {
          const text = redact(String(stderr || err.message).trim(), token);
          reject(new GitFailed(`git ${args[0]} failed: ${firstLine(text, 400)}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** The name and email commits are made with: the user's own git identity, else the app's. */
export async function identity(cwd: string): Promise<{ name: string; email: string }> {
  const get = (key: string) => git(cwd, ["config", "--get", key]).catch(() => "");
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { name: name || "Agent in Notebook", email: email || "agent-in-notebook@users.noreply.github.com" };
}

/** Text with every token handed out replaced by asterisks. */
export function redactTokens(text: string): string {
  let out = text;
  for (const t of known) out = redact(out, t);
  return out;
}

/** Text with a token replaced by asterisks. */
export function redact(text: string, token: string | undefined): string {
  return token && token.length >= 8 ? text.split(token).join("***") : text;
}
