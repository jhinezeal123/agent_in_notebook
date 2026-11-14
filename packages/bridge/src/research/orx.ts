// OpenResearch (`orx`) for the editor: the bridge runs `orx up` hidden, so
// VS Code can show OpenResearch's own web app (projects, papers, experiment
// trees, background runs, its research chats) in its tabs. Nothing of
// OpenResearch is copied here: updating orx updates what VS Code shows.
//
// When an OpenResearch is already running (its desktop app, or `orx up` in a
// terminal) the bridge uses that one: two of them cannot share one database.
// The bridge holds OpenResearch's event stream open, which also keeps a hidden
// `orx up` from stopping itself when idle, and passes run changes on.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { get, type ClientRequest } from "node:http";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { FINAL_RUN_STATUSES, type ResearchRun, type ResearchStatus, type RunStatus } from "@ainb/protocol";
import { which } from "../agents/registry.js";
import { loadResearchConfig } from "../config.js";

/** How to run orx: its path, and (for tests) a command and leading arguments standing in for it. */
export interface OrxLaunch {
  path: string;
  command: string;
  args: string[];
  /** Added to the environment of `orx up` (research.json `env`). */
  env?: Record<string, string>;
}

export interface OrxOptions {
  log: (msg: string) => void;
  onStatus: (status: ResearchStatus) => void;
  onRun: (run: ResearchRun) => void;
  /**
   * Something of a project changed (its record, an experiment, a run, its
   * artifacts); undefined: anything may have (the event stream reconnected).
   */
  onProjectChange?: (projectId: string | undefined) => void;
  /** Find orx (default: research.json, AINB_ORX, PATH, the usual install places). */
  locate?: () => OrxLaunch | { missing: string };
  /** Ports where an OpenResearch already running may answer (default: its default port). */
  knownPorts?: number[];
  /** Longest wait for `orx up` to come up. */
  startTimeoutMs?: number;
}

export const ORX_DEFAULT_PORT = 4791;
const READY_LINE = /dashboard on (http:\/\/127\.0\.0\.1:\d+)/;
const STDERR_KEEP = 4000;

export class Orx {
  status: ResearchStatus = { state: "off" };
  private child?: ChildProcess;
  private events?: ClientRequest;
  private starting?: Promise<ResearchStatus>;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** Bumped by every stop, so a stale start or event stream gives up. */
  private generation = 0;

  constructor(private readonly opts: OrxOptions) {}

  /** Start OpenResearch (or join a running one). Safe to call repeatedly. */
  start(): Promise<ResearchStatus> {
    if (this.status.state === "ready") return Promise.resolve(this.status);
    this.starting ??= this.doStart().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Stop what the bridge started, and look for orx afresh on the next start. */
  async restart(): Promise<ResearchStatus> {
    this.stop();
    this.setStatus({ state: "off" });
    return this.start();
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private stop(): void {
    this.generation++;
    clearTimeout(this.retry);
    this.events?.destroy();
    this.events = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill();
  }

  private setStatus(status: ResearchStatus): void {
    this.status = status;
    this.opts.onStatus(status);
  }

  private async doStart(): Promise<ResearchStatus> {
    if (this.closed) return this.status;
    const generation = this.generation;
    const launch = (this.opts.locate ?? locateOrx)();
    const orxPath = "path" in launch ? launch.path : undefined;
    // An OpenResearch already running owns the database: use it.
    for (const port of this.opts.knownPorts ?? [ORX_DEFAULT_PORT]) {
      const url = `http://127.0.0.1:${port}`;
      const health = await getJson(`${url}/api/health`, 1500).catch(() => null) as { ok?: boolean; version?: string } | null;
      if (generation !== this.generation) return this.status;
      if (health?.ok) {
        this.opts.log(`Using the OpenResearch already running at ${url}.`);
        return this.ready({ state: "ready", url, version: health.version, owned: false, orxPath }, generation);
      }
    }
    if ("missing" in launch) {
      this.setStatus({ state: "missing", error: launch.missing });
      return this.status;
    }
    this.setStatus({ state: "starting", orxPath });
    let stderr = "";
    const child = spawn(launch.command, [...launch.args, "up", "--headless", "--port", "0"], {
      env: orxEnv(launch),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`OpenResearch did not start within ${Math.round((this.opts.startTimeoutMs ?? 90_000) / 1000)} s.`)), this.opts.startTimeoutMs ?? 90_000);
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (d: string) => {
          stderr = (stderr + d).slice(-STDERR_KEEP);
          const m = READY_LINE.exec(stderr);
          if (m) { clearTimeout(timer); resolve(m[1]!); }
        });
        child.once("error", (e) => { clearTimeout(timer); reject(new Error(`Could not start ${launch.path}: ${e.message}`)); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(exitMessage(code, stderr))); });
      });
      if (generation !== this.generation) return this.status;
      child.on("exit", (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.generation++;
        this.events?.destroy();
        this.opts.log(`OpenResearch stopped (code ${code}).`);
        this.setStatus({ state: "off", orxPath, error: code ? exitMessage(code, stderr) : undefined });
      });
      const health = await getJson(`${url}/api/health`, 5000).catch(() => null) as { version?: string } | null;
      this.opts.log(`OpenResearch is running at ${url}.`);
      return this.ready({ state: "ready", url, version: health?.version, owned: true, orxPath }, generation);
    } catch (e) {
      if (this.child === child) this.child = undefined;
      if (child.exitCode === null) child.kill();
      if (generation !== this.generation) return this.status;
      this.setStatus({ state: "error", orxPath, error: (e as Error).message });
      return this.status;
    }
  }

  private ready(status: ResearchStatus, generation: number): ResearchStatus {
    this.setStatus(status);
    this.follow(status.url!, generation);
    return status;
  }

  /** Read OpenResearch's event stream: run changes go on to the editor. */
  private follow(url: string, generation: number): void {
    if (generation !== this.generation || this.closed) return;
    const lost = () => {
      if (generation !== this.generation || this.closed) return;
      this.events = undefined;
      // Ours stopped (its exit handler says so), or one we joined went away, or the stream dropped.
      void getJson(`${url}/api/health`, 1500).then(
        () => { this.retry = setTimeout(() => this.follow(url, generation), 2000); },
        () => {
          if (generation !== this.generation) return;
          this.generation++;
          if (!this.status.owned) this.setStatus({ state: "off", orxPath: this.status.orxPath });
        },
      );
    };
    const req = get(`${url}/api/events`, { headers: { accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); lost(); return; }
      // Events missed while the stream was down are not replayed.
      this.opts.onProjectChange?.(undefined);
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk.replace(/\r\n/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          this.onEvent(block);
        }
      });
      res.on("end", lost);
      res.on("error", lost);
    });
    req.on("error", lost);
    this.events = req;
  }

  private onEvent(block: string): void {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    let body: Record<string, any>;
    try {
      body = JSON.parse(data.join("\n"));
    } catch {
      return; // not JSON: skip
    }
    const changed = (id: unknown) => this.opts.onProjectChange?.(typeof id === "string" ? id : undefined);
    switch (type) {
      case "run.updated": {
        const run = toRun(body?.run);
        if (run) this.opts.onRun(run);
        changed(body?.run?.projectId);
        return;
      }
      case "project.updated": changed(body?.project?.id); return;
      case "experiment.updated": changed(body?.experiment?.projectId); return;
      case "files.updated": changed(body?.projectId); return;
      case "resync.required": this.opts.onProjectChange?.(undefined); return;
    }
  }
}

const STATUSES = new Set<RunStatus>(["starting", "running", ...FINAL_RUN_STATUSES]);

export function toRun(raw: unknown): ResearchRun | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string" || typeof r.experimentId !== "string" || typeof r.projectId !== "string") return null;
  if (!STATUSES.has(r.status as RunStatus)) return null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    id: r.id,
    experimentId: r.experimentId,
    projectId: r.projectId,
    status: r.status as RunStatus,
    backend: typeof r.backend === "string" ? r.backend : null,
    startedAt: num(r.startedAt),
    endedAt: num(r.endedAt),
    exitCode: num(r.exitCode),
    ...(typeof r.queueDetail === "string" && r.queueDetail ? { queueDetail: r.queueDetail } : {}),
  };
}

function exitMessage(code: number | null, stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-6).join("\n");
  if (/already using this database/i.test(stderr)) {
    return "Another OpenResearch is already running on this computer but does not answer on its usual port. Close it, or start it with `orx up`, then try again.";
  }
  return `OpenResearch exited (code ${code}).${tail ? `\n${tail}` : ""}`;
}

/**
 * The environment of `orx up`: the bridge's, then research.json `env`, with
 * orx's own folder first on PATH (so what it starts finds the same orx).
 */
export function orxEnv(launch: OrxLaunch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
  // Windows names it Path; keep whichever key is there.
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  if (isAbsolute(launch.path)) env[key] = [dirname(launch.path), env[key]].filter(Boolean).join(delimiter);
  return env;
}

/** Find orx: research.json, AINB_ORX, PATH, then where its installers put it. */
export function locateOrx(): OrxLaunch | { missing: string } {
  const cfg = loadResearchConfig();
  const configured = cfg.orxPath ?? process.env.AINB_ORX;
  if (configured) {
    return existsSync(configured)
      ? { path: configured, command: configured, args: [], env: cfg.env }
      : { missing: `The orx program set for Agent in Notebook is not at ${configured}. Choose it again.` };
  }
  const exe = process.platform === "win32" ? "orx.exe" : "orx";
  const found = which("orx") ?? [join(homedir(), ".cargo", "bin", exe), join(homedir(), ".local", "bin", exe), join(homedir(), ".openresearch", "bin", exe)].find((p) => existsSync(p));
  return found
    ? { path: found, command: found, args: [], env: cfg.env }
    : { missing: "OpenResearch (orx) is not installed, or not on PATH. Install it, or choose the orx program you built." };
}

function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { body += d; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}
