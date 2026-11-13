// The way to the machine that does not go through the kernel: the Python loop
// typed into a notebook server's terminal, run here for real behind a fake
// terminal, and OpRunner's choice between it and the kernel.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { CellInfo, NotebookInfo, RunResult } from "@ainb/protocol";
import { NoServerPython, OpError, OpRunner, OutputCollector, type Execution, type NotebookAdapter } from "@ainb/protocol";
import { bootLine, ServerPython, type TerminalLink } from "../src/page/server-python.js";

const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

/**
 * A terminal whose shell understands only the boot line: it runs the loop
 * with a local Python, its stdin and stdout standing in for the terminal.
 */
function fakeTerminal(children: ChildProcess[], opts: { shell?: "none" } = {}): () => Promise<TerminalLink> {
  return async () => {
    let child: ChildProcess | null = null;
    const output: ((t: string) => void)[] = [];
    const closed: (() => void)[] = [];
    return {
      send(text) {
        if (child) return void child.stdin!.write(text);
        // The shell echoes what it is typed, then runs it.
        for (const cb of output) cb(`$ ${text}\r\n`);
        const m = text.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/);
        if (!m || opts.shell === "none") return;
        child = spawn(PYTHON!, ["-u", "-c", Buffer.from(m[1]!, "base64").toString("utf8")], { stdio: ["pipe", "pipe", "inherit"] });
        children.push(child);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (d: string) => output.forEach((cb) => cb(d)));
        child.on("exit", () => closed.forEach((cb) => cb()));
      },
      onOutput: (cb) => output.push(cb),
      onClose: (cb) => closed.push(cb),
      close: () => child?.kill(),
    };
  };
}

describe.skipIf(!PYTHON)("Python in the notebook server's terminal", () => {
  const children: ChildProcess[] = [];
  afterEach(() => children.splice(0).forEach((c) => c.kill()));

  it("starts once and runs code, returning what it printed", async () => {
    const py = new ServerPython(fakeTerminal(children));
    expect(await py.run("print('hello')", 10_000)).toEqual({ status: "ok", outputs: [{ kind: "stream", name: "stdout", text: "hello\n" }] });
    expect(await py.run("import os\nprint(os.getpid() > 0, end='')", 10_000)).toEqual({ status: "ok", outputs: [{ kind: "stream", name: "stdout", text: "True" }] });
    expect(children).toHaveLength(1);
  }, 30_000);

  it("carries large requests and replies, and text that is not ASCII", async () => {
    const py = new ServerPython(fakeTerminal(children));
    const big = "xé€😀".repeat(200_000);
    const r = await py.run(`s = ${JSON.stringify(big)}\nprint(len(s), s[-6:])`, 30_000);
    expect(r.outputs[0]!.text).toBe(`${[...big].length} ${[...big].slice(-6).join("")}\n`);
    const back = await py.run(`print("y" * 1500000)`, 30_000);
    expect(back.outputs[0]!.text!.length).toBe(1_500_001);
  }, 60_000);

  it("reports an exception with its traceback", async () => {
    const py = new ServerPython(fakeTerminal(children));
    const r = await py.run("print('before')\nraise ValueError('nope')", 10_000);
    expect(r.status).toBe("error");
    expect(r.outputs[0]).toEqual({ kind: "stream", name: "stdout", text: "before\n" });
    expect(r.outputs[1]).toMatchObject({ kind: "error", ename: "ValueError", evalue: "nope" });
  }, 30_000);

  it("opens a new terminal after the old one closed", async () => {
    const py = new ServerPython(fakeTerminal(children));
    await py.run("pass", 10_000);
    children[0]!.kill();
    await new Promise((r) => children[0]!.once("exit", r));
    expect((await py.run("print(1)", 10_000)).outputs[0]!.text).toBe("1\n");
    expect(children).toHaveLength(2);
  }, 30_000);

  it("gives up for a while when Python does not start there", async () => {
    const py = new ServerPython(fakeTerminal(children, { shell: "none" }));
    const started = Date.now();
    await expect(py.run("pass", 1000)).rejects.toBeInstanceOf(NoServerPython);
    expect(Date.now() - started).toBeGreaterThan(19_000);
    expect(py.usable).toBe(false);
    await expect(py.run("pass", 1000)).rejects.toBeInstanceOf(NoServerPython);
  }, 40_000);

  it("is typed into the shell as one line, kept out of its history", () => {
    const line = bootLine();
    expect(line.startsWith(" exec ")).toBe(true);
    expect(line.endsWith("\r")).toBe(true);
    expect(line.length).toBeLessThan(4000);
  });
});

describe("machine_exec", () => {
  const info: NotebookInfo = { platform: "jupyter", title: "t", url: "u", cellCount: 0, activeCellId: null, selectedCellIds: [], kernel: "busy", language: "python" };
  const adapter = (machine?: NotebookAdapter["machineExec"]) => {
    const executed: string[] = [];
    const a: NotebookAdapter = {
      platform: "jupyter",
      info: () => info,
      getCells: (): CellInfo[] => [],
      setSource: () => false,
      insertCell: async () => "x",
      deleteCell: () => {},
      moveCell: () => 0,
      runCell: async (): Promise<RunResult> => ({ cellId: "x", status: "ok", outputs: [] }),
      startExecution: async (code): Promise<Execution> => {
        executed.push(code);
        const collected = new OutputCollector();
        collected.add({ output_type: "stream", name: "stdout", text: "from the kernel\n" });
        return { reply: Promise.resolve({ status: "ok" }), collected };
      },
      machineExec: machine,
      interrupt: () => false,
      focusCell: () => false,
      showReview: () => ({ decided: new Promise(() => {}), resolve: () => {} }),
      onSelectionChange: () => {},
    };
    return { runner: new OpRunner(a, () => {}), executed };
  };

  it("goes through the server's terminal when there is one, else the kernel", async () => {
    const viaServer = adapter(async () => ({ status: "ok", outputs: [{ kind: "stream", name: "stdout", text: "from the server\n" }] }));
    expect(await viaServer.runner.run({ op: "machine_exec", code: "x", waitMs: 1000 })).toMatchObject({ outputs: [{ text: "from the server\n" }] });
    expect(viaServer.executed).toEqual([]);

    const noTerminals = adapter(async () => Promise.reject(new NoServerPython("no terminals")));
    expect(await noTerminals.runner.run({ op: "machine_exec", code: "x", waitMs: 1000 })).toMatchObject({ outputs: [{ text: "from the kernel\n" }] });
    expect((await adapter().runner.run({ op: "machine_exec", code: "x", waitMs: 1000 }) as { outputs: unknown[] }).outputs).toHaveLength(1);

    // Any other failure is the answer: the code may have run.
    const failing = adapter(async () => Promise.reject(new OpError("The notebook machine did not answer in time.")));
    await expect(failing.runner.run({ op: "machine_exec", code: "x", waitMs: 1000 })).rejects.toThrow("did not answer");
    expect(failing.executed).toEqual([]);
  });
});
