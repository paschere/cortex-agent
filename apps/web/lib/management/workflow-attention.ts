import { createHash } from 'node:crypto';
import { notify } from '@/lib/notifications/notify';
import type { CollectionWorkflow } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/** In-app only. No email recipient or external channel is inferred. */
export async function notifyWorkflowAttention(db: SupabaseClient, run: CollectionWorkflow | null) {
  if (!run || run.state === 'cancelled' || run.state === 'ready' || run.state === 'approval')
    return;
  let event: string;
  let title: string;
  if (run.state === 'blocked') {
    event = `blocked:${createHash('sha256').update(run.detail).digest('hex').slice(0, 24)}`;
    title = 'El seguimiento de cartera necesita tu ayuda';
  } else if (run.state === 'review') {
    event = 'evidence-ready';
    title = 'Hay evidencia para revisar el cierre de cartera';
  } else {
    if (!run.action_id) return;
    const r = await db
      .from('actions')
      .select('outcome')
      .eq('id', run.action_id)
      .eq('user_id', run.user_id)
      .maybeSingle();
    if (r.error) throw new Error('No se pudo comprobar la respuesta del cobro.');
    if (r.data?.outcome !== 'replied' && r.data?.outcome !== 'no_reply') return;
    event = `${run.action_id}:${r.data.outcome}`;
    title =
      r.data.outcome === 'replied'
        ? 'Respondieron al cobro: revisa el siguiente paso'
        : 'El cobro sigue sin respuesta';
  }
  const id = await notify(db, {
    userId: run.user_id,
    kind: 'management_attention',
    title,
    body: run.detail,
    href: '/management/mission',
    dedupeKey: `management:${run.id}:${event}`,
  });
  if (!id) throw new Error('No se pudo registrar el aviso de seguimiento.');
}
