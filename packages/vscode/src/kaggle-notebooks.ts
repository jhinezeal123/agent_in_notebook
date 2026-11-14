import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { KaggleAccount, KaggleNotebookLaunch } from "../../studio/src/messages.js";

const execFileAsync = promisify(execFile);
const NEW_NOTEBOOK = "https://www.kaggle.com/code/new";
const KAGGLE_SIGN_IN = "https://www.kaggle.com/account/login?returnUrl=%2Fcode%2Fnew";

async function documentsDirectory(): Promise<string> {
  if (process.platform === "win32") {
    // Windows lets users move Documents to another drive or to OneDrive.
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", "Personal"], { windowsHide: true }).catch(() => ({ stdout: "" }));
    const value = /^\s*Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)$/mi.exec(stdout)?.[1]?.trim();
    const path = value?.replace(/%([^%]+)%/g, (match, key: string) => process.env[key] ?? match);
    if (path && isAbsolute(path)) return path;
  }
  return join(homedir(), "Documents");
}

export async function listKaggleAccounts(configuredPath: string): Promise<KaggleAccount[]> {
  const path = configuredPath || join(await documentsDirectory(), "kaggle_token", "profiles", "accounts.json");
  if (!isAbsolute(path)) throw new Error("Set ainb.kaggle.accountsFile to an absolute path.");
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Kaggle account registry not found. Set ainb.kaggle.accountsFile to your pool's profiles/accounts.json.");
    throw new Error(`Could not read the Kaggle account registry (${error.code ?? "read failed"}).`);
  });
  let registry: { accounts?: Record<string, { alias?: unknown } | null> } | null;
  try {
    registry = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("The Kaggle account registry contains invalid JSON.");
  }
  const accounts = registry?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) throw new Error("The Kaggle account registry is missing its accounts object.");

  return Object.entries(accounts).map(([id, entry]) => {
    const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
    return { id, alias: alias || id.replace(/\.txt$/i, "") };
  }).sort((a, b) => a.alias.localeCompare(b.alias));
}

async function chromeExecutable(configuredPath: string): Promise<string> {
  if (configuredPath && !isAbsolute(configuredPath)) throw new Error("Set ainb.kaggle.chromePath to an absolute path.");
  const candidates = configuredPath ? [configuredPath] : process.platform === "win32"
    ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
      .flatMap((dir) => dir ? [join(dir, "Google", "Chrome", "Application", "chrome.exe")] : [])
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
      : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).flatMap((dir) => [join(dir, "google-chrome"), join(dir, "google-chrome-stable")]);

  for (const path of candidates) {
    if ((await stat(path).catch(() => null))?.isFile()) return path;
  }
  throw new Error("Google Chrome was not found. Set ainb.kaggle.chromePath to the Chrome executable.");
}

export async function openKaggleNotebook(
  account: KaggleAccount,
  profileRoot: string,
  chromePath: string,
  baseUrl: () => Promise<string>,
  recover = true,
): Promise<KaggleNotebookLaunch> {
  const chrome = await chromeExecutable(chromePath);
  // The registry ID stays stable if an account's display name changes.
  const profile = join(profileRoot, createHash("sha256").update(account.id).digest("hex"));
  let url = NEW_NOTEBOOK;
  let result: KaggleNotebookLaunch = { state: "opened" };
  if (recover) {
    // Recovery only saves a sign-in. When it fails, offer to open Chrome without it.
    const unavailable = (reason: string): KaggleNotebookLaunch =>
      ({ state: "unavailable", message: `${reason} You can open Chrome without recovering the session.` });
    let base: string;
    try {
      base = await baseUrl();
    } catch (error) {
      return unavailable(`OpenResearch is needed to recover the Kaggle session. ${error instanceof Error ? error.message : String(error)}`);
    }
    let response: Response;
    try {
      response = await fetch(`${base}/api/settings/kaggle/recover-cookie/notebook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: account.id, chromeProfile: profile }),
        signal: AbortSignal.timeout(190_000),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      return unavailable(timedOut
        ? "OpenResearch took too long to recover the Kaggle session."
        : "Could not reach OpenResearch to recover the Kaggle session.");
    }
    if (response.status === 404 || response.status === 405) {
      return unavailable("Update OpenResearch to recover the Kaggle session from this Chrome profile.");
    }
    const receipt = await response.json().catch(() => null) as { stage?: string; note?: string; error?: string } | null;
    if (!response.ok) return unavailable(receipt?.error ?? `OpenResearch could not recover the Kaggle session (HTTP ${response.status}).`);
    const note = receipt?.note ?? "OpenResearch could not recover the Kaggle session.";
    switch (receipt?.stage) {
      case "retry": case "unavailable": return { state: receipt.stage, message: note };
      case "sign_in_required":
        url = KAGGLE_SIGN_IN;
        result = { state: "sign-in", message: note };
        break;
      case "refreshed": case "auto_login": case "browser_open": break;
      default: return unavailable("OpenResearch did not confirm the Kaggle session.");
    }
  }
  await mkdir(profile, { recursive: true });
  const args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => reject(new Error(`Could not start Google Chrome (${error.code ?? "launch failed"}).`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return result;
}
