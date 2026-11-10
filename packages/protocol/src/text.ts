// Text helpers shared by the bridge and the extension.

/** Keep the head and tail of a long text, noting how much was cut. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(text.length - tail)}`;
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
