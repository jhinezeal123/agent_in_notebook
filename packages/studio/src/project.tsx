// The right side bar's research view: the current project (the one opened
// last) in a bar at the top, its research chats and its experiment tree. Its
// artifacts are a native tree next to it (packages/vscode/src/artifacts.ts).

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { buildHistoryNodes, layoutLineage, type HistoryRow } from "@orx/components/experimentLineageModel";
import type { ChatSession, Project } from "@orx/api";
import { delegateLineage, delegateModelLabel, delegateStatus } from "@orx/delegates";
import { pickProject } from "./messages.js";
import { ResearchGate } from "./root.js";
import { Pane, useSelectedChat } from "./sidebar.js";
import { hostRequest, onHostEvent } from "./tunnel.js";
import { Icon, IconButton, StatusShape, ago, errorText } from "./ui.js";

/** The projects, and the current one (see pickProject). `project` is undefined until both are known. */
export function useCurrentProject() {
  const { queries } = useWorkspace();
  const projects = useQuery(queries.listProjectsQuery());
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const off = onHostEvent("project.current", setOpened);
    hostRequest<string | null>("project.current").then((id) => setOpened((old) => (old === undefined ? id : old)), () => setOpened(null));
    return off;
  }, []);
  const list = useMemo(() => [...(projects.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [projects.data]);
  const project = projects.data && opened !== undefined ? pickProject(list, opened) : undefined;
  return { projects, list, project };
}

export function ProjectPanel() {
  return <ResearchGate compact><ProjectInner /></ResearchGate>;
}

function ProjectInner() {
  const { projects, project } = useCurrentProject();
  const selected = useSelectedChat();
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setClosed((c) => ({ ...c, [id]: !c[id] }));
  if (projects.isError) return <p className="empty error">{errorText(projects.error)}</p>;
  if (project === undefined) return <p className="empty">Loading…</p>;
  if (!project) {
    return <p className="empty">No projects yet. <a href="#" onClick={(e) => { e.preventDefault(); void hostRequest("open", { view: "newchat" }); }}>Start one</a> from a folder or a paper.</p>;
  }
  return (
    <div className="sidebar">
      <ProjectBar project={project} />
      {/* The experiment tree is for research chats; a notebook chat does not follow it. */}
      {selected?.kind === "research" && (
        <Pane id="experiments" title="Experiments" open={!closed.experiments} onToggle={toggle}>
          <ExperimentTree project={project} />
        </Pane>
      )}
    </div>
  );
}

/** Which project the right side bar is about; click it to show another. */
function ProjectBar({ project }: { project: Project }) {
  const pick = () => void hostRequest("project.pick");
  return (
    <div className="projbar" role="button" tabIndex={0} title={`${project.name}\n${project.repoPath}\n\nClick to show another project`}
      onClick={pick} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick()}>
      <Icon name="folder" />
      <div className="projbar-text">
        <b>{project.name}</b>
        <span className="dsc">{project.repoPath}</span>
      </div>
      <span className="projbar-actions">
        <IconButton icon="code" title="Open the project's code in a new window" onClick={() => void hostRequest("folder.open", { path: project.repoPath, newWindow: true })} />
        <IconButton icon="swap" title="Show another project" onClick={pick} />
      </span>
    </div>
  );
}

/** The left side bar's Project Chats: the current project's research chats, sub-agents under the chat that started them. */
export function ProjectChats() {
  return <ResearchGate compact><ProjectChatsInner /></ResearchGate>;
}

function ProjectChatsInner() {
  const { projects, project } = useCurrentProject();
  if (projects.isError) return <p className="empty error">{errorText(projects.error)}</p>;
  if (project === undefined) return <p className="empty">Loading…</p>;
  if (!project) return <p className="empty">No projects yet. <a href="#" onClick={(e) => { e.preventDefault(); void hostRequest("open", { view: "newchat" }); }}>Start one</a>.</p>;
  return <div className="sidebar"><ChatList project={project} /></div>;
}

/** The project's research chats; a click shows one in the middle. */
function ChatList({ project }: { project: Project }) {
  const { queries, api } = useWorkspace();
  const selected = useSelectedChat();
  const sessions = useQuery(queries.listChatSessionsQuery(project.id));
  const all = sessions.data ?? [];
  // A delegate is listed under the chat that started it (a side chat too: it may wait on the user);
  // one whose chat is not listed here stands on its own.
  const listed = (s: ChatSession) => !s.archived && !s.sideParentSessionId;
  const chats = all.filter((s: ChatSession) => listed(s) && !(s.delegate && all.some((p) => p.id === s.delegate!.parentId && listed(p))));
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
      <div className="listhead">
        <span className="dsc" title={project.repoPath}>{project.name}</span>
        <IconButton icon="plus" title="New research chat in this project" disabled={creating} onClick={() => void newChat()} />
      </div>
      {sessions.isError && <p className="empty error">{errorText(sessions.error)}</p>}
      {chats.flatMap((s) => [{ session: s, level: 0 }, ...delegateLineage(all, s.id).filter((d) => !d.session.archived)]).map(({ session: s, level }) => {
        const on = selected?.kind === "research" && selected.sessionId === s.id;
        const status = level ? delegateStatus(s, all) : null;
        const asking = s.awaitingInput || status === "asking" || status === "approval";
        return (
          <div key={s.id} className={`item${on ? " sel" : ""}`} style={{ paddingLeft: 20 + 14 * level }} onClick={() => void hostRequest("chat.select", { kind: "research", projectId: project.id, sessionId: s.id })}
            title={level ? `Sub-agent: ${s.title || delegateModelLabel(s)}` : s.title ?? undefined}>
            <Icon name={level ? "branch" : "comment"} />
            <span className="lbl">{s.title || (level ? delegateModelLabel(s) || "Sub-agent" : "New chat")}</span>
            <span className="tail">
              {asking ? <span className="ask" title={status === "approval" ? "Waiting for your approval" : "Waiting for your answer"}>?</span>
                : s.busy || status === "running" ? <span className="dot pulse" style={{ background: "var(--st-running)" }} title="Working" />
                : status === "failed" ? <span className="dsc" style={{ color: "var(--st-failed)" }}>failed</span>
                : <span className="dsc">{ago(s.updatedAt)}</span>}
            </span>
          </div>
        );
      })}
      {sessions.isSuccess && !chats.length && (
        <p className="empty">No research chats yet. <a href="#" onClick={(e) => { e.preventDefault(); void newChat(); }}>Start one</a>.</p>
      )}
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
