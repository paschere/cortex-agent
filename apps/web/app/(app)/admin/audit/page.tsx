import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { clsx } from 'clsx';
import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';

interface AuditEvent {
  id: string;
  user_id: string;
  tool_id: string;
  status: string;
  latency_ms: number;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

export const dynamic = 'force-dynamic';

const STATUS_FILTERS = ['all', 'ok', 'error', 'confirmation_required', 'rate_limited'] as const;

const STATUS_PILL: Record<string, string> = {
  ok: 'bg-emerald-soft text-emerald',
  error: 'bg-rose-soft text-rose',
  confirmation_required: 'bg-amber-soft text-amber',
  rate_limited: 'bg-amber-soft text-amber',
};

function metaSummary(e: AuditEvent): string | null {
  const m = e.metadata ?? {};
  if (typeof m.error === 'string') return m.error;
  if (typeof m.reason === 'string') {
    return m.reason === 'missing_scopes'
      ? `missing ${String(m.provider ?? '')} scopes: ${Array.isArray(m.scopes) ? m.scopes.join(', ') : ''}`
      : String(m.reason);
  }
  if (e.tool_id === '__agent_turn') {
    const tin = Number(m.tokensIn ?? 0);
    const tout = Number(m.tokensOut ?? 0);
    if (tin || tout) return `${m.model ?? ''} · ${tin} in / ${tout} out tokens`;
  }
  return null;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; tool?: string; user?: string }>;
}) {
  const { status = 'all', tool = '', user: userFilter = '' } = await searchParams;
  const sb = getSupabaseServiceClient();

  let q = sb
    .from('audit_events')
    .select('id, user_id, tool_id, status, latency_ms, created_at, metadata')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status !== 'all') q = q.eq('status', status);
  if (tool) q = q.like('tool_id', `${tool}%`);
  if (userFilter) q = q.eq('user_id', userFilter);

  const { data: events } = await q;
  const rows: AuditEvent[] = (events ?? []) as AuditEvent[];

  const userIds = [...new Set(rows.map((e) => e.user_id))];
  let userMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await sb.from('users').select('id, email, name').in('id', userIds);
    userMap = Object.fromEntries(((users ?? []) as UserRow[]).map((u) => [u.id, u.name || u.email]));
  }

  const counts: Record<string, number> = {};
  for (const e of rows) counts[e.status] = (counts[e.status] ?? 0) + 1;

  const families = [...new Set(rows.map((e) => e.tool_id.split('.')[0] ?? ''))].sort();

  const qs = (patch: Record<string, string>) => {
    const params = new URLSearchParams();
    const merged = { status, tool, user: userFilter, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && v !== 'all') params.set(k, v);
    const s = params.toString();
    return `/admin/audit${s ? `?${s}` : ''}`;
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every tool call, by everyone, on every surface — who asked, what ran, what happened"
        icon={<ScrollText className="h-5 w-5" />}
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[11.5px]">
        {STATUS_FILTERS.map((s) => (
          <Link
            key={s}
            href={qs({ status: s })}
            className={clsx(
              'rounded-pill px-2.5 py-1 font-semibold',
              status === s
                ? 'bg-primary text-white'
                : 'bg-surface-2 text-ink-muted hover:text-ink',
            )}
          >
            {s === 'all' ? 'All' : s.replaceAll('_', ' ')}
            {s !== 'all' && counts[s] ? ` (${counts[s]})` : ''}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <Link
          href={qs({ tool: '' })}
          className={clsx(
            'rounded-pill px-2.5 py-1 font-semibold',
            !tool ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted hover:text-ink',
          )}
        >
          all tools
        </Link>
        {families.slice(0, 10).map((f) => (
          <Link
            key={f}
            href={qs({ tool: f })}
            className={clsx(
              'rounded-pill px-2.5 py-1 font-mono font-semibold',
              tool === f ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted hover:text-ink',
            )}
          >
            {f}
          </Link>
        ))}
        {userFilter && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <span className="rounded-pill bg-primary-soft px-2.5 py-1 font-semibold text-primary">
              {userMap[userFilter] ?? userFilter.slice(0, 8)}
            </span>
            <Link href={qs({ user: '' })} className="text-ink-faint hover:text-ink">
              ✕ clear
            </Link>
          </>
        )}
      </div>

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-ink-faint">
            No events match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="border-b border-border bg-surface-2/60">
                <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                  <th className="px-4 py-2.5 font-semibold">When</th>
                  <th className="px-4 py-2.5 font-semibold">Who</th>
                  <th className="px-4 py-2.5 font-semibold">Tool</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Latency</th>
                  <th className="px-4 py-2.5 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const detail = metaSummary(e);
                  return (
                    <tr key={e.id} className="border-t border-border align-top hover:bg-surface-2/40">
                      <td
                        className="whitespace-nowrap px-4 py-2 text-ink-faint"
                        title={new Date(e.created_at).toLocaleString()}
                      >
                        {relativeTime(e.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <Link href={qs({ user: e.user_id })} className="font-semibold text-ink hover:text-primary">
                          {userMap[e.user_id] ?? e.user_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-ink">
                        {e.tool_id === '__agent_turn' ? (
                          <span className="text-ink-faint">chat turn</span>
                        ) : (
                          e.tool_id
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <span
                          className={clsx(
                            'rounded-pill px-2 py-0.5 text-[10px] font-bold uppercase',
                            STATUS_PILL[e.status] ?? 'bg-surface-2 text-ink-faint',
                          )}
                        >
                          {e.status.replaceAll('_', ' ')}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-ink-faint">
                        {e.latency_ms > 0 ? `${e.latency_ms}ms` : '—'}
                      </td>
                      <td className="max-w-[340px] px-4 py-2 text-ink-muted">
                        {detail ? <span className="line-clamp-2">{detail}</span> : <span className="text-ink-faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="mt-2 text-[11px] text-ink-faint">
        Showing the {rows.length} most recent events{status !== 'all' ? ` with status "${status}"` : ''}
        {tool ? ` in ${tool}.*` : ''}.
      </p>
    </>
  );
}
