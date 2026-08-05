import type { BrainStats, DigestingDoc, IntakeKey } from '../_components/types';

/**
 * The arithmetic behind the instruments on the Brain Knowledge page.
 *
 * WHY IT IS HERE AND NOT IN THE COMPONENTS. Panning a graph, focusing the page
 * on one lobe and noticing that a document has just crossed into memory are all
 * pure functions of state. Kept inside the components they would only ever be
 * checked by looking at the screen; kept here they are ordinary functions with
 * ordinary tests, and the components are left holding nothing but the wiring.
 *
 * Nothing in this file may import `_lib/brain.ts` — that one reaches for
 * Supabase and `@cortex/agent-tools`, and this one is imported by client
 * components.
 */

/* ------------------------------------------------------------------- focus */

/**
 * The page read through one lobe of the plate.
 *
 * `chunks` comes back null on purpose: fragments are counted with a join on
 * spaces, not on sources, so there is no honest per-source figure to print and
 * the panel already knows to leave a null figure out rather than show a zero.
 * `intake` and `indexed` are left whole because the plate and the four mouths
 * are the control itself — they must keep drawing all four while one is chosen.
 */
export function focusStats(stats: BrainStats, source: IntakeKey | null): BrainStats {
  if (!source) return stats;
  const slice = stats.bySource[source];
  return {
    ...stats,
    stages: slice.stages,
    growth: slice.growth,
    spokenSeconds: slice.spokenSeconds,
    namedVoices: slice.namedVoices,
    unnamedRecordings: slice.unnamedRecordings,
    lastAddedAt: slice.lastAddedAt,
    digesting: slice.digesting,
    chunks: null,
  };
}

/* -------------------------------------------------------------------- live */

/**
 * Which documents finished while nobody reloaded.
 *
 * A document leaves the in-flight list for two reasons: it was indexed, or it
 * broke. Only the first is worth marking, so the count of things that crossed
 * into memory between the two readings caps how many of the departed are
 * claimed as arrivals — otherwise a failure would be announced as a success.
 */
export function arrivedInMemory(
  before: DigestingDoc[],
  after: DigestingDoc[],
  memoryDelta: number,
): DigestingDoc[] {
  if (memoryDelta <= 0) return [];
  const still = new Set(after.map((d) => d.id));
  return before.filter((d) => !still.has(d.id)).slice(0, memoryDelta);
}

/* ------------------------------------------------------------------- graph */

export interface Link {
  a: string;
  b: string;
}

/** Who is joined to whom, so a highlight is a lookup and not a scan. */
export function neighbourMap(...groups: Link[][]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    const bucket = map.get(from);
    if (bucket) bucket.add(to);
    else map.set(from, new Set([to]));
  };
  for (const group of groups) {
    for (const link of group) {
      add(link.a, link.b);
      add(link.b, link.a);
    }
  }
  return map;
}

/** A node and everything it touches: the set that stays lit. */
export function litSet(
  id: string | null,
  neighbours: Map<string, Set<string>>,
): Set<string> | null {
  if (!id) return null;
  const lit = new Set<string>([id]);
  for (const other of neighbours.get(id) ?? []) lit.add(other);
  return lit;
}

/* ----------------------------------------------------------------- viewBox */

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far in and out the graph may be pushed, as a multiple of "fits". */
export const MIN_SCALE = 0.85;
export const MAX_SCALE = 6;

/**
 * How far the drawing may be dragged past its own edge. A quarter of the plate
 * is enough to bring a node on the rim into the middle of a phone screen
 * without letting the graph be flicked off into empty space.
 */
const OVERSCROLL = 0.25;

export function fitView(size: number): ViewBox {
  return { x: 0, y: 0, w: size, h: size };
}

export function scaleOf(view: ViewBox, size: number): number {
  return size / view.w;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Keeps the window over the drawing rather than beside it. A window wider than
 * the drawing plus its margins is centred, because there is nothing left to
 * choose between.
 */
export function clampView(view: ViewBox, size: number): ViewBox {
  const margin = size * OVERSCROLL;
  const axis = (start: number, span: number): number => {
    if (span >= size + margin * 2) return (size - span) / 2;
    return clamp(start, -margin, size + margin - span);
  };
  return { ...view, x: axis(view.x, view.w), y: axis(view.y, view.h) };
}

/**
 * Zoom by `factor` about a point given in drawing units, so whatever is under
 * the pointer — or between two fingers — stays under it.
 */
export function zoomAt(
  view: ViewBox,
  size: number,
  factor: number,
  focusX: number,
  focusY: number,
): ViewBox {
  const w = clamp(view.w / factor, size / MAX_SCALE, size / MIN_SCALE);
  const k = w / view.w;
  return clampView(
    { x: focusX - (focusX - view.x) * k, y: focusY - (focusY - view.y) * k, w, h: w },
    size,
  );
}

/** The same window, moved by a distance already expressed in drawing units. */
export function panBy(view: ViewBox, dx: number, dy: number, size: number): ViewBox {
  return clampView({ ...view, x: view.x - dx, y: view.y - dy }, size);
}

/**
 * Put a point in the middle. Used when a document is opened from the ring: the
 * thing you just chose should not be left on the rim behind your thumb.
 */
export function centreOn(view: ViewBox, size: number, x: number, y: number): ViewBox {
  return clampView({ ...view, x: x - view.w / 2, y: y - view.h / 2 }, size);
}

/** Where a client point lands in drawing units, given the box on screen. */
export function toDrawing(
  view: ViewBox,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (rect.width === 0 || rect.height === 0) return { x: view.x, y: view.y };
  return {
    x: view.x + ((clientX - rect.left) / rect.width) * view.w,
    y: view.y + ((clientY - rect.top) / rect.height) * view.h,
  };
}

export function viewBoxAttr(view: ViewBox): string {
  return `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}`;
}

/** Distance between two fingers, which is all a pinch actually is. */
export function spread(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/* ------------------------------------------------------------------ search */

/** How many hits landed on each source, so the plate can say where they are. */
export function countBySource(hits: Array<{ source: IntakeKey }>): Record<IntakeKey, number> {
  const out: Record<IntakeKey, number> = { upload: 0, record: 0, meeting: 0, drive: 0 };
  for (const hit of hits) out[hit.source] += 1;
  return out;
}
