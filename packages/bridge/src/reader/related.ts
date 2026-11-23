import type { ReaderRelated } from "@ainb/protocol";
import { z } from "zod";
import type { ReaderHub } from "./index.js";
import { DAY_MS } from "./cards.js";

const endpoint = "https://api.semanticscholar.org/graph/v1/paper";
const external = z.object({ ArXiv: z.string().optional(), DOI: z.string().optional() }).nullish();
const paper = z.object({ title: z.string().nullish(), url: z.string().nullish(), externalIds: external });
const citations = z.object({ data: z.array(z.object({ citingPaper: paper.nullish() })).max(50) });
const references = z.object({ data: z.array(z.object({ citedPaper: paper.nullish(), intents: z.array(z.string()).nullish() })).max(100) });
const roles = { background: "Bối cảnh", method: "Phương pháp", result: "Kết quả" } as const;

function doiKey(doi: string | undefined): string | undefined {
  return doi?.toLowerCase();
}

function arxivKey(id: string | undefined): string | undefined {
  return id && /^\d{4}\.\d{4,5}(v\d+)?$/.test(id) ? id.replace(/v\d+$/, "") : undefined;
}

export class ReaderRelatedPapers {
  private readonly requests = new Map<string, Promise<ReaderRelated>>();
  private nextFetch = 0;
  constructor(private readonly hub: ReaderHub, private readonly fetcher: typeof fetch = fetch) {}

  async get(paperId: string): Promise<ReaderRelated> {
    const cached = this.hub.store.readJson<{ at: number; result: ReaderRelated }>(paperId, "related.json");
    if (cached && Date.now() - cached.at < DAY_MS) return cached.result;
    const pending = this.requests.get(paperId);
    if (pending) return pending;
    const request = this.load(paperId, cached?.result).finally(() => this.requests.delete(paperId));
    this.requests.set(paperId, request);
    return request;
  }

  private async load(paperId: string, cached?: ReaderRelated): Promise<ReaderRelated> {
    const doc = this.hub.doc(paperId);
    const arxiv = arxivKey(doc.arxiv);
    const base: ReaderRelated = { references: doc.refs, citations: [] };
    if (!arxiv) return { ...base, notice: "Tra paper trích dẫn yêu cầu mã arXiv." };
    try {
      const id = encodeURIComponent(`ARXIV:${arxiv}`);
      const incoming = citations.parse(await this.query(`${id}/citations?limit=20&fields=title,url,externalIds`));
      const outgoing = references.parse(await this.query(`${id}/references?limit=100&fields=title,externalIds,intents`));
      const roleOf = new Map<string, string>();
      const extra: ReaderRelated["references"] = [];
      for (const ref of outgoing.data) {
        const a = arxivKey(ref.citedPaper?.externalIds?.ArXiv);
        const doi = doiKey(ref.citedPaper?.externalIds?.DOI);
        const role = [...new Set((ref.intents ?? []).map((name) => roles[name as keyof typeof roles]).filter(Boolean))].join(", ");
        if (a && role) roleOf.set(a, role);
        if (doi && role) roleOf.set(doi, role);
        if (ref.citedPaper?.title) extra.push({ id: `ref-${extra.length + 1}`, text: ref.citedPaper.title, ...(a ? { arxiv: a } : {}), ...(doi ? { doi } : {}), ...(role ? { role } : {}) });
      }
      const result: ReaderRelated = {
        references: doc.refs.length ? doc.refs.map((r) => {
          const role = roleOf.get(arxivKey(r.arxiv) ?? "") ?? roleOf.get(doiKey(r.doi) ?? "");
          return { ...r, ...(role ? { role } : {}) };
        }) : extra,
        citations: incoming.data.flatMap(({ citingPaper: p }) => {
          const a = arxivKey(p?.externalIds?.ArXiv);
          if (!p?.title || (!a && !p.url?.startsWith("https://www.semanticscholar.org/"))) return [];
          return [{ title: p.title, ...(a ? { arxiv: a } : {}), url: a ? `https://arxiv.org/abs/${a}` : p.url! }];
        }),
      };
      this.hub.store.writeJsonFile(paperId, "related.json", { at: Date.now(), result });
      return result;
    } catch {
      return { ...(cached ?? base), notice: "Semantic Scholar tạm thời chưa trả kết quả. Bạn có thể thử lại." };
    }
  }

  private async query(path: string): Promise<unknown> {
    const now = Date.now();
    const start = Math.max(now, this.nextFetch);
    if (start - now > 10_000) throw new Error("Semantic Scholar request queue is full.");
    this.nextFetch = start + 1100;
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
    const key = process.env.AINB_SEMANTIC_SCHOLAR_KEY;
    const response = await this.fetcher(`${endpoint}/${path}`, { signal: AbortSignal.timeout(6500), ...(key ? { headers: { "x-api-key": key } } : {}) });
    if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`);
    return response.json();
  }
}
