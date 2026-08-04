import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import {
  type AuditEventRow,
  fetchAuditEvents,
  parseAuditFilters,
  riskSignals,
} from '../../_lib/audit-filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Hard ceiling so an "all time" export can never run away. */
const MAX_ROWS = 10_000;
/** Rows per round trip while streaming. */
const PAGE_SIZE = 1_000;
/** UTF-8 byte-order mark so Excel reads accents correctly. */
const BOM = '\uFEFF';

const COLUMNS = [
  'created_at',
  'user_id',
  'user',
  'tool_id',
  'surface',
  'status',
  'risk_level',
  'decision',
  'risk_reason',
  'risk_signals',
  'latency_ms',
  'conversation_id',
  'agent_id',
  'input_hash',
  'metadata',
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function csvLine(cells: unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

function rowToCells(e: AuditEventRow, users: Record<string, string>): unknown[] {
  return [
    e.created_at,
    e.user_id,
    users[e.user_id] ?? '',
    e.tool_id,
    e.surface ?? '',
    e.status,
    e.risk_level ?? '',
    e.decision ?? '',
    e.risk_reason ?? '',
    riskSignals(e.risk_signals).join(' '),
    e.latency_ms,
    e.conversation_id ?? '',
    e.agent_id ?? '',
    e.input_hash ?? '',
    JSON.stringify(e.metadata ?? {}),
  ];
}

/** Whole user directory in one shot — small table, and every row needs it. */
async function userDirectory(sb: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await sb.from('users').select('id, email, name').limit(2000);
  const rows = (data ?? []) as unknown as Array<{ id: string; email: string; name: string | null }>;
  return Object.fromEntries(rows.map((u) => [u.id, u.name ? `${u.name} <${u.email}>` : u.email]));
}

/**
 * GET /api/admin/audit/export?<audit filters>
 *
 * Streams the current filter set as CSV (org admins only). Accepts exactly the
 * same query params as /admin/audit — status, tool, user, surface, risk,
 * decision, range — so the file always matches what was on screen.
 */
export async function GET(req: NextRequest) {
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Only org admins can export the audit log' },
      { status: 403 },
    );
  }

  const filters = parseAuditFilters(Object.fromEntries(req.nextUrl.searchParams.entries()));
  const sb = getSupabaseServiceClient();
  const users = await userDirectory(sb);

  const encoder = new TextEncoder();
  let offset = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // BOM keeps Excel from mangling non-ASCII names.
      controller.enqueue(encoder.encode(BOM + csvLine([...COLUMNS])));
    },
    async pull(controller) {
      if (offset >= MAX_ROWS) {
        controller.close();
        return;
      }
      const limit = Math.min(PAGE_SIZE, MAX_ROWS - offset);
      const { rows } = await fetchAuditEvents(sb, filters, { limit, offset });
      if (rows.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(rows.map((e) => csvLine(rowToCells(e, users))).join('')));
      offset += rows.length;
      if (rows.length < limit) controller.close();
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit-${filters.range}-${stamp}.csv`;

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
