// The checks a question passes before it reaches the reader (E.6, the
// bridge's part): its schema and the rules of writing a question (Haladyna
// et al.), its quotes found in the paper, no near-duplicate; the map's and a
// unit's anchors exist. What the author gets back when it fails is in English,
// for the agent to fix. Pure.

import { READER_BLOOMS, type ReaderBloom } from "@ainb/protocol";
import type { ReaderBlock, ReaderDoc } from "./doc.js";
import { descendants } from "./doc.js";
import type { ItemInput, MapInput, PackInput, ReaderItem, ReaderUnitDef } from "./items.js";
import { sectionOf } from "./tools.js";

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

/**
 * Words compared loosely: Unicode forms folded (ligatures, subscripts), TeX's
 * Greek as letters, other TeX commands, spaces, punctuation and hyphens gone,
 * lowercase. "$W_{0}x$ + \Delta W" and "W0x + ΔW" compare equal.
 */
export function loose(s: string): string {
  return s
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => GREEK[name] ?? " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Least loose letters a quote needs: shorter ones are found anywhere. */
const QUOTE_MIN = 20;

/**
 * Where a quote is in the paper: the block (paragraph, equation, figure,
 * table) that has it, the anchor's own first; null when the paper does not
 * have it.
 */
export function findQuote(doc: Pick<ReaderDoc, "sections" | "blocks" | "equations">, anchor: string, quote: string): ReaderBlock | null {
  const q = loose(quote);
  if (q.length < QUOTE_MIN) return null;
  const has = (b: ReaderBlock) => loose(b.text).includes(q);
  const own = doc.blocks.find((b) => b.id === anchor) ?? doc.blocks.find((b) => b.id === doc.equations.find((e) => e.id === anchor)?.block);
  if (own && has(own)) return own;
  const section = sectionOf(doc as ReaderDoc, anchor);
  if (section) {
    const ids = new Set([section, ...descendants(doc.sections, section)]);
    const near = doc.blocks.find((b) => ids.has(b.section) && has(b));
    if (near) return near;
  }
  return doc.blocks.find(has) ?? null;
}

/** An id of the paper: a section, block, equation, or something in a block ("S4.SS1.p2.1"). */
export function knownAnchor(doc: ReaderDoc, id: string): boolean {
  return !!sectionOf(doc, id);
}

const ALL_NONE = /\b(all|none|both|neither)\s+of\s+(the\s+)?(above|options|answers|these)\b|tất cả (các )?(đáp án|phương án|ý|câu)( ở)? trên|tất cả đều (đúng|sai)|không (có )?(đáp án|phương án|ý) nào|cả hai (đáp án|phương án|ý)|\b[A-D] và [A-D] đều\b/i;
const NEGATIVE = /\b(NOT|EXCEPT)\b|\bKHÔNG\b|(không đúng|là sai|không phải là)\s*[?:.]?\s*$/;

function words(s: string): Set<string> {
  return new Set(s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

/** Two stems that say nearly the same (word overlap). */
export function nearDuplicate(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.75;
}

export interface QuoteFix {
  /** The evidence's anchor where the quote really is. */
  anchor: string;
}

/**
 * The rules of one question (E.6 checks 1 and 2). Returns what is wrong, and
 * fixes evidence anchors that point next to where the quote is.
 */
export function lintItem(item: ItemInput, doc: ReaderDoc, concepts?: Set<string>): string[] {
  const issues: string[] = [];
  const opts = item.options ?? [];
  const optionRules = (list: { text: string; correct: boolean; why: string }[], what: string, min: number, max: number, rightCount: "one" | "some") => {
    if (list.length < min || list.length > max) issues.push(`${what}: ${min === max ? min : `${min}–${max}`} are needed (there are ${list.length}).`);
    const right = list.filter((o) => o.correct).length;
    if (rightCount === "one" && right !== 1) issues.push(`${what}: exactly one must be right (${right} are).`);
    if (rightCount === "some" && (right < 1 || right === list.length)) issues.push(`${what}: at least one right and one wrong.`);
    for (const o of list) if (ALL_NONE.test(o.text)) issues.push(`${what}: no "all/none of the above" style option ("${o.text.slice(0, 60)}").`);
    for (const o of list.filter((x) => !x.correct)) if (o.why.trim().length < 10) issues.push(`${what}: the wrong option "${o.text.slice(0, 60)}" needs its why: the misconception it stands for.`);
    const seen = new Set<string>();
    for (const o of list) {
      const k = loose(o.text);
      if (seen.has(k)) issues.push(`${what}: two options say the same ("${o.text.slice(0, 60)}").`);
      seen.add(k);
    }
    const wrong = list.filter((o) => !o.correct).map((o) => o.text.length);
    if (rightCount === "one" && wrong.length) {
      const r = list.find((o) => o.correct)?.text.length ?? 0;
      const avg = wrong.reduce((a, b) => a + b, 0) / wrong.length;
      if (r > avg * 1.6 && r - Math.max(...wrong) > 25) issues.push(`${what}: the right option is much longer than the others (a cue): make them about the same length.`);
    }
  };
  switch (item.kind) {
    case "mcq":
      optionRules(opts, "options", 3, 4, "one");
      break;
    case "multi":
      optionRules(opts, "options", 3, 5, "some");
      break;
    case "twotier":
      optionRules(opts, "options", 3, 4, "one");
      optionRules(item.reasons ?? [], "reasons", 3, 4, "one");
      break;
    case "numeric":
      if (!item.numeric) issues.push("numeric: give `numeric: { value, tolerance }`.");
      break;
    case "order": {
      const steps = item.steps ?? [];
      if (steps.length < 3) issues.push("order: 3–7 steps are needed.");
      if (new Set(steps.map(loose)).size !== steps.length) issues.push("order: two steps say the same.");
      break;
    }
    case "match": {
      const pairs = item.pairs ?? [];
      if (pairs.length < 3) issues.push("match: 3–6 pairs are needed.");
      if (new Set(pairs.map((p) => loose(p.left))).size !== pairs.length || new Set(pairs.map((p) => loose(p.right))).size !== pairs.length) issues.push("match: each left and each right must be different.");
      break;
    }
  }
  if (NEGATIVE.test(item.stem)) issues.push("stem: write it positively (no NOT / EXCEPT / KHÔNG / \"điều nào không đúng\").");
  if (item.stem.replace(/\$[^$]*\$/g, "x").trim().length < 15) issues.push("stem: too short to hold the question's idea.");
  if (concepts?.size && !concepts.has(item.concept)) issues.push(`concept "${item.concept}" is not one of the map's concepts (${[...concepts].join(", ")}).`);
  issues.push(...lintEvidence(item.evidence, doc));
  return issues;
}

/** Each quote is the paper's own words (E.6 check 2); an anchor next to its quote is moved onto it. */
export function lintEvidence(evidence: { anchor: string; quote: string }[], doc: ReaderDoc): string[] {
  const issues: string[] = [];
  for (const e of evidence) {
    if (loose(e.quote).length < QUOTE_MIN) {
      issues.push(`evidence "${e.quote.slice(0, 60)}": too short to find; copy a whole clause (≥ 5 words) from paper_read.`);
      continue;
    }
    const block = findQuote(doc, e.anchor, e.quote);
    if (!block) issues.push(`evidence "${e.quote.slice(0, 80)}" is not in the paper: copy the paper's exact words from paper_read (formulas as their TeX).`);
    // Pointed at its section, or next to it: onto the block that has the words (an equation in it stays).
    else if (block.id !== e.anchor && !doc.equations.some((eq) => eq.id === e.anchor && eq.block === block.id)) e.anchor = block.id;
  }
  return issues;
}

/** A unit's checkpoint as the author wrote it (E.6 checks 1, 2, 4 at the author's word, 5). */
export function lintPack(pack: PackInput, ctx: { doc: ReaderDoc; unit: ReaderUnitDef; concepts?: Set<string>; others: ReaderItem[] }): string[] {
  const { doc, unit } = ctx;
  const issues: string[] = [];
  const inUnit = new Set(unit.sections);
  const here = (id: string) => {
    const s = sectionOf(doc, id);
    return !!s && inUnit.has(s);
  };
  if (pack.unit !== unit.id) issues.push(`unit: this is the checkpoint of "${unit.id}" (not "${pack.unit}").`);
  for (const p of pack.points) if (!knownAnchor(doc, p.anchor)) issues.push(`points: no anchor "${p.anchor}" in the paper.`);
  if (pack.explain && !here(pack.explain.anchor)) issues.push(`explain: "${pack.explain.anchor}" is not in this unit.`);
  for (const f of pack.figures) {
    const b = doc.blocks.find((x) => x.id === f.id);
    if (!b || (b.kind !== "fig" && b.kind !== "table") || !inUnit.has(b.section)) issues.push(`figures: "${f.id}" is not a figure or table of this unit.`);
  }
  for (const p of pack.predicts) {
    const b = doc.blocks.find((x) => x.id === p.id);
    if (!b || b.kind !== "table" || !inUnit.has(b.section)) issues.push(`predicts: "${p.id}" is not a table of this unit.`);
  }
  const items = pack.items;
  if (pack.light) {
    if (items.length > 2) issues.push("light: a unit with no checkpoint has at most 2 questions.");
  } else {
    if (items.length < 3 || items.length > 6) issues.push(`items: 3–6 questions are needed (there are ${items.length}); a unit with nothing to check (related work, conclusion) says why in \`light\`.`);
    if (items.length && !items.some((i) => atLeastApply(i.bloom))) issues.push("items: at least one question must be at the level of apply or higher (apply, analyze, evaluate, create).");
  }
  items.forEach((item, n) => {
    for (const msg of lintItem(item, doc, ctx.concepts)) issues.push(`item ${n + 1}: ${msg}`);
    items.slice(0, n).forEach((other, m) => {
      if (nearDuplicate(item.stem, other.stem)) issues.push(`item ${n + 1}: says nearly the same as item ${m + 1}.`);
    });
    for (const other of ctx.others) {
      if (other.concept === item.concept && other.bloom === item.bloom && nearDuplicate(item.stem, other.stem)) issues.push(`item ${n + 1}: says nearly the same as a question of unit ${other.unit} ("${other.stem.slice(0, 60)}").`);
    }
  });
  return issues;
}

export function atLeastApply(bloom: ReaderBloom): boolean {
  return READER_BLOOMS.indexOf(bloom) >= READER_BLOOMS.indexOf("apply");
}

/** One part of the map (each is written on its own). */
export function lintMapPart(part: keyof MapInput, map: MapInput, doc: ReaderDoc): string[] {
  const issues: string[] = [];
  switch (part) {
    case "roles":
      for (const r of map.roles ?? []) {
        const b = doc.blocks.find((x) => x.id === r.anchor);
        if (!b) issues.push(`roles: no paragraph "${r.anchor}" (use the ids paper_read shows in brackets).`);
      }
      if (new Set((map.roles ?? []).map((r) => r.anchor)).size !== (map.roles ?? []).length) issues.push("roles: a paragraph is listed twice.");
      break;
    case "concepts": {
      const ids = (map.concepts ?? []).map((c) => c.id);
      if (new Set(ids).size !== ids.length) issues.push("concepts: two have the same id.");
      for (const c of map.concepts ?? []) if (c.anchor && !knownAnchor(doc, c.anchor)) issues.push(`concepts: no anchor "${c.anchor}" (concept ${c.id}).`);
      break;
    }
    case "notation":
      for (const n of map.notation ?? []) if (n.anchor && !knownAnchor(doc, n.anchor)) issues.push(`notation: no anchor "${n.anchor}" (${n.symbol}).`);
      break;
    case "pretest":
      (map.pretest ?? []).forEach((p, i) => {
        if (!doc.sections.some((s) => s.id === p.section)) issues.push(`pretest ${i + 1}: no section "${p.section}".`);
        if (p.options) {
          if (p.options.length < 3 || p.options.length > 4) issues.push(`pretest ${i + 1}: 3–4 options.`);
          if (p.options.filter((o) => o.correct).length !== 1) issues.push(`pretest ${i + 1}: exactly one right option.`);
          for (const o of p.options) if (ALL_NONE.test(o.text)) issues.push(`pretest ${i + 1}: no "all/none of the above" option.`);
        }
        for (const msg of lintEvidence(p.evidence, doc)) issues.push(`pretest ${i + 1}: ${msg}`);
      });
      break;
    case "units": {
      const seen = new Set<string>();
      for (const u of map.units ?? []) {
        for (const s of u.sections) {
          if (!doc.sections.some((x) => x.id === s)) issues.push(`units: no section "${s}" ("${u.title}").`);
          if (seen.has(s)) issues.push(`units: "${s}" is in two units.`);
          seen.add(s);
        }
      }
      break;
    }
    case "fivec":
    case "background":
      break;
  }
  return issues;
}
