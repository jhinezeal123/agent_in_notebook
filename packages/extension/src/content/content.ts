// Isolated-world content script: relays between the page script and the
// background. It forwards only notebook data and op results upward; the page
// can never send chat commands to the bridge.

import type { NotebookInfo } from "@ainb/protocol";
import { TO_EXT, TO_PAGE, type BackgroundToContent, type ContentToBackground, type ContentToPage, type OpResponse, type PageToExt, type PingResponse, type ReplayResponse } from "../shared/page-messages.js";
import { EventRing } from "../shared/replay.js";

let attached: NotebookInfo | null = null;
let nextReq = 1;
const pending = new Map<number, (r: OpResponse) => void>();

/** This content-script instance: a tab reload starts a new one, with new sequences. */
const bootId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
/** The last events, so the worker can replay what it missed while it slept (A6.1). */
const ring = new EventRing(128);

function toBackground(msg: ContentToBackground) {
  // After the extension is reloaded, this old copy stays in the tab until the
  // tab reloads, and sendMessage throws "Extension context invalidated" at
  // once: it has no background left to talk to, so it stays quiet. The event
  // still rides in the ring: the next worker asks for it by sequence.
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Service worker restarting; it pings frames again when it comes back.
    });
  } catch {
    // Context invalidated between the check and the call.
  }
}

function toPage(msg: ContentToPage) {
  window.postMessage(msg, location.origin === "null" ? "*" : location.origin);
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || !e.data || e.data[TO_EXT] !== true) return;
  const msg = e.data as PageToExt;
  switch (msg.kind) {
    case "ready":
      attached = msg.info;
      toBackground({ type: "ainb.attached", info: msg.info, bootId, seq: ring.lastSeq });
      return;
    case "event":
      if (attached) {
        const seq = ring.push(msg.event);
        toBackground({ type: "ainb.event", event: msg.event, seq, bootId });
      }
      return;
    case "res": {
      const done = pending.get(msg.reqId);
      if (!done) return;
      pending.delete(msg.reqId);
      try {
        done(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
      } catch {
        // Nobody waits for this answer any more (the background gave up on the
        // op, restarted, or the extension was reloaded): drop it.
      }
      return;
    }
  }
});

chrome.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, sendResponse) => {
  // Frames without a notebook stay silent so the frame that has one answers.
  if (!attached) return false;
  if (msg.type === "ainb.ping") {
    sendResponse({ attached: true, info: attached, seq: ring.lastSeq, bootId } satisfies PingResponse);
    return false;
  }
  if (msg.type === "ainb.replay") {
    // Only this instance's own sequences: a worker asking with an old bootId
    // gets an empty answer and learns the current one from it.
    const events = msg.bootId === bootId ? ring.since(msg.fromSeq) : [];
    sendResponse({ bootId, seq: ring.lastSeq, events } satisfies ReplayResponse);
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
toPage({ [TO_PAGE]: "hello" });

// The measurement flag (A4.1) lives in chrome.storage.local, which the page's
// main world cannot read: forward it down, now and whenever it changes. This
// is a debug toggle, not a chat command — the upward boundary is unchanged.
try {
  void chrome.storage.local.get("ainbMeasure").then((r) => toPage({ [TO_PAGE]: "measure", on: !!r.ainbMeasure })).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ainbMeasure) toPage({ [TO_PAGE]: "measure", on: !!changes.ainbMeasure.newValue });
  });
} catch {
  // storage unavailable in this frame
}
