// Smoke test against the real agents installed on this machine. Uses the
// user's own accounts, so it only runs when asked:
//   REAL_AGENTS=claude,codex,gemini,opencode pnpm --filter @ainb/bridge exec vitest run test/real-agents.test.ts
// Custom ACP agents: point REAL_AGENTS_FILE at an agents.json (it is copied, not changed)
// and list their ids in REAL_AGENTS.

import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatSnapshot, Part } from "@ainb/protocol";
import { Bridge } from "../src/server.js";
import { FakeExtension, FakeNotebook } from "./fixtures/fake-extension.js";

const AGENTS = (process.env.REAL_AGENTS ?? "").split(",").filter(Boolean);
/** A 16x16 solid green PNG. Nothing else in the notebook names the color. */
const GREEN_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGMQOaFBEmIY1TCqYfhqAAAmYgQQb/1iygAAAABJRU5ErkJggg==";
const TOKEN = "real-agent-token-0123456789";
let bridge: Bridge;
let port: number;

beforeAll(async () => {
  if (!AGENTS.length) return;
  process.env.AINB_HOME = mkdtempSync(join(tmpdir(), "ainb-real-"));
  if (process.env.REAL_AGENTS_FILE) copyFileSync(process.env.REAL_AGENTS_FILE, join(process.env.AINB_HOME, "agents.json"));
  bridge = new Bridge({
    port: 0,
    token: TOKEN,
    mcpCommand: { command: process.execPath, args: [resolve(__dirname, "../dist/cli.js"), "mcp"] },
    log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
  });
  port = await bridge.listen();
});

afterAll(async () => {
  await bridge?.close();
});

describe.skipIf(!AGENTS.length)("real agents", () => {
  for (const [i, agentId] of AGENTS.entries()) {
    it(`${agentId} edits the notebook through the tools`, { timeout: 300_000 }, async () => {
      const nb = new FakeNotebook([
        { type: "markdown", source: "# Smoke test" },
        { type: "code", source: "print('old')" },
      ]);
      const ext = new FakeExtension(nb, 500 + i);
      await ext.connect(port, TOKEN);
      const snap = await ext.request<ChatSnapshot>("chat.open", {
        tabId: ext.tabId,
        agentId,
        settings: { scope: "write", review: false, targetCellIds: [] },
        platform: "colab",
      });
      await ext.waitFor(() => ext.statuses.includes("idle") || ext.statuses.includes("error"), 120_000, "agent start");
      const started = await ext.request<ChatSnapshot>("chat.get", { tabId: ext.tabId });
      expect(started?.error, started?.error).toBeUndefined();
      console.log(`${agentId} options:`, started?.options.map((o) => `${o.name}=${o.value}`).join(", "));

      // Auto-approve the agent's own permission prompts (only notebook tools should appear).
      const answered = new Set<string>();
      const timer = setInterval(() => {
        for (const p of ext.parts()) {
          if (p.type === "prompt" && !p.answer && !answered.has(p.promptId)) {
            answered.add(p.promptId);
            const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options[0];
            console.log(`${agentId} asked: ${p.title} -> ${allow?.name}`);
            void ext.request("chat.answer", { chatId: snap.chatId, promptId: p.promptId, optionId: allow!.id });
          }
        }
      }, 200);

      const before = ext.statuses.length;
      await ext.request("chat.send", {
        chatId: snap.chatId,
        text: "Change the code cell so it prints 'hello from the agent' instead of 'old'. Use the notebook tools. Then reply with just DONE.",
      });
      await ext.waitFor(() => ext.statuses.slice(before).some((s) => s === "idle" || s === "error"), 280_000, "turn end");
      clearInterval(timer);

      const tools = ext.parts().filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool");
      console.log(`${agentId} tools:`, tools.map((t) => `${t.title} [${t.status}${t.notebook ? `, notebook: ${(t.notebookCalls ?? []).join("+")}` : ""}]`).join(" | "));
      console.log(`${agentId} said:`, ext.agentText().slice(-400));
      expect(nb.cells[1]!.source).toContain("hello from the agent");
      expect(tools.some((t) => t.notebook)).toBe(true);
      // Notebook-only mode (on by default) must not refuse the agent's notebook tools.
      const refused = ext.parts().filter((p) => p.type === "notice" && p.text.startsWith("Refused"));
      console.log(`${agentId} refused:`, refused.map((p) => (p.type === "notice" ? p.text : "")).join(" | ") || "none");
      ext.close();
    });

    it(`${agentId} sees a plot image in a cell output`, { timeout: 300_000 }, async () => {
      const nb = new FakeNotebook([{ type: "code", source: "plt.imshow(img)" }]);
      nb.cells[0]!.outputs = [{ kind: "display", text: "<Figure size 640x480>", image: { mime: "image/png", data: GREEN_PNG } }];
      const ext = new FakeExtension(nb, 600 + i);
      await ext.connect(port, TOKEN);
      const snap = await ext.request<ChatSnapshot>("chat.open", {
        tabId: ext.tabId,
        agentId,
        settings: { scope: "write", review: false, targetCellIds: [] },
        platform: "colab",
      });
      await ext.waitFor(() => ext.statuses.includes("idle") || ext.statuses.includes("error"), 120_000, "agent start");
      const answered = new Set<string>();
      const timer = setInterval(() => {
        for (const p of ext.parts()) {
          if (p.type === "prompt" && !p.answer && !answered.has(p.promptId)) {
            answered.add(p.promptId);
            const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options[0];
            void ext.request("chat.answer", { chatId: snap.chatId, promptId: p.promptId, optionId: allow!.id });
          }
        }
      }, 200);
      const before = ext.statuses.length;
      await ext.request("chat.send", {
        chatId: snap.chatId,
        text: "Call read_cells for cell c1 and look at the image in its output. What single color fills that image? Reply with only the color name in English.",
      });
      await ext.waitFor(() => ext.statuses.slice(before).some((s) => s === "idle" || s === "error"), 280_000, "turn end");
      clearInterval(timer);
      const said = ext.agentText().slice(-300);
      console.log(`${agentId} image answer:`, said);
      expect(said.toLowerCase()).toContain("green");
      ext.close();
    });
  }
});
