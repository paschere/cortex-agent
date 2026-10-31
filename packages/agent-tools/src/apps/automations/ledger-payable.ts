import type { SupabaseClient } from '@supabase/supabase-js';
import { assertPeriodOpen } from '../../close/lock';
import { PeriodLockedError } from '../../close/shape';
import { bogotaToday } from '../../commitments/shape';
import { MOVEMENT_COLUMNS, type MovementDraft, type MovementRow } from '../../ledger/shape';
import { addDays, dayOf, moneyText } from '../../ledger/shape';
import { upsertMovements } from '../../ledger/store';
import { rowToDraft } from '../../ledger/tools';
import { type TemplateContext, renderTemplate } from './engine';
import { toNumber } from './related';
import type { AutomationAction } from './spec';

/**
 * LA ACCIÓN `ledger_payable`: el costo de una fila (un equipo usado, el
 * combustible…) queda en el libro de plata como CUENTA POR PAGAR PROBABLE
 * (status «expected», sentido «out»), para que la proyección de caja lo vea
 * sin que nadie lo digite.
 *
 * Idempotente: la identidad del movimiento es (hoja, `app:<slug>`, fila), así
 * que correr la regla otra vez —la fila se editó— ACTUALIZA el mismo
 * movimiento. Sin valor (vacío o <= 0) lo ANULA si existe (poner el costo en
 * cero lo saca de la proyección) y si no existe no hace nada. Nunca toca uno ya
 * liquidado, y respeta los meses cerrados.
 */

export type LedgerPayableAction = Extract<AutomationAction, { type: 'ledger_payable' }>;

export interface PayablePlan {
  /** El valor leído de la fila, o null si está vacío / no es número / <= 0. */
  amount: number | null;
  /** El borrador; con `amount` null sólo sirve para identificar el movimiento. */
  draft: MovementDraft;
}

/** Puro: de la acción y la fila al borrador del libro. */
export function buildPayablePlan(
  action: LedgerPayableAction,
  ctx: TemplateContext,
  at: { appSlug: string; trackerSlug: string; rowId: string; userId: string | null; today?: string },
): PayablePlan {
  const today = at.today ?? bogotaToday();
  const raw = toNumber(ctx.after[action.amount]);
  const amount = raw !== null && raw > 0 ? raw : null;
  const day = (action.date ? dayOf(String(ctx.after[action.date] ?? '').trim()) : null) ?? today;
  const counterparty = renderTemplate(action.counterparty, ctx).replace(/\s+/g, ' ').trim();
  const description = renderTemplate(action.description, ctx).replace(/\s+/g, ' ').trim();
  const draft = rowToDraft(
    {
      direction: 'out',
      kind: 'payable',
      status: 'expected',
      amount: amount ?? 1,
      currency: action.currency,
      date: day,
      dueDate: addDays(day, action.dueDays),
      counterpartyName: counterparty || null,
      description: description || counterparty || 'Costo de operación',
      category: action.category,
      ref: `${at.trackerSlug}:${at.rowId}`,
    },
    { kind: 'sheet', label: null, ref: null },
    { today, userId: at.userId ?? '' },
  );
  draft.recordedBy = at.userId;
  // El sistema de la fuente es la app, no «hoja»: dos apps con el mismo id de fila no chocan.
  draft.source = { ...draft.source, system: `app:${at.appSlug}`.slice(0, 80) };
  return { amount, draft };
}

async function existingOf(db: SupabaseClient, draft: MovementDraft): Promise<MovementRow | null> {
  const { data, error } = await db
    .from('ledger_movements')
    .select(MOVEMENT_COLUMNS)
    .eq('source_kind', draft.source.kind)
    .eq('source_system', draft.source.system ?? '')
    .eq('source_ref', draft.source.ref)
    .maybeSingle();
  if (error) throw error;
  return (data as MovementRow | null) ?? null;
}

async function ensureOpen(db: SupabaseClient, day: string, userId: string | null) {
  try {
    await assertPeriodOpen(db, day, { action: 'anotar una cuenta por pagar', userId });
  } catch (err) {
    if (err instanceof PeriodLockedError)
      throw new Error(`No se anotó la cuenta por pagar: ${err.message}`);
    throw err;
  }
}

export async function runLedgerPayable(input: {
  db: SupabaseClient;
  app: { slug: string };
  trackerSlug: string;
  rowId: string;
  userId: string | null;
  action: LedgerPayableAction;
  ctx: TemplateContext;
  today?: string;
}): Promise<string> {
  const { db, action } = input;
  const plan = buildPayablePlan(action, input.ctx, {
    appSlug: input.app.slug,
    trackerSlug: input.trackerSlug,
    rowId: input.rowId,
    userId: input.userId,
    today: input.today,
  });
  const found = await existingOf(db, plan.draft);
  // Lo liquidado (pagado, o saldado por el banco) ya es historia: no se toca.
  if (found?.status === 'settled') return 'Esa cuenta por pagar ya está pagada; no la toqué.';

  if (plan.amount === null) {
    if (!found || found.status === 'cancelled') return 'Sin valor: no hay nada que anotar por pagar.';
    await ensureOpen(db, found.date, input.userId);
    const res = await upsertMovements(
      db,
      [{ ...plan.draft, status: 'cancelled', outstanding: 0, merge: 'status' }],
      { recordedBy: input.userId },
    );
    if (res.rejected.length) throw new Error(res.rejected[0]?.reason ?? 'No se pudo anular.');
    return 'El valor quedó en cero: anulé la cuenta por pagar que había anotado.';
  }

  await ensureOpen(db, plan.draft.date, input.userId);
  if (found && found.date !== plan.draft.date) await ensureOpen(db, found.date, input.userId);
  const res = await upsertMovements(db, [plan.draft], { recordedBy: input.userId });
  if (res.rejected.length) throw new Error(res.rejected[0]?.reason ?? 'No se pudo anotar.');
  const who = plan.draft.counterpartyName ?? 'proveedor sin nombre';
  const done = `por pagar ${moneyText(plan.amount, action.currency)} a ${who} (vence ${plan.draft.dueDate})`;
  return res.inserted.length ? `Anotó ${done}` : res.updated.length ? `Actualizó ${done}` : `Ya estaba anotado ${done}`;
}
