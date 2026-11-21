// Main-world entry. Finds the notebook app in this frame, then serves
// NotebookOps relayed by the content script over window.postMessage.

import type { NotebookEvent, NotebookOp } from "@ainb/protocol";
import { OpRunner, type NotebookAdapter } from "@ainb/protocol";
import { ColabAdapter, detectColab } from "./colab.js";
import { detectJupyter, JupyterAdapter } from "./jupyter.js";
import { PollGovernor } from "./poll-governor.js";
import { TO_EXT, TO_PAGE, type PageToExt } from "../shared/page-messages.js";

const w = window as unknown as { __ainbPage?: boolean };

function post(msg: PageToExt) {
  window.postMessage({ [TO_EXT]: true, ...msg }, location.origin === "null" ? "*" : location.origin);
}

/**
 * `make` builds the adapter with a nudge it can call when an editor signal
 * says something changed (Jupyter); the runner it will pulse does not exist
 * yet, so the closure resolves late.
 */
function start(make: (nudge: () => void) => NotebookAdapter) {
  let nudgeNow: () => void = () => {};
  const adapter = make(() => nudgeNow());
  let activeOps = 0;
  let runner: OpRunner | undefined;

  // Adaptive pace (A4.1): the pulse's measured cost sets the base, idleness
  // stretches it, and any op or event snaps back. The background timer stays
  // on whatever the pace is — signals only add early ticks, never replace it.
  const governor = new PollGovernor({
    pulseMs: () => runner?.pulseMs ?? 0,
    setPollMs: (ms) => runner?.setPollMs(ms),
    busy: () => {
      if (activeOps > 0) return true;
      try {
        if (adapter.info().kernel === "busy") return true;
        return adapter.runStates?.().some((s) => s.running) ?? false;
      } catch {
        return false;
      }
    },
    log: (line) => console.debug(line),
  });

  runner = new OpRunner(adapter, (event: NotebookEvent) => {
    governor.markActivity();
    post({ kind: "event", event });
  });
  nudgeNow = () => runner?.pulseNow();

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window || !e.data || e.data[TO_PAGE] !== true) return;
    const { reqId, op } = e.data as { reqId: number; op: NotebookOp };
    activeOps++;
    governor.markActivity();
    runner!.run(op).then(
      (result) => {
        activeOps--;
        post({ kind: "res", reqId, ok: true, result });
      },
      (err: Error) => {
        activeOps--;
        post({ kind: "res", reqId, ok: false, error: err?.message ?? String(err) });
      },
    );
  });

  // Announce now, and again whenever the open notebook changes (JupyterLab
  // tabs) or its cell count does (a notebook still loading when first seen).
  // Only a changed key is sent; 5s is plenty for a notebook being loaded.
  let lastKey = "";
  const announce = () => {
    try {
      const info = adapter.info();
      const key = `${info.platform}|${info.title}|${info.docPath ?? ""}|${info.cellCount}`;
      if (key !== lastKey) {
        lastKey = key;
        post({ kind: "ready", info });
      }
    } catch {
      // notebook not ready; try again later
    }
  };
  announce();
  setInterval(announce, 5000);
  // The content script asks again after it (re)loads.
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source === window && e.data?.[TO_PAGE] === "hello") {
      lastKey = "";
      announce();
    }
    // The measurement flag, forwarded from chrome.storage.local (A4.1 debug).
    if (e.source === window && e.data?.[TO_PAGE] === "measure") governor.measure = !!e.data.on;
  });
}

if (!w.__ainbPage) {
  w.__ainbPage = true;
  let tries = 0;
  const probe = () => {
    tries++;
    if (detectColab()) return start(() => new ColabAdapter());
    if (detectJupyter()) return start((nudge) => new JupyterAdapter(nudge));
    // Notebook apps take a while to boot; keep looking, slower after a minute.
    setTimeout(probe, tries < 120 ? 500 : 5000);
  };
  probe();
}
