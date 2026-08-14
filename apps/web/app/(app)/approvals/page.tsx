import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { Inbox, ShieldAlert, Radar, AlarmClockOff, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { type StatusTone, chipClass } from '@/lib/status-chip';
// La tarjeta se fue a `components/approvals/` cuando el chat empezó a montarla
// también: es la misma decisión en dos sitios y no puede haber dos copias de
// ella. Ver la cabecera del componente.
import { PendingActionCard } from '@/components/approvals/PendingActionCard';
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
  tone: StatusTone;
}) {
  // A section break reads as whitespace plus a soft fade now, not a ruled line
  // underneath the label — the ledger look is what this direction moved away from.
  return (
    <div className="mb-3">
      <div className="field-label flex items-center gap-2 pb-2">
        {icon}
        {children}
        <span className={chipClass(tone)}>{count}</span>
      </div>
      <div className="rule-double" />
    </div>
  );
}

export default async function ApprovalsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

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
      {/*
        The subtitle used to say "todo lo que espera una decisión tuya, en una
        sola fila", and /actions made that untrue: a drafted email waiting on a
        yes is exactly that and is not here. Two options were to merge the
        screens or to stop overclaiming. Merging would have to throw away one of
        two halves that do not fit each other — an approval is a tool call parked
        mid-turn that expires, an action is a draft that keeps being watched
        after it is sent. So the claim narrows to what this page really holds,
        and the queue next door gets a door instead of a footnote: it is the only
        queue in the product with no badge and, until now, no inbound link.
      */}
      <PageHeader
        title="Aprobaciones"
        subtitle="Lo que Cortex quiere hacer y no hace sin tu permiso"
        icon={<Inbox className="h-5 w-5" />}
        actions={
          <Link
            href="/actions"
            className="inline-flex items-center gap-1 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:border-border-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            Lo redactado, en Acciones <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
      />

      {nothingPending ? (
        <Panel className="p-10 text-center text-sm text-ink-muted">
          <Inbox className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="mb-1 text-base font-bold text-ink">No hay nada pendiente</p>
          <p className="mx-auto max-w-md leading-relaxed">
            Aquí aparece lo que Cortex no hace sin permiso: una acción que necesita tu visto bueno,
            un prospecto nuevo por revisar o una rutina que falló. Los correos que ya redactó y
            faltan por mandar están en{' '}
            <Link href="/actions" className="font-semibold text-primary hover:underline">
              Acciones
            </Link>
            .
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
                Confirmaciones pendientes
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
                Prospectos nuevos
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
                Rutinas que fallan
              </SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {failing.map((j) => {
                  const run = j.lastRun;
                  const excerpt =
                    run.error && run.error.length > 180 ? `${run.error.slice(0, 180)}…` : run.error;
                  return (
                    <Panel key={j.id} className="flex flex-col gap-2 p-4">
                      <div className="flex items-start gap-3">
                        <AlarmClockOff className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-ink">{j.name}</div>
                          <div className="tabular text-micro text-ink-faint">
                            La última ejecución falló {relativeTime(run.started_at)}
                          </div>
                        </div>
                      </div>
                      {excerpt && (
                        <p className="rounded-sm border border-rose/30 bg-rose-soft px-2.5 py-1.5 font-mono text-micro leading-snug text-rose">
                          {excerpt}
                        </p>
                      )}
                      <Link
                        href="/schedules"
                        className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-primary transition-colors hover:text-primary-strong"
                      >
                        Revisar en Rutinas <ArrowRight className="h-3.5 w-3.5" />
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
