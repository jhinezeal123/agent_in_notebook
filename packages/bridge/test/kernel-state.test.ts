import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DONE, program } from "../src/notebook/kernel.js";
import { VARS_SOURCE } from "../src/notebook/tools.js";

const hasIpython = spawnSync("python", ["-c", "import IPython"], { stdio: "ignore" }).status === 0;

describe("kernel_state on IPython", () => {
  it.skipIf(!hasIpython)("reads user_ns from the helper's separate namespace", () => {
    const script = `from IPython.core.interactiveshell import InteractiveShell\nshell = InteractiveShell.instance()\nshell.user_ns["answer"] = 42\n${program(DONE + VARS_SOURCE, "_ainb_vars", { limit: 10 })}`;
    const result = spawnSync("python", ["-c", script], { encoding: "utf8", timeout: 15_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const line = result.stdout.split("\n").find((l) => l.startsWith("\u001eainb "));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!.slice("\u001eainb ".length));
    expect(parsed.vars).toEqual([expect.objectContaining({ name: "answer", type: "builtins.int", size: 28 })]);
    expect(parsed.vars[0].device).toBeUndefined();
  });
});
