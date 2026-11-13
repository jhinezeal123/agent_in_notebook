// The quick-setup compute screens (Tinker, Hugging Face, Modal, Ray,
// Kubernetes, Vercel), ported from OpenResearch's settings page: same queries,
// saves, checks and wording, drawn with the studio's own controls.

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import { ltr } from "@orx/i18n";
import { m } from "@orx/paraglide/messages.js";
import type { ComputeTargetSummary, HfSettings, K8sSettings, ModalSettings, RayPreflight, RaySettings, TinkerSettings, VercelPlan } from "@orx/api";
import { hostRequest } from "./tunnel.js";
import { Badge, Diagnostic, ErrorText, ExtLink, Field, LoadingRow, Spinner, StatusRow, TextInput } from "./compute-ui.js";
import { Button, Icon } from "./ui.js";

type Choice = { id: string; label: string };

/** A drop-down field (OpenResearch's OptionPicker, as a native select). */
function Select({ choices, value, onSelect, disabled }: { choices: Choice[]; value: string | null; onSelect: (id: string) => void; disabled?: boolean }) {
  return (
    <select className="inp" value={value ?? ""} disabled={disabled} onChange={(e) => onSelect(e.currentTarget.value)}>
      {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  );
}

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Backticked commands in a note show as code with a copy button (a webview has no terminal to run them in). */
function CopyNote({ note }: { note: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (cmd: string) => {
    void navigator.clipboard.writeText(cmd).then(() => { setCopied(cmd); setTimeout(() => setCopied(null), 1500); }, () => {});
  };
  const parts: ReactNode[] = note.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="cq-cmd">
        <code dir="ltr">{part}</code>
        <button type="button" className="ib" title={copied === part ? m.common_copied() : m.md_copy()} aria-label={m.a11y_copy_value({ value: ltr(part) })} onClick={() => copy(part)}><Icon name={copied === part ? "check" : "file"} /></button>
      </span>
    ) : part,
  );
  return <p className="note">{parts}</p>;
}

// ------------------------------------------------------------------ tinker

export function TinkerSection({ target }: { target: ComputeTargetSummary }) {
  const { saveTinkerKey } = useWorkspace().api;
  const { getTinkerSettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData, queryClient } = useWorkspace();

  const saveTinkerKeyMutation = useMutation({ mutationFn: saveTinkerKey });

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState<string | null>(null);

  const settingsOptions = getTinkerSettingsQuery();
  const settingsQuery = useQuery(settingsOptions);
  const settings = settingsQuery.data ?? null;
  const error = actionError ?? settingsQuery.error?.message ?? null;
  const setSettings = (value: SetStateAction<TinkerSettings | null>) => {
    setScopedQueryData(settingsOptions.queryKey, (current) => (typeof value === "function" ? value(current ?? null) : value) ?? undefined);
  };
  const [refreshing, setRefreshing] = useState(false);
  const checking = settingsQuery.isPending || refreshing;

  async function refresh() {
    if (checking || saving) return;
    setRefreshing(true);
    setError(null);
    try {
      await queryClient.fetchQuery({ ...getTinkerSettingsQuery(), staleTime: 0 });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || saving || checking) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await saveTinkerKeyMutation.mutateAsync(apiKey.trim()));
      setApiKey("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cform">
      {!settings && checking ? <LoadingRow><Spinner /> {m.common_checking()}</LoadingRow> : settings && (
        <StatusRow label={m.settings_page_status()}>
          <Badge tone={settings.validationStatus === "valid" ? "success" : settings.validationStatus === "invalid" ? "error" : "warning"}>
            {settings.validationStatus === "valid" ? m.settings_page_ready()
              : settings.validationStatus === "invalid" ? m.settings_tinker_invalid_key()
                : settings.validationStatus === "billingRequired" ? m.settings_tinker_billing_required()
                  : m.settings_page_not_configured()}
          </Badge>
        </StatusRow>
      )}
      {settings?.validationStatus === "billingRequired" && (
        <p className="muted small"><ExtLink href="https://tinker.thinkingmachines.ai/">{m.settings_tinker_billing_help()}</ExtLink></p>
      )}
      {settings?.processEnv && <p className="muted small">{m.settings_tinker_env_override()}</p>}
      <form className="cform" onSubmit={submit}>
        <Field label={target.configured || (settings !== null && settings.validationStatus !== "missing") ? m.settings_replace_key() : m.onboarding_api_key()}>
          <TextInput type="password" value={apiKey} placeholder={settings?.maskedKey ?? ""} onChange={(e) => setApiKey(e.currentTarget.value)} autoComplete="new-password" />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="row end">
          <Button disabled={saving || checking} onClick={() => void refresh()}><Icon name="refresh" /> {checking ? m.common_checking() : m.settings_check_again()}</Button>
          <Button primary type="submit" disabled={!apiKey.trim() || saving || checking}>{saving ? m.settings_validating() : m.common_save()}</Button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ hugging face

function HfStatusBadge({ settings }: { settings: HfSettings }) {
  if (settings.validationStatus === "missing") return <Badge tone="warning">{m.settings_page_not_configured()}</Badge>;
  if (settings.validationStatus === "invalid") return <Badge tone="error">{m.settings_page_invalid_token()}</Badge>;
  if (settings.validationStatus !== "valid") return null;
  if (settings.jobsWrite === true) return <Badge tone="success">{m.settings_page_ready()}</Badge>;
  if (settings.jobsWrite === false) {
    return (
      <span className="row">
        <Badge tone="warning">{m.settings_page_no_job_write_permission()}</Badge>
        <span className="muted" title={m.settings_hf_write_permission_help()}><Icon name="info" title={m.settings_hf_write_permission_help()} /></span>
      </span>
    );
  }
  return null;
}

export function HfSection({ remote: _remote }: { remote: boolean }) {
  const { saveHfToken } = useWorkspace().api;
  const { getHfSettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData, queryClient } = useWorkspace();

  const saveHfTokenMutation = useMutation({ mutationFn: saveHfToken });

  const settingsOptions = getHfSettingsQuery();
  const settingsQuery = useQuery(settingsOptions);
  const settings = settingsQuery.data ?? null;
  const setSettings = (value: SetStateAction<HfSettings | null>) => {
    setScopedQueryData(settingsOptions.queryKey, (current) => (typeof value === "function" ? value(current ?? null) : value) ?? undefined);
  };
  const loadError = settings ? null : settingsQuery.error?.message ?? null;
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (saving || refreshing || (!settings && !loadError)) return;
    setRefreshing(true);
    setError(null);
    try {
      await queryClient.fetchQuery({ ...getHfSettingsQuery(), staleTime: 0 });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token.trim() || saving || refreshing || (!settings && !loadError)) return;
    setSaving(true);
    setError(null);
    try {
      const next = await saveHfTokenMutation.mutateAsync(token.trim());
      setSettings(next);
      setError(null);
      setToken("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cform">
      {loadError ? (
        <ErrorText>{loadError}</ErrorText>
      ) : !settings ? (
        <LoadingRow><Spinner /> {m.settings_page_loading_status()}</LoadingRow>
      ) : (
        <>
          {settings.username && <StatusRow label={m.settings_page_account()}>{settings.username}</StatusRow>}
          {(settings.validationStatus === "missing" || settings.validationStatus === "invalid" ||
            (settings.validationStatus === "valid" && settings.jobsWrite !== null)) && (
            <StatusRow label={m.settings_page_status()}><HfStatusBadge settings={settings} /></StatusRow>
          )}
          {settings.validationStatus === "unreachable" && settings.validationError && <Diagnostic>{settings.validationError}</Diagnostic>}
          {settings.source === "env" && <p className="note">{m.settings_page_hf_token_is_set_in_the_environment_and()}</p>}
          {settings.validationStatus === "valid" && settings.jobsWrite === null && (
            <CopyNote note={m.settings_hf_token_help({ login: "`hf auth login`", url: ltr("huggingface.co/settings/tokens") })} />
          )}
        </>
      )}
      <form className="cform" onSubmit={submit}>
        <Field label={settings?.configured ? m.settings_replace_token() : m.settings_new_token()}>
          <TextInput type="password" value={token} onChange={(e) => setToken(e.currentTarget.value)} placeholder={settings?.maskedToken ?? m.settings_page_hf()} autoComplete="off" />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="row end">
          <Button disabled={saving || refreshing || (!settings && !loadError)} onClick={() => void refresh()}><Icon name="refresh" /> {refreshing ? m.common_checking() : m.settings_check_again()}</Button>
          <Button primary type="submit" disabled={!token.trim() || saving || refreshing || (!settings && !loadError)}>{saving ? m.settings_validating() : m.common_save()}</Button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ modal

export function ModalSection() {
  const { saveModalToken } = useWorkspace().api;
  const { getModalSettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData, queryClient } = useWorkspace();

  const saveModalTokenMutation = useMutation({ mutationFn: (args: Parameters<typeof saveModalToken>) => saveModalToken(...args) });

  const sOptions = getModalSettingsQuery();
  const sQuery = useQuery(sOptions);
  const s = sQuery.data ?? null;
  const setS = (value: SetStateAction<ModalSettings | null>) => {
    setScopedQueryData(sOptions.queryKey, (current) => (typeof value === "function" ? value(current ?? null) : value) ?? undefined);
  };
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? sQuery.error?.message ?? null;
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const loading = sQuery.isPending || refreshing;
  const [saving, setSaving] = useState(false);

  async function refresh() {
    if (loading || saving) return;
    setRefreshing(true);
    setError(null);
    try {
      await queryClient.fetchQuery({ ...getModalSettingsQuery(), staleTime: 0 });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tokenId.trim() || !tokenSecret.trim() || loading || saving || s?.processEnv) return;
    setSaving(true);
    setError(null);
    try {
      setS(await saveModalTokenMutation.mutateAsync([tokenId.trim(), tokenSecret.trim()]));
      setTokenId("");
      setTokenSecret("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cform">
      {!s && loading ? (
        <LoadingRow><Spinner /> {m.settings_page_checking_modal()}</LoadingRow>
      ) : s && (
        <StatusRow label={m.settings_page_status()}>
          <Badge tone={s.tokenConfigured ? "success" : "warning"}>{s.tokenConfigured ? m.settings_page_ready_to_use() : m.settings_page_not_configured()}</Badge>
        </StatusRow>
      )}
      {s?.processEnv && <p className="muted small">{m.settings_modal_env_override()}</p>}
      <form className="cform" onSubmit={submit}>
        <Field label={s?.tokenConfigured ? m.settings_modal_replace_id() : m.settings_modal_token_id()}>
          <TextInput type="password" value={tokenId} onChange={(e) => setTokenId(e.currentTarget.value)} placeholder={s?.maskedTokenId ?? "ak-…"} autoComplete="new-password" disabled={s?.processEnv} />
        </Field>
        <Field label={s?.tokenConfigured ? m.settings_modal_replace_secret() : m.settings_modal_token_secret()}>
          <TextInput type="password" value={tokenSecret} onChange={(e) => setTokenSecret(e.currentTarget.value)} placeholder={s?.maskedTokenSecret ?? "as-…"} autoComplete="new-password" disabled={s?.processEnv} />
        </Field>
        <p className="small"><ExtLink href="https://modal.com/docs/sdk/py/latest/config">{m.settings_modal_setup_help()}</ExtLink></p>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="row end">
          <Button disabled={loading || saving} onClick={() => void refresh()}><Icon name="refresh" /> {m.settings_page_refresh()}</Button>
          <Button primary type="submit" disabled={!tokenId.trim() || !tokenSecret.trim() || loading || saving || s?.processEnv}>{saving ? m.common_saving() : m.common_save()}</Button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ ray

function PreflightBadge({ test }: { test: "testing" | { reachable: boolean } | null }) {
  if (test === null) return null;
  if (test === "testing") return <Badge>{m.settings_page_testing()}</Badge>;
  if (test.reachable) return <Badge tone="success">{m.settings_page_reachable()}</Badge>;
  return <Badge tone="error">{m.settings_page_failed()}</Badge>;
}

export function RaySection() {
  const { saveRaySettings, rayPreflight } = useWorkspace().api;
  const { getRaySettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData } = useWorkspace();

  const saveRaySettingsMutation = useMutation({ mutationFn: saveRaySettings });

  const settingsOptions = getRaySettingsQuery();
  const settingsQuery = useQuery(settingsOptions);
  const settings = settingsQuery.data ?? null;
  const setSettings = (value: SetStateAction<RaySettings | null>) => {
    setScopedQueryData(settingsOptions.queryKey, (current) => (typeof value === "function" ? value(current ?? null) : value) ?? undefined);
  };
  const loadError = settings ? null : settingsQuery.error?.message ?? null;
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<"testing" | RayPreflight | null>(null);
  const preflight = test !== null && test !== "testing" ? test : null;

  const apply = (s: RaySettings) => {
    setSettings(s);
    setAddress(s.address ?? "");
  };

  const previousSettings = useRef<RaySettings | null>(null);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    if (settings && (!previous || address === (previous.address ?? ""))) setAddress(settings.address ?? "");
  }, [settings, address]);

  const unchanged = settings !== null && address === (settings.address ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      apply(await saveRaySettingsMutation.mutateAsync({ address }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  async function runPreflight() {
    setTest("testing");
    try {
      setTest(await rayPreflight(address.trim() || undefined));
    } catch (err) {
      setTest({ reachable: false, address: address.trim() || "(unknown)", rayVersion: null, error: messageOf(err) });
    }
  }

  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (!settings) return <LoadingRow><Spinner /> {m.settings_page_loading_ray_settings()}</LoadingRow>;
  return (
    <div className="cform">
      {preflight?.error && <Diagnostic>{preflight.error}</Diagnostic>}
      <form className="cform" onSubmit={submit}>
        <Field label={m.settings_page_jobs_dashboard_url()}>
          <TextInput type="text" value={address} onChange={(e) => { setAddress(e.currentTarget.value); setTest(null); }} placeholder="http://127.0.0.1:8265" autoComplete="off" spellCheck={false} />
        </Field>
        <p className="muted small">{m.settings_page_effective_url()}: {ltr(settings.resolvedAddress)} · {m.settings_page_source()}: {settings.source}</p>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="row">
          <Button primary type="submit" disabled={saving || unchanged}>{saving ? m.common_saving() : m.common_save()}</Button>
          <Button disabled={test === "testing"} onClick={() => void runPreflight()}>{m.settings_page_test_connection()}</Button>
          <PreflightBadge test={test} />
        </div>
        {preflight?.reachable && preflight.rayVersion && <p className="muted small">{m.settings_page_ray_version()}: {preflight.rayVersion}</p>}
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ kubernetes

function K8sHealthBadge({ s }: { s: K8sSettings }) {
  const p = s.preflight;
  if (!p.kubectlFound) return <Badge tone="error">{m.settings_page_kubectl_not_found()}</Badge>;
  if (!p.reachable) return <Badge tone="error">{m.settings_page_cluster_unreachable()}</Badge>;
  if (!p.canCreateJobs) return <Badge tone="error">{m.settings_page_no_job_create_permission()}</Badge>;
  return <Badge tone="success">{m.settings_page_connected()}</Badge>;
}

export function K8sSection({ onEditState }: { onEditState: (state: { dirty: boolean; saving: boolean }) => void }) {
  const { saveK8sSettings } = useWorkspace().api;
  const { getK8sSettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData, queryClient } = useWorkspace();

  const saveK8sSettingsMutation = useMutation({ mutationFn: saveK8sSettings });

  const settingsOptions = getK8sSettingsQuery();
  const settingsQuery = useQuery(settingsOptions);
  const settings = settingsQuery.data ?? null;
  const setSettings = (value: SetStateAction<K8sSettings | null>) => {
    setScopedQueryData(settingsOptions.queryKey, (current) => (typeof value === "function" ? value(current ?? null) : value) ?? undefined);
  };
  const loadError = settings ? null : settingsQuery.error?.message ?? null;
  const [context, setContext] = useState("");
  const [namespace, setNamespace] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: K8sSettings) => {
    setSettings(s);
    setContext(s.context ?? "");
    setNamespace(s.namespace);
  };

  const previousSettings = useRef<K8sSettings | null>(null);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    if (settings && (!previous || (context === (previous.context ?? "") && namespace.trim() === previous.namespace))) {
      setContext(settings.context ?? "");
      setNamespace(settings.namespace ?? "");
    }
  }, [settings, context, namespace]);

  const unchanged = settings !== null && context === (settings.context ?? "") && namespace.trim() === settings.namespace;
  const dirty = settings !== null && !unchanged;

  useEffect(() => {
    onEditState({ dirty, saving });
  }, [dirty, saving, onEditState]);

  async function checkAgain() {
    if (checking || saving || !unchanged) return;
    setChecking(true);
    try {
      await queryClient.fetchQuery({ ...getK8sSettingsQuery(), staleTime: 0 });
    } catch (err) {
      void hostRequest("message", { level: "error", text: messageOf(err) }).catch(() => {});
    } finally {
      setChecking(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || checking) return;
    setSaving(true);
    setError(null);
    try {
      apply(await saveK8sSettingsMutation.mutateAsync({ context, namespace: namespace.trim() }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (!settings) return <LoadingRow><Spinner /> {m.settings_page_checking_kubectl()}</LoadingRow>;
  const contextChoices: Choice[] = [
    { id: "", label: settings.currentContext ? m.settings_kubectl_default_context({ context: ltr(settings.currentContext) }) : m.settings_kubectl_default() },
    ...(context && !settings.contexts.includes(context) ? [{ id: context, label: m.settings_not_in_kubeconfig({ context: ltr(context) }) }] : []),
    ...settings.contexts.map((item) => ({ id: item, label: item })),
  ];
  return (
    <div className="cform">
      <StatusRow label={m.settings_page_status()}>
        {checking || saving ? <Badge>{m.common_checking()}</Badge> : dirty ? <Badge>{m.file_viewer_unsaved()}</Badge> : <K8sHealthBadge s={settings} />}
      </StatusRow>
      {unchanged && !checking && !saving && settings.preflight.error && <Diagnostic>{settings.preflight.error}</Diagnostic>}
      <form className="cform" onSubmit={submit}>
        <Field label={m.settings_page_context()}>
          <Select choices={contextChoices} value={context} disabled={saving || checking} onSelect={setContext} />
        </Field>
        <Field label={m.settings_page_namespace()}>
          <TextInput type="text" value={namespace} disabled={saving || checking} onChange={(e) => setNamespace(e.currentTarget.value)} placeholder={m.settings_page_default()} autoComplete="off" spellCheck={false} />
        </Field>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="row end">
          <Button disabled={saving || checking || !unchanged} onClick={() => void checkAgain()}><Icon name="refresh" /> {checking ? m.common_checking() : m.settings_check_again()}</Button>
          <Button primary type="submit" disabled={saving || checking || unchanged}>{saving ? m.common_saving() : m.common_save()}</Button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ vercel

/** Offered when the team has no project by this name; orx creates it on save. */
const VERCEL_NEW_PROJECT = "openresearch";

const VERCEL_PLAN_LIMITS: Record<VercelPlan, () => string> = {
  hobby: m.settings_vercel_plan_hobby,
  pro: m.settings_vercel_plan_pro,
  enterprise: m.settings_vercel_plan_enterprise,
};

export function VercelSection() {
  const { saveVercelSetup, getVercelScopes } = useWorkspace().api;
  const { getVercelSettingsQuery } = useWorkspace().queries;
  const { setScopedQueryData } = useWorkspace();

  const saveMutation = useMutation({ mutationFn: saveVercelSetup });
  const sOptions = getVercelSettingsQuery();
  const sQuery = useQuery(sOptions);
  const s = sQuery.data ?? null;
  const [token, setToken] = useState("");
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const typedToken = useDebouncedValue(token.trim(), 400);

  const savedScopes = s?.scopes ?? null;
  const lookup = typedToken || (pickedTeam && pickedTeam !== savedScopes?.teamId)
    ? { token: typedToken || null, teamId: pickedTeam }
    : null;
  const lookupQuery = useQuery({
    queryKey: ["vercelScopes", lookup?.token, lookup?.teamId],
    queryFn: () => getVercelScopes(lookup!.token, lookup!.teamId),
    enabled: lookup !== null,
    retry: false,
    gcTime: 0,
  });
  const scopes = lookup ? lookupQuery.data ?? null : savedScopes;
  const lookupError = lookup ? lookupQuery.error?.message ?? null : s?.error ?? null;
  const finding = lookup !== null && lookupQuery.isFetching;

  const teamId = pickedTeam ?? scopes?.teamId ?? null;
  const team = scopes?.teams.find((item) => item.id === teamId) ?? null;
  const projects = scopes?.teamId === teamId ? scopes.projects : [];
  const hasDefaultProject = projects.some((project) => project.name === VERCEL_NEW_PROJECT);
  const savedProject = teamId === savedScopes?.teamId && projects.some((project) => project.id === s?.projectId) ? s?.projectId ?? null : null;
  const projectId = pickedProject ?? savedProject ?? projects.find((project) => project.name === VERCEL_NEW_PROJECT)?.id ?? "new";
  const projectChoices: Choice[] = [
    ...(hasDefaultProject ? [] : [{ id: "new", label: m.settings_vercel_new_project({ name: VERCEL_NEW_PROJECT }) }]),
    ...projects.map((project) => ({ id: project.id, label: project.name })),
  ];

  const locked = !!s?.processEnv;
  const changed = !!typedToken || teamId !== savedScopes?.teamId || projectId !== s?.projectId;
  const canSave = !locked && !saving && !finding && changed && !!scopes && !!teamId && (!!typedToken || !!s?.maskedToken);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || !teamId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await saveMutation.mutateAsync({
        token: typedToken || null,
        teamId,
        projectId: projectId === "new" ? null : projectId,
        newProject: projectId === "new" ? VERCEL_NEW_PROJECT : null,
      });
      setScopedQueryData(sOptions.queryKey, next);
      setToken("");
      setPickedTeam(null);
      setPickedProject(null);
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  if (!s) return sQuery.error ? <ErrorText>{sQuery.error.message}</ErrorText> : <LoadingRow><Spinner /> {m.settings_page_checking_vercel()}</LoadingRow>;

  return (
    <div className="cform">
      <StatusRow label={m.settings_page_status()}>
        {!s.configured ? <Badge tone="warning">{m.settings_page_not_configured()}</Badge>
          : s.error ? <Badge tone="error">{m.settings_vercel_cant_connect()}</Badge>
            : <Badge tone="success">{m.settings_page_ready()}</Badge>}
      </StatusRow>
      {locked && <p className="note">{m.settings_vercel_env_override()}</p>}
      {!locked && s.oidc && <p className="note">{m.settings_vercel_replaces_oidc()}</p>}
      <form className="cform" onSubmit={submit}>
        <Field label={s.maskedToken ? m.settings_replace_token() : m.settings_vercel_access_token()}>
          <TextInput
            type="password"
            value={token}
            onChange={(event) => { setToken(event.currentTarget.value); setPickedTeam(null); setPickedProject(null); }}
            placeholder={s.maskedToken ?? undefined}
            autoComplete="new-password"
            disabled={locked}
          />
        </Field>
        <p className="small"><ExtLink href="https://vercel.com/account/settings/tokens">{m.settings_vercel_create_token()}</ExtLink></p>
        {finding && !scopes ? (
          <LoadingRow><Spinner /> {m.settings_vercel_finding_teams()}</LoadingRow>
        ) : lookupError ? (
          <ErrorText>{lookupError}</ErrorText>
        ) : scopes && (
          <>
            <Field label={m.settings_vercel_team()} hint={team?.plan ? VERCEL_PLAN_LIMITS[team.plan]() : undefined}>
              <Select
                choices={scopes.teams.map((item) => ({ id: item.id, label: item.name }))}
                value={teamId}
                disabled={locked || saving}
                onSelect={(id) => { setPickedTeam(id); setPickedProject(null); }}
              />
            </Field>
            <Field label={m.settings_vercel_project()}>
              <Select choices={projectChoices} value={projectId} disabled={locked || saving || finding} onSelect={setPickedProject} />
            </Field>
          </>
        )}
        {saveError && <ErrorText>{saveError}</ErrorText>}
        <div className="row end">
          <Button primary type="submit" disabled={!canSave}>{saving ? m.common_saving() : m.common_save()}</Button>
        </div>
      </form>
    </div>
  );
}
