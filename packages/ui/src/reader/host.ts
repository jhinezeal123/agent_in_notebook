// What the reading tab (packages/ui/src/reader) asks of its host (VS Code's
// ReaderHost, packages/vscode/src/reader-host.ts), and what the two views of a
// paper (its arXiv HTML, its PDF) offer the tab.

import type { ReaderAnchor, ReaderSectionView, ReaderView } from "@ainb/protocol";

export interface ReaderPageHost {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Events: "updated" (a ReaderView), "render" (a page or figure the tutor wants), "reveal" (an anchor), "connected". */
  on(listener: (e: { event: string; params?: unknown }) => void): () => void;
}

/** What the tab needs to show the paper (the host's answer to "init"). */
export interface ReaderInit {
  view: ReaderView;
  /** The paper's reading folder as a webview URL, ending in "/" (doc.html, paper.pdf, assets/ are in it). */
  base: string;
  /** pdf.js and its worker (a PDF paper only loads them). */
  pdfjs: string;
  pdfWorker: string;
}

/** What a view of the paper does for the tab. */
export interface DocHandle {
  /** Bring a cited place into view and mark it; false when it is not found. */
  reveal(anchor: ReaderAnchor): boolean;
  /** Scroll to a section (an outline click). */
  scrollTo(sectionId: string): void;
  /** A page or a figure as JPEG (base64), for the tutor to look at. */
  render(what: { page: number } | { asset: string }): Promise<string>;
  /** What the passes show on the paper (ER-2). */
  decorate(d: DocDecor): void;
}

/** The passes on the paper: roles lit up and the rest dimmed when skimming (pass 1), results hidden for a guess, a unit hidden while recalled. */
export interface DocDecor {
  /** Paragraphs and what they do (shown when not empty). */
  roles: { anchor: string; role: string }[];
  /** Dim what a first pass skips (title, abstract, introduction, headings, figures, conclusion stay). */
  skim: boolean;
  /** Tables whose results are hidden until the reader guessed. */
  hidden: string[];
  /** Sections hidden while the reader recalls them. */
  cover: string[];
  sections: ReaderSectionView[];
}

/** The section in view: the last one whose start is above this share of the view's height. */
export const READING_LINE = 0.3;

/** Mark a range or an element for a moment, where the reader's eyes should go. */
export function flash(target: Range | Element): void {
  if (target instanceof Range) {
    const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (registry && HighlightCtor) {
      registry.set("er-cite", new HighlightCtor(target));
      setTimeout(() => registry.delete("er-cite"), 4000);
      return;
    }
    const el = target.startContainer.parentElement;
    if (el) flash(el);
    return;
  }
  target.classList.remove("er-flash");
  void (target as HTMLElement).offsetWidth;
  target.classList.add("er-flash");
  setTimeout(() => target.classList.remove("er-flash"), 2200);
}

/** Scroll a scroller so that a box sits a third of the way down. */
export function scrollToBox(scroller: HTMLElement, box: DOMRect): void {
  const top = scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top: scroller.scrollTop + box.top - top - scroller.clientHeight * 0.3, behavior: "smooth" });
}

/** An image drawn on white as JPEG (base64), at most `max` pixels wide. */
export function jpegOf(source: CanvasImageSource, width: number, height: number, max = 1600): string {
  const scale = Math.min(1, max / Math.max(1, width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85).replace(/^data:image\/jpeg;base64,/, "");
}
