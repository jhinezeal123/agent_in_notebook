// Markdown for the transcript. Agent messages stream in and are re-sent whole
// every 80ms, so the text is cut into blocks that render independently: only
// the block still growing is parsed again (idea from T3 Code's chat view).

import DOMPurify from "dompurify";
import { Marked, Renderer, type RendererObject, type TokenizerAndRendererExtension } from "marked";
import { parseReaderCite, readerCiteLabel, type ReaderAnchor } from "@ainb/protocol";
import { chatFileLink, externalChatUrl } from "./chat-links.js";
import { decorateMarkdownImages } from "./images.js";
import { escapeHtml, mathExtensions, typesetMath } from "./math.js";

/** Syntax that ties blocks together (reference links, footnotes, raw HTML): render as one. */
const DOCUMENT_WIDE = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|\$\$|\\\[)|\[\^/m;
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

const renderer: RendererObject = {
  image({ href, text, title }) {
    return `<img data-image-source="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
  },
  link(token) {
    if (chatFileLink(token.href)) {
      return `<a data-file-link="${escapeHtml(token.href)}">${this.parser.parseInline(token.tokens)}</a>`;
    }
    return false;
  },
  table(token) {
    return `<div class="md-table">${Renderer.prototype.table.call(this, token)}</div>`;
  },
  // Code blocks get a small toolbar; the panel handles its buttons by delegation.
  code({ text, lang }) {
    const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
    if (language.toLowerCase() === "math") return `<div data-tex="${escapeHtml(text)}" data-display-math="true">${escapeHtml(text)}</div>`;
    const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
    return (
      `<div class="code" data-lang="${escapeHtml(language)}">` +
      `<div class="code-bar"><span class="code-lang">${escapeHtml(language || "code")}</span>` +
      `<button type="button" data-code-act="copy" title="Copy the code">Copy</button>` +
      `<button type="button" data-code-act="insert" title="Insert as a new cell below the selected cell">Insert as cell</button></div>` +
      `<pre><code${cls}>${escapeHtml(text)}</code></pre></div>`
    );
  },
};

/**
 * Easy-read: a paper tutor's citations, `[[S4.SS1]]`, `[[S2.E1]]`,
 * `[[p4: "exact words"]]`, as chips that bring the reading tab there. Other
 * `[[…]]` text stays as it is.
 */
const readerCite: TokenizerAndRendererExtension = {
  name: "readerCite",
  level: "inline",
  start(source) {
    const i = source.indexOf("[[");
    return i < 0 ? undefined : i;
  },
  tokenizer(source) {
    const match = /^\[\[([^[\]\n]{1,300})\]\]/.exec(source);
    const anchor = match && parseReaderCite(match[1]!);
    if (match && anchor) return { type: "readerCite", raw: match[0], anchor };
  },
  renderer(token) {
    const anchor = (token as unknown as { anchor: ReaderAnchor }).anchor;
    const title = anchor.quote ? `“${anchor.quote}” — xem trong paper` : "Xem trong paper";
    return `<button type="button" class="cite-chip" data-cite="${escapeHtml(JSON.stringify(anchor))}" title="${escapeHtml(title)}">${escapeHtml(readerCiteLabel(anchor))}</button>`;
  },
};

const markdown = new Marked({ extensions: mathExtensions, gfm: true, breaks: true, renderer });
const readerMarkdown = new Marked({ extensions: [readerCite, ...mathExtensions], gfm: true, breaks: true, renderer });

/** A chip's place in the paper, or null (not a chip, or not one we wrote). */
export function citeOf(el: Element): ReaderAnchor | null {
  const raw = el.closest<HTMLElement>("[data-cite]")?.dataset.cite;
  if (!raw) return null;
  try {
    const anchor = JSON.parse(raw) as ReaderAnchor;
    return anchor && typeof anchor === "object" ? anchor : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, string>();
const CACHE_MAX = 400;
const CACHE_ENTRY_MAX = 128_000;

/** Sanitized HTML for one block, cached so completed blocks survive streaming updates. `cites`: a paper tutor's chat (citation chips). */
export function renderMarkdown(block: string, localLinks = false, cites = false): string {
  const key = `${localLinks ? "file:" : "web:"}${cites ? "cite:" : ""}${block}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const fragment = DOMPurify.sanitize((cites ? readerMarkdown : markdown).parse(block, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style"],
    FORBID_ATTR: ["style", "target", "download", "ping", "srcset"],
  });
  for (const anchor of fragment.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? anchor.dataset.fileLink ?? "";
    const url = externalChatUrl(href);
    delete anchor.dataset.fileLink;
    if (url) {
      anchor.href = url;
      anchor.rel = "noopener noreferrer";
    } else if (localLinks && chatFileLink(href)) {
      anchor.href = "#";
      anchor.dataset.fileLink = href;
      anchor.title = href;
    } else {
      anchor.removeAttribute("href");
    }
  }
  decorateMarkdownImages(fragment, localLinks);
  typesetMath(fragment);
  const template = document.createElement("template");
  template.content.append(fragment);
  const html = template.innerHTML;
  if (html.length <= CACHE_ENTRY_MAX && block.length <= CACHE_ENTRY_MAX) {
    cache.set(key, html);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
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
