import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../../trackers/store';
import type { CatalogTracker } from '../../views/spec';
import { queueRuns } from './emit';
import type { AutomationEvent, Values } from './match';
import { type PollRow, pollDue, pollSlotIndex, rowSlotVersion, selectPollRows } from './poll';
import type { AutomationCondition } from './spec';
import { automationTriggerSchema } from './spec';

/**
 * LA VUELTA DE «CADA X MINUTOS, PARA CADA FILA QUE CUMPLA…» (0212).
 *
 * La llama el despachador de cada minuto (apps/web/inngest/functions/
 * app-automations.ts) por cada regla `rows_poll` encendida. Reclama la franja
 * con un UPDATE condicionado (dos vueltas del reloj = una sola ronda), elige las
 * filas con la lógica pura de poll.ts y deja UNA corrida en cola por fila. La
 * corrida es una corrida normal: mismas condiciones, mismos topes diarios,
 * mismo historial. Lo que pasa después (p. ej. Cortex escribe en la fila) emite
 * sus propios eventos con la regla en la cadena, así que no se dispara a sí misma.
 */

const SCAN_LIMIT = 2000;

export interface PollRuleInput {
  id: string;
  app_id: string;
  trigger: unknown;
  conditions: AutomationCondition[];
  schedule_last_slot: string | null;
}

export async function queuePollRound(
  db: SupabaseClient,
  rule: PollRuleInput,
  now: Date,
): Promise<{ queued: number; overflow: number; claimed: boolean }> {
  const parsed = automationTriggerSchema.safeParse(rule.trigger);
  if (!parsed.success || parsed.data.type !== 'rows_poll')
    return { queued: 0, overflow: 0, claimed: false };
  const trigger = parsed.data;
  const slot = pollDue(
    trigger.everyMinutes,
    rule.schedule_last_slot ? new Date(rule.schedule_last_slot) : null,
    now,
  );
  if (!slot) return { queued: 0, overflow: 0, claimed: false };

  // Se reclama la franja ANTES: gana un solo intento.
  let claim = db
    .from('custom_app_automations')
    .update({ schedule_last_slot: slot.toISOString() })
    .eq('id', rule.id);
  claim = rule.schedule_last_slot
    ? claim.lt('schedule_last_slot', slot.toISOString())
    : claim.is('schedule_last_slot', null);
  const { data: won, error: claimError } = await claim.select('id');
  if (claimError) throw claimError;
  if (!won?.length) return { queued: 0, overflow: 0, claimed: false };

  const tracker = await getTrackerBySlug(db, trigger.tracker);
  if (!tracker) return { queued: 0, overflow: 0, claimed: true };
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, created_at, updated_at')
    .eq('tracker_id', tracker.id)
    .limit(SCAN_LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as PollRow[];
  if (!rows.length) return { queued: 0, overflow: 0, claimed: true };

  const perRow = trigger.perRowMinutes ?? trigger.everyMinutes;
  const rowSlot = rowSlotVersion(perRow, now);
  // Filas que ya tuvieron corrida en la franja por fila (frecuencia mínima).
  const { data: seen, error: seenError } = await db
    .from('custom_app_automation_runs')
    .select('trigger_ref')
    .eq('automation_id', rule.id)
    .like('trigger_ref', 'poll:%')
    .gte('created_at', rowSlot)
    .limit(5000);
  if (seenError) throw seenError;
  const alreadyQueued = new Set(
    ((seen ?? []) as Array<{ trigger_ref: string }>).map((r) => r.trigger_ref.slice(5)),
  );

  const catalog: CatalogTracker = {
    slug: tracker.slug,
    name: tracker.name,
    fields: tracker.fields,
  };
  const picked = selectPollRows({
    rows,
    conditions: rule.conditions,
    window: trigger.window,
    tracker: catalog,
    alreadyQueued,
    maxRows: trigger.maxRows,
    slotIndex: pollSlotIndex(trigger.everyMinutes, now),
    now,
  });

  let queued = 0;
  for (const row of picked.rows) {
    const event: AutomationEvent = {
      kind: 'rows_poll',
      trackerId: tracker.id,
      trackerSlug: tracker.slug,
      rowId: row.id,
      after: (row.values ?? {}) as Values,
      label: row.label,
      version: rowSlot,
      actor: { kind: 'system' },
      chain: [],
      depth: 0,
    };
    queued += await queueRuns(db, [{ id: rule.id, app_id: rule.app_id }], event, `poll:${row.id}`);
  }
  return { queued, overflow: picked.overflow, claimed: true };
}
