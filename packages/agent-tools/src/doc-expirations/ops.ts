import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ConfirmInput,
  type ExpirationRow,
  type TrackManualInput,
  confirmExpirationRow,
  dismissExpiration,
  getExpiration,
  getScan,
  insertManual,
  recordScan,
  updateExpirationFields,
} from './store';
import { type SyncAction, type SyncContext, afterConfirm, syncExpirationCommitment } from './sync';

/**
 * Las decisiones de una persona sobre un papel, completas: la fila y lo que
 * sigue (el vencimiento en `commitments`, cerrar lo que se renueva). Las
 * llaman las herramientas del chat y las acciones de /documentos-vencen, así
 * que las dos superficies no pueden hacer cosas distintas con el mismo clic.
 */

export interface DecisionResult {
  row: ExpirationRow;
  commitmentId: string | null;
  action: SyncAction;
  renewed: ExpirationRow[];
}

export async function confirmExpiration(
  db: SupabaseClient,
  input: ConfirmInput,
  ctx: SyncContext,
): Promise<DecisionResult> {
  const row = await confirmExpirationRow(db, input);
  const after = await afterConfirm(db, row, ctx);
  const fresh = (await getExpiration(db, row.id)) ?? row;
  return { row: fresh, ...after };
}

export async function trackExpiration(
  db: SupabaseClient,
  input: TrackManualInput,
  ctx: SyncContext,
): Promise<DecisionResult> {
  const row = await insertManual(db, input);
  const after = await afterConfirm(db, row, ctx);
  const fresh = (await getExpiration(db, row.id)) ?? row;
  return { row: fresh, ...after };
}

export async function discardExpiration(
  db: SupabaseClient,
  input: { id: string; reason: string },
  ctx: SyncContext,
): Promise<DecisionResult> {
  const row = await dismissExpiration(db, input);
  const sync = await syncExpirationCommitment(db, row, ctx);
  return { row, ...sync, renewed: [] };
}

export async function changeExpiration(
  db: SupabaseClient,
  id: string,
  patch: { ownerUserId?: string | null; renewalLeadDays?: number },
  ctx: SyncContext,
): Promise<DecisionResult> {
  const row = await updateExpirationFields(db, id, patch);
  const sync = await syncExpirationCommitment(db, row, ctx);
  return { row, ...sync, renewed: [] };
}

/**
 * Alguien subió desde la pantalla el documento que renueva este papel. Se
 * deja la pista para la lectura (que corre al terminar de indexarse): leerá
 * sabiendo qué buscar y, al confirmarse, cerrará el anterior.
 */
export async function queueRenewalUpload(
  db: SupabaseClient,
  input: { expirationId: string; documentId: string },
): Promise<{ alreadyScanned: boolean }> {
  const current = await getExpiration(db, input.expirationId);
  if (!current) throw new ValidationError('Ese vencimiento ya no existe.');
  // Si la ingesta ya lo miró (llegó antes que la pista), quien llama vuelve a
  // leerlo con `force`: la pista queda puesta para esa lectura.
  const prior = await getScan(db, input.documentId);
  await recordScan(db, {
    documentId: input.documentId,
    outcome: 'queued',
    renewsExpirationId: current.id,
  });
  return { alreadyScanned: !!prior && prior.outcome !== 'queued' };
}
