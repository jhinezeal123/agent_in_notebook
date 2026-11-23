// Launch the ER-0 webview probe in the VS Code installed on this machine, as
// its own instance (fresh user-data and extensions folders, so the VS Code you
// have open is not touched). A window opens for ~10–30 s and closes itself.
//
//   node packages/vscode/test/debug/reader-webview-probe/run.mjs <file.pdf> [reader|frames] [outDir]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [pdf, variant = "reader", outDir = join(tmpdir(), "er0")] = process.argv.slice(2);
if (!pdf || !existsSync(pdf)) {
  console.error("usage: run.mjs <file.pdf> [reader|frames] [outDir]");
  process.exit(2);
}
const exe = process.env.AINB_CODE_EXE ?? (process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe")
  : "code");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `webview-probe-${variant}.json`);
rmSync(out, { force: true });
const profile = mkdtempSync(join(tmpdir(), "ainb-probe-vscode-"));

// A terminal inside VS Code carries variables that would hand the launch to the running instance.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VSCODE_|ELECTRON_)/.test(k)));
Object.assign(env, { AINB_PROBE_OUT: out, AINB_PROBE_PDF: resolve(pdf), AINB_PROBE_CSP: variant });

const args = [
  `--user-data-dir=${join(profile, "user")}`,
  `--extensions-dir=${join(profile, "ext")}`,
  `--extensionDevelopmentPath=${here}`,
  `--extensionTestsPath=${join(here, "runner.cjs")}`,
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--new-window",
];
const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const timer = setTimeout(() => { console.error("timeout: killing VS Code"); child.kill(); }, 180_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  if (!existsSync(out)) {
    console.error(`no result (exit ${code}). VS Code said:\n${log.slice(-3000)}`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(out, "utf8"));
  console.log(`VS Code ${r.vscode} · Electron ${r.electron} · Chrome ${r.chrome} · ${r.why} in ${r.ms} ms · CSP variant ${r.variant}`);
  for (const x of r.results) console.log(`${x.ok ? "OK " : "NO "} ${x.name}: ${typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail)}`);
  console.log(`\n${out}`);
});
