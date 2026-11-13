// The Notebooks side bar view: the open notebooks; a click shows the chat about one.
// The current project (its chats, experiments, code and artifacts) is in the
// right side bar (project.tsx, folder-tree.ts); compute is in Settings, a
// button on this view's title.

import { useEffect, useState, type ReactNode } from "react";
import type { NotebookEntry, SelectedChat } from "./messages.js";
import { hostRequest, onHostEvent } from "./tunnel.js";
import { Icon } from "./ui.js";

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

/** The Notebooks view: the list right under the view's own title, as VS Code's views have it. */
export function Sidebar() {
  const notebooks = useNotebooks();
  const selected = useSelectedChat();
  return (
    <div className="sidebar">
      {notebooks.length ? notebooks.map((n) => {
        const on = selected?.kind === "notebook" && selected.tabId === n.tabId;
        return (
          <div key={n.tabId} className={`item${on ? " sel" : ""}`} style={{ paddingLeft: 12 }} onClick={() => void hostRequest("chat.select", { kind: "notebook", tabId: n.tabId })}>
            <Icon name="notebook" />
            <span className="lbl">{n.title}</span>
            <span className="tail dsc">{PLATFORM[n.platform]}{n.place === "chrome" ? " · Chrome" : ""}</span>
          </div>
        );
      }) : <p className="empty">Open a notebook on Colab or Kaggle in Chrome, or an .ipynb file here, to chat about it.</p>}
    </div>
  );
}
