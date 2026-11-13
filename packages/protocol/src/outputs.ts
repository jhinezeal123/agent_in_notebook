// Normalize ipynb (nbformat 4) outputs into the flat CellOutput shape.

import type { CellOutput, OutputImage } from "./notebook.js";
import { capLines, collapseCarriageReturns, joinSource, squeezeRepeats, stripAnsi } from "./text.js";

const TEXT_MIMES = ["text/plain", "text/markdown", "application/json", "text/latex"];
const IMAGE_MIMES = ["image/png", "image/jpeg"] as const;
/** Larger images stay out (they are listed as a mime type instead). */
export const IMAGE_MAX_BASE64 = 1_500_000;

function imageOf(data: Record<string, unknown>): OutputImage | undefined {
  for (const mime of IMAGE_MIMES) {
    const v = data[mime];
    if (typeof v !== "string" && !Array.isArray(v)) continue;
    const b64 = joinSource(v).replace(/\s+/g, "");
    if (b64 && b64.length <= IMAGE_MAX_BASE64 && /^[A-Za-z0-9+/]+=*$/.test(b64)) return { mime, data: b64 };
  }
  return undefined;
}

export function normalizeIpynbOutput(raw: any): CellOutput | null {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.output_type) {
    case "stream":
      return { kind: "stream", name: raw.name ?? "stdout", text: collapseCarriageReturns(stripAnsi(joinSource(raw.text))) };
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
      const image = imageOf(data);
      const other = mimes.filter((m) => !TEXT_MIMES.includes(m) && m !== image?.mime);
      const out: CellOutput = {
        kind: raw.output_type === "execute_result" ? "result" : "display",
        text: text !== undefined ? stripAnsi(text) : undefined,
        mimes: other.length ? other : undefined,
      };
      if (image) out.image = image;
      return out;
    }
    default:
      return null;
  }
}

export function normalizeIpynbOutputs(list: unknown): CellOutput[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeIpynbOutput).filter((o): o is CellOutput => o !== null);
}

/**
 * Render outputs as plain text for an agent. `attachImage` decides what to do
 * with an image: it returns the label to put in the text (the image travels
 * alongside), or null when the image cannot be shown.
 *
 * Within `max`, an error keeps its own share: a long log printed before a
 * failure must not push out the error line or the frame in the user's code.
 * Text is cut between lines, keeping the start and (more of) the end.
 */
export function outputsToText(outputs: CellOutput[], max = 8000, attachImage?: (image: OutputImage) => string | null): string {
  const parts: string[] = [];
  const errors: string[] = [];
  let stream: { name: string; text: string } | null = null;
  const endStream = () => {
    if (stream) parts.push(stream.name === "stderr" ? `[stderr]\n${stream.text}` : stream.text);
    stream = null;
  };
  for (const o of outputs) {
    if (o.kind === "stream") {
      // Consecutive chunks of one stream are one text (a progress bar can span chunks).
      const name = o.name ?? "stdout";
      if (stream && stream.name === name) stream.text += o.text ?? "";
      else {
        endStream();
        stream = { name, text: o.text ?? "" };
      }
      continue;
    }
    endStream();
    if (o.kind === "error") errors.push(`[error] ${o.ename}: ${o.evalue}
${o.traceback ?? ""}`.trim());
    else {
      // A plot's text/plain is only its repr ("<Figure size ...>"); keep it, it is short.
      if (o.text) parts.push(o.text);
      const hidden = [...(o.mimes ?? [])];
      if (o.image) {
        const label = attachImage?.(o.image) ?? null;
        if (label) parts.push(label);
        else hidden.unshift(o.image.mime);
      }
      if (hidden.length) parts.push(`[${hidden.join(", ")} output not shown]`);
    }
  }
  endStream();
  const tidy = (t: string) => squeezeRepeats(collapseCarriageReturns(t)).replace(/\n{3,}/g, "\n\n").trim();
  let body = tidy(parts.join("\n"));
  let error = tidy(errors.join("\n\n"));
  if (body.length + error.length + 1 > max) {
    // The error gets up to half the room (more if the rest is short); the log gets what is left.
    const errorRoom = Math.min(error.length, Math.max(Math.floor(max * 0.5), max - body.length - 1));
    if (error.length > errorRoom) error = capLines(error, errorRoom, 0.35);
    body = capLines(body, Math.max(0, max - error.length - 1), 0.3);
  }
  return [body, error].filter(Boolean).join("\n");
}
