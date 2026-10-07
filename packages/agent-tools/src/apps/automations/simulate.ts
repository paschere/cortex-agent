import { NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../../trackers/store';
import type { CatalogTracker } from '../../views/spec';
import type { CustomAppRow } from '../store';
import { type Simulation, simulateRule } from './engine';
import type { AutomationEvent, Values } from './match';
import { matchesTrigger } from './match';
import type { AutomationInput } from './spec';

/**
 * «PROBAR CON UNA FILA DE EJEMPLO»: la regla corre contra una fila real (la que
 * se elija o la más reciente de la tabla) y dice qué haría, SIN HACERLO: ni
 * escribe, ni avisa, ni llama a nadie. Usa el mismo motor puro de la corrida de
 * verdad (condiciones, variables), así que lo que el simulador promete es lo
 * que la corrida cumple.
 */
export async function simulateAutomation(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id' | 'name' | 'slug'>,
  input: Pick<AutomationInput, 'trigger' | 'conditions' | 'actions'>,
  options: { rowId?: string; now?: Date; baseUrl?: string } = {},
): Promise<Simulation & { sample: { label: string; id: string } | null }> {
  const now = options.now ?? new Date();
  const trigger = input.trigger;
  const slug = 'tracker' in trigger ? trigger.tracker : null;
  const tracker = slug ? await getTrackerBySlug(db, slug) : null;
  if (slug && !tracker) throw new NotFoundError(`La tabla «${slug}» no existe.`);

  let after: Values = {};
  let label = '';
  let id: string | undefined;
  if (tracker) {
    let q = db
      .from('tracker_rows')
      .select('id, label, values')
      .eq('tracker_id', tracker.id)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (options.rowId) q = q.eq('id', options.rowId);
    const { data, error } = await q;
    if (error) throw error;
    const row = (data ?? [])[0] as { id: string; label: string; values: Values } | undefined;
    if (!row)
      throw new NotFoundError(
        options.rowId
          ? 'Esa fila no está en la tabla.'
          : `«${tracker.name}» todavía no tiene filas para probar.`,
      );
    after = row.values ?? {};
    label = row.label;
    id = row.id;
  }

  // Un «cambió» simulado: antes tenía otro valor en el campo que mira el disparador.
  let before: Values | null = null;
  if (trigger.type === 'row_updated' && trigger.field) before = { ...after, [trigger.field]: '' };
  else if (trigger.type === 'approval_decided' || trigger.type === 'row_updated')
    before = { ...after };

  const event: AutomationEvent = {
    kind: trigger.type,
    trackerId: tracker?.id,
    trackerSlug: tracker?.slug,
    rowId: id,
    before,
    after,
    label,
    version: now.toISOString(),
    actor: { kind: 'system' },
    decision:
      trigger.type === 'approval_decided' && trigger.decision !== 'any'
        ? trigger.decision === 'approved'
          ? 'approved'
          : 'rejected'
        : undefined,
    screen: 'screen' in trigger ? (trigger.screen as string | undefined) : undefined,
    buttonId: trigger.type === 'button' ? trigger.id : undefined,
    chain: [],
    depth: 0,
  };
  const catalog: CatalogTracker | null = tracker
    ? { slug: tracker.slug, name: tracker.name, fields: tracker.fields }
    : null;
  const base = options.baseUrl ?? '';
  const sim = simulateRule(
    input,
    event,
    {
      after,
      before,
      label,
      appName: app.name,
      link: `${base}/a/${app.id}`,
      reason: '(el motivo que escriba quien rechaza)',
      labels: tracker ? Object.fromEntries(tracker.fields.map((f) => [f.key, f.label])) : {},
    },
    catalog,
    now,
    matchesTrigger(trigger, event, tracker?.slug ?? null),
  );
  return { ...sim, sample: id ? { id, label } : null };
}
