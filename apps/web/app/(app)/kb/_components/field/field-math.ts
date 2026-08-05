import type { IntakeKey } from '../types';

/**
 * The brain, drawn as a relief map of its own memory.
 *
 * THE IDEA. Elevation is fragments. Every space (and, one level down, every
 * document) raises a hill inside the cortex whose height is how many retrievable
 * fragments it holds and whose position is what it is made of — a space of call
 * recordings sits over the temporal lobe, where hearing is; a space of filed
 * documents sits over the frontal. Contour lines are then not decoration: a
 * tight nest of rings is a subject this company has written about at length, and
 * a flat plain is a subject it has one page on. "What does it know a lot about"
 * stops being a number in a table and becomes the shape of the drawing.
 *
 * WHY A RELIEF AND NOT THE OBVIOUS THINGS. A force-directed cloud of dots is
 * what every graph library produces, it moves for reasons nobody can explain,
 * and with sixty documents it is a hairball. A treemap is honest about area and
 * says nothing about what is near what. A relief map is read the way every
 * person who has ever seen a map reads one, it survives being small, and it
 * degrades gracefully: with two spaces it is two hills, with forty it is a
 * range, and neither looks broken.
 *
 * EVERYTHING HERE IS PURE. No React, no DOM, no randomness that is not seeded
 * from an id — so the same corpus always draws the same map, which matters
 * because people navigate by remembering where things were. It is also why this
 * is a separate module: the contouring is the only expensive thing on the page
 * and it is the only thing worth unit-testing.
 */

/* ------------------------------------------------------------------ anatomy */

/**
 * The cerebrum outline, in the same 230×180 coordinate space the anatomical
 * plate has always used. It is the union of the four lobe paths that were there
 * before — same curve, same numbers — so the redesign is this drawing growing
 * up rather than a different drawing.
 */
export const CORTEX_PATH =
  'M 22 82 C 22 64 30 48 46 40 C 58 30 72 24 88 23 C 104 21 120 23 134 28 C 141 30 146 31 150 33 C 166 42 182 60 195 86 C 196 96 192 104 185 109 C 178 113 170 114 162 112 C 160 124 150 134 134 138 C 116 142 96 138 82 128 C 72 121 64 112 56 108 C 50 104 45 100 40 96 C 33 93 26 88 22 82 Z';

/** Cerebellum and brainstem. Outline only — they hold no data and never fill. */
export const STEM_PATHS = [
  'M 166 113 C 186 114 202 125 199 139 C 196 151 178 156 163 149 C 155 145 151 136 153 127',
  'M 160 122 C 174 122 187 126 196 133',
  'M 158 133 C 170 133 182 137 191 143',
  'M 150 116 C 152 130 150 145 144 156',
  'M 163 150 C 163 158 160 164 156 168',
];

/** Engraved gyri. They carry no data — they are what makes it a drawing. */
export const SULCI = [
  'M 32 74 C 42 66 54 60 66 57',
  'M 34 86 C 44 80 56 75 70 72',
  'M 92 40 C 106 34 122 33 136 37',
  'M 90 60 C 106 53 124 51 140 55',
  'M 88 82 C 104 76 122 74 138 78',
  'M 156 50 C 166 56 175 65 182 76',
  'M 152 74 C 162 79 171 86 178 94',
  'M 50 104 C 70 112 94 118 120 118',
  'M 62 120 C 80 128 100 132 122 131',
];

export const VIEWBOX = { width: 230, height: 180 } as const;

/**
 * Where each kind of material lands on the cortex.
 *
 * These are the centres of the four lobes the plate has always numbered, and
 * the assignment is the one the old drawing made for the same reason: hearing
 * lives in the temporal lobe, so recordings and meetings sit low and back. A
 * map that put audio in the frontal lobe would be a drawing that lies about
 * itself, and every person who has seen a diagram of a brain would feel it
 * without being able to say why.
 */
export const LOBE_ANCHOR: Record<IntakeKey, { x: number; y: number }> = {
  upload: { x: 55, y: 68 },
  meeting: { x: 114, y: 56 },
  drive: { x: 168, y: 76 },
  record: { x: 104, y: 116 },
};

export const LOBE_NAME: Record<IntakeKey, string> = {
  upload: 'Documentos',
  meeting: 'Reuniones',
  drive: 'Google Drive',
  record: 'Grabaciones',
};

/**
 * An ellipse inscribed in the cortex outline, used to keep hills from wandering
 * off the drawing. Deliberately approximate: the contours are clipped to the
 * real path by the browser, so this only has to stop a LABEL from ending up in
 * the margin, and an ellipse costs one multiplication where a point-in-bezier
 * test costs a subdivision routine nobody would ever read again.
 */
const KEEP = { cx: 108, cy: 80, rx: 80, ry: 52 };

/* -------------------------------------------------------------------- seeds */

export interface FieldSeed {
  id: string;
  label: string;
  /** What raises the hill: retrievable fragments, or documents when unknown. */
  weight: number;
  /** How this thing is made, across the four intakes. Need not sum to one. */
  mix: Partial<Record<IntakeKey, number>>;
  /** Ids of seeds this one is semantically tied to; they pull together. */
  ties?: string[];
  /** Anything the caller wants to find again on the placed seed. */
  meta?: Record<string, unknown>;
}

export interface PlacedSeed extends FieldSeed {
  x: number;
  y: number;
  /** Spread of the hill, in drawing units. Bigger corpus, broader hill. */
  sigma: number;
  /** Height, 0–1, relative to the tallest hill on this map. */
  height: number;
}

/** A stable small number in [0,1) from an id, so the map never reshuffles. */
function hashUnit(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function clampToCortex(x: number, y: number): { x: number; y: number } {
  const dx = (x - KEEP.cx) / KEEP.rx;
  const dy = (y - KEEP.cy) / KEEP.ry;
  const d = Math.hypot(dx, dy);
  if (d <= 1) return { x, y };
  return { x: KEEP.cx + (dx / d) * KEEP.rx, y: KEEP.cy + (dy / d) * KEEP.ry };
}

/**
 * Put every hill somewhere, then let them push each other apart.
 *
 * Position starts as a fact — the weighted centre of the lobes this thing is
 * made of — and is then relaxed, because two spaces that hold the same kind of
 * material would otherwise land on exactly the same pixel and read as one hill.
 * The relaxation is a fixed twelve passes over at most a few dozen seeds: it is
 * bounded, it is deterministic, and it runs once per data change rather than
 * per frame. Nothing here animates. A map that settles while you look at it is
 * a map you cannot point at.
 */
export function placeSeeds(seeds: FieldSeed[], opts: { passes?: number } = {}): PlacedSeed[] {
  if (seeds.length === 0) return [];
  const passes = opts.passes ?? 12;
  const peak = Math.max(...seeds.map((s) => Math.max(0, s.weight)), 1);

  const placed: PlacedSeed[] = seeds.map((seed) => {
    let wx = 0;
    let wy = 0;
    let total = 0;
    for (const key of Object.keys(LOBE_ANCHOR) as IntakeKey[]) {
      const share = Math.max(0, seed.mix[key] ?? 0);
      if (share === 0) continue;
      wx += LOBE_ANCHOR[key].x * share;
      wy += LOBE_ANCHOR[key].y * share;
      total += share;
    }
    // Nothing to place it by — a space with no documents yet — so it sits in
    // the middle rather than at the origin, where it would be off the drawing.
    const base = total > 0 ? { x: wx / total, y: wy / total } : { x: KEEP.cx, y: KEEP.cy };
    // Enough scatter to separate two identical mixes, small enough that the
    // lobe it sits over is never in doubt.
    const angle = hashUnit(seed.id, 1) * Math.PI * 2;
    const spread = 8 + hashUnit(seed.id, 2) * 16;
    const share = Math.max(0, seed.weight) / peak;
    const here = clampToCortex(
      base.x + Math.cos(angle) * spread,
      base.y + Math.sin(angle) * spread,
    );
    return {
      ...seed,
      x: here.x,
      y: here.y,
      // Square root, not linear: a space with a hundred times the fragments is
      // ten times as wide, not a hundred, or one corpus swallows the drawing.
      sigma: 11 + 27 * Math.sqrt(share),
      height: share,
    };
  });

  const tieIndex = new Map(placed.map((p, i) => [p.id, i] as const));

  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 0; i < placed.length; i += 1) {
      const a = placed[i] as PlacedSeed;
      let px = 0;
      let py = 0;

      for (let j = 0; j < placed.length; j += 1) {
        if (i === j) continue;
        const b = placed[j] as PlacedSeed;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 0.001;
        // Hills may overlap — a range is meant to look like a range — but their
        // summits must stay far enough apart to be separately clickable.
        const want = (a.sigma + b.sigma) * 0.42;
        if (d < want) {
          const push = (want - d) / want;
          px += (dx / d) * push * 6;
          py += (dy / d) * push * 6;
        }
      }

      // Ties are the semantic graph: two documents about the same subject are
      // drawn near each other, which is the one thing a relief map cannot say
      // on its own and the whole reason the graph is worth carrying up here.
      for (const tie of a.ties ?? []) {
        const j = tieIndex.get(tie);
        if (j === undefined || j === i) continue;
        const b = placed[j] as PlacedSeed;
        px += (b.x - a.x) * 0.06;
        py += (b.y - a.y) * 0.06;
      }

      const next = clampToCortex(a.x + px, a.y + py);
      a.x = next.x;
      a.y = next.y;
    }
  }

  return placed;
}

/* ----------------------------------------------------------------- contours */

/** How high the land is at a point: every hill, added up. */
export function elevationAt(x: number, y: number, seeds: PlacedSeed[]): number {
  let sum = 0;
  for (const s of seeds) {
    if (s.height <= 0) continue;
    const dx = x - s.x;
    const dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    const twoSigma2 = 2 * s.sigma * s.sigma;
    // Past three sigma the term is under 1% of the peak and cannot move a
    // contour; skipping it turns the inner loop from O(cells × seeds) into
    // something much closer to O(cells) once there are more than a handful.
    if (d2 > twoSigma2 * 4.5) continue;
    sum += s.height * Math.exp(-d2 / twoSigma2);
  }
  return sum;
}

export interface Contour {
  /** 0–1, share of the highest point on this map. */
  level: number;
  /** One path holding every segment at this level, as disjoint `M…L…` moves. */
  d: string;
}

/**
 * Marching squares, emitted as one path per level.
 *
 * WHY ONE PATH PER LEVEL AND NOT ONE PER LINE. Six levels over a 78×56 grid
 * produce a few thousand segments. As individual elements that is a few thousand
 * DOM nodes, which is where an interface like this stops being smooth on a
 * laptop; concatenated into six `d` strings it is six nodes and the browser
 * rasterises them in one pass. The contours are not closed loops as a result —
 * they are dashes at grid resolution — but at this grid size the eye joins them,
 * and the alternative costs the frame rate the whole design depends on.
 *
 * Saddles are resolved arbitrarily and consistently. At this resolution the two
 * readings differ by one cell, and no decision anybody makes on this screen
 * turns on it.
 */
const CASES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [], // 0
  [[3, 2]],
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  [
    [3, 0],
    [2, 1],
  ], // saddle
  [[0, 2]],
  [[3, 0]],
  [[3, 0]],
  [[0, 2]],
  [
    [0, 1],
    [3, 2],
  ], // saddle
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 2]],
  [], // 15
];

export interface ContourOptions {
  /** Grid columns. Higher is smoother and slower; 78 is the tuned default. */
  cols?: number;
  rows?: number;
  /** Where to draw rings, as shares of the tallest point. */
  levels?: number[];
}

const DEFAULT_LEVELS = [0.08, 0.16, 0.28, 0.42, 0.58, 0.76, 0.92];

export function contourLines(seeds: PlacedSeed[], opts: ContourOptions = {}): Contour[] {
  if (seeds.length === 0) return [];
  const cols = opts.cols ?? 78;
  const rows = opts.rows ?? 56;
  const levels = opts.levels ?? DEFAULT_LEVELS;

  const x0 = 14;
  const y0 = 12;
  const x1 = 204;
  const y1 = 150;
  const dx = (x1 - x0) / cols;
  const dy = (y1 - y0) / rows;

  // Sample once, contour many times. Recomputing the field per level is the
  // obvious shape and it is seven times the work for the same picture.
  const grid = new Float32Array((cols + 1) * (rows + 1));
  let max = 0;
  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= cols; c += 1) {
      const v = elevationAt(x0 + c * dx, y0 + r * dy, seeds);
      grid[r * (cols + 1) + c] = v;
      if (v > max) max = v;
    }
  }
  if (max <= 0) return [];

  const out: Contour[] = [];
  for (const share of levels) {
    const level = share * max;
    const parts: string[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const tl = grid[r * (cols + 1) + c] as number;
        const tr = grid[r * (cols + 1) + c + 1] as number;
        const br = grid[(r + 1) * (cols + 1) + c + 1] as number;
        const bl = grid[(r + 1) * (cols + 1) + c] as number;
        const index =
          (tl >= level ? 8 : 0) |
          (tr >= level ? 4 : 0) |
          (br >= level ? 2 : 0) |
          (bl >= level ? 1 : 0);
        const pairs = CASES[index];
        if (!pairs || pairs.length === 0) continue;

        const cx = x0 + c * dx;
        const cy = y0 + r * dy;
        const lerp = (a: number, b: number) => {
          const span = b - a;
          return span === 0 ? 0.5 : Math.max(0, Math.min(1, (level - a) / span));
        };
        // 0 top, 1 right, 2 bottom, 3 left.
        const edge = (which: number): [number, number] => {
          switch (which) {
            case 0:
              return [cx + lerp(tl, tr) * dx, cy];
            case 1:
              return [cx + dx, cy + lerp(tr, br) * dy];
            case 2:
              return [cx + lerp(bl, br) * dx, cy + dy];
            default:
              return [cx, cy + lerp(tl, bl) * dy];
          }
        };

        for (const [from, to] of pairs) {
          const a = edge(from);
          const b = edge(to);
          parts.push(
            `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`,
          );
        }
      }
    }
    if (parts.length > 0) out.push({ level: share, d: parts.join('') });
  }
  return out;
}

/**
 * The hill nearest a point, and how high the land is there.
 *
 * This is what the lens reads. It answers "what am I standing on" rather than
 * "what is closest in pixels": a large hill dominates a point well outside a
 * small neighbour's summit, and pointing at the slope of the big one should
 * name the big one.
 */
export function seedAt(
  x: number,
  y: number,
  seeds: PlacedSeed[],
): { seed: PlacedSeed; share: number } | null {
  let best: PlacedSeed | null = null;
  let bestValue = 0;
  for (const s of seeds) {
    const dx = x - s.x;
    const dy = y - s.y;
    const value = s.height * Math.exp(-(dx * dx + dy * dy) / (2 * s.sigma * s.sigma));
    if (value > bestValue) {
      bestValue = value;
      best = s;
    }
  }
  // Below this the land is flat and naming a hill would be inventing one.
  if (!best || bestValue < 0.03) return null;
  return { seed: best, share: bestValue };
}
