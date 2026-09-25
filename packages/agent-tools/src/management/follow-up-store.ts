import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FOLLOW_UP_STATES,
  type FollowUpNotice,
  type FollowUpReason,
  type FollowUpStep,
} from './follow-up';
import type { ManagementCase } from './shape';

/**
 * La única puerta de `management_case_notices` (0158) y las lecturas que el
 * vigilante necesita. `db` es siempre un handle con alcance de empresa: nada
 * de aquí filtra por `organization_id` a mano.
 *
 * El orden es el de commitment_notices y goal_notices: se RECLAMA (insert con
 * índice único), se manda, y se CIERRA con el resultado. Quien pierde la
 * reclamación no manda nada.
 */

const CASE_COLUMNS = 'id,data,revision,created_by,updated_by,created_at,updated_at';
const NOTICE_COLUMNS = 'id,case_id,case_revision,step,sent_on,delivered';

/** Techo de asuntos vivos por empresa y mañana. Más que eso es una mesa rota. */
export const FOLLOW_UP_CASE_LIMIT = 2000;

/** Los asuntos en los que el siguiente movimiento es del responsable. */
export async function listFollowUpCases(db: SupabaseClient): Promise<ManagementCase[]> {
  const { data, error } = await db
    .from('management_cases')
    .select(CASE_COLUMNS)
    .in('data->>state', [...FOLLOW_UP_STATES])
    .order('updated_at', { ascending: true })
    .limit(FOLLOW_UP_CASE_LIMIT);
  if (error) throw error;
  return (data ?? []) as ManagementCase[];
}

/**
 * Lo que el vigilante necesita del perfil: el interruptor por empresa
 * (encendido si no hay perfil o si el campo falta) y el responsable de
 * escalamiento acordado.
 */
export async function readFollowUpProfile(
  db: SupabaseClient,
): Promise<{ enabled: boolean; escalationOwnerId: string | null }> {
  const { data, error } = await db.from('management_profiles').select('data').maybeSingle();
  if (error) throw error;
  const profile = (data as { data?: { followUp?: unknown; escalationOwnerId?: unknown } } | null)
    ?.data;
  const owner = profile?.escalationOwnerId;
  return {
    enabled: profile?.followUp !== false,
    escalationOwnerId: typeof owner === 'string' && owner ? owner : null,
  };
}

/** Lo ya dicho sobre estos asuntos, en tandas para no reventar la URL. */
export async function listFollowUpNotices(
  db: SupabaseClient,
  caseIds: readonly string[],
): Promise<FollowUpNotice[]> {
  const out: FollowUpNotice[] = [];
  for (let i = 0; i < caseIds.length; i += 200) {
    const chunk = caseIds.slice(i, i + 200);
    const { data, error } = await db
      .from('management_case_notices')
      .select(NOTICE_COLUMNS)
      .in('case_id', chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      case_id: string;
      case_revision: number;
      step: FollowUpStep;
      sent_on: string;
      delivered: boolean;
    }>) {
      out.push({
        caseId: row.case_id,
        caseRevision: row.case_revision,
        step: row.step,
        sentOn: row.sent_on,
        delivered: row.delivered,
      });
    }
  }
  return out;
}

export type FollowUpClaim =
  | { outcome: 'claimed'; id: string }
  | { outcome: 'retry'; id: string }
  | { outcome: 'taken'; id: null };

/**
 * «¿Ya dijimos esto?» La respuesta la da el índice único, no este código.
 *
 * Gana → `claimed`. Pierde contra una fila sin entregar → `retry` con su id:
 * se vuelve a intentar sin crear otra. Pierde contra una entregada → `taken`.
 */
export async function claimFollowUpNotice(
  db: SupabaseClient,
  input: {
    caseId: string;
    caseRevision: number;
    step: FollowUpStep;
    reasons: readonly FollowUpReason[];
    sentOn: string;
    recipientUserIds: readonly string[];
    via: 'named' | 'manager' | 'admin' | 'none' | null;
  },
): Promise<FollowUpClaim> {
  const { data, error } = await db
    .from('management_case_notices')
    .insert({
      case_id: input.caseId,
      case_revision: input.caseRevision,
      step: input.step,
      reasons: [...input.reasons],
      sent_on: input.sentOn,
      recipient_user_ids: [...input.recipientUserIds].slice(0, 20),
      via: input.via === 'none' ? null : input.via,
      delivered: false,
    })
    .select('id')
    .single();
  if (!error && data) return { outcome: 'claimed', id: (data as { id: string }).id };
  if (error?.code !== '23505') throw error ?? new Error('No se pudo reclamar el aviso.');

  // El de «sin responsable» choca por asunto, en cualquier revisión.
  let query = db
    .from('management_case_notices')
    .select('id,delivered')
    .eq('case_id', input.caseId)
    .eq('step', input.step);
  if (input.step !== 'unowned') query = query.eq('case_revision', input.caseRevision);
  const existing = await query.maybeSingle();
  if (existing.error) throw existing.error;
  const row = existing.data as { id: string; delivered: boolean } | null;
  if (!row || row.delivered) return { outcome: 'taken', id: null };
  return { outcome: 'retry', id: row.id };
}

/** El resultado del envío. `sentOn` se mueve al día en que de verdad salió. */
export async function settleFollowUpNotice(
  db: SupabaseClient,
  input: { id: string; delivered: boolean; note?: string | null; sentOn: string },
): Promise<void> {
  const { error } = await db
    .from('management_case_notices')
    .update({
      delivered: input.delivered,
      note: input.note ? input.note.slice(0, 500) : null,
      sent_on: input.sentOn,
      settled_at: new Date().toISOString(),
    })
    .eq('id', input.id);
  if (error) throw error;
}

/**
 * Suelta una reclamación que no llegó a mandarse (el asunto cambió entre el
 * plan y el envío). Sólo borra filas sin entregar, así que nunca reabre un
 * aviso que sí salió.
 */
export async function releaseFollowUpNotice(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from('management_case_notices')
    .delete()
    .eq('id', id)
    .eq('delivered', false);
  if (error) throw error;
}
