// A paper as arXiv's HTML (LaTeXML), cleaned by the bridge (doc.html in the
// paper's folder) and cleaned again here: the formulas drawn by KaTeX from the
// authors' TeX (LaTeXML's MathML stays when KaTeX cannot), the images from the
// paper's folder, outside links to the browser.

import DOMPurify from "dompurify";
import katex from "katex";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ReaderAnchor, ReaderSectionView } from "@ainb/protocol";
import { quoteRange } from "./anchors.js";
import { flash, jpegOf, READING_LINE, scrollToBox, type DocDecor, type DocHandle, type ReaderInit, type ReaderPageHost } from "./host.js";

const MATH_BATCH = 120;

export function HtmlDoc({ init, host, scroller, onReady, onSection }: {
  init: ReaderInit;
  host: ReaderPageHost;
  scroller: () => HTMLElement | null;
  onReady: (doc: DocHandle) => void;
  onSection: (id: string | undefined) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    let stale = false;
    const el = root.current!;
    void (async () => {
      try {
        const res = await fetch(`${init.base}doc.html`);
        if (!res.ok) throw new Error(`Không đọc được bản HTML của paper (${res.status}).`);
        const html = await res.text();
        if (stale) return;
        el.innerHTML = clean(html, init.base);
        setState({ loading: false });
        onReady(handle(el, init, scroller));
        await typeset(el, () => stale);
      } catch (e) {
        if (!stale) setState({ loading: false, error: (e as Error).message });
      }
    })();
    return () => { stale = true; };
  }, [init.base]);

  // The section in view, as the reader scrolls.
  useEffect(() => {
    const box = scroller();
    if (!box) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      onSection(sectionInView(box, init.view.sections));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    box.addEventListener("scroll", onScroll, { passive: true });
    const timer = setTimeout(update, 400);
    return () => { box.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [init.base, init.view.sections.length]);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.("a[href]");
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      e.preventDefault();
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      const box = scroller();
      if (target && box) {
        scrollToBox(box, target.getBoundingClientRect());
        flash(target);
      }
      return;
    }
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) void host.request("link.open", { url: href }).catch(() => {});
  };

  return (
    <>
      {state.loading && <div class="er-status">Đang mở bản HTML của paper…</div>}
      {state.error && <div class="er-status error">{state.error}</div>}
      <div ref={root} class="er-doc er-doc-html ltx_page_content" onClick={onClick} />
    </>
  );
}

/** The bridge's HTML, sanitized again (MathML and SVG kept), images pointed at the paper's folder. */
function clean(html: string, base: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ["alttext", "display"],
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "link", "meta", "base"],
    FORBID_ATTR: ["srcset", "ping", "target", "formaction"],
  });
  for (const img of fragment.querySelectorAll<HTMLImageElement>("img[src]")) {
    const src = img.getAttribute("src") ?? "";
    // Only the paper's own copies (assets/…): nothing is loaded from the network.
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) img.removeAttribute("src");
    else img.src = new URL(src, base).href;
    img.loading = "lazy";
    img.decoding = "async";
  }
  for (const a of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("#") && !/^https?:\/\//i.test(href)) a.removeAttribute("href");
    else if (!href.startsWith("#")) a.title = href;
  }
  const box = document.createElement("div");
  box.append(fragment);
  return box.innerHTML;
}

/** Formulas drawn with KaTeX from the TeX LaTeXML kept (alttext), a batch per frame; MathML stays where KaTeX fails. */
async function typeset(root: HTMLElement, stale: () => boolean): Promise<void> {
  const maths = [...root.querySelectorAll("math[alttext]")];
  for (let i = 0; i < maths.length; i += MATH_BATCH) {
    if (stale()) return;
    for (const math of maths.slice(i, i + MATH_BATCH)) {
      const tex = (math.getAttribute("alttext") ?? "").trim();
      if (!tex || tex.length > 8000) continue;
      const display = math.getAttribute("display") === "block";
      try {
        const html = katex.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", maxExpand: 500, maxSize: 30 });
        const span = document.createElement("span");
        span.className = "er-math";
        span.dataset.tex = tex;
        if (display) span.dataset.display = "block";
        span.innerHTML = html;
        math.replaceWith(span);
      } catch {
        // An author's macro KaTeX does not know: LaTeXML's MathML shows it.
        math.classList.add("er-mathml");
      }
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function sectionInView(box: HTMLElement, sections: ReaderSectionView[]): string | undefined {
  const line = box.getBoundingClientRect().top + box.clientHeight * READING_LINE;
  let current: string | undefined;
  for (const s of sections) {
    const el = document.getElementById(s.id);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= line) current = s.id;
  }
  // Before the first section: the first one (the abstract, mostly).
  return current ?? sections.find((s) => document.getElementById(s.id))?.id;
}

function handle(root: HTMLElement, init: ReaderInit, scroller: () => HTMLElement | null): DocHandle {
  return {
    reveal(anchor: ReaderAnchor) {
      const box = scroller();
      const el = anchor.id ? document.getElementById(anchor.id) : null;
      if (anchor.quote) {
        const range = (el && quoteRange(el, anchor.quote)) ?? quoteRange(root, anchor.quote);
        if (range) {
          if (box) scrollToBox(box, range.getBoundingClientRect());
          flash(range);
          return true;
        }
      }
      if (!el) return false;
      if (box) scrollToBox(box, el.getBoundingClientRect());
      flash(el.tagName === "TBODY" ? el.closest("table") ?? el : el);
      return true;
    },
    scrollTo(sectionId: string) {
      const el = document.getElementById(sectionId);
      const box = scroller();
      if (el && box) box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8, behavior: "smooth" });
    },
    async render(what) {
      if (!("asset" in what)) throw new Error("Paper này hiện bằng HTML: không có trang PDF.");
      if (!/^assets\/[\w.-]+$/.test(what.asset)) throw new Error("Hình không thuộc paper.");
      // Fetched into a blob (same origin as the page), so the canvas can be read back.
      const res = await fetch(new URL(what.asset, init.base).href);
      if (!res.ok) throw new Error(`Không đọc được hình ${what.asset}.`);
      const url = URL.createObjectURL(await res.blob());
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const width = img.naturalWidth || 1200;
        const height = img.naturalHeight || Math.round(width * 0.75);
        return jpegOf(img, width, height);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    decorate(d: DocDecor) {
      decorateHtml(root, d);
    },
  };
}

/** Only these: a section id from the paper must not reach a selector unescaped. */
const byId = (id: string) => document.getElementById(id);

/** The passes on the paper's HTML (classes and data attributes the stylesheet draws). */
export function decorateHtml(root: HTMLElement, d: DocDecor): void {
  for (const el of root.querySelectorAll("[data-er-role]")) el.removeAttribute("data-er-role");
  for (const el of root.querySelectorAll(".er-hidden-result, .er-covered, .er-skim-keep")) el.classList.remove("er-hidden-result", "er-covered", "er-skim-keep");
  for (const r of d.roles) byId(r.anchor)?.setAttribute("data-er-role", r.role);
  root.classList.toggle("er-skim", d.skim);
  if (d.skim) {
    // Keshav's first pass: the introduction and the conclusion are read, besides what every section shows.
    const top = d.sections.filter((s) => s.level === 1);
    const intro = top.find((s) => s.number === "1") ?? top.find((s) => s.id !== "abstract");
    const outro = [...top].reverse().find((s) => /conclu|discussion|summary|limitation/i.test(s.title));
    for (const s of [intro, outro]) if (s) byId(s.id)?.classList.add("er-skim-keep");
  }
  for (const id of d.hidden) byId(id)?.classList.add("er-hidden-result");
  for (const id of d.cover) byId(id)?.classList.add("er-covered");
}
