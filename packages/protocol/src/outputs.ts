// Normalize ipynb (nbformat 4) outputs into the flat CellOutput shape.

import type { CellOutput } from "./notebook.js";
import { joinSource, stripAnsi } from "./text.js";

const TEXT_MIMES = ["text/plain", "text/markdown", "application/json", "text/latex"];

export function normalizeIpynbOutput(raw: any): CellOutput | null {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.output_type) {
    case "stream":
      return { kind: "stream", name: raw.name ?? "stdout", text: stripAnsi(joinSource(raw.text)) };
    case "error":
      return {
        kind: "error",
        ename: raw.ename,
        evalue: raw.evalue,
        traceback: stripAnsi(Array.isArray(raw.traceback) ? raw.traceback.join("\n") : String(raw.traceback ?? "")),
      };
    case "execute_result":
    case "display_data": {
      const data: Record<string, unknown> = raw.data ?? {};
      const mimes = Object.keys(data);
      const textMime = TEXT_MIMES.find((m) => m in data);
      let text: string | undefined;
      if (textMime) {
        const v = data[textMime];
        text = typeof v === "string" || Array.isArray(v) ? joinSource(v) : JSON.stringify(v);
      }
      const other = mimes.filter((m) => !TEXT_MIMES.includes(m));
      return {
        kind: raw.output_type === "execute_result" ? "result" : "display",
        text: text !== undefined ? stripAnsi(text) : undefined,
        mimes: other.length ? other : undefined,
      };
    }
    default:
      return null;
  }
}

export function normalizeIpynbOutputs(list: unknown): CellOutput[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeIpynbOutput).filter((o): o is CellOutput => o !== null);
}

/** Render outputs as plain text for an agent. */
export function outputsToText(outputs: CellOutput[], max = 8000): string {
  const parts: string[] = [];
  for (const o of outputs) {
    if (o.kind === "stream") parts.push(o.name === "stderr" ? `[stderr]\n${o.text ?? ""}` : (o.text ?? ""));
    else if (o.kind === "error") parts.push(`[error] ${o.ename}: ${o.evalue}\n${o.traceback ?? ""}`);
    else {
      if (o.text) parts.push(o.text);
      if (o.mimes?.length) parts.push(`[${o.mimes.join(", ")} output not shown]`);
    }
  }
  const text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(text.length - (max - head))}`;
}
