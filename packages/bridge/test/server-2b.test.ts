// Đợt 2c (server-side): WS perMessageDeflate, chat.changes RPC, chat.meta without
// full snapshot, adoptRenamed boot deduplication, and dropAllChats setup cleanup.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WIRE_VERSION, type AppliedChange, type ChatSnapshot } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";

const TOKEN = "test-token-2b-0123456789abcdef";
const CLI = resolve(__dirname, "../dist/cli.js");
const FAKE_AGENT = resolve(__dirname, "fixtures/fake-agent.mjs");
const NO_ORX = { knownPorts: [], locate: () => ({ missing: "OpenResearch not used." }) };

let home: string;
let bridge: Bridge;
let port: number;
let nextTab = 200;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ainb-2b-"));
  process.env.AINB_HOME = home;
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify([{ id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE_AGENT], toolWaitSeconds: 3 }]),
  );
  bridge = new Bridge({ port: 0, token: TOKEN, mcpCommand: { command: process.execPath, args: [CLI, "mcp"] }, research: NO_ORX, log: () => {} });
  port = await bridge.listen();
});

afterAll(async () => {
  await bridge?.close();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* windows child exit */ }
});

describe("Đợt 2c server plumbing (2c-bridge2b)", () => {
  it("negotiates perMessageDeflate on WebSocket upgrade (A3.1)", async () => {
    const extHeader = await new Promise<string | undefined>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode`, { perMessageDeflate: true });
      ws.on("upgrade", (res) => {
        resolve(res.headers["sec-websocket-extensions"]);
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(extHeader).toMatch(/permessage-deflate/i);
  });

  it("serves chat.changes from the journal and emits chat.meta on settings update (B2.1, A3.3)", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    const ext = new FakeExtension(nb, nextTab++);
    await ext.connect(port, TOKEN);
    const snap = await ext.request<ChatSnapshot>("chat.open", {
      tabId: ext.tabId,
      agentId: "fake",
      settings: { scope: "write", review: false, targetCellIds: [] },
      platform: "colab",
    });
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");

    const metas: unknown[] = [];
    let rawSnapshots = 0;
    ext.rpc.on("chat.meta", (p) => metas.push(p));
    ext.rpc.on("chat.snapshot", () => { rawSnapshots++; });

    await ext.request("chat.settings", {
      chatId: snap.chatId,
      settings: { scope: "auto", review: false, targetCellIds: [] },
    });
    await ext.waitFor(() => metas.length > 0, 5_000, "chat.meta");
    expect(rawSnapshots).toBe(0);

    // Seed a journal entry on the chat and read it through chat.changes.
    const chat = (bridge as unknown as { chats: Map<number, { journal: Map<string, AppliedChange[]> }> }).chats.get(ext.tabId)!;
    const change: AppliedChange = { kind: "update", cellId: "c1", cellType: "code", index: 0, before: "x = 1", after: "x = 2" };
    chat.journal.set("m-1", [change]);

    const res = await ext.request<{ changes: AppliedChange[] }>("chat.changes", { chatId: snap.chatId, messageId: "m-1" });
    expect(res.changes).toEqual([change]);
    const empty = await ext.request<{ changes: AppliedChange[] }>("chat.changes", { chatId: snap.chatId, messageId: "none" });
    expect(empty.changes).toEqual([]);

    ext.close();
  });

  it("only scans store.listMeta in adoptRenamed when boot changes (A4.5)", async () => {
    const nb = new FakeNotebook([{ type: "code", source: "x = 1" }]);
    nb.platform = "kaggle";
    const ext = new FakeExtension(nb, nextTab++);
    await ext.connect(port, TOKEN);
    await ext.request<ChatSnapshot>("chat.open", {
      tabId: ext.tabId,
      agentId: "fake",
      settings: { scope: "write", review: false, targetCellIds: [] },
      platform: "kaggle",
      notebookKey: "kaggle:u/nb-adopt-test",
    });
    await ext.waitFor(() => ext.statuses.includes("idle"), 30_000, "agent start");

    const store = (bridge as unknown as { store: { listMeta: () => unknown[] } }).store;
    const spy = vi.spyOn(store, "listMeta");
    const adopt = (bridge as unknown as { adoptRenamed: (t: { kind: string; tabId: number }, k: string, b: string) => void }).adoptRenamed.bind(bridge);
    const target = { kind: "vscode", tabId: ext.tabId };

    adopt(target, "kaggle:u/nb-adopt-test", "boot-1");
    adopt(target, "kaggle:u/nb-adopt-test", "boot-1");
    adopt(target, "kaggle:u/nb-adopt-test", "boot-1");
    expect(spy).toHaveBeenCalledTimes(1);

    adopt(target, "kaggle:u/nb-adopt-test", "boot-2");
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
    ext.close();
  });

  it("validates WIRE_VERSION on hello", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vscode`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ kind: "req", id: 1, method: "hello", params: { token: TOKEN, wire: WIRE_VERSION - 1, extensionVersion: "0.0.0" } }));
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(4400);
  });
});
