'use server';

import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { type RecordActivityLine, type RecordRef, recordActivity } from '@/lib/activity/record';
import { applyActivityScope } from '@/lib/activity/scope';
import { isTimelineEvent } from '@/lib/activity/sentences';
import type { ActivityEvent } from '@/lib/activity/types';
import { getOptionalSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { isCompanyManager } from '@cortex/agent-tools';

const COLUMNS =
  'id,user_id,conversation_id,tool_id,status,decision,surface,mandate_id,created_at,metadata';

/**
 * La «Actividad» del panel de una fila: quién hizo o aprobó qué sobre ese
 * registro. Mismo alcance que /actividad: quien administra ve todo; cualquier
 * otra persona sólo lo hecho con su sesión (el filtro va en la consulta).
 * No redirige si no hay sesión (los ejemplos de /v/* no la tienen): devuelve
 * vacío.
 */
export async function loadRecordActivity(
  ref: RecordRef,
): Promise<{ ok: true; lines: RecordActivityLine[] } | { ok: false }> {
  const ids = (ref?.ids ?? []).filter((x) => typeof x === 'string').slice(0, 5);
  const terms = (ref?.terms ?? []).filter((x) => typeof x === 'string').slice(0, 5);
  if (!ids.length && !terms.length) return { ok: true, lines: [] };
  try {
    const user = await getOptionalSession();
    if (!user) return { ok: false };
    const db = getOrgScopedClient(user.organization.id);
    const isManager = user.role === 'org_admin' || (await isCompanyManager(db, user.id));
    const viewer = { id: user.id, isManager };
    const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
    let q = db.from('audit_events').select(COLUMNS).gte('created_at', since);
    q = applyActivityScope(q, viewer).in('status', ['ok', 'error']);
    const { data } = await q.order('created_at', { ascending: false }).limit(800);
    const events = ((data ?? []) as unknown as ActivityEvent[]).filter(isTimelineEvent);
    const names = await fetchUserNames(db, [...new Set(events.map((e) => e.user_id))]);
    return { ok: true, lines: recordActivity(events, { ids, terms }, names) };
  } catch {
    return { ok: false };
  }
}
