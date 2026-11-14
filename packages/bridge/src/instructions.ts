// What the agent is told. The playbook rides the first turn of a session (every
// agent accepts plain prompt text, not every agent has a system prompt
// channel); a short context block rides every turn, so mode changes reach the
// agent without restarting it.

import { capText, firstLine, SCOPE_HINT, SCOPE_LABEL, type CellInfo, type ChatMessage, type ChatProject, type ChatSettings, type NotebookInfo } from "@ainb/protocol";
import type { BriefExperiment, BriefRun, ProjectBrief } from "./research/links.js";

const PLATFORM_NAME = { colab: "Google Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

export function playbook(info: NotebookInfo | null, file: string | null = null, project = false): string {
  const where = info ? PLATFORM_NAME[info.platform] : "Colab/Kaggle";
  const nbFile = file ? `the file ${file}` : "an .ipynb file in the working directory (notebook_info names it)";
  const editor = info?.platform === "vscode" ? "VS Code" : "the browser";
  // Colab lends no server terminal: the machine is reached through the kernel only.
  const colab = info?.platform === "colab" && !info.serverTerminals
    ? "\n- On Colab the terminal and the machine's files go through the kernel: while a cell runs they wait for it (commands already running keep running). The notebook file does not wait. Start long commands before a long cell, or wait for the cell."
    : "";
  return `<agent-in-notebook>
You are helping the user with a ${where} notebook open in ${editor}. You work on the machine the notebook runs on, through the tools of the MCP server named "notebook", as you would on your own computer:
- Bash (with shell_wait, shell_input, shell_interrupt): a terminal there. Sessions persist (cd, env, venv), commands run as long as they need, prompts can be answered.
- Read, Write, Edit, Glob, Grep: its files. Relative paths start in the notebook's working directory.
- The notebook is ${nbFile}, kept in step with ${editor}: Read shows it as cells with their outputs, current even while a cell runs; Edit changes text inside a cell; NotebookEdit replaces, inserts, deletes or moves cells; Write replaces it whole (.ipynb JSON). Commands may change the file too (nbformat, jupytext, jq); the change reaches ${editor}. Cells are matched by their ids: keep them.
- run_cells, run_all, wait_for_cells, interrupt_kernel: run the notebook's cells. read_output pages through a long output.
- run_code, wait_for_code: run code on the kernel, with the notebook's variables, without adding a cell.
- await_review: wait for the user's decision on a change awaiting review.${colab}

Rules:
1. Any shell or file tools of your own act on the user's computer, not on the notebook's machine. Use the notebook server's tools.
2. Read the notebook before changing it; the user edits it too.
3. Follow the mode given in <notebook-context>. The tools refuse what the mode forbids; do not work around a refusal, tell the user what you would do instead.
4. With review on, every change to the notebook is shown to the user as a diff, and commands wait for approval. A rejected change was not applied: do not retry it unchanged.
5. Steps the notebook needs in order to run again from the top (installs it imports, downloads it reads, data preparation) go in its cells, shell commands prefixed with "!"; everything else can happen in the terminal.
6. Keep each code cell to one logical step. Use markdown cells for prose when the user asks for explanations or a write-up.
7. When done, answer briefly in the user's language and name the cells you changed.${project ? `
8. This notebook belongs to an OpenResearch project (see <project-context>), kept on the user's computer. When the project has a GitHub repository, its code is cloned on the notebook's machine on a branch of this chat's (see <project-code>): change and run it there with your usual tools, and commit; the bridge pushes after each of your turns. Another branch: git fetch there. The project's shared artifacts (on the user's computer, seen by the user and every chat of the project) are reached only through the MCP server named "project": artifact_list, artifact_read (to_vm copies a file to the machine), artifact_write (text, or from_vm: a file on the machine). Write to the shared artifacts only the results and outputs the user asked for (a report, a figure, a table of metrics); code, working notes and scratch files stay in the repository on the machine. save_notebook saves this notebook with its outputs there; run_result reads a run's result or log.
9. For conceptual or scientific questions, comparisons of methods and related work, ground your answer in the literature: search with paper_search and read the papers you rely on with paper_read (MCP server "project") before answering, and link the papers you cite. Do not cite a paper you have not found that way. The user's /lit-review asks for a full literature review (see <lit-review>).` : ""}
</agent-in-notebook>`;
}

const OUTLINE_MAX_CELLS = 80;

/** `outlineUnchanged`: the agent got this same outline with its previous message. */
/** `file`: the notebook's file on its machine. */
export function turnContext(info: NotebookInfo | null, cells: CellInfo[] | null, settings: ChatSettings, targets: string[], outlineUnchanged = false, file: string | null = null): string {
  if (!info) {
    return `<notebook-context>\nNo notebook is attached right now (the tab may have navigated or reloaded). Tools will fail until it is back.\n</notebook-context>`;
  }
  const lines = [
    `Notebook: ${info.title} (${PLATFORM_NAME[info.platform]})${file ? `, file ${file}` : ""}`,
    `Kernel: ${info.kernel}. Language: ${info.language}.`,
    `Mode: ${SCOPE_LABEL[settings.scope]}. ${SCOPE_HINT[settings.scope]}${settings.review ? " Review is ON: each change waits for the user's approval." : ""}`,
  ];
  if (settings.scope === "cell") lines.push(`Editable cell(s): ${targets.length ? targets.join(", ") : "none — ask the user to select one"}.`);
  if (settings.notebookOnly) lines.push("Notebook only: requests to use your own tools on the user's computer (shell, file edits, web) are refused. Work through the notebook server's tools.");
  lines.push(`Active cell: ${info.activeCellId ?? "none"}.`);
  if (cells && outlineUnchanged) {
    lines.push(`Outline: ${cells.length} cells, unchanged since your previous message.`);
  } else if (cells) {
    lines.push(`Outline (${cells.length} cells):`);
    for (const c of cells.slice(0, OUTLINE_MAX_CELLS)) {
      lines.push(`[${c.index}] ${c.id} ${c.type}: ${firstLine(c.source, 70) || "(empty)"}`);
    }
    if (cells.length > OUTLINE_MAX_CELLS) lines.push(`… ${cells.length - OUTLINE_MAX_CELLS} more; Read the notebook file.`);
  }
  return `<notebook-context>\n${lines.join("\n")}\n</notebook-context>`;
}

/**
 * A bounded recap of the conversation, for an agent that starts mid-chat
 * (after a switch or a crash) and has none of it in its own session.
 */
export function recap(messages: ChatMessage[], maxChars = 6000): string {
  const items: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = m.parts
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "tool" && p.notebook) return `[tool: ${p.title} — ${p.status}]`;
        if (p.type === "review") return `[change to cell ${p.review.cellId}: ${p.status}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) items.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  if (!items.length) return "";
  let body = items.join("\n\n");
  if (body.length > maxChars) body = capText(body, maxChars);
  return `<earlier-conversation>\nThis chat started before you joined; here is what happened so far. The notebook may have changed since — read it again before acting.\n\n${body}\n</earlier-conversation>`;
}

/** Project context is capped at about this many characters. */
const PROJECT_CONTEXT_MAX = 8000;

const PROJECT_TOOLS =
  'Tools (MCP server "project"): artifact_list, artifact_read, artifact_write (the shared artifacts: only results the user asked for); ' +
  "save_notebook (this notebook, with outputs, to the shared artifacts); run_result (a run's result or log); " +
  "paper_search, paper_read (the research literature).";

function experimentLine(e: BriefExperiment): string {
  const name = e.title && e.title !== e.slug ? `${e.slug} "${e.title}"` : e.slug;
  const desc = e.description ? ` — ${firstLine(e.description, 100)}` : "";
  return `${name} [${e.status}] branch ${e.branch}${e.parent ? `, from ${e.parent}` : ""}${desc}`;
}

function runLine(r: BriefRun): string {
  const when = r.endedAt ? ` ${new Date(r.endedAt).toISOString().slice(0, 16).replace("T", " ")}` : "";
  const result = r.result ? `: ${firstLine(r.result.replace(/[#*`|]/g, " ").replace(/\s+/g, " ").trim(), 160)}` : "";
  return `run ${r.id} of ${r.experiment} [${r.status}]${when}${result}`;
}

function sizeText(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

/** What the agent is told about the notebook's project: on the session's first turn, after a compaction, after a move. */
export function projectContext(b: ProjectBrief, note?: string): string {
  const head = [
    `Project: ${b.name} (OpenResearch id ${b.id}).${b.paperId ? ` Paper: arXiv ${b.paperId}.` : ""}${b.githubUrl ? ` Repository: ${b.githubUrl}.` : ""}`,
    "It is on the user's computer. Paths are relative to the project; artifacts/ is its shared artifacts (artifact_read).",
    PROJECT_TOOLS,
  ];
  if (note) head.unshift(note);
  const sections: string[] = [];
  for (const d of b.docs) sections.push(`## ${d.name} (first lines)\n${d.head}`);
  sections.push(
    b.experiments.length
      ? `## Experiments (${b.experiments.length}${b.experiments.length >= 30 ? "+, newest" : ""})\n${b.experiments.map((e) => `- ${experimentLine(e)}`).join("\n")}`
      : "## Experiments\nNone yet.",
  );
  if (b.runs.length) sections.push(`## Latest runs\n${b.runs.map((r) => `- ${runLine(r)}`).join("\n")}`);
  sections.push(
    b.artifacts.length
      ? `## Shared artifacts (${b.artifactsTotal}${b.artifactsTotal > b.artifacts.length ? `, newest ${b.artifacts.length}` : ""})\n${b.artifacts.map((a) => `- artifacts/${a.path} (${sizeText(a.size)})`).join("\n")}`
      : "## Artifacts\nNone yet.",
  );
  let body = `${head.join("\n")}\n\n${sections.join("\n\n")}`;
  if (body.length > PROJECT_CONTEXT_MAX) body = `${capText(body, PROJECT_CONTEXT_MAX - 80)}\n(shortened)`;
  return `<project-context>\n${body}\n</project-context>`;
}

/** What changed in the project since the agent was last told, or null when nothing it was told changed. */
export function projectUpdate(before: ProjectBrief, after: ProjectBrief): string | null {
  const lines: string[] = [];
  const old = new Map(before.experiments.map((e) => [e.id, e]));
  for (const e of after.experiments) {
    const was = old.get(e.id);
    if (!was) lines.push(`New experiment: ${experimentLine(e)}`);
    else if (was.status !== e.status) lines.push(`Experiment ${e.slug}: ${was.status} → ${e.status}`);
  }
  const oldRuns = new Map(before.runs.map((r) => [r.id, r]));
  for (const r of after.runs) {
    const was = oldRuns.get(r.id);
    if (!was || was.status !== r.status || was.result !== r.result) lines.push(`${was ? "Run changed" : "New run"}: ${runLine(r)}`);
  }
  const files = new Set(before.artifacts.map((a) => a.path));
  const added = after.artifacts.filter((a) => !files.has(a.path));
  if (added.length) lines.push(`New shared artifacts: ${added.slice(0, 10).map((a) => `artifacts/${a.path}`).join(", ")}${added.length > 10 ? ` and ${added.length - 10} more` : ""}`);
  if (before.name !== after.name) lines.push(`The project is now called ${after.name}.`);
  if (!lines.length) return null;
  return `<project-update>\nChanges in project ${after.name} since your previous message:\n${lines.join("\n")}\n</project-update>`;
}

/** The project could not be read: say so (once per state), so the agent knows why its project tools fail. */
export function projectUnavailable(project: ChatProject): string {
  const why =
    project.state === "missing"
      ? `OpenResearch has no project "${project.name}" any more; the user can move this notebook to another project.`
      : `Project context unavailable (OpenResearch starting or not running)${project.error ? `: ${project.error}` : "."} The project tools say when it is back.`;
  return `<project-context>\nProject: ${project.name}. ${why}\n</project-context>`;
}

/**
 * The user typed /lit-review: OpenResearch's literature-review workflow
 * (its orx-lit-review skill), told for the tools of a notebook chat.
 */
export function litReview(text: string): string | null {
  if (!/(^|\s)\/lit-review(?![\w-])/i.test(text)) return null;
  const request = text.replace(/(^|\s)\/lit-review(?![\w-])/gi, " ").replace(/[\s.,;:!?]+/g, " ").trim();
  return `<lit-review>
The user asked for a literature review (/lit-review)${request ? " of the request in their message" : ". They named no topic: ask them what to review before searching"}. Work it like this, with paper_search and paper_read (MCP server "project"); never hand the search to a sub-agent.

Search:
1. Build the query from the user's own words and words from earlier results; never guess what an acronym stands for. keyword: short exact terms (method, acronym, benchmark, author, title phrase). embedding and openalex: one short faithful question.
2. Rate the difficulty 1-10. It sets how many follow-up rounds you may spend: 1-3 none, 4-7 one, 8-10 two. Set one date window and one priority for the whole review (published_after/before only when the request calls for them; recency for new work, historical for foundational work, popular only when asked) and keep them in every call.
3. First round: the sources that fit, at once. ML, CS, math, physics: keyword and/or embedding; add openalex for journals, conferences, citations or other fields; biorxiv for biology preprints, pubmed for biomedical and clinical work. When a keyword query mixes acronyms (2-10 characters, two or more capitals) with other words, also search those acronyms alone.
4. Merge: drop duplicates (same id, then DOI or arXiv id, then title); keep the alphaXiv copy of an arXiv paper. Do not compare alphaXiv votes with citations; rank by how well each paper fits.
5. Enough good papers: stop and rank 5-15 of them. Otherwise one follow-up round per concrete gap (a missing method, benchmark, venue, subtopic), within the budget; never just rephrase a search. An empty result does not show there is no literature.
6. At most two such reviews per turn.

Answer:
- A request for papers ("find papers", "what should I read"): give the ranked list (title linked, one line on why each) and stop.
- Claims, methods or comparisons: read the 3-5 papers that carry the answer with paper_read (full: true for exact wording) before relying on them. Never present a paper as verified from its abstract or snippets.
- Explain through the papers' own figures and tables: name them (Figure 2 of …) with a link to their page. Crop one from the PDF (on the notebook's machine, from https://arxiv.org/pdf/<id>) only when the user asks, and keep it in the shared artifacts.
- Quote the authors' own complete sentences for their reasoning, methods and limits, only from text you read; never join separate snippets or present a paraphrase as a quote. Mark your own interpretation as such.
- Links: https://www.alphaxiv.org/pdf/<arXiv id>?page=N (N when you know the page), else https://doi.org/<doi>, https://openalex.org/<W id>, https://pubmed.ncbi.nlm.nih.gov/<pmid>/. Label them "p. N", "Short title, p. N" or the title. Never invent an id or a page.
- Write the review to the shared artifacts only when the user asks for it there.
</lit-review>`;
}
