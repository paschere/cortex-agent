import type { SupabaseClient } from '@supabase/supabase-js';
import type { ManagementCaseData } from './shape';
export type ReviewEvent = {
  case_id: string;
  revision: number;
  data: ManagementCaseData;
  created_at: string;
};
/** Only a recorded transition with its immediate predecessor proves a closure in this period. */
export function evidenceClosures(events: ReviewEvent[], predecessors: ReviewEvent[]) {
  const all = new Map([...predecessors, ...events].map((e) => [`${e.case_id}:${e.revision}`, e]));
  const closed = new Map<string, ReviewEvent>();
  for (const e of events) {
    const previous = all.get(`${e.case_id}:${e.revision - 1}`);
    if (
      e.data.state === 'verified' &&
      e.data.evidence &&
      previous &&
      previous.data.state !== 'verified'
    )
      closed.set(e.case_id, e);
  }
  return [...closed.values()];
}
export async function readWeeklyManagement(
  db: SupabaseClient,
  start: string,
  endExclusive: string,
) {
  const r = await db
    .from('management_events')
    .select('case_id,revision,data,created_at')
    .gte('created_at', start)
    .lt('created_at', endExclusive)
    .order('created_at', { ascending: false })
    .limit(101);
  if (r.error) throw new Error('No se pudo leer el historial de gerencia.');
  const events = (r.data ?? []).slice(0, 100) as ReviewEvent[];
  const predecessors: ReviewEvent[] = [];
  // Bounded query strings, with exact revision lookups rather than inferring from updated_at.
  for (let i = 0; i < events.length; i += 20) {
    const batch = events.slice(i, i + 20).filter((e) => e.revision > 1);
    if (!batch.length) continue;
    const p = await db
      .from('management_events')
      .select('case_id,revision,data,created_at')
      .or(batch.map((e) => `and(case_id.eq.${e.case_id},revision.eq.${e.revision - 1})`).join(','));
    if (p.error) throw new Error('No se pudo comprobar la revisión anterior de los asuntos.');
    predecessors.push(...((p.data ?? []) as ReviewEvent[]));
  }
  const closures = evidenceClosures(events, predecessors);
  const known = new Set([...events, ...predecessors].map((e) => `${e.case_id}:${e.revision}`));
  const missingHistory = events.filter(
    (e) => e.data.state === 'verified' && !known.has(`${e.case_id}:${e.revision - 1}`),
  ).length;
  const partial = (r.data?.length ?? 0) > 100;
  return {
    closures,
    missingHistory,
    partial,
    rows: events.length,
    paragraphs: [
      `${closures.length} asuntos con transición a cierre y evidencia registrada en el período${partial ? ' (vista parcial: últimas 100 revisiones)' : ''}.`,
      ...(missingHistory
        ? [
            `${missingHistory} revisiones verificadas no tienen revisión anterior disponible; no se contaron como cierres nuevos.`,
          ]
        : []),
      ...closures.map(
        (e) =>
          `${e.data.title}: ${e.data.evidence?.observation} · Evidencia: ${e.data.evidence?.reference}`,
      ),
      'Un cierre registrado no atribuye por sí solo ahorro o ingresos a Cortex. La medición requiere línea base, período y criterio acordados.',
    ],
  };
}
