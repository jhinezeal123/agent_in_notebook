// Isolated-world content script: relays between the page script and the
// background. It forwards only notebook data and op results upward; the page
// can never send chat commands to the bridge.

import type { NotebookInfo } from "@ainb/protocol";
import { TO_EXT, TO_PAGE, type BackgroundToContent, type ContentToBackground, type OpResponse, type PageToExt } from "../shared/page-messages.js";

let attached: NotebookInfo | null = null;
let nextReq = 1;
const pending = new Map<number, (r: OpResponse) => void>();

function toBackground(msg: ContentToBackground) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Service worker restarting; it pings frames again when it comes back.
  });
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || !e.data || e.data[TO_EXT] !== true) return;
  const msg = e.data as PageToExt;
  switch (msg.kind) {
    case "ready":
      attached = msg.info;
      toBackground({ type: "ainb.attached", info: msg.info });
      return;
    case "event":
      if (attached) toBackground({ type: "ainb.event", event: msg.event });
      return;
    case "res": {
      const done = pending.get(msg.reqId);
      if (!done) return;
      pending.delete(msg.reqId);
      done(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
      return;
    }
  }
});

chrome.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, sendResponse) => {
  // Frames without a notebook stay silent so the frame that has one answers.
  if (!attached) return false;
  if (msg.type === "ainb.ping") {
    sendResponse({ attached: true, info: attached });
    return false;
  }
  if (msg.type === "ainb.op") {
    const reqId = nextReq++;
    pending.set(reqId, sendResponse);
    window.postMessage({ [TO_PAGE]: true, reqId, op: msg.op }, location.origin === "null" ? "*" : location.origin);
    return true;
  }
  return false;
});

// The page script may have announced before this script loaded.
window.postMessage({ [TO_PAGE]: "hello" }, location.origin === "null" ? "*" : location.origin);
