import 'server-only';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type ReplaySnapshot, SHARE_TOKEN_RE, parseSnapshot, shareState } from './shape';
import { auditShare } from './store';
import { hashShareToken } from './token';

/**
 * LA PUERTA DE AFUERA DE LA REPETICIÓN (/r/<token>).
 *
 * Quien abre el enlace no tiene cuenta: el token ES la credencial (192 bits; en
 * la base sólo está su hash). Sólo lectura, y sólo la foto depurada. Un token
 * mal formado, desconocido, vencido o revocado es lo mismo: nada (404).
 */

export interface OpenedReplay {
  shareId: string;
  organizationId: string;
  createdBy: string;
  taskId: string;
  snapshot: ReplaySnapshot;
  expiresAt: string;
  db: SupabaseClient;
}

const VIEW_AUDIT_GAP_MS = 10 * 60_000;

export async function openReplay(
  token: string,
  opts: { now?: Date; count?: boolean } = {},
): Promise<OpenedReplay | null> {
  const now = opts.now ?? new Date();
  if (!SHARE_TOKEN_RE.test(token)) return null;
  // Lectura sin alcance, la única: la fila por hash dice a qué empresa pertenece.
  const { data } = await getSupabaseServiceClient()
    .from('task_shares')
    .select(
      'id, organization_id, task_id, created_by, snapshot, expires_at, revoked_at, view_count, last_viewed_at, background_tasks(conversation_id)',
    )
    .eq('token_hash', hashShareToken(token))
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  if (
    shareState(
      { expiresAt: row.expires_at as string, revokedAt: (row.revoked_at as string) ?? null },
      now,
    ) !== 'active'
  ) {
    return null;
  }
  const snapshot = parseSnapshot(row.snapshot);
  if (!snapshot) return null;
  const db = getOrgScopedClient(row.organization_id as string);
  const last = row.last_viewed_at ? new Date(row.last_viewed_at as string).getTime() : 0;
  const count = opts.count !== false;
  const shouldAudit = count && now.getTime() - last > VIEW_AUDIT_GAP_MS;
  if (count)
    void db
      .from('task_shares')
      .update({ view_count: Number(row.view_count ?? 0) + 1, last_viewed_at: now.toISOString() })
      .eq('id', row.id as string)
      .then(undefined, () => undefined);
  if (shouldAudit) {
    const task = row.background_tasks as { conversation_id?: string | null } | null;
    void auditShare(db, {
      userId: row.created_by as string,
      toolId: 'task.share_view',
      shareId: row.id as string,
      conversationId: task?.conversation_id ?? null,
      metadata: { taskId: row.task_id },
    });
  }
  return {
    shareId: row.id as string,
    organizationId: row.organization_id as string,
    createdBy: row.created_by as string,
    taskId: row.task_id as string,
    snapshot,
    expiresAt: row.expires_at as string,
    db,
  };
}

/** Los bytes de una captura del enlace, o null. */
export async function readReplayShot(opened: OpenedReplay, key: string): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  const { data } = await opened.db
    .from('task_share_shots')
    .select('data_b64')
    .eq('share_id', opened.shareId)
    .eq('shot_key', key)
    .maybeSingle();
  const b64 = (data as { data_b64?: string } | null)?.data_b64;
  return b64 ? Buffer.from(b64, 'base64') : null;
}
