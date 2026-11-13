import katex from "katex";
import type { TokenizerAndRendererExtension, Tokens } from "marked";

const MAX_TEX_LENGTH = 8192;
const DISPLAY_DOLLARS = /^\$\$(?!\$)((?:\\[\s\S]|[^\\$]|\$(?!\$))+?)\$\$(?!\$)/;
const DISPLAY_BRACKETS = /^\\\[((?:\\(?!\])[\s\S]|[^\\])+?)\\\]/;
const INLINE_DOLLARS = /^\$(?![$\s])((?:\\[^\n]|[^\\$\n])+?)(?<!\s)\$(?![$\d])/;
const INLINE_PARENS = /^\\\(((?:\\(?!\))[^\n]|[^\\\n])+?)\\\)/;

function mathAt(source: string, displayOnly: boolean) {
  const first = source[0];
  if (first !== "$" && first !== "\\") return;
  const display = source.startsWith("$$") || source.startsWith("\\[");
  if (displayOnly && !display) return;
  const pattern = first === "$" ? (display ? DISPLAY_DOLLARS : INLINE_DOLLARS) : (display ? DISPLAY_BRACKETS : INLINE_PARENS);
  const match = pattern.exec(source.slice(0, MAX_TEX_LENGTH));
  const tex = match?.[1]?.trim();
  if (match && tex) return { type: "chatMath", raw: match[0], tex, display };
}

type MathToken = NonNullable<ReturnType<typeof mathAt>>;

function placeholder(token: Tokens.Generic): string {
  const { raw, tex, display } = token as MathToken;
  const tag = token.type === "chatMathBlock" ? "div" : "span";
  return `<${tag} data-tex="${escapeHtml(tex)}"${display ? ' data-display-math="true"' : ""}>${escapeHtml(raw.trim())}</${tag}>`;
}

export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "chatMathBlock", level: "block",
    tokenizer(source) {
      const indent = /^ {0,3}/.exec(source)![0];
      const math = mathAt(source.slice(indent.length), true);
      if (!math) return;
      const end = /^[ \t]*(?:\n|$)/.exec(source.slice(indent.length + math.raw.length));
      if (end) return { ...math, type: "chatMathBlock", raw: indent + math.raw + end[0] };
    },
    renderer: placeholder,
  },
  {
    name: "chatMath", level: "inline",
    start(source) {
      return source.search(/\$|\\[([]/);
    },
    tokenizer(source) {
      if (!this.lexer.state.inRawBlock) return mathAt(source, false);
    },
    renderer: placeholder,
  },
];

/** Typeset only after sanitizing the surrounding Markdown. KaTeX supplies the layout styles. */
export function typesetMath(fragment: DocumentFragment): void {
  for (const node of fragment.querySelectorAll<HTMLElement>("span[data-tex], div[data-tex]")) {
    const tex = node.getAttribute("data-tex") ?? "";
    const displayMode = node.hasAttribute("data-display-math");
    node.removeAttribute("data-tex");
    node.removeAttribute("data-display-math");
    if (!tex || tex.length > MAX_TEX_LENGTH) continue;
    const original = node.textContent;
    try {
      node.innerHTML = katex.renderToString(tex, { displayMode, trust: false, maxExpand: 200, maxSize: 20 });
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error;
      node.textContent = original;
      node.classList.add("math-fallback");
    }
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
