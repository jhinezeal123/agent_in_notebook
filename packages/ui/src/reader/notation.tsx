import katex from "katex";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ReaderGuide } from "@ainb/protocol";

export function EquationNotation({ root, notation }: { root: HTMLElement | null; notation: ReaderGuide["map"]["notation"] }) {
  const [tip, setTip] = useState<{ text: string; top: number; left: number }>();
  const meanings = useMemo(() => {
    const map = new Map<string, string>();
    const template = document.createElement("template");
    for (const item of notation) {
      try {
        template.innerHTML = katex.renderToString(item.symbol.replace(/^\$|\$$/g, ""), { output: "html", trust: false, maxExpand: 100, maxSize: 10 });
        const rendered = template.content.querySelector(".katex-html")?.textContent?.replace(/\s+/g, "");
        if (rendered) map.set(rendered, `${item.meaning}${item.shape ? ` · ${item.shape}` : ""}`);
      } catch { /* The notation table still shows the original entry. */ }
    }
    return map;
  }, [notation]);
  useEffect(() => {
    if (!root || !meanings.size) return;
    function over(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const formula = target?.closest(".er-math, math");
      for (let el = target; el && el !== formula && formula; el = el.parentElement) {
        if (el.matches(".katex-html .mord, mi, msub, msup, msubsup")) {
          const text = meanings.get(el.textContent?.replace(/\s+/g, "") ?? "");
          if (text) {
            const rect = el.getBoundingClientRect();
            setTip({ text, top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - Math.min(280, window.innerWidth - 16) - 8) });
            return;
          }
        }
      }
      setTip(undefined);
    }
    const hide = () => setTip(undefined);
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerleave", hide);
    root.addEventListener("scroll", hide, { passive: true });
    return () => {
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerleave", hide);
      root.removeEventListener("scroll", hide);
    };
  }, [root, meanings]);
  return tip ? <div class="er-notation-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>{tip.text}</div> : null;
}
