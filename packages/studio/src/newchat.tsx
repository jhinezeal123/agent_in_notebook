// New Chat: where the work starts (an empty folder, an existing project, or
// a paper with its code), then which chat: a research chat (OpenResearch's
// tools: experiments, background runs, papers) or a notebook chat (our tools on
// a notebook open in Chrome or VS Code).

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { TARGET_LABELS } from "@orx/computeTargets";
import type { Harness, PaperHit, Project } from "@orx/api";
import type { AgentInfo } from "@ainb/protocol";
import type { AgentLogin, KaggleAccount, KaggleNotebookLaunch, ProjectChoice } from "./messages.js";
import { ResearchGate, useResearchStatus } from "./root.js";
import { useNotebooks } from "./sidebar.js";
import { hostRequest } from "./tunnel.js";
import { Banner, Button, Icon, errorText } from "./ui.js";

type Source = "empty" | "existing" | "paper";
type Mode = "research" | "notebook";

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const join = (dir: string, name: string) => (dir ? `${dir}${dir.includes("\\") ? "\\" : "/"}${name}` : name);

export function NewChat() {
  const status = useResearchStatus();
  const [mode, setMode] = useState<Mode>("research");
  const ready = status?.state === "ready";
  useEffect(() => { if (status && !ready && status.state !== "starting" && status.state !== "off") setMode("notebook"); }, [status?.state]);
  return (
    <div className="page">
      <header><h1>New Chat</h1><p className="muted">Pick where the work starts, then the kind of chat.</p></header>
      <section className="sec">
        <span className="lab">Chat type</span>
        <div className="modes">
          <button type="button" className="mode rs" aria-pressed={mode === "research"} onClick={() => setMode("research")}>
            <b><Icon name="flask" /> Research chat</b>
            <span>The agent creates experiment branches, sends runs to rented or remote machines, and reads papers. Results show in the experiment tree.</span>
            <span className="tags"><i>OpenResearch</i></span>
          </button>
          <button type="button" className="mode nb" aria-pressed={mode === "notebook"} onClick={() => setMode("notebook")}>
            <b><Icon name="notebook" /> Notebook chat</b>
            <span>The agent edits and runs cells in a notebook open now, and uses the terminal of the machine it runs on.</span>
            <span className="tags"><i>notebook</i><i>terminal</i></span>
          </button>
        </div>
      </section>
      {mode === "research" ? <ResearchGate><ResearchStart /></ResearchGate> : <NotebookStart />}
    </div>
  );
}

function ResearchStart() {
  const { queries, api } = useWorkspace();
  const [source, setSource] = useState<Source>("paper");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [paper, setPaper] = useState<PaperHit | null>(null);
  const [harnessId, setHarnessId] = useState<string>("");
  const [first, setFirst] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = useQuery(queries.listProjectsQuery());
  const harnesses = useQuery(queries.getHarnessesQuery());
  const compute = useQuery(queries.getComputeSettingsQuery());
  const ready = (harnesses.data ?? []).filter((h: Harness) => h.agentReady);
  useEffect(() => { if (!harnessId && ready[0]) setHarnessId(ready[0].id); }, [ready.length]);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const papers = useQuery({ ...queries.searchPapersQuery(query), enabled: source === "paper" && query.length >= 2 && !paper });
  const resolved = useQuery({ ...queries.resolvePaperQuery(paper?.paperId ?? ""), enabled: !!paper });
  // Where new projects go: next to the most recent one, else where OpenResearch's own form puts them.
  const home = useMemo(() => {
    const recent = [...(projects.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent ? parentOf(recent.path || recent.repoPath) : "~/OpenResearch";
  }, [projects.data]);
  const slug = slugify(name);
  useEffect(() => { if (source !== "existing" && slug) setLocation(join(home, slug)); }, [slug, home, source]);
  useEffect(() => { if (paper && !name) setName(slugify((paper.title ?? paper.paperId).split(":")[0]!)); }, [paper]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      let project: Project | undefined;
      if (source === "existing" && projectId) project = projects.data?.find((p) => p.id === projectId);
      else {
        const body = source === "paper"
          ? { creationMode: "paper" as const, name: name || slug, path: location, paperId: paper!.paperId, cloneUrl: resolved.data?.repoUrl ?? undefined, createFolder: true, requireNewFolder: false, initializeGit: true }
          : source === "existing"
            ? { creationMode: "folder" as const, name: name || slugify(folder!.split(/[\\/]/).pop()!), path: folder!, createFolder: false, requireNewFolder: false, initializeGit: true }
            : { creationMode: "blank" as const, name: name || slug, path: location, createFolder: true, requireNewFolder: true, initializeGit: true };
        project = (await api.createProject(body)).project;
      }
      if (!project) throw new Error("Choose a project.");
      const session = await api.createChatSession(project.id, harnessId as Harness["id"]);
      if (first.trim()) await api.sendChatMessage(session.id, first.trim());
      await hostRequest("chat.select", { kind: "research", projectId: project.id, sessionId: session.id });
      void hostRequest("close");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const canStart = !!harnessId && (source === "existing" ? !!(projectId || folder) : source === "paper" ? !!paper && !!location && !resolved.isPending : !!slug && !!location);
  const label = source === "paper" ? (resolved.data?.repoUrl ? "Clone the paper's code and start" : "Create project and start") : source === "existing" && projectId ? "Start chat" : "Create project and start";

  return (
    <>
      <section className="sec">
        <span className="lab">Start from</span>
        <div className="segc" role="radiogroup">
          {([["empty", "Empty folder"], ["existing", "Existing project"], ["paper", "From a paper"]] as const).map(([k, l]) => (
            <button type="button" key={k} role="radio" aria-checked={source === k} aria-pressed={source === k} onClick={() => setSource(k)}>{l}</button>
          ))}
        </div>
        {source === "empty" && (
          <div className="two">
            <label className="field"><span className="lab">Project name</span><input className="inp" value={name} placeholder="my-research" onInput={(e) => setName(e.currentTarget.value)} /></label>
            <label className="field"><span className="lab">Project location</span><input className="inp mono" value={location} onInput={(e) => setLocation(e.currentTarget.value)} /></label>
          </div>
        )}
        {source === "existing" && (
          <>
            {!!projects.data?.length && (
              <div className="radios">
                <span className="lab">OpenResearch projects</span>
                {[...projects.data].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((p) => (
                  <label key={p.id}><input type="radio" name="proj" checked={projectId === p.id} onChange={() => { setProjectId(p.id); setFolder(null); }} /> {p.name} <small>{p.repoPath}</small></label>
                ))}
              </div>
            )}
            <Button className="picker" onClick={() => void hostRequest<string | null>("folder.pick", { title: "Choose an existing project folder" }).then((p) => { if (p) { setFolder(p); setProjectId(null); } })}>
              <Icon name="folder" /><span>{folder ?? "Choose another folder…"}</span><Icon name="chev-r" />
            </Button>
          </>
        )}
        {source === "paper" && (
          paper ? (
            <>
              <div className="pcard"><Icon name="library" /><div><b>{paper.title}</b><span className="muted small">{resolved.isPending ? "Looking for its code…" : resolved.data?.repoUrl ? resolved.data.repoUrl.replace(/^https?:\/\//, "") : `arXiv ${paper.paperId}`}</span></div><Button small onClick={() => setPaper(null)}>Change</Button></div>
              {resolved.isSuccess && !resolved.data.repoUrl && <Banner tone="warn">No public repository found on alphaXiv. The project starts empty, with the paper's PDF.</Banner>}
              <div className="two">
                <label className="field"><span className="lab">{resolved.data?.repoUrl ? "Clone destination" : "Project location"}</span><input className="inp mono" value={location} onInput={(e) => setLocation(e.currentTarget.value)} /></label>
                <label className="field"><span className="lab">Project name</span><input className="inp" value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
              </div>
            </>
          ) : (
            <>
              <label className="field"><span className="lab">Paper</span><input className="inp" value={q} autoFocus placeholder="Search for a paper by arXiv ID, URL, or title" onInput={(e) => setQ(e.currentTarget.value)} />
                <span className="muted small">{papers.isFetching ? "Searching alphaXiv…" : "A linked public code repository is cloned without credentials."}</span></label>
              {query.length >= 2 && (
                <div className="list">
                  {papers.isError && <p className="empty error">{errorText(papers.error)}</p>}
                  {papers.data?.map((p) => (
                    <button type="button" key={p.paperId} className="prow" onClick={() => setPaper(p)}><b>{p.title}</b><small>{p.paperId}</small></button>
                  ))}
                  {papers.isSuccess && !papers.data.length && <p className="empty">No papers found. Try an arXiv ID, URL, or a different title.</p>}
                </div>
              )}
            </>
          )
        )}
      </section>
      <section className="sec">
        <div className="two">
          <label className="field"><span className="lab">Agent</span>
            <select className="inp" value={harnessId} onChange={(e) => setHarnessId(e.currentTarget.value)}>
              {ready.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              {!ready.length && <option value="">No agent is ready</option>}
            </select>
            {!ready.length && harnesses.isSuccess && <a href="#" className="small" onClick={(e) => { e.preventDefault(); void hostRequest("open", { view: "settings", section: "agents" }); }}>Set up an agent</a>}
          </label>
          <div className="field"><span className="lab">Runs go to</span>
            <span className="inp ro">{compute.data?.defaultBackend ? TARGET_LABELS[compute.data.defaultBackend]?.() ?? compute.data.defaultBackend : "No default yet"}</span>
            <a href="#" className="small" onClick={(e) => { e.preventDefault(); void hostRequest("open", { view: "settings", section: "compute" }); }}>Change in Settings</a>
          </div>
        </div>
        <label className="field"><span className="lab">First message (optional)</span><textarea className="inp" rows={3} value={first} placeholder="Reproduce Table 2 of the paper, then try a smaller learning rate." onInput={(e) => setFirst(e.currentTarget.value)} /></label>
      </section>
      {error && <Banner tone="error">{error}</Banner>}
      <footer className="foot"><Button onClick={() => void hostRequest("close")}>Cancel</Button><Button primary disabled={!canStart || busy} onClick={() => void start()}>{busy ? "Creating…" : label}</Button></footer>
    </>
  );
}

function NotebookStart() {
  const notebooks = useNotebooks();
  const [tabId, setTabId] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState("");
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  // "": Scratch, the project for notebooks that belong to none yet.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [logins, setLogins] = useState<AgentLogin[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { hostRequest<{ agents: AgentInfo[] }>("agents.list").then((r) => { setAgents(r.agents); setAgentId((a) => a || r.agents.find((x) => x.available)?.id || ""); }, () => {}); }, []);
  useEffect(() => {
    void Promise.all([hostRequest<ProjectChoice[]>("projects.list").catch(() => []), hostRequest<string | null>("project.current").catch(() => null)]).then(([list, current]) => {
      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      setProjects(sorted);
      setProjectId((p) => p ?? (current && sorted.some((x) => x.id === current) ? current : ""));
    });
    hostRequest<AgentLogin[]>("agents.logins").then(setLogins, () => {});
  }, []);
  useEffect(() => { if (tabId === null && notebooks[0]) setTabId(notebooks[0].tabId); }, [notebooks.length]);
  const PLACE = { colab: "Colab tab in Chrome", kaggle: "Kaggle tab in Chrome", jupyter: "Jupyter tab in Chrome", vscode: "open in VS Code" } as const;
  const login = logins.find((l) => l.agentId === agentId);
  const start = () => {
    setError(null);
    void hostRequest("chat.select", { kind: "notebook", tabId, agentId, ...(projectId ? { projectId } : {}) }).then(() => hostRequest("close"), (e) => setError(errorText(e)));
  };
  return (
    <>
      <section className="sec">
        <span className="lab">Notebook</span>
        {notebooks.length ? (
          <div className="radios">
            {notebooks.map((n) => (
              <label key={n.tabId}><input type="radio" name="nbk" checked={tabId === n.tabId} onChange={() => setTabId(n.tabId)} /> {n.title} <small>{PLACE[n.platform]}</small></label>
            ))}
          </div>
        ) : <Banner tone="info">No notebook is open. Open a new Kaggle notebook below, a Colab notebook in Chrome (with the Agent in Notebook extension), or an .ipynb file in VS Code.</Banner>}
        <KaggleLauncher notebooks={notebooks} onAppeared={setTabId} />
      </section>
      <section className="sec">
        <div className="two">
          <label className="field"><span className="lab">Project</span>
            <select className="inp" value={projectId ?? ""} onChange={(e) => setProjectId(e.currentTarget.value)}>
              <option value="">Scratch (no project yet)</option>
              {projects.filter((p) => p.name !== "Scratch").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="muted small">The agent reads the project's code, experiments and results, and saves the notebook to its artifacts. A notebook already in a project moves to this one.</span>
          </label>
          <label className="field"><span className="lab">Agent</span>
            <select className="inp" value={agentId} onChange={(e) => setAgentId(e.currentTarget.value)}>
              {agents.map((a) => <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{a.available ? "" : " (not installed)"}</option>)}
            </select>
            {login && login.state !== "ready" && login.state !== "unsupported" && (
              <span className="muted small">{login.state === "needsLogin" ? `OpenResearch says ${login.name} is not signed in. Sign in once and both chats use it.` : `OpenResearch could not tell whether ${login.name} is signed in.`}{login.note ? ` ${login.note}` : ""}</span>
            )}
          </label>
        </div>
      </section>
      {error && <Banner tone="error">{error}</Banner>}
      <footer className="foot"><Button onClick={() => void hostRequest("close")}>Cancel</Button>
        <Button primary disabled={tabId === null || !agentId} onClick={start}>Start chat</Button></footer>
    </>
  );
}

type Notebooks = ReturnType<typeof useNotebooks>;

/** Kaggle's "k" mark (its favicon), the first letter of the official wordmark (Simple Icons). */
function KaggleMark() {
  return (
    <svg viewBox="-1.8 7.3 7 7.05" width="20" height="20" aria-label="Kaggle" role="img">
      <path fill="#20BEFF" d="M.1025 7.3475c-.0681 0-.1022.0341-.1022.102v6.752c0 .0681.034.1022.1022.1022h.7049c.068 0 .1022-.034.1022-.1023v-1.481l.4187-.3985 1.5016 1.91c.041.0477.0884.0716.143.0716h.9091c.0476 0 .0748-.0135.0817-.0407.0135-.041.0066-.075-.0206-.1023l-1.9816-2.4618 1.9002-1.8384c.0204-.0205.0237-.051.01-.092-.0137-.0339-.0408-.051-.0816-.051h-.9398c-.0477 0-.0953.024-.143.0716L.9096 11.607V7.4496c0-.0679-.0342-.102-.1022-.102z" />
    </svg>
  );
}

/** Opens a fresh Kaggle notebook in Chrome for one of the Kaggle accounts; once its tab connects it is picked above. */
function KaggleLauncher({ notebooks, onAppeared }: { notebooks: Notebooks; onAppeared: (tabId: number) => void }) {
  const accounts = useQuery({
    queryKey: ["kaggle-notebook-accounts"],
    queryFn: () => hostRequest<KaggleAccount[]>("kaggle.accounts"),
    retry: false,
  });
  const [accountId, setAccountId] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Exclude<KaggleNotebookLaunch, { state: "opened" }> | null>(null);
  // The tabs open before the launch: the first Kaggle tab not among them is the new one.
  const [before, setBefore] = useState<Set<number> | null>(null);

  useEffect(() => { if (!accountId && accounts.data?.[0]) setAccountId(accounts.data[0].id); }, [accounts.data]);
  useEffect(() => {
    if (!before) return;
    const fresh = notebooks.find((n) => n.platform === "kaggle" && !before.has(n.tabId));
    if (fresh) { onAppeared(fresh.tabId); setBefore(null); }
  }, [notebooks, before]);

  const open = async (recover = true) => {
    if (!accountId || opening) return;
    setOpening(true);
    setError(null);
    setResult(null);
    setBefore(null);
    try {
      const launch = await hostRequest<KaggleNotebookLaunch>("kaggle.openNotebook", { id: accountId, recover });
      if (launch.state === "opened") setBefore(new Set(notebooks.map((n) => n.tabId)));
      else setResult(launch);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOpening(false);
    }
  };

  const alias = accounts.data?.find((a) => a.id === accountId)?.alias;
  const none = accounts.data?.length === 0;
  return (
    <div className="launch">
      <div className="launch-main">
        <span className="lg lg-kaggle"><KaggleMark /></span>
        <div className="launch-text">
          <b>New Kaggle notebook</b>
          <span className="muted small">{none ? "Add an account to your Kaggle account pool to open one here." : "Opens a fresh Kaggle tab in Chrome, signed in to the account you pick."}</span>
        </div>
        {!none && !accounts.isError && (
          <div className="launch-act">
            <select className="inp" aria-label="Kaggle account" value={accountId} disabled={!accounts.data?.length || opening} onChange={(e) => setAccountId(e.currentTarget.value)}>
              {accounts.isPending && <option value="">Loading accounts…</option>}
              {accounts.data?.map(({ id, alias }) => <option key={id} value={id}>{alias}</option>)}
            </select>
            <Button disabled={!accountId || opening} onClick={() => void open()}>{opening ? <><span className="spinner small" /> Opening…</> : <><Icon name="plus" /> Open</>}</Button>
          </div>
        )}
      </div>
      {opening && <span className="muted small" role="status">Recovering the Kaggle session for {alias}, then opening Chrome…</span>}
      {before && !opening && <span className="muted small" role="status"><span className="spinner small" /> Opened in Chrome. Waiting for the notebook to connect; it is picked above when it does.</span>}
      {result && <Banner tone={result.state === "sign-in" ? "info" : "warn"}>
        <div><p role="status">{result.message}</p>
          {result.state === "unavailable" && <Button small onClick={() => void open(false)}>Open Chrome anyway</Button>}
          {result.state === "retry" && <Button small onClick={() => void open()}>Try again</Button>}</div>
      </Banner>}
      {accounts.isError && <div className="row"><Banner tone="error">{errorText(accounts.error)}</Banner><Button small disabled={accounts.isFetching} onClick={() => void accounts.refetch()}>Retry</Button></div>}
      {error && <Banner tone="error">{error}</Banner>}
    </div>
  );
}
