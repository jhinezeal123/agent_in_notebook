import { describe, expect, it } from "vitest";
import type { ChatMessage, Part } from "@ainb/protocol";
import { splitMarkdownBlocks, thoughtLine } from "../src/markdown.js";
import { dateSeparators, dayLabel, groupParts, lastUserMessage, messageTime, messageTitle, queuedMessageIds, summarizeTools, type ToolPart } from "../src/transcript.js";

describe("splitMarkdownBlocks", () => {
  it("cuts at blank lines between blocks and joins back to the same text", () => {
    const text = "# Title\n\nFirst paragraph\nstill first.\n\n- a\n- b\n\n- loose item\n\nAfter the list.";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toEqual(["# Title\n", "First paragraph\nstill first.\n", "- a\n- b\n\n- loose item\n", "After the list."]);
    expect(blocks.join("\n")).toBe(text);
  });

  it("keeps a fenced block whole, blank lines included, even while it is still streaming", () => {
    const text = "Code:\n\n```python\nx = 1\n\ny = 2\n```\n\nDone.";
    expect(splitMarkdownBlocks(text)).toEqual(["Code:\n", "```python\nx = 1\n\ny = 2\n```\n", "Done."]);
    expect(splitMarkdownBlocks("Intro\n\n```\nopen fence\n\nmore")).toEqual(["Intro\n", "```\nopen fence\n\nmore"]);
  });

  it("does not split text whose syntax spans blocks", () => {
    const text = "See [docs][1].\n\n[1]: https://example.com";
    expect(splitMarkdownBlocks(text)).toEqual([text]);
    expect(splitMarkdownBlocks("A\n\n<details>\n\nB\n\n</details>")).toHaveLength(1);
  });
});

describe("thoughtLine", () => {
  it("shows a bold heading, else the first sentence", () => {
    expect(thoughtLine("**Planning the fix**\n\nI will read cell 3 first.")).toBe("Planning the fix");
    expect(thoughtLine("I should read `cell 3` first. Then edit it.")).toBe("I should read cell 3 first.");
  });
});

const tool = (title: string, status: ToolPart["status"] = "completed", calls?: string[]): ToolPart => ({
  type: "tool",
  toolCallId: Math.random().toString(36),
  title,
  status,
  notebook: true,
  notebookCalls: calls,
});

describe("tool groups", () => {
  it("groups consecutive tool calls and keeps other parts in place", () => {
    const parts: Part[] = [{ type: "text", text: "Looking." }, tool("mcp__notebook__Read"), tool("mcp__notebook__Grep"), { type: "text", text: "Now edit." }, tool("x")];
    expect(groupParts(parts).map((i) => (i.kind === "tools" ? `tools:${i.tools.length}` : i.part.type))).toEqual(["text", "tools:2", "text", "tools:1"]);
  });

  it("summarizes by action, counting every notebook call one agent call made", () => {
    const tools = [
      tool("mcp__notebook__Read"),
      tool("mcp__notebook__read_output"),
      tool("execute", "completed", ["NotebookEdit", "run_cells"]),
      tool("notebook.run_all"),
      tool("mcp__notebook__Bash"),
      tool("Run shell: ls"),
    ];
    expect(summarizeTools(tools)).toBe("Read ×2 · Edited · Ran ×2 · Ran command · Used tool");
  });
});

const msg = (id: string, role: ChatMessage["role"], createdAt = 0, parts: Part[] = [{ type: "text", text: id }]): ChatMessage => ({ id, role, createdAt, parts });

describe("queuedMessageIds", () => {
  it("marks user messages after the last agent message while a turn runs", () => {
    const messages = [msg("u1", "user"), msg("a1", "agent"), msg("u2", "user"), msg("u3", "user")];
    expect([...queuedMessageIds(messages, "running")]).toEqual(["u2", "u3"]);
  });

  it("counts only user messages, not system notices between them", () => {
    const messages = [msg("u1", "user"), msg("a1", "agent"), msg("u2", "user"), msg("s1", "system"), msg("u3", "user")];
    expect([...queuedMessageIds(messages, "running")]).toEqual(["u2", "u3"]);
  });

  it("is empty when the queued message got its own reply (the next turn began)", () => {
    const messages = [msg("u1", "user"), msg("a1", "agent"), msg("u2", "user"), msg("a2", "agent")];
    expect(queuedMessageIds(messages, "running").size).toBe(0);
  });

  it("is empty when no turn is running, whatever the transcript looks like", () => {
    const messages = [msg("u1", "user"), msg("a1", "agent"), msg("u2", "user")];
    for (const status of ["idle", "starting", "error", "closed"] as const) {
      expect(queuedMessageIds(messages, status).size).toBe(0);
    }
  });

  it("is empty while the running turn's reply has not reached the transcript yet", () => {
    expect(queuedMessageIds([msg("u1", "user")], "running").size).toBe(0);
    expect(queuedMessageIds([], "running").size).toBe(0);
  });

  it("honors the explicit queued mark even when no agent turn is running (e.g. behind a busyJob)", () => {
    const queuedMsg: ChatMessage = { ...msg("u2", "user"), queued: true };
    expect([...queuedMessageIds([msg("u1", "user"), queuedMsg], "idle")]).toEqual(["u2"]);
  });
});

describe("lastUserMessage", () => {
  it("returns the last user message's text and cells, joining its text parts", () => {
    const messages = [
      msg("u1", "user", 0, [{ type: "text", text: "first" }]),
      msg("a1", "agent"),
      msg("u2", "user", 0, [{ type: "text", text: "second" }, { type: "cells", cells: [] }, { type: "text", text: " part" }]),
      msg("a2", "agent"),
    ];
    expect(lastUserMessage(messages)).toEqual({ text: "second part", cells: [] });
  });

  it("keeps the text verbatim and skips user messages without text", () => {
    const messages = [
      msg("u1", "user", 0, [{ type: "text", text: "  keep my spacing  " }]),
      msg("u2", "user", 0, [{ type: "cells", cells: [{ cellId: "c1", index: 0, label: "x" }] }]),
    ];
    expect(lastUserMessage(messages)?.text).toBe("  keep my spacing  ");
  });

  it("carries the message's own attached cells, not the composer's", () => {
    const cells = [{ cellId: "c1", index: 0, label: "x" }];
    const messages = [msg("u1", "user", 0, [{ type: "text", text: "fix it" }, { type: "cells", cells }])];
    expect(lastUserMessage(messages)).toEqual({ text: "fix it", cells });
  });

  it("is null when no user message has text", () => {
    expect(lastUserMessage([])).toBeNull();
    expect(lastUserMessage([msg("a1", "agent"), msg("s1", "system")])).toBeNull();
  });
});

describe("dateSeparators", () => {
  const now = new Date(2026, 10, 21, 12, 0).getTime(); // a local noon
  const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).getTime();

  it("puts nothing in a transcript that stays within today", () => {
    const messages = [msg("u1", "user", at(21, 8)), msg("a1", "agent", at(21, 9)), msg("u2", "user", at(21, 11))];
    expect(dateSeparators(messages, now).size).toBe(0);
  });

  it("labels the first message when it is from an earlier day", () => {
    const messages = [msg("u1", "user", at(20)), msg("a1", "agent", at(20, 10))];
    expect([...dateSeparators(messages, now)]).toEqual([["u1", "Yesterday"]]);
  });

  it("marks each new local day, once, at its first message", () => {
    const messages = [
      msg("u1", "user", at(19)),
      msg("a1", "agent", at(19, 10)),
      msg("u2", "user", at(20)),
      msg("a2", "agent", at(20, 10)),
      msg("u3", "user", at(21, 8)),
      msg("a3", "agent", at(21, 9)),
    ];
    expect([...dateSeparators(messages, now)]).toEqual([
      ["u1", dayLabel(at(19), now)],
      ["u2", "Yesterday"],
      ["u3", "Today"],
    ]);
  });

  it("tells days apart across a month boundary", () => {
    const decNow = new Date(2026, 11, 1, 12, 0).getTime();
    const messages = [msg("u1", "user", new Date(2026, 10, 30, 23, 50).getTime()), msg("u2", "user", new Date(2026, 11, 1, 0, 10).getTime())];
    expect([...dateSeparators(messages, decNow)]).toEqual([["u1", dayLabel(messages[0]!.createdAt, decNow)], ["u2", "Today"]]);
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 10, 21, 12, 0).getTime();

  it("says Today and Yesterday for the nearest days", () => {
    expect(dayLabel(new Date(2026, 10, 21, 0, 5).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 20, 23, 55).getTime(), now)).toBe("Yesterday");
  });

  it("says Yesterday across month and year boundaries", () => {
    expect(dayLabel(new Date(2026, 10, 30).getTime(), new Date(2026, 11, 1).getTime())).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 11, 31).getTime(), new Date(2027, 0, 1).getTime())).toBe("Yesterday");
  });

  it("writes older days as a local date", () => {
    const at = new Date(2026, 10, 19, 9).getTime();
    expect(dayLabel(at, now)).toBe(new Date(at).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" }));
  });
});

describe("message time", () => {
  it("formats a short local time and a full date-time title", () => {
    const at = new Date(2026, 10, 21, 14, 32).getTime();
    expect(messageTime(at)).toBe(new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    expect(messageTitle(at)).toBe(new Date(at).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  });
});
