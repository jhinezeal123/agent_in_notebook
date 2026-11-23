import { Fragment, type ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { SCOPE_HINT, SCOPE_LABEL, applyMessagePatch, diffLines, diffStats, readerChatKey, type AgentOption, type AppliedChange, type ChatCode, type ChatProject, type ChatSearchHit, type ChatSettings, type ChatSnapshot, type ChatUsage, type MachineStats, type MessagePatch, type NotebookInfo, type Part, type ReaderAnchor, type ReviewInfo, type Scope } from "@ainb/protocol";
import { DEFAULT_PREFS, type AttachedCell, type BridgeState, type NotebookChoice, type Prefs } from "./panel-messages.js";
import { usePanelHost } from "./host.js";
import { AttachedChip, Message, PendingPrompt, type PartActions } from "./parts.js";
import { Icon, type IconName } from "./icons.js";
import { MentorBar, WorkshopBar } from "./mentor-bar.js";
import { ReaderBar } from "./reader-bar.js";
import { dateSeparators, lastUserMessage, queuedMessageIds } from "./transcript.js";
import { kernelHint, loginHintFrom } from "./chat-hints.js";
import { exportChatMarkdown } from "./export-chat.js";
import { contextualSuggestions, matchSlashCommands, type SlashCommand } from "./slash-commands.js";
import { resolveLang, t, type LangPref, type UiLang } from "./i18n.js";
import type { MentorStage } from "@ainb/protocol";
import type { ReaderGuide } from "@ainb/protocol";

const PLATFORM = { colab: "Colab", kaggle: "Kaggle", jupyter: "Jupyter", vscode: "VS Code" } as const;

export function App() {
  const client = usePanelHost();
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => client.watchTab(setTabId), [client]);
  const [notebook, setNotebook] = useState<NotebookInfo | null>(null);
  /** Easy-read: the paper whose reading tab is in front; the chat is its tutor. */
  const [reader, setReader] = useState<{ paperId: string; title: string } | null>(null);
  const [readerGuide, setReaderGuide] = useState<ReaderGuide | null>(null);
  const [readerRevision, setReaderRevision] = useState(0);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const [choices, setChoices] = useState<NotebookChoice[]>([]);
  const [chat, setChat] = useState<ChatSnapshot | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [error, setError] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);
  const [loadedTab, setLoadedTab] = useState<number | null>(null);
  /** A suggestion put in the input box. */
  const [draft, setDraft] = useState<{ text: string } | null>(null);
  const [changingOption, setChangingOption] = useState(false);
  /** Cells the user attached ("Attach to Chat" in the notebook), sent with the next message. */
  const [attached, setAttached] = useState<AttachedCell[]>([]);
  /** Counts the times the user attached cells, so the input box takes the focus each time. */
  const [attachedAt, setAttachedAt] = useState(0);
  /** Cells an Edit put back in the composer; the host does not track them, so they ride along attachment updates until sent or removed. */
  const editedCells = useRef<AttachedCell[]>([]);
  /** The chat error the user dismissed; a different error shows the banner again. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  /** Search bar state (B4.2). */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"chat" | "all">("chat");
  const [searchIndex, setSearchIndex] = useState(0);
  const [crossHits, setCrossHits] = useState<ChatSearchHit[]>([]);
  const [crossLoading, setCrossLoading] = useState(false);
  /** Accessible polite announcement emitted only when a turn finishes (B5.3). */
  const [liveAnnounce, setLiveAnnounce] = useState("");
  const prevStatus = useRef<string | undefined>(undefined);
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
      else if (e.event === "command" && e.params === "chat.export") exportRef.current();
      else if (e.event === "attachments") {
        if (e.params.tabId !== tabRef.current) return;
        setAttached(mergeCells(editedCells.current, e.params.cells));
        if (e.params.added) setAttachedAt((n) => n + 1);
      }
      else if (e.event === "notebook") {
        if (e.params.tabId === tabRef.current) setNotebook(e.params.info);
      } else if (e.event === "bridge") {
        const { method, params } = e.params as { method: string; params: any };
        if (method === "reader.updated" && readerRef.current?.paperId === params.paperId) setReaderRevision((n) => n + 1);
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
        } else if (method === "chat.meta") {
          setChat((c) => {
            if (!c || c.chatId !== params.chatId) return c;
            return {
              ...c,
              ...("settings" in params ? { settings: params.settings } : {}),
              ...("options" in params ? { options: params.options } : {}),
              ...("project" in params ? { project: params.project } : {}),
              ...("code" in params ? { code: params.code } : {}),
            };
          });
        } else if (method === "chat.usage") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, usage: params.usage } : c));
        } else if (method === "chat.mentor") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, mentor: params.mentor } : c));
        } else if (method === "chat.workshop") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, workshop: params.workshop } : c));
        } else if (method === "chat.machine") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, machine: params.machine } : c));
        } else if (method === "chat.status") {
          setChat((c) => (c && c.chatId === params.chatId ? { ...c, status: params.status, error: params.error } : c));
        }
      }
    });
  }, []);

  const connected = bridge?.conn === "connected";
  useEffect(() => {
    let stale = false;
    if (reader && connected) void client.request<ReaderGuide | null>("reader.guide", { tabId }).then((guide) => {
      if (!stale) setReaderGuide(guide);
    }, () => {});
    return () => { stale = true; };
  }, [reader?.paperId, tabId, connected, readerRevision]);

  // Load the tab's notebook and chat whenever the tab or the connection changes.
  useEffect(() => {
    let stale = false;
    setChat(null);
    setNotebook(null);
    setReader(null);
    setLoadedTab(null);
    setAttached([]);
    editedCells.current = [];
    setDismissedError(null);
    if (tabId === null) return;
    void client.request<NotebookInfo | null>("tab.notebook", { tabId }).then((info) => tabRef.current === tabId && setNotebook(info), () => {});
    void client.request<{ paperId: string; title: string } | null>("tab.reader", { tabId }).then((paper) => tabRef.current === tabId && setReader(paper), () => {});
    void client.request<AttachedCell[]>("attachments.get", { tabId }).then((cells) => tabRef.current === tabId && setAttached(cells), () => {});
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

  // What the chat is about: a notebook, or (easy-read) a paper in its reading tab.
  const subjectKey = notebook?.key ?? (reader ? readerChatKey(reader.paperId) : undefined);
  // During a tab or document switch, ignore snapshots from the previous notebook.
  const live = chat && chat.tabId === tabId && chat.status !== "closed" && (!chat.notebookKey || chat.notebookKey === subjectKey) ? chat : null;
  const settings: ChatSettings =
    live?.agentId === prefs.agentId ? live.settings : { scope: prefs.scope, review: prefs.review, targetCellIds: [], notebookOnly: prefs.notebookOnly };
  /** chat.open's parameters for this tab: its notebook, or the paper its tutor reads. */
  const openParams = (agentId: string) => reader
    ? { tabId, agentId, settings, reader: { paperId: reader.paperId } }
    : { tabId, agentId, settings, platform: notebook?.platform, notebookKey: notebook?.key };

  // ACP exposes model choices when the session opens, before any prompt.
  useEffect(() => {
    if (!connected || !prefsReady || tabId === null || loadedTab !== tabId || (!notebook && !reader) || live?.agentId === prefs.agentId) return;
    if (!bridge?.agents.some((a) => a.id === prefs.agentId && a.available)) return;
    let stale = false;
    void client.request<ChatSnapshot>("chat.open", openParams(prefs.agentId)).then((snap) => {
      if (!stale && tabRef.current === tabId && agentRef.current === snap.agentId) adopt(snap);
    }, (e) => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [connected, prefsReady, loadedTab, tabId, notebook?.platform, notebook?.key, reader?.paperId, prefs.agentId, live?.agentId, bridge?.agents]);

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
    if (tabId === null || (!notebook && !reader)) return undefined;
    const snap = await run(client.request<ChatSnapshot>("chat.open", openParams(agentId)));
    if (snap && tabRef.current === tabId && agentRef.current === agentId) adopt(snap);
    return snap;
  };

  /** Send a message. `resendCells`: a resend carries the original message's cells and leaves the composer's attachments alone. */
  const send = async (text: string, resendCells?: AttachedCell[]) => {
    if (changingOption) return false;
    setError(null);
    setDismissedError(null);
    let c = live;
    if (!c || c.agentId !== prefs.agentId) c = (await openChat(prefs.agentId)) ?? null;
    if (!c) return false;
    if (c.tabId !== tabRef.current) return false;
    const cells = resendCells ?? attached;
    const ok = await run(client.request("chat.send", { chatId: c.chatId, text, ...(cells.length ? { cells } : {}) }));
    if (ok === undefined) return false;
    if (!resendCells && cells.length) {
      const sent = new Set(cells.map((x) => x.cellId));
      editedCells.current = editedCells.current.filter((x) => !sent.has(x.cellId));
      setAttached((current) => current.filter((x) => !sent.has(x.cellId)));
      // The cells went with this message; cells attached meanwhile stay for the next one.
      void client.request("attachments.remove", { tabId: c.tabId, cellIds: cells.map((x) => x.cellId) }).catch(() => {});
    }
    return true;
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const detach = (cellId: string) => {
    editedCells.current = editedCells.current.filter((c) => c.cellId !== cellId);
    setAttached((current) => current.filter((c) => c.cellId !== cellId));
    if (tabId !== null) void run(client.request("attachments.remove", { tabId, cellIds: [cellId] }));
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

  /** Export Chat as Markdown (B4.1). */
  const exportRef = useRef(() => {});
  exportRef.current = () => {
    if (!live) return;
    const md = exportChatMarkdown(live, notebook);
    const name = notebook?.title || reader?.title || live.notebookKey || "notebook-chat";
    void run(client.request("chat.export", { filename: name, content: md }));
  };

  const lang: UiLang = resolveLang(prefs.language);

  // Announce once when a running turn finishes (B5.3 polite aria-live).
  useEffect(() => {
    if (prevStatus.current === "running" && live?.status === "idle") {
      setLiveAnnounce(t("a11y.turnDone", lang));
      const timer = setTimeout(() => setLiveAnnounce(""), 3000);
      return () => clearTimeout(timer);
    }
    prevStatus.current = live?.status;
  }, [live?.status, lang]);

  // Global keyboard shortcuts (B4.2 Ctrl+F search, B5.3 Escape = stop when running, Ctrl+/ = focus composer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && live?.messages.length) {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setAttachedAt((n) => n + 1);
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      } else if (e.key === "Escape" && live?.status === "running") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== "SELECT") {
          void run(client.request("chat.cancel", { chatId: live.chatId }));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live?.chatId, live?.status, live?.messages.length, searchOpen, client, run]);

  // Cross-notebook search query (B4.2 phase 2).
  useEffect(() => {
    if (!searchOpen || searchScope !== "all") return;
    const q = searchQuery.trim();
    if (!q) { setCrossHits([]); return; }
    let stale = false;
    setCrossLoading(true);
    const timer = setTimeout(() => {
      void client.request<{ hits: ChatSearchHit[] }>("chats.search", { query: q, limit: 30 }).then(
        (r) => { if (!stale) setCrossHits(r.hits ?? []); },
        () => { if (!stale) setCrossHits([]); },
      ).finally(() => { if (!stale) setCrossLoading(false); });
    }, 220);
    return () => { stale = true; clearTimeout(timer); };
  }, [searchOpen, searchScope, searchQuery, client]);

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
  const [verifying, setVerifying] = useState(false);
  const verifyNotebook = () => {
    if (!live || verifying) return;
    setVerifying(true);
    void run(client.request("chat.verifyNotebook", { chatId: live.chatId })).finally(() => setVerifying(false));
  };

  const manageAgents = () => void run(client.request("studio.open", { view: "settings", section: "agents" }));

  const actions: PartActions = useMemo(
    () => ({
      answer: (promptId, optionId) => live && void run(client.request("chat.answer", { chatId: live.chatId, promptId, optionId })),
      review: (reviewId, accept) => live && void run(client.request("chat.review", { chatId: live.chatId, reviewId, accept })),
      cardAction: (cardId, actionId) => live && void run(client.request("chat.cardAction", { chatId: live.chatId, cardId, actionId })),
      focusCell: (cellId) => tabId !== null && void run(client.request("notebook.focus", { tabId, cellId })),
      // In a Mentor exercise the learner types every line themself; a paper's tutor has no notebook.
      insertCell: (source, cellType) => tabId !== null && !live?.mentor && !reader && void run(client.request("notebook.insert", { tabId, source, cellType })),
      // A citation in a paper tutor's answer: its reading tab goes there.
      ...(reader ? { cite: (anchor: ReaderAnchor) => tabId !== null && void run(client.request("reader.reveal", { tabId, anchor })) } : {}),
      // The transcript shows the outcome (a notice on the message); errors show in the banner.
      undo: async (messageId) => {
        if (live) await run(client.request("chat.undo", { chatId: live.chatId, messageId }));
      },
      changes: async (messageId) => {
        if (!live) return [];
        const res = await run(client.request<{ changes: AppliedChange[] }>("chat.changes", { chatId: live.chatId, messageId }));
        return res?.changes ?? [];
      },
      pin: (messageId, pinned) => {
        if (live) void run(client.request("chat.pin", { chatId: live.chatId, messageId, pinned }));
      },
      dequeue: (messageId) => {
        if (live) void run(client.request("chat.dequeue", { chatId: live.chatId, messageId }));
      },
      openImage: (mime, data, alt) => {
        void run(client.request("image.open", { mime, data, alt }));
      },
      openReviewDiff: (review: ReviewInfo) => {
        const title = `${review.kind} ${review.cellType} ${review.index !== undefined ? `[${review.index}]` : review.cellId.slice(0, 10)}`;
        void run(client.request("review.diff", { before: review.before, after: review.after, title, cellType: review.cellType }));
      },
      edit: (text, cells) => {
        editedCells.current = mergeCells(cells, editedCells.current);
        setAttached((current) => mergeCells(cells, current));
        setDraft({ text });
      },
      resend: (text, cells) => void sendRef.current(text, cells),
    }),
    [live?.chatId, tabId, !!live?.mentor, reader?.paperId],
  );

  const mentor = live?.mentor;
  /** A tutor's chat (Mentor's or a paper's): its mode is fixed, the notebook toggles do not apply. */
  const tutor = !!mentor || !!reader;
  const mentorCall = (method: string, extra: Record<string, unknown> = {}) => live && void run(client.request(method, { chatId: live.chatId, ...extra }));

  if (!bridge) return <div class="center muted">{error ?? "Loading…"}</div>;
  if (!connected) return <Setup bridge={bridge} lang={lang} onManageAgents={manageAgents} />;

  const agents = bridge.agents;
  const running = live?.status === "running";
  const queuedCount = live ? queuedMessageIds(live.messages, live.status).size : 0;
  const lastUser = live ? lastUserMessage(live.messages) : null;
  const allParts = (live?.messages ?? []).flatMap((m) => m.parts);
  const pendingReviews = allParts.filter((p): p is Extract<Part, { type: "review" }> => p.type === "review" && p.status === "pending");
  const pendingPrompts = allParts.filter((p): p is Extract<Part, { type: "prompt" }> => p.type === "prompt" && p.answer === undefined);
  const history = (live?.messages ?? []).filter((m) => m.role === "user").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
  const pinnedMessages = (live?.messages ?? []).filter((m) => m.pinned);

  const searchLower = searchOpen && searchScope === "chat" ? searchQuery.trim().toLowerCase() : "";
  const matchedMsgIds = useMemo(() => {
    if (!searchLower || !live) return [] as string[];
    return live.messages
      .filter((m) =>
        m.parts.some((p) => {
          if (p.type === "text" || p.type === "thought" || p.type === "notice") return p.text.toLowerCase().includes(searchLower);
          if (p.type === "tool") return p.title.toLowerCase().includes(searchLower) || (p.detail ?? "").toLowerCase().includes(searchLower);
          if (p.type === "card") return p.card.title.toLowerCase().includes(searchLower) || (p.card.detail ?? "").toLowerCase().includes(searchLower);
          return false;
        }),
      )
      .map((m) => m.id);
  }, [searchLower, live?.messages]);
  const activeSearchMsgId = matchedMsgIds.length ? matchedMsgIds[searchIndex % matchedMsgIds.length] : null;
  const scrollToMessage = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const scrollToReview = (reviewId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-review-id="${CSS.escape(reviewId)}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.focus(); }
  };

  const handleSlashCommand = (cmd: SlashCommand) => {
    if (cmd.run.kind === "action") {
      if (cmd.run.action === "save") saveNotebook();
      else if (cmd.run.action === "verify") verifyNotebook();
      else if (cmd.run.action === "clear") clearRef.current();
      else if (cmd.run.action === "compact") {
        void send("Summarize our work, decisions, and next steps concisely so I can continue in a fresh chat.");
      }
      return;
    }
    if (cmd.run.needsArg) setDraft({ text: cmd.run.text });
    else void send(cmd.run.text);
  };

  const agentReady = agents.some((a) => a.id === prefs.agentId && a.available);
  const agentName = agents.find((a) => a.id === prefs.agentId)?.name ?? "the agent";
  const agentReason = agents.find((a) => a.id === prefs.agentId)?.reason;
  const composerDisabled = changingOption || !live || live.agentId !== prefs.agentId || live.status === "starting" || !agentReady;
  // Why sending is blocked, said out loud; "starting" already speaks in the status line below.
  let blocked: string | null = null;
  if (!agentReady) blocked = `${agentName} is not available.${agentReason ? ` ${agentReason}` : ""}`;
  else if (changingOption) blocked = "Applying the option change…";
  else if (!live) blocked = "Opening the chat…";
  else if (live.agentId !== prefs.agentId) blocked = `Switching to ${agentName}…`;
  const signIn = blocked ? loginHintFrom(live?.error) ?? loginHintFrom(error) : null;
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
    <div class={mentor ? "app mentor-chat" : reader ? "app reader-chat" : "app"}>
      <div class="sr-only" aria-live="polite">{liveAnnounce}</div>
      {reader && (
        <header class="notebook-header">
          <div class="notebook-header-body chat-width">
            <div class="notebook-details">
              <div class="notebook-title" title={reader.title}>{reader.title}</div>
              <div class="notebook-meta">
                <span>Gia sư của paper · chọn một đoạn trong tab đọc để hỏi về nó</span>
              </div>
            </div>
            {live?.messages.length ? (
              <button class="ctx-btn" title={t("header.search", lang)} aria-label={t("header.search", lang)} onClick={() => setSearchOpen((v) => !v)}><Icon name="search" /></button>
            ) : null}
            <button class="ctx-btn" title="Về tab đọc của paper" aria-label="Về tab đọc của paper" onClick={() => tabId !== null && void run(client.request("reader.reveal", { tabId }))}><Icon name="notebook" /></button>
          </div>
        </header>
      )}
      {notebook && (
        <NotebookHeader
          notebook={notebook}
          machine={live?.machine}
          tabId={tabId}
          choices={choices}
          onPick={(id) => void run(client.request("notebooks.select", { tabId: id }))}
          onMirror={() => tabId !== null && void run(client.request("notebook.mirror", { tabId }))}
          onOpenChrome={() => void run(client.openLink(notebook.url))}
          onSearch={live?.messages.length ? () => setSearchOpen((v) => !v) : undefined}
          onExport={live?.messages.length ? () => exportRef.current() : undefined}
          code={live?.code}
          onPushCode={() => live && void run(client.request("chat.pushCode", { chatId: live.chatId }))}
          lang={lang}
        />
      )}
      {searchOpen && (
        <div class="search-bar chat-width" role="search">
          <input
            type="search"
            autoFocus
            value={searchQuery}
            placeholder={t(searchScope === "chat" ? "search.placeholder" : "search.allPlaceholder", lang)}
            onInput={(e) => { setSearchQuery((e.target as HTMLInputElement).value); setSearchIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchScope === "chat" && matchedMsgIds.length) {
                const next = (searchIndex + (e.shiftKey ? -1 : 1) + matchedMsgIds.length) % matchedMsgIds.length;
                setSearchIndex(next);
                scrollToMessage(matchedMsgIds[next]!);
              }
            }}
          />
          <button class={`linkish small${searchScope === "chat" ? " active" : ""}`} onClick={() => setSearchScope("chat")}>{t("search.thisChat", lang)}</button>
          <button class={`linkish small${searchScope === "all" ? " active" : ""}`} onClick={() => setSearchScope("all")}>{t("search.allChats", lang)}</button>
          {searchScope === "chat" && searchQuery.trim() && (
            <>
              <span class="muted small">{matchedMsgIds.length ? `${(searchIndex % matchedMsgIds.length) + 1}/${matchedMsgIds.length}` : t("search.noMatches", lang)}</span>
              {matchedMsgIds.length > 0 && (
                <>
                  <button class="icon" aria-label="Previous match" onClick={() => { const n = (searchIndex - 1 + matchedMsgIds.length) % matchedMsgIds.length; setSearchIndex(n); scrollToMessage(matchedMsgIds[n]!); }}>↑</button>
                  <button class="icon" aria-label="Next match" onClick={() => { const n = (searchIndex + 1) % matchedMsgIds.length; setSearchIndex(n); scrollToMessage(matchedMsgIds[n]!); }}>↓</button>
                </>
              )}
            </>
          )}
          <button class="icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setSearchQuery(""); }}><Icon name="close" /></button>
        </div>
      )}
      {searchOpen && searchScope === "all" && searchQuery.trim() && (
        <div class="cross-search-results chat-width">
          {crossLoading && <div class="muted small">Searching…</div>}
          {!crossLoading && !crossHits.length && <div class="muted small">{t("search.noMatches", lang)}</div>}
          {crossHits.map((h) => (
            <div key={`${h.notebookKey}:${h.messageId}`} class="cross-hit">
              <div class="cross-hit-head">
                <strong>{h.title || h.notebookKey}</strong>
                <span class="muted small">{h.role} · {new Date(h.createdAt).toLocaleDateString()}</span>
              </div>
              <div class="cross-hit-snippet">{h.snippet}</div>
            </div>
          ))}
        </div>
      )}
      {pinnedMessages.length > 0 && (
        <PinnedBar messages={pinnedMessages} onJump={scrollToMessage} onUnpin={(id) => actions.pin?.(id, false)} lang={lang} />
      )}
      {mentor && (
        <MentorBar
          mentor={mentor}
          busy={running || live?.status === "starting"}
          onJudge={() => mentorCall("mentor.judge")}
          onHint={() => mentorCall("mentor.hint")}
          onStage={(stage: MentorStage) => mentorCall("mentor.stage", { stage })}
          onCodeReview={() => mentorCall("mentor.codeReview")}
          onReport={(reason) => mentorCall("mentor.report", { reason })}
          onHome={() => void run(client.request("mentor.open"))}
        />
      )}
      {live?.workshop && (
        <WorkshopBar
          workshop={live.workshop}
          busy={running || live.status === "starting"}
          onApprove={() => mentorCall("mentor.paper.approve")}
          onAuthor={(opts) => mentorCall("mentor.paper.author", opts ?? {})}
          onStop={() => mentorCall("mentor.paper.stopAuthoring")}
          onHome={() => void run(client.request("mentor.open"))}
        />
      )}
      {readerGuide && readerGuide.paperId === reader?.paperId && <ReaderBar guide={readerGuide}
        quiz={() => void run(client.request("reader.reveal", { tabId, action: "quiz" }))} />}
      {!notebook && !reader ? (
        <Welcome mark>
          <p>Open a notebook on Colab or Kaggle in Chrome, or an <code>.ipynb</code> file in VS Code, to chat with an agent about it.</p>
          <ConnectionChecklist bridge={bridge} notebook={null} agentReady={agentReady} agentName={agentName} onManageAgents={manageAgents} lang={lang} />
        </Welcome>
      ) : (
        <Transcript
          key={live?.chatId ?? notebook?.key ?? reader?.paperId ?? tabId}
          chat={live}
          notebook={notebook}
          hasAttached={attached.length > 0}
          actions={actions}
          onSuggest={(text) => setDraft({ text })}
          paper={!!reader}
          mentor={!!mentor || !!live?.workshop}
          review={mentor?.kind === "review"}
          searchHits={new Set(matchedMsgIds)}
          activeSearchId={activeSearchMsgId}
        />
      )}

      {live?.error && live.error !== dismissedError && (
        <div class="banner error" role="alert">
          <span>{live.error}</span>
          {lastUser !== null && (
            <button class="linkish" disabled={composerDisabled} title="Send your last message again, unchanged" onClick={() => void send(lastUser.text, lastUser.cells)}>
              Send again
            </button>
          )}
          <button class="icon" aria-label="Dismiss" onClick={() => setDismissedError(live.error ?? null)}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {error && (
        <div class="banner error" role="alert">
          <span>{error}</span>
          <button class="icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {(notebook || reader) && (
        <footer class="bottom chat-width">
          {pendingPrompts[0] && <PendingPrompt part={pendingPrompts[0]} more={pendingPrompts.length - 1} actions={actions} />}
          {pendingReviews.length > 0 && (
            <ReviewTray
              reviews={pendingReviews.map((p) => p.review)}
              onJump={scrollToReview}
              onApply={(id) => actions.review(id, true)}
              onReject={(id) => actions.review(id, false)}
              onOpenDiff={(r) => actions.openReviewDiff?.(r)}
              lang={lang}
            />
          )}
          {blocked && (
            <div class="composer-blocked" role="status">
              <span>{blocked}</span>
              {!agentReady && <button class="linkish" onClick={manageAgents}>Manage agents…</button>}
              {signIn && <span class="composer-signin">{signIn}</span>}
            </div>
          )}
          <Composer
            history={history}
            running={running}
            queued={queuedCount}
            draft={draft}
            focusAt={attachedAt}
            placeholder={mentor ? "Trao đổi với mentor…" : reader ? "Hỏi gia sư về paper…" : attached.length ? `Ask ${agentName} about ${attached.length === 1 ? "this cell" : "these cells"}…` : `Ask ${agentName}… (type / for commands)`}
            disabled={composerDisabled}
            customSlash={prefs.slashTemplates}
            onSlash={handleSlashCommand}
            onSend={send}
            onStop={() => live && void run(client.request("chat.cancel", { chatId: live.chatId }))}
            context={notebook &&
              <ComposerContext
                notebook={notebook}
                settings={settings}
                onSettings={updateSettings}
                attached={attached}
                onFocusCell={actions.focusCell}
                onDetach={detach}
                project={live?.project}
                onShowProject={() => live?.project?.id && void run(client.request("project.show", { projectId: live.project.id }))}
                onMoveProject={moveProject}
                saving={saving}
                onSaveNotebook={saveNotebook}
                verifying={verifying}
                onVerifyNotebook={verifyNotebook}
              />
            }
            tools={
              <>
                {!tutor && <Picker
                  label="Access"
                  class={`scope scope-${settings.scope}`}
                  value={settings.scope}
                  title={SCOPE_HINT[settings.scope]}
                  options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s], title: SCOPE_HINT[s] }))}
                  onChange={(s) => updateSettings({ ...settings, scope: s as Scope })}
                />}
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
                        if (id === MANAGE) manageAgents();
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
                  <div class="option-row">
                    <span class="option-name">{t("options.language", lang)}</span>
                    <Picker
                      label={t("options.language", lang)}
                      value={prefs.language ?? "auto"}
                      options={[
                        { value: "auto", label: "Auto" },
                        { value: "en", label: "English" },
                        { value: "vi", label: "Tiếng Việt" },
                      ]}
                      onChange={(v) => setPrefs({ language: v as LangPref })}
                    />
                  </div>
                </OptionsMenu>
              </>
            }
          />
          <div class="input-status">
            {!tutor && <>
            <label class="toggle" title="Each change waits as a diff to apply or reject, and with Write + run each run or command waits for your OK. Off: the agent goes ahead without asking.">
              <input type="checkbox" class="switch" checked={settings.review} onChange={(e) => updateSettings({ ...settings, review: e.currentTarget.checked })} />
              Ask before changes
            </label>
            <label class="toggle" title="Refuse the agent's requests to use its own tools on this computer (shell, file edits, web). Notebook content could try to talk the agent into them.">
              <input type="checkbox" class="switch" checked={settings.notebookOnly} onChange={(e) => updateSettings({ ...settings, notebookOnly: e.currentTarget.checked })} />
              Notebook only
            </label>
            </>}
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

function NotebookHeader({ notebook, machine, tabId, choices, onPick, onMirror, onOpenChrome, onSearch, onExport, code, onPushCode, lang }: {
  notebook: NotebookInfo;
  machine?: MachineStats;
  tabId: number | null;
  choices: NotebookChoice[];
  onPick: (tabId: number) => void;
  onMirror: () => void;
  onOpenChrome: () => void;
  onSearch?: () => void;
  onExport?: () => void;
  code?: ChatCode;
  onPushCode: () => void;
  lang: UiLang;
}) {
  const chrome = tabId !== null && tabId < 0;
  const hasCurrentChoice = choices.some((choice) => choice.tabId === tabId);
  const resources = machineResources(machine);
  const hint = kernelHint(notebook.platform, notebook.kernel);
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
            <span class="kernel-state" title={hint ?? undefined} tabIndex={hint ? 0 : undefined}>
              <span class={`kdot k-${notebook.kernel}`} aria-hidden="true" />
              Kernel {notebook.kernel}
            </span>
            {code && <span><CodeState code={code} onPush={onPushCode} /></span>}
            {resources.map((resource) => <ResourceChip key={resource.key} resource={resource} at={machine!.at} />)}
            {hint && <span class="kernel-hint">{hint}</span>}
          </div>
        </div>
        {onSearch && (
          <button class="ctx-btn" title={t("header.search", lang)} aria-label={t("header.search", lang)} onClick={onSearch}>
            <Icon name="search" />
          </button>
        )}
        {onExport && (
          <button class="ctx-btn" title={t("header.export", lang)} aria-label={t("header.export", lang)} onClick={onExport}>
            <Icon name="download" />
          </button>
        )}
        {notebook.url && notebook.platform !== "vscode" && (
          <button class="ctx-btn notebook-chrome" title={t("header.openChrome", lang)} aria-label="Open in Chrome" onClick={onOpenChrome}>
            <Icon name="globe" />
          </button>
        )}
        {chrome && (
          <button class="ctx-btn notebook-mirror" title={t("header.openMirror", lang)} aria-label="Open in VS Code" onClick={onMirror}>
            <Icon name="open" />
          </button>
        )}
      </div>
    </header>
  );
}

/** The project's code on the notebook's machine: a green check when it is there; a red X, which puts it there, when not. */
function CodeState({ code, onPush }: { code: ChatCode; onPush: () => void }) {
  if (code.state === "ready") {
    return (
      <span class="code-state ok" title={`The project's code is on the notebook's machine at ${code.dir} (branch ${code.branch}).`}>
        <Icon name="check" /> Code
      </span>
    );
  }
  if (code.state === "pushing") {
    return (
      <span class="code-state busy" title="Putting the project's code on the notebook's machine…">
        <span class="spinner" aria-hidden="true" /> Code
      </span>
    );
  }
  if (code.state === "none") {
    return (
      <span class="code-state off" title={code.why ?? "The project's code is not put on this notebook's machine."}>
        <Icon name="close" /> Code
      </span>
    );
  }
  const why = code.why ? `${code.why}
` : "";
  return (
    <button type="button" class="code-state missing" title={`${why}Click to put the project's code on the notebook's machine now.`} aria-label="Put the project's code on the notebook's machine" onClick={onPush}>
      <Icon name="close" /> Code
    </button>
  );
}

type ResourceRow = { name: string; used: number; total: number; note?: string; warn: boolean };
type Resource = { key: string; label: string; warn: boolean; rows: ResourceRow[] };

function machineResources(machine?: MachineStats): Resource[] {
  if (!machine) return [];
  const out: Resource[] = [];
  if (machine.memTotal !== undefined && machine.memAvailable !== undefined && machine.memTotal > 0) {
    const warn = machine.memAvailable < machine.memTotal * 0.1;
    out.push({ key: "ram", label: "RAM", warn, rows: [{ name: "RAM", used: machine.memTotal - machine.memAvailable, total: machine.memTotal, warn }] });
  }
  // Every GPU of the machine (Kaggle's T4 x2 has two), each with its own row.
  const gpus = (machine.gpus ?? []).filter((g) => g.memTotal > 0);
  if (gpus.length) {
    const rows = gpus.map((g, i) => ({
      name: gpus.length > 1 ? `GPU ${i} · ${g.name}` : g.name,
      used: g.memUsed,
      total: g.memTotal,
      note: `${Math.round(g.util)}% busy`,
      warn: g.memUsed > g.memTotal * 0.9,
    }));
    out.push({ key: "gpu", label: "GPU", warn: rows.some((r) => r.warn), rows });
  }
  if (machine.diskTotal !== undefined && machine.diskFree !== undefined && machine.diskTotal > 0) {
    const warn = machine.diskFree < machine.diskTotal * 0.05;
    out.push({ key: "disk", label: "Disk", warn, rows: [{ name: "Disk", used: machine.diskTotal - machine.diskFree, total: machine.diskTotal, warn }] });
  }
  return out;
}

/** A machine resource in the header: just its name; hovering or focusing it shows the numbers. */
function ResourceChip({ resource, at }: { resource: Resource; at: number }) {
  const gb = (n: number) => `${(n / 1_000_000_000).toFixed(1)} GB`;
  const percent = (r: ResourceRow) => Math.max(0, Math.min(100, Math.round((r.used / r.total) * 100)));
  const asOf = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const summary = resource.rows.map((r) => `${r.name}: ${gb(r.used)} of ${gb(r.total)}${r.note ? `, ${r.note}` : ""}`).join("; ");
  return (
    <span class={`resource${resource.warn ? " warn" : ""}`} tabIndex={0} aria-label={`${resource.label}: ${summary}`}>
      {resource.label}
      <span class="resource-pop" role="tooltip">
        {resource.rows.map((r) => (
          <span key={r.name} class={`resource-row${r.warn ? " warn" : ""}`}>
            <span class="resource-head">
              <span class="resource-name">{r.name}</span>
              <span class="resource-pct">{percent(r)}%</span>
            </span>
            <span class="resource-bar"><span style={{ width: `${percent(r)}%` }} /></span>
            <span class="resource-nums">
              <span>{gb(r.used)} of {gb(r.total)}</span>
              {r.note && <span>{r.note}</span>}
            </span>
          </span>
        ))}
        <span class="resource-asof">As of {asOf}</span>
      </span>
    </span>
  );
}

function ComposerContext({ notebook, settings, onSettings, attached, onFocusCell, onDetach, project, onShowProject, onMoveProject, saving, onSaveNotebook, verifying, onVerifyNotebook }: {
  notebook: NotebookInfo;
  settings: ChatSettings;
  onSettings: (s: ChatSettings) => void;
  attached: AttachedCell[];
  onFocusCell: (cellId: string) => void;
  onDetach: (cellId: string) => void;
  project?: ChatProject;
  onShowProject: () => void;
  onMoveProject: () => void;
  saving: boolean;
  onSaveNotebook: () => void;
  verifying: boolean;
  onVerifyNotebook: () => void;
}) {
  // The cells the Cell mode may change, as the bridge picks them: pinned, else attached, else selected.
  const targets = settings.targetCellIds.length ? settings.targetCellIds
    : attached.length ? attached.map((c) => c.cellId)
    : notebook.selectedCellIds.length ? notebook.selectedCellIds : notebook.activeCellId ? [notebook.activeCellId] : [];
  const pinned = settings.targetCellIds.length > 0;
  if (!project && settings.scope !== "cell" && !attached.length) return null;
  return (
    <div class="ctx-row">
      {project && (
        <span class={`ctx-chip project p-${project.state}`} title={projectTitle(project)}>
          <Icon name="folder" />
          <button class="ctx-name ctx-link" disabled={!project.id} onClick={onShowProject}>{project.name}{project.state === "pending" ? "…" : ""}</button>
          {project.state !== "ready" && project.state !== "pending" && <Icon name="warning" class="warn" />}
          <span class="ctx-sep" aria-hidden="true" />
          <button class="ctx-btn" title="Move to project…" aria-label="Move to project" onClick={onMoveProject}><Icon name="swap" /></button>
          <button class="ctx-btn" disabled={saving || verifying || project.state !== "ready"} title={verifying ? "Starting verification…" : "Run all cells from a clean state, then save only if they pass"} aria-label="Verify and save" onClick={onVerifyNotebook}><Icon name="check" /></button>
          <button class="ctx-btn" disabled={saving || project.state !== "ready"} title={saving ? "Saving…" : `Save this notebook, with its outputs, to the artifacts of ${project.name}`} aria-label="Save to project" onClick={onSaveNotebook}><Icon name="save" /></button>
        </span>
      )}
      {attached.map((cell) => <AttachedChip key={cell.cellId} cell={cell} onFocus={() => onFocusCell(cell.cellId)} onRemove={() => onDetach(cell.cellId)} />)}
      {settings.scope === "cell" && (
        <span class="ctx-chip cells" title={pinned ? "The agent may change these pinned cells" : attached.length ? "The agent may change the attached cells" : "The agent may change the selected cell"}>
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

const REVIEW_SUGGESTIONS: { icon: IconName; label: string; text: string }[] = [
  { icon: "sparkle", label: "Bắt đầu ôn", text: "Chào mentor, mình bắt đầu ôn bài này từ cell trống." },
];

/** A paper's tutor, before the first question (easy-read). */
const PAPER_SUGGESTIONS: { icon: IconName; label: string; text: string }[] = [
  { icon: "sparkle", label: "Paper này giải quyết vấn đề gì?", text: "Paper này giải quyết vấn đề gì, và đóng góp chính là gì? Chỉ chỗ trong paper." },
  { icon: "notebook", label: "Nên đọc theo thứ tự nào?", text: "Mình nên đọc paper này theo thứ tự nào để nắm ý nhanh nhất, và mục nào có thể lướt qua?" },
  { icon: "flask", label: "Kiến thức nền cần có", text: "Để hiểu paper này mình cần biết trước những kiến thức nền nào? Mỗi thứ nói ngắn gọn vì sao cần." },
  { icon: "check", label: "Hỏi tôi một câu", text: "Hỏi mình một câu về phần mình vừa đọc để mình tự kiểm tra. Đừng nói đáp án trước khi mình trả lời." },
];

const MENTOR_SUGGESTIONS: { icon: IconName; label: string; text: string }[] = [
  { icon: "sparkle", label: "Bắt đầu buổi học", text: "Chào mentor, mình bắt đầu bài này. Mình đã chạy các cell Phòng công thức." },
  { icon: "notebook", label: "Kể lại công thức", text: "Mình hiểu công thức này như sau: " },
];

function Transcript({
  chat,
  notebook,
  hasAttached = false,
  actions,
  onSuggest,
  paper = false,
  mentor = false,
  review = false,
  searchHits,
  activeSearchId,
}: {
  chat: ChatSnapshot | null;
  notebook?: NotebookInfo | null;
  hasAttached?: boolean;
  actions: PartActions;
  onSuggest: (text: string) => void;
  /** A paper's tutor (easy-read). */
  paper?: boolean;
  mentor?: boolean;
  review?: boolean;
  searchHits?: Set<string>;
  activeSearchId?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const searchingRef = useRef(false);
  searchingRef.current = !!searchHits?.size;
  const [behind, setBehind] = useState(false);
  const hasMessages = !!chat?.messages.length;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !content.current) return;
    const follow = () => {
      if (stick.current && !searchingRef.current) el.scrollTop = el.scrollHeight;
    };
    // Streaming text, images and changes to the composer can all resize the view.
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    observer.observe(content.current);
    follow();
    return () => observer.disconnect();
  }, [hasMessages]);

  if (paper && (!chat || !hasMessages)) {
    return (
      <Welcome
        title="Đọc cùng gia sư"
        text={<p>Chọn một đoạn trong paper rồi bấm <b>Giải thích</b>, <b>Ví dụ cụ thể</b>, <b>Ký hiệu</b> hay <b>Vì sao?</b>, hoặc hỏi bất cứ điều gì. Gia sư đọc paper trước khi trả lời; bấm vào chỗ trích (như <b>§4.1</b>, <b>Eq. 3</b>) để tới đó trong paper.</p>}
      >
        <div class="suggestions">
          {PAPER_SUGGESTIONS.map((s) => (
            <button key={s.text} class="suggestion" onClick={() => onSuggest(s.text)}>
              <Icon name={s.icon} /><span>{s.label}</span><Icon name="chev-r" />
            </button>
          ))}
        </div>
      </Welcome>
    );
  }
  if (mentor && (!chat || !hasMessages)) {
    return (
      <Welcome
        title={review ? "Ôn lại từ trang trắng" : "Bắt đầu thôi"}
        text={review
          ? <p>Cài lại bài này từ cell trống, theo trí nhớ, khoảng 8 phút. Bấm <b>Chấm bài</b> khi xong: qua máy chấm là xong buổi ôn.</p>
          : <p>Chạy các cell <b>Phòng công thức</b> trong notebook, nhìn kỹ hình, rồi kể lại công thức bằng lời của bạn. Mentor sẽ hỏi lại, không code hộ.</p>}
      >
        <div class="suggestions">
          {(review ? REVIEW_SUGGESTIONS : MENTOR_SUGGESTIONS).map((s) => (
            <button key={s.text} class="suggestion" onClick={() => onSuggest(s.text)}>
              <Icon name={s.icon} /><span>{s.label}</span><Icon name="chev-r" />
            </button>
          ))}
        </div>
      </Welcome>
    );
  }
  if (!chat || !hasMessages) {
    const dynamic = contextualSuggestions({ notebook, usage: chat?.usage, hasAttached });
    return (
      <Welcome title="What are you working on?" text={<p>Ask about your notebook, or get help editing and running cells.</p>}>
        <div class="suggestions">
          {dynamic.map((s) => (
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
  const queued = queuedMessageIds(chat.messages, chat.status);
  const separators = dateSeparators(chat.messages);
  return (
    <div class="transcript-wrap">
      <div
        class="transcript"
        role="log"
        aria-label="Chat transcript"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setBehind(!stick.current);
        }}
      >
        <div class="transcript-content chat-width" ref={content}>
          {chat.messages.map((m) => (
            <Fragment key={m.id}>
              {separators.has(m.id) && <div class="date-sep" role="separator"><span>{separators.get(m.id)}</span></div>}
              <Message
                msg={m}
                actions={actions}
                live={m.id === liveId}
                queued={queued.has(m.id)}
                highlight={!!searchHits?.has(m.id)}
                activeHit={activeSearchId === m.id}
              />
            </Fragment>
          ))}
          {running && (
            <div class="working" role="status">
              <span class="dots" aria-hidden="true"><i /><i /><i /></span> Working <Elapsed since={last?.role === "agent" ? last.createdAt : Date.now()} />
              {queued.size > 0 && <span>· {queued.size} queued</span>}
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

function Composer({ history, running, queued, disabled, draft, focusAt, placeholder, customSlash, onSlash, onSend, onStop, context, tools }: {
  history: string[];
  running: boolean;
  /** User messages waiting behind the current turn; Stop asks before discarding them. */
  queued: number;
  disabled: boolean;
  /** Text put in the box from outside (a suggestion); a new object each time. */
  draft: { text: string } | null;
  /** Changes when the box should take the focus (cells were attached). */
  focusAt: number;
  placeholder: string;
  customSlash?: Prefs["slashTemplates"];
  onSlash?: (cmd: SlashCommand) => void;
  onSend: (t: string) => Promise<boolean>;
  onStop: () => void;
  context: ComponentChildren;
  tools: ComponentChildren;
}) {
  const [text, setText] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  /** Stop with a queue asks once, inline (the Undo pattern), before discarding it. */
  const [confirmStop, setConfirmStop] = useState(false);
  const slashMatches = useMemo(() => matchSlashCommands(text, customSlash), [text, customSlash]);
  useEffect(() => { setSlashIdx(0); }, [text]);
  useEffect(() => {
    if (!running || queued === 0) setConfirmStop(false);
  }, [running, queued]);
  /** Position in `history` while recalling earlier prompts with the arrow keys. */
  const recall = useRef<number | null>(null);
  useEffect(() => {
    if (!draft) return;
    recall.current = null;
    setText(draft.text);
    area.current?.focus();
  }, [draft]);
  useEffect(() => {
    if (focusAt) area.current?.focus();
  }, [focusAt]);
  const pickSlash = (cmd: SlashCommand) => {
    setText("");
    recall.current = null;
    onSlash?.(cmd);
    area.current?.focus();
  };
  const submit = async () => {
    const t = text.trim();
    if (!t || disabled || sending.current) return;
    const exact = slashMatches.find((c) => c.name.toLowerCase() === t.toLowerCase());
    if (exact && onSlash) {
      pickSlash(exact);
      return;
    }
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
      {slashMatches.length > 0 && onSlash && (
        <div class="slash-menu" role="listbox" aria-label="Slash commands">
          {slashMatches.map((cmd, idx) => (
            <button
              key={cmd.name}
              type="button"
              role="option"
              aria-selected={idx === slashIdx}
              class={`slash-item${idx === slashIdx ? " active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(cmd); }}
            >
              <span class="slash-name">{cmd.name}</span>
              <span class="slash-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
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
          if (slashMatches.length > 0 && onSlash) {
            if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              pickSlash(slashMatches[slashIdx % slashMatches.length]!);
              return;
            }
            if (e.key === "Escape") { e.preventDefault(); setText(""); return; }
          }
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
      {confirmStop && (
        <div class="stop-confirm">
          <span>Stop and discard {queued} queued message{queued === 1 ? "" : "s"}?</span>
          <button class="stop small" onClick={() => { setConfirmStop(false); onStop(); }}>Stop</button>
          <button class="secondary small" onClick={() => setConfirmStop(false)}>Keep</button>
        </div>
      )}
      <div class="toolbar">
        <div class="toolbar-options">{tools}</div>
        <div class="toolbar-actions">
          {running && (
            <button
              class="send stop-agent"
              onClick={() => { if (queued > 0 && !confirmStop) setConfirmStop(true); else onStop(); }}
              title={queued > 0 && !confirmStop ? "Stop the agent (asks about the queued messages)" : "Stop the agent"}
              aria-label="Stop"
            >
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

function PinnedBar({ messages, onJump, onUnpin, lang }: { messages: ChatSnapshot["messages"]; onJump: (id: string) => void; onUnpin: (id: string) => void; lang: UiLang }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="pinned-bar chat-width">
      <button class="linkish pinned-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="pin" /> {t("pinned.title", lang)} ({messages.length}) <Icon name={open ? "chev-d" : "chev-r"} />
      </button>
      {open && (
        <div class="pinned-list">
          {messages.map((m) => {
            const preview = m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").replace(/\s+/g, " ").trim().slice(0, 90) || "(message)";
            return (
              <div key={m.id} class="pinned-item">
                <button class="linkish pinned-jump" onClick={() => onJump(m.id)}>
                  <span class="muted small">{m.role === "user" ? "You" : "Agent"}:</span> {preview}
                </button>
                <button class="icon" aria-label={t("msg.unpin", lang)} title={t("msg.unpin", lang)} onClick={() => onUnpin(m.id)}>
                  <Icon name="close" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewTray({
  reviews,
  onJump,
  onApply,
  onReject,
  onOpenDiff,
  lang,
}: {
  reviews: ReviewInfo[];
  onJump: (reviewId: string) => void;
  onApply: (reviewId: string) => void;
  onReject: (reviewId: string) => void;
  onOpenDiff: (r: ReviewInfo) => void;
  lang: UiLang;
}) {
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    const per = reviews.map((r) => {
      const s = diffStats(diffLines(r.before, r.after));
      added += s.added;
      removed += s.removed;
      return { r, ...s };
    });
    return { added, removed, per };
  }, [reviews]);

  if (reviews.length === 1 && !open) {
    return (
      <div class="bulk review-tray">
        <button class="linkish small" onClick={() => onJump(reviews[0]!.reviewId)}>
          1 change awaits review ({t("review.shortcutHint", lang)})
        </button>
      </div>
    );
  }
  return (
    <div class="bulk review-tray">
      <div class="review-tray-head">
        <button class="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chev-d" : "chev-r"} /> {reviews.length} {t("review.trayTitle", lang)}
          <span class="stats">
            {" "}<span class="add">+{totals.added}</span> <span class="del">−{totals.removed}</span>
          </span>
        </button>
        <div class="review-tray-actions">
          {confirmAll ? (
            <>
              <span class="small">Apply {reviews.length} cells (+{totals.added}/−{totals.removed})?</span>
              <button class="primary small" onClick={() => { setConfirmAll(false); reviews.forEach((r) => onApply(r.reviewId)); }}>
                {t("review.confirmApply", lang)}
              </button>
              <button class="secondary small" onClick={() => setConfirmAll(false)}>
                {t("review.cancel", lang)}
              </button>
            </>
          ) : (
            <>
              <button class="primary small" onClick={() => setConfirmAll(true)}>
                {t("review.applyAll", lang)}
              </button>
              <button class="secondary small" onClick={() => reviews.forEach((r) => onReject(r.reviewId))}>
                {t("review.rejectAll", lang)}
              </button>
            </>
          )}
        </div>
      </div>
      {open && (
        <div class="review-tray-list">
          {totals.per.map(({ r, added, removed }) => (
            <div key={r.reviewId} class="review-tray-row">
              <button class="linkish review-tray-item" onClick={() => onJump(r.reviewId)}>
                <span>{r.kind} · {r.cellType} {r.index !== undefined ? `[${r.index}]` : r.cellId.slice(0, 8)}</span>
                {r.label && <span class="muted small"> {r.label}</span>}
              </button>
              <span class="stats"><span class="add">+{added}</span> <span class="del">−{removed}</span></span>
              <button class="linkish small" onClick={() => onOpenDiff(r)}>Diff</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionChecklist({
  bridge,
  notebook,
  agentReady,
  agentName,
  onManageAgents,
  lang,
}: {
  bridge: BridgeState;
  notebook: NotebookInfo | null;
  agentReady: boolean;
  agentName: string;
  onManageAgents: () => void;
  lang: UiLang;
}) {
  const client = usePanelHost();
  const bridgeOk = bridge.conn === "connected";
  const chromeOk = !!bridge.browserConnected;
  const nbOk = !!notebook;
  const kernelOk = !!notebook && notebook.kernel !== "disconnected" && notebook.kernel !== "unknown";
  const row = (ok: boolean, label: string, detail: string, action?: ComponentChildren) => (
    <li class={`doctor-row ${ok ? "ok" : "miss"}`}>
      <span class="doctor-mark" aria-hidden="true">{ok ? "✓" : "✗"}</span>
      <span class="doctor-label">{label}</span>
      <span class="doctor-detail muted small">{detail}</span>
      {action}
    </li>
  );
  return (
    <div class="doctor">
      <div class="doctor-title">{t("doctor.title", lang)}</div>
      <ul class="doctor-list">
        {row(
          bridgeOk,
          t("doctor.bridge", lang),
          bridgeOk ? (bridge.bridgeVersion ? `v${bridge.bridgeVersion}` : "connected") : bridge.conn,
          !bridgeOk && (
            <button class="linkish small" onClick={() => void client.copy("pnpm ainb install")}>
              {t("setup.copyInstall", lang)}
            </button>
          ),
        )}
        {row(
          chromeOk,
          t("doctor.chrome", lang),
          chromeOk ? "connected" : "optional for local .ipynb",
          bridgeOk && !chromeOk && (
            <button class="linkish small" onClick={() => void client.copy("chrome://extensions")}>
              {t("doctor.copyExt", lang)}
            </button>
          ),
        )}
        {row(
          nbOk,
          t("doctor.notebook", lang),
          nbOk ? notebook!.title : "none open",
          bridgeOk && !nbOk && (
            <span class="doctor-links">
              <button class="linkish small" onClick={() => void client.openLink("https://colab.research.google.com")}>{t("doctor.openColab", lang)}</button>
              <button class="linkish small" onClick={() => void client.openLink("https://www.kaggle.com/code")}>{t("doctor.openKaggle", lang)}</button>
            </span>
          ),
        )}
        {nbOk && row(kernelOk, t("doctor.kernel", lang), notebook!.kernel)}
        {bridgeOk && row(
          agentReady,
          t("doctor.agent", lang),
          agentReady ? agentName : "none available",
          !agentReady && (
            <button class="linkish small" onClick={onManageAgents}>{t("doctor.manageAgents", lang)}</button>
          ),
        )}
      </ul>
    </div>
  );
}

function Setup({ bridge, lang, onManageAgents }: { bridge: BridgeState; lang: UiLang; onManageAgents: () => void }) {
  const client = usePanelHost();
  const [error, setError] = useState<string>();
  const busy = bridge.conn === "connecting";
  const connect = (method: string) => {
    setError(undefined);
    void client.request(method).catch((e: Error) => setError(e.message));
  };
  return (
    <div class="setup pad">
      <h1>{t("setup.title", lang)}</h1>
      <p>{t("setup.desc", lang)} It starts by itself once <code>pnpm ainb install</code> has been run.</p>
      {busy ? <p role="status">Starting the bridge…</p> : <p role="status" class={`status ${bridge.conn}`}>{error ?? bridge.error}</p>}
      <div class="row-actions">
        <button class="primary" disabled={busy} onClick={() => connect("config.auto")}>{bridge.conn === "replaced" ? t("setup.connectHere", lang) : t("setup.start", lang)}</button>
        <button class="secondary" disabled={busy} onClick={() => connect("config.prompt")}>{t("setup.enterToken", lang)}</button>
        <button class="linkish" onClick={() => void client.copy("pnpm ainb install")}>{t("setup.copyInstall", lang)}</button>
        {bridge.config.source === "manual" && <button class="linkish" disabled={busy} onClick={() => connect("config.reset")}>{t("setup.useLocal", lang)}</button>}
      </div>
      <ConnectionChecklist bridge={bridge} notebook={null} agentReady={false} agentName="" onManageAgents={onManageAgents} lang={lang} />
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

/** Cells merged by id, the first list's order first: Edit puts cells back that the host does not track. */
function mergeCells(a: AttachedCell[], b: AttachedCell[]): AttachedCell[] {
  const seen = new Set(a.map((c) => c.cellId));
  return [...a, ...b.filter((c) => !seen.has(c.cellId))];
}
