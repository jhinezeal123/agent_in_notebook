// Tests for Đợt 3b-ui & B5.4 pure helpers: exportChatMarkdown (B4.1),
// slash commands & contextual suggestions (B5.1), and vi/en i18n (B5.4).

import { describe, expect, it } from "vitest";
import type { ChatSnapshot } from "@ainb/protocol";
import { exportChatMarkdown } from "../src/export-chat.js";
import { contextualSuggestions, matchSlashCommands } from "../src/slash-commands.js";
import { resolveLang, t } from "../src/i18n.js";

describe("B4.1 exportChatMarkdown", () => {
  it("formats user, agent, tools, reviews, cards, and pinned messages as Markdown", () => {
    const snap: ChatSnapshot = {
      chatId: "c1",
      tabId: 1,
      agentId: "claude",
      agentName: "Claude Code",
      status: "idle",
      settings: { scope: "write", review: true, targetCellIds: [], notebookOnly: true },
      options: [],
      notebook: null,
      messages: [
        { id: "m1", role: "user", createdAt: 1_700_000_000_000, pinned: true, parts: [{ type: "text", text: "Fix cell 1" }] },
        {
          id: "m2",
          role: "agent",
          createdAt: 1_700_000_005_000,
          parts: [
            { type: "tool", toolCallId: "t1", title: "mcp__notebook__Read", status: "completed", notebook: true },
            { type: "review", status: "accepted", review: { reviewId: "r1", kind: "update", cellId: "c1", cellType: "code", index: 0, before: "x = 1", after: "x = 2" } },
            { type: "text", text: "Updated `x = 2`." },
          ],
        },
      ],
    };
    const md = exportChatMarkdown(snap, {
      platform: "kaggle",
      title: "Train ViT",
      url: "https://kaggle.com/code/u/train-vit",
      cellCount: 3,
      activeCellId: "c1",
      selectedCellIds: ["c1"],
      kernel: "idle",
      language: "python",
    });
    expect(md).toContain("# Train ViT");
    expect(md).toContain("## User [Pinned]");
    expect(md).toContain("> *Tools:* Read");
    expect(md).toContain("```diff\n-x = 1\n+x = 2\n```");
    expect(md).toContain("Updated `x = 2`.");
  });
});

describe("B5.1 slash commands & contextual suggestions", () => {
  it("filters built-in and custom slash commands only for leading slash tokens", () => {
    expect(matchSlashCommands("hello")).toEqual([]);
    expect(matchSlashCommands("/fix now")).toEqual([]);
    expect(matchSlashCommands("/f").map((c) => c.name)).toEqual(["/fix"]);
    expect(matchSlashCommands("/").length).toBeGreaterThanOrEqual(8);
    const custom = [{ name: "ablation", prompt: "Compare lr=1e-3 vs 1e-4" }];
    expect(matchSlashCommands("/ab", custom).map((c) => c.name)).toEqual(["/ablation"]);
  });

  it("adapts suggestions to attached cells, disconnected kernel, and high context usage", () => {
    const highCtx = contextualSuggestions({ usage: { used: 90_000, size: 100_000 } });
    expect(highCtx[0]!.label).toMatch(/Summarize/i);

    const attached = contextualSuggestions({ hasAttached: true });
    expect(attached[0]!.label).toMatch(/attached/i);

    const disconnected = contextualSuggestions({
      notebook: { platform: "colab", title: "nb", url: "", cellCount: 1, activeCellId: null, selectedCellIds: [], kernel: "disconnected", language: "python" },
    });
    expect(disconnected.some((s) => /disconnected/i.test(s.text))).toBe(true);
  });
});

describe("B5.4 i18n", () => {
  it("resolves language preference and translates UI keys", () => {
    expect(resolveLang("vi", "en-US")).toBe("vi");
    expect(resolveLang("en", "vi-VN")).toBe("en");
    expect(resolveLang("auto", "vi-VN")).toBe("vi");
    expect(resolveLang("auto", "en-US")).toBe("en");
    expect(t("setup.title", "en")).toBe("Connect to the bridge");
    expect(t("setup.title", "vi")).toBe("Kết nối với bridge");
  });
});
