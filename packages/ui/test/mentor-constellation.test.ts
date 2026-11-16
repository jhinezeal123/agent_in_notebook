import { describe, expect, it } from "vitest";
import type { MentorConstellation, MentorStarState, MentorStarView } from "@ainb/protocol";
import { MAP_H, MAP_W, heatWeeks, layout, ratingShare } from "../src/mentor/constellation.js";

function star(id: string, x: number, y: number, state: MentorStarState, after: string[] = []): MentorStarView {
  return { id, name: id, constellation: "foundation", x, y, after, state, fade: 0, exercises: [] };
}

const constellations: MentorConstellation[] = [{ id: "foundation", name: "Nền móng", stars: ["a", "b", "c"], mastered: 2 }];

describe("layout", () => {
  const stars = [star("a", 0, 0, "mastered"), star("b", 100, 100, "mastered", ["a"]), star("c", 50, 50, "locked", ["b"])];
  const map = layout({ stars, constellations, today: { exerciseId: "x", title: "X", star: "c", minutes: 20, difficulty: 1000, reason: "next", kind: "learn" } });

  it("keeps every star inside the map, corners included", () => {
    for (const s of map.stars) {
      expect(s.cx).toBeGreaterThan(0);
      expect(s.cx).toBeLessThan(MAP_W);
      expect(s.cy).toBeGreaterThan(0);
      expect(s.cy).toBeLessThan(MAP_H);
    }
  });

  it("lights a line only when both ends are mastered", () => {
    const ab = map.links.find((l) => l.from === "a" && l.to === "b")!;
    const bc = map.links.find((l) => l.from === "b" && l.to === "c")!;
    expect(ab.lit).toBe(true);
    expect(bc.lit).toBe(false);
    expect(bc.near).toBe(true);
  });

  it("marks today's star and sizes stars by state", () => {
    expect(map.stars.find((s) => s.id === "c")!.today).toBe(true);
    expect(map.stars.find((s) => s.id === "a")!.today).toBe(false);
    expect(map.stars.find((s) => s.id === "a")!.r).toBeGreaterThan(map.stars.find((s) => s.id === "c")!.r);
  });

  it("puts the constellation label above its stars, and the sky is the same each time", () => {
    const label = map.labels[0]!;
    expect(label).toMatchObject({ id: "foundation", mastered: 2, total: 3 });
    expect(label.y).toBeLessThan(Math.min(...map.stars.map((s) => s.cy)) + 1);
    expect(layout({ stars, constellations, today: null }).dust).toEqual(map.dust);
  });
});

describe("heatWeeks", () => {
  it("starts columns on Monday and keeps every day", () => {
    // 2026-11-11 is a Wednesday: two empty cells lead the first week.
    const days = Array.from({ length: 10 }, (_, i) => ({ day: `2026-11-${String(11 + i).padStart(2, "0")}`, count: i }));
    const weeks = heatWeeks(days);
    expect(weeks[0]!.slice(0, 3)).toEqual([null, null, days[0]]);
    expect(weeks.flat().filter(Boolean)).toEqual(days);
    expect(weeks.every((w) => w.length <= 7)).toBe(true);
    expect(heatWeeks([])).toEqual([]);
  });
});

describe("ratingShare", () => {
  it("maps 800..2400 to a visible share", () => {
    expect(ratingShare(null)).toBe(0);
    expect(ratingShare(100)).toBe(0.04);
    expect(ratingShare(1600)).toBeCloseTo(0.5);
    expect(ratingShare(3000)).toBe(1);
  });
});
