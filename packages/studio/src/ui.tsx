// Small building blocks in VS Code's look (its theme colors come in as CSS
// variables), and the experiment status marks OpenResearch uses.

import type { ComponentProps, ReactNode } from "react";
import type { HistoryStatus } from "@orx/components/experimentLineageModel";
import { runDisplay, type RunDisplayStatus } from "@orx/runDisplay";
import type { Run } from "@orx/api";

const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8",
  "chev-r": "M9 6l6 6-6 6",
  "chev-d": "M6 9l6 6 6-6",
  close: "M6 6l12 12M18 6 6 18",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  flask: "M9.5 3h5M10.5 3v6L5 18.5A1.7 1.7 0 0 0 6.5 21h11a1.7 1.7 0 0 0 1.5-2.5L13.5 9V3M7.5 15h9",
  notebook: "M6 3h12v18H6zM6 7H4M6 12H4M6 17H4M10 8h5M10 12h5",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  comment: "M4 5h16v11H9l-5 4z",
  refresh: "M20 11a8 8 0 0 0-14.3-4M4 13a8 8 0 0 0 14.3 4M5 3v4h4M19 21v-4h-4",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  play: "M8 5l11 7-11 7z",
  stop: "M6 6h12v12H6z",
  code: "M9 7l-5 5 5 5M15 7l5 5-5 5",
  branch: "M7 4v12M7 16a2 2 0 1 0 0 .01M17 8a2 2 0 1 0 0 .01M17 10c0 3-4 3-8.5 5",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  warning: "M12 4 21 20H3zM12 10v4M12 17h.01",
  check: "M5 12l4 4 10-10",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20",
  library: "M5 4v16M10 4v16M15 4l4 16",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  edit: "M4 20h4L19 9l-4-4L4 16z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  file: "M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5",
  power: "M12 3.5v8M7 6.5a7 7 0 1 0 10 0",
  swap: "M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4",
  plug:"M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21",
  send: "M12 19V5M6 11l6-6 6 6",
  sparkle: "M12 3.5l1.9 6.6 6.6 1.9-6.6 1.9L12 20.5l-1.9-6.6L3.5 12l6.6-1.9z",
};

export function Icon({ name, title }: { name: keyof typeof PATHS | string; title?: string }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  );
}

const STATUS_COLOR: Record<HistoryStatus, string> = {
  done: "var(--st-done)", failed: "var(--st-failed)", running: "var(--st-running)", cancelled: "var(--st-cancelled)", lost: "var(--st-muted)", none: "var(--st-muted)",
};

/** OpenResearch's marks: ● done, ◆ failed, ◐ running, ⊘ cancelled or lost, ○ not run. */
export function StatusShape({ status, root }: { status: HistoryStatus; root?: boolean }) {
  const c = STATUS_COLOR[status];
  return (
    <svg className={`shape${status === "running" ? " pulse" : ""}`} viewBox="0 0 14 14" aria-hidden="true">
      {root && <circle cx="7" cy="7" r="6.3" fill="none" stroke={c} strokeWidth="0.9" opacity="0.6" />}
      {status === "done" && <circle cx="7" cy="7" r="4" fill={c} />}
      {status === "failed" && <path d="M7 2.6 11.4 7 7 11.4 2.6 7z" fill={c} />}
      {status === "running" && <><circle cx="7" cy="7" r="3.6" fill="none" stroke={c} strokeWidth="1.5" /><path d="M7 3.4a3.6 3.6 0 0 1 0 7.2z" fill={c} /></>}
      {(status === "cancelled" || status === "lost") && <><circle cx="7" cy="7" r="3.6" fill="none" stroke={c} strokeWidth="1.4" /><path d="M4.6 9.4 9.4 4.6" stroke={c} strokeWidth="1.4" /></>}
      {status === "none" && <circle cx="7" cy="7" r="3.6" fill="none" stroke={c} strokeWidth="1.4" />}
    </svg>
  );
}

const DISPLAY_TONE: Partial<Record<RunDisplayStatus, string>> = {
  done: "done", failed: "failed", running: "running", submitting: "running", starting: "queued", queued: "queued",
  cancelling: "cancelled", cancelled: "cancelled", cancelled_unconfirmed: "cancelled", not_fully_stopped: "cancelled", unconfirmed: "cancelled",
  unreachable: "queued", needs_auth: "queued", cancellation_pending: "queued", lost: "muted", abandoned: "muted",
};

const DISPLAY_LABEL: Partial<Record<RunDisplayStatus, () => string>> = {
  done: () => "Done", failed: () => "Failed", running: () => "Running", submitting: () => "Submitting", starting: () => "Starting", queued: () => "Queued",
  cancelling: () => "Cancelling…", cancelled: () => "Cancelled", lost: () => "Outcome unavailable", abandoned: () => "Abandoned",
  unreachable: () => "Unreachable", needs_auth: () => "Authentication needed", cancellation_pending: () => "Cancellation pending",
  cancelled_unconfirmed: () => "Cancelled · couldn't confirm", not_fully_stopped: () => "Not fully stopped", unconfirmed: () => "Unconfirmed",
};

/** A run's state as OpenResearch words it, with a dot in its color. */
export function RunBadge({ run }: { run: Run | null }) {
  if (!run) return <span className="badge"><span className="dot" style={{ background: "var(--st-muted)" }} />Not run</span>;
  const d = runDisplay(run);
  const tone = DISPLAY_TONE[d.status] ?? "muted";
  const live = tone === "running" || tone === "queued";
  return (
    <span className="badge" title={d.stale && d.since ? `Last seen ${new Date(d.since).toLocaleString()}` : undefined}>
      <span className={`dot${live ? " pulse" : ""}${d.stale ? " hollow" : ""}`} style={{ background: `var(--st-${tone})`, borderColor: `var(--st-${tone})` }} />
      {(DISPLAY_LABEL[d.status] ?? (() => d.status))()}
    </span>
  );
}

export function Button({ children, primary, small, className, ...rest }: { children: ReactNode; primary?: boolean; small?: boolean } & Omit<ComponentProps<"button">, "children">) {
  return <button type="button" {...rest} className={`btn${primary ? " primary" : ""}${small ? " small" : ""}${className ? ` ${className}` : ""}`}>{children}</button>;
}

export function IconButton({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: (e: MouseEvent) => void; disabled?: boolean }) {
  return <button className="ib" title={title} aria-label={title} disabled={disabled} type="button" onClick={(e) => { e.stopPropagation(); onClick(e.nativeEvent); }}><Icon name={icon} /></button>;
}

export function Banner({ tone, children }: { tone: "info" | "warn" | "error"; children: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "error" ? "alert" : undefined}><Icon name={tone === "info" ? "info" : "warning"} /><div>{children}</div></div>;
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(from: number | null | undefined, to: number | null | undefined): string {
  if (!from) return "";
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
