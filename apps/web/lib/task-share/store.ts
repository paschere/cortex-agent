import 'server-only';
import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { TASK_COLUMNS, type TaskRecord, taskFromRow } from '@/lib/background-tasks/repository';
import { overlayToolResults, parseStoredParts, toolInvocationsOf } from '@/lib/message-parts';
import { browserActorKey } from '@cortex/agent-tools/src/browser/profiles';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ReplayInvocation,
  type ReplaySnapshot,
  SHARE_MAX_ACTIVE_PER_TASK,
  SHARE_MAX_SHOT_BYTES,
  type ShareState,
  type ShotRef,
  buildSnapshot,
  clampShareDays,
  shareExpiry,
  shareState,
} from './shape';
import { hashShareToken, mintShareToken } from './token';

/**
 * Compartir la repetición de una tarea: crear, listar, revocar, y las capturas.
 * La puerta pública (por token) vive en `public.ts`.
 */

export interface ShareRow {
  id: string;
  taskId: string;
  createdBy: string;
  hidePersonal: boolean;
  includeShots: boolean;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  state: ShareState;
  shots: number;
}

const COLS =
  'id, task_id, created_by, hide_personal, include_shots, expires_at, revoked_at, view_count, last_viewed_at, created_at';

export function shareFromRow(r: Record<string, unknown>, shots = 0, now = new Date()): ShareRow {
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const row = {
    id: r.id as string,
    taskId: r.task_id as string,
    createdBy: r.created_by as string,
    hidePersonal: r.hide_personal !== false,
    includeShots: r.include_shots !== false,
    expiresAt: r.expires_at as string,
    revokedAt: s('revoked_at'),
    viewCount: Number(r.view_count ?? 0),
    lastViewedAt: s('last_viewed_at'),
    createdAt: r.created_at as string,
    shots,
  };
  return { ...row, state: shareState(row, now) };
}

/** Una fila de auditoría de compartir / revocar / ver. Nunca lanza. */
export async function auditShare(
  db: SupabaseClient,
  input: {
    userId: string;
    toolId: 'task.share' | 'task.share_revoke' | 'task.share_view';
    shareId: string;
    conversationId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .from('audit_events')
    .insert({
      user_id: input.userId,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      tool_id: input.toolId,
      input_hash: input.shareId,
      status: 'ok',
      latency_ms: 0,
      metadata: input.metadata ?? {},
    })
    .then(undefined, () => undefined);
}

/** Las invocaciones SÓLO de los turnos de la tarea (ver el aviso de privacidad abajo). */
async function taskInvocations(db: SupabaseClient, task: TaskRecord): Promise<ReplayInvocation[]> {
  if (!task.conversationId) return [];
  const { data } = await db
    .from('messages')
    .select('role, parts, tool_results, created_at')
    .eq('conversation_id', task.conversationId)
    .order('created_at', { ascending: true })
    .limit(400);
  const rows = (data ?? []) as Array<{
    role: string;
    parts: unknown;
    tool_results: unknown;
    created_at: string;
  }>;
  // LA VENTANA ES LA DE LA TAREA y nada más: desde su pedido hasta que terminó.
  // Una tarea «continue» nació de un turno del chat: empieza en el último
  // mensaje de la persona antes de encolarse. Lo que se hable después en la
  // conversación no entra.
  let from = new Date(task.queuedAt).getTime() - 60_000;
  if (task.mode === 'continue') {
    const lastUser = [...rows]
      .filter((r) => r.role === 'user' && new Date(r.created_at).getTime() <= from + 60_000)
      .pop();
    if (lastUser) from = new Date(lastUser.created_at).getTime();
  }
  const to = task.finishedAt
    ? new Date(task.finishedAt).getTime() + 60_000
    : Number.POSITIVE_INFINITY;
  const out: ReplayInvocation[] = [];
  for (const r of rows) {
    const at = new Date(r.created_at).getTime();
    if (r.role !== 'assistant' || at < from || at > to) continue;
    const parts = parseStoredParts(r.parts);
    if (!parts) continue;
    for (const inv of toolInvocationsOf(overlayToolResults(parts, r.tool_results))) {
      out.push({
        toolCallId: inv.toolCallId,
        toolName: inv.toolName,
        state: inv.state,
        args: inv.args,
        ...('result' in inv ? { result: (inv as { result?: unknown }).result } : {}),
      });
    }
  }
  return out;
}

/** La captura desde el servicio de navegador, con la llave de la DUEÑA de la tarea. */
async function fetchShot(
  organizationId: string,
  ownerId: string,
  ref: ShotRef,
): Promise<Buffer | null> {
  const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(
      `${base}/session/${encodeURIComponent(ref.sessionId)}/shot/${encodeURIComponent(ref.shotId)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-cortex-owner': browserActorKey(organizationId, ownerId),
        },
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Sólo JPEG chico: cabecera FF D8 y dentro del tope.
    if (buf.length < 4 || buf.length > SHARE_MAX_SHOT_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) {
      return null;
    }
    return buf;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'task share: shot fetch failed');
    return null;
  }
}

export type CreateShareResult =
  | { ok: true; token: string; share: ShareRow }
  | { ok: false; status: number; error: string };

export async function createShare(
  db: SupabaseClient,
  input: {
    organizationId: string;
    companyName: string;
    task: TaskRecord;
    actorId: string;
    days?: unknown;
    hidePersonal?: boolean;
    includeShots?: boolean;
    now?: Date;
  },
): Promise<CreateShareResult> {
  const now = input.now ?? new Date();
  const { task } = input;
  if (task.status === 'queued' || task.status === 'working') {
    return {
      ok: false,
      status: 409,
      error: 'Espera a que la tarea termine o te necesite para compartirla.',
    };
  }
  const { count } = await db
    .from('task_shares')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', task.id)
    .is('revoked_at', null)
    .gt('expires_at', now.toISOString());
  if ((count ?? 0) >= SHARE_MAX_ACTIVE_PER_TASK) {
    return {
      ok: false,
      status: 429,
      error: 'Esta tarea ya tiene muchos enlaces activos. Revoca alguno primero.',
    };
  }

  const hidePersonal = input.hidePersonal !== false;
  const includeShots = input.includeShots !== false;
  const invocations = await taskInvocations(db, task);
  const names = await fetchUserNames(db, [task.userId]);
  const { snapshot, shots } = buildSnapshot({
    title: task.title,
    request: task.prompt,
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    companyName: input.companyName,
    ownerName: names[task.userId]?.split('@')[0] ?? null,
    answer: task.result,
    invocations,
    hidePersonal,
    includeShots,
  });

  // Copiar las capturas ANTES de guardar el enlace: las del servicio caducan.
  const copied: Array<{ key: string; b64: string }> = [];
  for (const ref of shots) {
    const buf = await fetchShot(input.organizationId, task.userId, ref);
    if (buf) copied.push({ key: ref.key, b64: buf.toString('base64') });
  }
  // Los pasos cuya captura ya no existe pierden la referencia.
  const kept = new Set(copied.map((c) => c.key));
  snapshot.steps = snapshot.steps.map((s) =>
    s.shot && !kept.has(s.shot) ? { ...s, shot: null } : s,
  );

  const token = mintShareToken();
  const days = clampShareDays(input.days);
  const { data, error } = await db
    .from('task_shares')
    .insert({
      task_id: task.id,
      created_by: input.actorId,
      token_hash: hashShareToken(token),
      hide_personal: hidePersonal,
      include_shots: includeShots,
      snapshot,
      expires_at: shareExpiry(now, days).toISOString(),
    })
    .select(COLS)
    .single();
  if (error || !data) {
    return { ok: false, status: 500, error: 'No se pudo crear el enlace.' };
  }
  const row = data as Record<string, unknown>;
  if (copied.length > 0) {
    const ins = await db
      .from('task_share_shots')
      .insert(copied.map((c) => ({ share_id: row.id, shot_key: c.key, data_b64: c.b64 })));
    if (ins.error) logger.warn({ err: ins.error.message }, 'task share: shots insert failed');
  }
  const share = shareFromRow(row, copied.length, now);
  await auditShare(db, {
    userId: input.actorId,
    toolId: 'task.share',
    shareId: share.id,
    conversationId: task.conversationId,
    metadata: {
      taskId: task.id,
      days,
      hidePersonal,
      includeShots,
      shots: copied.length,
      steps: snapshot.steps.length,
    },
  });
  return { ok: true, token, share };
}

export async function listShares(db: SupabaseClient, taskId: string, now = new Date()) {
  const { data } = await db
    .from('task_shares')
    .select(COLS)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(30);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = rows.map((r) => r.id as string);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: shots } = await db
      .from('task_share_shots')
      .select('share_id')
      .in('share_id', ids);
    for (const s of (shots ?? []) as Array<{ share_id: string }>) {
      counts.set(s.share_id, (counts.get(s.share_id) ?? 0) + 1);
    }
  }
  return rows.map((r) => shareFromRow(r, counts.get(r.id as string) ?? 0, now));
}

export async function loadShare(db: SupabaseClient, shareId: string) {
  const { data } = await db.from('task_shares').select(COLS).eq('id', shareId).maybeSingle();
  return data ? shareFromRow(data as Record<string, unknown>) : null;
}

export async function revokeShare(
  db: SupabaseClient,
  input: { shareId: string; actorId: string; conversationId?: string | null },
): Promise<boolean> {
  const { data, error } = await db
    .from('task_shares')
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.actorId })
    .eq('id', input.shareId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error || !data) return false;
  // Las capturas ya no tienen para qué quedarse.
  await db.from('task_share_shots').delete().eq('share_id', input.shareId);
  await auditShare(db, {
    userId: input.actorId,
    toolId: 'task.share_revoke',
    shareId: input.shareId,
    conversationId: input.conversationId ?? null,
  });
  return true;
}

export async function loadTaskById(db: SupabaseClient, id: string): Promise<TaskRecord | null> {
  const { data } = await db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  return data ? taskFromRow(data as Record<string, unknown>) : null;
}

export type { ReplaySnapshot };
