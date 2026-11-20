// A research chat: one of OpenResearch's own chat sessions (its agent, its
// tools, its run notices), read and written through OpenResearch's chat logic
// and drawn in the chat panel's look. Chats it delegated to (sub-agents)
// show under the turn that started them, and what other chats sent it can be
// read in full; a click opens that chat here.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { activePath } from "@orx/transcriptTree";
import { fmtDuration, type ChatActiveRun, type ChatMessage, type ChatPart, type ChatSession, type EnvAnswer, type EnvRequestVar, type EnvScope, type Harness, type PromptAnswer } from "@orx/api";
import { runConnectHost, runDisplay } from "@orx/runDisplay";
import { statusLabel } from "@orx/components/StatusBadge";
import { useModelName } from "@orx/components/pickerAgents";
import { delegateLineage, delegateModelLabel, delegatesOf, delegateStatus, type DelegateStatus } from "@orx/delegates";
import { firstLine } from "@orx/agentMessages";
import { ltr } from "@orx/i18n";
import { m } from "@orx/paraglide/messages.js";
import { Markdown } from "./experiment.js";
import { ResearchGate } from "./root.js";
import { hostRequest } from "./tunnel.js";
import { Banner, Button, Icon, errorText } from "./ui.js";

export function ResearchChat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <ResearchGate compact><ChatInner key={sessionId} projectId={projectId} sessionId={sessionId} /></ResearchGate>;
}

type PromptReply = Omit<PromptAnswer, "promptId">;

/** The other chats of the project, by id, and opening one in the chat panel. */
interface ChatLinks {
  projectId: string;
  modelName: ReturnType<typeof useModelName>;
  chat(id: string): ChatSession | undefined;
  open(id: string): void;
}
const ChatLinksContext = createContext<ChatLinks | null>(null);

interface DelegateRow {
  session: ChatSession;
  status: DelegateStatus;
}

function ChatInner({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const workspace = useWorkspace();
  const { queries, api } = workspace;
  const [state, , history] = workspace.chat.useChatState(projectId, sessionId);
  const sessions = useQuery(queries.listChatSessionsQuery(projectId));
  const projects = useQuery(queries.listProjectsQuery());
  const harnesses = useQuery(queries.getHarnessesQuery());
  const session = sessions.data?.find((s: ChatSession) => s.id === sessionId);
  const project = projects.data?.find((p) => p.id === projectId);
  const harness = harnesses.data?.find((h: Harness) => h.id === session?.harness);
  const modelName = useModelName();
  const all = state.messagesBySession[sessionId] ?? [];
  const messages = useMemo(() => activePath(all, state.activeLeafBySession[sessionId]), [all, state.activeLeafBySession[sessionId]]);
  const busy = state.busySessions.has(sessionId) || !!session?.busy;
  const queued = state.queuedBySession[sessionId] ?? [];
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string } | null>(null);
  // The experiments this chat started that are still going, as OpenResearch's chat lists them above its input.
  const queryClient = useQueryClient();
  const activeRuns = useQuery(queries.listChatActiveRunsQuery());
  useEffect(() => workspace.events.onChatEvent((ev) => {
    if (ev.type === "runsChanged" || ev.type === "reconnected") void queryClient.invalidateQueries({ queryKey: queries.listChatActiveRunsQuery().queryKey });
  }), [workspace, queryClient]);
  const runs = (activeRuns.data ?? []).filter((r) => r.sessionId === sessionId);

  const allSessions = useMemo(() => sessions.data ?? [], [sessions.data]);
  const links = useMemo<ChatLinks>(() => ({
    projectId,
    modelName,
    chat: (id) => allSessions.find((s) => s.id === id),
    open: (id) => void hostRequest("chat.select", { kind: "research", projectId, sessionId: id }),
  }), [allSessions, projectId, modelName]);
  // Each delegate sits under the message that started it: the last one begun before it was.
  const delegatesByMessage = useMemo(() => {
    const out = new Map<string, DelegateRow[]>();
    for (const d of delegatesOf(allSessions, sessionId)) {
      const at = messages.filter((msg) => msg.createdAt <= d.createdAt).at(-1);
      if (!at) continue;
      out.set(at.id, [...(out.get(at.id) ?? []), { session: d, status: delegateStatus(d, allSessions) }]);
    }
    return out;
  }, [allSessions, sessionId, messages]);
  // Sub-agents, at any depth, that wait on the user: they stop until someone answers in their chat.
  const waiting = delegateLineage(allSessions, sessionId)
    .map(({ session: s }) => ({ session: s, status: delegateStatus(s, allSessions) }))
    .filter((d) => d.status === "asking" || d.status === "approval");
  const parent = session?.delegate ? links.chat(session.delegate.parentId) : undefined;

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });

  const send = async (text: string) => {
    setError(null);
    try {
      await api.sendChatMessage(sessionId, text, {}, undefined, undefined, crypto.randomUUID(), busy && harness?.supportsSteering ? "steer" : undefined);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const respond = (promptId: string, answer: PromptReply) =>
    void api.respondChat(sessionId, { promptId, ...answer }).catch((e) => setError(errorText(e)));

  return (
    <ChatLinksContext.Provider value={links}>
    <div className="rchat">
      {!messages.length && !history.isPending && !history.isError ? (
        <div className="welcome">
          <div className="welcome-mark"><Icon name="flask" /></div>
          <h2>{session?.title || "Research chat"}</h2>
          <p className="welcome-text">Ask the agent to reproduce a result, try an idea as a new experiment, or read a paper. Runs and results show in the experiment tree.</p>
          <div className="suggestions">
            {SUGGESTIONS.map((t) => <button type="button" key={t} className="suggestion" onClick={() => setDraft({ text: t })}><Icon name="sparkle" /> {t}</button>)}
          </div>
        </div>
      ) : (
        <div className="transcript" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {history.isError && <Banner tone="error">{errorText(history.error)}</Banner>}
          {messages.map((msg) => (
            <div key={msg.id} className="msg-row">
              <Message message={msg} onRespond={respond} />
              {delegatesByMessage.get(msg.id)?.map((d) => <DelegateCard key={d.session.id} row={d} onOpen={links.open} />)}
            </div>
          ))}
          {busy && <div className="working"><span className="spinner" /> Working…</div>}
          {!!queued.length && <div className="queued">{queued.length} message{queued.length > 1 ? "s" : ""} waiting for the agent</div>}
        </div>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {harness && !harness.agentReady && <Banner tone="warn">{harness.name} is not ready: {harness.agentNote ?? "set it up in Settings › Agents."}</Banner>}
      {!!waiting.length && (
        <div className="waitbar" role="status">
          {waiting.map((d) => (
            <div key={d.session.id} className="waitrow">
              <span className="ask">?</span>
              <span className="waitrow-text"><b>{d.session.title?.trim() || delegateModelLabel(d.session, modelName)}</b> {d.status === "asking" ? "needs an answer" : "needs your approval"}</span>
              <Button small onClick={() => links.open(d.session.id)}>Open</Button>
            </div>
          ))}
        </div>
      )}
      <RunBanner key={sessionId} runs={runs} />
      <Composer busy={busy} draft={draft} placeholder={`Message ${harness?.name ?? "the agent"}…`} onSend={send} onStop={() => void api.interruptChat(sessionId).catch((e) => setError(errorText(e)))}
        context={
          <div className="ctx-row">
            <span className="ctx-chip rs" title="This chat uses OpenResearch's tools: experiments, runs and papers"><Icon name="flask" /> Research</span>
            {project && <span className="ctx-chip" title={project.repoPath}><Icon name="folder" /><span className="ctx-name">{project.name}</span></span>}
            {session?.delegate && (
              <button type="button" className="ctx-chip link" disabled={!parent} title={parent ? "Open the chat that delegated this task" : undefined} onClick={() => parent && links.open(parent.id)}>
                <Icon name="branch" /><span className="ctx-name">Sub-agent of {parent?.title?.trim() || "another chat"}</span>
              </button>
            )}
          </div>
        }
        tools={<>
          {harness && <span className="tb-label" title="Change agents in Settings › Agents">{harness.name}</span>}
          {session?.model && <span className="tb-label">{session.model}</span>}
        </>} />
    </div>
    </ChatLinksContext.Provider>
  );
}

function Message({ message, onRespond }: { message: ChatMessage; onRespond: (promptId: string, answer: PromptReply) => void }) {
  if (message.role === "user") {
    const notice = message.parts.find((p) => p.orx);
    if (notice) return <OrxNotice part={notice} />;
    const text = message.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    return <div className="ub">{text}</div>;
  }
  return (
    <div className="am">
      {groupTools(message.parts).map((g, i) => Array.isArray(g)
        ? <ToolGroup key={i} parts={g} />
        : <Part key={g.id} part={g} onRespond={onRespond} />)}
    </div>
  );
}

/** Consecutive tool calls fold into one group, as OpenResearch shows them. */
function groupTools(parts: ChatPart[]): (ChatPart | ChatPart[])[] {
  const out: (ChatPart | ChatPart[])[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (p.type === "tool" && Array.isArray(last)) last.push(p);
    else out.push(p.type === "tool" ? [p] : p);
  }
  return out;
}

function toolLine(p: ChatPart): string {
  const input = p.state?.input ?? {};
  return p.state?.title ?? input.description ?? input.command ?? (input.commandArgv?.join(" ")) ?? input.filePath ?? p.tool ?? "Tool";
}

function ToolGroup({ parts }: { parts: ChatPart[] }) {
  const running = parts.some((p) => p.state?.status === "running");
  const failed = parts.filter((p) => p.state?.status === "error").length;
  const [open, setOpen] = useState(parts.length === 1 || running || failed > 0);
  return (
    <div className="tgroup">
      {parts.length > 1 && <button type="button" className="tg-head" onClick={() => setOpen(!open)}><Icon name={open ? "chev-d" : "chev-r"} /> {parts.length} steps{failed ? `, ${failed} failed` : ""}{running ? " · running" : ""}</button>}
      {open && parts.map((p) => <ToolRow key={p.id} part={p} />)}
    </div>
  );
}

function ToolRow({ part }: { part: ChatPart }) {
  const [open, setOpen] = useState(false);
  const status = part.state?.status;
  const detail = part.state?.error ?? part.state?.output;
  return (
    <div className={`trow${status === "error" ? " err" : ""}`}>
      <button type="button" onClick={() => detail && setOpen(!open)} disabled={!detail}>
        {status === "running" ? <span className="spinner small" /> : <Icon name={status === "error" ? "close" : part.tool?.toLowerCase().includes("bash") || part.state?.input?.command ? "terminal" : part.state?.input?.filePath ? "file" : "check"} />}
        <span className="tl">{part.tool && <b>{part.tool}</b>} {toolLine(part)}</span>
      </button>
      {open && detail && <pre className="tdetail">{detail.length > 4000 ? `${detail.slice(0, 4000)}\n…` : detail}</pre>}
    </div>
  );
}

function Part({ part, onRespond }: { part: ChatPart; onRespond: (promptId: string, answer: PromptReply) => void }) {
  if (part.orx) return <OrxNotice part={part} />;
  switch (part.type) {
    case "text": return part.text ? <Markdown text={part.text} /> : null;
    case "reasoning": return part.text ? <details className="thought"><summary>Thinking</summary><Markdown text={part.text} /></details> : null;
    case "prompt": return part.prompt ? <Prompt part={part} onRespond={onRespond} /> : null;
    case "steer": return part.text ? <div className="ub">{part.text}</div> : null;
    default: return null;
  }
}

function OrxNotice({ part }: { part: ChatPart }) {
  const src = part.orx!;
  const text = (part.text ?? "").split("\n")[0];
  if (src.kind === "run") {
    const ok = src.status === "done";
    return <div className={`npill ${ok ? "ok" : src.status === "failed" ? "bad" : "warn"}`}><Icon name={ok ? "check" : "warning"} /><span>{text || `Run ${src.status}`}</span></div>;
  }
  return <SentCard part={part} />;
}

const SENT_KIND: Record<string, string> = { task: "Task from", message: "Message from", answer: "Answer from", question: "Question from" };

/** What another chat (or OpenResearch, about runs) sent this one: its sender opens that chat, the rest opens the whole message. */
function SentCard({ part }: { part: ChatPart }) {
  const links = useContext(ChatLinksContext);
  const modelName = links?.modelName ?? (() => null);
  const [open, setOpen] = useState(false);
  const { kind, from } = part.orx!;
  const text = part.text ?? "";
  const monitoring = kind === "monitoring";
  const chat = monitoring || !from ? undefined : links?.chat(from);
  const sender = monitoring ? "OpenResearch" : chat?.title?.trim() || (chat ? delegateModelLabel(chat, modelName) : "another chat");
  return (
    <div className={`sent${open ? " open" : ""}`}>
      <div className="sent-head">
        <span className="sent-from">
          <Icon name={monitoring ? "warning" : "comment"} />
          {!monitoring && <span className="muted">{SENT_KIND[kind] ?? "From"}</span>}
          {chat ? <button type="button" className="linkish" title="Open this chat" onClick={() => links?.open(chat.id)}>{sender}</button> : <span>{sender}</span>}
        </span>
        <button type="button" className="sent-toggle" aria-expanded={open} title={open ? "Fold" : "Read the whole message"} onClick={() => setOpen(!open)}>
          {!open && <span className="sent-preview">{firstLine(text)}</span>}
          <Icon name={open ? "chev-d" : "chev-r"} />
        </button>
      </div>
      {open && <div className="sent-body"><Markdown text={text} /></div>}
    </div>
  );
}

const DELEGATE_STATUS: Record<DelegateStatus, string> = {
  running: "Running", asking: "Needs an answer", approval: "Needs approval", finished: "Finished", failed: "Failed", stopped: "Stopped",
};

/** A chat this one delegated to, under the turn that started it. */
function DelegateCard({ row: { session, status }, onOpen }: { row: DelegateRow; onOpen: (id: string) => void }) {
  const links = useContext(ChatLinksContext);
  const model = delegateModelLabel(session, links?.modelName ?? (() => null));
  const ended = status === "finished" || status === "failed" || status === "stopped";
  const preview = ended ? firstLine(session.delegate?.answer || session.delegate?.error || "") : "";
  return (
    <button type="button" className={`dcard ${status}`} title="Open sub-agent chat" onClick={() => onOpen(session.id)}>
      <Icon name="branch" />
      <span className="dcard-main">
        <span className="dcard-top">
          <b className="dcard-title">{session.title?.trim() || model || "Sub-agent"}</b>
          <span className="dcard-status">{DELEGATE_STATUS[status]}</span>
        </span>
        <span className="dcard-sub">{preview || model}</span>
      </span>
      {status === "running" ? <span className="spinner small" /> : <Icon name="chev-r" />}
    </button>
  );
}

function Prompt({ part, onRespond }: { part: ChatPart; onRespond: (promptId: string, answer: PromptReply) => void }) {
  const p = part.prompt!;
  const [picked, setPicked] = useState<string[]>([]);
  if (p.kind === "env") return <EnvPrompt part={part} onRespond={onRespond} />;
  if (p.resolved) {
    const answer = p.answers?.join(", ") ?? (p.approved === undefined ? "" : p.approved ? "Allowed" : "Declined");
    return <div className="prompt done"><span className="muted">{p.kind === "question" ? p.question : p.kind === "plan" ? "Plan" : `Use ${p.tool ?? "a tool"}`}</span>{answer && <b> · {answer}</b>}</div>;
  }
  if (p.kind === "question") {
    return (
      <div className="prompt">
        {p.header && <span className="muted small">{p.header}</span>}
        <p>{p.question}</p>
        <div className="opts">
          {(p.options ?? []).map((o) => (
            <button type="button" key={o.label} className={`opt${picked.includes(o.label) ? " on" : ""}`} title={o.description}
              onClick={() => (p.multiSelect ? setPicked((x) => (x.includes(o.label) ? x.filter((y) => y !== o.label) : [...x, o.label])) : onRespond(part.id, { answers: [o.label] }))}>{o.label}</button>
          ))}
        </div>
        {p.multiSelect && <button type="button" className="btn primary small" disabled={!picked.length} onClick={() => onRespond(part.id, { answers: picked })}>Answer</button>}
      </div>
    );
  }
  return (
    <div className="prompt">
      {p.kind === "plan" ? <><b>Proposed plan</b>{p.plan && <Markdown text={p.plan} />}</> : <><b>Allow {p.tool ?? "this tool"}?</b>{p.toolInput && <pre className="tdetail">{JSON.stringify(p.toolInput, null, 2).slice(0, 2000)}</pre>}</>}
      <div className="opts">
        <button type="button" className="btn primary small" onClick={() => onRespond(part.id, { approve: true })}>{p.kind === "plan" ? "Approve" : "Allow"}</button>
        <button type="button" className="btn small" onClick={() => onRespond(part.id, { approve: false })}>{p.kind === "plan" ? "Keep planning" : "Deny"}</button>
      </div>
    </div>
  );
}

function envPatternMatches(pattern: string, value: string): boolean {
  // Keep inline validation safe without spawning a Web Worker (disallowed by VS Code webview CSP).
  if (pattern.length > 256 || value.length > 4096) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

function EnvPrompt({ part, onRespond }: { part: ChatPart; onRespond: (promptId: string, answer: PromptReply) => void }) {
  const p = part.prompt!;
  const variables = p.variables ?? [];
  if (p.resolved) {
    const lines = variables.map((v) => {
      const name = ltr(v.name);
      if (v.savedTo === "global") return m.chat_env_saved_global({ name });
      if (v.savedTo === "project") return m.chat_env_saved_project({ name });
      return p.approved ? m.chat_env_left_unset({ name }) : null;
    }).filter((text) => text !== null);
    const text = p.approved === undefined
      ? m.chat_env_ended()
      : p.approved === false
        ? m.chat_env_declined()
        : lines.join(" · ") || m.chat_env_title();
    return <div className="prompt done"><span className="muted">{text}</span></div>;
  }
  return <EnvPromptForm promptId={part.id} variables={variables} reason={p.question} onRespond={onRespond} />;
}

function EnvPromptForm({ promptId, variables, reason, onRespond }: {
  promptId: string;
  variables: EnvRequestVar[];
  reason?: string;
  onRespond: (promptId: string, answer: PromptReply) => void;
}) {
  const projectId = useContext(ChatLinksContext)?.projectId;
  const { queries } = useWorkspace();
  const saved = useQuery(queries.getEnvVarsQuery(projectId)).data;
  const [values, setValues] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [selectedScope, setScope] = useState<EnvScope>("project");

  const scope: EnvScope = projectId ? selectedScope : "global";
  const savedVars = scope === "project" ? saved?.projectVars : saved?.vars;
  const mismatches = useMemo(() => {
    const out = new Set<string>();
    for (const v of variables) {
      const value = values.get(v.name)?.trim();
      if (v.pattern && value && !envPatternMatches(v.pattern, value)) out.add(v.name);
    }
    return out;
  }, [variables, values]);
  const answers: EnvAnswer[] = variables.flatMap(({ name }) => {
    const value = values.get(name)?.trim();
    return value ? [{ name, value, scope, mismatched: mismatches.has(name) }] : [];
  });
  const save = () => { if (answers.length) onRespond(promptId, { approve: true, env: answers }); };

  return (
    <form className="prompt" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <b>{m.chat_env_title()}</b>
      {reason && <p>{reason}</p>}
      {variables.map((v) => {
        const current = savedVars?.find((entry) => entry.key === v.name);
        const value = values.get(v.name) ?? "";
        const mismatched = mismatches.has(v.name);
        return (
          <label key={v.name} className="field">
            <span className="row">
              <code className="lab">{v.name}</code>
              {current && <span className="pill">{m.chat_env_saved()}</span>}
            </span>
            {v.description && <span className="muted small">{v.description}</span>}
            <input
              className="inp"
              type={v.secret ? "password" : "text"}
              value={value}
              placeholder={v.example}
              aria-label={m.a11y_value_for({ name: ltr(v.name) })}
              aria-invalid={mismatched || undefined}
              autoComplete={v.secret ? "new-password" : "off"}
              spellCheck={false}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setValues((all) => new Map(all).set(v.name, next));
              }}
            />
            {mismatched && <span className="small warn">{v.example ? m.chat_env_mismatch_example({ example: ltr(v.example) }) : m.chat_env_mismatch()}</span>}
            {current?.inProcessEnv && <span className="muted small">{m.chat_env_shell_wins({ name: ltr(v.name) })}</span>}
          </label>
        );
      })}
      {projectId && (
        <label className="row small muted">
          <span>{m.chat_env_save_scope()}</span>
          <select className="inp narrow" value={scope} onChange={(e) => setScope(e.currentTarget.value as EnvScope)}>
            <option value="project">{m.chat_env_save_to_project()}</option>
            <option value="global">{m.chat_env_save_for_all_projects()}</option>
          </select>
        </label>
      )}
      <div className="opts">
        <button type="submit" className="btn primary small" disabled={!answers.length}>{m.common_save()}</button>
        <button type="button" className="btn small" onClick={() => onRespond(promptId, { approve: false })}>{m.chat_env_decline()}</button>
      </div>
    </form>
  );
}

/** OpenResearch's ExperimentRunBanner: one row per run this chat started, folded when there are several. */
function RunBanner({ runs }: { runs: ChatActiveRun[] }) {
  if (!runs.length) return null;
  if (runs.length === 1) return <div className="runbar"><RunRow item={runs[0]!} /></div>;
  return (
    <details className="runbar">
      <summary><Icon name="flask" /><b>{m.chat_experiments_running({ count: runs.length })}</b><span className="chev"><Icon name="chev-r" /></span></summary>
      <div className="runbar-list">{runs.map((item) => <RunRow key={item.run.id} item={item} />)}</div>
    </details>
  );
}

function RunRow({ item }: { item: ChatActiveRun }) {
  const { api } = useWorkspace();
  const { run, experimentName } = item;
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = runDisplay(pending ? { ...run, cancelling: true } : run);
  const cancelling = pending || run.cancelling;
  const label = display.stale || cancelling || display.status === "queued"
    ? statusLabel(display.status, display.stopping)
    : run.status === "running" ? m.chat_experiment_running() : m.chat_experiment_starting();
  const connectHost = runConnectHost(run);
  const waiting = display.waiting ?? (display.status === "queued" ? run.queueDetail : null);
  const name = experimentName || run.experimentId;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const stop = async () => {
    setPending(true);
    setError(null);
    try {
      await api.cancelRun(run.id);
    } catch (e) {
      setPending(false);
      setError(errorText(e));
    }
  };
  return (
    <div className="runrow">
      <Icon name="flask" />
      <b role="status">{label}</b>
      <span aria-hidden="true">·</span>
      <button type="button" className="runrow-exp" title={name} onClick={() => void hostRequest("open", { view: "experiment", projectId: run.projectId, experimentId: run.experimentId })}>{name}</button>
      <span className="runrow-end">
        <span className="mono muted">{fmtDuration(now - run.createdAt)}</span>
        <Button small onClick={() => void hostRequest("logs.show", { runId: run.id, title: name })}><Icon name="terminal" /> {m.experiment_overview_logs()}</Button>
        {connectHost
          ? <Button small onClick={() => void hostRequest("open", { view: "settings", section: "compute", connectHost })}><Icon name="plug" /> {m.settings_connect()}</Button>
          : <Button small disabled={cancelling} onClick={() => void stop()}><Icon name="stop" /> {cancelling ? statusLabel(display.status, display.stopping) : m.common_stop()}</Button>}
      </span>
      {waiting && <span className="runrow-note muted" role="status">{waiting}</span>}
      {error && <span className="runrow-note err-text" role="alert">{error}</span>}
    </div>
  );
}

const SUGGESTIONS = ["Reproduce the baseline and run it on the default machine", "Try a lower learning rate as a child experiment", "Summarize the paper's method section"];

/** The input box, as in the notebook chat: context chips, the text, a toolbar with the send button. */
export function Composer({ busy, placeholder, draft, onSend, onStop, context, tools }: {
  busy: boolean;
  placeholder: string;
  draft?: { text: string } | null;
  onSend: (t: string) => Promise<boolean>;
  onStop: () => void;
  context?: ReactNode;
  tools?: ReactNode;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (draft) { setText(draft.text); area.current?.focus(); } }, [draft]);
  useLayoutEffect(() => { const el = area.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; } }, [text]);
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    if (!(await onSend(t))) setText(t);
  };
  return (
    <div className="composer-wrap">
      <div className="composer" onClick={(e) => { if (e.target === e.currentTarget) area.current?.focus(); }}>
        {context}
        <textarea ref={area} rows={1} value={text} placeholder={busy ? "Queue a follow-up…" : placeholder} onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
        <div className="toolbar">
          {tools}
          <span className="grow" />
          {busy && !text.trim()
            ? <button type="button" className="send stop" title="Stop the agent" aria-label="Stop" onClick={onStop}><Icon name="stop" /></button>
            : <button type="button" className="send" title="Send (Enter)" aria-label="Send" disabled={!text.trim()} onClick={() => void submit()}><Icon name="send" /></button>}
        </div>
      </div>
    </div>
  );
}

/** Used by the host to ask which research chat to show when none is selected. */
export function noChat() {
  return <div className="empty-chat"><p>Pick a chat in the Research side bar, or start one.</p><button type="button" className="btn primary" onClick={() => void hostRequest("open", { view: "newchat" })}>New Chat</button></div>;
}
