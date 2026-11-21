// One experiment, as OpenResearch's own overview has it: description, latest
// run, run history, where it sits in the tree, and its git branch.

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { ancestorsOf, buildHistoryNodes, historyBackendLabel, type HistoryNode } from "@orx/components/experimentLineageModel";
import { runActive, runDisplay, runNotice, runResult } from "@orx/runDisplay";
import type { Run, TrackioMetric, TrackioRunMetrics } from "@orx/api";
import { renderMarkdown, splitMarkdownBlocks } from "../../ui/src/markdown.js";
import { hostRequest } from "./tunnel.js";
import { Banner, Button, Icon, RunBadge, StatusShape, ago, duration, errorText } from "./ui.js";

const CHART_COLORS = ["#4ea1ff", "#3fb950", "#f0883e", "#bc8cff", "#ff7b72", "#79c0ff"];

function Sparkline({ metric, width = 96, height = 24 }: { metric: TrackioMetric; width?: number; height?: number }) {
  const pts = metric.series.length ? metric.series : [metric.first, metric.last];
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.step);
  const ys = pts.map((p) => p.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const d = pts
    .map((p, i) => {
      const x = ((p.step - minX) / dx) * (width - 4) + 2;
      const y = height - 2 - ((p.value - minY) / dy) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MultiRunChart({
  seriesList,
  metricName,
}: {
  seriesList: { label: string; color: string; metric: TrackioMetric }[];
  metricName: string;
}) {
  const width = 560;
  const height = 180;
  const pad = { top: 12, right: 16, bottom: 24, left: 54 };
  const allPts = seriesList.flatMap((s) => (s.metric.series.length ? s.metric.series : [s.metric.first, s.metric.last]));
  if (allPts.length < 2) return null;
  const minX = Math.min(...allPts.map((p) => p.step));
  const maxX = Math.max(...allPts.map((p) => p.step));
  const minY = Math.min(...allPts.map((p) => p.value));
  const maxY = Math.max(...allPts.map((p) => p.value));
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;
  const px = (x: number) => pad.left + ((x - minX) / dx) * iw;
  const py = (y: number) => pad.top + ih - ((y - minY) / dy) * ih;
  const fmt = (n: number) => (Math.abs(n) >= 1000 || (Math.abs(n) > 0 && Math.abs(n) < 0.001) ? n.toExponential(2) : Number(n.toPrecision(4)).toString());

  return (
    <div className="metric-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="metric-svg" role="img" aria-label={`${metricName} over steps`}>
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + ih} stroke="currentColor" strokeOpacity="0.25" />
        <line x1={pad.left} y1={pad.top + ih} x2={pad.left + iw} y2={pad.top + ih} stroke="currentColor" strokeOpacity="0.25" />
        <text x={pad.left - 6} y={pad.top + 8} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.7">{fmt(maxY)}</text>
        <text x={pad.left - 6} y={pad.top + ih} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.7">{fmt(minY)}</text>
        <text x={pad.left} y={height - 6} textAnchor="start" fontSize="10" fill="currentColor" opacity="0.7">step {minX}</text>
        <text x={pad.left + iw} y={height - 6} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.7">step {maxX}</text>
        {seriesList.map((s) => {
          const pts = s.metric.series.length ? s.metric.series : [s.metric.first, s.metric.last];
          const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.step).toFixed(1)},${py(p.value).toFixed(1)}`).join(" ");
          return <path key={s.label} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />;
        })}
      </svg>
      <div className="metric-legend">
        {seriesList.map((s) => (
          <span key={s.label} className="metric-legend-item">
            <span className="metric-swatch" style={{ background: s.color }} />
            {s.label}: <b>{fmt(s.metric.last.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function fmtMetric(n: number): string {
  return Math.abs(n) >= 1000 || (Math.abs(n) > 0 && Math.abs(n) < 0.001) ? n.toExponential(3) : Number(n.toPrecision(4)).toString();
}

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
  const [selectedMetric, setSelectedMetric] = useState<string>("");
  const nodes = useMemo(() => (experiments.data ? buildHistoryNodes(experiments.data, runs.data ?? []) : []), [experiments.data, runs.data]);
  const node = nodes.find((n) => n.id === experimentId);
  const project = projects.data?.find((p) => p.id === projectId);
  const compareRuns = useMemo(() => {
    if (!node) return [] as { label: string; run: Run }[];
    const list: { label: string; run: Run }[] = [...node.runs]
      .reverse()
      .slice(0, 5)
      .map((r, i) => ({ label: `Run #${node.runs.length - i}`, run: r }));
    if (node.parent?.latestRun) {
      list.push({ label: `Parent (${node.parent.experiment.slug})`, run: node.parent.latestRun });
    }
    return list;
  }, [node]);
  const anyLive = compareRuns.some((c) => runActive(c.run.status));
  const trackioRuns = useQuery({ ...queries.getTrackioRunsQuery(projectId, anyLive), enabled: !!node });
  const metricQueries = useQueries({
    queries: compareRuns.map((c) => ({
      ...queries.getTrackioRunMetricsQuery(projectId, c.run.id, runActive(c.run.status)),
      enabled: !!node,
    })),
  });
  if (experiments.isError) return <div className="page"><Banner tone="error">{errorText(experiments.error)}</Banner></div>;
  if (!experiments.data) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!node) return <div className="page"><Banner tone="warn">This experiment no longer exists.</Banner></div>;
  const e = node.experiment;
  const run = node.latestRun;
  const result = run ? runResult(run) : null;
  const notice = run ? runNotice(run) : null;
  const waiting = run ? runDisplay(run).waiting ?? (notice?.kind === "queued" ? notice.detail : null) : null;
  const open = (id: string) => void hostRequest("open", { view: "experiment", projectId, experimentId: id });
  const step = (n: HistoryNode, current = false) => (
    <div key={n.id} className={`step${current ? " cur" : ""}`} onClick={current ? undefined : () => open(n.id)}>
      <StatusShape status={n.status} root={!n.parent} />{n.code && <code>{n.code}</code>}<span>{n.label}</span><small>{ago(n.createdAt)}</small>
    </div>
  );
  const ancestors = ancestorsOf(node);

  const metricsByRun = new Map<string, TrackioRunMetrics>();
  compareRuns.forEach((c, idx) => {
    const data = metricQueries[idx]?.data;
    if (data) metricsByRun.set(c.run.id, data);
  });
  const latestMetrics = run ? (metricsByRun.get(run.id)?.metrics ?? []) : [];
  const metricNames = Array.from(new Set([...metricsByRun.values()].flatMap((m) => m.metrics.map((x) => x.name))));
  const activeMetricName = (selectedMetric && metricNames.includes(selectedMetric)) ? selectedMetric : (metricNames.find((n) => /loss|val|acc|score/i.test(n)) ?? metricNames[0] ?? "");
  const chartSeries = activeMetricName
    ? compareRuns
        .map((c, idx) => {
          const metric = metricsByRun.get(c.run.id)?.metrics.find((m) => m.name === activeMetricName);
          return metric ? { label: c.label, color: CHART_COLORS[idx % CHART_COLORS.length]!, metric } : null;
        })
        .filter((x): x is { label: string; color: string; metric: TrackioMetric } => !!x)
    : [];
  const trackioUrl = trackioRuns.data?.dashboardUrl
    ? `${trackioRuns.data.dashboardUrl}${trackioRuns.data.dashboardSign ? `${trackioRuns.data.dashboardUrl.includes("?") ? "&" : "?"}__sign=${encodeURIComponent(trackioRuns.data.dashboardSign)}` : ""}`
    : null;

  return (
    <div className="page wide">
      <header className="ov-head">
        <div><h1>{node.code ? `${node.code}: ${node.label}` : node.label}</h1><span className="muted mono">{e.slug}</span></div>
        <RunBadge run={run} />
      </header>
      <div className="row">
        <Button disabled={!run} onClick={() => run && void hostRequest("logs.show", { runId: run.id, title: e.slug })}><Icon name="terminal" /> Logs</Button>
        <Button disabled={!project} onClick={() => project && void hostRequest("folder.reveal", { path: project.repoPath })}><Icon name="code" /> Code</Button>
        {trackioUrl && <Button onClick={() => void hostRequest("link.open", { url: trackioUrl })}>Open Trackio ↗</Button>}
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
            {waiting && <p className="muted small" role="status">{waiting}</p>}
            {run.command && <pre className="cmd">$ {run.command}</pre>}
            {result && <Markdown text={result} className={run.status === "failed" ? "err-text" : ""} />}
          </>
        ) : <p className="muted">Not run yet.</p>}
      </section>
      <section className="sec bt">
        <div className="sec-head">
          <h2>Metrics (Trackio)</h2>
          {metricNames.length > 1 && (
            <select className="inp small-select" value={activeMetricName} onChange={(ev) => setSelectedMetric(ev.target.value)}>
              {metricNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
        </div>
        {latestMetrics.length > 0 ? (
          <div className="metric-cards">
            {latestMetrics.map((m) => {
              const delta = m.last.value - m.first.value;
              return (
                <div key={m.name} className="metric-card">
                  <div className="metric-name">{m.name}</div>
                  <div className="metric-val">{fmtMetric(m.last.value)}</div>
                  <div className="metric-sub muted small">
                    {fmtMetric(m.first.value)} → {fmtMetric(m.last.value)} ({delta >= 0 ? "+" : ""}{fmtMetric(delta)})
                  </div>
                  <Sparkline metric={m} />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted small">No Trackio metrics logged for this run yet.</p>
        )}
        {chartSeries.length > 0 && <MultiRunChart seriesList={chartSeries} metricName={activeMetricName} />}
        {compareRuns.length > 1 && activeMetricName && (
          <div className="rtable-wrap" style={{ marginTop: "10px" }}>
            <table className="rtable">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>{activeMetricName} (first → last)</th>
                  <th>Δ vs baseline</th>
                  <th>Duration</th>
                  <th>Backend</th>
                  <th>Commit</th>
                </tr>
              </thead>
              <tbody>
                {compareRuns.map((c, idx) => {
                  const m = metricsByRun.get(c.run.id)?.metrics.find((x) => x.name === activeMetricName);
                  const baseRun = compareRuns[idx + 1] ?? compareRuns.at(-1);
                  const baseM = baseRun && baseRun.run.id !== c.run.id ? metricsByRun.get(baseRun.run.id)?.metrics.find((x) => x.name === activeMetricName) : undefined;
                  const diff = m && baseM ? m.last.value - baseM.last.value : null;
                  return (
                    <tr key={c.run.id}>
                      <td>{c.label}</td>
                      <td><RunBadge run={c.run} /></td>
                      <td className="mono">{m ? `${fmtMetric(m.first.value)} → ${fmtMetric(m.last.value)}` : "—"}</td>
                      <td className="mono">{diff !== null ? `${diff >= 0 ? "+" : ""}${fmtMetric(diff)}` : "—"}</td>
                      <td className="mono">{c.run.startedAt ? duration(c.run.startedAt, c.run.endedAt) : "—"}</td>
                      <td>{historyBackendLabel(c.run)}</td>
                      <td className="mono">{c.run.commitSha ? c.run.commitSha.slice(0, 7) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
