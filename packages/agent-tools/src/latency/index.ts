/**
 * How long a turn took, measured where it happened.
 *
 * Deliberately a small module beside `turn-context`, not inside it. That one
 * records WHAT the model was handed and is kept for forensics on a single bad
 * answer; this one records HOW LONG the handing took and is a numeric series
 * read in aggregate. They share a turn and nothing else: different questions,
 * different retention pressure (quoted corpus versus plain integers), different
 * readers.
 *
 * What they do share is the rule that makes either of them safe to run on every
 * turn — accumulate in memory, write once after the answer is already on the
 * screen. See `clock.ts`.
 *
 * WHAT WAS ALREADY THERE AND IS NOT DUPLICATED HERE. `audit_events` records
 * every tool call with its own `latency_ms`, so the per-tool breakdown is
 * already answerable and this module only counts and sums. `turn_contexts`
 * records the prompt's composition and the provider's token counts. Neither
 * knew when the first character reached the person, which is the number that
 * decides how the product feels, and that is the gap this fills.
 */

export * from './types';
export { LATENCY_KEEP_DAYS, REPORTED_PERCENTILES, DEFAULT_SAMPLE_LIMIT } from './policy';
export { TurnClock } from './clock';
export type { TurnClockInit } from './clock';
export {
  percentile,
  summarize,
  cacheBehaviour,
  stageDistributions,
  loadTurnLatencies,
  report,
} from './read';
export type { Distribution, CacheBehaviour, LatencyReport, LoadLatencyOptions } from './read';
