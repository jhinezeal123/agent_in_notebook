// Text helpers shared by the bridge and the extension.

/** Keep the head and tail of a long text, noting how much was cut. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(text.length - tail)}`;
}

/**
 * Like capText, but cuts between lines, so the agent never sees half a line
 * (or half a traceback frame). `headShare` of the room goes to the start.
 */
export function capLines(text: string, max: number, headShare = 0.4): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const headMax = Math.floor(max * headShare);
  const tailMax = max - headMax;
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  while (i < lines.length && used + lines[i]!.length + 1 <= headMax) {
    used += lines[i]!.length + 1;
    head.push(lines[i++]!);
  }
  let j = lines.length - 1;
  let tailUsed = 0;
  while (j >= i && tailUsed + lines[j]!.length + 1 <= tailMax) {
    tailUsed += lines[j]!.length + 1;
    tail.unshift(lines[j--]!);
  }
  // One line longer than the room on its side: keep a shortened copy of it.
  if (!head.length && i <= j) {
    head.push(capText(lines[i++]!, headMax));
  }
  if (!tail.length && i <= j) {
    tail.unshift(capText(lines[j--]!, tailMax));
  }
  const omitted = j - i + 1;
  if (omitted <= 0) return [...head, ...tail].join("\n");
  const chars = lines.slice(i, j + 1).reduce((n, l) => n + l.length + 1, 0);
  return [...head, `… [${omitted} line${omitted === 1 ? "" : "s"} (${chars} characters) omitted] …`, ...tail].join("\n");
}

/** True if capLines/capText shortened this text. */
export function wasShortened(text: string): boolean {
  return /… \[\d+ (?:lines?|characters)\b[^\]]*omitted\] …/.test(text);
}

/**
 * Apply carriage returns the way a terminal shows them: each line keeps only
 * what was written after its last "\r". Progress bars (tqdm, Keras) rewrite
 * one line thousands of times; only the final state means anything.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      for (let k = segments.length - 1; k >= 0; k--) if (segments[k]) return segments[k];
      return "";
    })
    .join("\n");
}

/** Runs of the same line (warnings in a loop) shrink to a couple of copies and a count. */
export function squeezeRepeats(text: string, keep = 2): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n > keep + 1 && lines[i]!.trim()) {
      for (let k = 0; k < keep; k++) out.push(lines[i]!);
      out.push(`… (the line above repeated ${n - keep} more times)`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join("\n");
}

const DATA_URI = /(data:[\w.+-]+\/[\w.+-]+;base64,)([A-Za-z0-9+/]{200,}={0,2})/g;
const DATA_MARK = /\[\[ainb:data-(\d+)[^\]]*\]\]/g;

/**
 * Replace base64 payloads of data: URIs (images pasted into markdown cells)
 * with short marks; `restoreDataUris` puts them back into text the agent
 * writes, so a cell keeps its images when the agent edits around them.
 */
export function hideDataUris(source: string): { text: string; payloads: string[] } {
  const payloads: string[] = [];
  if (!source.includes(";base64,")) return { text: source, payloads };
  const text = source.replace(DATA_URI, (_, prefix: string, b64: string) => {
    payloads.push(b64);
    return `${prefix}[[ainb:data-${payloads.length} ${Math.max(1, Math.round((b64.length * 0.75) / 1024))} KB hidden]]`;
  });
  return { text, payloads };
}

export function restoreDataUris(text: string, payloads: string[]): string {
  if (!payloads.length) return text;
  return text.replace(DATA_MARK, (mark, n: string) => payloads[Number(n) - 1] ?? mark);
}

/** Remove ANSI escape sequences (tracebacks are colored). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** ipynb stores multiline strings either as a string or a list of lines. */
export function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.join("");
  return typeof src === "string" ? src : "";
}

export function firstLine(text: string, max = 80): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
