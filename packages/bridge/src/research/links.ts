// Which OpenResearch project each notebook belongs to (kept in the notebook's
// meta file), and what a chat is told about that project. Every notebook
// belongs to one project; a notebook never linked goes to Scratch.

import { createHash } from "node:crypto";
import type { ChatProject, NotebookChatSummary, Platform } from "@ainb/protocol";
import type { ChatStore, NotebookMeta, ProjectCache } from "../store.js";
import { describeFailure, OrxApiError, OrxUnavailable, SCRATCH_NAME, type OrxArtifact, type OrxExperiment, type OrxFile, type OrxProject, type OrxRun, type ResearchProjects } from "./projects.js";


/** What a chat knows of its project at one moment. */
export interface ProjectResolution {
  project: ChatProject;
  /** OpenResearch's record, when it answered. */
  orx?: OrxProject;
  /** Said once to the chat (the Scratch project was replaced). */
  notice?: string;
}

/** What the agent is told about the project, from OpenResearch's state. */
export interface ProjectBrief {
  id: string;
  name: string;
  paperId: string | null;
  githubUrl: string | null;
  docs: { name: string; head: string }[];
  experiments: BriefExperiment[];
  runs: BriefRun[];
  artifacts: { path: string; size: number }[];
  artifactsTotal: number;
  /** Changes when anything above changes. */
  digest: string;
}

export interface BriefExperiment {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  branch: string;
  parent: string | null;
  /** Its newest run's status, else "not run". */
  status: string;
}

export interface BriefRun {
  id: string;
  experiment: string;
  status: string;
  endedAt: number | null;
  result: string | null;
}

const BRIEF_EXPERIMENTS = 30;
const BRIEF_RUNS = 5;
const BRIEF_ARTIFACTS = 40;
const DOC_LINES = 40;
const DOCS = ["AGENTS.md", "CLAUDE.md", "README.md"];
/** A brief is fetched again after this long even without an event saying it changed. */
const BRIEF_TTL_MS = 60_000;

export class ProjectLinks {
  /** Briefs by project id; `dirty` once an event said the project changed. */
  private briefs = new Map<string, { brief: ProjectBrief; at: number; dirty: boolean }>();

  constructor(readonly store: ChatStore, readonly projects: ResearchProjects, private readonly log: (msg: string) => void = () => {}) {}

  /**
   * The notebook's project as known without asking OpenResearch, after
   * recording what the editor said about it. `projectId` links it there.
   */
  initial(key: string, info: { projectId?: string; title?: string; url?: string; platform?: Platform; agentId?: string }): ChatProject {
    const meta = this.store.saveMeta(key, info.projectId ? { ...info, projectName: undefined } : info);
    return pendingOf(meta, this.projects.scratchId());
  }

  /** Ask OpenResearch about the notebook's project; a notebook with none is linked to Scratch. */
  async resolve(key: string, wait: boolean): Promise<ProjectResolution> {
    const meta = this.store.loadMeta(key) ?? this.store.saveMeta(key, {});
    const scratchId = this.projects.scratchId();
    if (!meta.projectId) {
      try {
        const scratch = await this.scratchOrThrow(wait);
        this.store.saveMeta(key, { projectId: scratch.id, projectName: scratch.name, cache: cacheOf(scratch) });
        return { project: readyOf(scratch, true), orx: scratch };
      } catch (e) {
        return { project: { id: null, name: SCRATCH_NAME, state: "pending", scratch: true, error: describeFailure(e) } };
      }
    }
    try {
      const orx = await this.projects.getProject(meta.projectId, wait);
      const cache = cacheOf(orx);
      if (orx.name !== meta.projectName || JSON.stringify(cache) !== JSON.stringify(meta.cache)) this.store.saveMeta(key, { projectName: orx.name, cache });
      return { project: readyOf(orx, orx.id === scratchId), orx };
    } catch (e) {
      if (e instanceof OrxApiError && e.status === 404) {
        if (meta.projectId === scratchId) {
          // Scratch was deleted in OpenResearch: its notebooks move to a new one.
          try {
            const scratch = await this.projects.ensureScratch();
            this.store.saveMeta(key, { projectId: scratch.id, projectName: scratch.name, cache: cacheOf(scratch) });
            return { project: readyOf(scratch, true), orx: scratch, notice: "The Scratch project was deleted in OpenResearch, so this notebook moved to a new Scratch project." };
          } catch (again) {
            return { project: { id: null, name: SCRATCH_NAME, state: "pending", scratch: true, error: describeFailure(again) } };
          }
        }
        return {
          project: {
            id: meta.projectId,
            name: meta.projectName ?? meta.projectId,
            state: "missing",
            error: `OpenResearch has no project "${meta.projectName ?? meta.projectId}" any more. Move this notebook to another project.`,
          },
        };
      }
      return { project: { id: meta.projectId, name: meta.projectName ?? "Project", state: "unavailable", scratch: meta.projectId === scratchId, error: describeFailure(e) } };
    }
  }

  private async scratchOrThrow(wait: boolean): Promise<OrxProject> {
    // Without waiting, a Scratch already made is enough to link to (checked on the next turn).
    if (!wait && !this.projects.ready) {
      void this.projects.ensureScratch().catch(() => {});
      throw new OrxUnavailable("OpenResearch is starting.");
    }
    return this.projects.ensureScratch();
  }

  /** Move a notebook to another project, once OpenResearch confirms the project exists. */
  async link(key: string, projectId: string, info: { title?: string; url?: string; platform?: Platform } = {}): Promise<ProjectResolution> {
    const orx = await this.projects.getProject(projectId, true);
    this.store.saveMeta(key, { ...info, projectId: orx.id, projectName: orx.name, cache: cacheOf(orx) });
    return { project: readyOf(orx, orx.id === this.projects.scratchId()), orx };
  }

  /** The notebook's project as last seen (what its code and artifacts need), while OpenResearch does not answer. */
  cached(key: string): ProjectCache | null {
    const meta = this.store.loadMeta(key);
    return meta?.cache && meta.cache.id === meta.projectId ? meta.cache : null;
  }

  /** The notebook chats of a project, newest first. */
  list(projectId: string): NotebookChatSummary[] {
    const scratchId = this.projects.scratchId();
    return this.store
      .listMeta()
      .filter((m) => m.projectId === projectId || (!m.projectId && projectId === scratchId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({
        notebookKey: m.key,
        title: m.title,
        url: m.url,
        platform: m.platform,
        agentId: m.agentId,
        updatedAt: m.updatedAt,
        messages: this.store.hasTranscript(m.key),
      }));
  }

  // ------------------------------------------------------------ briefs

  /** An event said these projects changed (none named: any may have). */
  markDirty(projectId?: string): void {
    if (projectId === undefined) for (const entry of this.briefs.values()) entry.dirty = true;
    else {
      const entry = this.briefs.get(projectId);
      if (entry) entry.dirty = true;
    }
  }

  /** The brief of a project: cached until an event or its age says it changed. */
  async brief(project: OrxProject): Promise<ProjectBrief> {
    const cached = this.briefs.get(project.id);
    if (cached && !cached.dirty && Date.now() - cached.at < BRIEF_TTL_MS && cached.brief.name === project.name) return cached.brief;
    const brief = await this.fetchBrief(project);
    this.briefs.set(project.id, { brief, at: Date.now(), dirty: false });
    return brief;
  }

  private async fetchBrief(project: OrxProject): Promise<ProjectBrief> {
    const id = encodeURIComponent(project.id);
    const [experiments, runs, artifacts, ...docs] = await Promise.all([
      this.projects.api<{ experiments?: OrxExperiment[] }>("GET", `/api/projects/${id}/experiments`).then((r) => r.experiments ?? []),
      this.projects.api<{ runs?: OrxRun[] }>("GET", `/api/projects/${id}/runs`).then((r) => r.runs ?? []),
      this.projects.api<{ entries?: OrxArtifact[] }>("GET", `/api/projects/${id}/files`).then((r) => flatten(r.entries ?? []), (e) => {
        this.log(`Could not list the artifacts of ${project.name}: ${describeFailure(e)}`);
        return [] as OrxArtifact[];
      }),
      ...DOCS.map((name) =>
        this.projects.api<OrxFile>("GET", `/api/projects/${id}/file?path=${encodeURIComponent(name)}`).then(
          (f) => (f.notFound || f.binary || !f.content ? null : { name, head: f.content.split("\n").slice(0, DOC_LINES).join("\n").trimEnd() }),
          () => null,
        ),
      ),
    ]);
    const latest = new Map<string, OrxRun>();
    const time = (r: OrxRun) => r.endedAt ?? r.startedAt ?? r.createdAt ?? 0;
    for (const run of runs) {
      const old = latest.get(run.experimentId);
      if (!old || time(run) > time(old)) latest.set(run.experimentId, run);
    }
    const slugs = new Map(experiments.map((e) => [e.id, e.slug]));
    const live = experiments.filter((e) => !e.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    const files = artifacts.filter((a) => !a.isDir).sort((a, b) => b.modifiedAt - a.modifiedAt);
    const brief: Omit<ProjectBrief, "digest"> = {
      id: project.id,
      name: project.name,
      paperId: project.paperId ?? null,
      githubUrl: project.githubUrl ?? null,
      docs: docs.filter((d): d is { name: string; head: string } => !!d),
      experiments: live.slice(0, BRIEF_EXPERIMENTS).map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title ?? null,
        description: e.description ?? null,
        branch: e.branchName,
        parent: e.parentExperimentId ? slugs.get(e.parentExperimentId) ?? e.parentExperimentId : null,
        status: latest.get(e.id)?.status ?? "not run",
      })),
      runs: [...runs].sort((a, b) => time(b) - time(a)).slice(0, BRIEF_RUNS).map((r) => ({
        id: r.id,
        experiment: slugs.get(r.experimentId) ?? r.experimentId,
        status: r.status,
        endedAt: r.endedAt ?? null,
        result: r.resultMarkdown?.trim() || null,
      })),
      artifacts: files.slice(0, BRIEF_ARTIFACTS).map((a) => ({ path: a.path, size: a.size })),
      artifactsTotal: files.length,
    };
    return { ...brief, digest: createHash("sha256").update(JSON.stringify(brief)).digest("hex").slice(0, 16) };
  }
}

function flatten(entries: OrxArtifact[]): OrxArtifact[] {
  return entries.flatMap((e) => [e, ...flatten(e.children ?? [])]);
}

function readyOf(orx: OrxProject, scratch: boolean): ChatProject {
  return { id: orx.id, name: orx.name, state: "ready", ...(scratch ? { scratch: true } : {}) };
}

/** What a notebook keeps of its project, to work on while OpenResearch is not running. */
function cacheOf(orx: OrxProject): ProjectCache {
  return { id: orx.id, name: orx.name, repoPath: orx.repoPath, githubUrl: orx.githubUrl ?? null, artifactsDir: orx.artifactsDir };
}

function pendingOf(meta: NotebookMeta, scratchId: string | undefined): ChatProject {
  if (!meta.projectId) return { id: null, name: SCRATCH_NAME, state: "pending", scratch: true };
  const scratch = meta.projectId === scratchId;
  return { id: meta.projectId, name: meta.projectName ?? (scratch ? SCRATCH_NAME : "Project"), state: "pending", ...(scratch ? { scratch: true } : {}) };
}
