// The Research side bar: the open notebooks and the compute machines. The
// current project (its chats, experiments and artifacts) is in the right side
// bar (project.tsx, artifacts.ts).

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { TARGET_LABELS } from "@orx/computeTargets";
import type { NotebookEntry, SelectedChat } from "./messages.js";
import { ResearchGate } from "./root.js";
import { hostRequest, onHostEvent } from "./tunnel.js";
import { Icon, IconButton, errorText } from "./ui.js";

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

export function useSelectedChat(): SelectedChat | null {
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

export function Pane({ id, title, actions, children, open, onToggle }: { id: string; title: ReactNode; actions?: ReactNode; children: ReactNode; open: boolean; onToggle: (id: string) => void }) {
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
        <ResearchPanes closed={closed} toggle={toggle} />
      </ResearchGate>
    </div>
  );
}

function ResearchPanes({ closed, toggle }: { closed: Record<string, boolean>; toggle: (id: string) => void }) {
  // Projects and their chats are in the right side bar (project.tsx), about the current project.
  return (
    <Pane id="compute" title="Compute" open={!closed.compute} onToggle={toggle}
      actions={<IconButton icon="gear" title="Compute settings" onClick={() => void hostRequest("open", { view: "settings", section: "compute" })} />}>
      <ComputeList />
    </Pane>
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
