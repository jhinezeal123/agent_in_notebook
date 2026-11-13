// Settings > Compute: OpenResearch's compute tab in VS Code's look. The same
// parts as in OpenResearch (run engine switch, running instances, default
// destination with flavor, tiles for the ready and the other backends, a detail
// page per backend, a quick setup dialog for the token-based ones), on the same
// data (its queries, its strings and logos); only the elements are ours.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { TARGET_LABELS } from "@orx/computeTargets";
import { BackendBadge, BackendLogo } from "@orx/components/BackendLogos";
import { worstPerAlias } from "@orx/engineHosts";
import { runActive } from "@orx/runDisplay";
import { fmtBytes, fmtDuration, fmtNumber, timeAgo, type ComputeSettings, type ComputeTargetId, type ComputeTargetSummary, type LocalMachine, type Run } from "@orx/api";
import { m } from "@orx/paraglide/messages.js";
import { ltr } from "@orx/i18n";
import * as downstream from "@orx/../../downstream/catalog";
import { Banner, Button, Icon, RunBadge, errorText } from "./ui.js";
import { ConfirmModal, ExtLink, LoadingRow, Modal, Spinner, Badge, Switch, TextInput } from "./compute-ui.js";
import { HfSection, K8sSection, ModalSection, RaySection, TinkerSection, VercelSection } from "./compute-quick.js";
import { KaggleSection, OpenResearchSection, SlurmSection, SshSection } from "./compute-hosts.js";

const TARGET_CARD_DESCRIPTIONS: Record<ComputeTargetId, () => string> = {
  local: m.compute_description_local,
  ssh: m.compute_description_ssh,
  ...downstream.computeDescriptions,
  tinker: m.compute_description_tinker,
  hf: m.compute_description_hf,
  modal: m.compute_description_modal,
  k8s: m.compute_description_k8s,
  slurm: m.compute_description_slurm,
  ray: m.compute_description_ray,
  vercel: m.compute_description_vercel,
  openresearch: m.compute_description_openresearch,
};

/** Kind strings from the runs table, which pick the logos. */
const TARGET_KIND: Record<ComputeTargetId, string> = {
  local: "local_job",
  tinker: "tinker_job",
  hf: "hf_job",
  modal: "modal_job",
  k8s: "k8s_job",
  ssh: "ssh_job",
  ...downstream.computeKinds,
  slurm: "slurm_job",
  ray: "ray_job",
  vercel: "vercel_job",
  openresearch: "openresearch_job",
};

/** Backends whose launches take --flavor; mirrors the server's validation. */
const FLAVORED_TARGETS: ComputeTargetId[] = ["hf", "modal", "slurm", "ray", "vercel", "openresearch", ...downstream.flavoredTargets];
/** Of those, the ones where a launch requires a flavor. */
const FLAVOR_REQUIRED: ComputeTargetId[] = ["hf", "modal", "openresearch"];

const FLAVOR_SUGGESTIONS: Partial<Record<ComputeTargetId, string[]>> = {
  hf: ["cpu-basic", "t4-small", "a10g-small", "a10g-large", "a100-large", "h100", "h200"],
  modal: ["cpu", "t4", "l4", "a10g", "a100", "a100-80gb", "l40s", "h100", "h100:2"],
  slurm: ["gpu", "h100:1", "h100:2", "a100:4"],
  ray: ["cpu", "cpu:2", "gpu", "gpu:1", "gpu:1,cpu:4", "gpu:1,mem:8GiB"],
  vercel: ["cpu", "cpu-1", "cpu-4", "cpu-8", "cpu-16", "cpu-32"],
  openresearch: ["h100_sxm", "h100_sxm:2", "cpu5c", "cpu5g", "cpu5m"],
  ...downstream.flavorSuggestions,
};

/** Backends set up in a dialog; the others have a detail page. */
const QUICK_SETUP_TARGETS: ComputeTargetId[] = ["tinker", "hf", "modal", "ray", "k8s", "vercel"];

const TARGET_USAGE: Partial<Record<ComputeTargetId, () => string>> = {
  tinker: m.compute_usage_tinker,
  hf: m.compute_usage_hf,
  modal: m.compute_usage_modal,
  openresearch: m.compute_usage_openresearch,
};

const CUSTOM_FLAVOR_ID = "__custom__";

function isCustomFlavor(backend: ComputeTargetId, flavor: string) {
  return Boolean(flavor && !(FLAVOR_SUGGESTIONS[backend] ?? []).includes(flavor));
}

function localMachineSummary(hw: LocalMachine) {
  const processor = hw.chip ?? `${hw.os}/${hw.arch}`;
  const memory = hw.memBytes === null ? null : fmtBytes(hw.memBytes);
  const gpu = hw.gpus.length === 0 ? null : m.settings_gpu_count({ count: hw.gpus.length });
  return [processor, hw.cpuCount > 0 ? m.settings_cpu_cores({ count: hw.cpuCount }) : null, memory, gpu].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ picker

interface Choice { id: string; label: string }

/** A drop-down list (OpenResearch's OptionPicker) in the look of VS Code's. */
function Picker({ choices, value, disabled, icon, onSelect }: { choices: Choice[]; value: string; disabled?: boolean; icon?: (choice: Choice) => ReactNode; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [open]);
  const current = choices.find((c) => c.id === value);
  return (
    <div className="picker-menu" ref={box}>
      <button type="button" className="picker-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current && icon?.(current)}
        <span className="grow">{current?.label ?? ""}</span>
        <Icon name="chev-d" />
      </button>
      {open && (
        <div className="picker-list" role="listbox">
          {choices.map((c) => (
            <button type="button" role="option" aria-selected={c.id === value} key={c.id} className={`picker-opt${c.id === value ? " on" : ""}`} onClick={() => { setOpen(false); onSelect(c.id); }}>
              {icon?.(c)}<span>{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ run engine

function RunEngineSetting() {
  const { getRunEngineQuery } = useWorkspace().queries;
  const { setRunEngine } = useWorkspace().api;
  const id = useId();
  const engineQuery = useQuery(getRunEngineQuery());
  const engineMutation = useMutation({ mutationFn: setRunEngine });
  return (
    <div className="setting-card">
      <div className="setting-row">
        <div>
          <b id={`run-engine-label-${id}`}>{m.settings_run_engine_label()}</b>
          <div id={`run-engine-description-${id}`} className="muted">
            <p>{m.settings_run_engine_description()}</p>
            <p>{m.settings_run_engine_note()}</p>
            {engineQuery.data?.forcedBy === "canary" && <p>{m.settings_run_engine_canary()}</p>}
            {engineQuery.data?.forcedBy === "environment" && <p>{m.settings_run_engine_override()}</p>}
          </div>
        </div>
        <Switch
          checked={engineQuery.data?.enabled ?? false}
          disabled={!engineQuery.data || engineQuery.data.forcedBy !== null || engineMutation.isPending}
          labelledBy={`run-engine-label-${id}`}
          describedBy={`run-engine-description-${id}`}
          onChange={(next) => engineMutation.mutate(next)}
        />
      </div>
      {(engineQuery.error || engineMutation.error) && <p role="alert" className="err-text">{(engineMutation.error ?? engineQuery.error)?.message}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ running instances

/** Live instances show elapsed-so-far, finished ones the total; both start at submission, so queue time counts. */
function runtimeLabel(run: Run): string {
  if (runActive(run.status)) return fmtDuration(Date.now() - run.createdAt);
  if (run.endedAt) return fmtDuration(run.endedAt - run.createdAt);
  return "—";
}

function InstancesTable({ instances, emptyLabel }: { instances: Run[]; emptyLabel: string }) {
  if (instances.length === 0) return <p className="empty-box">{emptyLabel}</p>;
  return (
    <div className="rtable-wrap">
      <table className="rtable">
        <thead><tr><th>{m.settings_page_backend()}</th><th>{m.settings_page_status()}</th><th>{m.settings_page_started()}</th><th>{m.settings_page_runtime()}</th></tr></thead>
        <tbody>
          {instances.map((run) => {
            const url = typeof run.backend?.url === "string" ? run.backend.url : undefined;
            return (
              <tr key={run.id}>
                <td><span className="backend-cell"><BackendBadge backend={run.backend} />{url && <ExtLink href={url}><span title={m.settings_page_open_job_page()}>↗</span></ExtLink>}</span></td>
                <td><RunBadge run={run} /></td>
                <td>{timeAgo(run.createdAt)}</td>
                <td>{runtimeLabel(run)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The runs of every project (settings are not about one project). */
function useAllRuns(): { runs: Run[] | null; error: string | null; refreshing: boolean; reload: () => void } {
  const { listProjectsQuery, listRunsQuery } = useWorkspace().queries;
  const projects = useQuery(listProjectsQuery());
  const lists = useQueries({ queries: (projects.data ?? []).map((p) => ({ ...listRunsQuery(p.id), subscribed: true })) });
  const [, setTick] = useState(0);
  // Re-render every 30s so live rows' runtime keeps counting.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const loading = projects.isPending || lists.some((l) => l.isPending);
  const error = projects.error?.message ?? lists.find((l) => l.error)?.error?.message ?? null;
  return {
    runs: loading && !error ? null : lists.flatMap((l) => l.data ?? []),
    error,
    refreshing: projects.isFetching || lists.some((l) => l.isFetching),
    reload: () => { void projects.refetch(); lists.forEach((l) => void l.refetch()); },
  };
}

function ComputeActivity({ onViewHistory }: { onViewHistory: () => void }) {
  const { runs, error, refreshing, reload } = useAllRuns();
  const byRecent = (a: Run, b: Run) => b.createdAt - a.createdAt;
  const running = runs?.filter((r) => runActive(r.status)).sort(byRecent);
  const past = runs?.filter((r) => !runActive(r.status));
  return (
    <section className="sec">
      <div className="sec-head">
        <h3>{m.settings_page_running_instances()}{running && running.length > 0 && <span className="count-badge">{running.length}</span>}</h3>
        <Button small onClick={reload} disabled={refreshing}><Icon name="refresh" /> {m.settings_page_refresh()}</Button>
        <Button small onClick={onViewHistory}>{past?.length ? m.instances_view_history_count({ count: fmtNumber(past.length) }) : m.instances_view_history()}</Button>
      </div>
      {error && <p className="err-text">{error}</p>}
      {!running ? <LoadingRow><Spinner /> {m.settings_page_loading()}</LoadingRow> : <InstancesTable instances={running} emptyLabel={m.instances_nothing_running()} />}
    </section>
  );
}

function InstanceHistory({ onBack }: { onBack: () => void }) {
  const { runs, error, refreshing, reload } = useAllRuns();
  return (
    <>
      <button type="button" className="back" onClick={onBack}><Icon name="chev-r" /> {m.settings_page_back_to_compute()}</button>
      <div className="sec-head"><h2>{m.settings_page_instance_history()}</h2><Button small onClick={reload} disabled={refreshing}><Icon name="refresh" /> {m.settings_page_refresh()}</Button></div>
      {error && <p className="err-text">{error}</p>}
      {!runs ? <LoadingRow><Spinner /> {m.settings_page_loading()}</LoadingRow> : <InstancesTable instances={[...runs].sort((a, b) => b.createdAt - a.createdAt)} emptyLabel={m.instances_none_yet()} />}
    </>
  );
}

// ------------------------------------------------------------------ default destination

function DefaultDestinationEditor({ settings, onSaved }: { settings: ComputeSettings; onSaved: (settings: ComputeSettings) => void }) {
  const { setComputeDefault } = useWorkspace().api;
  const setComputeDefaultMutation = useMutation({ mutationFn: setComputeDefault });
  const savedBackend = settings.configuredDefaultBackend ?? settings.defaultBackend ?? "local";
  const savedFlavor = settings.defaultFlavor ?? "";
  const [backend, setBackend] = useState<ComputeTargetId>(savedBackend);
  const [flavor, setFlavor] = useState(savedFlavor);
  const [customFlavor, setCustomFlavor] = useState(isCustomFlavor(savedBackend, savedFlavor));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = settings.targets.find((candidate) => candidate.id === backend);
  const choices = settings.targets.filter((candidate) => candidate.configured || candidate.id === savedBackend);
  const flavored = FLAVORED_TARGETS.includes(backend);
  const flavorRequired = FLAVOR_REQUIRED.includes(backend);
  const flavorSuggestions = FLAVOR_SUGGESTIONS[backend] ?? [];
  const unchanged = backend === savedBackend && (!flavored || flavor.trim() === savedFlavor);
  const destination = TARGET_LABELS[backend]();
  const usage = TARGET_USAGE[backend];
  const helperText = saving
    ? m.settings_updating_default_destination()
    : flavorRequired && !flavor.trim()
      ? m.settings_choose_flavor_for_runs({ destination })
      : backend === "ssh"
        ? m.settings_new_runs_use_ssh()
        : m.settings_new_runs_use_destination({ destination });

  useEffect(() => {
    setBackend(savedBackend);
    setFlavor(savedFlavor);
    setCustomFlavor(isCustomFlavor(savedBackend, savedFlavor));
  }, [savedBackend, savedFlavor]);

  async function save(nextBackend: ComputeTargetId, nextFlavor: string) {
    const nextFlavored = FLAVORED_TARGETS.includes(nextBackend);
    if (saving || (FLAVOR_REQUIRED.includes(nextBackend) && !nextFlavor.trim())) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await setComputeDefaultMutation.mutateAsync({ backend: nextBackend, flavor: nextFlavored ? nextFlavor.trim() || null : null }));
    } catch (err) {
      setError(errorText(err));
      setBackend(savedBackend);
      setFlavor(savedFlavor);
      setCustomFlavor(isCustomFlavor(savedBackend, savedFlavor));
    } finally {
      setSaving(false);
    }
  }

  function changeBackend(id: string) {
    const next = settings.targets.find((candidate) => candidate.id === id);
    if (!next) return;
    setBackend(next.id);
    const nextFlavor = next.id === savedBackend ? savedFlavor : "";
    setFlavor(nextFlavor);
    setCustomFlavor(isCustomFlavor(next.id, nextFlavor));
    if (!FLAVOR_REQUIRED.includes(next.id)) void save(next.id, nextFlavor);
  }

  function changeFlavor(id: string) {
    if (id === CUSTOM_FLAVOR_ID) { setCustomFlavor(true); return; }
    setCustomFlavor(false);
    setFlavor(id);
    if (!flavorRequired || id) void save(backend, id);
  }

  return (
    <section className="sec">
      <h3>{m.settings_page_default_destination()}</h3>
      <form className="dest" onSubmit={(e) => { e.preventDefault(); if (!unchanged) void save(backend, flavor); }}>
        <Picker
          choices={choices.map((c) => ({ id: c.id, label: TARGET_LABELS[c.id]() }))}
          value={backend}
          disabled={saving}
          icon={(c) => <BackendLogo kind={TARGET_KIND[c.id as ComputeTargetId]} size={16} />}
          onSelect={changeBackend}
        />
        {flavored && (customFlavor ? (
          <div className="row">
            <TextInput
              type="text" value={flavor} placeholder={m.settings_page_custom_flavor()} autoFocus autoComplete="off" spellCheck={false} disabled={saving}
              onInput={(e) => setFlavor(e.currentTarget.value)}
              onBlur={() => {
                if (flavorRequired && !flavor.trim()) {
                  if (backend === savedBackend) { setFlavor(savedFlavor); setCustomFlavor(isCustomFlavor(savedBackend, savedFlavor)); }
                  return;
                }
                if (!unchanged) void save(backend, flavor);
              }}
            />
            <button type="button" className="ib" title={m.settings_page_choose_a_preset_flavor()} aria-label={m.settings_page_choose_a_preset_flavor()} onMouseDown={(e) => e.preventDefault()} onClick={() => setCustomFlavor(false)}><Icon name="chev-d" /></button>
          </div>
        ) : (
          <Picker
            choices={[
              { id: "", label: flavorRequired ? m.settings_choose_flavor() : m.settings_no_default_flavor() },
              ...(flavor && !flavorSuggestions.includes(flavor) ? [{ id: flavor, label: m.settings_custom_value({ value: ltr(flavor) }) }] : []),
              ...flavorSuggestions.map((s) => ({ id: s, label: s })),
              { id: CUSTOM_FLAVOR_ID, label: m.settings_page_custom_flavor_1c8a207() },
            ]}
            value={flavor}
            disabled={saving}
            onSelect={changeFlavor}
          />
        ))}
      </form>
      {error && <p className="err-text">{error}</p>}
      {target && !target.configured && <p className="note">{m.settings_page_this_saved_destination_is_not_configured_set_it()}</p>}
      <p className="muted">{helperText}</p>
      {usage && <p className="muted">{usage()}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ tiles

function TargetTile({ target, isDefault, summary, attention, onOpen, onOpenEnvironment }: {
  target: ComputeTargetSummary;
  isDefault: boolean;
  summary?: string;
  /** A problem on this target that needs the user, such as a host waiting for Connect. */
  attention?: string;
  onOpen?: () => void;
  onOpenEnvironment: () => void;
}) {
  const summaryId = useId();
  const setupLabel = target.unverified
    ? m.settings_check_setup()
    : target.id === "openresearch" && !target.signedIn
      ? m.settings_sign_in()
      : target.id === "ray"
        ? m.settings_connect()
        : m.settings_set_up();
  return (
    <div className={`tile${onOpen && target.enabled ? " open" : ""}${target.enabled ? "" : " off"}`}>
      {onOpen && <button type="button" className="tile-hit" onClick={onOpen} disabled={!target.enabled} aria-label={TARGET_LABELS[target.id]()} aria-describedby={summaryId} aria-haspopup={QUICK_SETUP_TARGETS.includes(target.id) ? "dialog" : undefined} title={target.disabledReason ?? undefined} />}
      <span className="tile-logo"><BackendLogo kind={TARGET_KIND[target.id]} size={40} /></span>
      <span className="tile-name">{TARGET_LABELS[target.id]()}</span>
      <span>{TARGET_CARD_DESCRIPTIONS[target.id]()}</span>
      <span id={summaryId} className="tile-sum">
        {target.fromEnvironmentTab ? (
          <>{target.id === "tinker" ? m.settings_key_from() : m.settings_token_from()}{" "}<button type="button" className="tile-link" onClick={onOpenEnvironment}>{m.settings_environment_tab()}</button></>
        ) : summary ?? target.summary}
      </span>
      {attention && <span className="tile-attn">{attention}</span>}
      <span className={`tile-foot${isDefault ? " def" : ""}`}>
        <span>
          {isDefault
            ? m.settings_page_default_808d7dc()
            : target.configured
              ? !onOpen || QUICK_SETUP_TARGETS.includes(target.id) ? m.settings_page_ready_to_use() : m.settings_view_settings()
              : setupLabel}
        </span>
        {onOpen && <span aria-hidden="true">→</span>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ detail page and quick setup

function BackendDetailPage({ target, isDefault, onBack }: { target: ComputeTargetSummary; isDefault: boolean; onBack: () => void }) {
  return (
    <>
      <button type="button" className="back" onClick={onBack}><Icon name="chev-r" /> {m.settings_page_back_to_compute()}</button>
      <div className="detail-head">
        <div className="row"><BackendLogo kind={TARGET_KIND[target.id]} size={32} /><h2>{TARGET_LABELS[target.id]()}</h2></div>
        {isDefault && <Badge>{m.settings_page_default_808d7dc()}</Badge>}
      </div>
      {target.id === "ssh" && <SshSection />}
      {target.id === "kaggle" && <KaggleSection />}
      {target.id === "slurm" && <SlurmSection />}
      {target.id === "openresearch" && <OpenResearchSection remote={false} />}
    </>
  );
}

function QuickSetupDialog({ target, onClose }: { target: ComputeTargetSummary; onClose: () => void }) {
  const [edit, setEdit] = useState({ dirty: false, saving: false });
  const [confirming, setConfirming] = useState(false);
  const close = () => { if (edit.saving) return; if (edit.dirty) setConfirming(true); else onClose(); };
  return (
    <>
      <Modal title={TARGET_LABELS[target.id]()} logo={<BackendLogo kind={TARGET_KIND[target.id]} size={24} />} locked={edit.saving} onClose={close}>
        {target.id === "tinker" && <TinkerSection target={target} />}
        {target.id === "hf" && <HfSection remote={false} />}
        {target.id === "modal" && <ModalSection />}
        {target.id === "ray" && <RaySection />}
        {target.id === "k8s" && <K8sSection onEditState={setEdit} />}
        {target.id === "vercel" && <VercelSection />}
      </Modal>
      {confirming && <ConfirmModal title={TARGET_LABELS[target.id]()} text={m.settings_k8s_discard_changes()} confirm={m.common_confirm()} destructive onCancel={() => setConfirming(false)} onConfirm={onClose} />}
    </>
  );
}

// ------------------------------------------------------------------ the tab

export function ComputeTab({ onOpenEnvironment }: { onOpenEnvironment: () => void }) {
  const { useEngineHosts, getComputeSettingsQuery, getLocalMachineQuery } = useWorkspace().queries;
  const { pendingHostConnect, onHostConnectRequest } = useWorkspace().events;
  const client = useQueryClient();
  const settingsOptions = getComputeSettingsQuery();
  const settingsQuery = useQuery(settingsOptions);
  const settings = settingsQuery.data ?? null;
  const localMachineQuery = useQuery(getLocalMachineQuery());
  const localMachine = localMachineQuery.data ?? null;
  const [selectedTarget, setSelectedTarget] = useState<ComputeTargetId | null>(null);
  const [quick, setQuick] = useState<ComputeTargetId | null>(null);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    const open = () => { if (pendingHostConnect()) setSelectedTarget("ssh"); };
    open();
    return onHostConnectRequest(open);
  }, []);
  const needsConnect = [...worstPerAlias(useEngineHosts() ?? []).values()].filter((host) => host.status === "needs_auth");
  const apply = (s: ComputeSettings) => client.setQueryData(settingsOptions.queryKey, s);

  // Server order, except the selected default leads its section.
  const defaultBackend = settings?.configuredDefaultBackend ?? settings?.defaultBackend;
  const ordered = settings ? [...settings.targets].sort((a, b) => Number(b.id === defaultBackend) - Number(a.id === defaultBackend)) : null;
  const configuredTargets = ordered?.filter((t) => t.configured) ?? [];
  const availableTargets = ordered?.filter((t) => !t.configured) ?? [];
  const renderTarget = (target: ComputeTargetSummary) => (
    <TargetTile
      key={target.id}
      target={target}
      isDefault={defaultBackend === target.id}
      summary={target.id === "local" ? localMachine ? localMachineSummary(localMachine) : localMachineQuery.error?.message ?? m.settings_page_detecting_hardware() : undefined}
      attention={target.id !== "ssh" || needsConnect.length === 0
        ? undefined
        : needsConnect.length === 1
          ? m.settings_ssh_host_needs_connect({ host: ltr(needsConnect[0]!.alias) })
          : m.settings_ssh_hosts_need_connect({ count: fmtNumber(needsConnect.length) })}
      onOpen={target.id === "local" ? undefined : () => (QUICK_SETUP_TARGETS.includes(target.id) ? setQuick(target.id) : setSelectedTarget(target.id))}
      onOpenEnvironment={onOpenEnvironment}
    />
  );
  const selected = selectedTarget ? settings?.targets.find((t) => t.id === selectedTarget) : null;
  const quickTarget = quick ? settings?.targets.find((t) => t.id === quick) : null;

  if (history) return <InstanceHistory onBack={() => setHistory(false)} />;
  if (selected && !QUICK_SETUP_TARGETS.includes(selected.id)) {
    return <BackendDetailPage target={selected} isDefault={defaultBackend === selected.id} onBack={() => setSelectedTarget(null)} />;
  }
  return (
    <>
      <RunEngineSetting />
      <ComputeActivity onViewHistory={() => setHistory(true)} />
      {settingsQuery.error && !settings ? <Banner tone="error">{settingsQuery.error.message}</Banner>
        : !settings ? <LoadingRow><Spinner /> {m.settings_page_checking_compute_targets()}</LoadingRow>
          : (
            <>
              <DefaultDestinationEditor settings={settings} onSaved={apply} />
              <section className="sec">
                <h3>{m.settings_page_ready_to_use()}</h3>
                <div className="tiles">{configuredTargets.map(renderTarget)}</div>
              </section>
              {availableTargets.length > 0 && (
                <section className="sec">
                  <h3>{m.settings_page_more_compute_options()}</h3>
                  <div className="tiles">{availableTargets.map(renderTarget)}</div>
                </section>
              )}
            </>
          )}
      {quickTarget && <QuickSetupDialog target={quickTarget} onClose={() => setQuick(null)} />}
    </>
  );
}
