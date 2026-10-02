import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA ÚNICA PUERTA DE `follow_through_notices` (0177), y el interruptor del
 * resumen diario.
 *
 * El orden es el de commitment_notices y management_case_notices: se RECLAMA
 * (insert con índice único), se avisa, y se CIERRA con el resultado. Quien
 * pierde la reclamación no avisa nada: correr el barrido diez veces, o dos a la
 * vez, avisa una.
 *
 * `db` es siempre un handle con alcance de empresa.
 */

export type FollowThroughNoticeKind = 'approval_reminder' | 'approval_discard' | 'work_digest';

/** Lo ya avisado en los últimos días, como `${userId}|${kind}|${ref}`. */
export async function listFollowThroughClaims(
  db: SupabaseClient,
  opts: { kinds: readonly FollowThroughNoticeKind[]; sinceDay: string },
): Promise<Set<string>> {
  const { data, error } = await db
    .from('follow_through_notices')
    .select('user_id, kind, ref')
    .in('kind', [...opts.kinds])
    .gte('sent_on', opts.sinceDay)
    .limit(10_000);
  if (error) throw error;
  return new Set(
    ((data ?? []) as Array<{ user_id: string; kind: string; ref: string }>).map(
      (r) => `${r.user_id}|${r.kind}|${r.ref}`,
    ),
  );
}

/**
 * Reclama el aviso. `true`: es tuyo, avísalo. `false`: alguien ya lo reclamó
 * (otra corrida, un reintento) y no se avisa otra vez.
 */
export async function claimFollowThroughNotice(
  db: SupabaseClient,
  input: {
    userId: string;
    kind: FollowThroughNoticeKind;
    ref: string;
    sentOn: string;
    itemCount: number;
  },
): Promise<string | null> {
  const { data, error } = await db
    .from('follow_through_notices')
    .insert({
      user_id: input.userId,
      kind: input.kind,
      ref: input.ref.slice(0, 200),
      sent_on: input.sentOn,
      item_count: Math.max(0, Math.floor(input.itemCount)),
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/** Cierra el aviso con su resultado. */
export async function settleFollowThroughNotice(
  db: SupabaseClient,
  id: string,
  delivered: boolean,
): Promise<void> {
  const { error } = await db.from('follow_through_notices').update({ delivered }).eq('id', id);
  if (error) throw error;
}

/**
 * Si la empresa quiere el resumen diario de vencidos. Encendido si no hay
 * fila: es el default de la columna (0177).
 */
export async function readOverdueDigestEnabled(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from('work_settings').select('overdue_digest').maybeSingle();
  if (error) throw error;
  return (data as { overdue_digest?: boolean } | null)?.overdue_digest !== false;
}

/** Lo enciende o lo apaga. Quién puede llamarla lo decide quien la llama (sólo administradores). */
export async function saveOverdueDigestEnabled(
  db: SupabaseClient,
  enabled: boolean,
  actorId: string | null,
): Promise<boolean> {
  const { data, error } = await db
    .from('work_settings')
    .upsert(
      { overdue_digest: enabled, updated_by: actorId, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id' },
    )
    .select('overdue_digest')
    .single();
  if (error) throw error;
  return (data as { overdue_digest: boolean }).overdue_digest !== false;
}
