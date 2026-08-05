import { describe, expect, it } from 'vitest';
import {
  type FieldSeed,
  LOBE_ANCHOR,
  contourLines,
  elevationAt,
  placeSeeds,
  seedAt,
} from './field-math';

/**
 * The relief map is the navigation, so these are not cosmetic properties. If
 * two hills land on the same summit one of them is unclickable; if the map
 * reshuffles between renders people lose the place they had memorised; if a
 * recording-heavy space drifts to the frontal lobe the drawing is lying.
 */

function seed(id: string, weight: number, mix: FieldSeed['mix']): FieldSeed {
  return { id, label: id, weight, mix };
}

describe('placing hills on the cortex', () => {
  it('is deterministic — the same corpus draws the same map', () => {
    const input = [
      seed('a', 400, { upload: 10 }),
      seed('b', 120, { record: 8, meeting: 2 }),
      seed('c', 60, { drive: 5 }),
    ];
    const first = placeSeeds(input);
    const second = placeSeeds(input);
    expect(first.map((s) => [s.id, s.x, s.y])).toEqual(second.map((s) => [s.id, s.x, s.y]));
  });

  it('puts a recordings-only space over the temporal lobe, not the frontal one', () => {
    const [spoken] = placeSeeds([seed('spoken', 100, { record: 1 })]);
    const [filed] = placeSeeds([seed('filed', 100, { upload: 1 })]);
    if (!spoken || !filed) throw new Error('nothing placed');
    // Temporal sits low and back of frontal on the plate; the drawing has to
    // agree with the anatomy it borrows.
    expect(spoken.y).toBeGreaterThan(filed.y);
    expect(
      Math.hypot(spoken.x - LOBE_ANCHOR.record.x, spoken.y - LOBE_ANCHOR.record.y),
    ).toBeLessThan(Math.hypot(spoken.x - LOBE_ANCHOR.upload.x, spoken.y - LOBE_ANCHOR.upload.y));
  });

  it('separates spaces made of exactly the same material', () => {
    const placed = placeSeeds([
      seed('one', 100, { upload: 1 }),
      seed('two', 100, { upload: 1 }),
      seed('three', 100, { upload: 1 }),
    ]);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i] as (typeof placed)[number];
        const b = placed[j] as (typeof placed)[number];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(9);
      }
    }
  });

  it('keeps every hill inside the drawing, however lopsided the corpus', () => {
    const placed = placeSeeds(
      Array.from({ length: 30 }, (_, i) => seed(`s${i}`, 500, { record: 1 })),
    );
    for (const s of placed) {
      expect(s.x).toBeGreaterThan(18);
      expect(s.x).toBeLessThan(200);
      expect(s.y).toBeGreaterThan(14);
      expect(s.y).toBeLessThan(148);
    }
  });

  it('makes a bigger corpus a broader, taller hill', () => {
    const placed = placeSeeds([seed('big', 1000, { upload: 1 }), seed('small', 10, { drive: 1 })]);
    const big = placed.find((s) => s.id === 'big');
    const small = placed.find((s) => s.id === 'small');
    if (!big || !small) throw new Error('nothing placed');
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.sigma).toBeGreaterThan(small.sigma);
  });

  it('places an empty space rather than dropping it off the map', () => {
    const [nothing] = placeSeeds([seed('empty', 0, {})]);
    if (!nothing) throw new Error('nothing placed');
    expect(Number.isFinite(nothing.x)).toBe(true);
    expect(Number.isFinite(nothing.y)).toBe(true);
    expect(nothing.height).toBe(0);
  });

  it('draws tied documents nearer each other than untied ones', () => {
    const base: FieldSeed[] = [
      { id: 'a', label: 'a', weight: 100, mix: { upload: 1 } },
      { id: 'b', label: 'b', weight: 100, mix: { upload: 1 } },
    ];
    const apart = placeSeeds(base);
    const together = placeSeeds([
      { ...base[0], ties: ['b' as string] } as FieldSeed,
      { ...base[1], ties: ['a' as string] } as FieldSeed,
    ]);
    const gap = (p: ReturnType<typeof placeSeeds>) => {
      const [x, y] = p;
      if (!x || !y) throw new Error('nothing placed');
      return Math.hypot(x.x - y.x, x.y - y.y);
    };
    expect(gap(together)).toBeLessThan(gap(apart));
  });
});

describe('the relief itself', () => {
  it('is highest at a summit and falls away from it', () => {
    const placed = placeSeeds([seed('one', 100, { meeting: 1 })]);
    const s = placed[0];
    if (!s) throw new Error('nothing placed');
    const summit = elevationAt(s.x, s.y, placed);
    expect(summit).toBeGreaterThan(elevationAt(s.x + s.sigma, s.y, placed));
    expect(elevationAt(s.x + s.sigma, s.y, placed)).toBeGreaterThan(
      elevationAt(s.x + s.sigma * 3, s.y, placed),
    );
  });

  it('draws nothing on an empty corpus instead of a flat ring at zero', () => {
    expect(contourLines([])).toEqual([]);
    expect(contourLines(placeSeeds([seed('empty', 0, {})]))).toEqual([]);
  });

  it('draws rings around a hill, one path per level', () => {
    const contours = contourLines(placeSeeds([seed('one', 100, { upload: 1 })]));
    expect(contours.length).toBeGreaterThan(2);
    for (const c of contours) {
      expect(c.d.startsWith('M')).toBe(true);
      expect(c.d).toContain('L');
    }
  });

  it('stays cheap enough to recompute on every data change', () => {
    const many = placeSeeds(
      Array.from({ length: 60 }, (_, i) =>
        seed(`s${i}`, 50 + i * 11, i % 2 ? { record: 1 } : { upload: 1, drive: 0.4 }),
      ),
    );
    const started = performance.now();
    contourLines(many);
    // Generous on purpose: this is a regression guard against someone raising
    // the grid resolution until the page stutters, not a benchmark.
    expect(performance.now() - started).toBeLessThan(400);
  });

  it('names the hill you are standing on, and nothing when the land is flat', () => {
    const placed = placeSeeds([seed('big', 400, { upload: 1 }), seed('far', 400, { drive: 1 })]);
    const big = placed.find((s) => s.id === 'big');
    if (!big) throw new Error('nothing placed');
    expect(seedAt(big.x, big.y, placed)?.seed.id).toBe('big');
    expect(seedAt(-500, -500, placed)).toBeNull();
  });
});
