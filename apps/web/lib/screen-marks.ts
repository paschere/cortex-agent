/**
 * Pointing at something on the frame: from what the model says to what is drawn.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF screen-glance.ts
 * ===========================================================================
 * screen-glance.ts is the frame's journey INTO a turn, and it is server work:
 * it imports zod and the AI SDK's message shape. This is the journey back OUT,
 * and every line of it runs in the browser, inside a component, on a value that
 * came off the data stream. So it has no dependencies at all — not zod, not
 * `ai`, not React — which is what lets the composer, the transcript and the
 * route all call the same three functions, and what lets them be tested with
 * plain numbers.
 *
 * The reason they must be the same functions on both sides is the second half
 * of this file's job: NOTHING HERE TRUSTS THE MODEL. A rectangle is validated
 * where it is produced (the tool's execute) and again where it is painted (the
 * card), because between those two points it is serialised into a stream, put
 * in a database row on some turns, and read back a week later by a client that
 * has no idea which version of the prompt produced it.
 */

/**
 * One rectangle over the frame, with the sentence that goes beside it.
 *
 * ===========================================================================
 * NORMALISED, NEVER PIXELS — AND THIS IS NOT A STYLE PREFERENCE
 * ===========================================================================
 * The picture is resized twice between the monitor and the mark. `frameSizeOf`
 * in tab-recorder.ts scales the tab down to a 1280px long edge before it is
 * sent, and the transcript then draws whatever arrives at the width of the chat
 * column — which changes when the window is resized, when the sidebar opens, and
 * is different again on a phone. A pixel measured on any one of those three
 * surfaces means nothing on the other two: an absolute `left: 812px` points at
 * the right button on the machine that produced it and at empty space
 * everywhere else, INCLUDING on the same machine one window-drag later.
 *
 * A fraction of the width survives all of it, because every one of those
 * resizes preserves the aspect ratio and therefore preserves fractions. Which
 * is also why `markRect` below takes the size to scale INTO as an argument
 * rather than assuming one: the card passes 100×100 and gets percentages, so
 * the browser rescales the marks with the image for free and no JavaScript ever
 * measures anything.
 *
 * Corners rather than origin-plus-size because that is the shape a model
 * actually emits when it is asked where something is, and because two corners
 * can be given in the wrong order — which is a mistake that can be CORRECTED
 * (see `normalizeMarks`), while a negative width can only be thrown away.
 */
export interface ScreenMark {
  /** Left edge, as a fraction of the frame's width. 0 is the left border. */
  x1: number;
  /** Top edge, as a fraction of the frame's height. 0 is the top border. */
  y1: number;
  /** Right edge, as a fraction of the frame's width. 1 is the right border. */
  x2: number;
  /** Bottom edge, as a fraction of the frame's height. 1 is the bottom border. */
  y2: number;
  /** What is inside it, in the person's own language. Read aloud by a reader. */
  label: string;
}

/**
 * How many rectangles one answer may draw.
 *
 * Four is not a technical limit, it is the point past which pointing stops
 * being pointing. "¿Dónde le doy?" has one answer; a sequence of steps has
 * three or four; anything beyond that is a diagram of the whole screen, which
 * is a worse way of saying what the sentence underneath already says better.
 */
export const MAX_MARKS = 4;

/**
 * The smallest rectangle worth drawing, as a fraction of the frame.
 *
 * 0,4 % of the long edge is about five pixels on a 1280px frame — smaller than
 * the border of the box that would be drawn around it. Below this the mark is
 * not pointing at anything a person can see, and it is nearly always the
 * signature of a coordinate that got clamped: a box that was entirely off the
 * right edge collapses onto x = 1 and arrives here with no width at all.
 */
const MIN_SIDE = 0.004;

/** Labels longer than this are a paragraph, and a paragraph is not a label. */
const MAX_LABEL = 120;

function fraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Clamped, not rejected. A model that says 1.02 saw the edge of the screen
  // and rounded outwards; the honest reading of that is "the border", and
  // refusing it would throw away a correct answer over a rounding error.
  return Math.min(1, Math.max(0, value));
}

function normalizeMark(raw: unknown): ScreenMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const label = typeof o.label === 'string' ? o.label.trim().slice(0, MAX_LABEL) : '';
  // A box with no words is a box a screen reader cannot announce and a person
  // cannot act on. The whole promise of this feature is the rectangle AND the
  // sentence, so half of it is not a partial success.
  if (!label) return null;

  const x1 = fraction(o.x1);
  const y1 = fraction(o.y1);
  const x2 = fraction(o.x2);
  const y2 = fraction(o.y2);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

  // Corners in the wrong order are repaired rather than discarded: the model
  // named two opposite corners of a real rectangle and got their order wrong,
  // which is a different mistake from pointing at the wrong place.
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);

  // What survives clamping has to still be a rectangle. A mark that was
  // entirely outside the picture is now a line on its border, and drawing a
  // line on the border of a screenshot is worse than drawing nothing: it points
  // confidently at the frame's edge, which is somewhere the person will look.
  if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) return null;

  return { x1: left, y1: top, x2: right, y2: bottom, label };
}

/**
 * Everything the model claimed, turned into what can safely be drawn.
 *
 * Takes `unknown` on purpose. On the server it is handed a value zod has
 * already shaped; in the transcript it is handed `toolInvocation.result`, which
 * is whatever came back over the data stream — or, for a conversation reopened
 * next week, whatever was written into `messages.tool_results` by a build that
 * no longer exists. Both callers get the same guarantee out of it, and neither
 * has to know which one it is.
 */
export function normalizeMarks(raw: unknown): ScreenMark[] {
  if (!Array.isArray(raw)) return [];
  const marks: ScreenMark[] = [];
  for (const item of raw) {
    if (marks.length >= MAX_MARKS) break;
    const mark = normalizeMark(item);
    if (mark) marks.push(mark);
  }
  return marks;
}

/**
 * A rectangle in whatever units the thing drawing it uses.
 *
 * `size` is the box the frame is being drawn into. The card passes
 * `{ width: 100, height: 100 }` and gets percentages, which CSS then keeps
 * correct through every resize without measuring anything; a test passes
 * 1280×720 and gets the pixels that would have been on the person's monitor.
 * Same arithmetic, and that is the point — the number that gets painted is the
 * number that gets asserted.
 */
export function markRect(
  mark: ScreenMark,
  size: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: mark.x1 * size.width,
    top: mark.y1 * size.height,
    width: (mark.x2 - mark.x1) * size.width,
    height: (mark.y2 - mark.y1) * size.height,
  };
}

/**
 * One frame, held in the browser's memory for exactly as long as it can be
 * useful — which is never longer than this tab stays open.
 *
 * ===========================================================================
 * THE PICTURE IS NOT STORED, SO THE ANNOTATION CANNOT BE EITHER
 * ===========================================================================
 * Migration 0092 keeps a timestamp and a token count and nothing else: no
 * bytes, no URL, no cache key. That decision is what the capture contract
 * promises, and drawing a rectangle on a screenshot is not a good enough reason
 * to start keeping screenshots. So the only copy of the frame that can be
 * annotated is the one already in this page's memory, and it lives in React
 * state in ChatRoot for the life of the tab.
 *
 * Reloading therefore loses the picture while KEEPING the marks — they are on
 * the assistant's message row, in `tool_results`. That asymmetry is not a bug
 * to hide; it is the storage decision showing through, and the card says so in
 * words rather than drawing rectangles over a blank space.
 */
export interface ScreenFrame {
  /** A `data:` URL. Never leaves this tab, never reaches the server twice. */
  src: string;
  width: number;
  height: number;
}

/**
 * How many frames a session keeps at once.
 *
 * A 1280×720 JPEG at quality 0.85 is 250–400 KB of base64, so this is roughly
 * one megabyte held for an afternoon of asking. Keeping every frame of a long
 * session would be tens of megabytes of screenshots in a tab that people leave
 * open all day — which is both a memory leak and, quietly, a bigger pile of
 * somebody's screen than this feature ever promised to hold.
 *
 * Three is the number of screen questions somebody scrolls back through. Beyond
 * that the card falls back to the same honest note a reload produces, which is
 * a behaviour that already has to exist and already reads correctly.
 */
export const KEPT_FRAMES = 3;

/**
 * Add a frame to the ones being held, and let the oldest go.
 *
 * Insertion order is the eviction order, which works because the keys are
 * message UUIDs: JavaScript orders integer-like keys numerically and everything
 * else by insertion, and a UUID is never integer-like. Re-adding an id deletes
 * it first so it moves to the end rather than keeping the position it had.
 */
export function rememberFrame(
  kept: Readonly<Record<string, ScreenFrame>>,
  id: string,
  frame: ScreenFrame,
  limit: number = KEPT_FRAMES,
): Record<string, ScreenFrame> {
  const next: Record<string, ScreenFrame> = { ...kept };
  delete next[id];
  next[id] = frame;
  const ids = Object.keys(next);
  for (const stale of ids.slice(0, Math.max(0, ids.length - Math.max(1, limit)))) {
    delete next[stale];
  }
  return next;
}
