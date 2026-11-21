// Estimated run cost for paid cloud compute backends (C8).
// Uses running time (startedAt -> endedAt, excluding queue wait time) multiplied
// by an editable hourly flavor rate. Clearly labeled as an estimate, not a bill.

import { runActive } from "@orx/runDisplay";
import type { Run } from "@orx/api";

export const RATES_UPDATED = "2026-11-21";
const STORAGE_KEY = "ainb.costRates.v1";

/** Default public hourly USD rates by "<backend>:<flavor>" or "<flavor>". */
export const DEFAULT_RATES: Record<string, number> = {
  "modal:cpu": 0.14,
  "modal:t4": 0.59,
  "modal:l4": 0.80,
  "modal:a10g": 1.10,
  "modal:l40s": 1.95,
  "modal:a100": 2.10,
  "modal:a100-80gb": 2.50,
  "modal:h100": 3.95,
  "modal:h100:2": 7.90,
  "hf:cpu-basic": 0.0,
  "hf:t4-small": 0.40,
  "hf:a10g-small": 1.00,
  "hf:a10g-large": 1.50,
  "hf:a100-large": 2.50,
  "hf:h100": 4.50,
  "hf:h200": 6.00,
  "openresearch:h100_sxm": 3.50,
  "openresearch:h100_sxm:2": 7.00,
};

export function loadRates(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_RATES };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged: Record<string, number> = { ...DEFAULT_RATES };
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) merged[k] = v;
    }
    return merged;
  } catch {
    return { ...DEFAULT_RATES };
  }
}

export function saveRates(rates: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rates));
  } catch {
    // storage unavailable
  }
}

export interface RunCostEstimate {
  dollars: number;
  ratePerHour: number;
  runningMs: number;
  queueMs: number;
  key: string;
  uncertain?: boolean;
}

function backendKeys(run: Run): string[] {
  const b = run.backend as Record<string, unknown> | null | undefined;
  if (!b) return [];
  const kind = String(b.kind ?? b.backend ?? "").replace(/_job$/, "").toLowerCase();
  const flavor = String(b.flavor ?? b.gpu ?? b.accelerator ?? "").toLowerCase();
  const host = String(run.host ?? b.host ?? b.alias ?? "").toLowerCase();
  const keys: string[] = [];
  if (kind && flavor) keys.push(`${kind}:${flavor}`);
  if (kind === "ssh" && host) keys.push(`ssh:${host}`);
  if (flavor) keys.push(flavor);
  return keys;
}

/** Estimate USD cost from actual running duration (excluding queue time). Null when free or unknown rate. */
export function estimateRunCost(run: Run, rates: Record<string, number>, now = Date.now()): RunCostEstimate | null {
  if (!run.startedAt) return null;
  const keys = backendKeys(run);
  let matchedKey: string | undefined;
  let rate: number | undefined;
  for (const k of keys) {
    if (rates[k] !== undefined) { matchedKey = k; rate = rates[k]; break; }
  }
  if (matchedKey === undefined || rate === undefined) return null;
  const active = runActive(run.status);
  const end = active ? now : run.endedAt;
  if (!end || end < run.startedAt) return null;
  const runningMs = Math.max(0, end - run.startedAt);
  const queueMs = Math.max(0, run.startedAt - run.createdAt);
  const dollars = (runningMs / 3_600_000) * rate;
  return {
    dollars,
    ratePerHour: rate,
    runningMs,
    queueMs,
    key: matchedKey,
    uncertain: run.status === "lost" || (!active && !run.endedAt),
  };
}

export function formatCost(dollars: number): string {
  if (dollars <= 0) return "$0.00";
  if (dollars < 0.01) return "<$0.01";
  return `~$${dollars.toFixed(2)}`;
}

export function monthlyTotalCost(runs: Run[], rates: Record<string, number>, now = Date.now()): { total: number; counted: number } {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  let total = 0;
  let counted = 0;
  for (const r of runs) {
    if ((r.startedAt ?? r.createdAt) < monthStart) continue;
    const est = estimateRunCost(r, rates, now);
    if (est && est.dollars > 0) {
      total += est.dollars;
      counted++;
    }
  }
  return { total, counted };
}
