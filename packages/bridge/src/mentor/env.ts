// What Python on this computer has for the exercises. The kernel the
// notebook picks may be another Python: the judge checks the kernel itself.

import { spawn } from "node:child_process";
import type { MentorEnv } from "@ainb/protocol";

const MODULES = ["numpy", "matplotlib", "ipykernel", "torch"];
const PROBE = `import importlib.util, json, sys
print(json.dumps({"path": sys.executable, "version": sys.version.split()[0], "modules": {m: importlib.util.find_spec(m) is not None for m in ${JSON.stringify(MODULES)}}}))`;

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Python did not answer in time."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").at(-1) || `exit code ${code}`));
    });
  });
}

export function installCommand(env: Pick<MentorEnv, "modules" | "python">): string | undefined {
  const py = env.python ? `"${env.python.path}"` : "python";
  const missing = MODULES.filter((m) => env.modules[m] === false);
  if (!missing.length) return undefined;
  const plain = missing.filter((m) => m !== "torch");
  const lines = [];
  if (plain.length) lines.push(`${py} -m pip install ${plain.join(" ")}`);
  if (missing.includes("torch")) lines.push(`${py} -m pip install torch --index-url https://download.pytorch.org/whl/cpu`);
  return lines.join("\n");
}

let cached: { at: number; env: MentorEnv } | null = null;

export async function checkEnv(refresh = false): Promise<MentorEnv> {
  if (cached && !refresh && Date.now() - cached.at < 10 * 60_000) return cached.env;
  const candidates: [string, string[]][] = process.platform === "win32" ? [["python", []], ["py", ["-3"]]] : [["python3", []], ["python", []]];
  let error = "";
  for (const [command, pre] of candidates) {
    try {
      const raw = JSON.parse((await run(command, [...pre, "-c", PROBE], 20_000)).trim().split("\n").at(-1)!);
      const env: MentorEnv = { python: { path: String(raw.path), version: String(raw.version) }, modules: raw.modules ?? {} };
      const install = installCommand(env);
      if (install) env.install = install;
      cached = { at: Date.now(), env };
      return env;
    } catch (e) {
      error ||= (e as Error).message;
    }
  }
  const env: MentorEnv = { modules: {}, error: `Không tìm thấy Python trên máy (${error}). Cài Python 3.10+ từ python.org rồi mở lại VS Code.` };
  cached = { at: Date.now(), env };
  return env;
}
