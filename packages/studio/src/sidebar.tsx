// The Notebooks side bar view: the current project's notebook chats (open
// ones marked; a closed one opens its notebook again), then the notebooks
// open now in other projects. A click shows the notebook in the middle and its
// chat in the right side bar. The project's research chats are in Project
// Chats (project.tsx); its code and artifacts in the right side bar.

import { useEffect, useState, type ReactNode } from "react";
import type { NotebookChatSummary } from "@ainb/protocol";
import type { NotebookEntry, SelectedChat } from "./messages.js";
import { hostRequest, onHostEvent } from "./tunnel.js";
import { Icon, ago, errorText } from "./ui.js";

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

/** The project the right side bar shows (null: none), as the host says. */
function useProjectId(): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const off = onHostEvent("project.current", setId);
    hostRequest<string | null>("project.current").then((x) => setId((old) => (old === undefined ? x : old)), () => setId(null));
    return off;
  }, []);
  return id;
}

/** The Notebooks view: the list right under the view's own title, as VS Code's views have it. */
export function Sidebar() {
  const open = useNotebooks();
  const selected = useSelectedChat();
  const projectId = useProjectId();
  const [chats, setChats] = useState<NotebookChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The project's notebook chats change when one opens, closes or moves: ask again then, and now and then.
  useEffect(() => {
    if (!projectId) { setChats(null); return; }
    let live = true;
    const load = () => hostRequest<NotebookChatSummary[]>("notebookChats.list", { projectId }).then(
      (list) => { if (live) { setChats(list); setError(null); } },
      (e) => { if (live) setError(errorText(e)); },
    );
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [projectId, open.length, selected?.kind, selected?.kind === "notebook" ? selected.tabId : null]);
  const fail = (e: unknown) => void hostRequest("message", { level: "error", text: errorText(e) });
  const mine = chats ?? [];
  const others = open.filter((n) => !mine.some((c) => c.tabId === n.tabId));
  const isOn = (tabId: number | undefined) => tabId !== undefined && selected?.kind === "notebook" && selected.tabId === tabId;
  return (
    <div className="sidebar">
      {error && <p className="empty error">{error}</p>}
      {mine.map((c) => {
        const where = c.platform ? PLATFORM[c.platform as keyof typeof PLATFORM] ?? c.platform : "";
        return (
          <div key={c.notebookKey} className={`item${isOn(c.tabId) ? " sel" : ""}`} style={{ paddingLeft: 12 }} onClick={() => void hostRequest("notebookChat.open", c).catch(fail)}
            title={`${c.title ?? "Notebook"}${where ? ` (${where})` : ""}${c.tabId === undefined ? "\n\nNot open now: click to open the notebook" : ""}`}>
            <Icon name="notebook" />
            <span className="lbl">{c.title || "Notebook"}</span>
            <span className="tail">
              {c.tabId !== undefined ? <span className="dot" style={{ background: "var(--st-running)" }} title="Open now" /> : <span className="dsc">{where ? `${where} · ` : ""}{ago(c.updatedAt)}</span>}
            </span>
          </div>
        );
      })}
      {projectId && chats && !mine.length && <p className="empty">No notebook chats in this project yet.</p>}
      {!!others.length && <div className="listhead"><span className="dsc">{projectId ? "Open, in other projects" : "Open now"}</span></div>}
      {others.map((n) => (
        <div key={n.tabId} className={`item${isOn(n.tabId) ? " sel" : ""}`} style={{ paddingLeft: 12 }} onClick={() => void hostRequest("chat.select", { kind: "notebook", tabId: n.tabId }).catch(fail)}>
          <Icon name="notebook" />
          <span className="lbl">{n.title}</span>
          <span className="tail dsc">{PLATFORM[n.platform]}{n.place === "chrome" ? " · Chrome" : ""}</span>
        </div>
      ))}
      {!mine.length && !others.length && !(projectId && chats) && <p className="empty">Open a notebook on Colab or Kaggle in Chrome, or an .ipynb file here, to chat about it.</p>}
    </div>
  );
}
