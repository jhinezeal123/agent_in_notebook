// What every research screen sits in: OpenResearch's own workspace (its API
// client, query cache and live event stream), and a gate that waits for
// OpenResearch to be running.

import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { QueryEvents } from "@orx/queries/Events";
import { WorkspaceContext, type Workspace } from "@orx/workspace";
import type { ResearchStatus } from "@ainb/protocol";
import { hostRequest, onHostEvent } from "./tunnel.js";
import { Banner, Button, errorText } from "./ui.js";

export function WorkspaceRoot({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  return (
    <WorkspaceContext value={workspace}>
      <QueryClientProvider client={workspace.queryClient}>
        <QueryEvents />
        {children}
      </QueryClientProvider>
    </WorkspaceContext>
  );
}

export function useResearchStatus(): ResearchStatus | null {
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  useEffect(() => {
    let live = true;
    const off = onHostEvent("research.status", (s) => setStatus(s));
    hostRequest<ResearchStatus>("research.status").then((s) => { if (live) setStatus((old) => old ?? s); }, (e) => live && setStatus({ state: "error", error: errorText(e) }));
    return () => { live = false; off(); };
  }, []);
  return status;
}

/** Shows its children once OpenResearch runs; until then, what is wrong and how to fix it. */
export function ResearchGate({ children, compact }: { children: ReactNode; compact?: boolean }) {
  const status = useResearchStatus();
  const [busy, setBusy] = useState(false);
  if (status?.state === "ready") return <>{children}</>;
  const act = (method: string) => {
    setBusy(true);
    hostRequest(method).catch(() => {}).finally(() => setBusy(false));
  };
  if (!status || status.state === "starting" || status.state === "off") {
    return <div className={compact ? "gate compact" : "gate"}><span className="spinner" /> Starting OpenResearch…</div>;
  }
  return (
    <div className={compact ? "gate compact" : "gate"}>
      <Banner tone={status.state === "missing" ? "warn" : "error"}>
        <p>{status.state === "missing" ? "OpenResearch is needed for projects, experiments and research chats." : "OpenResearch could not start."}</p>
        <p className="muted pre">{status.error}</p>
      </Banner>
      <div className="row">
        <Button primary disabled={busy} onClick={() => act("research.chooseOrx")}>Choose the orx program…</Button>
        <Button disabled={busy} onClick={() => act("research.restart")}>Try again</Button>
      </div>
      <p className="muted small">Notebook chats on Colab, Kaggle and VS Code notebooks work without it.</p>
    </div>
  );
}
