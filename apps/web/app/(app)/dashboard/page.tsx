import { CopyButton } from '@/components/connect/ConnectCortex';
import { Panel } from '@/components/ui/panel';
import { readInsights } from '@/lib/insights';
import { readJournal } from '@/lib/journal';
import { getMcpUrl } from '@/lib/mcp-url';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readWaitingIndex } from '@/lib/waiting';
import { readOnboarding } from '@cortex/agent-tools';
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
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { DayJournal } from './_components/DayJournal';
import { Insights } from './_components/Insights';
import { WaitingIndex } from './_components/WaitingIndex';

/**
 * INICIO ES «LO QUE TE ESPERA», NO UN TABLERO.
 *
 * Aquí aterriza quien abre /dashboard a propósito. El hop de `/` ya no manda
 * aquí: manda al chat. Hasta ahora esta pantalla contaba aprobaciones y prospectos y dejaba fuera tres colas enteras — vencimientos,
 * correos redactados y encargos atascados — que los crons nocturnos llenan
 * solos y que nadie ve hasta que abre la pantalla donde cayeron. Un borrador
 * puede llevar nueve días ahí sin que nada lo diga.
 *
 * Lo primero de la página es una FRASE, no una cuadrícula: «Tres cosas te
 * esperan y una lleva nueve días». Se escribe con reglas en `waiting-shape.ts`
 * y se prueba caso por caso; ningún modelo interviene, porque esta pantalla se
 * dibuja en cada carga y una frase generada sería cara, lenta y distinta cada
 * vez para los mismos datos.
 */

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

  // A NEW COMPANY NEVER LANDS HERE.
  //
  // `/` redirects to this page, so before the guide existed the first screen of
  // a brand-new workspace was four zeros and two empty panels — a product that
  // cannot show what it is for and gives no clue what to do about it. Somebody
  // whose only step is still "answer one question" is sent to the guide instead,
  // and stays sent until they finish it or close it themselves.
  //
  // Costs one indexed read on a table with one row per workspace, and returns
  // `show: false` for every workspace that has ever done anything — including,
  // by way of migration 0085 § 8, every workspace that existed before it.
  const onboarding = await readOnboarding(sb);
  if (onboarding.show) redirect('/onboarding');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [waiting, journal, toolCallsRes, signalsRes, routinesRes, runsRes, convsRes] =
    await Promise.all([
      // El índice de las cuatro colas. Los conteos salen de `countNavSignals`,
      // el mismo que dibuja los badges del menú, así que la barra lateral y
      // esta pantalla no pueden discrepar sobre cuánto trabajo hay parado.
      readWaitingIndex(user.organization.id, user.id),
      // La otra mitad: lo que Cortex hizo anoche y hoy. Cada clase de actividad
      // se recoge sola dentro de `readJournal`, así que esta promesa no puede
      // rechazar por una tabla caída — devuelve la jornada con el hueco dicho.
      readJournal(user.organization.id, user.id, { isAdmin: user.role === 'org_admin' }),
      sb
        .from('audit_events')
        .select('id', { count: 'exact', head: true })
        // Both are bookkeeping rows, not tool calls: counting them would make
        // approving something look like running two things.
        .not('tool_id', 'in', '("__agent_turn","__approval_decision")')
        // La fila de intención (0118) precede a la de resultado de la MISMA
        // llamada; contarla haría parecer dos acciones donde hubo una.
        .neq('status', 'attempted')
        .gte('created_at', todayStart.toISOString()),
      sb.from('growth_signals').select('id', { count: 'exact', head: true }).eq('status', 'new'),
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
  const pendingApprovals = waiting.counts.approvals;
  const activeRoutines = routinesRes.count ?? 0;

  const runs = (runsRes.data ?? []) as unknown as RunRow[];
  const conversations = (convsRes.data ?? []) as unknown as ConversationRow[];

  const firstName = (user.name?.trim() || user.email.split('@')[0] || 'hola').split(/\s+/)[0];
  const todayLabel = new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Bogota',
  }).format(new Date());

  const mcpUrl = await getMcpUrl();
  const isAdmin = user.role === 'org_admin';

  return (
    <>
      {/* Masthead: el escritorio abre con UNA cosa que manda — la frase. */}
      <Panel className="animate-rise mb-4 overflow-hidden">
        <div className="desk-sky px-5 pb-4 pt-5 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <p className="text-sm font-semibold text-ink-muted">Hola, {firstName}</p>
            <p className="tabular text-micro text-ink-faint">{todayLabel}</p>
          </div>
          {/* LA FRASE, ahora con el cuerpo de un titular. Es lo único de la
              pantalla que se lee sin buscarlo, así que lleva el tamaño de
              página entero; el saludo y la fecha la acompañan en chico. La
              escribe `summarizeWaiting` a partir de los conteos y de dos
              hechos —qué se venció y qué lleva más esperando—; ni una palabra
              sale de un modelo. */}
          <h1
            className={clsx(
              'mt-1.5 max-w-3xl text-pretty leading-snug tracking-tight',
              waiting.total > 0
                ? 'text-xl font-extrabold text-ink'
                : 'text-lg font-bold text-ink-muted',
            )}
          >
            {waiting.sentence}
          </h1>
        </div>
        <div className="rule-double" />
        {/* El pulso: cuatro cifras en celdas partidas por filos de un píxel —
            la misma retícula que usan las colas de abajo — en vez de cuatro
            pares etiqueta-número flotando. El ámbar sólo se enciende cuando
            la cifra pide una mirada. */}
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          <PulseCell label="Herramientas hoy" value={toolCallsToday} />
          <PulseCell label="Prospectos nuevos" value={newSignals} attention={newSignals > 0} />
          <PulseCell label="Por aprobar" value={pendingApprovals} attention={pendingApprovals > 0} />
          <PulseCell label="Rutinas activas" value={activeRoutines} />
        </div>
      </Panel>

      {/* LAS DOS MITADES, UNA AL LADO DE OTRA.
          A la izquierda, lo que espera a esta persona: el índice de las cuatro
          colas, que NO es una tabla fusionada — cada una conserva su nombre, su
          verbo y su enlace (ver la cabecera de lib/waiting.ts).
          A la derecha, lo que hizo Cortex. Durante meses sólo existió la
          izquierda, y esa asimetría era todo el problema: una pantalla que sólo
          sabe enumerar deuda de quien mira se lee como alguien que reparte
          tareas, no como alguien que las hace. Las dos columnas cuestan lecturas
          independientes y ninguna puede tumbar a la otra.
          El reparto es 5/4 y no mitad y mitad: lo que espera DECISIÓN manda
          sobre lo que ya se hizo — la jerarquía del escritorio es esa — pero
          las dos siguen a la misma altura, que es lo que las hace mitades. */}
      <div className="mb-4 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[5fr_4fr]">
        <WaitingIndex index={waiting} />
        <DayJournal journal={journal} />
      </div>

      {/*
        LA TERCERA MITAD: LO QUE NOTÉ.
        Arriba están la deuda de quien mira y el trabajo de anoche. Faltaba lo
        único que nadie pidió — una cifra que se movió y la pregunta que deja
        detrás. Va aquí y no en el chat porque en el chat compite con la
        respuesta; un hallazgo es algo que Cortex trae, no algo que se busca.

        Y VA EN SU PROPIO `Suspense`, fuera del `Promise.all` de arriba. Cuesta
        más lecturas que todo lo demás de la pantalla junto (las metas con su
        histórico, dos barridos de documentos y la lista de clientes), y ésta es
        la pantalla a la que redirige `/`: meterlo en la misma promesa haría
        que «tres cosas te esperan» tuviera que esperar a un reparto por
        cliente de doce meses. Con la frontera aquí, el inicio pinta con lo que
        ya tenía y los hallazgos llegan cuando estén.
      */}
      <Suspense fallback={<InsightsPending />}>
        <InsightsPanel organizationId={user.organization.id} />
      </Suspense>

      {/* Los prospectos no son una de las cuatro colas —nadie prometió nada, no
          hay nada parado a medias— pero son lo otro que llega solo y espera una
          mirada, y no tienen conteo en ninguna parte. Una franja, sólo cuando
          hay. */}
      {newSignals > 0 && (
        <Link
          href="/approvals"
          className="group mb-4 flex items-center gap-3 rounded-card border border-amber/50 bg-amber-soft px-4 py-3 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-amber motion-reduce:transform-none motion-reduce:transition-none"
        >
          <BadgeCheck className="h-4 w-4 shrink-0 text-amber" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-semibold text-ink">Prospectos nuevos</span>
            <span className="text-ink-muted">
              {' '}
              — <span className="tabular">{newSignals}</span> por revisar
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
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                        {relName(r.scheduled_jobs) ?? 'Rutina'}
                      </span>
                      <span className="tabular shrink-0 text-micro text-ink-faint">
                        {relativeTime(r.started_at)}
                      </span>
                    </div>
                    {excerpt && (
                      <p
                        className={clsx(
                          'mt-1 line-clamp-2 text-xs leading-snug',
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
                      <div className="truncate text-sm font-medium text-ink">
                        {c.title?.trim() || 'Conversación sin título'}
                      </div>
                      <div className="truncate text-xs text-ink-faint">
                        {relName(c.agents) ?? 'Cortex'}
                      </div>
                    </div>
                    <span className="tabular shrink-0 text-micro text-ink-faint">
                      {relativeTime(c.updated_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Atajos: una fila de píldoras, no una rejilla de tarjetas idénticas —
          son maneras de irse de aquí, no contenido, y no pueden pesar lo mismo
          que las colas de arriba. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="field-label mr-1">Atajos</span>
        <QuickAction href="/chat" icon={<Sparkles className="h-3.5 w-3.5" />} label="Nuevo chat" />
        <QuickAction
          href="/pipelines"
          icon={<Workflow className="h-3.5 w-3.5" />}
          label="Ejecutar un pipeline"
        />
        <QuickAction
          href="/kb"
          icon={<BookOpen className="h-3.5 w-3.5" />}
          label="Buscar en Brain Knowledge"
        />
        <QuickAction
          href="/schedules"
          icon={<AlarmClock className="h-3.5 w-3.5" />}
          label="Rutinas"
        />
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
              <h2 className="text-base font-bold tracking-tight text-ink">
                Conecta Cortex donde trabajes
              </h2>
              <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
                El mismo cerebro —todas las herramientas, Brain Knowledge, los pipelines y las
                rutinas— dentro de Claude, Claude Code, ChatGPT o cualquier cliente MCP. Corre con
                tus propios permisos y cada acción queda auditada.
              </p>
            </div>
          </div>
          <Link
            href="/mcp-tokens"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-primary px-3.5 py-2 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
          >
            Configurar un cliente
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="mt-4">
          <div className="field-label">URL del conector</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm font-semibold text-ink">
              {mcpUrl}
            </code>
            <CopyButton text={mcpUrl} label="Copiar la URL" />
          </div>
          <p className="mt-2 text-micro text-ink-faint">
            Claude te identifica con tu cuenta de Google: no hay ningún token que pegar.{' '}
            <Link href="/mcp-tokens" className="font-semibold text-primary hover:underline">
              Paso a paso para Claude, ChatGPT y Claude Code
            </Link>
            .
          </p>
        </div>

        {/* Trust strip */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-micro">
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

/**
 * El panel de hallazgos, con sus lecturas dentro.
 *
 * Es un componente de servidor propio y no una promesa más de la página porque
 * eso es lo que le da a `Suspense` una frontera que suspender. `readInsights`
 * ya se traga sus tres errores por separado y los devuelve como huecos con
 * nombre, así que esto no puede tumbar la pantalla.
 */
async function InsightsPanel({ organizationId }: { organizationId: string }) {
  const { insights, gaps } = await readInsights(organizationId);
  return <Insights insights={insights} gaps={gaps} />;
}

/**
 * El hueco mientras llega.
 *
 * Dice lo que está pasando en vez de fingir contenido con barras grises. Un
 * esqueleto promete que va a haber algo, y aquí muchas veces no lo hay: la
 * respuesta honesta de un espacio nuevo es cero hallazgos, y un esqueleto de
 * tres tarjetas que se resuelve en una frase de disculpa es peor que la frase.
 */
function InsightsPending() {
  return (
    <section className="mb-4 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="text-sm font-semibold text-ink">Lo que noté</span>
      </div>
      <p className="mt-2 text-sm text-ink-faint" aria-live="polite">
        Mirando qué se movió…
      </p>
    </section>
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
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-ink-muted">{body}</p>
      <Link
        href={action.href}
        className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
      >
        {action.label} <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

/** ok / error / running, in the shared status shape. */
function RunStatusChip({ status }: { status: string }) {
  const tone: StatusTone = status === 'ok' ? 'emerald' : status === 'error' ? 'rose' : 'primary';
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
      className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:border-primary/25 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transform-none motion-reduce:transition-none"
    >
      <span className="shrink-0 text-primary">{icon}</span>
      {label}
    </Link>
  );
}

/**
 * Una celda del pulso: la etiqueta que nombra y la cifra en monoespaciada
 * (regla 3 — es un número que alguien cita). El ámbar sólo cuando la cifra
 * espera una mirada; un cero ámbar sería una alarma sin incendio.
 */
function PulseCell({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: number;
  attention?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-3">
      <div className="field-label">{label}</div>
      <div className={clsx('stat-num mt-0.5 text-lg', attention ? 'text-amber' : 'text-ink')}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}
