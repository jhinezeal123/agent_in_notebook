// `ainb mentor verify`: check this checkout's Mentor exercises on a notebook
// open in Chrome, through the running bridge, and record the ones that pass in
// mentor-catalog/verified.json (the catalog test requires a record, matching
// the exercise's files, for every PyTorch exercise).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { catalogDir } from "./catalog.js";
import { reportText, type VerifyReport } from "./verify.js";

export interface VerifiedRecord {
  hash: string;
  python?: string;
  torch?: string | null;
  at: string;
}

export function verifiedFile(dir = catalogDir()): string {
  return join(dir, "verified.json");
}

export function readVerified(dir = catalogDir()): Record<string, VerifiedRecord> {
  try {
    return JSON.parse(readFileSync(verifiedFile(dir), "utf8")) as Record<string, VerifiedRecord>;
  } catch {
    return {};
  }
}

export async function mentorVerify(args: string[]): Promise<number> {
  const tabAt = args.indexOf("--tab");
  const tabId = tabAt >= 0 ? Number(args[tabAt + 1]) : undefined;
  const ids = args.filter((a, i) => !a.startsWith("--") && !(tabAt >= 0 && i === tabAt + 1));
  const cfg = loadConfig();
  const dir = catalogDir();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/mentor/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ exerciseIds: ids, ...(tabId !== undefined && Number.isFinite(tabId) ? { tabId } : {}), catalogDir: dir }),
    });
  } catch {
    console.error(`The bridge is not running on port ${cfg.port}. Open VS Code (it starts the bridge), then try again.`);
    return 1;
  }
  if (!res.ok || !res.body) {
    console.error(`The bridge refused: ${res.status} ${await res.text().catch(() => "")}`);
    return 1;
  }
  const reports: VerifyReport[] = [];
  let failed = false;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;
      const msg = JSON.parse(raw) as { t: string; [k: string]: unknown };
      if (msg.t === "start") console.log(`Checking ${(msg.exercises as string[]).length} exercise(s) on "${msg.title}" (tab ${msg.tabId}).`);
      else if (msg.t === "step") console.log(`  ${msg.exerciseId}: ${msg.text}…`);
      else if (msg.t === "report") {
        const r = msg.report as VerifyReport;
        reports.push(r);
        console.log(reportText(r));
        if (!r.ok) failed = true;
        // Written at once: a long run that is cut off keeps what passed.
        else record(dir, [r]);
      } else if (msg.t === "error") {
        failed = true;
        console.error(`Error${msg.exerciseId ? ` (${msg.exerciseId})` : ""}: ${msg.message}`);
      }
    }
  }
  const passed = reports.filter((r) => r.ok);
  if (passed.length) console.log(`Recorded ${passed.length} in ${verifiedFile(dir)}.`);
  return failed ? 1 : 0;
}

function record(dir: string, passed: VerifyReport[]): void {
  const verified = readVerified(dir);
  for (const r of passed) verified[r.exerciseId] = { hash: r.hash, python: r.python, torch: r.torch ?? null, at: new Date(r.at).toISOString() };
  const sorted = Object.fromEntries(Object.entries(verified).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(verifiedFile(dir), `${JSON.stringify(sorted, null, 2)}
`);
}
