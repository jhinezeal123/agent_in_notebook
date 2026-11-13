import { IMAGE_MAX_BASE64, normalizeIpynbOutput } from "@ainb/protocol";

type OutputItem = { mime: string; data: Uint8Array };
const stdout = "application/vnd.code.notebook.stdout";
const stderr = "application/vnd.code.notebook.stderr";
const error = "application/vnd.code.notebook.error";

/** Turn the editor and Jupyter API's output items back into nbformat output. */
export function toIpynbOutput(output: { items: readonly OutputItem[]; metadata?: Record<string, unknown> }) {
  const failed = output.items.find((item) => item.mime === error);
  if (failed) {
    const text = Buffer.from(failed.data).toString();
    const original = output.metadata?.originalError;
    if (original && typeof original === "object") return { ...original, output_type: "error" };
    try {
      const { name, message, stack } = JSON.parse(text) ?? {};
      return { output_type: "error", ename: name, evalue: message, traceback: stack };
    } catch {
      return { output_type: "error", evalue: text };
    }
  }
  const stream = output.items.find((item) => item.mime === stdout || item.mime === stderr);
  if (stream) return { output_type: "stream", name: stream.mime === stderr ? "stderr" : "stdout", text: Buffer.from(stream.data).toString() };
  const data = Object.create(null) as Record<string, string>;
  for (const { mime, data: bytes } of output.items) {
    if (mime === "image/png" || mime === "image/jpeg") {
      data[mime] = bytes.length <= IMAGE_MAX_BASE64 / 4 * 3 ? Buffer.from(bytes).toString("base64") : "";
    } else {
      data[mime] = /^(text\/(plain|markdown|latex)|application\/json)$/.test(mime) ? Buffer.from(bytes).toString() : "";
    }
  }
  return { output_type: output.metadata?.outputType === "execute_result" ? "execute_result" : "display_data", data };
}

export function notebookOutputs(outputs: readonly { items: readonly OutputItem[]; metadata?: Record<string, unknown> }[]) {
  return outputs.map((output) => normalizeIpynbOutput(toIpynbOutput(output))).filter((output) => output !== null);
}
