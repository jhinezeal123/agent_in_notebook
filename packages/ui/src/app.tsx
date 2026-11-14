import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { SCOPE_HINT, SCOPE_LABEL, applyMessagePatch, type AgentOption, type ChatProject, type ChatSettings, type ChatSnapshot, type ChatUsage, type MessagePatch, type NotebookInfo, type Part, type Scope } from "@ainb/protocol";
import { DEFAULT_PREFS, type BridgeState, type NotebookChoice, type Prefs } from "./panel-messages.js";
import { usePanelHost } from "./host.js";
import { Message, PendingPrompt, type PartActions } from "./parts.js";
import { Icon, type IconName } from "./icons.js";

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

export function App() {
  const client = usePanelHost();
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => client.watchTab(setTabId), [client]);
  const [notebook, setNotebook] = useState<NotebookInfo | null>(null);
  const [choices, setChoices] = useState<NotebookChoice[]>([]);
  const [chat, setChat] = useState<ChatSnapshot | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [error, setError] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);
  const [loadedTab, setLoadedTab] = useState<number | null>(null);
  /** A suggestion put in the input box. */
  const [draft, setDraft] = useState<{ text: string } | null>(null);
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
    void client.request<NotebookChoice[]>("notebooks.list").then(setChoices, () => {});
    return client.on((e) => {
      if (e.event === "state") setBridge({ ...e.params });
      else if (e.event === "notebooks") setChoices(e.params);
      else if (e.event === "prefs") setPrefsState({ ...DEFAULT_PREFS, ...e.params });
      else if (e.event === "command" && e.params === "chat.clear") clearRef.current();
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

  /** Clear Chat: close the chat, which forgets its saved conversation. */
  const clearRef = useRef(() => {});
  clearRef.current = () => {
    if (!live) return;
    const id = live.chatId;
    void run(client.request("chat.close", { chatId: id })).then((closed) => {
      if (closed) setChat((current) => current?.chatId === id ? null : current);
    });
  };

  /** Move the notebook to another project (a quick pick in the editor). */
  const moveProject = () => {
    if (!live?.notebookKey) return;
    void run(client.request<ChatProject | null>("project.move", { notebookKey: live.notebookKey, title: notebook?.title, url: notebook?.url, platform: notebook?.platform, current: live.project?.id ?? null }));
  };
  const [saving, setSaving] = useState(false);
  const saveNotebook = () => {
    if (!live || saving) return;
    setSaving(true);
    void run(client.request("chat.saveNotebook", { chatId: live.chatId })).finally(() => setSaving(false));
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
  if (!connected) return <Setup bridge={bridge} />;

  const agents = bridge.agents;
  const running = live?.status === "running";
  const allParts = (live?.messages ?? []).flatMap((m) => m.parts);
  const pendingReviews = allParts.filter((p): p is Extract<Part, { type: "review" }> => p.type === "review" && p.status === "pending");
  const pendingPrompts = allParts.filter((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt" && p.answer === undefined);
  const history = (live?.messages ?? []).filter((m) => m.role === "user").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));

  const agentReady = agents.some((a) => a.id === prefs.agentId && a.available);
  const agentName = agents.find((a) => a.id === prefs.agentId)?.name ?? "the agent";
  // The model sits in the toolbar; the agent's other options open from the agent's button.
  const options = live && live.agentId === prefs.agentId ? live.options : [];
  const modelOptions = options.filter((o) => o.category === "model" && o.kind === "select");
  const moreOptions = options.filter((o) => !modelOptions.includes(o)).sort((a, b) => optionOrder(a) - optionOrder(b));
  const optionsLocked = changingOption || live?.status !== "idle";
  const setOption = (id: string, v: string | boolean) => {
    if (!live) return;
    setChangingOption(true);
    void run(client.request<ChatSnapshot>("chat.option", { chatId: live.chatId, optionId: id, value: v })).then((c) => {
      if (c && tabRef.current === c.tabId && agentRef.current === c.agentId) setChat(c);
    }).finally(() => setChangingOption(false));
  };

  return (
    <div class="app">
      {notebook && (
        <NotebookHeader
          notebook={notebook}
          tabId={tabId}
          choices={choices}
          onPick={(id) => void run(client.request("notebooks.select", { tabId: id }))}
          onMirror={() => tabId !== null && void run(client.request("notebook.mirror", { tabId }))}
        />
      )}
      {!notebook ? (
        <Welcome mark>
          <p>Open a notebook on Colab or Kaggle in Chrome, or an <code>.ipynb</code> file in VS Code, to chat with an agent about it.</p>
        </Welcome>
      ) : (
        <Transcript key={live?.chatId ?? notebook.key ?? tabId} chat={live} actions={actions} onSuggest={(text) => setDraft({ text })} />
      )}

      {live?.error && <div class="banner error">{live.error}</div>}
      {error && (
        <div class="banner error" role="alert">
          <span>{error}</span>
          <button class="icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {notebook && (
        <footer class="bottom chat-width">
          {pendingPrompts[0] && <PendingPrompt part={pendingPrompts[0]} more={pendingPrompts.length - 1} actions={actions} />}
          {pendingReviews.length > 1 && (
            <div class="bulk">
              <span>{pendingReviews.length} changes await review</span>
              <button class="primary small" onClick={() => pendingReviews.forEach((p) => actions.review(p.review.reviewId, true))}>
                Apply all
              </button>
              <button class="secondary small" onClick={() => pendingReviews.forEach((p) => actions.review(p.review.reviewId, false))}>
                Reject all
              </button>
            </div>
          )}
          <Composer
            history={history}
            running={running}
            draft={draft}
            placeholder={`Ask ${agentName}…`}
            disabled={changingOption || !live || live.agentId !== prefs.agentId || live.status === "starting" || !agentReady}
            onSend={send}
            onStop={() => live && void run(client.request("chat.cancel", { chatId: live.chatId }))}
            context={
              <ComposerContext
                notebook={notebook}
                settings={settings}
                onSettings={updateSettings}
                project={live?.project}
                onShowProject={() => live?.project?.id && void run(client.request("project.show", { projectId: live.project.id }))}
                onMoveProject={moveProject}
                saving={saving}
                onSaveNotebook={saveNotebook}
              />
            }
            tools={
              <>
                <Picker
                  label="Mode"
                  class={`scope scope-${settings.scope}`}
                  value={settings.scope}
                  title={SCOPE_HINT[settings.scope]}
                  options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s], title: SCOPE_HINT[s] }))}
                  onChange={(s) => updateSettings({ ...settings, scope: s as Scope })}
                />
                {modelOptions.map((o) => <OptionPicker key={o.id} option={o} disabled={optionsLocked} onSet={setOption} />)}
                <OptionsMenu label={agentName}>
                  <div class="option-row">
                    <span class="option-name">Agent</span>
                    <Picker
                      label="Agent"
                      value={prefs.agentId}
                      disabled={running || changingOption}
                      options={[
                        ...agents.map((a) => ({ value: a.id, label: a.available ? a.name : `${a.name} (not installed)`, disabled: !a.available, title: a.reason })),
                        { value: MANAGE, label: "Manage agents…", title: "Add or change agents in Settings" },
                      ]}
                      onChange={(id) => {
                        if (id === MANAGE) void run(client.request("studio.open", { view: "settings", section: "agents" }));
                        else setPrefs({ agentId: id });
                      }}
                    />
                  </div>
                  {moreOptions.length > 0 && <div class="options-caption">{agentName} options</div>}
                  {moreOptions.map((o) => (
                    <div key={o.id} class="option-row">
                      <span class="option-name" title={o.name}>{o.name}</span>
                      {o.kind === "select" ? (
                        <OptionPicker option={o} disabled={optionsLocked} onSet={setOption} />
                      ) : (
                        <input type="checkbox" class="switch" aria-label={o.name} checked={!!o.value} disabled={optionsLocked} onChange={(e) => setOption(o.id, e.currentTarget.checked)} />
                      )}
                    </div>
                  ))}
                </OptionsMenu>
              </>
            }
          />
          <div class="input-status">
            <label class="toggle" title="Show each change as a diff to apply or reject">
              <input type="checkbox" class="switch" checked={settings.review} onChange={(e) => updateSettings({ ...settings, review: e.currentTarget.checked })} />
              Review
            </label>
            <label class="toggle" title="Refuse the agent's requests to use its own tools on this computer (shell, file edits, web). Notebook content could try to talk the agent into them.">
              <input type="checkbox" class="switch" checked={settings.notebookOnly} onChange={(e) => updateSettings({ ...settings, notebookOnly: e.currentTarget.checked })} />
              Notebook only
            </label>
            {live?.status === "starting" && <span role="status">Starting {live.agentName}…</span>}
            {live?.usage && live.agentId === prefs.agentId && <ContextMeter usage={live.usage} />}
          </div>
        </footer>
      )}
    </div>
  );
}

const SCOPES: Scope[] = ["cell", "write", "auto"];
/** The agent picker's last entry: opens Settings › Agents, where agents are managed. */
const MANAGE = "\u0000manage";

function Welcome({ title = "Agent in Notebook", mark = false, text, children }: { title?: string; mark?: boolean; text?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="welcome">
      <div class="welcome-body">
        {mark && <div class="welcome-mark"><Icon name="notebook" /></div>}
        <h2>{title}</h2>
        <div class="welcome-text">{text ?? children}</div>
        {text ? children : null}
      </div>
    </div>
  );
}

/** A select drawn as a borderless toolbar button, like the model picker in VS Code's chat. */
function Picker({ label, value, options, onChange, disabled, title, class: cls }: {
  label: string;
  class?: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean; title?: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <span class={cls ? `picker ${cls}` : "picker"}>
      <select aria-label={label} title={title ?? label} value={value} disabled={disabled} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chev-d" />
    </span>
  );
}

function NotebookHeader({ notebook, tabId, choices, onPick, onMirror }: {
  notebook: NotebookInfo;
  tabId: number | null;
  choices: NotebookChoice[];
  onPick: (tabId: number) => void;
  onMirror: () => void;
}) {
  const chrome = tabId !== null && tabId < 0;
  const hasCurrentChoice = choices.some((choice) => choice.tabId === tabId);
  return (
    <header class="notebook-header">
      <div class="notebook-header-body chat-width">
        <div class="notebook-details">
          {choices.length > 1 ? (
            <div class="notebook-select" title={notebook.title}>
              <span class="notebook-title" aria-hidden="true">{notebook.title}</span>
              <Icon name="chev-d" />
              <select class="notebook-pick" aria-label="Notebook" value={hasCurrentChoice ? (tabId ?? "") : ""} onChange={(e) => onPick(Number(e.currentTarget.value))}>
                {!hasCurrentChoice && <option value="" disabled>{notebook.title}</option>}
                {choices.map((choice) => <option key={choice.tabId} value={choice.tabId}>{choiceLabel(choice)}</option>)}
              </select>
            </div>
          ) : (
            <div class="notebook-title" title={notebook.title}>{notebook.title}</div>
          )}
          <div class="notebook-meta">
            <span>{PLATFORM[notebook.platform]}{chrome ? " in Chrome" : ""}</span>
            {notebook.cellCount > 0 && <span>{notebook.cellCount} {notebook.cellCount === 1 ? "cell" : "cells"}</span>}
            <span class="kernel-state">
              <span class={`kdot k-${notebook.kernel}`} aria-hidden="true" />
              Kernel {notebook.kernel}
            </span>
          </div>
        </div>
        {chrome && (
          <button class="ctx-btn notebook-mirror" title="Open this notebook in VS Code: edits and runs go to the Chrome tab" aria-label="Open in VS Code" onClick={onMirror}>
            <Icon name="open" />
          </button>
        )}
      </div>
    </header>
  );
}

function ComposerContext({ notebook, settings, onSettings, project, onShowProject, onMoveProject, saving, onSaveNotebook }: {
  notebook: NotebookInfo;
  settings: ChatSettings;
  onSettings: (s: ChatSettings) => void;
  project?: ChatProject;
  onShowProject: () => void;
  onMoveProject: () => void;
  saving: boolean;
  onSaveNotebook: () => void;
}) {
  const targets = settings.targetCellIds.length ? settings.targetCellIds : notebook.selectedCellIds.length ? notebook.selectedCellIds : notebook.activeCellId ? [notebook.activeCellId] : [];
  const pinned = settings.targetCellIds.length > 0;
  if (!project && settings.scope !== "cell") return null;
  return (
    <div class="ctx-row">
      {project && (
        <span class={`ctx-chip project p-${project.state}`} title={projectTitle(project)}>
          <Icon name="folder" />
          <button class="ctx-name ctx-link" disabled={!project.id} onClick={onShowProject}>{project.name}{project.state === "pending" ? "…" : ""}</button>
          {project.state !== "ready" && project.state !== "pending" && <Icon name="warning" class="warn" />}
          <span class="ctx-sep" aria-hidden="true" />
          <button class="ctx-btn" title="Move to project…" aria-label="Move to project" onClick={onMoveProject}><Icon name="swap" /></button>
          <button class="ctx-btn" disabled={saving || project.state !== "ready"} title={saving ? "Saving…" : `Save this notebook, with its outputs, to the artifacts of ${project.name}`} aria-label="Save to project" onClick={onSaveNotebook}><Icon name="save" /></button>
        </span>
      )}
      {settings.scope === "cell" && (
        <span class="ctx-chip cells" title={pinned ? "The agent may change these pinned cells" : "The agent may change the selected cell"}>
          <Icon name="cell" />
          <span class="ctx-name" title={targets.join(", ") || undefined}>{targets.length ? targets.map((t) => t.slice(0, 8)).join(", ") : "Select a cell"}</span>
          {pinned ? (
            <button class="ctx-btn" title="Follow the selection again" aria-label="Unpin" onClick={() => onSettings({ ...settings, targetCellIds: [] })}><Icon name="close" /></button>
          ) : targets.length > 0 && (
            <button class="ctx-btn" title="Pin these cells" aria-label="Pin" onClick={() => onSettings({ ...settings, targetCellIds: targets })}><Icon name="pin" /></button>
          )}
        </span>
      )}
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
  return <span ref={ref} class="elapsed" aria-hidden="true" />;
}

const SUGGESTIONS: { icon: IconName; label: string; text: string }[] = [
  { icon: "notebook", label: "Explain this notebook", text: "Explain what this notebook does" },
  { icon: "wand", label: "Fix the selected cell", text: "Fix the error in the selected cell" },
  { icon: "chart", label: "Plot the training loss", text: "Add a section that plots the training loss" },
];

function Transcript({ chat, actions, onSuggest }: { chat: ChatSnapshot | null; actions: PartActions; onSuggest: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const hasMessages = !!chat?.messages.length;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !content.current) return;
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    // Streaming text, images and changes to the composer can all resize the view.
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    observer.observe(content.current);
    follow();
    return () => observer.disconnect();
  }, [hasMessages]);

  if (!chat || !hasMessages) {
    return (
      <Welcome title="What are you working on?" text={<p>Ask about your notebook, or get help editing and running cells.</p>}>
        <div class="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s.text} class="suggestion" onClick={() => onSuggest(s.text)}>
              <Icon name={s.icon} /><span>{s.label}</span><Icon name="chev-r" />
            </button>
          ))}
        </div>
      </Welcome>
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
          setBehind(!stick.current);
        }}
      >
        <div class="transcript-content chat-width" ref={content}>
          {chat.messages.map((m) => (
            <Message key={m.id} msg={m} actions={actions} live={m.id === liveId} />
          ))}
          {running && (
            <div class="working" role="status">
              <span class="dots" aria-hidden="true"><i /><i /><i /></span> Working <Elapsed since={last?.role === "agent" ? last.createdAt : Date.now()} />
            </div>
          )}
        </div>
      </div>
      {behind && (
        <button
          class="jump"
          onClick={() => {
            stick.current = true;
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
            setBehind(false);
          }}
        >
          <Icon name="chev-d" /> Jump to latest
        </button>
      )}
    </div>
  );
}

function Composer({ history, running, disabled, draft, placeholder, onSend, onStop, context, tools }: {
  history: string[];
  running: boolean;
  disabled: boolean;
  /** Text put in the box from outside (a suggestion); a new object each time. */
  draft: { text: string } | null;
  placeholder: string;
  onSend: (t: string) => Promise<boolean>;
  onStop: () => void;
  context: ComponentChildren;
  tools: ComponentChildren;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  /** Position in `history` while recalling earlier prompts with the arrow keys. */
  const recall = useRef<number | null>(null);
  useEffect(() => {
    if (!draft) return;
    recall.current = null;
    setText(draft.text);
    area.current?.focus();
  }, [draft]);
  const submit = async () => {
    const t = text.trim();
    if (!t || disabled || sending.current) return;
    sending.current = true;
    recall.current = null;
    setText("");
    area.current?.focus();
    try {
      if (!(await onSend(t))) setText((current) => current || text);
    } finally {
      sending.current = false;
    }
  };
  const sendLabel = running ? "Queue follow-up" : "Send";
  return (
    <div class="composer" onClick={(e) => { if (e.target === e.currentTarget) area.current?.focus(); }}>
      {context}
      <textarea
        ref={area}
        rows={1}
        aria-label="Message"
        placeholder={running ? "Queue a follow-up…" : placeholder}
        value={text}
        onInput={(e) => {
          recall.current = null;
          setText((e.target as HTMLTextAreaElement).value);
        }}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
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
      <div class="toolbar">
        <div class="toolbar-options">{tools}</div>
        <div class="toolbar-actions">
          {running && (
            <button class="send stop-agent" onClick={onStop} title="Stop the agent" aria-label="Stop">
              <Icon name="stop" />
            </button>
          )}
          <button class="send" onClick={() => void submit()} disabled={disabled || !text.trim()} title={`${sendLabel} (Enter)`} aria-label={sendLabel}>
            <Icon name="send" />
          </button>
        </div>
      </div>
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

const optionOrder = (o: AgentOption) => ["model", "thought_level", "mode"].indexOf(o.category ?? "") >>> 0;

/** One of the agent's own choices (model, effort…), as it listed them over ACP. */
function OptionPicker({ option, disabled, onSet }: { option: AgentOption; disabled: boolean; onSet: (id: string, v: string | boolean) => void }) {
  return (
    <Picker
      label={option.name}
      value={String(option.value)}
      disabled={disabled}
      options={(option.choices ?? []).map((c) => ({ value: c.value, label: c.name, title: c.description ?? undefined }))}
      onChange={(v) => onSet(option.id, v)}
    />
  );
}

/** The agent's button in the toolbar: opens a menu above the input box with the agent and its options. */
function OptionsMenu({ label, children }: { label: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span class="options" ref={root}>
      <button ref={button} class="options-btn" aria-haspopup="dialog" aria-expanded={open} aria-label="Agent and options" title={`Agent: ${label}. Change the agent and its options.`} onClick={() => setOpen(!open)}>
        <Icon name="sliders" /><span>{label}</span>
      </button>
      {open && <div class="options-menu" role="dialog" aria-label="Agent and options">{children}</div>}
    </span>
  );
}

function Setup({ bridge }: { bridge: BridgeState }) {
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
      <p>The agents run on your computer through a small local bridge. It starts by itself once <code>pnpm ainb install</code> has been run.</p>
      {busy ? <p role="status">Starting the bridge…</p> : <p role="status" class={`status ${bridge.conn}`}>{error ?? bridge.error}</p>}
      <div class="row-actions">
        <button class="primary" disabled={busy} onClick={() => connect("config.auto")}>{bridge.conn === "replaced" ? "Connect here" : "Start the bridge"}</button>
        <button class="secondary" disabled={busy} onClick={() => connect("config.prompt")}>Enter pairing token</button>
        {bridge.config.source === "manual" && <button class="linkish" disabled={busy} onClick={() => connect("config.reset")}>Use local configuration</button>}
      </div>
    </div>
  );
}

function projectTitle(p: ChatProject): string {
  const base = `OpenResearch project: ${p.name}${p.scratch ? " (where notebooks go when no project was chosen)" : ""}`;
  if (p.state === "pending") return `${base}\nWaiting for OpenResearch…`;
  if (p.state === "missing") return `${base}\n${p.error ?? "This project no longer exists."} Move the notebook to another project.`;
  if (p.state === "unavailable") return `${base}\nProject context unavailable: ${p.error ?? "OpenResearch is not running."}`;
  return `${base}\nThe agent knows its experiments, runs and artifacts. Click to show it in the side bar.`;
}

function choiceLabel(c: NotebookChoice): string {
  return `${PLATFORM[c.platform]} · ${c.title}${c.place === "chrome" ? " (Chrome)" : ""}`;
}
