import { CHIP_BASE, CHIP_TONE, DOT_TONE, type StatusTone } from '@/lib/status-chip';
import type { ErrandState } from '@/lib/errands/types';
import { clsx } from 'clsx';

/**
 * The one place an errand's state turns into colour and words.
 *
 * Imported by both the server list and the client detail view, so it holds no
 * hooks and no server-only imports.
 *
 * The tones follow the design system's rule that colour carries meaning, and
 * the two interesting choices are:
 *
 *   `blocked` is AMBER, not rose. Nothing is broken and nothing is lost — the
 *   errand is doing the right thing, and a person has to look. Rose here would
 *   train people to read a question as a failure, which is exactly backwards:
 *   asking is the behaviour this feature was built to produce.
 *
 *   `exhausted` is NEUTRAL, not rose. The errand spent what it was allowed to
 *   spend and stopped. That is the ceiling working, and painting it red would
 *   push people to raise ceilings they should be lowering.
 */
export const ERRAND_TONE: Record<ErrandState, { label: string; tone: StatusTone }> = {
  queued: { label: 'En cola', tone: 'neutral' },
  working: { label: 'Trabajando', tone: 'primary' },
  blocked: { label: 'Te pregunta algo', tone: 'amber' },
  watching: { label: 'Vigilando', tone: 'primary' },
  delivered: { label: 'Entregado', tone: 'emerald' },
  failed: { label: 'No pudo', tone: 'rose' },
  cancelled: { label: 'Detenido', tone: 'neutral' },
  exhausted: { label: 'Llegó a su tope', tone: 'neutral' },
};

export function ErrandStatusPill({
  state,
  className,
}: { state: ErrandState; className?: string }) {
  const { label, tone } = ERRAND_TONE[state];
  const live = state === 'working' || state === 'queued';
  return (
    <span className={clsx(CHIP_BASE, CHIP_TONE[tone], className)}>
      <span className="relative flex h-1.5 w-1.5">
        {live && (
          <span
            className={clsx(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none',
              DOT_TONE[tone],
            )}
          />
        )}
        <span className={clsx('relative inline-flex h-1.5 w-1.5 rounded-full', DOT_TONE[tone])} />
      </span>
      {label}
    </span>
  );
}

/** "hace 12m" / "hace 3d" — for a list read minutes or days after the fact. */
export function relativeWhen(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `hace ${days}d` : new Date(iso).toLocaleDateString('es-CO');
}

/** Compact absolute stamp for a provenance mark: "04 ago 10:18". */
export function stamp(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
