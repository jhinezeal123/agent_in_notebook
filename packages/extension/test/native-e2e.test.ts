// Pairing through native messaging in a real browser: `ainb install`, then
// opening a notebook starts the bridge and connects with no token typed in.
//
// It registers the native host for this user's browsers (on Windows: HKCU
// registry keys) and removes the registration afterwards, so it only runs when asked:
//   E2E_NATIVE=1 pnpm --filter @ainb/extension exec vitest run test/native-e2e.test.ts

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = !!process.env.E2E_NATIVE;
const ROOT = resolve(__dirname, "../../..");
const EXT = resolve(__dirname, "../dist");
const CLI = resolve(ROOT, "packages/bridge/dist/cli.js");
const PORT = 47800 + Math.floor(Math.random() * 90);
const home = mkdtempSync(join(tmpdir(), "ainb-native-e2e-"));

const ainb = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AINB_HOME: home }, encoding: "utf8" });
const running = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
  } catch {
    return false;
  }
};

/**
 * Install and uninstall act on this user's real browser registration. Whatever
 * was registered before (the user's own `ainb install`) is put back afterwards.
 */
const HOST = "com.agent_in_notebook.bridge";
const REG_KEYS = ["Google\\Chrome", "Chromium", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser"].map((b) => `HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST}`);
const POSIX_DIRS = (process.platform === "darwin"
  ? ["Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"].map((b) => join(homedir(), "Library", "Application Support", b))
  : ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map((b) => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), b))
).map((d) => join(d, "NativeMessagingHosts", `${HOST}.json`));

function saveRegistration(): () => void {
  if (process.platform === "win32") {
    const before = REG_KEYS.map((key) => {
      try {
        const out = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return { key, value: out.match(/REG_SZ\s+(.+)/)?.[1]?.trim() };
      } catch {
        return { key, value: undefined };
      }
    });
    return () => {
      for (const { key, value } of before) if (value) execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
    };
  }
  const before = POSIX_DIRS.map((file) => ({ file, body: existsSync(file) ? readFileSync(file, "utf8") : undefined }));
  return () => {
    for (const { file, body } of before) {
      if (body === undefined) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  };
}

let restoreRegistration = () => {};
let ctx: BrowserContext;
let nb: Page;
const COLAB = "https://colab.research.google.com/github/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb";
/** The browser extension is connected to the bridge. */
const paired = async () => {
  try {
    return ((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { extension: boolean }).extension;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  if (!RUN) return;
  writeFileSync(join(home, "config.json"), JSON.stringify({ token: "native-e2e-0123456789", port: PORT }));
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [resolve(ROOT, "packages/bridge/test/fixtures/fake-agent.mjs")] }]));
  restoreRegistration = saveRegistration();
  const install = ainb("install");
  expect(install.status, install.stderr).toBe(0);
  ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
});

afterAll(async () => {
  if (!RUN) return;
  await ctx?.close();
  ainb("stop");
  ainb("uninstall");
  restoreRegistration();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!RUN)("native messaging", () => {
  it("has the fixed extension ID the host allows", async () => {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    expect(new URL(sw.url()).host).toBe("mkdjlgboacefhokakjlobfailhipgklf");
  });

  it("starts the bridge and pairs when a notebook opens", async () => {
    expect(await running()).toBe(false);
    nb = await ctx.newPage();
    await nb.goto(COLAB, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect.poll(paired, { timeout: 60_000 }).toBe(true);
  }, 120_000);

  it("stays stopped after `ainb stop` until a notebook is opened again", async () => {
    expect(ainb("stop").stdout).toContain("Stopped.");
    await expect.poll(running, { timeout: 15_000 }).toBe(false);
    await nb.waitForTimeout(4000);
    expect(await running()).toBe(false);
    await nb.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect.poll(paired, { timeout: 60_000 }).toBe(true);
  }, 180_000);
});
