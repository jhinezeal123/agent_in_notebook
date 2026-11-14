// The tools of the MCP server "project": what a notebook chat's agent, which
// works on the notebook's machine, reaches of its OpenResearch project on the
// user's computer. The project's code is not here: it is cloned on the
// machine (vmrepo.ts). Here are the project's shared artifacts (results and
// outputs every chat of the project sees), read and written through the
// bridge, and the research literature
// (searched and read with OpenResearch's `orx discover` and `orx paper`).

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";
import { capLines, capText } from "@ainb/protocol";
import { toIpynb } from "../notebook/ipynb.js";
import { check, Denied, machine, resolve, tool, type ToolContext, type ToolDef, type ToolResult } from "../notebook/tools.js";
import { FileTooBig, readFile as vmReadFile, writeFile as vmWriteFile } from "../notebook/vmfs.js";
import type { ProjectLinks } from "../research/links.js";
import type { ResearchProjects } from "../research/projects.js";

/** What the artifact tools need of the project. */
export interface ArtifactsProject {
  id: string;
  name: string;
  artifactsDir: string;
}

export interface ProjectToolContext extends ToolContext {
  research: ResearchProjects;
  links: ProjectLinks;
  /** The chat's project: OpenResearch's record, or what the notebook kept of it while OpenResearch is not running; else throws Denied saying why. */
  project(): Promise<ArtifactsProject>;
  /** Artifact paths (relative to the artifacts folder) this chat wrote: replacing any other asks first. */
  created: Set<string>;
  /** Ask the user a yes/no question in the chat; true for yes. */
  confirm(summary: string, detail: string, yes: string, no: string): Promise<boolean>;
}

const READ_LINES = 2000;
const READ_BUDGET = 60_000;
const LIST_MAX = 400;
/** save_notebook refuses a notebook bigger than this. */
export const NOTEBOOK_MAX = 20 * 1024 * 1024;
/** Files copied between the notebook's machine and the shared artifacts, at most. */
const COPY_MAX = 50 * 1024 * 1024;
const TEXT_MAX = 5 * 1024 * 1024;

const IMAGE_MIME: Record<string, "image/png" | "image/jpeg"> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

/**
 * Files whose content must not go to the agent's model provider: environment
 * files, private keys, credentials.
 */
export function isSecretPath(path: string): boolean {
  const name = basename(path.replace(/\\/g, "/")).toLowerCase();
  if (/^\.env(\..*)?$/.test(name) && name !== ".env.example" && name !== ".env.sample" && name !== ".env.template") return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name)) return true;
  if (/^id_[a-z0-9_]+$/.test(name)) return true;
  return [".netrc", ".pgpass", "kaggle.json", "credentials", "credentials.json", ".npmrc", ".pypirc"].includes(name);
}

/** A path in the shared artifacts, as the agent may write it ("artifacts/x" or "x"), relative to the folder. */
function artifactRel(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const rel = p === "artifacts" ? "" : p.startsWith("artifacts/") ? p.slice("artifacts/".length) : p;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || (rel !== "" && rel.split("/").some((s) => s === ".." || s === ""))) {
    throw new Denied(`"${path}" is not a path inside the shared artifacts. Use a path like figures/loss.png or results/metrics.csv.`);
  }
  return rel;
}

/**
 * Where an artifact is on disk: inside the artifacts folder, whatever links
 * the path takes on the way (a symlink out of it is refused).
 */
async function artifactTarget(project: ArtifactsProject, rel: string, make: boolean): Promise<{ file: string; exists: boolean; dir: boolean }> {
  if (!project.artifactsDir) throw new Denied("OpenResearch did not say where this project keeps its artifacts.");
  await mkdir(project.artifactsDir, { recursive: true });
  const base = await realpath(project.artifactsDir);
  const file = resolvePath(base, rel || ".");
  if (!inside(base, file)) throw new Denied(`${rel} is outside the shared artifacts.`);
  if (make) await mkdir(dirname(file), { recursive: true });
  const parent = await realpath(dirname(file)).catch(() => null);
  if (parent && !inside(base, parent) && file !== base) throw new Denied(`${rel} leads outside the shared artifacts.`);
  const info = await lstat(file).catch(() => null);
  if (info?.isSymbolicLink()) throw new Denied(`artifacts/${rel} is a link; it is not used.`);
  return { file, exists: !!info, dir: !!info?.isDirectory() };
}

function inside(base: string, path: string): boolean {
  const r = relative(base, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes(".."));
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Write an artifact. In review mode it waits for the user; replacing a file
 * this chat did not write always does. `user`: the user asked (a button), so
 * nothing is asked.
 */
async function saveArtifact(ctx: ProjectToolContext, project: ArtifactsProject, rel: string, data: Buffer | string, what: string, opts: { user?: boolean; preview?: string } = {}): Promise<string> {
  const clean = artifactRel(rel);
  if (!clean) throw new Denied("Name the file to write in the shared artifacts.");
  const d = opts.user ? null : check(ctx, "save", null);
  const { file, exists, dir } = await artifactTarget(project, clean, true);
  if (dir) throw new Denied(`artifacts/${clean} is a folder.`);
  if (d) {
    const foreign = exists && !ctx.created.has(clean);
    if (foreign || (d.allow && d.askBeforeRun)) {
      const summary = foreign ? `Replace artifacts/${clean} in ${project.name}? This chat did not write it.` : `Save ${what} to artifacts/${clean} in ${project.name}`;
      const ok = await ctx.confirm(summary, opts.preview ?? sizeText(Buffer.byteLength(data)), foreign ? "Replace" : "Save", "Don't save");
      if (!ok) throw new Denied("The user declined. Nothing was saved.");
    }
  }
  await writeAtomic(file, data);
  ctx.created.add(clean);
  ctx.links.markDirty(project.id);
  return `artifacts/${clean}`;
}

function slug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\.ipynb$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "notebook";
}

function sizeText(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

function numbered(text: string, offset?: number, limit?: number): string {
  const lines = text.split("\n");
  const start = Math.max(1, offset ?? 1);
  if (start > lines.length) return `The file has only ${lines.length} lines.`;
  const shown: string[] = [];
  let used = 0;
  let end = start - 1;
  for (let n = start; n <= lines.length && n < start + (limit ?? READ_LINES); n++) {
    const line = `${String(n).padStart(6)}\t${lines[n - 1]!.length > 2000 ? `${lines[n - 1]!.slice(0, 1999)}…` : lines[n - 1]}`;
    if (used + line.length > READ_BUDGET && shown.length) break;
    shown.push(line);
    used += line.length + 1;
    end = n;
  }
  const more = end < lines.length ? `\n(lines ${start}-${end} of ${lines.length}; continue with offset=${end + 1})` : "";
  return shown.join("\n") + more;
}

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-";
}

interface Listed {
  path: string;
  size: number;
  modifiedAt: number;
}

/** The files under a folder, newest first, at most `max` (and whether there were more). */
async function listFiles(dir: string, max: number): Promise<{ files: Listed[]; more: boolean }> {
  const files: Listed[] = [];
  let more = false;
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.length >= max * 4) {
        more = true;
        return;
      }
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), path);
      else if (e.isFile()) {
        const st = await stat(join(abs, e.name)).catch(() => null);
        if (st) files.push({ path, size: st.size, modifiedAt: st.mtimeMs });
      }
    }
  };
  await walk(dir, "");
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  if (files.length > max) more = true;
  return { files: files.slice(0, max), more };
}

// ------------------------------------------------------------ shared with the chat's button

/** Save the notebook (with outputs unless `outputs` is false) to artifacts/notebooks/. */
export async function saveNotebook(ctx: ProjectToolContext, opts: { name?: string; outputs?: boolean; user?: boolean } = {}): Promise<{ path: string; cells: number; bytes: number; project: ArtifactsProject }> {
  const project = await ctx.project();
  const info = await ctx.call({ op: "info" });
  const outputs = opts.outputs !== false;
  const { cells } = await ctx.call({ op: "get_cells", includeOutputs: outputs });
  const text = toIpynb(outputs ? cells : cells.map((c) => ({ ...c, outputs: [], executionCount: null })), info.language);
  const bytes = Buffer.byteLength(text);
  if (bytes > NOTEBOOK_MAX) throw new Denied(`The notebook is ${sizeText(bytes)} with its outputs, more than ${sizeText(NOTEBOOK_MAX)}. Save it without outputs (outputs: false).`);
  const name = `${slug(opts.name ?? info.title)}.ipynb`;
  const path = await saveArtifact(ctx, project, `notebooks/${name}`, text, `the notebook (${cells.length} cells${outputs ? "" : ", no outputs"})`, { user: opts.user });
  return { path, cells: cells.length, bytes, project };
}

// ------------------------------------------------------------ the tools

export const PROJECT_TOOLS: ToolDef<z.ZodType, ProjectToolContext>[] = [
  tool({
    name: "artifact_list",
    description:
      "List the project's shared artifacts (on the user's computer, seen by every chat of the project: reports, figures, results, saved notebooks), newest first. prefix narrows to a folder.",
    schema: z.object({ prefix: z.string().optional().describe("Only paths under this folder, e.g. figures/.") }),
    async run(ctx: ProjectToolContext, a) {
      const project = await ctx.project();
      const prefix = a.prefix ? artifactRel(a.prefix) : "";
      const { file, exists, dir } = await artifactTarget(project, prefix, false);
      if (!exists) return { text: prefix ? `Nothing under artifacts/${prefix}.` : "The project has no shared artifacts yet." };
      if (!dir) return { text: `artifacts/${prefix} is a file.` };
      const { files, more } = await listFiles(file, LIST_MAX);
      if (!files.length) return { text: prefix ? `Nothing under artifacts/${prefix}.` : "The project has no shared artifacts yet." };
      const lines = files.map((f) => `artifacts/${prefix ? `${prefix}/` : ""}${f.path} (${sizeText(f.size)}, ${when(f.modifiedAt)})`);
      return { text: lines.join("\n") + (more ? "\n(more not shown; narrow with prefix)" : "") };
    },
  }),
  tool({
    name: "artifact_read",
    description:
      "Read a file of the shared artifacts: text with line numbers (offset and limit are lines, 1-based), an image attached. " +
      "to_vm copies it to that path on the notebook's machine instead (any file, up to 50 MB), to use it there. Secrets (.env, keys) are not read.",
    schema: z.object({
      path: z.string().min(1).describe("Like figures/loss.png (artifacts/ in front is fine)."),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).optional(),
      to_vm: z.string().optional().describe("A path on the notebook's machine to copy the file to."),
    }),
    async run(ctx: ProjectToolContext, a) {
      if (isSecretPath(a.path)) throw new Denied(`${a.path} looks like a secret (environment file, key or credentials), so it is not read. Ask the user for what you need from it.`);
      const project = await ctx.project();
      const rel = artifactRel(a.path);
      const { file, exists, dir } = await artifactTarget(project, rel, false);
      if (!exists) return { text: `No artifacts/${rel}. artifact_list shows what there is.`, isError: true };
      if (dir) return { text: `artifacts/${rel} is a folder; artifact_list prefix=${rel} lists it.`, isError: true };
      const size = (await stat(file)).size;
      if (a.to_vm) {
        const d = check(ctx, "execute", null);
        if (size > COPY_MAX) throw new Denied(`artifacts/${rel} is ${sizeText(size)}, more than ${sizeText(COPY_MAX)}.`);
        const info = await ctx.call({ op: "info" });
        const exec = machine(ctx, info);
        const dest = await resolve(ctx, info, a.to_vm);
        if (d.allow && d.askBeforeRun) {
          const ok = await ctx.confirm(`Copy artifacts/${rel} to ${dest} on the notebook's machine`, sizeText(size), "Copy", "Don't copy");
          if (!ok) return { text: "The user declined. Nothing was copied." };
        }
        const r = await vmWriteFile(exec, dest, await readFile(file));
        if ("conflict" in r) return { text: `${dest} could not be written on the notebook's machine.`, isError: true };
        return { text: `Copied artifacts/${rel} (${sizeText(size)}) to ${dest} on the notebook's machine.` };
      }
      const ext = file.split(".").pop()!.toLowerCase();
      if (IMAGE_MIME[ext] && ctx.images && size <= 3_000_000) {
        return { text: `artifacts/${rel}: image, ${sizeText(size)}, attached.`, images: [{ mime: IMAGE_MIME[ext]!, data: (await readFile(file)).toString("base64") }] };
      }
      if (size > 512_000) {
        const head = (await readFile(file)).subarray(0, 512_000);
        if (head.includes(0)) return { text: `artifacts/${rel} is a binary file (${sizeText(size)}). to_vm copies it to the notebook's machine.` };
        return { text: `artifacts/${rel} is ${sizeText(size)}; the first 500 KB:\n${numbered(head.toString("utf8"), a.offset, a.limit)}` };
      }
      const data = await readFile(file);
      if (data.includes(0)) return { text: `artifacts/${rel} is a binary file (${sizeText(size)}). to_vm copies it to the notebook's machine.` };
      return { text: numbered(data.toString("utf8"), a.offset, a.limit) || `artifacts/${rel} is empty.` };
    },
  }),
  tool({
    name: "artifact_write",
    description:
      "Write a result to the project's shared artifacts, where the user and every other chat of the project see it. " +
      "Only results and outputs the user asked for (a report, a figure, a table of metrics): code, working notes and scratch files stay in the repository on the notebook's machine. " +
      "Give content (text), or from_vm: a file on the notebook's machine to copy (a figure, a CSV; up to 50 MB). Replacing a file another chat or the user wrote asks the user.",
    schema: z.object({
      path: z.string().min(1).describe("Where in the shared artifacts, e.g. reports/ablation.md or figures/loss.png."),
      content: z.string().optional(),
      from_vm: z.string().optional().describe("A file on the notebook's machine to copy."),
    }),
    async run(ctx: ProjectToolContext, a) {
      if ((a.content === undefined) === (a.from_vm === undefined)) throw new Denied("Give either content or from_vm.");
      const project = await ctx.project();
      let data: Buffer | string;
      let preview: string;
      if (a.content !== undefined) {
        if (Buffer.byteLength(a.content) > TEXT_MAX) throw new Denied(`That is more than ${sizeText(TEXT_MAX)}. Write it to a file on the notebook's machine and use from_vm.`);
        data = a.content;
        preview = capLines(a.content, 3000, 0.7);
      } else {
        const info = await ctx.call({ op: "info" });
        const exec = machine(ctx, info);
        const from = await resolve(ctx, info, a.from_vm!);
        try {
          data = (await vmReadFile(exec, from, COPY_MAX)).data;
        } catch (e) {
          if (e instanceof FileTooBig) throw new Denied(`${from} is ${sizeText(e.size)}, more than ${sizeText(COPY_MAX)}. Keep it on the notebook's machine; write a summary instead.`);
          throw new Denied(`Could not read ${from} on the notebook's machine: ${(e as Error).message}`);
        }
        preview = `${from} on the notebook's machine, ${sizeText(data.length)}`;
      }
      const path = await saveArtifact(ctx, project, a.path, data, a.from_vm ? basename(a.from_vm) : "a file", { preview });
      return { text: `Wrote ${path} (${sizeText(Buffer.byteLength(data))}) in ${project.name}'s shared artifacts.` };
    },
  }),
  tool({
    name: "save_notebook",
    description:
      "Save this notebook, with its outputs, to the shared artifacts (artifacts/notebooks/<name>.ipynb), where the user and research chats find it. " +
      "Saving again replaces the copy this chat saved. outputs: false leaves outputs out (for big notebooks).",
    schema: z.object({
      name: z.string().max(80).optional().describe("File name, default from the notebook's title."),
      outputs: z.boolean().optional(),
    }),
    async run(ctx: ProjectToolContext, a) {
      const r = await saveNotebook(ctx, { name: a.name, outputs: a.outputs });
      return { text: `Saved ${r.path} in ${r.project.name} (${r.cells} cells, ${sizeText(r.bytes)}).` };
    },
  }),
  tool({
    name: "paper_search",
    description:
      "Search the research literature, the way OpenResearch's lit-review does (`orx discover`, run on the user's computer; public sources, no sign-in). One search per call. " +
      "source: keyword (alphaXiv/arXiv: exact terms in title, abstract and full text, with matching snippets: method names, acronyms, benchmarks, authors), " +
      "embedding (alphaXiv/arXiv: semantic, from a short question in the user's terms), openalex (journals, conferences, citations, beyond arXiv), " +
      "biorxiv (biology preprints), pubmed (biomedical and clinical journals; PubMed syntax such as [ti], [au]). " +
      "Results: id (for paper_read), title, date, abstract, votes or citations. Dates are inclusive YYYY-MM-DD; prioritize: recency only for new work, historical for foundational work, popular only when asked about standing.",
    schema: z.object({
      source: z.enum(["keyword", "embedding", "openalex", "biorxiv", "pubmed"]),
      query: z.string().min(1).max(500),
      published_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      published_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      prioritize: z.enum(["default", "recency", "historical", "popular"]).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Most results (default 15)."),
    }),
    async run(ctx: ProjectToolContext, a) {
      const args = ["discover", a.source];
      if (a.published_after) args.push("--published-after", a.published_after);
      if (a.published_before) args.push("--published-before", a.published_before);
      if (a.prioritize) args.push("--prioritize", a.prioritize);
      if (a.limit) args.push("--limit", String(a.limit));
      const out = await orxCli(ctx, [...args, "--", a.query], 90_000);
      let hits: LitHit[];
      try {
        hits = JSON.parse(out) as LitHit[];
        if (!Array.isArray(hits)) throw new Error("not a list");
      } catch {
        return { text: `orx discover gave an answer that is not a list of papers:\n${capText(out, 2000)}`, isError: true };
      }
      if (!hits.length) {
        return { text: `No ${a.source} results for "${a.query}". That does not show there is no such literature: try another source, or a more focused query.` };
      }
      return { text: capText(`${hits.length} ${a.source} results for "${a.query}":\n\n${hits.map(hitText).join("\n\n")}`, SEARCH_MAX) };
    },
  }),
  tool({
    name: "paper_read",
    description:
      "Read a paper found with paper_search (`orx paper`): its id is an arXiv id or URL, a DOI, an OpenAlex W… id or a PubMed id. " +
      "For alphaXiv papers: a structured report, or full: true for the extracted full text (exact wording, for quotes); then a GitHub line when alphaXiv links code. " +
      "Other sources: abstract and links to the full text. Long text comes in pages: offset (in characters) continues.",
    schema: z.object({
      id: z.string().min(1).max(300),
      full: z.boolean().optional(),
      offset: z.number().int().min(0).optional(),
    }),
    async run(ctx: ProjectToolContext, a) {
      const out = await orxCli(ctx, ["paper", ...(a.full ? ["--full"] : []), "--", a.id], 120_000);
      const start = Math.min(a.offset ?? 0, out.length);
      if (start >= out.length && out.length) return { text: `The paper's text has ${out.length} characters; offset ${a.offset} is past the end.` };
      const end = Math.min(out.length, start + PAPER_PAGE);
      const page = out.slice(start, end);
      const more = end < out.length ? `\n\n(characters ${start}-${end} of ${out.length}; continue with offset=${end})` : "";
      return { text: (page.trim() ? page : "orx paper printed nothing for this id.") + more };
    },
  }),
];

const SEARCH_MAX = 40_000;
const PAPER_PAGE = 40_000;

/** A search result as `orx discover` prints it. */
interface LitHit {
  source: string;
  id: string;
  title: string;
  abstract?: string;
  publicationDate?: string | null;
  votes?: number;
  citations?: number;
  snippets?: { pageNumber?: number; snippet: string }[];
}

function hitText(h: LitHit, i: number): string {
  const facts = [h.publicationDate?.slice(0, 10), h.votes != null ? `${h.votes} votes` : "", h.citations != null ? `${h.citations} citations` : ""].filter(Boolean).join("; ");
  const lines = [`${i + 1}. [${h.source} ${h.id}] ${h.title}${facts ? ` (${facts})` : ""}`];
  const abstract = (h.abstract ?? "").replace(/\s+/g, " ").trim();
  if (abstract) lines.push(`   ${abstract.length > 600 ? `${abstract.slice(0, 599)}…` : abstract}`);
  for (const s of (h.snippets ?? []).slice(0, 2)) {
    const text = s.snippet.replace(/\s+/g, " ").trim();
    lines.push(`   match${s.pageNumber ? ` p. ${s.pageNumber}` : ""}: "${text.length > 300 ? `${text.slice(0, 299)}…` : text}"`);
  }
  return lines.join("\n");
}

/** Run orx on the user's computer; its failure (not installed, a source turned off, offline) goes to the agent as is. */
async function orxCli(ctx: ProjectToolContext, args: string[], timeoutMs: number): Promise<string> {
  try {
    return await ctx.research.cli(args, { timeoutMs });
  } catch (e) {
    throw new Denied((e as Error).message);
  }
}

export type { ToolResult };
