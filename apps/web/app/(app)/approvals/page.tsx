import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { Inbox, ShieldAlert, Radar, AlarmClockOff, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { PendingActionCard } from './_components/PendingActionCard';
import { SignalCard } from './_components/SignalCard';

interface PendingActionRow {
  id: string;
  tool_id: string;
  input: unknown;
  created_at: string;
  expires_at: string;
  decision: 'approved' | 'declined' | null;
  decided_at: string | null;
  decided_via: string | null;
}

/**
 * How long an already-answered approval keeps a place in the queue.
 *
 * It is here for one reason: the same approval can now be answered from a
 * button in Google Chat, and the email that went out points at this page. Someone
 * who approves in Chat and then opens the link must see "you already approved
 * this" — not an empty queue, and certainly not a second Approve button.
 */
const RECENTLY_DECIDED_MS = 60 * 60_000;

interface SignalRow {
  id: string;
  company: string;
  role_title: string;
  url: string;
  source: string;
  summary: string | null;
}

interface JobRunRow {
  status: string;
  error: string | null;
  started_at: string;
}

interface JobRow {
  id: string;
  name: string;
  scheduled_job_runs: JobRunRow[];
}

export const dynamic = 'force-dynamic';

function SectionLabel({
  icon,
  children,
  count,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  count: number;
  tone: 'amber' | 'primary' | 'rose';
}) {
  const badge = {
    amber: 'bg-amber-soft text-amber',
    primary: 'bg-primary-soft text-primary',
    rose: 'bg-rose-soft text-rose',
  }[tone];
  return (
    <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
      {icon}
      {children}
      <span className={`rounded-pill px-1.5 py-0.5 text-[10px] font-bold ${badge}`}>{count}</span>
    </div>
  );
}

export default async function ApprovalsPage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const nowIso = new Date().toISOString();
  const decidedSince = new Date(Date.now() - RECENTLY_DECIDED_MS).toISOString();

  const [pendingRes, signalsRes, jobsRes] = await Promise.all([
    db
      .from('mcp_pending_actions')
      .select('id, tool_id, input, created_at, expires_at, decision, decided_at, decided_via')
      .eq('user_id', user.id)
      .or(`and(decision.is.null,expires_at.gt.${nowIso}),decided_at.gt.${decidedSince}`)
      .order('created_at', { ascending: false }),
    db
      .from('growth_signals')
      .select('id, company, role_title, url, source, summary')
      .eq('status', 'new')
      .order('created_at', { ascending: false }),
    db
      .from('scheduled_jobs')
      .select('id, name, scheduled_job_runs(status, error, started_at)')
      .eq('user_id', user.id)
      .order('started_at', { referencedTable: 'scheduled_job_runs', ascending: false })
      .limit(1, { foreignTable: 'scheduled_job_runs' }),
  ]);

  const approvalRows = (pendingRes.data ?? []) as unknown as PendingActionRow[];
  // Answered ones stay visible but are never actionable — see RECENTLY_DECIDED_MS.
  const pending = approvalRows.filter((r) => !r.decision);
  const decided = approvalRows.filter((r) => r.decision);
  const signals = (signalsRes.data ?? []) as unknown as SignalRow[];
  const failing = ((jobsRes.data ?? []) as unknown as JobRow[])
    .map((j) => ({ id: j.id, name: j.name, lastRun: j.scheduled_job_runs?.[0] }))
    .filter((j): j is { id: string; name: string; lastRun: JobRunRow } => j.lastRun?.status === 'error');

  const nothingPending = approvalRows.length === 0 && signals.length === 0 && failing.length === 0;

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Every decision and confirmation waiting on you, in one queue"
        icon={<Inbox className="h-5 w-5" />}
      />

      {nothingPending ? (
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          <Inbox className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="mb-1 font-semibold text-ink">All clear — Cortex keeps working ⚡</p>
          <p className="mx-auto max-w-md">
            When Cortex needs your sign-off — a gated action, a fresh growth signal, or a routine
            that hit an error — it shows up here.
          </p>
        </Panel>
      ) : (
        <div className="space-y-8">
          {/* Pending confirmations: amber = requires a human decision */}
          {approvalRows.length > 0 && (
            <section>
              <SectionLabel
                icon={<ShieldAlert className="h-3.5 w-3.5 text-amber" />}
                count={pending.length}
                tone="amber"
              >
                Pending confirmations
              </SectionLabel>
              <div className="space-y-3">
                {[...pending, ...decided].map((p) => (
                  <PendingActionCard
                    key={p.id}
                    id={p.id}
                    toolId={p.tool_id}
                    input={p.input}
                    expiresAt={p.expires_at}
                    decision={p.decision}
                    decidedAt={p.decided_at}
                    decidedVia={p.decided_via}
                  />
                ))}
              </div>
            </section>
          )}

          {/* New growth signals: team-wide triage queue */}
          {signals.length > 0 && (
            <section>
              <SectionLabel
                icon={<Radar className="h-3.5 w-3.5 text-primary" />}
                count={signals.length}
                tone="primary"
              >
                New growth signals
              </SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {signals.map((s) => (
                  <SignalCard
                    key={s.id}
                    id={s.id}
                    company={s.company}
                    roleTitle={s.role_title}
                    url={s.url}
                    source={s.source}
                    summary={s.summary}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Failing routines: rose = errors, read-only pointers to /schedules */}
          {failing.length > 0 && (
            <section>
              <SectionLabel
                icon={<AlarmClockOff className="h-3.5 w-3.5 text-rose" />}
                count={failing.length}
                tone="rose"
              >
                Failing routines
              </SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {failing.map((j) => {
                  const run = j.lastRun;
                  const excerpt =
                    run.error && run.error.length > 180 ? `${run.error.slice(0, 180)}…` : run.error;
                  return (
                    <Panel key={j.id} className="flex flex-col gap-2 p-4">
                      <div className="flex items-start gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-rose-soft text-rose">
                          <AlarmClockOff className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-bold text-ink">{j.name}</div>
                          <div className="text-[11.5px] text-ink-faint">
                            last run failed {relativeTime(run.started_at)}
                          </div>
                        </div>
                      </div>
                      {excerpt && (
                        <p className="rounded-[8px] border border-rose/20 bg-rose-soft px-2.5 py-1.5 font-mono text-[11px] leading-snug text-rose">
                          {excerpt}
                        </p>
                      )}
                      <Link
                        href="/schedules"
                        className="mt-auto inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:text-primary-strong"
                      >
                        Review in Routines <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </Panel>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
