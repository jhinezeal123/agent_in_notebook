import { parseReaderCite } from "@ainb/protocol";
import type { ReaderDoc } from "./doc.js";
import { findQuote } from "./lint.js";

const citation = /\[\[([^\[\]\n]{1,300})\]\]/g;
const category = /^\s*(?:\*\*|__)?(Paper nói|Ngoài paper|Suy luận|Hướng dẫn)(?:\*\*|__)?\s*:/iu;
const withheld = "Một phần câu trả lời bị giữ lại vì thiếu mốc hoặc đoạn trích khớp với paper. Bạn có thể hỏi lại và yêu cầu gia sư dẫn nguyên văn.";

/** Check a complete reply before its prose reaches the transcript. */
export function reviewReaderReply(doc: ReaderDoc, text: string): string {
  const known = new Set([...doc.sections, ...doc.blocks, ...doc.equations, ...doc.refs].map((entry) => entry.id));
  const equations = new Map(doc.equations.map((e) => [e.id, e.block]));
  const published: string[] = [];
  let rejected = false;
  // A paper claim is one paragraph, so a good citation elsewhere cannot open it.
  for (const raw of text.trim().split(/\n[\t ]*\n/).filter(Boolean)) {
    const label = raw.match(category)?.[1]?.toLowerCase();
    let exact = false;
    let valid = !raw.replace(citation, "").includes("[[");
    const block = raw.replace(citation, (full, inside: string) => {
      const anchor = parseReaderCite(inside);
      if (!anchor || (anchor.id && !known.has(anchor.id))) {
        valid = false;
        return "";
      }
      if (!anchor.quote) return full;
      const found = findQuote(doc, anchor.id ?? "", anchor.quote);
      if (!found || (anchor.page !== undefined && anchor.page !== found.page)) {
        valid = false;
        return "";
      }
      const id = anchor.id && (anchor.id === found.id || equations.get(anchor.id) === found.id) ? anchor.id : found.id;
      // The citation has the same anchor/quote format as the webview's chip parser.
      const resolved = `${id}: "${anchor.quote}"`;
      if (resolved.length > 300 || !parseReaderCite(resolved)) {
        valid = false;
        return "";
      }
      exact = true;
      return `[[${resolved}]]`;
    });
    if (valid && (exact || (label && label !== "paper nói"))) published.push(block);
    else rejected = true;
  }
  if (rejected || !published.length) published.push(withheld);
  return published.join("\n\n");
}
