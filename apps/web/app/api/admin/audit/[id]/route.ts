import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import {
  AUDIT_SELECT,
  AUDIT_SELECT_LEGACY,
  type AuditEventRow,
  fetchUserNames,
  normaliseAuditRow,
} from '../../_lib/audit-filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Events shown on each side of the selected one. */
const NEIGHBOURS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadEvent(sb: SupabaseClient, id: string): Promise<AuditEventRow | null> {
  const build = (select: string) =>
    sb.from('audit_events').select(select).eq('id', id).maybeSingle();
  let res = await build(AUDIT_SELECT);
  if (res.error) res = await build(AUDIT_SELECT_LEGACY);
  if (res.error || !res.data) return null;
  return normaliseAuditRow(res.data as unknown as Record<string, unknown>);
}

async function loadNeighbours(
  sb: SupabaseClient,
  opts: { column: string; value: string; pivot: string; direction: 'before' | 'after' },
): Promise<AuditEventRow[]> {
  const ascending = opts.direction === 'after';
  const build = (select: string) => {
    const base = sb.from('audit_events').select(select).eq(opts.column, opts.value);
    const bounded = ascending
      ? base.gt('created_at', opts.pivot)
      : base.lt('created_at', opts.pivot);
    return bounded.order('created_at', { ascending }).limit(NEIGHBOURS);
  };
  let res = await build(AUDIT_SELECT);
  if (res.error) res = await build(AUDIT_SELECT_LEGACY);
  if (res.error || !res.data) return [];
  const rows = (res.data as unknown as Record<string, unknown>[]).map(normaliseAuditRow);
  // "before" comes back newest-first — flip it so the list reads chronologically.
  return ascending ? rows : rows.reverse();
}

/**
 * GET /api/admin/audit/:id
 *
 * One audit event plus the events immediately around it, so an auditor can see
 * the sequence a call belonged to. Scoped to the same conversation when the
 * event has one, otherwise to the same user.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'org_admin') {
    return NextResponse.json({ error: 'Only org admins can read the audit log' }, { status: 403 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sb = getSupabaseServiceClient();
  const event = await loadEvent(sb, id);
  if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const scope = event.conversation_id ? 'conversation' : 'user';
  const column = event.conversation_id ? 'conversation_id' : 'user_id';
  const value = event.conversation_id ?? event.user_id;

  const [before, after] = await Promise.all([
    loadNeighbours(sb, { column, value, pivot: event.created_at, direction: 'before' }),
    loadNeighbours(sb, { column, value, pivot: event.created_at, direction: 'after' }),
  ]);

  const users = await fetchUserNames(
    sb,
    [...before, ...after].map((e) => e.user_id),
  );

  return NextResponse.json({ event, before, after, scope, users });
}
