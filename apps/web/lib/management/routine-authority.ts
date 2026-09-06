import type { SupabaseClient } from '@supabase/supabase-js';
/** Read at each tool boundary: pausing or revoking never restores the legacy approval. */
export async function readRoutineAuthority(db: SupabaseClient, id: string, userId: string) {
  const r = await db
    .from('scheduled_jobs')
    .select('status,mandate_only,allow_unattended_writes')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (r.error || !r.data || r.data.status !== 'active')
    throw new Error(
      'La rutina se detuvo, cambió de responsable o no se pudo comprobar su autorización.',
    );
  return {
    scopedMandatesOnly: r.data.mandate_only === true,
    confirmed: r.data.mandate_only !== true && r.data.allow_unattended_writes === true,
  };
}
