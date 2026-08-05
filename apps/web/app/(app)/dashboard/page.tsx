import { CopyButton } from '@/components/connect/ConnectCortex';
import { Panel } from '@/components/ui/panel';
import { Field } from '@/components/ui/provenance';
import { getMcpUrl } from '@/lib/mcp-url';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import {
  AlarmClock,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  MessagesSquare,
  Plug,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface RunRow {
  id: string;
  status: string;
  started_at: string;
  output: string | null;
  error: string | null;
  scheduled_jobs: { name: string } | { name: string }[] | null;
}

interface ConversationRow {
  id: string;
  title: string | null;
  updated_at: string;
  agents: { name: string } | { name: string }[] | null;
}

function relName(rel: { name: string } | { name: string }[] | null): string | undefined {
  return Array.isArray(rel) ? rel[0]?.name : rel?.name;
}

export default async function DashboardPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  const [toolCallsRes, signalsRes, approvalsRes, routinesRes, runsRes, convsRes] =
    await Promise.all([
      sb
        .from('audit_events')
        .select('id', { count: 'exact', head: true })
        // Both are bookkeeping rows, not tool calls: counting them would make
        // approving something look like running two things.
        .not('tool_id', 'in', '("__agent_turn","__approval_decision")')
        .gte('created_at', todayStart.toISOString()),
      sb.from('growth_signals').select('id', { count: 'exact', head: true }).eq('status', 'new'),
      sb
        .from('mcp_pending_actions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('decision', null)
        .gt('expires_at', nowIso),
      sb
        .from('scheduled_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'active'),
      sb
        .from('scheduled_job_runs')
        .select('id, status, started_at, output, error, scheduled_jobs!inner(name, user_id)')
        .eq('scheduled_jobs.user_id', user.id)
        .order('started_at', { ascending: false })
        .limit(6),
      sb
        .from('conversations')
        .select('id, title, updated_at, agents(name)')
        .eq('user_id', user.id)
        .neq('surface', 'mcp')
        .order('updated_at', { ascending: false })
        .limit(5),
    ]);

  const toolCallsToday = toolCallsRes.count ?? 0;
  const newSignals = signalsRes.count ?? 0;
  const pendingApprovals = approvalsRes.count ?? 0;
  const activeRoutines = routinesRes.count ?? 0;

  const runs = (runsRes.data ?? []) as unknown as RunRow[];
  const conversations = (convsRes.data ?? []) as unknown as ConversationRow[];

  const firstName = (user.name?.trim() || user.email.split('@')[0] || 'hola').split(/\s+/)[0];
  const needsYou = pendingApprovals + newSignals;

  const mcpUrl = await getMcpUrl();
  const isAdmin = user.role === 'org_admin';

  return (
    <>
      {/* Masthead: the day's figures, read as a form header. */}
      <Panel className="animate-rise mb-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
          <div className="min-w-0">
            <div className="field-label">Espacio de trabajo</div>
            <h1 className="mt-1 text-[22px] font-extrabold tracking-tight text-ink">
              Hola, {firstName}
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              Esto es lo que se movió mientras no estabas.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <Field label="Herramientas hoy">{toolCallsToday.toLocaleString()}</Field>
            <Field label="Prospectos nuevos">
              <span className={newSignals > 0 ? 'text-amber' : undefined}>
                {newSignals.toLocaleString()}
              </span>
            </Field>
            <Field label="Por aprobar">
              <span className={pendingApprovals > 0 ? 'text-amber' : undefined}>
                {pendingApprovals.toLocaleString()}
              </span>
            </Field>
            <Field label="Rutinas activas">{activeRoutines.toLocaleString()}</Field>
          </div>
        </div>
      </Panel>

      {/* Needs you */}
      {needsYou > 0 && (
        <Link
          href="/approvals"
          className="group mb-4 flex items-center gap-3 rounded-card border border-amber/50 bg-amber-soft px-4 py-3 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-amber motion-reduce:transform-none motion-reduce:transition-none"
        >
          <BadgeCheck className="h-4 w-4 shrink-0 text-amber" />
          <div className="min-w-0 flex-1 text-[13px]">
            <span className="font-semibold text-ink">Cortex te está esperando</span>
            <span className="text-ink-muted">
              {' '}
              —{' '}
              {pendingApprovals > 0 && (
                <>
                  <span className="tabular">{pendingApprovals}</span>
                  {pendingApprovals === 1 ? ' acción por aprobar' : ' acciones por aprobar'}
                </>
              )}
              {pendingApprovals > 0 && newSignals > 0 && ' · '}
              {newSignals > 0 && (
                <>
                  <span className="tabular">{newSignals}</span>
                  {newSignals === 1 ? ' prospecto por revisar' : ' prospectos por revisar'}
                </>
              )}
            </span>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-amber transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Latest routine runs */}
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="field-label">Rutinas — últimas ejecuciones</div>
            <Link
              href="/schedules"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-strong"
            >
              Ver las rutinas <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {runs.length === 0 ? (
            <Empty
              title="Ninguna rutina se ha ejecutado"
              body="Una rutina es un trabajo que Cortex ejecuta solo, a la hora que le digas. Pídele una en el chat y sus ejecuciones aparecen aquí."
              action={{ href: '/chat', label: 'Pedirle una rutina a Cortex' }}
            />
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((r) => {
                const excerpt = (r.status === 'error' ? r.error : r.output)?.trim();
                return (
                  <li key={r.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2">
                      <RunStatusChip status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                        {relName(r.scheduled_jobs) ?? 'Rutina'}
                      </span>
                      <span className="tabular shrink-0 text-[11.5px] text-ink-faint">
                        {relativeTime(r.started_at)}
                      </span>
                    </div>
                    {excerpt && (
                      <p
                        className={clsx(
                          'mt-1 line-clamp-2 text-[12px] leading-snug',
                          r.status === 'error' ? 'text-rose' : 'text-ink-muted',
                        )}
                      >
                        {excerpt}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* Recent conversations */}
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="field-label">Conversaciones recientes</div>
            <Link
              href="/chat"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-strong"
            >
              Nuevo chat <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {conversations.length === 0 ? (
            <Empty
              title="Todavía no hay conversaciones"
              body="Aquí queda todo lo que le preguntas a Cortex, con las herramientas que usó para responderte."
              action={{ href: '/chat', label: 'Abrir el chat' }}
            />
          ) : (
            <ul className="divide-y divide-border">
              {conversations.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/chat/${c.id}`}
                    className="flex items-center gap-3 rounded-card px-1.5 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-ink-muted">
                      <MessagesSquare className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">
                        {c.title?.trim() || 'Conversación sin título'}
                      </div>
                      <div className="truncate text-xs text-ink-faint">
                        {relName(c.agents) ?? 'Cortex'}
                      </div>
                    </div>
                    <span className="tabular shrink-0 text-[11.5px] text-ink-faint">
                      {relativeTime(c.updated_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Quick actions */}
      <div className="mt-4">
        <div className="field-label mb-2">Atajos</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <QuickAction href="/chat" icon={<Sparkles className="h-4 w-4" />} label="Nuevo chat" />
          <QuickAction
            href="/pipelines"
            icon={<Workflow className="h-4 w-4" />}
            label="Ejecutar un pipeline"
          />
          <QuickAction
            href="/kb"
            icon={<BookOpen className="h-4 w-4" />}
            label="Buscar en Brain Knowledge"
          />
          <QuickAction
            href="/schedules"
            icon={<AlarmClock className="h-4 w-4" />}
            label="Rutinas"
          />
        </div>
      </div>

      {/* Connect Cortex anywhere — the connector URL lives here because it is the
          one thing people come back for; the per-client walkthrough lives on
          /mcp-tokens so the two surfaces cannot drift apart. */}
      <Panel className="mt-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card border border-border bg-surface-2 text-primary">
              <Plug className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold tracking-tight text-ink">
                Conecta Cortex donde trabajes
              </h2>
              <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
                El mismo cerebro —todas las herramientas, Brain Knowledge, los pipelines y las
                rutinas— dentro de Claude, Claude Code, ChatGPT o cualquier cliente MCP. Corre con
                tus propios permisos y cada acción queda auditada.
              </p>
            </div>
          </div>
          <Link
            href="/mcp-tokens"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
          >
            Configurar un cliente
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="mt-4">
          <div className="field-label">URL del conector</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] font-semibold text-ink">
              {mcpUrl}
            </code>
            <CopyButton text={mcpUrl} label="Copiar la URL" />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-faint">
            Claude te identifica con tu cuenta de Google: no hay ningún token que pegar.{' '}
            <Link href="/mcp-tokens" className="font-semibold text-primary hover:underline">
              Paso a paso para Claude, ChatGPT y Claude Code
            </Link>
            .
          </p>
        </div>

        {/* Trust strip */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[11.5px]">
          <TrustItem
            href="/tools"
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            label="Tu acceso, tus permisos"
          />
          <span className="text-ink-faint">·</span>
          <TrustItem
            href="/approvals"
            icon={<BadgeCheck className="h-3.5 w-3.5" />}
            label="Lo que escribe te lo pregunta antes"
          />
          <span className="text-ink-faint">·</span>
          <TrustItem
            href={isAdmin ? '/admin/audit' : undefined}
            icon={<ScrollText className="h-3.5 w-3.5" />}
            label="Cada acción queda auditada"
          />
        </div>
      </Panel>
    </>
  );
}

function TrustItem({
  href,
  icon,
  label,
}: {
  href?: string;
  icon: React.ReactNode;
  label: string;
}) {
  const body = (
    <>
      <span className="text-primary">{icon}</span>
      {label}
    </>
  );
  if (!href) {
    return <span className="inline-flex items-center gap-1.5 text-ink-muted">{body}</span>;
  }
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-primary"
    >
      {body}
    </Link>
  );
}

/** An empty panel says what belongs there and offers the control that fills it. */
function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { href: string; label: string };
}) {
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-xs text-[12px] leading-relaxed text-ink-muted">{body}</p>
      <Link
        href={action.href}
        className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
      >
        {action.label} <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

/** ok / error / running, in the shared status shape. */
function RunStatusChip({ status }: { status: string }) {
  const tone: StatusTone =
    status === 'ok' ? 'emerald' : status === 'error' ? 'rose' : 'primary';
  const label = status === 'ok' ? 'exitosa' : status === 'error' ? 'falló' : 'corriendo';
  return <span className={chipClass(tone)}>{label}</span>;
}

function QuickAction({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-2.5 rounded-card border border-border bg-surface px-3.5 py-3 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
    >
      <span className="shrink-0 text-primary">{icon}</span>
      <span className="truncate text-[13px] font-semibold text-ink">{label}</span>
      <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}
