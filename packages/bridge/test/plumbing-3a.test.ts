// Đợt 3a plumbing: chat.pin + pinned survival past 200-msg trim, chat.dequeue,
// chats.search, mentor.status, browserConnected/browser.status, KaggleQuotaWatcher (C3),
// and read-only experiment_list / run_read tools (C4).

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage, KaggleQuotaStatus } from "@ainb/protocol";
import { ChatStore, MAX_MESSAGES, trimMessages } from "../src/store.js";
import { KaggleQuotaWatcher } from "../src/research/quota.js";
import type { Orx } from "../src/research/orx.js";
import { callTool } from "../src/notebook/tools.js";
import { PROJECT_TOOLS, type ProjectToolContext } from "../src/project/tools.js";
import { Mentor } from "../src/mentor/index.js";

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* windows */ }
  }
});

describe("B4.3 pinned messages survive trim & keep journal", () => {
  it("keeps pinned messages ahead of the 200-message window in chronological order", () => {
    const msgs: ChatMessage[] = Array.from({ length: MAX_MESSAGES + 10 }, (_, i) => ({
      id: `m${i}`,
      role: "agent",
      parts: [{ type: "text", text: `msg ${i}` }],
      createdAt: i,
      ...(i === 2 || i === 5 ? { pinned: true } : {}),
    }));
    const { kept, dropped } = trimMessages(msgs, MAX_MESSAGES);
    expect(kept.length).toBe(MAX_MESSAGES + 2);
    expect(kept[0]!.id).toBe("m2");
    expect(kept[1]!.id).toBe("m5");
    expect(kept[2]!.id).toBe("m10");
    expect(dropped.some((m) => m.id === "m2" || m.id === "m5")).toBe(false);
    expect(dropped.some((m) => m.id === "m0")).toBe(true);
  });

  it("persists pinned messages and their undo journal entries past MAX_MESSAGES", () => {
    const store = new ChatStore(tmpDir("ainb-pin-"));
    const msgs: ChatMessage[] = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({
      id: `m${i}`,
      role: "agent",
      parts: [{ type: "text", text: `body ${i}` }],
      createdAt: i,
      ...(i === 0 ? { pinned: true, changes: { count: 1 } } : {}),
    }));
    store.save({
      key: "nb:pin",
      agentId: "claude",
      messages: msgs,
      journal: {
        m0: [{ kind: "update", cellId: "c1", cellType: "code", index: 0, before: "a", after: "b" }],
        m1: [{ kind: "update", cellId: "c1", cellType: "code", index: 0, before: "b", after: "c" }],
      },
    });
    const loaded = store.load("nb:pin")!;
    expect(loaded.messages[0]!.id).toBe("m0");
    expect(loaded.messages[0]!.pinned).toBe(true);
    expect(loaded.journal?.m0?.length).toBe(1);
    expect(loaded.journal?.m1).toBeUndefined();
  });
});

describe("B4.2 ChatStore.search", () => {
  it("finds matching messages across saved notebooks with snippets and metadata", () => {
    const store = new ChatStore(tmpDir("ainb-search-"));
    store.saveMeta("colab:/a", { title: "ResNet Ablation", platform: "colab", url: "https://colab.research.google.com/a" });
    store.save({
      key: "colab:/a",
      agentId: "claude",
      title: "ResNet Ablation",
      messages: [
        { id: "u1", role: "user", createdAt: 100, parts: [{ type: "text", text: "Why did cosine annealing diverge?" }] },
        { id: "a1", role: "agent", createdAt: 200, parts: [{ type: "text", text: "Check warmup steps before cosine annealing." }] },
      ],
    });
    const hits = store.search("cosine annealing");
    expect(hits.length).toBe(2);
    expect(hits[0]!.messageId).toBe("a1");
    expect(hits[0]!.title).toBe("ResNet Ablation");
    expect(hits[0]!.snippet).toMatch(/cosine annealing/i);
  });
});

describe("A7.1 Mentor.status", () => {
  it("returns lightweight streak, overall rating and dueReviews count", () => {
    const mentor = new Mentor({ dir: tmpDir("ainb-mentor-st-") });
    const st = mentor.status();
    expect(st.streak).toBe(0);
    expect(st.overall).toBe(1000);
    expect(st.dueReviews).toBe(0);
    expect(st.activeToday).toBe(false);
  });
});

describe("C3 KaggleQuotaWatcher", () => {
  it("detects low GPU quota and idle live sessions without starting orx", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/settings/kaggle") {
        res.end(JSON.stringify({ configured: true }));
      } else if (req.url === "/api/settings/kaggle/quota") {
        res.end(JSON.stringify({ accounts: [{ account: "main", gpu: { used: 27, reserved: 0, total: 30, remaining: 3 } }] }));
      } else if (req.url === "/api/settings/kaggle/sessions") {
        res.end(JSON.stringify({ sessions: [{ id: "s1", account: "main", created: 1, deadline: 9999999999, state: "live", active_run: null, note: "idle gpu" }] }));
      } else if (req.url === "/api/settings/kaggle/close-session") {
        res.end(JSON.stringify({ closing: true }));
      } else {
        res.end("{}");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const updates: KaggleQuotaStatus[] = [];
    const fakeOrx = { status: { state: "ready", url: `http://127.0.0.1:${port}` } } as unknown as Orx;
    const watcher = new KaggleQuotaWatcher(fakeOrx, { onUpdate: (s) => updates.push(s), idleWarnMs: 0 });
    try {
      const st = await watcher.check(true);
      expect(st.configured).toBe(true);
      expect(st.lowGpuAccounts).toEqual(["main"]);
      expect(st.idleSessions.map((s) => s.id)).toEqual(["s1"]);
      expect(updates.length).toBe(1);
      const closed = await watcher.closeSession("s1");
      expect(closed.closing).toBe(true);
    } finally {
      watcher.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("C4 read-only experiment_list and run_read MCP tools", () => {
  it("lists experiments and reads a run's result, metrics and log", async () => {
    const api = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith("/experiments")) return { experiments: [{ id: "e1", title: "LoRA rank 8", archived: false, updatedAt: 10 }] };
      if (path.endsWith("/runs")) return { runs: [{ id: "r1", experimentId: "e1", status: "done", exitCode: 0, resultMarkdown: "val_loss=0.42", startedAt: 1000, endedAt: 5000 }] };
      if (path.includes("/trackio/")) return { metrics: [{ name: "val_loss", points: [{ step: 1, value: 0.9 }, { step: 2, value: 0.42 }] }] };
      if (path.includes("/log?")) return { content: "epoch 1 done\nepoch 2 done" };
      return {};
    });
    const ctx = {
      project: async () => ({ id: "p1", name: "Demo", artifactsDir: "/tmp" }),
      research: { api },
    } as unknown as ProjectToolContext;

    const list = await callTool(ctx, "experiment_list", {}, PROJECT_TOOLS);
    expect(list.isError).toBeFalsy();
    expect(list.text).toContain("LoRA rank 8 [e1]");
    expect(list.text).toContain("val_loss=0.42");

    const run = await callTool(ctx, "run_read", { run_id: "r1" }, PROJECT_TOOLS);
    expect(run.isError).toBeFalsy();
    expect(run.text).toContain("Run r1");
    expect(run.text).toContain("val_loss: 0.42");
    expect(run.text).toContain("epoch 2 done");
  });
});
