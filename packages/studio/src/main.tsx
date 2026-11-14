// Entry of the research screens. In their own webview (the side bar, an
// editor tab) they render into #studio; the chat panel loads this bundle too
// and mounts a research chat through `window.ainbStudio`.

import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createWorkspace, type Workspace } from "@orx/workspace";
import type { StudioView } from "./messages.js";
import { installTunnel, onHostEvent } from "./tunnel.js";
import { WorkspaceRoot } from "./root.js";
import { Sidebar } from "./sidebar.js";
import { ProjectChats, ProjectPanel } from "./project.js";
import { NewChat } from "./newchat.js";
import { Settings } from "./settings.js";
import { ExperimentView } from "./experiment.js";
import { ResearchChat } from "./chat.js";

installTunnel();
let workspace: Workspace | undefined;
const getWorkspace = () => (workspace ??= createWorkspace("vscode"));

function Screen({ initial }: { initial: StudioView }) {
  const [view, setView] = useState(initial);
  useEffect(() => onHostEvent("view", setView), []);
  // OpenResearch's way: Compute picks the request up and opens the connect form for that host.
  useEffect(() => { if (view.view === "settings" && view.connectHost) getWorkspace().events.requestHostConnect(view.connectHost); }, [view]);
  switch (view.view) {
    case "sidebar": return <Sidebar />;
    case "project": return <ProjectPanel />;
    case "projectChats": return <ProjectChats />;
    case "newchat": return <NewChat />;
    case "settings": return <Settings section={view.section} request={view} />;
    case "experiment": return <ExperimentView key={view.experimentId} projectId={view.projectId} experimentId={view.experimentId} />;
    case "chat": return <ResearchChat projectId={view.projectId} sessionId={view.sessionId} />;
  }
}

const el = document.getElementById("studio");
if (el?.dataset.view) {
  const view = JSON.parse(el.dataset.view) as StudioView;
  createRoot(el).render(<WorkspaceRoot workspace={getWorkspace()}><Screen initial={view} /></WorkspaceRoot>);
}

let chatRoot: Root | undefined;
(window as unknown as { ainbStudio: unknown }).ainbStudio = {
  /** Show a research chat in `element` (null: unmount it). */
  showChat(element: HTMLElement, chat: { projectId: string; sessionId: string } | null) {
    if (!chat) { chatRoot?.unmount(); chatRoot = undefined; return; }
    chatRoot ??= createRoot(element);
    chatRoot.render(<WorkspaceRoot workspace={getWorkspace()}><ResearchChat projectId={chat.projectId} sessionId={chat.sessionId} /></WorkspaceRoot>);
  },
};
