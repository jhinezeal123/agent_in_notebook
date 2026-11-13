// Markdown for the transcript. Agent messages stream in and are re-sent whole
// every 80ms, so the text is cut into blocks that render independently: only
// the block still growing is parsed again (idea from T3 Code's chat view).

import DOMPurify from "dompurify";
import { marked } from "marked";

/** Syntax that ties blocks together (reference links, footnotes, raw HTML): render as one. */
const DOCUMENT_WIDE = /^ {0,3}\[[^\]\n]+\]:|^ {0,3}<[A-Za-z!?/]|\[\^/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INDENTED = /^[ \t]/;

/** After a blank line, an indented line, or a list item right after list content, continues the block. */
function continues(line: string, previous: string): boolean {
  return INDENTED.test(line) || (LIST_ITEM.test(line) && (LIST_ITEM.test(previous) || INDENTED.test(previous)));
}

/** Cut Markdown at blank lines that close every open block, so each piece renders as it would in the whole. */
export function splitMarkdownBlocks(text: string): string[] {
  if (text.includes("\r") || DOCUMENT_WIDE.test(text)) return [text];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let afterBlank = false;
  let previous = "";
  for (const line of text.split("\n")) {
    if (fence !== null) {
      current.push(line);
      const close = FENCE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length && line.trim() === close) fence = null;
      continue;
    }
    if (line.trim() === "") {
      afterBlank = true;
      current.push(line);
      continue;
    }
    if (afterBlank && current.some((l) => l.trim() !== "") && !continues(line, previous)) {
      blocks.push(current.join("\n"));
      current = [];
    }
    afterBlank = false;
    fence = FENCE.exec(line)?.[1] ?? null;
    current.push(line);
    previous = line;
  }
  blocks.push(current.join("\n"));
  return blocks;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // Code blocks get a small toolbar; the panel handles its buttons by delegation.
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
      return (
        `<div class="code" data-lang="${escapeHtml(language)}">` +
        `<div class="code-bar"><span class="code-lang">${escapeHtml(language || "code")}</span>` +
        `<button type="button" data-code-act="copy" title="Copy the code">Copy</button>` +
        `<button type="button" data-code-act="insert" title="Insert as a new cell below the selected cell">Insert as cell</button></div>` +
        `<pre><code${cls}>${escapeHtml(text)}</code></pre></div>`
      );
    },
  },
});

const cache = new Map<string, string>();
const CACHE_MAX = 400;

/** Sanitized HTML for one block, cached: a finished block is never parsed twice. */
export function renderMarkdown(block: string): string {
  const hit = cache.get(block);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(block, { async: false }) as string, { ADD_ATTR: ["target"] });
  cache.set(block, html);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return html;
}

/** The first sentence or bold heading of a thought, as one line (for the live "thinking" line). */
export function thoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\n]+)\*\*/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!](?=\s)/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}
