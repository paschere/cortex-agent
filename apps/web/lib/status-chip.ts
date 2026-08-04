/**
 * The one shape a status wears across the operational screens.
 *
 * A status is a mark applied to a document, so it is drawn like one: squared,
 * ruled, monospaced, upper case. Every screen that shows run state — routines,
 * the orchestrator, dev work, pipelines, prospects — imports from here so the
 * same word never appears in two different costumes.
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
  'inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-[1.4] tracking-[0.08em]';

export const CHIP_TONE: Record<StatusTone, string> = {
  neutral: 'border-border-strong bg-surface-2 text-ink-muted',
  primary: 'border-primary/40 bg-primary-soft text-primary',
  emerald: 'border-emerald/40 bg-emerald-soft text-emerald',
  amber: 'border-amber/40 bg-amber-soft text-amber',
  rose: 'border-rose/40 bg-rose-soft text-rose',
};

/** Full class string for a status chip of the given tone. */
export function chipClass(tone: StatusTone): string {
  return `${CHIP_BASE} ${CHIP_TONE[tone]}`;
}

/** The dot that goes inside a chip or beside a label. Round on purpose. */
export const DOT_TONE: Record<StatusTone, string> = {
  neutral: 'bg-ink-faint',
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  rose: 'bg-rose',
};
