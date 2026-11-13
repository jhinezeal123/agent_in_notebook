// Browser native messaging: `ainb install` registers this program with the
// browsers, and the extension calls it to find the bridge (starting it when it
// is not running) instead of the user copying a token by hand. The browser
// itself checks that the caller is our extension, so the reply may carry the
// pairing token.
//
// Messages are JSON with a 4-byte length prefix in native byte order, over
// stdin/stdout. Nothing else may be written to stdout.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EXTENSION_ID, NATIVE_HOST, type NativeReply } from "@ainb/protocol";
import { BRIDGE_VERSION, dataDir, loadConfig, STOPPED_MARK } from "./config.js";

const START_TIMEOUT_MS = 15_000;

// ------------------------------------------------------------------ framing

/** Split length-prefixed messages out of a byte stream. */
export class NativeReader {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------ host

/** Run as the native host the browser starts: answer messages until stdin closes. */
export async function runNativeHost(cliPath: string): Promise<void> {
  // Anything printed by mistake must not corrupt the message stream.
  console.log = console.error;
  const reader = new NativeReader();
  let queue = Promise.resolve();
  process.stdin.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = reader.push(chunk);
    } catch {
      process.exit(1);
    }
    for (const msg of msgs) {
      queue = queue.then(async () => {
        const reply = await answer(msg, cliPath).catch((e): NativeReply => ({ ok: false, error: (e as Error).message }));
        await new Promise<void>((r) => process.stdout.write(frame(reply), () => r()));
      });
    }
  });
  await new Promise<void>((r) => process.stdin.on("end", r));
  await queue;
}

async function answer(msg: unknown, cliPath: string): Promise<NativeReply> {
  if ((msg as { type?: unknown })?.type !== "connect") return { ok: false, error: "Unknown request." };
  const cfg = loadConfig();
  const started = await ensureBridge(cfg.port, cliPath);
  if (typeof started === "object") return started;
  return { ok: true, port: cfg.port, token: cfg.token, version: BRIDGE_VERSION, started };
}

type Health = { ok: true; version: string } | "down" | "foreign";

async function health(port: number): Promise<Health> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; version?: unknown } | null;
    return body?.ok === true && typeof body.version === "string" ? { ok: true, version: body.version } : "foreign";
  } catch (e) {
    // Refused (nothing listening) or timed out: treat both as not running.
    return (e as Error).name === "TimeoutError" ? "foreign" : "down";
  }
}

/** True if the bridge was started now, false if it was already running, or why it could not start. */
export async function ensureBridge(port: number, cliPath: string): Promise<boolean | NativeReply> {
  const now = await health(port);
  if (now === "foreign") return { ok: false, error: `Port ${port} is taken by another program. Set a different "port" in ${join(dataDir(), "config.json")}.` };
  if (now !== "down") return false;

  const logFile = join(dataDir(), "bridge.log");
  writeFileSync(logFile, "", { mode: 0o600 });
  let exited = false;
  if (process.platform === "win32") {
    // Node hands every inheritable handle to a child on Windows, which would include
    // the browser's pipes: the bridge would hold them open for as long as it runs.
    // Start-Process (ShellExecute) passes none, and the bridge writes its own log.
    const args = `"${cliPath}" serve --log "${logFile}"`;
    const script = `Start-Process -WindowStyle Hidden -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '${args.replace(/'/g, "''")}'`;
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true });
    const code = await new Promise<number>((r) => {
      ps.on("exit", (c) => r(c ?? 1));
      ps.on("error", () => r(1));
    });
    if (code !== 0) return { ok: false, error: "Could not start the bridge (PowerShell Start-Process failed)." };
  } else {
    // Detached, so the bridge outlives this short-lived host.
    const child = spawn(process.execPath, [cliPath, "serve", "--log", logFile], { detached: true, stdio: "ignore" });
    child.on("exit", () => (exited = true));
    child.on("error", () => (exited = true));
    child.unref();
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if ((await health(port)) !== "down") return true;
    const log = readLog(logFile);
    if (exited || log.includes(STOPPED_MARK)) break;
  }
  const log = readLog(logFile).replace(STOPPED_MARK, "").trim().split(/\r?\n/).slice(-15).join("\n");
  return { ok: false, error: "The bridge did not start.", log: `${log}\n(log: ${logFile})`.trim() };
}

function readLog(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ------------------------------------------------------------------ install

interface Browser {
  name: string;
  /** Windows: registry key under HKCU holding the manifest path. */
  reg: string;
  /** macOS / Linux: the browser's user data folder (the manifest goes in NativeMessagingHosts inside it). */
  mac: string;
  linux: string;
}

const BROWSERS: Browser[] = [
  { name: "Chrome", reg: "Software\\Google\\Chrome", mac: "Google/Chrome", linux: "google-chrome" },
  { name: "Chromium", reg: "Software\\Chromium", mac: "Chromium", linux: "chromium" },
  { name: "Edge", reg: "Software\\Microsoft\\Edge", mac: "Microsoft Edge", linux: "microsoft-edge" },
  { name: "Brave", reg: "Software\\BraveSoftware\\Brave-Browser", mac: "BraveSoftware/Brave-Browser", linux: "BraveSoftware/Brave-Browser" },
];

function userDataDir(b: Browser): string {
  return process.platform === "darwin" ? join(homedir(), "Library", "Application Support", b.mac) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), b.linux);
}

function hostDir(): string {
  return join(dataDir(), "native-host");
}

/** A script the browser can start: it runs this very Node and CLI, whatever PATH the browser has. */
function writeLauncher(cliPath: string): string {
  const dir = hostDir();
  mkdirSync(dir, { recursive: true });
  const home = process.env.AINB_HOME;
  if (process.platform === "win32") {
    const file = join(dir, "ainb-native-host.cmd");
    const lines = ["@echo off", ...(home ? [`set "AINB_HOME=${home}"`] : []), `"${process.execPath}" "${cliPath}" native-host %*`];
    writeFileSync(file, lines.join("\r\n") + "\r\n");
    return file;
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const file = join(dir, "ainb-native-host.sh");
  // GUI browsers on macOS get a bare PATH; keep the one agents were found with.
  const lines = ["#!/bin/sh", `export PATH=${q(process.env.PATH ?? "/usr/bin:/bin")}`, ...(home ? [`export AINB_HOME=${q(home)}`] : []), `exec ${q(process.execPath)} ${q(cliPath)} native-host "$@"`];
  writeFileSync(file, lines.join("\n") + "\n");
  chmodSync(file, 0o755);
  return file;
}

function manifest(launcher: string, extensionIds: string[]) {
  return {
    name: NATIVE_HOST,
    description: "Agent in Notebook bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

export interface InstallResult {
  manifest: string;
  browsers: string[];
  extensionIds: string[];
}

/** Register the native host for every supported browser on this machine. */
export function installNativeHost(cliPath: string, extraIds: string[] = []): InstallResult {
  const extensionIds = [...new Set([EXTENSION_ID, ...extraIds])];
  for (const id of extensionIds) if (!/^[a-p]{32}$/.test(id)) throw new Error(`"${id}" is not an extension ID (32 letters a-p, shown on chrome://extensions).`);
  const launcher = writeLauncher(cliPath);
  const body = JSON.stringify(manifest(launcher, extensionIds), null, 2);
  const browsers: string[] = [];
  let manifestPath = join(hostDir(), `${NATIVE_HOST}.json`);

  if (process.platform === "win32") {
    writeFileSync(manifestPath, body);
    for (const b of BROWSERS) {
      execFileSync("reg", ["add", `HKCU\\${b.reg}\\NativeMessagingHosts\\${NATIVE_HOST}`, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore", windowsHide: true });
      browsers.push(b.name);
    }
  } else {
    // Only browsers that have been run here; Chrome regardless, so there is always one.
    for (const b of BROWSERS) {
      const data = userDataDir(b);
      if (!existsSync(data) && b.name !== "Chrome") continue;
      const dir = join(data, "NativeMessagingHosts");
      mkdirSync(dir, { recursive: true });
      manifestPath = join(dir, `${NATIVE_HOST}.json`);
      writeFileSync(manifestPath, body);
      browsers.push(b.name);
    }
  }
  return { manifest: process.platform === "win32" ? manifestPath : dirname(manifestPath), browsers, extensionIds };
}

export function uninstallNativeHost(): string[] {
  const removed: string[] = [];
  for (const b of BROWSERS) {
    if (process.platform === "win32") {
      try {
        execFileSync("reg", ["delete", `HKCU\\${b.reg}\\NativeMessagingHosts\\${NATIVE_HOST}`, "/f"], { stdio: "ignore", windowsHide: true });
        removed.push(b.name);
      } catch {
        // not registered for that browser
      }
    } else {
      const file = join(userDataDir(b), "NativeMessagingHosts", `${NATIVE_HOST}.json`);
      if (existsSync(file)) {
        rmSync(file);
        removed.push(b.name);
      }
    }
  }
  rmSync(hostDir(), { recursive: true, force: true });
  return removed;
}
