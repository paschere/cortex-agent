import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday, deriveState } from '../commitments/shape';
import {
  confirmExtracted,
  createCommitment,
  dropCommitment,
  getCommitment,
  isUniqueViolation,
  markMet,
  rescheduleCommitment,
} from '../commitments/store';
import { quoteStatesDate } from './dates';
import { COMMITMENT_KIND_FOR, EXPIRATION_KIND_LABEL } from './kinds';
import {
  type ExpirationRow,
  getExpiration,
  markRenewed,
  openSiblings,
  setCommitmentLink,
} from './store';

/**
 * Cada papel confirmado tiene su vencimiento en `commitments` (0069), y de
 * ahí salen los avisos: el «ahead» a `renewal_lead_days`, el del día, el de
 * vencido y la escalada; el resumen diario de vencidos (0177); el piloto
 * automático (0176); el registro de trabajo (0174). No se construye un segundo
 * vigilante: se le da a este lo que tiene que vigilar.
 *
 * IDEMPOTENTE. Llamarlo dos veces sobre la misma fila no crea dos
 * vencimientos: si ya hay uno enlazado se actualiza; si la flota (RUNT) ya
 * tiene el mismo SOAT con la misma fecha, se enlaza a ése en vez de duplicarlo
 * (el índice único de 0069 sobre vehículo, tipo y fecha lo garantiza además).
 *
 * LA FUENTE DICE LA VERDAD. Si la fecha confirmada está escrita en la cita del
 * documento, el vencimiento nace con fuente «documento» y esa cita — y lo
 * confirma la misma persona que confirmó aquí (la regla de 0069: nada leído
 * se vigila sin alguien). Si la persona escribió o corrigió la fecha, la
 * fuente es esa persona, «manual», porque es quien la afirmó.
 */

export interface SyncContext {
  userId: string;
  organizationId: string;
  today?: string;
}

export type SyncAction = 'none' | 'created' | 'linked' | 'updated' | 'closed';

export async function syncExpirationCommitment(
  db: SupabaseClient,
  row: ExpirationRow,
  ctx: SyncContext,
): Promise<{ commitmentId: string | null; action: SyncAction }> {
  const today = ctx.today ?? bogotaToday();
  if (row.needs_review) return { commitmentId: row.commitment_id, action: 'none' };

  const current = row.commitment_id ? await getCommitment(db, row.commitment_id) : null;
  const open = current && current.state !== 'met' && current.state !== 'dropped';

  if (row.status === 'descartado' || row.status === 'renovado') {
    if (current && open) {
      if (row.status === 'descartado') {
        await dropCommitment(db, {
          id: current.id,
          userId: ctx.userId,
          reason: `Documento descartado: ${row.dismissed_reason ?? 'ya no aplica'}.`,
        });
      } else {
        await markMet(db, {
          id: current.id,
          userId: ctx.userId,
          note: 'Renovado: llegó un documento con una vigencia posterior.',
          today,
        });
      }
      return { commitmentId: current.id, action: 'closed' };
    }
    return { commitmentId: row.commitment_id, action: 'none' };
  }
  if (!row.expires_on) return { commitmentId: row.commitment_id, action: 'none' };

  // Ya enlazado y abierto: ponerlo al día con lo que se confirmó.
  if (current && open) {
    if (current.due_on !== row.expires_on) {
      await rescheduleCommitment(db, { id: current.id, dueOn: row.expires_on, today });
    }
    const patch: Record<string, unknown> = {};
    if (current.notice_days !== row.renewal_lead_days) patch.notice_days = row.renewal_lead_days;
    if (current.owner_user_id !== row.owner_user_id && row.owner_user_id) {
      patch.owner_user_id = row.owner_user_id;
    }
    if (current.title !== row.title) patch.title = row.title;
    if (Object.keys(patch).length > 0) {
      patch.state = deriveState(
        {
          due_on: row.expires_on,
          notice_days: (patch.notice_days as number | undefined) ?? current.notice_days,
        },
        today,
      );
      patch.updated_at = new Date().toISOString();
      const { error } = await db.from('commitments').update(patch).eq('id', current.id);
      if (error) throw error;
    }
    return { commitmentId: current.id, action: 'updated' };
  }
  // Enlazado a uno cerrado con la misma fecha: esa ocurrencia ya se resolvió.
  if (current && current.due_on === row.expires_on) {
    return { commitmentId: current.id, action: 'none' };
  }

  const kind = COMMITMENT_KIND_FOR[row.kind];

  // La flota ya lo vigila (RUNT, misma placa, mismo tipo, misma fecha).
  if (row.vehicle_id) {
    const reused = await findVehicleCommitment(db, row.vehicle_id, kind, row.expires_on);
    if (reused) {
      await setCommitmentLink(db, row.id, reused);
      return { commitmentId: reused, action: 'linked' };
    }
  }

  const fromDocument =
    row.source === 'documento' &&
    !!row.document_id &&
    !!row.expires_quote &&
    row.expires_quote.trim().length >= 8 &&
    quoteStatesDate(row.expires_quote, row.expires_on);

  let created: { id: string };
  try {
    created = await createCommitment(db, {
      title: row.title,
      detail: describe(row),
      kind,
      dueOn: row.expires_on,
      noticeDays: row.renewal_lead_days,
      counterparty: row.issuer,
      ownerUserId: row.owner_user_id ?? ctx.userId,
      vehicleId: row.vehicle_id,
      recurrence: 'none',
      source: fromDocument
        ? {
            kind: 'document',
            documentId: row.document_id as string,
            chunkId: row.chunk_id,
            quote: row.expires_quote as string,
          }
        : { kind: 'manual', userId: row.confirmed_by ?? ctx.userId },
      createdBy: ctx.userId,
    });
  } catch (err) {
    if (row.vehicle_id && isUniqueViolation(err)) {
      const reused = await findVehicleCommitment(db, row.vehicle_id, kind, row.expires_on);
      if (reused) {
        await setCommitmentLink(db, row.id, reused);
        return { commitmentId: reused, action: 'linked' };
      }
    }
    throw err;
  }

  // Leído de un documento nace pendiente (0069); lo confirma la persona que
  // acaba de confirmarlo aquí, con su nombre.
  if (fromDocument) {
    await confirmExtracted(db, {
      id: created.id,
      userId: row.confirmed_by ?? ctx.userId,
      organizationId: ctx.organizationId,
    });
  }
  if (row.client_id) {
    const { error } = await db
      .from('commitments')
      .update({ client_id: row.client_id })
      .eq('id', created.id);
    if (error) throw error;
  }
  await setCommitmentLink(db, row.id, created.id);
  return { commitmentId: created.id, action: 'created' };
}

async function findVehicleCommitment(
  db: SupabaseClient,
  vehicleId: string,
  kind: string,
  dueOn: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('commitments')
    .select('id')
    .eq('vehicle_id', vehicleId)
    .eq('kind', kind)
    .eq('due_on', dueOn)
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as { id: string } | undefined)?.id ?? null;
}

function describe(row: ExpirationRow): string {
  const parts = [
    `${EXPIRATION_KIND_LABEL[row.kind]}${row.number ? ` No. ${row.number}` : ''}`,
    row.issuer ? `expedido por ${row.issuer}` : '',
    row.issued_on ? `desde ${row.issued_on}` : '',
  ].filter(Boolean);
  return `${parts.join(', ')}. Renovarlo y subir el documento nuevo en Documentos que vencen cierra este aviso.`;
}

/**
 * Lo que pasa cuando un papel queda confirmado (a mano o al revisar): cierra
 * los papeles anteriores del mismo tipo y sujeto que éste renueva, y deja su
 * vencimiento al día. Idempotente.
 */
export async function afterConfirm(
  db: SupabaseClient,
  row: ExpirationRow,
  ctx: SyncContext,
): Promise<{ commitmentId: string | null; action: SyncAction; renewed: ExpirationRow[] }> {
  const today = ctx.today ?? bogotaToday();
  const siblings = await openSiblings(db, row, today);
  const renewed: ExpirationRow[] = [];
  for (const old of siblings) {
    await markRenewed(db, { oldId: old.id, newId: row.id });
    const closed = await getExpiration(db, old.id);
    if (closed) {
      await syncExpirationCommitment(db, closed, ctx);
      renewed.push(closed);
    }
  }
  const sync = await syncExpirationCommitment(db, row, ctx);
  return { ...sync, renewed };
}
