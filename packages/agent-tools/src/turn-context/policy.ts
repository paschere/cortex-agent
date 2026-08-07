/**
 * How much of a turn is kept, in what detail, and for how long.
 *
 * THE TRADE THIS FILE IS. Capturing the real context costs storage on every
 * turn forever, and the two easy answers are both wrong: keeping the whole
 * prompt of every turn indefinitely is not affordable, and keeping nothing is
 * the state that made this surface necessary. So the cost is spent where the
 * question gets asked and withdrawn where it does not.
 *
 * WHEN THE QUESTION IS ACTUALLY ASKED. "Why did it answer that?" is asked about
 * a turn somebody remembers — this morning, yesterday, the demo last Tuesday.
 * Nobody opens a turn from March. But the SHAPE of the turn keeps its value far
 * longer than its content: "retrieval has been eating 70% of the context on
 * this agent for a month" is a question about numbers, not about text, and the
 * numbers cost a twentieth of what the text costs.
 *
 * So a row lives two lives:
 *
 *   FULL (14 days)      Everything: fragment excerpts, the retrieval summary
 *                       the model was handed, memory text. This is the window
 *                       where a turn gets debugged.
 *
 *   SKELETON (90 days)  Scores, verdicts, document titles, tool ranking, the
 *                       weight of each part. Every number, no quoted material.
 *                       Redaction is a real UPDATE that nulls the text columns,
 *                       not a filter at read time — the material is gone from
 *                       the row, which is the only version of "we stopped
 *                       keeping it" worth claiming.
 *
 *   Then the row is deleted.
 *
 * REDACTION IS ALSO THE PRIVACY ANSWER. What is captured is material from the
 * brain, some of it out of somebody's personal space. A fourteen-day life for
 * quoted text means a stray fragment cannot sit in a diagnostics table for a
 * year; the numbers that outlive it name a document, never quote one.
 *
 * WHY THE DATES ARE ON THE ROW. Each row states its own two deadlines at
 * insert. The purge is then a dumb sweep of `now()` against a column, the
 * policy lives here in one place, and a row written under an older policy ages
 * out under the policy it was written with rather than being retroactively
 * re-dated by an edit to this file.
 */

const DAY_MS = 86_400_000;

/** How long quoted material — fragment text, memory text, the summary — lives. */
export const DETAIL_DAYS = 14;

/** How long the numbers live after the text is gone. */
export const SKELETON_DAYS = 90;

/**
 * How much of a fragment is kept.
 *
 * Enough to recognise the passage and see where it was cut, not enough to be a
 * second copy of the corpus. The whole fragment is in `kb_chunks` and reachable
 * by `chunkId` — but only until somebody re-indexes the document, which is why
 * an excerpt is stored at all rather than just the id: what is on screen has to
 * be what was sent that day, not what that chunk happens to say now.
 */
export const EXCERPT_CHARS = 480;

/** Memories are short by construction (0051 caps them); this is a backstop. */
export const MEMORY_CHARS = 400;

/**
 * A ceiling on how many fragments are written down per turn, near-misses
 * included. Retrieval is asked for a handful and the losers are what make the
 * row worth reading, but an unbounded list would let one pathological turn
 * dominate the table.
 */
export const MAX_FRAGMENTS = 12;

/** Same idea for the tool list: enough to see the shape of a wide catalogue. */
export const MAX_OFFERED_TOOLS = 80;

export interface RetentionDates {
  /** After this, the text columns are nulled. */
  detailUntil: string;
  /** After this, the row is deleted. */
  purgeAt: string;
}

export function retentionFrom(now: Date = new Date()): RetentionDates {
  return {
    detailUntil: new Date(now.getTime() + DETAIL_DAYS * DAY_MS).toISOString(),
    purgeAt: new Date(now.getTime() + SKELETON_DAYS * DAY_MS).toISOString(),
  };
}

/** Cut a captured string to its stored length, marking that it was cut. */
export function excerpt(text: string, max: number = EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}
