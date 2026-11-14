// The OpenResearch projects notebook chats belong to, read through the HTTP
// API of the OpenResearch the bridge runs (see orx.ts). Nothing here waits on
// OpenResearch for a chat to go on: a call either answers within a few
// seconds or fails with OrxUnavailable, which says "not known", never "gone".

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadResearchConfig, saveResearchConfig } from "../config.js";
import type { Orx } from "./orx.js";

/** OpenResearch is not running or did not answer: whatever was asked is not known. */
export class OrxUnavailable extends Error {}

/** OpenResearch answered with an error (its message is written for the user). */
export class OrxApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The fields of an OpenResearch project the bridge uses (its API sends more). */
export interface OrxProject {
  id: string;
  name: string;
  slug?: string;
  /** The project's repository (its hub clone). */
  repoPath: string;
  path?: string;
  /** Where its artifacts are kept on this computer. */
  artifactsDir: string;
  baselineBranch?: string;
  paperId?: string | null;
  githubUrl?: string | null;
  updatedAt: number;
}

export interface OrxExperiment {
  id: string;
  projectId: string;
  parentExperimentId?: string | null;
  slug: string;
  branchName: string;
  title?: string | null;
  description?: string | null;
  agentStatus?: string;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OrxRun {
  id: string;
  experimentId: string;
  projectId: string;
  status: string;
  command?: string | null;
  commitSha?: string | null;
  resultMarkdown?: string | null;
  createdAt: number;
  updatedAt?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  exitCode?: number | null;
}

export interface OrxArtifact {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
  children?: OrxArtifact[];
}

/** One file of a project's code, as OpenResearch serves it (capped near 512 KB). */
export interface OrxFile {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  notFound: boolean;
  root?: string;
}

const CALL_MS = 3_000;
/** A tool may wait this long for OpenResearch to come up. */
const START_WAIT_MS = 20_000;

export const SCRATCH_NAME = "Scratch";

export function scratchPath(): string {
  return process.env.AINB_SCRATCH_DIR || join(homedir(), "OpenResearch", "scratch");
}

export class ResearchProjects {
  private scratch?: Promise<OrxProject>;

  constructor(private readonly orx: Orx, private readonly log: (msg: string) => void = () => {}) {}

  /** OpenResearch is up now (nothing is asked of it). */
  get ready(): boolean {
    return this.orx.status.state === "ready";
  }

  /** An `orx` command's output (literature search and reading); OpenResearch need not be running. */
  cli(args: string[], opts?: { timeoutMs?: number; maxBytes?: number }): Promise<string> {
    return this.orx.cli(args, opts);
  }

  /**
   * OpenResearch's address. Not running: start it in the background and fail
   * at once, unless `wait` (then wait a while for it).
   */
  private async base(wait: boolean): Promise<string> {
    const status = this.orx.status;
    if (status.state === "ready" && status.url) return status.url;
    const starting = this.orx.start();
    if (wait) {
      const s = await Promise.race([starting, new Promise<null>((r) => setTimeout(() => r(null), START_WAIT_MS).unref())]);
      if (s?.state === "ready" && s.url) return s.url;
      throw new OrxUnavailable(s?.error ? `OpenResearch is not running: ${s.error}` : "OpenResearch is still starting. Try again in a moment.");
    }
    starting.catch(() => {});
    throw new OrxUnavailable(status.state === "starting" || status.state === "off" ? "OpenResearch is starting." : `OpenResearch is not running${status.error ? `: ${status.error}` : "."}`);
  }

  /** A JSON request to OpenResearch's API. */
  async api<T>(method: string, path: string, opts: { body?: unknown; wait?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      if (!res.ok) throw new OrxApiError(res.status, `OpenResearch answered HTTP ${res.status}.`);
      throw new OrxApiError(res.status, `OpenResearch sent something that is not JSON (${path}).`);
    }
    if (!res.ok) {
      const message = (data as { error?: unknown } | null)?.error;
      throw new OrxApiError(res.status, typeof message === "string" && message ? message : `OpenResearch answered HTTP ${res.status}.`);
    }
    return data as T;
  }

  /** The bytes of a response (raw files). */
  async bytes(path: string, opts: { wait?: boolean; timeoutMs?: number; max?: number } = {}): Promise<Buffer> {
    const res = await this.raw("GET", path, opts);
    if (!res.ok) {
      let message = `OpenResearch answered HTTP ${res.status}.`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body?.error === "string") message = body.error;
      } catch {
        // keep the status
      }
      throw new OrxApiError(res.status, message);
    }
    const length = Number(res.headers.get("content-length"));
    if (opts.max !== undefined && length > opts.max) throw new OrxApiError(413, `The file is ${length} bytes, more than ${opts.max}.`);
    const data = Buffer.from(await res.arrayBuffer());
    if (opts.max !== undefined && data.length > opts.max) throw new OrxApiError(413, `The file is ${data.length} bytes, more than ${opts.max}.`);
    return data;
  }

  private async raw(method: string, path: string, opts: { body?: unknown; wait?: boolean; timeoutMs?: number }): Promise<Response> {
    const base = await this.base(!!opts.wait);
    try {
      return await fetch(`${base}${path}`, {
        method,
        headers: opts.body === undefined ? {} : { "content-type": "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_MS),
      });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? "did not answer in time" : `could not be reached (${(e as Error).message})`;
      throw new OrxUnavailable(`OpenResearch ${why}.`);
    }
  }

  async getProject(id: string, wait = false): Promise<OrxProject> {
    const r = await this.api<{ project?: OrxProject } & Partial<OrxProject>>("GET", `/api/projects/${encodeURIComponent(id)}`, { wait });
    const project = r.project ?? (r as OrxProject);
    if (!project?.id) throw new OrxApiError(500, "OpenResearch sent a project without an id.");
    return project;
  }

  async listProjects(wait = false): Promise<OrxProject[]> {
    const r = await this.api<{ projects?: OrxProject[] }>("GET", "/api/projects", { wait });
    return Array.isArray(r.projects) ? r.projects : [];
  }

  /**
   * The Scratch project, where notebooks go when no project was chosen: made
   * the first time it is needed (not published to GitHub), found again by its
   * folder if research.json lost it. Concurrent callers share one attempt.
   */
  ensureScratch(): Promise<OrxProject> {
    this.scratch ??= this.findOrMakeScratch().finally(() => {
      this.scratch = undefined;
    });
    return this.scratch;
  }

  private async findOrMakeScratch(): Promise<OrxProject> {
    const saved = loadResearchConfig().scratchProjectId;
    if (saved) {
      try {
        return await this.getProject(saved, true);
      } catch (e) {
        if (!(e instanceof OrxApiError && e.status === 404)) throw e;
        this.log("The Scratch project was deleted in OpenResearch; making a new one.");
      }
    }
    const folder = scratchPath();
    const same = (p: string | undefined) => !!p && samePath(p, folder);
    const known = (await this.listProjects(true)).find((p) => same(p.path) || same(p.repoPath));
    let project = known;
    if (!project) {
      const exists = existsSync(folder);
      const created = await this.api<{ project: OrxProject }>("POST", "/api/projects", {
        wait: true,
        timeoutMs: 60_000,
        body: {
          name: SCRATCH_NAME,
          path: folder,
          creationMode: exists ? "folder" : "blank",
          createFolder: !exists,
          requireNewFolder: false,
          initializeGit: true,
          githubSyncEnabled: false,
        },
      });
      project = created.project;
      this.log(`Made the Scratch project at ${folder}.`);
    }
    const { scratchProjectId: _old, ...rest } = loadResearchConfig();
    saveResearchConfig({ ...rest, scratchProjectId: project.id });
    return project;
  }

  /** The Scratch project's id as last saved (it may have been deleted since). */
  scratchId(): string | undefined {
    return loadResearchConfig().scratchProjectId;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p.replace(/^~(?=$|[\\/])/, homedir())).replace(/[\\/]+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** A short, user-facing description of why a project call failed. */
export function describeFailure(e: unknown): string {
  if (e instanceof OrxUnavailable || e instanceof OrxApiError) return e.message;
  return (e as Error)?.message ?? String(e);
}
