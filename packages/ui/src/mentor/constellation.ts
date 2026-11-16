// The star map's geometry: where each star sits in the SVG, how bright it is,
// which lines are lit, where constellation names go, and the background dust.
// Pure, so it is tested without a browser.

import type { MentorHome, MentorStarState, MentorStarView } from "@ainb/protocol";

export const MAP_W = 1000;
export const MAP_H = 560;
const PAD_X = 46;
const PAD_Y = 40;

export interface MapStar extends MentorStarView {
  cx: number;
  cy: number;
  r: number;
  today: boolean;
}

export interface MapLink {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Both ends mastered: the line glows. */
  lit: boolean;
  /** One end started: the line shows faintly. */
  near: boolean;
  /** The dimmer end's fade (an overdue review). */
  fade: number;
}

export interface MapLabel {
  id: string;
  name: string;
  x: number;
  y: number;
  mastered: number;
  total: number;
}

export interface MapLayout {
  stars: MapStar[];
  links: MapLink[];
  labels: MapLabel[];
  dust: { x: number; y: number; r: number; o: number }[];
}

const RADIUS: Record<MentorStarState, number> = { locked: 2.4, open: 5, learning: 6, mastered: 7.5 };

export function place(x: number, y: number): { cx: number; cy: number } {
  return { cx: PAD_X + (x / 100) * (MAP_W - 2 * PAD_X), cy: PAD_Y + (y / 100) * (MAP_H - 2 * PAD_Y) };
}

/** A small seeded generator, so the sky looks the same every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function layout(home: Pick<MentorHome, "stars" | "constellations" | "today">): MapLayout {
  const stars: MapStar[] = home.stars.map((s) => ({ ...s, ...place(s.x, s.y), r: RADIUS[s.state], today: home.today?.star === s.id }));
  const byId = new Map(stars.map((s) => [s.id, s]));
  const links: MapLink[] = [];
  for (const s of stars) {
    for (const a of s.after) {
      const from = byId.get(a);
      if (!from) continue;
      links.push({
        from: a, to: s.id, x1: from.cx, y1: from.cy, x2: s.cx, y2: s.cy,
        lit: from.state === "mastered" && s.state === "mastered",
        near: from.state !== "locked" || s.state !== "locked",
        fade: Math.max(from.fade, s.fade),
      });
    }
  }
  const labels: MapLabel[] = home.constellations.map((c) => {
    const own = stars.filter((s) => s.constellation === c.id);
    const xs = own.map((s) => s.cx);
    const top = Math.min(...own.map((s) => s.cy));
    return {
      id: c.id,
      name: c.name,
      x: own.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0,
      y: own.length ? Math.max(14, top - 22) : 0,
      mastered: c.mastered,
      total: c.stars.length,
    };
  });
  const rand = seeded(7);
  const dust = Array.from({ length: 160 }, () => ({ x: rand() * MAP_W, y: rand() * MAP_H, r: 0.4 + rand() * 1.1, o: 0.15 + rand() * 0.45 }));
  return { stars, links, labels, dust };
}

/** Columns of a GitHub-style heatmap: weeks, each with seven days (Monday first). */
export function heatWeeks(days: { day: string; count: number }[]): ({ day: string; count: number } | null)[][] {
  if (!days.length) return [];
  const first = new Date(`${days[0]!.day}T00:00:00Z`).getUTCDay();
  const lead = (first + 6) % 7;
  const cells: ({ day: string; count: number } | null)[] = [...new Array(lead).fill(null), ...days];
  const weeks: ({ day: string; count: number } | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** A rating as a share of the scale the bars draw (800..2400). */
export function ratingShare(r: number | null): number {
  if (r === null) return 0;
  return Math.max(0.04, Math.min(1, (r - 800) / 1600));
}
