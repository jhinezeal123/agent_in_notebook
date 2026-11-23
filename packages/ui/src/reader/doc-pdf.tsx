// A paper as its PDF, drawn with pdf.js (6.5.438: it no longer turns a PDF's
// functions into JavaScript, the old CVE-2024-4367 path, and the tab's CSP
// forbids eval anyway): pages on canvases with a text layer to select from,
// drawn as they come near.
// The first time, its text is taken out for the tutor (reader.pdfText).
// pdf.js is imported from the extension's files and its worker started from a
// blob: a webview cannot start a worker from its resource URLs (ER-0).

import { useEffect, useRef, useState } from "preact/hooks";
import type * as PdfJs from "pdfjs-dist";
import type { ReaderAnchor } from "@ainb/protocol";
import { quoteRange } from "./anchors.js";
import { flash, jpegOf, READING_LINE, scrollToBox, type DocHandle, type ReaderInit, type ReaderPageHost } from "./host.js";

type Pdf = typeof PdfJs;
type PdfDocument = PdfJs.PDFDocumentProxy;

/** The tutor's page images: about 250 KB each (ER-0). */
const RENDER_SCALE = 1.5;
const MAX_WIDTH = 1100;

let loading: Promise<Pdf> | undefined;

/** pdf.js, once per tab. */
function loadPdfJs(init: ReaderInit): Promise<Pdf> {
  loading ??= (async () => {
    const pdfjs = await import(/* webpackIgnore: true */ init.pdfjs) as Pdf;
    const source = await (await fetch(init.pdfWorker)).text();
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
    return pdfjs;
  })();
  return loading;
}

interface PageBox {
  n: number;
  el: HTMLDivElement;
  drawn: boolean;
}

export function PdfDoc({ init, host, scroller, onReady, onSection, onTextProgress }: {
  init: ReaderInit;
  host: ReaderPageHost;
  scroller: () => HTMLElement | null;
  onReady: (doc: DocHandle) => void;
  onSection: (id: string | undefined) => void;
  onTextProgress: (state: { done: number; total: number } | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    let stale = false;
    let observer: IntersectionObserver | undefined;
    let task: PdfJs.PDFDocumentLoadingTask | undefined;
    const el = root.current!;
    void (async () => {
      try {
        const pdfjs = await loadPdfJs(init);
        const res = await fetch(`${init.base}paper.pdf`);
        if (!res.ok) throw new Error(`Không đọc được file PDF (${res.status}).`);
        const data = new Uint8Array(await res.arrayBuffer());
        task = pdfjs.getDocument({ data, enableXfa: false });
        const doc = await task.promise;
        if (stale) return;
        const width = Math.min(MAX_WIDTH, Math.max(320, (scroller()?.clientWidth ?? 900) - 48));
        const pages: PageBox[] = [];
        el.textContent = "";
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const vp = page.getViewport({ scale });
          const box = document.createElement("div");
          box.className = "er-page";
          box.id = `page-${n}`;
          box.dataset.page = String(n);
          box.style.width = `${Math.floor(vp.width)}px`;
          box.style.height = `${Math.floor(vp.height)}px`;
          box.style.setProperty("--total-scale-factor", String(scale));
          box.style.setProperty("--scale-round-x", "1px");
          box.style.setProperty("--scale-round-y", "1px");
          const label = document.createElement("div");
          label.className = "er-page-no";
          label.textContent = `${n}`;
          box.append(label);
          el.append(box);
          pages.push({ n, el: box, drawn: false });
        }
        setState({ loading: false });
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const p = pages[Number((entry.target as HTMLElement).dataset.page) - 1];
            if (p && !p.drawn) {
              p.drawn = true;
              void draw(pdfjs, doc, p).catch(() => { p.drawn = false; });
            }
          }
        }, { root: scroller(), rootMargin: "900px 0px" });
        for (const p of pages) observer.observe(p.el);
        onReady(handle(el, doc, pages, pdfjs, scroller));
        if (init.view.needsText) await takeText(doc, host, () => stale, onTextProgress);
      } catch (e) {
        if (!stale) setState({ loading: false, error: (e as Error).message });
      }
    })();
    return () => {
      stale = true;
      observer?.disconnect();
      void task?.destroy();
    };
  }, [init.base]);

  useEffect(() => {
    const box = scroller();
    if (!box) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = box.getBoundingClientRect().top + box.clientHeight * READING_LINE;
      let current: string | undefined;
      for (const page of root.current?.querySelectorAll<HTMLElement>(".er-page") ?? []) {
        if (page.getBoundingClientRect().top <= line) current = page.id;
        else break;
      }
      onSection(current ?? "page-1");
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    box.addEventListener("scroll", onScroll, { passive: true });
    const timer = setTimeout(update, 600);
    return () => { box.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [init.base]);

  return (
    <>
      {state.loading && <div class="er-status">Đang mở PDF…</div>}
      {state.error && <div class="er-status error">{state.error}</div>}
      <div ref={root} class="er-doc er-doc-pdf" />
    </>
  );
}

/** A page: its canvas (sharp on this screen), and its text layer to select and find words in. */
async function draw(pdfjs: Pdf, doc: PdfDocument, p: PageBox): Promise<void> {
  const page = await doc.getPage(p.n);
  const scale = Number(p.el.style.getPropertyValue("--total-scale-factor")) || 1;
  const vp = page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${Math.floor(vp.width)}px`;
  canvas.style.height = `${Math.floor(vp.height)}px`;
  await page.render({ canvas, viewport: vp, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) }).promise;
  const text = document.createElement("div");
  text.className = "textLayer";
  p.el.append(canvas, text);
  await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render();
}

/** Each page's text, for the tutor (once: the bridge keeps it). */
async function takeText(doc: PdfDocument, host: ReaderPageHost, stale: () => boolean, progress: (s: { done: number; total: number } | null) => void): Promise<void> {
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (stale()) return;
    progress({ done: n - 1, total: doc.numPages });
    const content = await (await doc.getPage(n)).getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      text += item.hasEOL ? "\n" : "";
    }
    pages.push(text);
  }
  let title: string | undefined;
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: unknown } | undefined)?.Title;
    if (typeof t === "string") title = t;
  } catch {
    // No metadata: the file's name stays the title.
  }
  try {
    await host.request("reader.pdfText", { pages, ...(title ? { title } : {}) });
  } finally {
    progress(null);
  }
}

function handle(root: HTMLElement, doc: PdfDocument, pages: PageBox[], pdfjs: Pdf, scroller: () => HTMLElement | null): DocHandle {
  const go = (box: DOMRect) => {
    const scroll = scroller();
    if (scroll) scrollToBox(scroll, box);
  };
  const reveal = (anchor: ReaderAnchor): boolean => {
    const n = anchor.page ?? Number(anchor.id?.match(/^page-(\d+)$/)?.[1]);
    const p = Number.isSafeInteger(n) ? pages[n - 1] : undefined;
    if (!p && !anchor.quote) return false;
    if (p && !p.drawn) {
      // Not drawn yet: its text layer is needed to find the words.
      p.drawn = true;
      void draw(pdfjs, doc, p).then(() => reveal(anchor), () => { p.drawn = false; });
      go(p.el.getBoundingClientRect());
      return true;
    }
    if (anchor.quote) {
      const range = (p && quoteRange(p.el, anchor.quote)) ?? quoteRange(root, anchor.quote);
      if (range) {
        go(range.getBoundingClientRect());
        flash(range);
        return true;
      }
    }
    if (!p) return false;
    go(p.el.getBoundingClientRect());
    flash(p.el);
    return true;
  };
  return {
    decorate(d) {
      // A PDF's pages are pictures: a unit being recalled hides them all.
      root.classList.toggle("er-covered", d.cover.length > 0);
    },
    reveal,
    scrollTo(sectionId: string) {
      const el = document.getElementById(sectionId);
      const box = scroller();
      if (el && box) box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8, behavior: "smooth" });
    },
    async render(what) {
      if (!("page" in what)) throw new Error("Hình của PDF: xem cả trang (paper_page).");
      if (what.page < 1 || what.page > doc.numPages) throw new Error(`PDF có ${doc.numPages} trang.`);
      const page = await doc.getPage(what.page);
      const vp = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvas, viewport: vp }).promise;
      return jpegOf(canvas, canvas.width, canvas.height, 2000);
    },
  };
}
