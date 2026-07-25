import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { BarChart3, Zap, AlertTriangle, Users, Timer, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';

interface AuditEvent {
  user_id: string;
  tool_id: string;
  status: string;
  latency_ms: number;
  created_at: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

export const dynamic = 'force-dynamic';

const RANGES = [7, 14, 30] as const;

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysParam } = await searchParams;
  const days = RANGES.includes(Number(daysParam) as (typeof RANGES)[number])
    ? Number(daysParam)
    : 7;

  const sb = getSupabaseServiceClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: events } = await sb
    .from('audit_events')
    .select('user_id, tool_id, status, latency_ms, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5000);

  const rows: AuditEvent[] = (events ?? []) as AuditEvent[];

  // Aggregations
  const byTool: Record<string, { count: number; errors: number; latencies: number[] }> = {};
  const byUser: Record<string, number> = {};
  const byDay: Record<string, { ok: number; error: number }> = {};
  let okCount = 0;
  let errorCount = 0;
  const allLatencies: number[] = [];

  for (const e of rows) {
    const t = (byTool[e.tool_id] ??= { count: 0, errors: 0, latencies: [] });
    t.count += 1;
    if (e.status === 'error') {
      t.errors += 1;
      errorCount += 1;
    } else if (e.status === 'ok') {
      okCount += 1;
    }
    if (e.latency_ms > 0) {
      t.latencies.push(e.latency_ms);
      allLatencies.push(e.latency_ms);
    }
    byUser[e.user_id] = (byUser[e.user_id] ?? 0) + 1;
    const day = e.created_at.slice(0, 10);
    const d = (byDay[day] ??= { ok: 0, error: 0 });
    if (e.status === 'error') d.error += 1;
    else d.ok += 1;
  }

  const pct = (arr: number[], p: number) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };

  const successRate = okCount + errorCount > 0 ? Math.round((okCount / (okCount + errorCount)) * 100) : 100;
  const p50 = pct(allLatencies, 0.5);
  const p95 = pct(allLatencies, 0.95);

  const userIds = Object.keys(byUser);
  let userMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await sb.from('users').select('id, email, name').in('id', userIds);
    userMap = Object.fromEntries(
      ((users ?? []) as UserRow[]).map((u) => [u.id, u.name || u.email]),
    );
  }

  const toolEntries = Object.entries(byTool).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  const maxToolCount = toolEntries[0]?.[1].count ?? 1;
  const userEntries = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxUserCount = userEntries[0]?.[1] ?? 1;

  // Day series, oldest → newest, filling gaps
  const daySeries: Array<{ day: string; ok: number; error: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    daySeries.push({ day, ok: byDay[day]?.ok ?? 0, error: byDay[day]?.error ?? 0 });
  }
  const maxDay = Math.max(1, ...daySeries.map((d) => d.ok + d.error));

  const stats = [
    { label: 'Tool calls', value: String(rows.length), icon: Zap },
    { label: 'Success rate', value: `${successRate}%`, icon: CheckCircle2 },
    { label: 'Errors', value: String(errorCount), icon: AlertTriangle },
    { label: 'Active users', value: String(userIds.length), icon: Users },
    { label: 'Latency p50 / p95', value: `${p50}ms / ${p95}ms`, icon: Timer },
  ];

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle={`Tool activity across every surface — last ${days} days`}
        icon={<BarChart3 className="h-5 w-5" />}
      />

      <div className="mb-4 flex gap-2 text-xs">
        {RANGES.map((r) => (
          <Link
            key={r}
            href={`/admin/usage?days=${r}`}
            className={
              days === r
                ? 'rounded-pill bg-primary px-3 py-1 font-bold text-white'
                : 'rounded-pill bg-surface-2 px-3 py-1 font-semibold text-ink-muted hover:text-ink'
            }
          >
            {r}d
          </Link>
        ))}
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {stats.map((s) => (
            <Panel key={s.label} className="flex items-center gap-3 p-3.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                <s.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-extrabold leading-tight text-ink">{s.value}</div>
                <div className="truncate text-[10.5px] text-ink-faint">{s.label}</div>
              </div>
            </Panel>
          ))}
        </div>

        {/* Daily activity */}
        <Panel className="p-4">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Daily activity
          </div>
          <div className="flex h-28 items-end gap-1">
            {daySeries.map((d) => {
              const total = d.ok + d.error;
              const h = Math.round((total / maxDay) * 100);
              const errH = total > 0 ? Math.round((d.error / total) * h) : 0;
              return (
                <div
                  key={d.day}
                  className="group relative flex-1"
                  title={`${d.day}: ${total} calls (${d.error} errors)`}
                >
                  <div className="flex h-28 flex-col justify-end overflow-hidden rounded-t-[4px]">
                    <div className="w-full bg-rose" style={{ height: `${errH}%` }} />
                    <div className="w-full bg-primary" style={{ height: `${Math.max(total > 0 ? 2 : 0, h - errH)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-ink-faint">
            <span>{daySeries[0]?.day}</span>
            <span>{daySeries[daySeries.length - 1]?.day}</span>
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* By tool */}
          <Panel className="p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Top tools
            </div>
            {toolEntries.length === 0 ? (
              <p className="text-[12.5px] text-ink-faint">No activity in this window.</p>
            ) : (
              <ul className="space-y-2">
                {toolEntries.map(([tool, t]) => {
                  const avg = t.latencies.length
                    ? Math.round(t.latencies.reduce((a, b) => a + b, 0) / t.latencies.length)
                    : 0;
                  return (
                    <li key={tool}>
                      <div className="mb-0.5 flex items-center justify-between text-[11.5px]">
                        <span className="truncate font-mono font-semibold text-ink">{tool}</span>
                        <span className="shrink-0 text-ink-faint">
                          {t.count}× · {avg}ms
                          {t.errors > 0 && <span className="ml-1 text-rose">· {t.errors} err</span>}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={t.errors > 0 ? 'h-full rounded-full bg-amber' : 'h-full rounded-full bg-primary'}
                          style={{ width: `${Math.max(3, Math.round((t.count / maxToolCount) * 100))}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          {/* By user */}
          <Panel className="p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              By teammate
            </div>
            {userEntries.length === 0 ? (
              <p className="text-[12.5px] text-ink-faint">No activity in this window.</p>
            ) : (
              <ul className="space-y-2">
                {userEntries.map(([userId, count]) => (
                  <li key={userId}>
                    <div className="mb-0.5 flex items-center justify-between text-[11.5px]">
                      <span className="truncate font-semibold text-ink">
                        {userMap[userId] ?? userId.slice(0, 8)}
                      </span>
                      <span className="shrink-0 text-ink-faint">{count} calls</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(3, Math.round((count / maxUserCount) * 100))}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
