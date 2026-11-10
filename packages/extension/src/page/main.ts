// Main-world entry. Finds the notebook app in this frame, then serves
// NotebookOps relayed by the content script over window.postMessage.

import type { NotebookEvent, NotebookOp } from "@ainb/protocol";
import { OpRunner, type NotebookAdapter } from "./adapter.js";
import { ColabAdapter, detectColab } from "./colab.js";
import { detectJupyter, JupyterAdapter } from "./jupyter.js";
import { TO_EXT, TO_PAGE, type PageToExt } from "../shared/page-messages.js";

const w = window as unknown as { __ainbPage?: boolean };

function post(msg: PageToExt) {
  window.postMessage({ [TO_EXT]: true, ...msg }, location.origin === "null" ? "*" : location.origin);
}

function start(adapter: NotebookAdapter) {
  const runner = new OpRunner(adapter, (event: NotebookEvent) => post({ kind: "event", event }));

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window || !e.data || e.data[TO_PAGE] !== true) return;
    const { reqId, op } = e.data as { reqId: number; op: NotebookOp };
    runner.run(op).then(
      (result) => post({ kind: "res", reqId, ok: true, result }),
      (err: Error) => post({ kind: "res", reqId, ok: false, error: err?.message ?? String(err) }),
    );
  });

  // Announce now, and again whenever the open notebook changes (JupyterLab tabs).
  let lastKey = "";
  const announce = () => {
    try {
      const info = adapter.info();
      const key = `${info.platform}|${info.title}`;
      if (key !== lastKey) {
        lastKey = key;
        post({ kind: "ready", info });
      }
    } catch {
      // notebook not ready; try again later
    }
  };
  announce();
  setInterval(announce, 2000);
  // The content script asks again after it (re)loads.
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source === window && e.data?.[TO_PAGE] === "hello") {
      lastKey = "";
      announce();
    }
  });
}

if (!w.__ainbPage) {
  w.__ainbPage = true;
  let tries = 0;
  const probe = () => {
    tries++;
    if (detectColab()) return start(new ColabAdapter());
    if (detectJupyter()) return start(new JupyterAdapter());
    // Notebook apps take a while to boot; keep looking, slower after a minute.
    setTimeout(probe, tries < 120 ? 500 : 5000);
  };
  probe();
}
