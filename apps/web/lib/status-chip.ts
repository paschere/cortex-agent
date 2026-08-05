/**
 * The one shape a status wears across the operational screens.
 *
 * A status is a short label, not a mark stamped on paperwork, so it is drawn
 * like one: a soft capsule, sentence case, in the UI face. Every screen that
 * shows run state — routines, the orchestrator, dev work, pipelines, prospects
 * — imports from here so the same word never appears in two different costumes.
 *
 * Tone is meaning, never decoration:
 *   neutral  nothing is asserted yet (waiting, skipped, archived, a plain count)
 *   primary  the system itself is working or asserting
 *   emerald  in force / finished well
 *   amber    a person has to look at this
 *   rose     failed, blocked, refused
 */

export type StatusTone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export const CHIP_BASE =
  'inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-[3px] text-[11px] font-semibold leading-[1.45]';

export const CHIP_TONE: Record<StatusTone, string> = {
  neutral: 'border-border bg-surface-2 text-ink-muted',
  primary: 'border-primary/15 bg-primary-soft text-primary-ink',
  emerald: 'border-emerald/20 bg-emerald-soft text-emerald',
  amber: 'border-amber/20 bg-amber-soft text-amber',
  rose: 'border-rose/20 bg-rose-soft text-rose',
};

/** Full class string for a status chip of the given tone. */
export function chipClass(tone: StatusTone): string {
  return `${CHIP_BASE} ${CHIP_TONE[tone]}`;
}

/**
 * A chip that is also a control — a filter pill, a segmented choice. Same
 * capsule, plus the hover and press response a clickable thing owes the cursor.
 */
export const CHIP_INTERACTIVE =
  'transition-all duration-150 hover:-translate-y-px active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none';

/** The dot that goes inside a chip or beside a label. Round on purpose. */
export const DOT_TONE: Record<StatusTone, string> = {
  neutral: 'bg-ink-faint',
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  rose: 'bg-rose',
};
