// A paper's text, for the mentor to read: the LaTeX source from arXiv first
// (formulas as the authors wrote them), else alphaXiv's text through `orx
// paper`, else text taken out of a PDF on the notebook's machine. The result
// starts with a line saying where it came from, so the mentor knows how far
// to trust the formulas.

import { gunzipSync } from "node:zlib";

/** Most characters of a paper kept. */
export const SOURCE_MAX = 600_000;

export interface PaperSource {
  title: string;
  authors?: string;
  year?: number;
  url?: string;
  arxiv?: string;
  kind: "latex" | "alphaxiv" | "pdf";
  text: string;
}

/** An arXiv id from what the learner pasted (an id, an abs/pdf link), or null. */
export function parseArxivId(input: string): string | null {
  const s = input.trim();
  const modern = s.match(/(?:arxiv\.org\/(?:abs|pdf|e-print)\/|arxiv:|^)(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?\/?$/i);
  if (modern) return modern[1]! + (modern[2] ?? "");
  const old = s.match(/(?:arxiv\.org\/(?:abs|pdf|e-print)\/|arxiv:|^)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?\/?$/i);
  return old ? old[1]! + (old[2] ?? "") : null;
}

/** A paper id from its arXiv id: `arxiv-2006-11239`. */
export function paperIdFor(arxiv: string): string {
  return `arxiv-${arxiv.replace(/v\d+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** The files of a tar archive (regular files only). */
export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let at = 0;
  while (at + 512 <= buf.length) {
    const header = buf.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, len: number) => header.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(257, 6).startsWith("ustar") ? field(345, 155) : "";
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const body = buf.subarray(at + 512, at + 512 + size);
    if ((type === "0" || type === "\0") && name) files.set(prefix ? `${prefix}/${name}` : name, Buffer.from(body));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function stripComments(tex: string): string {
  return tex
    .split("\n")
    .map((line) => {
      // A % not escaped starts a comment.
      const m = line.match(/(^|[^\\])%/);
      return m ? line.slice(0, (m.index ?? 0) + m[1]!.length) : line;
    })
    .filter((line, i, all) => line.trim() || (all[i - 1] ?? "").trim())
    .join("\n");
}

/**
 * One LaTeX text from a source tree: the main file (with \documentclass),
 * with \input and \include put in place; macros of the preamble kept, the rest
 * of it dropped.
 */
export function flattenLatex(files: Map<string, string>): string | null {
  const tex = [...files.keys()].filter((f) => f.endsWith(".tex"));
  const main = tex.find((f) => /\\documentclass/.test(files.get(f)!) && /\\begin\{document\}/.test(files.get(f)!)) ?? tex.find((f) => /\\documentclass/.test(files.get(f)!));
  if (!main) return null;
  const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "");
  const find = (from: string, name: string): string | undefined => {
    const want = name.endsWith(".tex") ? name : `${name}.tex`;
    return [`${dirOf(from)}${want}`, want].map((c) => c.replace(/^\.\//, "")).find((c) => files.has(c));
  };
  const expand = (file: string, depth: number): string =>
    stripComments(files.get(file)!).replace(/\\(?:input|include)\s*\{([^}]+)\}/g, (whole, name: string) => {
      const target = depth < 6 ? find(main, name.trim()) ?? find(file, name.trim()) : undefined;
      return target ? `\n${expand(target, depth + 1)}\n` : whole;
    });
  const all = expand(main, 0);
  const begin = all.indexOf("\\begin{document}");
  if (begin < 0) return all;
  const macros = all.slice(0, begin).split("\n").filter((l) => /^\s*\\(newcommand|renewcommand|def|DeclareMathOperator|let)\b/.test(l));
  return [...(macros.length ? ["% macros of the preamble", ...macros, ""] : []), all.slice(begin)].join("\n");
}

/** The LaTeX of an e-print download (gzip'd tar, gzip'd single file), or null (a PDF, or nothing usable). */
export function latexFromEprint(raw: Buffer): string | null {
  let buf = raw;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf);
    } catch {
      return null;
    }
  }
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return null;
  if (buf.length > 262 && buf.subarray(257, 262).toString("latin1") === "ustar") {
    const files = new Map<string, string>();
    for (const [name, body] of untar(buf)) if (name.endsWith(".tex")) files.set(name.replace(/^\.\//, ""), body.toString("utf8").replace(/\r\n/g, "\n"));
    return flattenLatex(files);
  }
  const text = buf.toString("utf8").replace(/\r\n/g, "\n");
  return /\\documentclass|\\begin\{document\}/.test(text) ? flattenLatex(new Map([["main.tex", text]])) : null;
}

function xmlText(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** Title, authors and year from the arXiv API's Atom answer. */
export function parseArxivAtom(xml: string): { title?: string; authors?: string; year?: number } {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1] ?? "";
  const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => xmlText(m[1]!));
  const year = Number(entry.match(/<published>(\d{4})/)?.[1]);
  return {
    ...(title ? { title: xmlText(title) } : {}),
    ...(authors.length ? { authors: authors.length > 4 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ") } : {}),
    ...(Number.isFinite(year) && year > 1900 ? { year } : {}),
  };
}

export interface FetchDeps {
  fetch?: typeof fetch;
  /** `orx paper --full <id>`, when orx is installed. */
  orxPaper?: (id: string) => Promise<string>;
  log?: (message: string) => void;
}

function cap(text: string): string {
  return text.length > SOURCE_MAX ? `${text.slice(0, SOURCE_MAX)}\n\n[… cut at ${SOURCE_MAX} characters]` : text;
}

/** An arXiv paper's text: its LaTeX, else alphaXiv's text. Throws when neither is available. */
export async function fetchArxiv(arxiv: string, deps: FetchDeps = {}): Promise<PaperSource> {
  const get = deps.fetch ?? fetch;
  const headers = { "user-agent": "agent-in-notebook (Mentor)" };
  let meta: ReturnType<typeof parseArxivAtom> = {};
  try {
    const r = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv)}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.ok) meta = parseArxivAtom(await r.text());
  } catch (e) {
    deps.log?.(`Mentor: arXiv metadata for ${arxiv}: ${(e as Error).message}`);
  }
  const base = { title: meta.title ?? `arXiv ${arxiv}`, ...(meta.authors ? { authors: meta.authors } : {}), ...(meta.year ? { year: meta.year } : {}), url: `https://arxiv.org/abs/${arxiv}`, arxiv };
  try {
    const r = await get(`https://arxiv.org/e-print/${encodeURIComponent(arxiv)}`, { headers, signal: AbortSignal.timeout(60_000) });
    if (r.ok) {
      const latex = latexFromEprint(Buffer.from(await r.arrayBuffer()));
      if (latex && latex.length > 2000) {
        return { ...base, kind: "latex", text: cap(`<!-- source: arXiv LaTeX of ${arxiv}; the formulas are the authors' own -->\n# ${base.title}\n\n${latex}`) };
      }
    }
  } catch (e) {
    deps.log?.(`Mentor: arXiv source of ${arxiv}: ${(e as Error).message}`);
  }
  if (deps.orxPaper) {
    try {
      const text = await deps.orxPaper(arxiv);
      if (text.trim().length > 2000) return { ...base, kind: "alphaxiv", text: cap(`<!-- source: alphaXiv full text of ${arxiv} (orx paper); formulas may be flattened, check them against the PDF -->\n# ${base.title}\n\n${text}`) };
    } catch (e) {
      deps.log?.(`Mentor: orx paper ${arxiv}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Không lấy được nội dung của arXiv ${arxiv} (không có mã LaTeX, và orx không có sẵn). Tải PDF về rồi thêm paper bằng file PDF.`);
}

/** Python that writes base64 chunks to a file on the notebook's machine. */
export function pdfChunkCode(path: string, chunk: string, first: boolean): string {
  return `import base64 as _b\nwith open(${JSON.stringify(path)}, ${first ? '"wb"' : '"ab"'}) as _f:\n    _f.write(_b.b64decode("${chunk}"))\ndel _b, _f\nprint("ok")`;
}

/** Python that takes the text out of the PDF (installing pypdf if needed) into a text file, and prints its length. */
export function pdfExtractCode(path: string, out: string): string {
  return String.raw`
def _ainb_pdf():
    import importlib.util, json, subprocess, sys
    if importlib.util.find_spec("pypdf") is None:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pypdf"], check=False, capture_output=True)
    try:
        from pypdf import PdfReader
    except ImportError:
        print("<<MENTOR-PDF " + json.dumps({"error": "pypdf không cài được (notebook cần bật Internet)."}) + " MENTOR-PDF>>")
        return
    reader = PdfReader(${JSON.stringify(path)})
    pages = []
    for i, page in enumerate(reader.pages):
        pages.append(f"\n\n[page {i + 1}]\n" + (page.extract_text() or ""))
    text = "".join(pages)
    meta = reader.metadata or {}
    with open(${JSON.stringify(out)}, "w", encoding="utf-8") as f:
        f.write(text)
    print("<<MENTOR-PDF " + json.dumps({"chars": len(text), "pages": len(reader.pages), "title": str(meta.get("/Title") or "")}) + " MENTOR-PDF>>")
try:
    _ainb_pdf()
finally:
    del _ainb_pdf
`.trimStart();
}

/** Python that prints a slice of a text file as a marked base64 line. */
export function readSliceCode(path: string, offset: number, length: number): string {
  return `import base64 as _b\nwith open(${JSON.stringify(path)}, encoding="utf-8") as _f:\n    _t = _f.read()[${offset}:${offset + length}]\nprint("<<MENTOR-PDF " + _b.b64encode(_t.encode("utf-8")).decode() + " MENTOR-PDF>>")\ndel _b, _f, _t`;
}

export function pdfMarked(text: string): string | null {
  return text.match(/<<MENTOR-PDF (.*?) MENTOR-PDF>>/)?.[1] ?? null;
}
