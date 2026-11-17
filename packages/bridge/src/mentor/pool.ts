// Checking many exercises at once on one notebook machine. A kernel runs one
// call at a time, so the work goes to a pool the kernel keeps in the
// background: a few worker threads, each starting one Python process at a time
// (two per GPU, each process seeing only its GPU; without a GPU, half as many
// as CPUs). Every check of every exercise (references, starters, broken
// solutions, labs) waits in a queue, so a worker that is free takes the next
// one, whichever exercise it belongs to. Checks that train on a GPU have their
// own queue and go first: a GPU's worker takes CPU work only when no GPU work
// waits, so a GPU never idles behind tests that run on the CPU. The bridge sends new work and collects
// what has finished with one short kernel call every few seconds; between
// them the kernel is idle.

import type { Exec } from "./verify.js";

const MARK = /<<MENTOR-POOL (.*) MENTOR-POOL>>/;

export interface PoolInfo {
  gpus: number;
  slots: number;
}

interface Job {
  id: string;
  group: string;
  code: string;
  timeout: number;
  gpu: boolean;
}

interface Done {
  id: string;
  out?: string;
  err?: string;
  timeout?: boolean;
  ms?: number;
}

const START = String.raw`
def _ainb_pool_start():
    import json, os, queue, subprocess, sys, tempfile, threading, time
    old = globals().get("_ainb_pool")
    if old is not None:
        old["stop"]()
    try:
        import torch
        gpus = torch.cuda.device_count()
    except Exception:
        gpus = 0
    cpus = os.cpu_count() or 1
    slots = max(1, 2 * gpus if gpus else cpus // 2)
    import collections
    gpu_jobs, cpu_jobs, done, running = collections.deque(), collections.deque(), [], set()
    lock = threading.Lock()
    ready = threading.Condition(lock)
    state = {"stopped": False}
    base = os.path.join(tempfile.gettempdir(), "ainb-verify")
    def next_job():
        with ready:
            while True:
                if state["stopped"]:
                    return None
                if gpu_jobs:
                    return gpu_jobs.popleft()
                if cpu_jobs:
                    return cpu_jobs.popleft()
                ready.wait()
    def work(device):
        while True:
            job = next_job()
            if job is None:
                return
            # One folder per exercise: data its reference downloaded is found again by its other checks.
            folder = os.path.join(base, job["group"])
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, job["id"] + ".py")
            with open(path, "w", encoding="utf-8") as f:
                f.write(job["code"])
            env = dict(os.environ, MPLBACKEND="Agg", PYTHONIOENCODING="utf-8", OMP_NUM_THREADS=str(max(1, cpus // slots)))
            if device is not None:
                env["CUDA_VISIBLE_DEVICES"] = str(device)
            r = {"id": job["id"]}
            t0 = time.time()
            try:
                p = subprocess.Popen([sys.executable, path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env, cwd=folder)
                with lock:
                    running.add(p)
                try:
                    out, err = p.communicate(timeout=job["timeout"])
                except subprocess.TimeoutExpired:
                    p.kill()
                    out, err = p.communicate()
                    r["timeout"] = True
                finally:
                    with lock:
                        running.discard(p)
                r["out"] = out[-50000:]
                if p.returncode and not r.get("timeout"):
                    r["err"] = f"exit {p.returncode}: " + " | ".join(err.strip().splitlines()[-3:])
            except Exception as e:
                r["err"] = f"{type(e).__name__}: {e}"
            r["ms"] = int(1000 * (time.time() - t0))
            with lock:
                done.append(r)
    for k in range(slots):
        threading.Thread(target=work, args=(k % gpus if gpus else None,), daemon=True).start()
    def add(jobs):
        with ready:
            for j in jobs:
                (gpu_jobs if j.get("gpu") and gpus else cpu_jobs).append(j)
            ready.notify_all()
    def take():
        with lock:
            out = list(done)
            done.clear()
        return out
    def stop():
        with ready:
            state["stopped"] = True
            gpu_jobs.clear()
            cpu_jobs.clear()
            ready.notify_all()
            for p in list(running):
                p.kill()
    globals()["_ainb_pool"] = {"add": add, "take": take, "stop": stop}
    print("<<MENTOR-POOL " + json.dumps({"gpus": gpus, "slots": slots}) + " MENTOR-POOL>>")
try:
    _ainb_pool_start()
finally:
    del _ainb_pool_start
`.trimStart();

function pollCode(jobs: Job[]): string {
  const b64 = Buffer.from(JSON.stringify(jobs), "utf8").toString("base64");
  return `import base64 as _b, json as _j
_ainb_pool["add"](_j.loads(_b.b64decode("${b64}").decode("utf-8")))
print("<<MENTOR-POOL " + _j.dumps(_ainb_pool["take"](), ensure_ascii=False) + " MENTOR-POOL>>")
del _b, _j
`;
}

const STOP = `if "_ainb_pool" in globals():
    _ainb_pool["stop"]()
    del _ainb_pool
`;

function marked<T>(res: Awaited<ReturnType<Exec>>): T | null {
  const text = res.outputs.filter((o) => o.kind === "stream").map((o) => o.text ?? "").join("");
  const m = text.match(MARK);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return null;
  }
}

function why(res: Awaited<ReturnType<Exec>>): string {
  const err = res.outputs.find((o) => o.kind === "error");
  return err ? `${err.ename ?? "Error"}: ${err.evalue ?? ""}` : res.message ?? res.status;
}

export class KernelPool {
  private seq = 0;
  private queued: Job[] = [];
  private waiting = new Map<string, { resolve: (r: Awaited<ReturnType<Exec>>) => void; reject: (e: Error) => void }>();
  private closed = false;
  private loop?: Promise<void>;
  private failure?: Error;

  constructor(private readonly kernel: Exec, private readonly pollMs = 3000) {}

  /** Starts the pool in the kernel (stopping one an earlier check left). */
  async start(): Promise<PoolInfo> {
    const res = await this.kernel(START, 120_000);
    const info = marked<PoolInfo>(res);
    if (!info) throw new Error(`Could not start the checking pool in the kernel: ${why(res)}`);
    this.loop = this.run();
    return info;
  }

  /** An Exec whose calls wait in the pool's queue; `group` names the folder they run in, `gpu`: they train on a GPU. */
  exec(group: string, gpu = false): Exec {
    return (code, waitMs) => new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const id = `j${++this.seq}`;
      this.waiting.set(id, { resolve, reject });
      this.queued.push({ id, group: group.replace(/[^\w.-]/g, "_"), code, timeout: Math.max(1, Math.ceil(waitMs / 1000)), gpu });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.loop;
    await this.kernel(STOP, 30_000).catch(() => {});
  }

  private fail(e: Error): void {
    this.failure = e;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
    this.queued = [];
  }

  private async run(): Promise<void> {
    while (!this.closed && !this.failure) {
      const jobs = this.queued.splice(0);
      let res: Awaited<ReturnType<Exec>>;
      try {
        res = await this.kernel(pollCode(jobs), 60_000);
      } catch (e) {
        // A cell of the learner's holds the kernel: the pool runs on behind it, try again.
        if (/kernel is busy/i.test((e as Error).message)) {
          this.queued.unshift(...jobs);
          await new Promise((r) => setTimeout(r, this.pollMs));
          continue;
        }
        this.fail(e as Error);
        return;
      }
      const done = marked<Done[]>(res);
      if (!done) {
        this.fail(new Error(`The checking pool in the kernel is gone (was the kernel restarted?): ${why(res)}`));
        return;
      }
      for (const d of done) {
        const w = this.waiting.get(d.id);
        if (!w) continue;
        this.waiting.delete(d.id);
        const text = (d.out ?? "") + (d.err ? `\n${d.err}` : "");
        w.resolve({
          status: d.timeout ? "running" : d.err ? "error" : "ok",
          outputs: [{ kind: "stream", name: "stdout", text }],
          ...(d.err ? { message: d.err } : {}),
          ...(d.ms !== undefined ? { ms: d.ms } : {}),
        });
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}
