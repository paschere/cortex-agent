import type { FlowSummary } from '@/lib/browser-shape';

/**
 * How a trámite reads at a glance, and in what order the list puts them.
 *
 * `status` alone is not the question a person arrives with. The question is
 * "which of these can I trust to run without me", and the answer needs the last
 * run as well as the proof: a trámite that was proven in July and has been
 * failing since Tuesday is `ready` in the database and is the single most
 * urgent row on the screen.
 *
 * A `draft` that failed is NOT trouble. It has never worked; a failure is what
 * a hypothesis is expected to do, and colouring it like a regression would
 * spend the alarm on the one row that never promised anything.
 */
export type Health = 'proven' | 'proposed' | 'trouble';

export function health(flow: FlowSummary): Health {
  if (flow.status === 'broken') return 'trouble';
  if (flow.status === 'draft') return 'proposed';
  return flow.lastRunStatus === 'failed' ? 'trouble' : 'proven';
}

const ORDER: Record<Health, number> = { trouble: 0, proposed: 1, proven: 2 };

/**
 * Trouble first, then the hypotheses waiting on somebody, then the shelf that
 * works. The expensive failure of this module is a trámite that broke months
 * ago and stayed politely in alphabetical order.
 */
export function byUrgency(a: FlowSummary, b: FlowSummary): number {
  const rank = ORDER[health(a)] - ORDER[health(b)];
  if (rank !== 0) return rank;
  return (b.lastRunAt ?? b.verifiedAt ?? '').localeCompare(a.lastRunAt ?? a.verifiedAt ?? '');
}

/** An absolute moment, for anything a person might quote: "11 ago 10:18". */
export function stamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date.replace('.', '')} ${time}`;
}

/** Seconds, with the decimal comma this country writes. */
export function secs(value: number): string {
  return value >= 10 ? `${Math.round(value)} s` : `${value.toFixed(1).replace('.', ',')} s`;
}

/** What a run cost. Zero is the whole argument of the module, so it says so. */
export function money(value: number | null): string {
  if (!value) return 'sin costo';
  return `US$${value.toFixed(4)}`;
}
