import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { SCOPE_HINT, SCOPE_LABEL, type AgentOption, type ChatMessage, type ChatSettings, type ChatSnapshot, type NotebookInfo, type Part, type Scope } from "@ainb/protocol";
import { DEFAULT_PREFS, type BridgeState, type Prefs } from "../shared/panel-messages.js";
import { client } from "./client.js";
import { Message, type PartActions } from "./parts.js";
import { AgentManager } from "./agent-manager.js";

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter" } as const;

function useActiveTab(): number | null {
  // `?tab=<id>` pins the panel to one tab (used when it is opened as a page, e.g. in tests).
  const pinned = Number(new URLSearchParams(location.search).get("tab")) || null;
  const [tabId, setTabId] = useState<number | null>(pinned);
  useEffect(() => {
    if (pinned) return;
    let windowId: number | undefined;
    const refresh = async () => {
      const [tab] = await chrome.tabs.query({ active: true, ...(windowId !== undefined ? { windowId } : { currentWindow: true }) });
      setTabId(tab?.id ?? null);
    };
    void chrome.windows.getCurrent().then((w) => {
      windowId = w.id;
      void refresh();
    });
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (windowId === undefined || info.windowId === windowId) setTabId(info.tabId);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, []);
  return tabId;
}

export function App() {
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const tabId = useActiveTab();
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

  useEffect(() => {
    void chrome.storage.local.get("prefs").then(({ prefs }) => prefs && setPrefsState({ ...DEFAULT_PREFS, ...prefs })).finally(() => setPrefsReady(true));
    void client.request<BridgeState>("state.get").then(setBridge);
    return client.on((e) => {
      if (e.event === "state") setBridge({ ...e.params });
      else if (e.event === "notebook") {
        if (e.params.tabId === tabRef.current) setNotebook(e.params.info);
      } else if (e.event === "bridge") {
        const { method, params } = e.params as { method: string; params: any };
        if (params?.tabId !== tabRef.current) return;
        if (method === "chat.snapshot" && params.agentId === agentRef.current) setChat(params as ChatSnapshot);
        else if (method === "chat.message") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, messages: upsert(c.messages, params.message) } : c));
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
      void chrome.storage.local.set({ prefs: next });
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

  const settings: ChatSettings = chat?.settings ?? { scope: prefs.scope, review: prefs.review, targetCellIds: [], notebookOnly: prefs.notebookOnly };
  // A chat belongs to one notebook: when another notebook fills the tab, the
  // old chat is not shown and a chat for the new notebook is opened (or restored).
  const live = chat && chat.status !== "closed" && (!chat.notebookKey || !notebook?.key || chat.notebookKey === notebook.key) ? chat : null;

  // ACP exposes model choices when the session opens, before any prompt.
  useEffect(() => {
    if (!connected || !prefsReady || tabId === null || loadedTab !== tabId || !notebook || live?.agentId === prefs.agentId) return;
    if (!bridge?.agents.some((a) => a.id === prefs.agentId && a.available)) return;
    let stale = false;
    void client.request<ChatSnapshot>("chat.open", { tabId, agentId: prefs.agentId, settings, platform: notebook.platform, notebookKey: notebook.key }).then((snap) => {
      if (!stale && tabRef.current === tabId && agentRef.current === snap.agentId) setChat(snap);
    }, (e) => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [connected, prefsReady, loadedTab, tabId, notebook?.platform, notebook?.key, prefs.agentId, live?.agentId, bridge?.agents]);

  const updateSettings = (s: ChatSettings) => {
    setPrefs({ scope: s.scope, review: s.review, notebookOnly: s.notebookOnly });
    if (live) void run(client.request<ChatSnapshot>("chat.settings", { chatId: live.chatId, settings: s })).then((c) => c && setChat(c));
  };

  const openChat = async (agentId: string): Promise<ChatSnapshot | undefined> => {
    if (tabId === null || !notebook) return undefined;
    const snap = await run(client.request<ChatSnapshot>("chat.open", { tabId, agentId, settings, platform: notebook.platform, notebookKey: notebook.key }));
    if (snap && tabRef.current === tabId && agentRef.current === agentId) setChat(snap);
    return snap;
  };

  const send = async (text: string) => {
    if (changingOption) return false;
    setError(null);
    let c = live;
    if (!c || c.agentId !== prefs.agentId) c = (await openChat(prefs.agentId)) ?? null;
    if (!c) return false;
    const ok = await run(client.request("chat.send", { chatId: c.chatId, text }));
    return ok !== undefined;
  };

  const actions: PartActions = useMemo(
    () => ({
      answer: (promptId, optionId) => live && void run(client.request("chat.answer", { chatId: live.chatId, promptId, optionId })),
      review: (reviewId, accept) => live && void run(client.request("chat.review", { chatId: live.chatId, reviewId, accept })),
      focusCell: (cellId) => tabId !== null && void run(client.request("notebook.focus", { tabId, cellId })),
    }),
    [live?.chatId, tabId],
  );

  if (!bridge) return <div class="center muted">Loading…</div>;
  if (!connected) return <Setup bridge={bridge} />;

  const agents = bridge.agents;
  const running = live?.status === "running";
  const pendingReviews = (live?.messages ?? []).flatMap((m) => m.parts).filter((p): p is Extract<Part, { type: "review" }> => p.type === "review" && p.status === "pending");

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
            <span class="muted">No notebook in this tab</span>
          )}
        </div>
        {notebook && <span class={`kernel k-${notebook.kernel}`} title="Notebook kernel">kernel: {notebook.kernel}</span>}
        {live && (
          <button
            class="icon"
            title="New chat (clears the saved conversation for this notebook)"
            aria-label="New chat"
            onClick={() => void run(client.request("chat.close", { chatId: live.chatId })).then(() => setChat(null))}
          >
            ＋
          </button>
        )}
      </header>

      {!notebook ? (
        <div class="center muted pad">
          <p>Open a notebook on Colab or Kaggle (or a local Jupyter started with app exposure) to chat with an agent about it.</p>
          <p class="small">If the notebook is open, reload its tab once after installing the extension.</p>
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
          <Composer running={running} disabled={changingOption || !live || live.agentId !== prefs.agentId || live.status === "starting" || !agents.some((a) => a.id === prefs.agentId && a.available)} onSend={send} onStop={() => live && void run(client.request("chat.cancel", { chatId: live.chatId }))} />
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

function upsert(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return [...list, m];
  const next = list.slice();
  next[i] = m;
  return next;
}

function Transcript({ chat, actions }: { chat: ChatSnapshot | null; actions: PartActions }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
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
  return (
    <div
      class="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {chat.messages.map((m) => (
        <Message key={m.id} msg={m} actions={actions} />
      ))}
      {chat.status === "running" && <div class="typing" aria-label="Agent is working">●●●</div>}
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

function Composer({ running, disabled, onSend, onStop }: { running: boolean; disabled: boolean; onSend: (t: string) => Promise<boolean>; onStop: () => void }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
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
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void submit();
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

function Setup({ bridge }: { bridge: BridgeState }) {
  const [port, setPort] = useState(String(bridge.config.port));
  const [token, setToken] = useState(bridge.config.token);
  const [saving, setSaving] = useState(false);
  return (
    <div class="setup pad">
      <h1>Connect to the bridge</h1>
      <p>The agents run on your computer through a small local bridge.</p>
      <ol>
        <li>
          Start it: <code>pnpm bridge</code> in the project folder (or <code>node packages/bridge/dist/cli.js serve</code>).
        </li>
        <li>Paste the pairing token it prints below.</li>
      </ol>
      <label class="field">
        Pairing token
        <input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="from the bridge's console" autocomplete="off" />
      </label>
      <label class="field">
        Port
        <input inputMode="numeric" value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value)} />
      </label>
      <button
        class="primary"
        disabled={saving || !token.trim()}
        onClick={async () => {
          setSaving(true);
          await client.request("config.set", { port: Number(port), token }).catch(() => {});
          setSaving(false);
        }}
      >
        {bridge.conn === "connecting" ? "Connecting…" : bridge.conn === "replaced" ? "Connect here" : "Connect"}
      </button>
      <p class={`status ${bridge.conn}`}>
        {bridge.conn === "connecting" ? "Connecting…" : bridge.error ?? (bridge.conn === "unpaired" ? "Not paired yet." : "Not connected.")}
      </p>
    </div>
  );
}
