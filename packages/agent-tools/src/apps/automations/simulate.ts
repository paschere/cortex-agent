import { NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../../trackers/store';
import type { CatalogTracker } from '../../views/spec';
import type { CustomAppRow } from '../store';
import { type ActionPreview, type Simulation, type TemplateContext, simulateRule } from './engine';
import type { AutomationEvent, Values } from './match';
import { matchesTrigger } from './match';
import {
  describeRelatedPlan,
  describeRollupPlan,
  planRollup,
  planUpdateRelated,
  planUpdateRows,
  summarizeChanges,
} from './related';
import { type AutomationInput, triggerTracker } from './spec';

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
  const slug = triggerTracker(trigger);
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

  // Un suceso contable simulado: la fila de ejemplo se lleva al estado al que
  // llegaría («una factura queda pagada» → Pagada, saldo 0), con su «antes».
  let kind: AutomationEvent['kind'] = trigger.type;
  if (trigger.type === 'accounting_event') {
    const created = [
      'invoice_created',
      'receipt_created',
      'credit_note_created',
      'customer_created',
      'purchase_created',
      'supplier_payment_created',
      'quotation_created',
    ];
    const target =
      trigger.event === 'invoice_paid'
        ? 'Pagada'
        : trigger.event === 'invoice_overdue'
          ? 'Vencida'
          : trigger.event === 'invoice_annulled'
            ? 'Anulada'
            : null;
    if (created.includes(trigger.event)) {
      kind = 'row_created';
      before = null;
    } else if (trigger.event === 'invoice_rejected') {
      kind = 'row_updated';
      before = { ...after, factura_electronica: 'Pendiente' };
      after = {
        ...after,
        factura_electronica: 'Rechazada',
        mensaje_dian: after.mensaje_dian ?? 'Ejemplo: el NIT del adquirente no es válido.',
      };
    } else if (trigger.event === 'stock_low') {
      // Las existencias bajan del nivel de antes al del umbral (o a «Bajo mínimo»).
      const low = trigger.threshold ?? 0;
      kind = 'row_updated';
      before = { ...after, existencias: low + 10, alerta: 'Con existencias' };
      after = { ...after, existencias: low, alerta: low > 0 ? 'Bajo mínimo' : 'Sin existencias' };
    } else {
      kind = 'row_updated';
      before = { ...after, estado: 'Por cobrar' };
      after = { ...after, ...(target ? { estado: target } : {}), ...(target === 'Pagada' ? { saldo: 0 } : {}) };
    }
  }

  const event: AutomationEvent = {
    kind,
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
  const ctx: TemplateContext = {
    after,
    before,
    label,
    appName: app.name,
    link: `${base}/a/${app.id}`,
    reason: '(el motivo que escriba quien rechaza)',
    labels: tracker ? Object.fromEntries(tracker.fields.map((f) => [f.key, f.label])) : {},
    types: tracker ? Object.fromEntries(tracker.fields.map((f) => [f.key, f.type])) : {},
  };
  const sim = simulateRule(
    input,
    event,
    ctx,
    catalog,
    now,
    matchesTrigger(trigger, event, tracker?.slug ?? null),
  );
  // Filas relacionadas y acumulados: se LEE lo que hay y se dice qué cambiaría,
  // fila por fila, con el mismo plan que usa la corrida de verdad. No se escribe nada.
  const actions: ActionPreview[] = [];
  for (let i = 0; i < input.actions.length; i++) {
    const a = input.actions[i];
    const preview = sim.actions[i] as ActionPreview;
    if (!a || preview.skipped || !tracker) {
      actions.push(preview);
      continue;
    }
    try {
      if (a.type === 'update_related') {
        const plan = await planUpdateRelated(db, { tracker, rowId: id, action: a, ctx, now });
        actions.push({
          type: a.type,
          summary: describeRelatedPlan(plan),
          details: plan.rows
            .filter((r) => r.changes.length)
            .slice(0, 10)
            .map((r) => `${r.label}: ${summarizeChanges(r.changes)}`),
        });
        continue;
      }
      if (a.type === 'update_rows') {
        const plan = await planUpdateRows(db, { action: a, ctx, now });
        actions.push({
          type: a.type,
          summary: describeRelatedPlan(plan),
          details: plan.rows
            .filter((r) => r.changes.length)
            .slice(0, 10)
            .map((r) => `${r.label}: ${summarizeChanges(r.changes)}`),
        });
        continue;
      }
      if (a.type === 'rollup') {
        const plan = await planRollup(db, { tracker, action: a, ctx, before, now });
        actions.push({ type: a.type, summary: describeRollupPlan(a, plan) });
        continue;
      }
    } catch (err) {
      actions.push({
        type: preview.type,
        summary: `${preview.summary} (No se pudo revisar la tabla: ${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }
    actions.push(preview);
  }
  return { ...sim, actions, sample: id ? { id, label } : null };
}
