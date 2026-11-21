// Proactive Kaggle quota & idle-session watcher (C3).
// Never starts OpenResearch by itself: only polls when `orx` is already ready
// and Kaggle is configured. Protects the 30h/week GPU quota by alerting when
// remaining hours drop low or a live session sits idle with no active run.

import type { KaggleQuotaStatus } from "@ainb/protocol";
import type { Orx } from "./orx.js";

const DEFAULT_POLL_MS = 10 * 60_000;
const LOW_GPU_HOURS = 5;
const LOW_GPU_RATIO = 0.2;
const DEFAULT_IDLE_WARN_MS = 30 * 60_000;

interface RawKaggleSettings {
  configured?: boolean;
}

interface RawKaggleQuota {
  accounts?: {
    account: string;
    gpu?: { used: number; reserved: number; total: number; remaining: number } | null;
    tpu?: { used: number; reserved: number; total: number; remaining: number } | null;
    refresh_at?: string | null;
    error?: string;
  }[];
}

interface RawKaggleSession {
  id: string;
  account: string;
  created: number;
  deadline: number;
  state: string;
  active_run: string | null;
  note?: string | null;
}

export interface QuotaWatcherOptions {
  pollMs?: number;
  lowGpuHours?: number;
  lowGpuRatio?: number;
  idleWarnMs?: number;
  onUpdate: (status: KaggleQuotaStatus) => void;
  log?: (msg: string) => void;
}

export class KaggleQuotaWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private inflight?: Promise<KaggleQuotaStatus>;
  private idleSince = new Map<string, number>();
  private lastSignature = "";
  last: KaggleQuotaStatus = { configured: false, checkedAt: 0, accounts: [], idleSessions: [], lowGpuAccounts: [] };

  constructor(private readonly orx: Orx, private readonly opts: QuotaWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.pollMs ?? DEFAULT_POLL_MS;
    this.timer = setInterval(() => {
      if (this.orx.status.state === "ready") void this.check(false).catch(() => {});
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fetch current Kaggle quota & idle sessions if orx is ready (never starts orx). */
  check(force = false): Promise<KaggleQuotaStatus> {
    if (!force && this.inflight) return this.inflight;
    this.inflight = this.checkNow(force).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async checkNow(force: boolean): Promise<KaggleQuotaStatus> {
    const status = this.orx.status;
    if (status.state !== "ready" || !status.url) {
      return this.last;
    }
    const base = status.url;
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    };
    const now = Date.now();
    try {
      const settings = await get<RawKaggleSettings>("/api/settings/kaggle");
      if (!settings?.configured) {
        this.idleSince.clear();
        const next: KaggleQuotaStatus = { configured: false, checkedAt: now, accounts: [], idleSessions: [], lowGpuAccounts: [] };
        this.commit(next, force);
        return next;
      }
      const [quotaRes, sessRes] = await Promise.all([
        get<RawKaggleQuota>("/api/settings/kaggle/quota").catch((e) => ({ accounts: [], error: (e as Error).message })),
        get<{ sessions?: RawKaggleSession[] }>("/api/settings/kaggle/sessions").catch(() => ({ sessions: [] })),
      ]);
      const accounts = (quotaRes.accounts ?? []).map((a) => ({
        account: a.account,
        gpu: a.gpu ?? null,
        tpu: a.tpu ?? null,
        refreshAt: a.refresh_at ?? null,
        ...(a.error ? { error: a.error } : {}),
      }));
      const lowHours = this.opts.lowGpuHours ?? LOW_GPU_HOURS;
      const lowRatio = this.opts.lowGpuRatio ?? LOW_GPU_RATIO;
      const lowGpuAccounts = accounts
        .filter((a) => a.gpu && a.gpu.total > 0 && (a.gpu.remaining < lowHours || a.gpu.remaining / a.gpu.total < lowRatio))
        .map((a) => a.account);

      const activeIds = new Set<string>();
      const idleSessions: KaggleQuotaStatus["idleSessions"] = [];
      for (const s of sessRes.sessions ?? []) {
        const live = s.state === "live" || s.state === "running" || s.state === "ready";
        if (!live || s.active_run) continue;
        activeIds.add(s.id);
        const since = this.idleSince.get(s.id) ?? now;
        this.idleSince.set(s.id, since);
        idleSessions.push({
          id: s.id,
          account: s.account,
          state: s.state,
          created: s.created,
          deadline: s.deadline,
          idleMs: Math.max(0, now - since),
          note: s.note ?? null,
        });
      }
      for (const id of [...this.idleSince.keys()]) if (!activeIds.has(id)) this.idleSince.delete(id);

      const next: KaggleQuotaStatus = {
        configured: true,
        checkedAt: now,
        accounts,
        idleSessions,
        lowGpuAccounts,
        ...("error" in quotaRes && quotaRes.error ? { error: quotaRes.error } : {}),
      };
      this.commit(next, force);
      return next;
    } catch (e) {
      const next: KaggleQuotaStatus = { ...this.last, checkedAt: now, error: (e as Error).message };
      this.last = next;
      return next;
    }
  }

  private commit(next: KaggleQuotaStatus, force: boolean): void {
    this.last = next;
    const warnMs = this.opts.idleWarnMs ?? DEFAULT_IDLE_WARN_MS;
    const sig = JSON.stringify({
      configured: next.configured,
      low: next.lowGpuAccounts,
      idle: next.idleSessions.filter((s) => s.idleMs >= warnMs).map((s) => s.id),
      rem: next.accounts.map((a) => [a.account, Math.round((a.gpu?.remaining ?? -1) * 10)]),
    });
    if (force || sig !== this.lastSignature) {
      this.lastSignature = sig;
      this.opts.onUpdate(next);
    }
  }

  /** Close a live Kaggle session through OpenResearch (only when orx is ready). */
  async closeSession(sessionId: string): Promise<{ closing: boolean }> {
    const status = this.orx.status;
    if (status.state !== "ready" || !status.url) throw new Error("OpenResearch is not running.");
    const res = await fetch(`${status.url}/api/settings/kaggle/close-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Could not close session (HTTP ${res.status}).`);
    const body = (await res.json()) as { closing?: boolean };
    this.idleSince.delete(sessionId);
    void this.check(true).catch(() => {});
    return { closing: body?.closing !== false };
  }
}
