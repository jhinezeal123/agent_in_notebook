// arXiv for the reader's tests: the LoRA mini page (latexml-mini.html), its
// two images, its metadata; a hub on a temporary shelf that fetches from it.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ReaderHub, type ReaderHubOptions, type ReaderShelf } from "../../../src/reader/index.js";

export const PAGE = readFileSync(join(__dirname, "latexml-mini.html"), "utf8");
export const LORA = "2106.09685";
export const LORA_ID = "arxiv-2106-09685";

export const ATOM = `<feed><entry><title>LoRA: Low-Rank Adaptation of
  Large Language Models</title><published>2021-06-17T17:37:18Z</published>
<author><name>Edward J. Hu</name></author><author><name>Yelong Shen</name></author></entry></feed>`;

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
/** The smallest thing that passes for a JPEG (its magic number). */
export const JPEG = Buffer.from("ffd8ffe000104a46494600", "hex");

export type Routes = Record<string, () => Response>;

/** The LoRA mini paper as arXiv serves it. */
export function loraRoutes(): Routes {
  return {
    [`https://export.arxiv.org/api/query?id_list=${LORA}`]: () => new Response(ATOM),
    [`https://arxiv.org/html/${LORA}`]: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
    [`https://arxiv.org/html/${LORA}v2/figure1.svg`]: () => new Response(SVG),
    [`https://arxiv.org/html/${LORA}v2/qv8_qv64.png`]: () => new Response(PNG),
  };
}

export interface TestHub {
  hub: ReaderHub;
  root: string;
  fetched: string[];
  shelved: Parameters<ReaderShelf["shelve"]>[0][];
  emit: ReturnType<typeof vi.fn<ReaderHubOptions["emit"]>>;
  routes: Routes;
}

const roots: string[] = [];

/** A hub on a fresh shelf; whatever is not in `routes` answers 404. */
export function testHub(routes: Routes = loraRoutes(), opts: { shelf?: Partial<ReaderShelf>; root?: string; renderWaitMs?: number; author?: ReaderHubOptions["author"]; misconception?: ReaderHubOptions["misconception"] } = {}): TestHub {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "ainb-reader-"));
  if (!opts.root) roots.push(root);
  const fetched: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    const u = String(url);
    fetched.push(u);
    const route = routes[u];
    return route ? route() : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  const shelved: TestHub["shelved"] = [];
  const shelf: ReaderShelf = {
    paperFor: () => undefined,
    arxivOf: () => undefined,
    shelve: (p) => {
      shelved.push(p);
    },
    ...opts.shelf,
  };
  const emit = vi.fn<ReaderHubOptions["emit"]>();
  const hub = new ReaderHub({
    root, shelf, emit, fetch: fake, spacingMs: 0, renderWaitMs: opts.renderWaitMs ?? 2000, log: () => {},
    ...(opts.author ? { author: opts.author } : {}), ...(opts.misconception ? { misconception: opts.misconception } : {}),
  });
  return { hub, root, fetched, shelved, emit, routes };
}

/** Remove the shelves the tests made. */
export function cleanShelves(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}
