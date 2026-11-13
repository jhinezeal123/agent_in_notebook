// One experiment, as OpenResearch's own overview has it: description, latest
// run, run history, where it sits in the tree, and its git branch.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { ancestorsOf, buildHistoryNodes, historyBackendLabel, type HistoryNode } from "@orx/components/experimentLineageModel";
import { runActive, runResult } from "@orx/runDisplay";
import { renderMarkdown, splitMarkdownBlocks } from "../../ui/src/markdown.js";
import { hostRequest } from "./tunnel.js";
import { Banner, Button, Icon, RunBadge, StatusShape, ago, duration, errorText } from "./ui.js";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => splitMarkdownBlocks(text).map((b) => renderMarkdown(b)).join(""), [text]);
  return <div className={`md${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ExperimentView({ projectId, experimentId }: { projectId: string; experimentId: string }) {
  const { queries, api } = useWorkspace();
  const experiments = useQuery(queries.listExperimentsQuery(projectId));
  const runs = useQuery(queries.listRunsQuery(projectId));
  const projects = useQuery(queries.listProjectsQuery());
  const [error, setError] = useState<string | null>(null);
  const nodes = useMemo(() => (experiments.data ? buildHistoryNodes(experiments.data, runs.data ?? []) : []), [experiments.data, runs.data]);
  const node = nodes.find((n) => n.id === experimentId);
  const project = projects.data?.find((p) => p.id === projectId);
  if (experiments.isError) return <div className="page"><Banner tone="error">{errorText(experiments.error)}</Banner></div>;
  if (!experiments.data) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!node) return <div className="page"><Banner tone="warn">This experiment no longer exists.</Banner></div>;
  const e = node.experiment;
  const run = node.latestRun;
  const result = run ? runResult(run) : null;
  const open = (id: string) => void hostRequest("open", { view: "experiment", projectId, experimentId: id });
  const step = (n: HistoryNode, current = false) => (
    <div key={n.id} className={`step${current ? " cur" : ""}`} onClick={current ? undefined : () => open(n.id)}>
      <StatusShape status={n.status} root={!n.parent} />{n.code && <code>{n.code}</code>}<span>{n.label}</span><small>{ago(n.createdAt)}</small>
    </div>
  );
  const ancestors = ancestorsOf(node);

  return (
    <div className="page wide">
      <header className="ov-head">
        <div><h1>{node.code ? `${node.code}: ${node.label}` : node.label}</h1><span className="muted mono">{e.slug}</span></div>
        <RunBadge run={run} />
      </header>
      <div className="row">
        <Button disabled={!run} onClick={() => run && void hostRequest("logs.show", { runId: run.id, title: e.slug })}><Icon name="terminal" /> Logs</Button>
        <Button disabled={!project} onClick={() => project && void hostRequest("folder.reveal", { path: project.repoPath })}><Icon name="code" /> Code</Button>
        {run && runActive(run.status) && <Button onClick={() => void api.cancelRun(run.id).catch((x) => setError(errorText(x)))}><Icon name="stop" /> Stop run</Button>}
        <span className="spacer" />
        {e.chatSessionId && <Button primary onClick={() => void hostRequest("chat.select", { kind: "research", projectId, sessionId: e.chatSessionId })}><Icon name="comment" /> Open chat</Button>}
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {e.description && <section className="sec bt"><h2>Description</h2><Markdown text={e.description} /></section>}
      <section className="sec bt">
        <h2>Latest run</h2>
        {run ? (
          <>
            <div className="meta">
              <RunBadge run={run} />
              <span className="bk">{historyBackendLabel(run)}</span>
              <span><Icon name="clock" /> {ago(run.startedAt ?? run.createdAt)}</span>
              {run.startedAt && <span>{duration(run.startedAt, run.endedAt)}</span>}
              {run.commitSha && <span className="mono">{run.commitSha.slice(0, 7)}</span>}
              {run.exitCode !== null && run.exitCode !== undefined && <span className={run.exitCode ? "err-text" : ""}>exit {run.exitCode}</span>}
            </div>
            {run.command && <pre className="cmd">$ {run.command}</pre>}
            {result && <Markdown text={result} className={run.status === "failed" ? "err-text" : ""} />}
          </>
        ) : <p className="muted">Not run yet.</p>}
      </section>
      {node.runs.length > 1 && (
        <section className="sec bt">
          <h2>Run history</h2>
          <div className="hist">
            {[...node.runs].reverse().map((r, i) => (
              <div key={r.id}><span>Run {node.runs.length - i}</span><RunBadge run={r} /><span className="muted">{ago(r.startedAt ?? r.createdAt)}</span><span className="mono muted">{duration(r.startedAt, r.endedAt)}</span>
                <span className="end"><Button small onClick={() => void hostRequest("logs.show", { runId: r.id, title: `${e.slug} #${node.runs.length - i}` })}><Icon name="terminal" /></Button></span></div>
            ))}
          </div>
        </section>
      )}
      <section className="sec bt">
        <h2>Lineage</h2>
        <div className="lin">
          {!!ancestors.length && <><span className="muted small">Ancestors</span>{ancestors.map((a) => step(a))}</>}
          {step(node, true)}
          {!!node.children.length && <><span className="muted small">Children</span>{node.children.map((c) => step(c))}</>}
        </div>
      </section>
      <section className="sec bt">
        <h2>Git</h2>
        <div className="meta"><span className="bpill"><Icon name="branch" /> {e.branchName}</span>{node.parent && <span>from <code>{node.parent.experiment.slug}</code></span>}<span>created {ago(e.createdAt)}</span></div>
        {e.runCommand && <pre className="cmd">$ {e.runCommand}</pre>}
      </section>
    </div>
  );
}
