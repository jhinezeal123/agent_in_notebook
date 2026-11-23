// What easy-read takes from the rest of the app, pinned down (as
// mentor-contract.test.ts does for Mentor). The reader's tutor is a role the
// chat takes; it relies on the chat letting its tools through in "Notebook
// only" mode, and on the chat not knowing it. A change over there would not
// fail to compile; it would only leave the tutor without its tools.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isNotebookTool } from "../src/chat.js";
import { TOOLS } from "../src/notebook/tools.js";
import { ReaderAuthorRole } from "../src/reader/author.js";
import { READER_SETTINGS, TUTOR_TOOLS } from "../src/reader/chat.js";
import { ReaderCheckerRole } from "../src/reader/checker.js";
import { READER_TOOLS } from "../src/reader/tools.js";

const ROOT = resolve(__dirname, "../../..");
const source = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("the reader's tools in the chat", () => {
  const names = READER_TOOLS.map((t) => t.name);
  // The tutor's, the hidden author's and the checker's (ER-2).
  const all = [...new Set([
    ...TUTOR_TOOLS.map((t) => t.name),
    ...new ReaderAuthorRole(null as never, "p", null as never).tools().map((t) => t.name),
    ...new ReaderCheckerRole(null as never, "p", []).tools().map((t) => t.name),
  ])];

  it("are let through in Notebook-only mode, however the agent spells them", () => {
    // chat.ts isNotebookTool: the reader's names need their patterns (paper_\w+, reader_\w+) there.
    expect(all).toEqual(expect.arrayContaining(["reader_grade", "reader_misconception", "reader_map_write", "reader_items_write", "reader_items_fix", "reader_check_write"]));
    for (const n of all) {
      for (const spelled of [n, `mcp__notebook__${n}`, `notebook/${n}`]) {
        expect(isNotebookTool(spelled, undefined), `${spelled} would be refused in Notebook-only mode; add its pattern to isNotebookTool in chat.ts`).toBe(true);
      }
    }
    expect(READER_SETTINGS.notebookOnly).toBe(true);
  });

  it("read the paper (paper_*), or write only the reader's own records (reader_*), and do not take a core tool's name", () => {
    const core = new Set(TOOLS.map((t) => t.name));
    for (const n of names) expect(n.startsWith("paper_"), `${n}: reading tools are paper_*`).toBe(true);
    for (const n of all) {
      expect(/^(paper|reader)_/.test(n), `${n}: a reader tool is paper_* (reads) or reader_* (the reading's own records); anything else needs a decision first (docs/easy-read.md E.5)`).toBe(true);
      expect(core.has(n), `${n} is also a core tool`).toBe(false);
    }
  });
});

describe("the chat and the reader, apart", () => {
  it("the chat knows the role, not the reader", () => {
    const chat = source("packages/bridge/src/chat.ts");
    const imports = chat.split("\n").filter((l) => /^import\b/.test(l) || /\bfrom "/.test(l));
    expect(imports.filter((l) => /["']\.\/reader\//.test(l)), "chat.ts imports from reader/; put it behind ChatRole (chat-role.ts) instead").toEqual([]);
  });

  it("a tutor chat gets no project (and so not the project server's own paper_read)", () => {
    // server.ts chat.open: `tutor` includes the reader, and the project host is only for chats that are not tutors.
    const server = source("packages/bridge/src/server.ts");
    expect(server).toMatch(/const tutor = [^;]*!!readerId/);
    expect(server).toMatch(/const project: ChatProjectHost \| undefined = key && !mentor/);
  });
});
