import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  AlarmClock,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  Globe,
  History,
  Mail,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  User,
  Wrench,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LiveRelative } from '../_components/LiveRelative';
import { RoutineActions } from '../_components/RoutineActions';
import { RunHistory } from '../_components/RunHistory';
import { RunMarkdown } from '../_components/RunMarkdown';
import { fmtLong, humanizeCron, runDuration, stripMarkdown } from '../_components/format';
import type { JobRun, JobStatus, ScheduledJob } from '../_components/types';

export const dynamic = 'force-dynamic';

/** How far back the history goes on this page — ten times the card's strip. */
const RUN_LIMIT = 50;

const STATUS_STYLES: Record<JobStatus, string> = {
  active: 'bg-emerald-soft text-emerald',
  paused: 'bg-amber-soft text-amber',
  completed: 'bg-surface-2 text-ink-faint',
  cancelled: 'bg-rose-soft text-rose',
};

const SECTION = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint';

/** Mean duration of the finished runs we loaded, e.g. "18.4s". */
function averageDuration(runs: JobRun[]): string | null {
  const spans = runs
    .filter((r) => r.finished_at)
    .map((r) => new Date(r.finished_at as string).getTime() - new Date(r.started_at).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (spans.length === 0) return null;
  const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
  const start = new Date(0).toISOString();
  return runDuration(start, new Date(mean).toISOString());
}

export default async function RoutineDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const { id } = await params;
  const db = getSupabaseServiceClient();

  const { data: row } = await db
    .from('scheduled_jobs')
    .select(
      'id, user_id, name, kind, tool_id, tool_input, instruction, schedule_kind, cron, timezone, run_at, status, next_run_at, last_run_at, allow_unattended_writes, notify_email, conversation_id, recipients, is_global, created_at',
    )
    .eq('id', id)
    .maybeSingle();

  // Same rule as POST /api/schedules/[id]/run: the owner, or anyone when the
  // routine is global. Anything else simply doesn't exist for this visitor.
  if (!row) notFound();
  const ownerId = row.user_id as string;
  const isGlobal = (row.is_global as boolean | null) ?? false;
  const isOwner = ownerId === user.id;
  if (!isOwner && !isGlobal) notFound();

  const [{ data: runRows }, { data: owner }, ok, failed] = await Promise.all([
    db
      .from('scheduled_job_runs')
      .select('id, status, started_at, finished_at, output, error')
      .eq('job_id', id)
      .order('started_at', { ascending: false })
      .limit(RUN_LIMIT),
    db.from('users').select('name, email').eq('id', ownerId).maybeSingle(),
    db
      .from('scheduled_job_runs')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', id)
      .eq('status', 'ok'),
    db
      .from('scheduled_job_runs')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', id)
      .eq('status', 'error'),
  ]);

  const runs = (runRows ?? []) as unknown as JobRun[];
  const okCount = ok.count ?? 0;
  const failedCount = failed.count ?? 0;

  const job: ScheduledJob = {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as ScheduledJob['kind'],
    toolId: (row.tool_id as string | null) ?? null,
    instruction: (row.instruction as string | null) ?? null,
    scheduleKind: row.schedule_kind as ScheduledJob['scheduleKind'],
    cron: (row.cron as string | null) ?? null,
    timezone: row.timezone as string,
    runAt: (row.run_at as string | null) ?? null,
    status: row.status as JobStatus,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    allowUnattendedWrites: row.allow_unattended_writes as boolean,
    notifyEmail: row.notify_email as boolean,
    conversationId: (row.conversation_id as string | null) ?? null,
    recipients: ((row.recipients as string[] | null) ?? []).filter(Boolean),
    isGlobal,
    ownerId,
    runs,
  };

  const toolInput = row.tool_input as unknown;
  const ownerLabel =
    (owner?.name as string | null) ?? (owner?.email as string | null) ?? 'Unknown owner';
  const schedule =
    job.scheduleKind === 'once'
      ? `Once at ${fmtLong(job.runAt)}`
      : humanizeCron(job.cron, job.timezone);

  const lastSuccess = runs.find((r) => r.status === 'ok' && r.output);
  const summary = lastSuccess?.output ? stripMarkdown(lastSuccess.output).slice(0, 420) : null;
  const avg = averageDuration(runs);
  const failing =
    runs.length >= 2 && runs[0]?.status === 'error' && runs[1]?.status === 'error';

  return (
    <>
      <div className="mb-4">
        <Link
          href="/schedules"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Routines
        </Link>
      </div>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
          {job.kind === 'tool' ? <Wrench className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
        </span>

        <div className="min-w-0 flex-1 basis-[18rem]">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
            {job.name}
            <span
              className={`rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${STATUS_STYLES[job.status]}`}
            >
              {job.status}
            </span>
            {job.isGlobal && (
              <span
                className="inline-flex items-center gap-1 rounded-pill bg-primary-soft px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-primary"
                title="Team routine — runs for the whole workspace"
              >
                <Globe className="h-3 w-3" /> global
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
              {job.kind === 'tool' ? 'tool' : 'agent'}
            </span>
            {failing && (
              <span className="inline-flex items-center gap-1 rounded-pill bg-rose-soft px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-rose">
                <TriangleAlert className="h-3 w-3" /> failing
              </span>
            )}
          </h1>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-faint">
            <span className="inline-flex items-center gap-1.5 font-semibold text-ink-muted">
              <AlarmClock className="h-3.5 w-3.5 text-primary" />
              {schedule} · {job.timezone}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {job.status === 'active' && job.nextRunAt ? (
                <>
                  Next {fmtLong(job.nextRunAt)} (<LiveRelative ts={job.nextRunAt} mode="next" />)
                </>
              ) : (
                'No run scheduled'
              )}
            </span>
            <span className="inline-flex items-center gap-1.5" title={`Owner: ${ownerLabel}`}>
              <User className="h-3.5 w-3.5" />
              {ownerLabel}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <History className="h-3.5 w-3.5" />
              Last run {job.lastRunAt ? fmtLong(job.lastRunAt) : 'never'}
            </span>
          </div>
        </div>

        <RoutineActions job={job} canEdit={isOwner || job.isGlobal} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {/* What it does */}
          <Panel className="p-5">
            <div className={`mb-3 ${SECTION}`}>What it does</div>

            {job.kind === 'agent' ? (
              job.instruction ? (
                <RunMarkdown className="rounded-[12px] bg-surface-2 px-3.5 py-3">
                  {job.instruction}
                </RunMarkdown>
              ) : (
                <p className="text-[12.5px] text-ink-faint">No instruction stored.</p>
              )
            ) : (
              <div className="space-y-2">
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-primary-soft px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-primary">
                  <Wrench className="h-3 w-3" />
                  {job.toolId ?? 'unknown tool'}
                </span>
                {toolInput != null && (
                  <pre className="scroll-slim overflow-x-auto rounded-[12px] bg-surface-2 px-3.5 py-3 text-[12px] leading-[1.6] text-ink-muted">
                    {JSON.stringify(toolInput, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <div className="mt-4 space-y-2 border-t border-border pt-3.5">
              <p className="flex items-start gap-2 text-[12.5px] text-ink-muted">
                <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                {job.notifyEmail
                  ? 'Emails the result every time it finishes.'
                  : 'Does not email anyone — results live here and in the conversation.'}
              </p>
              <p className="flex items-start gap-2 text-[12.5px] text-ink-muted">
                <ShieldAlert
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${job.allowUnattendedWrites ? 'text-amber' : 'text-ink-faint'}`}
                />
                {job.allowUnattendedWrites
                  ? 'May run write tools unattended — no human confirms each action.'
                  : 'Read-only: any write tool would wait for a human confirmation.'}
              </p>

              <div className="pt-1">
                <div className={`mb-1.5 ${SECTION}`}>Recipients</div>
                {job.recipients.length === 0 ? (
                  <p className="text-[12px] text-ink-faint">
                    None set — the result goes to the owner only.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {job.recipients.map((r) => (
                      <span
                        key={r}
                        className="inline-flex items-center gap-1 rounded-pill bg-primary-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-primary"
                      >
                        <Mail className="h-3 w-3" />
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {/* Runs */}
          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className={SECTION}>Runs</div>
              <span className="text-[11px] text-ink-faint">
                {runs.length === 0
                  ? 'none yet'
                  : `showing the last ${runs.length}${runs.length === RUN_LIMIT ? ` of ${okCount + failedCount}+` : ''}`}
              </span>
            </div>
            <RunHistory runs={runs} />
          </Panel>
        </div>

        <div className="space-y-4">
          {/* Last successful result */}
          <Panel className="p-4">
            <div className={`mb-2 ${SECTION}`}>Last successful result</div>
            {lastSuccess && summary ? (
              <>
                <p className="text-[12.5px] leading-relaxed text-ink-muted">
                  {summary}
                  {(lastSuccess.output?.length ?? 0) > 420 && '…'}
                </p>
                <p className="mt-2 text-[11px] text-ink-faint">
                  {fmtLong(lastSuccess.started_at)} · <LiveRelative ts={lastSuccess.started_at} />
                </p>
                <Link
                  href={`#run-${lastSuccess.id}`}
                  className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary transition-colors hover:text-primary-strong"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Read the full report
                </Link>
              </>
            ) : (
              <p className="text-[12.5px] text-ink-faint">
                Nothing successful yet — the first good run shows up here.
              </p>
            )}
          </Panel>

          {/* Track record */}
          <Panel className="p-4">
            <div className={`mb-2.5 ${SECTION}`}>Track record</div>
            <ul className="space-y-2 text-[12.5px]">
              <li className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-ink-muted">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald" /> Successful runs
                </span>
                <span className="font-bold text-ink">{okCount}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-ink-muted">
                  <XCircle className="h-3.5 w-3.5 text-rose" /> Failed runs
                </span>
                <span className="font-bold text-ink">{failedCount}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-ink-muted">
                  <Clock className="h-3.5 w-3.5 text-ink-faint" /> Average duration
                </span>
                <span className="font-bold text-ink">{avg ?? '—'}</span>
              </li>
            </ul>
            {okCount + failedCount > 0 && (
              <p className="mt-2.5 border-t border-border pt-2 text-[11px] text-ink-faint">
                {Math.round((okCount / (okCount + failedCount)) * 100)}% of finished runs succeeded
                {avg && ` · average over the last ${runs.length} runs`}
              </p>
            )}
          </Panel>

          {/* Results conversation */}
          {job.conversationId && (
            <Panel className="p-4">
              <div className={`mb-2 ${SECTION}`}>Results conversation</div>
              <p className="mb-2.5 text-[12px] text-ink-faint">
                Every run posts its result into this chat — reply there to dig in.
              </p>
              <Link
                href={`/chat/${job.conversationId}`}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <MessageSquare className="h-3.5 w-3.5" /> Open conversation
              </Link>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
