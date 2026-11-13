import { describe, expect, it } from "vitest";
import type { Part } from "@ainb/protocol";
import { splitMarkdownBlocks, thoughtLine } from "../src/sidepanel/markdown.js";
import { groupParts, summarizeTools, type ToolPart } from "../src/sidepanel/transcript.js";

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
