// The detail pages of the compute backends that talk to a machine of yours or
// to your OpenResearch account: SSH hosts, Slurm, OpenResearch itself and
// Kaggle. Same queries, checks and wording as OpenResearch's own settings page
// (ui/src/components/SettingsPage.tsx), in VS Code's look.
//
// One difference: OpenResearch's page signs in and connects inside the page,
// in a terminal over a WebSocket, which a webview does not carry. Here
// "Connect" and "Sign in" open the terminal in VS Code (`terminal.run`), and
// "Check" in the page reads the result afterwards.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { queryOptions, useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { m } from "@orx/paraglide/messages.js";
import { fmtClock, ltr } from "@orx/i18n";
import { worstPerAlias } from "@orx/engineHosts";
import { accountErrorMessage } from "@orx/components/OpenResearchAccount";
import {
  AlphaXivNotConnectedError,
  timeAgo,
  type EngineHost,
  type OpenResearchSettings,
  type SlurmPreflight,
  type SlurmSettings,
  type SshConfigFile,
  type SshExecutionPreflight,
} from "@orx/api";
import { kaggleApi, type KaggleAccountQuota, type KaggleConfig, type KaggleQuotaHours } from "@orx/../../downstream/kaggle/ui/api";
import { Badge, ConfirmModal, Detail, Details, Diagnostic, ErrorText, ExtLink, Field, LoadingRow, Modal, Spinner, TextInput } from "./compute-ui.js";
import { hostRequest } from "./tunnel.js";
import { Button, Icon } from "./ui.js";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ terminal in VS Code

/** Open the terminal that connects to a host, or signs in to OpenResearch, in VS Code. */
function openTerminal(request: { command: "compute.connect"; backend: "ssh" | "slurm"; host: string; title: string } | { command: "login"; title: string }) {
  return hostRequest("terminal.run", request);
}

const TERMINAL_HINT = "A terminal opened in VS Code. Finish signing in there, then press Check.";

// ------------------------------------------------------------------ SSH

const SSH_MASTER_POLL_MS = 5_000;

function useSshMasterStatuses(hosts: string[]) {
  const { workspaceScope, isCurrentScope, setScopedQueryData } = useWorkspace();
  const { getSshMasterStatusQuery } = useWorkspace().queries;

  const scope = workspaceScope();
  const options = hosts.map((host) => getSshMasterStatusQuery(host));
  const queries = useQueries({ queries: options.map((query) => ({ ...query, refetchInterval: SSH_MASTER_POLL_MS })) });
  const statuses = Object.fromEntries(hosts.flatMap((host, index) => (queries[index].data ? [[host, queries[index].data.running]] : [])));
  const markRunning = (host: string) => {
    if (isCurrentScope(scope)) setScopedQueryData(getSshMasterStatusQuery(host).queryKey, { running: true });
  };
  return [statuses, markRunning] as const;
}

/** The run engine's view of a host, when it has one worth showing over the last manual check. */
function EngineHostCell({ host }: { host: EngineHost }) {
  let badge = <Badge tone="success">{m.settings_host_connected()}</Badge>;
  let note: string | null = null;

  if (host.status === "needs_auth") {
    badge = <Badge tone="warning">{m.status_needs_auth()}</Badge>;
  } else if (host.status === "backoff") {
    badge = <Badge tone="warning">{m.status_unreachable()}</Badge>;
    const since = fmtClock(host.sinceMs);
    note = host.nextRetryMs === null
      ? m.settings_host_since({ time: since })
      : m.settings_host_since_next_try({ time: since, next: fmtClock(host.nextRetryMs) });
  }

  return (
    <div className="ch-status" role="status">
      {badge}
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

const ENGINE_HOST_SHOWN: ReadonlySet<EngineHost["status"]> = new Set(["live", "backoff", "needs_auth"]);

function HostTestCell({ test, connecting, masterRunning, containerFailed = false }: { test: SshExecutionPreflight | undefined; connecting: boolean; masterRunning: boolean | null | undefined; containerFailed?: boolean }) {
  if (connecting) return <span role="status"><Badge>{m.settings_connecting()}</Badge></span>;
  if (test === undefined) return <Badge>{m.settings_page_not_checked()}</Badge>;
  const missingTools = test.missingTools ?? [];
  const disconnected = test.reachable && test.toolsFound && masterRunning === false;
  const badge = !test.reachable || containerFailed ? (
    <Badge tone="error">{m.settings_page_failed()}</Badge>
  ) : !test.toolsFound ? (
    <Badge tone="error">{missingTools.length === 1 ? m.settings_needs_tool({ tool: ltr(missingTools[0]) }) : m.settings_needs_tools()}</Badge>
  ) : disconnected ? (
    <Badge tone="warning">{m.settings_disconnected()}</Badge>
  ) : (
    <Badge tone="success">{m.settings_page_ready()}</Badge>
  );
  return (
    <div className="ch-status" role="status">
      {badge}
      {!disconnected && <span className="muted small">{timeAgo(test.testedAt)}</span>}
    </div>
  );
}

function SshDefaultHost({ settings }: { settings: { hosts: { host: string }[]; defaultHost: string | null } }) {
  const { saveSshDefault } = useWorkspace().api;
  const [saving, setSaving] = useState(false);
  return (
    <label className="row small muted">
      {m.ssh_default_host()}
      <select className="inp narrow" value={settings.defaultHost ?? ""} disabled={saving} onChange={(e) => {
        const host = e.currentTarget.value;
        setSaving(true);
        void saveSshDefault(host || null).catch((error: unknown) => {
          void hostRequest("message", { level: "error", text: errorMessage(error) });
        }).finally(() => setSaving(false));
      }}>
        <option value="">{m.settings_page_not_set_pass_host_per_launch()}</option>
        {settings.defaultHost && !settings.hosts.some((host) => host.host === settings.defaultHost) && <option value={settings.defaultHost}>{settings.defaultHost}</option>}
        {settings.hosts.map((host) => <option key={host.host} value={host.host}>{host.host}</option>)}
      </select>
    </label>
  );
}

function SshExecutionSettings({ host, connecting, reference, onChange }: {
  host: { host: string };
  connecting: boolean;
  reference: string | null;
  onChange: (reference: string | null) => void;
}) {
  const { saveSshHost } = useWorkspace().api;
  const save = useMutation({ mutationFn: saveSshHost, scope: { id: `ssh-settings-${host.host}` } });
  function change(value: string | null) {
    onChange(value);
    save.reset();
    if (value !== null && !value.trim()) return;
    save.mutate({ host: host.host, container: value?.trim() ?? null });
  }

  return (
    <details className="ch-advanced">
      <summary className="muted small">{m.new_project_advanced()}</summary>
      <div className="cform ch-advanced-body">
        <Field label={m.ssh_run_in()}>
          <select className="inp" value={reference !== null ? "container" : "host"} disabled={connecting} onChange={(e) => change(e.currentTarget.value === "container" ? "" : null)}>
            <option value="host">{m.ssh_direct_host()}</option>
            <option value="container">{m.ssh_existing_container()}</option>
          </select>
        </Field>
        {reference !== null && (
          <Field label={m.ssh_container_reference()}>
            <TextInput value={reference} disabled={connecting} required onChange={(e) => change(e.currentTarget.value)} />
          </Field>
        )}
        {save.error && <ErrorText>{save.error.message}</ErrorText>}
      </div>
    </details>
  );
}

/** ~/.ssh/config, edited as plain text (OpenResearch's editor, without the code editor). */
function SshConfigDialog({ onClose }: { onClose: () => void }) {
  const { getSshConfigQuery } = useWorkspace().queries;
  const { saveSshConfig } = useWorkspace().api;
  const { isCurrentScope, setScopedQueryData } = useWorkspace();
  const options = getSshConfigQuery();
  const fileQuery = useQuery(options);
  const [file, setFile] = useState<SshConfigFile | null>(() => fileQuery.data ?? null);
  const [draft, setDraft] = useState(() => fileQuery.data?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = file !== null && draft !== file.content;
  const loadError = !file && fileQuery.error ? fileQuery.error.message : null;

  useEffect(() => {
    if (!fileQuery.data || dirty || saving) return;
    setFile(fileQuery.data);
    setDraft(fileQuery.data.content);
  }, [fileQuery.data]);

  async function save() {
    if (!file || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveSshConfig(draft, file.content);
      if (!isCurrentScope(options.queryKey)) return;
      setScopedQueryData(options.queryKey, { ...file, content: draft });
      setFile({ ...file, content: draft });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const close = () => { if (dirty) setConfirmDiscard(true); else onClose(); };

  return (
    <>
      <Modal title={m.ssh_config_title()} onClose={close} locked={saving}>
        <code className="muted">~/.ssh/config</code>
        {loadError ? <ErrorText>{loadError}</ErrorText>
          : file === null ? <LoadingRow><Spinner /> {m.ssh_config_loading()}</LoadingRow>
            : <textarea className="inp mono ch-config" value={draft} spellCheck={false} onChange={(e) => { setDraft(e.currentTarget.value); setSaved(false); }} />}
        {error && <ErrorText>{error}</ErrorText>}
        {saved && <p className="muted small" role="status">{m.ssh_config_saved()}</p>}
        <div className="row end">
          <Button onClick={close} disabled={saving}>{m.settings_page_cancel()}</Button>
          <Button primary onClick={() => void save()} disabled={!dirty || saving}>{saving ? m.common_saving() : m.common_save()}</Button>
        </div>
      </Modal>
      {confirmDiscard && <ConfirmModal title={m.ssh_config_title()} text={m.ssh_config_discard_changes()} confirm={m.settings_page_cancel()} destructive onConfirm={onClose} onCancel={() => setConfirmDiscard(false)} />}
    </>
  );
}

export function SshSection() {
  const { useEngineHosts, setEngineHost } = useWorkspace().queries;
  const { takeHostConnect, onHostConnectRequest } = useWorkspace().events;
  const { retryEngineHost, testSshExecution } = useWorkspace().api;
  const { getSshSettingsQuery } = useWorkspace().queries;

  const hostsQuery = useQuery(getSshSettingsQuery());
  const hosts = hostsQuery.data?.hosts ?? (hostsQuery.isError ? [] : null);
  const [tests, setTests] = useState<Record<string, SshExecutionPreflight>>({});
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const activeAttempt = useRef(0);
  const [probing, setProbing] = useState(false);
  const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>({});
  const [connectingHost, setConnectingHost] = useState<string | null>(null);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const checkedHosts = hosts
    ?.filter((host) => {
      const test = tests[host.host] ?? host.lastTest;
      return test?.reachable && test.toolsFound;
    })
    .map((host) => host.host) ?? [];
  const [masterRunning, markMasterRunning] = useSshMasterStatuses(checkedHosts);
  const engineHosts = useEngineHosts();
  const engineByAlias = worstPerAlias(engineHosts ?? []);
  const [busyHost, setBusyHost] = useState<string | null>(null);
  const [hostError, setHostError] = useState<{ host: string; message: string } | null>(null);

  function connect(host: string) {
    activeAttempt.current += 1;
    setProbing(false);
    setConnectionFailed(false);
    setConnectingHost(host);
    setExpandedHosts((expanded) => ({ ...expanded, [host]: true }));
    setHostError(null);
    openTerminal({ command: "compute.connect", backend: "ssh", host, title: `SSH: ${host}` }).catch((error: unknown) => {
      setHostError({ host, message: errorMessage(error) });
    });
  }

  // A run's Connect lands here: start that host's flow and bring its row into view.
  useEffect(() => {
    const take = () => {
      const host = takeHostConnect();
      if (!host) return;
      connect(host);
      requestAnimationFrame(() => document.getElementById(`ssh-host-${host}`)?.scrollIntoView({ block: "center" }));
    };
    take();
    return onHostConnectRequest(take);
  }, []);

  /** Retry and Test on key hosts: one request, its error shown under the host's row. */
  async function hostAction(host: string, action: () => Promise<void>) {
    setBusyHost(host);
    setHostError(null);
    try {
      await action();
    } catch (error) {
      setHostError({ host, message: errorMessage(error) });
    } finally {
      setBusyHost(null);
    }
  }

  const retry = (host: string) => hostAction(host, async () => setEngineHost(await retryEngineHost(host)));

  const test = (host: string, reference: string | null) => hostAction(host, async () => {
    const result = await testSshExecution(host, reference?.trim() || null);
    setTests((tests) => ({ ...tests, [host]: result }));
  });

  function cancelConnect() {
    activeAttempt.current += 1;
    setProbing(false);
    setConnectionFailed(false);
    setConnectingHost(null);
  }

  /** After the terminal: check the host (and its container) the way the connection page does. */
  async function checkConnection(host: string, reference: string | null) {
    const attempt = ++activeAttempt.current;
    setProbing(true);
    try {
      const result = await testSshExecution(host, reference?.trim() || null);
      if (activeAttempt.current !== attempt) return;
      const ok = result.reachable && result.toolsFound && (reference === null || result.container?.ready === true);
      setTests((tests) => ({ ...tests, [host]: reference === null ? { ...result, container: null } : { ...result, container: result.container ?? { reference: reference.trim(), ready: false, error: result.error ?? null } } }));
      if (ok) {
        markMasterRunning(host);
        setConnectionFailed(false);
        setConnectingHost(null);
      } else {
        setConnectionFailed(true);
      }
    } catch (error) {
      if (activeAttempt.current !== attempt) return;
      const message = errorMessage(error);
      setConnectionFailed(true);
      setTests((tests) => ({ ...tests, [host]: {
        container: reference === null ? null : { reference: reference.trim(), ready: false, error: message },
        reachable: false, toolsFound: false, missingTools: [], error: message, testedAt: Date.now(),
      } }));
    } finally {
      if (activeAttempt.current === attempt) setProbing(false);
    }
  }

  return (
    <>
      {hostsQuery.error && <ErrorText>{hostsQuery.error.message}</ErrorText>}
      <div className="row between ch-toolbar">
        {hostsQuery.data && <SshDefaultHost settings={hostsQuery.data} />}
        <Button onClick={() => setConfigOpen(true)}><Icon name="gear" /> {m.ssh_configure_hosts()}</Button>
      </div>
      {configOpen && <SshConfigDialog onClose={() => setConfigOpen(false)} />}
      {hosts === null ? (
        <LoadingRow><Spinner /> {m.settings_page_reading_ssh_config()}</LoadingRow>
      ) : hosts.length === 0 ? (
        <p className="empty-box">{m.settings_page_no_hosts_found_in_ssh_config()}</p>
      ) : (
        <div className="hosts">
          {hosts.map((h) => {
            // Session-local result wins; the persisted one covers restarts.
            const reference = drafts[h.host] === undefined ? h.container ?? null : drafts[h.host];
            const executionTest = tests[h.host];
            const containerTest = reference !== null && executionTest?.container?.reference === reference.trim() ? executionTest : undefined;
            const hostTest = (reference !== null ? containerTest
              : executionTest?.container ? h.lastTest : executionTest ?? h.lastTest) as SshExecutionPreflight | undefined;
            const containerError = containerTest?.container?.error;
            const containerFailed = containerTest?.container?.ready === false;
            const connectionError = hostTest?.error || containerError;
            const connecting = connectingHost === h.host;
            const engine = engineByAlias.get(h.host);
            // A Test run this session speaks for a connected host; trouble on the host outranks it.
            const engineShown = !connecting && engine !== undefined && ENGINE_HOST_SHOWN.has(engine.status)
              && !(engine.status === "live" && executionTest) ? engine : null;
            const keyHost = engine?.class === "key" && !engine.connectRequired;
            // Key hosts need no Connect: Retry while backing off, otherwise Test.
            const keyAction = !keyHost || engineShown?.status === "needs_auth" ? null : engineShown?.status === "backoff" ? "retry" : "test";
            const open = expandedHosts[h.host] ?? false;
            const hasTerminal = connecting || Boolean(connectionError);
            const address = `${h.user ? `${h.user}@` : ""}${h.hostname ?? h.host}${h.port ? `:${h.port}` : ""}`;
            return (
              <div key={h.host} id={`ssh-host-${h.host}`} data-ssh-host={h.host} className="ch-host">
                <div className="ch-host-row">
                  <div className="ch-host-name">
                    <b title={h.host}>{h.host}</b>
                    <span className="muted small" title={address}>{address}</span>
                  </div>
                  <div className="ch-host-state">
                    {engineShown
                      ? <EngineHostCell host={engineShown} />
                      : <HostTestCell test={hostTest} connecting={connecting && !connectionFailed} masterRunning={keyHost ? undefined : masterRunning[h.host]} containerFailed={containerFailed} />}
                    {hasTerminal && (
                      <button type="button" className="ib" aria-expanded={open}
                        aria-label={open ? m.a11y_collapse_item({ name: ltr(h.host) }) : m.a11y_expand_item({ name: ltr(h.host) })}
                        onClick={() => setExpandedHosts((expanded) => ({ ...expanded, [h.host]: !open }))}>
                        <Icon name={open ? "chev-d" : "chev-r"} />
                      </button>
                    )}
                  </div>
                  {keyAction ? (
                    <Button small disabled={busyHost === h.host} onClick={() => void (keyAction === "retry" ? retry(h.host) : test(h.host, reference))}>
                      {keyAction === "retry" ? m.app_retry() : m.settings_host_test()}
                    </Button>
                  ) : (
                    <Button small primary={engineShown?.status === "needs_auth"}
                      onClick={() => { if (connecting && !connectionFailed) cancelConnect(); else connect(h.host); }}
                      disabled={!connecting && ((connectingHost !== null && !connectionFailed) || (reference !== null && !reference.trim()))}>
                      {connecting
                        ? connectionFailed ? m.app_retry() : m.settings_page_cancel()
                        : engineShown?.status === "needs_auth" ? m.settings_connect()
                          : hostTest?.reachable === false || containerFailed ? m.app_retry()
                            : hostTest ? m.settings_reconnect() : m.settings_connect()}
                    </Button>
                  )}
                </div>
                {hostError?.host === h.host && <ErrorText>{hostError.message}</ErrorText>}
                <SshExecutionSettings host={h} connecting={connecting && !connectionFailed} reference={reference}
                  onChange={(value) => {
                    if (connecting) cancelConnect();
                    setDrafts((drafts) => ({ ...drafts, [h.host]: value }));
                    setTests((tests) => {
                      const next = { ...tests };
                      delete next[h.host];
                      return next;
                    });
                  }} />
                {hasTerminal && open && (
                  <div className="ch-terminal">
                    {connecting && !connectionFailed && (
                      <div className="row">
                        <span className="muted small">{TERMINAL_HINT}</span>
                        <Button small primary disabled={probing} onClick={() => void checkConnection(h.host, reference)}>{probing ? m.common_checking() : m.settings_check_again()}</Button>
                        <Button small onClick={() => openTerminal({ command: "compute.connect", backend: "ssh", host: h.host, title: `SSH: ${h.host}` }).catch((e: unknown) => setHostError({ host: h.host, message: errorMessage(e) }))}>Open terminal again</Button>
                      </div>
                    )}
                    {connectionError && <pre className="term" aria-label={m.settings_ssh_connection_terminal({ host: ltr(h.host) })}>{connectionError}</pre>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Slurm

/** First failing check wins, like K8sHealthBadge. */
function SlurmTestBadge({ test, connecting, masterRunning }: { test: SlurmPreflight | null; connecting: boolean; masterRunning: boolean | null | undefined }) {
  if (connecting) return <Badge>{m.settings_connecting()}</Badge>;
  if (test === null) return <Badge>{m.settings_page_not_checked()}</Badge>;
  if (!test.reachable) return <Badge tone="error">{m.settings_page_failed()}</Badge>;
  if (!test.slurmFound) return <Badge tone="error">{m.settings_page_no_slurm_cli()}</Badge>;
  if (!test.toolsFound) return <Badge tone="error">{m.settings_page_missing_bash_tar()}</Badge>;
  if (masterRunning === false) return <Badge tone="warning">{m.settings_disconnected()}</Badge>;
  return <Badge tone="success">{m.settings_page_ready()}</Badge>;
}

export function SlurmSection() {
  const { saveSlurmSettings, post } = useWorkspace().api;
  const { getSlurmSettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData } = useWorkspace();

  const saveSlurmSettingsMutation = useMutation({ mutationFn: saveSlurmSettings });

  const settingsOptions = getSlurmSettingsQuery();
  const settingsQuery = useQuery(settingsOptions);
  const settings = settingsQuery.data ?? null;
  const setSettings = (value: React.SetStateAction<SlurmSettings | null>) => {
    setScopedQueryData(settingsOptions.queryKey, (current) => (typeof value === "function" ? value(current ?? null) : value) ?? undefined);
  };
  const loadError = settings ? null : settingsQuery.error?.message ?? null;
  const [host, setHost] = useState("");
  const [partition, setPartition] = useState("");
  const [account, setAccount] = useState("");
  const [timeLimit, setTimeLimit] = useState("");
  const [cpusPerTask, setCpusPerTask] = useState("");
  const [mem, setMem] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<SlurmPreflight | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [probing, setProbing] = useState(false);
  const readyHost = host && test?.reachable && test.slurmFound && test.toolsFound ? [host] : [];
  const [masterRunning, markMasterRunning] = useSshMasterStatuses(readyHost);

  function connect() {
    setConnectionFailed(false);
    setConnecting(true);
    openTerminal({ command: "compute.connect", backend: "slurm", host, title: `Slurm: ${host}` }).catch((e: unknown) => setError(errorMessage(e)));
  }

  /** After the terminal: the live check of the login node. */
  async function checkConnection() {
    if (!host) return;
    setProbing(true);
    setError(null);
    try {
      const result = await post<SlurmPreflight>("/api/settings/slurm/preflight", { host });
      setTest(result);
      if (result.reachable && result.slurmFound && result.toolsFound) {
        markMasterRunning(host);
        setConnectionFailed(false);
        setConnecting(false);
      } else {
        setConnectionFailed(true);
      }
    } catch (e) {
      setConnectionFailed(true);
      setTest({ reachable: false, slurmFound: false, toolsFound: false, partitions: [], error: errorMessage(e) });
    } finally {
      setProbing(false);
    }
  }

  const apply = (s: SlurmSettings) => {
    setSettings(s);
    setHost(s.host ?? "");
    setPartition(s.partition ?? "");
    setAccount(s.account ?? "");
    setTimeLimit(s.timeLimit ?? "");
    setCpusPerTask(s.cpusPerTask === null ? "" : String(s.cpusPerTask));
    setMem(s.mem ?? "");
  };

  const previousSettings = useRef<SlurmSettings | null>(null);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    if (settings && (!previous || (
      host === (previous.host ?? "")
      && partition.trim() === (previous.partition ?? "")
      && account.trim() === (previous.account ?? "")
      && timeLimit.trim() === (previous.timeLimit ?? "")
      && cpusPerTask.trim() === (previous.cpusPerTask === null ? "" : String(previous.cpusPerTask))
      && mem.trim() === (previous.mem ?? "")
    ))) {
      setHost(settings.host ?? "");
      setPartition(settings.partition ?? "");
      setAccount(settings.account ?? "");
      setTimeLimit(settings.timeLimit ?? "");
      setCpusPerTask(settings.cpusPerTask === null ? "" : String(settings.cpusPerTask));
      setMem(settings.mem ?? "");
    }
  }, [settings, host, partition, account, timeLimit, cpusPerTask, mem]);

  const unchanged =
    settings !== null &&
    host === (settings.host ?? "") &&
    partition.trim() === (settings.partition ?? "") &&
    account.trim() === (settings.account ?? "") &&
    timeLimit.trim() === (settings.timeLimit ?? "") &&
    cpusPerTask.trim() === (settings.cpusPerTask === null ? "" : String(settings.cpusPerTask)) &&
    mem.trim() === (settings.mem ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      apply(
        await saveSlurmSettingsMutation.mutateAsync({
          host,
          partition: partition.trim(),
          account: account.trim(),
          timeLimit: timeLimit.trim(),
          // Blank means "clear it"; the API reads 0 as back-to-partition-default.
          cpusPerTask: Number(cpusPerTask.trim()) || 0,
          mem: mem.trim(),
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (!settings) return <LoadingRow><Spinner /> {m.settings_page_loading_slurm_settings()}</LoadingRow>;
  return (
    <>
      {!connecting && test?.error && <Diagnostic>{test.error}</Diagnostic>}
      <form className="cform" onSubmit={submit}>
        <Field label={m.settings_page_login_node()}>
          <select className="inp narrow" value={host} disabled={saving || connecting} onChange={(e) => {
            setHost(e.currentTarget.value);
            setTest(null); // a badge earned by cluster A must not vouch for cluster B
            setConnecting(false);
            setConnectionFailed(false);
          }}>
            <option value="">{m.settings_page_not_set_pass_host_per_launch()}</option>
            {host && !settings.hosts.some((item) => item.host === host) && <option value={host}>{`${host} (not in ~/.ssh/config)`}</option>}
            {settings.hosts.map((item) => <option key={item.host} value={item.host}>{item.host}</option>)}
          </select>
        </Field>
        <div className="row">
          <Button disabled={!host} onClick={() => {
            if (connecting && !connectionFailed) {
              setConnectionFailed(false);
              setConnecting(false);
            } else {
              connect();
            }
          }}>
            {connecting ? connectionFailed ? m.app_retry() : m.settings_page_cancel() : test ? m.settings_reconnect() : m.settings_connect()}
          </Button>
          {!host && <span className="muted small">{m.settings_pick_login_node()}</span>}
          <span role="status">
            <SlurmTestBadge test={test} connecting={connecting && !connectionFailed} masterRunning={masterRunning[host]} />
          </span>
        </div>
        {connecting && !connectionFailed && (
          <div className="row">
            <span className="muted small">{TERMINAL_HINT}</span>
            <Button small primary disabled={probing} onClick={() => void checkConnection()}>{probing ? m.common_checking() : m.settings_check_again()}</Button>
            <Button small onClick={() => openTerminal({ command: "compute.connect", backend: "slurm", host, title: `Slurm: ${host}` }).catch((e: unknown) => setError(errorMessage(e)))}>Open terminal again</Button>
          </div>
        )}
        {connecting && connectionFailed && test?.error && <pre className="term">{test.error}</pre>}
        <div className="cform ch-section">
          <div className="two">
            <Field label={m.settings_page_partition()}>
              <TextInput type="text" list="slurm-partitions" value={partition} onChange={(e) => setPartition(e.currentTarget.value)} placeholder={m.settings_page_cluster_default()} autoComplete="off" spellCheck={false} />
              <datalist id="slurm-partitions">{test?.partitions.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
            <Field label={m.settings_page_account()}>
              <TextInput type="text" value={account} onChange={(e) => setAccount(e.currentTarget.value)} placeholder={m.settings_page_cluster_default()} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          <Field label={m.settings_page_time_limit()}>
            <TextInput type="text" value={timeLimit} onChange={(e) => setTimeLimit(e.currentTarget.value)} placeholder={m.settings_page_cluster_default_e_g_4h_30m()} autoComplete="off" spellCheck={false} />
          </Field>
          <div className="two">
            <Field label={m.settings_slurm_cpus_per_job()}>
              <TextInput type="number" min={1} value={cpusPerTask} onChange={(e) => setCpusPerTask(e.currentTarget.value)} placeholder={m.settings_slurm_cpus_placeholder()} autoComplete="off" />
            </Field>
            <Field label={m.settings_slurm_memory()}>
              <TextInput type="text" value={mem} onChange={(e) => setMem(e.currentTarget.value)} placeholder={m.settings_slurm_memory_placeholder()} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="row end">
          <button type="submit" className="btn primary" disabled={saving || unchanged || connecting}>{saving ? m.common_saving() : m.common_save()}</button>
        </div>
      </form>
    </>
  );
}

// ------------------------------------------------------------------ OpenResearch

function SshKeyCard({ sshKey }: { sshKey: NonNullable<OpenResearchSettings["sshKeyToAdd"]> }) {
  const { useAddOpenResearchSshKey } = useWorkspace().queries;
  const add = useAddOpenResearchSshKey();
  const [added, setAdded] = useState(false);
  return (
    <div className="setting-card">
      <code dir="ltr" className="ch-break">{sshKey.path}</code>
      {sshKey.fingerprint ? <code dir="ltr" className="muted small ch-break">{sshKey.fingerprint}</code> : <span className="muted small">{m.settings_ssh_key_new()}</span>}
      <p dir="auto" className="muted small">{m.settings_ssh_key_upload_note()}</p>
      {add.error && <ErrorText>{add.error.message}</ErrorText>}
      {added && <p className="ok-text small" role="status">{m.settings_ssh_key_added()}</p>}
      <div className="row end">
        <Button primary disabled={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: () => setAdded(true) })}>
          {add.isPending ? <Spinner /> : <Icon name="check" />} {add.isPending ? m.settings_ssh_key_adding() : add.isError ? m.app_retry() : m.settings_ssh_key_add()}
        </Button>
      </div>
    </div>
  );
}

export function OpenResearchSection({ remote }: { remote: boolean }) {
  const { getOpenResearchSettingsQuery, useOpenResearchAccount, useAlphaXivFolders, useSignOutOpenResearch } = useWorkspace().queries;

  const settingsQuery = useQuery(getOpenResearchSettingsQuery());
  const accountQuery = useOpenResearchAccount();
  // A remote workspace's settings come from the remote host but its account from this machine; don't pair them.
  const account = remote ? undefined : accountQuery.data;
  const accountFailed = !remote && accountQuery.isError;
  const folders = useAlphaXivFolders();
  const alphaXivStatus = folders.isSuccess ? m.library_connected() : folders.error instanceof AlphaXivNotConnectedError ? m.library_not_connected() : null;
  const [editProfileBefore, editProfileAfter] = m.settings_openresearch_edit_profile({ settings: "\0" }).split("\0");
  const accountError = remote ? null : accountErrorMessage(accountQuery.error);
  const s = settingsQuery.data;
  const signedOut = account && !account.loggedIn;
  const expired = signedOut && s?.loggedIn;
  const loadError = settingsQuery.error?.message;
  const busy = settingsQuery.isFetching;
  const refresh = () => { void accountQuery.refetch(); return settingsQuery.refetch(); };
  const logout = useSignOutOpenResearch();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInOpened, setSignInOpened] = useState(false);
  const user = account?.user ?? null;
  const userName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "";

  return (
    <>
      {loadError && !s ? (
        <ErrorText>{loadError}</ErrorText>
      ) : (
        <>
          <Details>
            <Detail label={m.settings_page_status()}>
              {!s && busy ? (
                <Badge><Spinner />{m.common_checking()}</Badge>
              ) : signedOut ? (
                <Badge tone="warning">{m.settings_page_not_signed_in()}</Badge>
              ) : loadError || s?.error || accountFailed ? (
                <Badge tone="warning">{m.settings_page_unable_to_verify()}</Badge>
              ) : !s ? null : !s.loggedIn ? (
                <Badge tone="warning">{m.settings_page_not_signed_in()}</Badge>
              ) : s.sshKeyStatus === "matched" ? (
                <Badge tone="success">{m.settings_page_ready()}</Badge>
              ) : s.sshKeyStatus === "unknown" ? (
                <Badge tone="warning">{m.settings_page_unable_to_verify()}</Badge>
              ) : (
                <Badge tone="warning">{m.settings_page_not_configured()}</Badge>
              )}
            </Detail>
            {s?.loggedIn && !signedOut && <>
              {!remote && !accountFailed && (
                <Detail label={account?.user?.alphaxivUrl ? m.settings_openresearch_alphaxiv_account() : m.settings_page_account()}>
                  {accountQuery.isLoading ? m.common_checking() : <>
                    {user ? <span dir="auto"><b>{userName}</b><br /><span className="muted">{user.email}</span></span> : <span>{m.settings_openresearch_account_unavailable()}</span>}
                    {alphaXivStatus && <span className="muted small ch-full">{alphaXivStatus}</span>}
                    {account?.user?.alphaxivUrl && <span className="muted small ch-full">{editProfileBefore}<ExtLink href={new URL("/settings", account.user.alphaxivUrl).href}>{m.settings_openresearch_alphaxiv_settings()}</ExtLink>{editProfileAfter}</span>}
                  </>}
                </Detail>
              )}
              <Detail label={m.settings_openresearch_organizations()}>
                {s.organizations == null ? "—" : s.organizations.length === 0 ? m.settings_openresearch_no_orgs() : (
                  <ul className="ch-list">
                    {s.organizations.map((org) => (
                      <li key={org.id}>
                        <div dir="auto">{org.name}{account?.user?.id === org.createdBy && <span className="muted small"> · {m.settings_openresearch_owner()}</span>}</div>
                        {s.organizations && s.organizations.length > 1 && <code className="muted small ch-break">{org.id}</code>}
                      </li>
                    ))}
                  </ul>
                )}
                {s.organizations && s.organizations.length > 0 && <p className="muted small ch-full">{s.organizations.length === 1 ? m.settings_openresearch_one_org() : m.settings_openresearch_choose_org()}</p>}
              </Detail>
            </>}
            <Detail label={m.settings_page_ssh_key()}>
              {!s?.loggedIn || signedOut ? "—" : s.sshKeyStatus === "matched" ? (
                <Badge tone="success">{m.settings_page_on_this_computer()}</Badge>
              ) : s.sshKeyStatus === "no_local_match" ? (
                <Badge tone="warning">{m.settings_page_not_on_this_computer()}</Badge>
              ) : s.sshKeyStatus === "none_registered" ? (
                <Badge tone="error">{m.settings_page_none_registered()}</Badge>
              ) : (
                <Badge>{m.settings_page_unknown()}</Badge>
              )}
            </Detail>
          </Details>
          {remote && s && !s.loggedIn && <p className="muted small">{m.settings_login_help({ command: ltr("orx login") })}</p>}
          {!remote && !signedOut && s?.sshKeyToAdd && <SshKeyCard sshKey={s.sshKeyToAdd} />}
          {remote && s?.loggedIn && s.sshKeyStatus === "none_registered" &&
            (s.sshKeyPath ? (
              <p dir="auto" className="note">{m.settings_page_add_one_with()} <code>orx ssh-key add {s.sshKeyPath}</code>.</p>
            ) : (
              <p dir="auto" className="note">{m.settings_page_no_key_on_this_computer_yet_create_one()} <code>ssh-keygen -t ed25519</code>{m.settings_page_then_add_it_with()} <code>orx ssh-key add</code>.</p>
            ))}
          {remote && s?.loggedIn && s.sshKeyStatus === "no_local_match" &&
            (s.sshKeyPath ? (
              <p dir="auto" className="note">{m.settings_register_computer_help({ register: ltr(`orx ssh-key add ${s.sshKeyPath}`), load: ltr("ssh-add") })}</p>
            ) : (
              <p dir="auto" className="note">{m.settings_page_no_key_on_this_computer_to_register_load()} <code>ssh-add</code>{m.settings_page_or_create_one_with()} <code>ssh-keygen -t ed25519</code>.</p>
            ))}
          {!busy && (expired || accountError || loadError || s?.error) && <p role="status" dir="auto" className="err-text compute-error">{expired ? m.account_sign_in_expired() : accountError || loadError || s?.error}</p>}
        </>
      )}
      {signInError && <ErrorText>{signInError}</ErrorText>}
      {signInOpened && <p className="muted small" role="status">A terminal opened in VS Code. Sign in there, then press “{m.settings_check_again()}”.</p>}
      <div className="row end ch-actions">
        {(account?.apiUrl || s?.apiUrl) && <ExtLink href={`${(account?.apiUrl || s?.apiUrl || "").replace(/\/$/, "")}/auth/login`}>{m.settings_openresearch_dashboard()} ↗</ExtLink>}
        {!remote && !signedOut && (account?.loggedIn || s?.loggedIn) && <Button disabled={busy || logout.isPending} onClick={() => setConfirmSignOut(true)}>{m.settings_openresearch_sign_out()}</Button>}
        <Button onClick={() => void refresh()} disabled={busy}><Icon name="refresh" /> {busy ? m.common_checking() : m.settings_check_again()}</Button>
        {!remote && s && signedOut && (
          <Button primary disabled={busy} onClick={() => {
            setSignInError(null);
            openTerminal({ command: "login", title: "OpenResearch sign-in" }).then(() => setSignInOpened(true), (e: unknown) => setSignInError(errorMessage(e)));
          }}>
            {m.account_sign_in_alphaxiv()}
          </Button>
        )}
      </div>
      {confirmSignOut && (
        <ConfirmModal title={m.settings_openresearch_sign_out_title()} text={m.settings_openresearch_sign_out_description()} confirm={m.settings_openresearch_sign_out()} destructive
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => { setConfirmSignOut(false); void logout.mutateAsync().catch((e: unknown) => setSignInError(errorMessage(e))); }} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ Kaggle

const hours = (seconds: number) => `${(seconds / 3600).toFixed(1)}h`;

function QuotaMeter({ label, quota }: { label: string; quota: KaggleQuotaHours }) {
  const share = quota.total > 0 ? quota.remaining / quota.total : 0;
  const tone = share <= 0 ? "bad" : share < 0.2 ? "low" : "ok";
  return (
    <div className="ch-meter">
      <div className="row between small"><span>{label}</span><span className={share <= 0 ? "err-text" : "muted"}>{hours(quota.remaining)} left of {hours(quota.total)}</span></div>
      <div className="ch-meter-bar" role="meter" aria-label={`${label} hours left`} aria-valuemin={0} aria-valuemax={quota.total} aria-valuenow={quota.remaining}>
        <div className={`ch-meter-fill ${tone}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }} />
      </div>
    </div>
  );
}

function AccountQuota({ quota, loading }: { quota?: KaggleAccountQuota; loading: boolean }) {
  if (!quota) return <span className="muted small ch-full">{loading ? "Loading quota…" : "Quota unavailable"}</span>;
  if (quota.error) return <span className="err-text small ch-full">Quota unavailable: {quota.error}</span>;
  return (
    <div className="ch-full">
      <div className="row">
        {quota.gpu && <QuotaMeter label="GPU" quota={quota.gpu} />}
        {quota.tpu && <QuotaMeter label="TPU" quota={quota.tpu} />}
      </div>
      {quota.blocks.map((b) => <span key={b.quota} className="warn small">Skipped for new {b.quota.toUpperCase()} notebooks until {new Date(b.until * 1000).toLocaleTimeString()}{b.reason ? ` · ${b.reason}` : ""}</span>)}
    </div>
  );
}

export function KaggleSection() {
  const workspace = useWorkspace();
  const { queryClient, workspaceKey, workspaceScope, isCurrentScope, setScopedQueryData } = workspace;
  const { getKaggleSettings, saveKaggleSettings, kagglePreflight, getSessions, getQuota, closeSession, recoverCookie } = kaggleApi(workspace.api);
  const options = queryOptions({ queryKey: workspaceKey("getKaggleSettings"), queryFn: ({ signal }) => getKaggleSettings(signal) });
  const query = useQuery(options);
  const sessions = useQuery({ queryKey: workspaceKey("kaggleSessions"), queryFn: ({ signal }) => getSessions(signal), enabled: query.data?.runtimeReady === true, refetchInterval: 5000 });
  const quota = useQuery({ queryKey: workspaceKey("kaggleQuota"), queryFn: ({ signal }) => getQuota(signal), enabled: query.data?.runtimeReady === true, refetchInterval: 5 * 60_000, staleTime: 60_000 });
  const [draft, setDraft] = useState<KaggleConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, string>>({});
  useEffect(() => { if (query.data && draft === null) setDraft(query.data.settings); }, [query.data, draft]);
  if (!draft) return <p>{query.error?.message ?? "Loading Kaggle settings…"}</p>;
  const data = query.data;
  const set = <K extends keyof KaggleConfig>(key: K, value: KaggleConfig[K]) => { setDraft({ ...draft, [key]: value }); setStatus(null); };
  async function act(task: () => Promise<void>) {
    if (busy) return;
    const scope = workspaceScope();
    setBusy(true); setError(null); setStatus(null);
    try { await task(); } catch (e) { if (isCurrentScope(scope)) setError(errorMessage(e)); }
    finally { if (isCurrentScope(scope)) setBusy(false); }
  }
  async function save() {
    if (!draft) return;
    const scope = workspaceScope();
    const result = await saveKaggleSettings({ ...draft, competitionSources: draft.competitionSources.map((s) => s.trim()).filter(Boolean), datasetSources: draft.datasetSources.map((s) => s.trim()).filter(Boolean) });
    if (!isCurrentScope(scope)) return;
    setScopedQueryData(options.queryKey, result); setStatus("Kaggle settings saved.");
    await queryClient.invalidateQueries({ queryKey: workspaceKey("getComputeSettings") });
  }
  async function check() {
    if (!draft) return;
    const scope = workspaceScope();
    const result = await kagglePreflight(draft);
    if (isCurrentScope(scope)) setReadiness(Object.fromEntries(result.accounts.map((a) => [a.account, a.readiness])));
  }
  const live = sessions.data?.sessions.filter((s) => s.state !== "stopped") ?? [];
  const quotaByAccount = new Map(quota.data?.accounts.map((q) => [q.account, q]) ?? []);
  const reset = quota.data?.accounts.find((q) => q.refresh_at)?.refresh_at;
  const refreshAt = reset ? new Date(reset) : null;
  return (
    <div className="cform">
      <form className="cform" onSubmit={(e) => { e.preventDefault(); void act(save); }}>
        <p className="muted small">Each experiment Run leases a Kaggle notebook. Runs can reuse its environment until the session expires or you close it. Parallel Runs use different accounts; excess Runs wait for a free session.</p>
        {!data?.runtimeReady && <ErrorText>Install the standalone runtime with downstream/kaggle/setup.ps1. Python, dependencies and account profiles stay in OpenResearch storage.</ErrorText>}
        <fieldset className="ch-fieldset">
          <legend>Account pool</legend>
          <p className="muted small">Enable accounts available to all projects. Up to two GPU notebooks, or one CPU or TPU notebook, per account. No project is pinned to an account.</p>
          <div className="row between muted small">
            <span>{refreshAt ? `Weekly accelerator quota resets ${refreshAt.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Weekly accelerator quota"}{quota.dataUpdatedAt ? ` · checked ${new Date(quota.dataUpdatedAt).toLocaleTimeString()}` : ""}</span>
            <Button small disabled={quota.isFetching} onClick={() => void quota.refetch()}>{quota.isFetching ? "Checking quota…" : "Refresh quota"}</Button>
          </div>
          {quota.error && <ErrorText>{quota.error.message}</ErrorText>}
          {data?.accounts.map((a) => (
            <div className="row ch-account" key={a.id}>
              <label className="chk ch-grow"><input type="checkbox" checked={draft.accounts.includes(a.id)} disabled={busy || !a.configured} onChange={(e) => set("accounts", e.currentTarget.checked ? [...draft.accounts, a.id] : draft.accounts.filter((id) => id !== a.id))} />{a.username ?? a.alias}</label>
              <span className="muted small">{!a.configured ? "Missing token" : readiness[a.id] ?? "Not checked"}</span>
              <Button small disabled={busy} onClick={() => void act(async () => { const scope = workspaceScope(); const r = await recoverCookie(a.id); if (isCurrentScope(scope)) setStatus(r.note ?? "Cookie recovery finished. Check accounts again."); })}>Recover cookie</Button>
              {a.configured && <AccountQuota quota={quotaByAccount.get(a.id)} loading={quota.isPending} />}
            </div>
          ))}
        </fieldset>
        <div className="two">
          <Field label="Default accelerator">
            <select className="inp" value={draft.accelerator} disabled={busy} onChange={(e) => set("accelerator", e.currentTarget.value)}>
              {(data?.accelerators ?? ["cpu"]).map((a) => <option key={a} value={a}>{a === "cpu" ? "CPU" : a === "NvidiaTeslaT4" ? "GPU · T4 × 2" : a}</option>)}
            </select>
          </Field>
          <Field label="Notebook lifetime (minutes)">
            <TextInput type="number" min={1} max={720} required value={draft.ttlMinutes} disabled={busy} onChange={(e) => set("ttlMinutes", Number(e.currentTarget.value))} />
          </Field>
        </div>
        <p className="muted small">Lifetime starts when the notebook is reserved. Reusing it does not reset the deadline. Stopping a Run keeps its notebook available; Close session shuts down the notebook.</p>
        <Field label="Competition sources"><textarea className="inp" rows={2} value={draft.competitionSources.join("\n")} disabled={busy} onChange={(e) => set("competitionSources", e.currentTarget.value.split(/\r?\n/))} /></Field>
        <Field label="Dataset sources"><textarea className="inp" rows={2} value={draft.datasetSources.join("\n")} disabled={busy} onChange={(e) => set("datasetSources", e.currentTarget.value.split(/\r?\n/))} /></Field>
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy || !data?.runtimeReady || !draft.accounts.length}>{busy ? "Working…" : "Save Kaggle settings"}</button>
          <Button disabled={busy || !draft.accounts.length} onClick={() => void act(check)}>Check accounts</Button>
        </div>
        {(error ?? data?.error) && <ErrorText>{error ?? data?.error}</ErrorText>}
        {status && <p className="muted small" role="status">{status}</p>}
      </form>
      <section className="cform" aria-label="Kaggle sessions">
        <h3>Kaggle sessions · {live.length} active</h3>
        {sessions.error && <ErrorText>{sessions.error.message}</ErrorText>}
        {!live.length && <p className="muted small">No live notebooks. A session is allocated when the next Run starts.</p>}
        {live.map((s) => (
          <article key={s.id} className="setting-card">
            <div className="row between"><b>{data?.accounts.find((a) => a.id === s.account)?.username ?? s.account}</b><span>{s.state === "provisioning" ? (s.error ? m.status_unconfirmed() : s.provider_status === "queued" ? m.status_queued() : m.status_starting()) : s.state}</span></div>
            {(s.error ?? s.detail ?? s.note) && <p role="status" className={`small ch-break ${s.error ? "warn" : "muted"}`}>{s.error ?? s.detail ?? s.note}</p>}
            <span className="muted small">Session {s.id.slice(0, 12)} · expires {new Date(s.deadline * 1000).toLocaleTimeString()}</span>
            {s.active_run && <span className="muted small">Run {s.active_run.slice(0, 12)}</span>}
            <div><Button small disabled={busy || s.state === "closing"} onClick={() => void act(async () => { await closeSession(s.id); await sessions.refetch(); })}>Close session</Button></div>
          </article>
        ))}
      </section>
    </div>
  );
}
