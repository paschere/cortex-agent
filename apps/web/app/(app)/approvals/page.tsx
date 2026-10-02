// La tarjeta se fue a `components/approvals/` cuando el chat empezó a montarla
// también: es la misma decisión en dos sitios y no puede haber dos copias de
// ella. Ver la cabecera del componente.
import { PendingActionCard } from '@/components/approvals/PendingActionCard';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { findPriorAction } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlarmClockOff, ArrowRight, Inbox, Radar, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
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
  // Un título de sección de verdad (h2, 18px, extrabold) con su cifra en una
  // píldora mono: en el lienzo del autoservicio la jerarquía la llevan el
  // tamaño y el peso, no una etiqueta pequeña en mayúsculas sobre una raya.
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-2">
        {icon}
      </span>
      <h2 className="text-lg font-extrabold tracking-tight text-ink">{children}</h2>
      <span className={clsx(chipClass(tone), 'tabular')}>{count}</span>
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
      // Activation approvals are rendered in ActivationExecution, whose
      // button claims the same queue row and then performs the required GET
      // verification. Keep them out of this generic executor card.
      .or(
        `and(decision.is.null,expires_at.gt.${nowIso},staged_via.is.null),and(decision.is.null,expires_at.gt.${nowIso},staged_via.neq.activation),and(decided_at.gt.${decidedSince},staged_via.is.null),and(decided_at.gt.${decidedSince},staged_via.neq.activation)`,
      )
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
  // Acciones seguras de repetir (0168): si una pendiente repite algo que esta
  // misma persona ya hizo dentro de la ventana, la tarjeta lo dice ANTES del
  // botón, y aprobarla es repetir a sabiendas. Sólo lectura; en la duda, nada.
  const repeatOf = new Map<string, string>();
  await Promise.all(
    pending.map(async (p) => {
      const prior = await findPriorAction({
        db,
        organizationId: user.organization.id,
        userId: user.id,
        toolId: p.tool_id,
        input: p.input,
      }).catch(() => null);
      if (prior) repeatOf.set(p.id, prior.at);
    }),
  );
  const signals = (signalsRes.data ?? []) as unknown as SignalRow[];
  const failing = ((jobsRes.data ?? []) as unknown as JobRow[])
    .map((j) => ({ id: j.id, name: j.name, lastRun: j.scheduled_job_runs?.[0] }))
    .filter(
      (j): j is { id: string; name: string; lastRun: JobRunRow } => j.lastRun?.status === 'error',
    );

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
        <Panel className="px-6 py-12 text-center text-sm text-ink-muted">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-card bg-emerald-soft text-emerald">
            <Inbox className="h-6 w-6" />
          </span>
          <p className="mb-1 text-lg font-extrabold tracking-tight text-ink">
            Nada espera tu permiso
          </p>
          <p className="mx-auto max-w-md leading-relaxed">
            Cuando Cortex quiera mandar un correo, escribir en una tabla o cambiar algo por ti, te
            lo pregunta aquí primero. También verás los prospectos nuevos y las rutinas que fallen.
            Los correos que ya redactó y faltan por mandar están en{' '}
            <Link href="/actions" className="font-semibold text-primary hover:underline">
              Acciones
            </Link>
            .
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Link
              href={`/chat?prompt=${encodeURIComponent('Redacta un correo cordial para un cliente que tiene una factura vencida, y muéstramelo antes de enviarlo.')}`}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-primary-strong"
            >
              Pedirle a Cortex que redacte algo
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/procesos"
              className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-5 py-2 text-sm font-bold text-ink transition-colors hover:bg-surface-2"
            >
              Activar un proceso
            </Link>
          </div>
        </Panel>
      ) : (
        <div className="space-y-8">
          {/* Pending confirmations: amber = requires a human decision */}
          {approvalRows.length > 0 && (
            <section>
              <SectionLabel
                icon={<ShieldAlert className="h-4 w-4 text-amber" />}
                count={pending.length}
                tone="amber"
              >
                Esperan tu permiso
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
                    repeatOfAt={repeatOf.get(p.id) ?? null}
                  />
                ))}
              </div>
            </section>
          )}

          {/* New growth signals: team-wide triage queue */}
          {signals.length > 0 && (
            <section>
              <SectionLabel
                icon={<Radar className="h-4 w-4 text-primary" />}
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
                icon={<AlarmClockOff className="h-4 w-4 text-rose" />}
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
                    <Panel key={j.id} className="flex flex-col gap-2.5 p-5">
                      <div className="flex items-start gap-3">
                        <AlarmClockOff className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-ink">{j.name}</div>
                          <div className="tabular text-micro text-ink-faint">
                            La última ejecución falló {relativeTime(run.started_at)}
                          </div>
                        </div>
                      </div>
                      {/* El error crudo es para quien lo diagnostica: plegado. Lo
                          que se ofrece primero es pedirle a Cortex que lo lea. */}
                      {excerpt && (
                        <details className="text-micro">
                          <summary className="cursor-pointer font-semibold text-ink-muted hover:text-ink">
                            Ver el error
                          </summary>
                          <p className="mt-1.5 rounded-sm border border-rose/30 bg-rose-soft px-2.5 py-1.5 font-mono leading-snug text-rose">
                            {excerpt}
                          </p>
                        </details>
                      )}
                      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1">
                        <Link
                          href={`/chat?prompt=${encodeURIComponent(`La rutina «${j.name}» falló. Revisa qué pasó y dime cómo arreglarla.`)}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-primary transition-colors hover:text-primary-strong"
                        >
                          Que Cortex lo revise <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          href="/schedules"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
                        >
                          Ver en Rutinas
                        </Link>
                      </div>
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
