// Messages between the page (main world), the content script and the
// background service worker.

import type { NotebookEvent, NotebookInfo, NotebookOp } from "@ainb/protocol";

/** window.postMessage markers. */
export const TO_PAGE = "__ainbToPage";
export const TO_EXT = "__ainbToExt";

export type PageToExt =
  | { kind: "ready"; info: NotebookInfo }
  | { kind: "event"; event: NotebookEvent }
  | { kind: "res"; reqId: number; ok: true; result: unknown }
  | { kind: "res"; reqId: number; ok: false; error: string };

/** chrome.runtime messages: content script -> background. */
export type ContentToBackground = { type: "ainb.attached"; info: NotebookInfo } | { type: "ainb.event"; event: NotebookEvent };

/** chrome.tabs messages: background -> content script. */
export type BackgroundToContent = { type: "ainb.op"; op: NotebookOp } | { type: "ainb.ping" };

export type OpResponse = { ok: true; result: unknown } | { ok: false; error: string };
