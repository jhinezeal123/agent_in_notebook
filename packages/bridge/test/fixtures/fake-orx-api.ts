// Stands in for an OpenResearch already running (`orx up`) with the parts of
// its HTTP API notebook chats use: projects, experiments, runs, files,
// artifacts, papers, research chats (with their worktrees, made when the
// session's terminal opens) and the event stream.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";

export interface FakeSession {
  id: string;
  projectId: string;
  messages: string[];
  title?: string;
  archived?: boolean;
  /** Its worktree's folder, once its terminal was opened. */
  worktree?: string;
}

export interface FakeProject {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  path: string;
  artifactsDir: string;
  githubUrl: string | null;
  paperId: string | null;
  createdAt: number;
  updatedAt: number;
}

export class FakeOrx {
  server!: Server;
  port = 0;
  readonly root = mkdtempSync(join(tmpdir(), "fake-orx-"));
  projects = new Map<string, FakeProject>();
  /** Code by project id, then path. */
  code = new Map<string, Map<string, string>>();
  experiments: Record<string, unknown>[] = [];
  runs: Record<string, unknown>[] = [];
  logs = new Map<string, string>();
  createdProjects: Record<string, unknown>[] = [];
  sessions: FakeSession[] = [];
  requests: string[] = [];
  /** Projects that are not git repositories: no worktree can be made. */
  noGit = new Set<string>();
  /** Projects that are real git repositories (worktrees are git worktrees). */
  gitProjects = new Set<string>();
  /** Their "GitHub" repositories (bare), by project id. */
  remotes = new Map<string, string>();
  /** Terminal connections refused for a wrong origin. */
  refusedTerminals = 0;
  private sockets = new WebSocketServer({ noServer: true });
  private streams = new Set<ServerResponse>();
  private nextId = 1;

  async start(): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = /^\/api\/projects\/([^/]+)\/terminal$/.exec(url.pathname);
      const host = req.headers.host;
      if (!m || req.headers.origin !== `http://${host}`) {
        this.refusedTerminals++;
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        const project = this.projects.get(decodeURIComponent(m[1]!));
        const session = this.sessions.find((s) => s.id === url.searchParams.get("sessionId"));
        if (!project || !session) {
          ws.send(JSON.stringify({ type: "error", error: "chat session not found" }));
          ws.close();
          return;
        }
        // Like OpenResearch: a worktree that cannot be made falls back to the clone, silently.
        if (!session.worktree && this.gitProjects.has(project.id)) {
          const dir = join(this.root, "worktrees", project.slug, session.id);
          execFileSync("git", ["-C", project.repoPath, "worktree", "add", "-q", "--detach", dir, "HEAD"], { stdio: "pipe" });
          session.worktree = dir;
        } else if (!session.worktree && !this.noGit.has(project.id)) {
          const dir = join(this.root, "worktrees", project.slug, session.id);
          for (const [path, content] of this.code.get(project.id)!) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), content);
          }
          mkdirSync(dir, { recursive: true });
          session.worktree = dir;
        }
        ws.send("PS> ");
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async close(): Promise<void> {
    for (const s of this.streams) s.destroy();
    for (const c of this.sockets.clients) c.terminate();
    for (let i = 0; i < this.remotes.size; i++) {
      delete process.env[`GIT_CONFIG_KEY_${i}`];
      delete process.env[`GIT_CONFIG_VALUE_${i}`];
    }
    delete process.env.GIT_CONFIG_COUNT;
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /**
   * `git`: the project is a real git repository (its code committed on main),
   * whose GitHub repository (githubUrl, https://github.com/test/<slug>) is a
   * bare repository next to it: git on this computer is told so
   * (url.<path>.insteadOf, through the environment). Session worktrees are
   * real git worktrees.
   */
  addProject(name: string, opts: { code?: Record<string, string>; githubUrl?: string; git?: boolean } = {}): FakeProject {
    const id = `proj_${this.nextId++}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const repoPath = join(this.root, "repos", slug);
    const artifactsDir = join(this.root, "files", slug);
    mkdirSync(repoPath, { recursive: true });
    const p: FakeProject = { id, name, slug, repoPath, path: repoPath, artifactsDir, githubUrl: opts.githubUrl ?? null, paperId: null, createdAt: Date.now(), updatedAt: Date.now() };
    this.projects.set(id, p);
    this.code.set(id, new Map(Object.entries(opts.code ?? {})));
    if (opts.git) {
      const remote = join(this.root, "github", `${slug}.git`);
      const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
      mkdirSync(remote, { recursive: true });
      g(remote, "init", "-q", "--bare", "-b", "main");
      g(repoPath, "init", "-q", "-b", "main");
      g(repoPath, "config", "user.name", "Test");
      g(repoPath, "config", "user.email", "test@example.com");
      for (const [path, content] of Object.entries(opts.code ?? {})) {
        mkdirSync(dirname(join(repoPath, path)), { recursive: true });
        writeFileSync(join(repoPath, path), content);
      }
      g(repoPath, "add", "-A");
      g(repoPath, "commit", "-q", "--allow-empty", "-m", "base");
      g(repoPath, "remote", "add", "origin", remote);
      g(repoPath, "push", "-q", "origin", "main");
      p.githubUrl = `https://github.com/test/${slug}`;
      this.remotes.set(id, remote);
      this.gitProjects.add(id);
      const rules = [...this.remotes.entries()];
      process.env.GIT_CONFIG_COUNT = String(rules.length);
      rules.forEach(([pid, path], i) => {
        process.env[`GIT_CONFIG_KEY_${i}`] = `url.${path}.insteadOf`;
        process.env[`GIT_CONFIG_VALUE_${i}`] = `${this.projects.get(pid)!.githubUrl}.git`;
      });
    }
    return p;
  }

  emit(event: string, data: unknown): void {
    for (const s of this.streams) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    this.requests.push(`${req.method} ${path}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    };
    if (path === "/api/health") return send(200, { ok: true, version: "9.9.9-fake" });
    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hello\n\n");
      this.streams.add(res);
      res.on("close", () => this.streams.delete(res));
      return;
    }
    if (path === "/api/projects" && req.method === "GET") return send(200, { projects: [...this.projects.values()] });
    if (path === "/api/projects" && req.method === "POST") {
      const b = await body();
      this.createdProjects.push(b);
      if (!b.name) return send(400, { error: "name is required" });
      const p = this.addProject(b.name);
      p.repoPath = p.path = b.path;
      return send(200, { project: p, githubPublicationError: null });
    }
    if (path === "/api/papers/search") return send(200, { papers: [{ paperId: "2401.00001", title: `A paper about ${url.searchParams.get("q")}`, snippet: "We study things." }] });
    if (path === "/api/chat/sessions" && req.method === "POST") {
      const b = await body();
      if (!this.projects.has(b.projectId)) return send(404, { error: "project not found" });
      const s: FakeSession = { id: `chat_${this.nextId++}`, projectId: b.projectId, messages: [] };
      this.sessions.push(s);
      return send(200, { session: { id: s.id, projectId: s.projectId } });
    }
    let m = /^\/api\/chat\/sessions\/([^/]+)(\/worktree)?$/.exec(path);
    if (m) {
      const s = this.sessions.find((x) => x.id === m![1]);
      if (!s) return send(404, { error: "chat session not found" });
      if (req.method === "PATCH") {
        const b = await body();
        if (typeof b.title === "string") s.title = b.title;
        else if (typeof b.archived === "boolean") s.archived = b.archived;
        return send(200, { session: s });
      }
      if (!m[2]) return send(200, { session: s });
      if (!s.worktree) return send(200, { exists: false });
      const code = this.code.get(s.projectId)!;
      const files: { path: string; status: string }[] = [];
      const here = new Set(listFiles(s.worktree, ""));
      for (const f of here) if (!code.has(f)) files.push({ path: f, status: "added" });
      else if (readFileSync(join(s.worktree, f), "utf8") !== code.get(f)) files.push({ path: f, status: "modified" });
      for (const f of code.keys()) if (!here.has(f)) files.push({ path: f, status: "deleted" });
      return send(200, { exists: true, branch: null, baselineBranch: "main", baseSha: "abc123", files, diff: {} });
    }
    m = /^\/api\/chat\/sessions\/([^/]+)\/message$/.exec(path);
    if (m && req.method === "POST") {
      const s = this.sessions.find((x) => x.id === m![1]);
      if (!s) return send(404, { error: "chat session not found" });
      s.messages.push((await body()).text);
      return send(200, { ok: true, turn: { turnId: "t1", queued: false, existing: false } });
    }
    m = /^\/api\/runs\/([^/]+)(\/logs)?$/.exec(path);
    if (m) {
      const run = this.runs.find((r) => r.id === m![1]);
      if (!run) return send(404, { error: "run not found" });
      if (!m[2]) return send(200, { run });
      const log = Buffer.from(this.logs.get(run.id as string) ?? "");
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const data = log.subarray(cursor, cursor + 256 * 1024);
      return send(200, { generation: "g1", offset: cursor, dataBase64: data.toString("base64"), nextCursor: cursor + data.length, eof: cursor + data.length >= log.length });
    }
    m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return send(404, { error: "not found" });
    const project = this.projects.get(decodeURIComponent(m[1]!));
    if (!project) return send(404, { error: "project not found" });
    const code = this.code.get(project.id)!;
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? this.sessions.find((s) => s.id === sessionId && s.projectId === project.id) : undefined;
    if (sessionId && !session) return send(404, { error: "chat session not found" });
    // A session with a worktree reads its files from there.
    const wt = session?.worktree;
    const read = (p: string): string | undefined => (wt ? (existsSync(join(wt, p)) && statSync(join(wt, p)).isFile() ? readFileSync(join(wt, p), "utf8") : undefined) : code.get(p));
    switch (m[2] ?? "") {
      case "":
        return send(200, { project });
      case "/experiments":
        return send(200, { experiments: this.experiments.filter((e) => e.projectId === project.id) });
      case "/runs":
        return send(200, { runs: this.runs.filter((r) => r.projectId === project.id) });
      case "/files":
        mkdirSync(project.artifactsDir, { recursive: true });
        return send(200, { dir: project.artifactsDir, entries: listDir(project.artifactsDir, ""), truncated: false });
      case "/code-tree":
        return wt
          ? send(200, { root: "worktree", path: wt, branch: this.gitProjects.has(project.id) ? execFileSync("git", ["-C", wt, "branch", "--show-current"]).toString().trim() || null : null, entries: listFiles(wt, "").sort(), truncated: false })
          : send(200, { root: "clone", path: project.repoPath, branch: "main", entries: [...code.keys()].sort(), truncated: false });
      case "/file": {
        const p = url.searchParams.get("path") ?? "";
        const content = read(p);
        return send(200, { path: p, content: content ?? "", truncated: false, binary: false, notFound: content === undefined, root: "clone", presentation: "text", version: null });
      }
      case "/file/raw": {
        const content = read(url.searchParams.get("path") ?? "");
        if (content === undefined) return send(404, { error: "file not found" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": Buffer.byteLength(content) });
        res.end(content);
        return;
      }
    }
    return send(404, { error: "not found" });
  }
}

function listDir(dir: string, rel: string): unknown[] {
  return readdirSync(dir).map((name) => {
    const full = join(dir, name);
    const path = rel ? `${rel}/${name}` : name;
    const st = statSync(full);
    return st.isDirectory()
      ? { name, path, isDir: true, size: 0, modifiedAt: st.mtimeMs, children: listDir(full, path) }
      : { name, path, isDir: false, size: st.size, modifiedAt: st.mtimeMs };
  });
}

function listFiles(dir: string, rel: string): string[] {
  return readdirSync(dir).filter((name) => name !== ".git").flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name;
    return statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), path) : [path];
  });
}

export const readText = (file: string) => readFileSync(file, "utf8");
