// Messages between the page (main world), the content script and the
// background service worker.

import type { NotebookEvent, NotebookInfo, NotebookOp } from "@ainb/protocol";
import type { SequencedEvent } from "./replay.js";

/** window.postMessage markers. */
export const TO_PAGE = "__ainbToPage";
export const TO_EXT = "__ainbToExt";

export type PageToExt =
  | { kind: "ready"; info: NotebookInfo }
  | { kind: "event"; event: NotebookEvent }
  | { kind: "res"; reqId: number; ok: true; result: unknown }
  | { kind: "res"; reqId: number; ok: false; error: string };

/**
 * chrome.runtime messages: content script -> background. `bootId` identifies
 * one content-script instance (a tab reload starts a new one); `seq` numbers
 * this instance's events from 1 so the worker can replay what it missed while
 * it slept (A6.1). Only notebook data travels up — never chat commands.
 */
export type ContentToBackground =
  | { type: "ainb.attached"; info: NotebookInfo; bootId: string; seq: number }
  | { type: "ainb.event"; event: NotebookEvent; seq: number; bootId: string };

/** chrome.tabs messages: background -> content script. */
export type BackgroundToContent =
  | { type: "ainb.op"; op: NotebookOp }
  | { type: "ainb.ping" }
  /** Send the buffered events with seq >= fromSeq (this instance's own bootId). */
  | { type: "ainb.replay"; fromSeq: number; bootId: string };

/** What a frame answers to ainb.ping when it holds a notebook. */
export interface PingResponse {
  attached: true;
  info: NotebookInfo;
  seq: number;
  bootId: string;
}

/** What a frame answers to ainb.replay: its current bootId/seq and the buffered part. */
export interface ReplayResponse {
  bootId: string;
  seq: number;
  events: SequencedEvent[];
}

/** window.postMessage: content script -> page, alongside the ops it relays. */
export type ContentToPage =
  | { [TO_PAGE]: "hello" }
  /** The `ainbMeasure` flag of chrome.storage.local, which the page world cannot read. */
  | { [TO_PAGE]: "measure"; on: boolean };

export type OpResponse = { ok: true; result: unknown } | { ok: false; error: string };
