// The Research side bar: projects and their chats, the open notebooks, the
// current project's experiment tree, and the compute machines.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { TARGET_LABELS } from "@orx/computeTargets";
import { buildHistoryNodes, layoutLineage, type HistoryRow } from "@orx/components/experimentLineageModel";
import type { ChatSession, Project } from "@orx/api";
import type { NotebookEntry, SelectedChat } from "./messages.js";
import { ResearchGate } from "./root.js";
import { hostRequest, onHostEvent } from "./tunnel.js";
import { Icon, IconButton, StatusShape, ago, errorText } from "./ui.js";

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

function useSelectedChat(): SelectedChat | null {
  const [chat, setChat] = useState<SelectedChat | null>(null);
  useEffect(() => {
    const off = onHostEvent("chat.selected", setChat);
    hostRequest<SelectedChat | null>("chat.selected").then((c) => setChat((old) => old ?? c), () => {});
    return off;
  }, []);
  return chat;
}

export function useNotebooks(): NotebookEntry[] {
  const [list, setList] = useState<NotebookEntry[]>([]);
  useEffect(() => {
    const off = onHostEvent("notebooks", setList);
    hostRequest<NotebookEntry[]>("notebooks.list").then(setList, () => {});
    return off;
  }, []);
  return list;
}

function Pane({ id, title, actions, children, open, onToggle }: { id: string; title: ReactNode; actions?: ReactNode; children: ReactNode; open: boolean; onToggle: (id: string) => void }) {
  return (
    <section className={`pane${open ? " open" : ""}`}>
      <div className="pane-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => onToggle(id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onToggle(id)}>
        <Icon name={open ? "chev-d" : "chev-r"} />
        <span className="pane-title">{title}</span>
        <span className="pane-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
      {open && <div className="pane-body">{children}</div>}
    </section>
  );
}

export function Sidebar() {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setClosed((c) => ({ ...c, [id]: !c[id] }));
  const notebooks = useNotebooks();
  const selected = useSelectedChat();
  return (
    <div className="sidebar">
      <Pane id="notebooks" title="Notebooks" open={!closed.notebooks} onToggle={toggle}>
        {notebooks.length ? notebooks.map((n) => {
          const on = selected?.kind === "notebook" && selected.tabId === n.tabId;
          return (
            <div key={n.tabId} className={`item${on ? " sel" : ""}`} style={{ paddingLeft: 20 }} onClick={() => void hostRequest("chat.select", { kind: "notebook", tabId: n.tabId })}>
              <Icon name="notebook" />
              <span className="lbl">{n.title}</span>
              <span className="tail dsc">{PLATFORM[n.platform]}{n.place === "chrome" ? " · Chrome" : ""}</span>
            </div>
          );
        }) : <p className="empty">Open a notebook on Colab or Kaggle in Chrome, or an .ipynb file here, to chat about it.</p>}
      </Pane>
      <ResearchGate compact>
        <ResearchPanes closed={closed} toggle={toggle} selected={selected} />
      </ResearchGate>
    </div>
  );
}

function ResearchPanes({ closed, toggle, selected }: { closed: Record<string, boolean>; toggle: (id: string) => void; selected: SelectedChat | null }) {
  const { queries } = useWorkspace();
  const projects = useQuery(queries.listProjectsQuery());
  const list = useMemo(() => [...(projects.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [projects.data]);
  const [current, setCurrent] = useState<string | null>(null);
  // The experiment tree follows the project of the research chat in front, else the one picked here.
  const projectId = (selected?.kind === "research" ? selected.projectId : null) ?? current ?? list[0]?.id ?? null;
  const project = list.find((p) => p.id === projectId) ?? null;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (projectId) setExpanded((e) => (projectId in e ? e : { ...e, [projectId]: true }));
  }, [projectId]);

  return (
    <>
      <Pane id="projects" title="Projects" open={!closed.projects} onToggle={toggle}
        actions={<IconButton icon="plus" title="New Chat" onClick={() => void hostRequest("open", { view: "newchat" })} />}>
        {projects.isError && <p className="empty error">{errorText(projects.error)}</p>}
        {projects.isSuccess && !list.length && <p className="empty">No projects yet. <a href="#" onClick={(e) => { e.preventDefault(); void hostRequest("open", { view: "newchat" }); }}>Start one</a> from a folder or a paper.</p>}
        {list.map((p) => (
          <ProjectRow key={p.id} project={p} open={!!expanded[p.id]} current={p.id === projectId} selected={selected}
            onToggle={() => { setExpanded((e) => ({ ...e, [p.id]: !e[p.id] })); setCurrent(p.id); }} />
        ))}
      </Pane>
      <Pane id="experiments" title={project ? `Experiments · ${project.name}` : "Experiments"} open={!closed.experiments} onToggle={toggle}>
        {project ? <ExperimentTree project={project} /> : <p className="empty">Pick a project.</p>}
      </Pane>
      <Pane id="compute" title="Compute" open={!closed.compute} onToggle={toggle}
        actions={<IconButton icon="gear" title="Compute settings" onClick={() => void hostRequest("open", { view: "settings", section: "compute" })} />}>
        <ComputeList />
      </Pane>
    </>
  );
}

function ProjectRow({ project, open, current, selected, onToggle }: { project: Project; open: boolean; current: boolean; selected: SelectedChat | null; onToggle: () => void }) {
  const { queries, api } = useWorkspace();
  const sessions = useQuery({ ...queries.listChatSessionsQuery(project.id), enabled: open });
  const chats = (sessions.data ?? []).filter((s: ChatSession) => !s.archived && !s.sideParentSessionId);
  const harnesses = useQuery(queries.getHarnessesQuery());
  const [creating, setCreating] = useState(false);
  const newChat = async () => {
    const harness = harnesses.data?.find((h) => h.agentReady);
    if (!harness) { void hostRequest("open", { view: "settings", section: "agents" }); return; }
    setCreating(true);
    try {
      const session = await api.createChatSession(project.id, harness.id);
      await hostRequest("chat.select", { kind: "research", projectId: project.id, sessionId: session.id });
    } catch (e) {
      void hostRequest("message", { level: "error", text: errorText(e) });
    } finally {
      setCreating(false);
    }
  };
  return (
    <>
      <div className={`item${current ? " current" : ""}`} style={{ paddingLeft: 6 }} onClick={onToggle} title={project.repoPath}>
        <Icon name={open ? "chev-d" : "chev-r"} />
        <Icon name="folder" />
        <span className="lbl">{project.name}</span>
        <span className="tail hov"><IconButton icon="plus" title="New research chat in this project" disabled={creating} onClick={() => void newChat()} /></span>
      </div>
      {open && chats.map((s) => {
        const on = selected?.kind === "research" && selected.sessionId === s.id;
        return (
          <div key={s.id} className={`item${on ? " sel" : ""}`} style={{ paddingLeft: 38 }} onClick={() => void hostRequest("chat.select", { kind: "research", projectId: project.id, sessionId: s.id })} title={s.title ?? undefined}>
            <Icon name="comment" />
            <span className="lbl">{s.title || "New chat"}</span>
            <span className="tail">
              {s.awaitingInput ? <span className="ask" title="Waiting for your answer">?</span> : s.busy ? <span className="dot pulse" style={{ background: "var(--st-running)" }} title="Working" /> : <span className="dsc">{ago(s.updatedAt)}</span>}
            </span>
          </div>
        );
      })}
      {open && sessions.isSuccess && !chats.length && <p className="empty" style={{ paddingLeft: 38 }}>No chats yet.</p>}
    </>
  );
}

function ExperimentTree({ project }: { project: Project }) {
  const { queries } = useWorkspace();
  const experiments = useQuery(queries.listExperimentsQuery(project.id));
  const runs = useQuery(queries.listRunsQuery(project.id));
  const rows = useMemo<HistoryRow[]>(() => {
    if (!experiments.data) return [];
    const nodes = buildHistoryNodes(experiments.data.filter((e) => !e.archived), runs.data ?? []);
    return layoutLineage({ key: "all", title: "", nodes });
  }, [experiments.data, runs.data]);
  if (experiments.isError) return <p className="empty error">{errorText(experiments.error)}</p>;
  if (experiments.isPending) return <p className="empty">Loading…</p>;
  if (!rows.length) return <p className="empty">No experiments yet. A research chat creates them as it works.</p>;
  return (
    <div className="lineage">
      {rows.map((row) => {
        const node = row.kind === "collapsed" ? row.head : row.node;
        const open = () => void hostRequest("open", { view: "experiment", projectId: project.id, experimentId: node.id });
        if (row.kind === "lead-in") return <div key={`in-${node.id}`} className="item dsc" style={{ paddingLeft: 14 + row.lane * 14 }}>from {row.from.label}</div>;
        return (
          <div key={node.id} className="item" style={{ paddingLeft: 14 + row.lane * 14 }} onClick={open} title={node.experiment.title ?? node.experiment.slug}>
            {row.lane > 0 && <span className="rail" aria-hidden="true">└</span>}
            <StatusShape status={node.status} root={!node.parent} />
            <span className="lbl">{row.kind === "collapsed" ? `${node.label} +${row.hidden.length - 1}` : node.code ? `${node.code}: ${node.label}` : node.label}</span>
            <span className="tail">
              <span className="dsc st-text">{node.latestRun ? ago(node.latestRun.endedAt ?? node.latestRun.startedAt ?? node.latestRun.createdAt) : "not run"}</span>
              <span className="hov">
                {node.latestRun && <IconButton icon="terminal" title="Logs" onClick={() => void hostRequest("logs.show", { runId: node.latestRun!.id, title: node.experiment.slug })} />}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ComputeList() {
  const { queries } = useWorkspace();
  const compute = useQuery(queries.getComputeSettingsQuery());
  if (compute.isError) return <p className="empty error">{errorText(compute.error)}</p>;
  const targets = (compute.data?.targets ?? []).filter((t) => t.configured || t.id === compute.data?.defaultBackend);
  return (
    <>
      {targets.map((t) => {
        const isDefault = t.id === compute.data?.defaultBackend;
        return (
          <div key={t.id} className="item" style={{ paddingLeft: 20 }} onClick={() => void hostRequest("open", { view: "settings", section: "compute" })} title={t.summary}>
            <span className="dot" style={{ background: t.enabled ? "var(--st-done)" : "var(--st-muted)" }} />
            <span className="lbl">{TARGET_LABELS[t.id]?.() ?? t.id}</span>
            <span className="tail dsc">{isDefault ? "Default" : t.summary}</span>
          </div>
        );
      })}
      {compute.isSuccess && !targets.length && <p className="empty">No machine set up for background runs. <a href="#" onClick={(e) => { e.preventDefault(); void hostRequest("open", { view: "settings", section: "compute" }); }}>Set one up</a>.</p>}
    </>
  );
}
