// Pairing through native messaging in a real browser: `ainb install`, then the
// side panel starts the bridge and connects with no token typed in.
//
// It registers the native host for this user's browsers (on Windows: HKCU
// registry keys) and removes the registration afterwards, so it only runs when asked:
//   E2E_NATIVE=1 pnpm --filter @ainb/extension exec vitest run test/native-e2e.test.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

let ctx: BrowserContext;
let panel: Page;

beforeAll(async () => {
  if (!RUN) return;
  writeFileSync(join(home, "config.json"), JSON.stringify({ token: "native-e2e-0123456789", port: PORT }));
  writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [resolve(ROOT, "packages/bridge/test/fixtures/fake-agent.mjs")] }]));
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
});

describe.skipIf(!RUN)("native messaging", () => {
  it("has the fixed extension ID the host allows", async () => {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    expect(new URL(sw.url()).host).toBe("mkdjlgboacefhokakjlobfailhipgklf");
  });

  it("starts the bridge and pairs when the panel opens", async () => {
    expect(await running()).toBe(false);
    panel = await ctx.newPage();
    await panel.goto("chrome-extension://mkdjlgboacefhokakjlobfailhipgklf/sidepanel.html");
    // Connected: the panel shows its main view (no notebook in this tab).
    await panel.getByText("No notebook in this tab").waitFor({ timeout: 45_000 });
    expect(await running()).toBe(true);
  });

  it("stays stopped after `ainb stop` until the user starts it again", async () => {
    expect(ainb("stop").stdout).toContain("Stopped.");
    await panel.getByText("The bridge was stopped.").waitFor({ timeout: 15_000 });
    await panel.waitForTimeout(4000);
    expect(await running()).toBe(false);
    await panel.getByRole("button", { name: "Start the bridge" }).click();
    await panel.getByText("No notebook in this tab").waitFor({ timeout: 45_000 });
    expect(await running()).toBe(true);
  });
});
