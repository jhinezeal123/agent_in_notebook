import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { EXTENSION_ID, SCOPE_HINT, SCOPE_LABEL, applyMessagePatch, type AgentOption, type ChatMessage, type ChatSettings, type ChatSnapshot, type ChatUsage, type MessagePatch, type NotebookInfo, type Part, type Scope } from "@ainb/protocol";
import { DEFAULT_PREFS, type BridgeState, type Prefs } from "../shared/panel-messages.js";
import { usePanelHost } from "./host.js";
import { copyText, Message, PendingPrompt, type PartActions } from "./parts.js";
import { AgentManager } from "./agent-manager.js";

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

export function App() {
  const client = usePanelHost();
  const inVSCode = client.kind === "vscode";
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => client.watchTab(setTabId), [client]);
  const [notebook, setNotebook] = useState<NotebookInfo | null>(null);
  const [chat, setChat] = useState<ChatSnapshot | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [error, setError] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);
  const [loadedTab, setLoadedTab] = useState<number | null>(null);
  const [managingAgents, setManagingAgents] = useState(false);
  const [changingOption, setChangingOption] = useState(false);
  const tabRef = useRef(tabId);
  tabRef.current = tabId;
  const agentRef = useRef(prefs.agentId);
  agentRef.current = prefs.agentId;
  /** Mode changes made while no chat was open yet; applied to the chat once it opens. */
  const unsentSettings = useRef<Partial<ChatSettings> | null>(null);

  useEffect(() => {
    void client.getPrefs().then((prefs) => prefs && setPrefsState({ ...DEFAULT_PREFS, ...prefs }), () => {}).finally(() => setPrefsReady(true));
    void client.request<BridgeState>("state.get").then(setBridge, (e: Error) => setError(e.message));
    return client.on((e) => {
      if (e.event === "state") setBridge({ ...e.params });
      else if (e.event === "notebook") {
        if (e.params.tabId === tabRef.current) setNotebook(e.params.info);
      } else if (e.event === "bridge") {
        const { method, params } = e.params as { method: string; params: any };
        if (params?.tabId !== tabRef.current) return;
        if (method === "chat.snapshot" && params.agentId === agentRef.current) setChat(params as ChatSnapshot);
        else if (method === "chat.patch") {
          setChat((c) => {
            if (!c || c.chatId !== params.chatId) return c;
            const messages = applyMessagePatch(c.messages, params as MessagePatch);
            if (messages) return { ...c, messages };
            // An update was missed (the panel was busy reconnecting): fetch the whole chat.
            queueMicrotask(() => void client.request<ChatSnapshot | null>("chat.get", { tabId: params.tabId }).then((snap) => {
              if (snap && snap.tabId === tabRef.current) setChat(snap);
            }, () => {}));
            return c;
          });
        } else if (method === "chat.usage") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, usage: params.usage } : c));
        } else if (method === "chat.status") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, status: params.status, error: params.error } : c));
        }
      }
    });
  }, []);

  const connected = bridge?.conn === "connected";

  // Load the tab's notebook and chat whenever the tab or the connection changes.
  useEffect(() => {
    let stale = false;
    setChat(null);
    setNotebook(null);
    setLoadedTab(null);
    if (tabId === null) return;
    void client.request<NotebookInfo | null>("tab.notebook", { tabId }).then((info) => tabRef.current === tabId && setNotebook(info), () => {});
    if (connected) void client.request<ChatSnapshot | null>("chat.get", { tabId }).then((c) => {
      if (!stale) { setChat(c); setLoadedTab(tabId); }
    }, (e) => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [tabId, connected]);

  const setPrefs = (p: Partial<Prefs>) => {
    setPrefsState((old) => {
      const next = { ...old, ...p };
      void client.setPrefs(next).catch((e: Error) => setError(e.message));
      return next;
    });
  };

  const run = useCallback(async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  }, []);

  // During a tab or document switch, ignore snapshots from the previous notebook.
  const live = chat && chat.tabId === tabId && chat.status !== "closed" && (!chat.notebookKey || chat.notebookKey === notebook?.key) ? chat : null;
  const settings: ChatSettings =
    live?.agentId === prefs.agentId ? live.settings : { scope: prefs.scope, review: prefs.review, targetCellIds: [], notebookOnly: prefs.notebookOnly };

  // ACP exposes model choices when the session opens, before any prompt.
  useEffect(() => {
    if (!connected || !prefsReady || tabId === null || loadedTab !== tabId || !notebook || live?.agentId === prefs.agentId) return;
    if (!bridge?.agents.some((a) => a.id === prefs.agentId && a.available)) return;
    let stale = false;
    void client.request<ChatSnapshot>("chat.open", { tabId, agentId: prefs.agentId, settings, platform: notebook.platform, notebookKey: notebook.key }).then((snap) => {
      if (!stale && tabRef.current === tabId && agentRef.current === snap.agentId) adopt(snap);
    }, (e) => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [connected, prefsReady, loadedTab, tabId, notebook?.platform, notebook?.key, prefs.agentId, live?.agentId, bridge?.agents]);

  const updateSettings = (s: ChatSettings) => {
    setPrefs({ scope: s.scope, review: s.review, notebookOnly: s.notebookOnly });
    if (live && live.agentId === prefs.agentId) {
      // Show the change at once; the bridge's answer confirms it.
      setChat((c) => (c && c.chatId === live.chatId ? { ...c, settings: s } : c));
      void run(client.request<ChatSnapshot>("chat.settings", { chatId: live.chatId, settings: s })).then((c) => c && setChat(c));
    } else unsentSettings.current = { ...unsentSettings.current, scope: s.scope, review: s.review, notebookOnly: s.notebookOnly };
  };

  /** Show a freshly opened chat, carrying over mode changes made while it was opening. */
  const adopt = (snap: ChatSnapshot) => {
    setChat(snap);
    const unsent = unsentSettings.current;
    unsentSettings.current = null;
    if (!unsent || snap.status === "closed") return;
    const next = { ...snap.settings, ...unsent };
    if (next.scope === snap.settings.scope && next.review === snap.settings.review && next.notebookOnly === snap.settings.notebookOnly) return;
    void run(client.request<ChatSnapshot>("chat.settings", { chatId: snap.chatId, settings: next })).then((c) => c && setChat(c));
  };

  const openChat = async (agentId: string): Promise<ChatSnapshot | undefined> => {
    if (tabId === null || !notebook) return undefined;
    const snap = await run(client.request<ChatSnapshot>("chat.open", { tabId, agentId, settings, platform: notebook.platform, notebookKey: notebook.key }));
    if (snap && tabRef.current === tabId && agentRef.current === agentId) adopt(snap);
    return snap;
  };

  const send = async (text: string) => {
    if (changingOption) return false;
    setError(null);
    let c = live;
    if (!c || c.agentId !== prefs.agentId) c = (await openChat(prefs.agentId)) ?? null;
    if (!c) return false;
    if (c.tabId !== tabRef.current) return false;
    const ok = await run(client.request("chat.send", { chatId: c.chatId, text }));
    return ok !== undefined;
  };

  const actions: PartActions = useMemo(
    () => ({
      answer: (promptId, optionId) => live && void run(client.request("chat.answer", { chatId: live.chatId, promptId, optionId })),
      review: (reviewId, accept) => live && void run(client.request("chat.review", { chatId: live.chatId, reviewId, accept })),
      focusCell: (cellId) => tabId !== null && void run(client.request("notebook.focus", { tabId, cellId })),
      insertCell: (source, cellType) => tabId !== null && void run(client.request("notebook.insert", { tabId, source, cellType })),
      // The transcript shows the outcome (a notice on the message); errors show in the banner.
      undo: async (messageId) => {
        if (live) await run(client.request("chat.undo", { chatId: live.chatId, messageId }));
      },
    }),
    [live?.chatId, tabId],
  );

  if (!bridge) return <div class="center muted">{error ?? "Loading…"}</div>;
  if (!connected) return inVSCode ? <VSCodeSetup bridge={bridge} /> : <Setup bridge={bridge} />;

  const agents = bridge.agents;
  const running = live?.status === "running";
  const allParts = (live?.messages ?? []).flatMap((m) => m.parts);
  const pendingReviews = allParts.filter((p): p is Extract<Part, { type: "review" }> => p.type === "review" && p.status === "pending");
  const pendingPrompts = allParts.filter((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt" && p.answer === undefined);
  const history = (live?.messages ?? []).filter((m) => m.role === "user").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));

  return (
    <div class="app">
      <header class="top">
        <span class={`dot ${notebook ? "ok" : "off"}`} aria-hidden="true" />
        <div class="top-title">
          {notebook ? (
            <>
              <strong>{PLATFORM[notebook.platform]}</strong> · <span title={notebook.title}>{notebook.title}</span>
            </>
          ) : (
            <span class="muted">{inVSCode ? "No active notebook" : "No notebook in this tab"}</span>
          )}
        </div>
        {notebook && <span class={`kernel k-${notebook.kernel}`} title="Notebook kernel">kernel: {notebook.kernel}</span>}
        {live && (
          <button
            class="icon"
            title="New chat (clears the saved conversation for this notebook)"
            aria-label="New chat"
            onClick={() => void run(client.request("chat.close", { chatId: live.chatId })).then((closed) => {
              if (closed) setChat((current) => current?.chatId === live.chatId ? null : current);
            })}
          >
            ＋
          </button>
        )}
      </header>

      {!notebook ? (
        <div class="center muted pad">
          {inVSCode ? <p>Open an <code>.ipynb</code> file in the Notebook Editor to chat with an agent about it.</p> : <>
            <p>Open a notebook on Colab or Kaggle (or a local Jupyter started with app exposure) to chat with an agent about it.</p>
            <p class="small">If the notebook is open, reload its tab once after installing the extension.</p>
          </>}
          <button class="secondary" onClick={() => setManagingAgents(true)}>Manage agents</button>
        </div>
      ) : (
        <Transcript chat={live} actions={actions} />
      )}

      {live?.error && <div class="banner error">{live.error}</div>}
      {error && (
        <div class="banner error" role="alert">
          {error}
          <button class="icon" aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {notebook && (
        <footer class="bottom">
          {pendingPrompts[0] && <PendingPrompt part={pendingPrompts[0]} more={pendingPrompts.length - 1} actions={actions} />}
          {pendingReviews.length > 1 && (
            <div class="bulk">
              {pendingReviews.length} changes await review
              <button class="primary small" onClick={() => pendingReviews.forEach((p) => actions.review(p.review.reviewId, true))}>
                Apply all
              </button>
              <button class="secondary small" onClick={() => pendingReviews.forEach((p) => actions.review(p.review.reviewId, false))}>
                Reject all
              </button>
            </div>
          )}
          <ModeBar settings={settings} notebook={notebook} onChange={updateSettings} />
          <Composer history={history} running={running} disabled={changingOption || !live || live.agentId !== prefs.agentId || live.status === "starting" || !agents.some((a) => a.id === prefs.agentId && a.available)} onSend={send} onStop={() => live && void run(client.request("chat.cancel", { chatId: live.chatId }))} />
          <div class="agent-row">
            <select
              aria-label="Agent"
              value={prefs.agentId}
              disabled={running || changingOption}
              onChange={(e) => {
                const id = (e.target as HTMLSelectElement).value;
                setPrefs({ agentId: id });
              }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available} title={a.reason}>
                  {a.name}
                  {a.available ? "" : " (not installed)"}
                </option>
              ))}
            </select>
            {live && live.agentId === prefs.agentId && <AgentOptions chat={live} busy={changingOption} onSet={(id, v) => {
              setChangingOption(true);
              void run(client.request<ChatSnapshot>("chat.option", { chatId: live.chatId, optionId: id, value: v })).then((c) => {
                if (c && tabRef.current === c.tabId && agentRef.current === c.agentId) setChat(c);
              }).finally(() => setChangingOption(false));
            }} />}
            {live?.status === "starting" && <span class="muted small">starting…</span>}
            {live?.usage && live.agentId === prefs.agentId && <ContextMeter usage={live.usage} />}
            <button class="linkish" disabled={running || changingOption} onClick={() => setManagingAgents(true)}>Manage agents</button>
          </div>
        </footer>
      )}
      {managingAgents && <AgentManager agents={agents} onSaved={(id) => { setPrefs({ agentId: id }); setManagingAgents(false); }} onRemoved={(id) => {
        if (prefs.agentId === id) setPrefs({ agentId: agents.find((a) => a.builtin && a.available)?.id ?? "claude" });
      }} onClose={() => setManagingAgents(false)} />}
    </div>
  );
}

/** Elapsed time, written straight into the node each second so the transcript does not re-render. */
function Elapsed({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
      const text = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
      if (ref.current && ref.current.textContent !== text) ref.current.textContent = text;
    };
    write();
    const timer = setInterval(write, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} class="elapsed" />;
}

function Transcript({ chat, actions }: { chat: ChatSnapshot | null; actions: PartActions }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastHeight = useRef(0);
  const [behind, setBehind] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight > lastHeight.current && !behind) setBehind(true);
    lastHeight.current = el.scrollHeight;
  });
  if (!chat || !chat.messages.length) {
    return (
      <div class="transcript empty">
        <div class="center muted pad">
          <p>Ask the agent about this notebook.</p>
          <ul class="hints">
            <li>“Explain what cell 3 does”</li>
            <li>“Fix the error in the selected cell”</li>
            <li>“Add a section that plots the training loss”</li>
          </ul>
        </div>
      </div>
    );
  }
  const running = chat.status === "running";
  const last = chat.messages.at(-1);
  const liveId = running && last?.role === "agent" ? last.id : null;
  return (
    <div class="transcript-wrap">
      <div
        class="transcript"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (stick.current && behind) setBehind(false);
        }}
      >
        {chat.messages.map((m) => (
          <Message key={m.id} msg={m} actions={actions} live={m.id === liveId} />
        ))}
        {running && (
          <div class="working" aria-label="Agent is working">
            <span class="spinner" aria-hidden="true" /> Working <Elapsed since={last?.role === "agent" ? last.createdAt : Date.now()} />
          </div>
        )}
      </div>
      {behind && (
        <button
          class="jump"
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
            stick.current = true;
            setBehind(false);
          }}
        >
          ↓ New messages
        </button>
      )}
    </div>
  );
}

function ModeBar({ settings, notebook, onChange }: { settings: ChatSettings; notebook: NotebookInfo; onChange: (s: ChatSettings) => void }) {
  const scopes: Scope[] = ["cell", "write", "auto"];
  const targets = settings.targetCellIds.length ? settings.targetCellIds : notebook.selectedCellIds.length ? notebook.selectedCellIds : notebook.activeCellId ? [notebook.activeCellId] : [];
  const pinned = settings.targetCellIds.length > 0;
  return (
    <div class="modebar">
      <div class="seg" role="radiogroup" aria-label="Mode">
        {scopes.map((s) => (
          <button key={s} role="radio" aria-checked={settings.scope === s} class={settings.scope === s ? "on" : ""} title={SCOPE_HINT[s]} onClick={() => onChange({ ...settings, scope: s })}>
            {SCOPE_LABEL[s]}
          </button>
        ))}
      </div>
      <label class="toggle" title="Show each change as a diff to apply or reject">
        <input type="checkbox" checked={settings.review} onChange={(e) => onChange({ ...settings, review: (e.target as HTMLInputElement).checked })} />
        Review
      </label>
      <label class="toggle" title="Refuse the agent's requests to use its own tools on this computer (shell, file edits, web). Notebook content could try to talk the agent into them.">
        <input type="checkbox" checked={settings.notebookOnly} onChange={(e) => onChange({ ...settings, notebookOnly: (e.target as HTMLInputElement).checked })} />
        Notebook only
      </label>
      {settings.scope === "cell" && (
        <div class="targets">
          <span class="muted">{pinned ? "Pinned:" : "Target (selected):"}</span> {targets.length ? targets.map((t) => t.slice(0, 10)).join(", ") : <em>select a cell</em>}
          {pinned ? (
            <button class="linkish" onClick={() => onChange({ ...settings, targetCellIds: [] })}>
              follow selection
            </button>
          ) : (
            targets.length > 0 && (
              <button class="linkish" onClick={() => onChange({ ...settings, targetCellIds: targets })}>
                pin
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function Composer({ history, running, disabled, onSend, onStop }: { history: string[]; running: boolean; disabled: boolean; onSend: (t: string) => Promise<boolean>; onStop: () => void }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  /** Position in `history` while recalling earlier prompts with the arrow keys. */
  const recall = useRef<number | null>(null);
  const submit = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText("");
    if (!(await onSend(t))) setText(t);
  };
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  return (
    <div class="composer">
      <textarea
        ref={area}
        rows={2}
        placeholder={running ? "Queue a follow-up…" : "Ask about this notebook…"}
        value={text}
        onInput={(e) => {
          recall.current = null;
          setText((e.target as HTMLTextAreaElement).value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            recall.current = null;
            void submit();
            return;
          }
          // Arrow keys walk through earlier prompts when the box is empty or shows a recalled one.
          const el = e.currentTarget as HTMLTextAreaElement;
          const browsing = recall.current !== null && text === history[recall.current];
          const oneLine = !text.includes("\n");
          if (e.key === "ArrowUp" && history.length && (text === "" || browsing) && (el.selectionStart === 0 || (browsing && oneLine))) {
            e.preventDefault();
            recall.current = recall.current === null ? history.length - 1 : Math.max(0, recall.current - 1);
            setText(history[recall.current]!);
          } else if (e.key === "ArrowDown" && browsing && (el.selectionEnd === text.length || oneLine)) {
            e.preventDefault();
            const next = recall.current! + 1;
            recall.current = next < history.length ? next : null;
            setText(next < history.length ? history[next]! : "");
          }
        }}
      />
      {running ? (
        <button class="stop" onClick={onStop} title="Stop the agent">
          Stop
        </button>
      ) : (
        <button class="primary send" onClick={() => void submit()} disabled={disabled || !text.trim()}>
          Send
        </button>
      )}
    </div>
  );
}

/** How full the agent's context window is, as the agent reported it. */
function ContextMeter({ usage }: { usage: ChatUsage }) {
  const share = usage.size > 0 ? Math.min(1, usage.used / usage.size) : 0;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const cost = usage.cost ? ` · ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}` : "";
  const level = share >= 0.85 ? " full" : share >= 0.6 ? " filling" : "";
  return (
    <span class={`context-meter${level}`} title={`Context: ${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens${cost}. Start a new chat when it is nearly full.`}>
      <span class="bar"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
      {k(usage.used)}/{k(usage.size)}
    </span>
  );
}

function AgentOptions({ chat, busy, onSet }: { chat: ChatSnapshot; busy: boolean; onSet: (id: string, v: string | boolean) => void }) {
  const order = (o: AgentOption) => ["model", "thought_level", "mode"].indexOf(o.category ?? "") >>> 0;
  const opts = [...chat.options].sort((a, b) => order(a) - order(b));
  return (
    <>
      {opts.map((o) =>
        o.kind === "select" ? (
          <select key={o.id} aria-label={o.name} title={o.name} value={String(o.value)} disabled={busy || chat.status !== "idle"} onChange={(e) => onSet(o.id, (e.target as HTMLSelectElement).value)}>
            {o.choices?.map((c) => (
              <option key={c.value} value={c.value} title={c.description ?? undefined}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <label key={o.id} class="toggle small" title={o.name}>
            <input type="checkbox" checked={!!o.value} disabled={busy || chat.status !== "idle"} onChange={(e) => onSet(o.id, (e.target as HTMLInputElement).checked)} />
            {o.name}
          </label>
        ),
      )}
    </>
  );
}

function VSCodeSetup({ bridge }: { bridge: BridgeState }) {
  const client = usePanelHost();
  const [error, setError] = useState<string>();
  const busy = bridge.conn === "connecting";
  const connect = (method: string) => {
    setError(undefined);
    void client.request(method).catch((e: Error) => setError(e.message));
  };
  return (
    <div class="setup pad">
      <h1>Connect to the bridge</h1>
      <p>Run <code>pnpm bridge</code> from the project folder in a terminal.</p>
      {busy ? <p role="status">Connecting…</p> : <p role="status">{error ?? bridge.error}</p>}
      <div class="row-actions">
        <button class="primary" disabled={busy} onClick={() => connect("config.auto")}>{bridge.conn === "replaced" ? "Connect here" : "Retry connection"}</button>
        <button class="secondary" disabled={busy} onClick={() => connect("config.prompt")}>Enter pairing token</button>
        {bridge.config.source === "manual" && <button class="linkish" disabled={busy} onClick={() => connect("config.reset")}>Use local configuration</button>}
      </div>
    </div>
  );
}

function Setup({ bridge }: { bridge: BridgeState }) {
  const client = usePanelHost();
  const [port, setPort] = useState(String(bridge.config.port));
  const [token, setToken] = useState(bridge.config.source === "manual" ? bridge.config.token : "");
  const [saving, setSaving] = useState(false);
  const manual = bridge.config.source === "manual";
  const native = bridge.native?.status;
  const needsInstall = native === "missing" || native === "forbidden";
  const busy = bridge.conn === "connecting";
  // The ID is fixed by the manifest's key; a copy loaded without it needs its own entry.
  const command = `ainb install${bridge.extensionId !== EXTENSION_ID ? ` --extension-id ${bridge.extensionId}` : ""}`;
  const auto = () => void client.request("config.auto", {}).catch(() => {});
  // Before installing, "paste the token" is not the next step; installing is.
  const status = needsInstall && !manual && bridge.conn === "unpaired" ? null : busy ? null : bridge.error ?? (bridge.conn === "unpaired" ? "Not paired yet." : "Not connected.");
  return (
    <div class="setup pad">
      <h1>Connect to the bridge</h1>
      <p>The agents run on your computer through a small local bridge.</p>
      {!manual &&
        (needsInstall ? (
          <>
            <p>
              {native === "forbidden"
                ? "The bridge is set up for another copy of this extension. Run this once in a terminal:"
                : "Set it up once: run this in a terminal, then come back here. The panel then starts the bridge by itself."}
            </p>
            <div class="cmd">
              <code>{command}</code>
              <button class="linkish" onClick={(e) => void copyText(client, command, e.currentTarget)}>
                Copy
              </button>
            </div>
            <p class="muted small">
              From the project folder: <code>pnpm ainb {command.slice(5)}</code>
            </p>
            <button class="primary" disabled={busy} onClick={auto}>
              {busy ? "Checking…" : "Check again"}
            </button>
          </>
        ) : (
          <button class="primary" disabled={busy} onClick={auto}>
            {busy ? "Starting the bridge…" : bridge.conn === "replaced" ? "Connect here" : "Start the bridge"}
          </button>
        ))}
      {status && <p class={`status ${bridge.conn}`}>{status}</p>}
      {bridge.native?.log && <pre class="setup-log">{bridge.native.log}</pre>}
      <details class="manual" open={manual}>
        <summary>Connect with a pairing token instead</summary>
        <p class="muted small">
          For a bridge started by hand (<code>ainb serve</code> prints the token), for example in WSL or on another port.
        </p>
        <label class="field">
          Pairing token
          <input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="from the bridge's console" autocomplete="off" />
        </label>
        <label class="field">
          Port
          <input inputMode="numeric" value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value)} />
        </label>
        <div class="row-actions">
          <button
            class={manual ? "primary" : "secondary"}
            disabled={saving || !token.trim()}
            onClick={async () => {
              setSaving(true);
              await client.request("config.set", { port: Number(port), token }).catch(() => {});
              setSaving(false);
            }}
          >
            {manual && busy ? "Connecting…" : manual && bridge.conn === "replaced" ? "Connect here" : "Connect"}
          </button>
          {manual && (
            <button class="linkish" onClick={auto}>
              Set up automatically instead
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
