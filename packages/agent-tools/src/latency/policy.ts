/**
 * How long a measurement is kept.
 *
 * A latency row is nothing but numbers — no quoted material, no corpus, no
 * personal text — so it has none of the privacy pressure that gives
 * `turn_contexts` its fourteen-day detail window. What it has instead is a
 * volume problem: one row per turn, forever, to answer a question that is
 * always about the recent past ("is it slower than it was last month?").
 *
 * Ninety days is one quarter, which is the shortest window in which a
 * regression that arrived slowly is still visible, and it deliberately matches
 * the skeleton window of `turn_contexts` so a turn's shape and a turn's timing
 * disappear together rather than leaving half a record behind.
 */
export const LATENCY_KEEP_DAYS = 90;

/**
 * The percentiles worth reporting, and the deliberate absence of a mean.
 *
 * An average latency is the single most misleading number in this whole
 * subject. What ruins the experience is the turn that took nineteen seconds,
 * and a mean is exactly the statistic that hides it behind ninety fast turns.
 * So this module reports the median for a sense of the normal case and then
 * moves straight to the tail, which is where the product is actually judged.
 */
export const REPORTED_PERCENTILES = [50, 90, 95, 99] as const;

/** How many turns a summary looks at unless the caller says otherwise. */
export const DEFAULT_SAMPLE_LIMIT = 500;
