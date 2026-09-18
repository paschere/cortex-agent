import { buildManagementInbox } from '@/lib/management/inbox-overview';
import { readMissionProgress } from '@/lib/management/mission-progress-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { bogotaToday, readManagement } from '@cortex/agent-tools';
import { ArrowUpRight, CircleCheck, CircleDot, CircleX, Gauge, SearchCheck } from 'lucide-react';
import Link from 'next/link';

type Bucket = 'decisions' | 'blocked' | 'working';

const bucketMeta: Record<Bucket, { label: string; description: string; icon: typeof CircleCheck }> =
  {
    decisions: {
      label: 'Decisiones',
      description: 'Resultados que necesitan una revisión humana.',
      icon: CircleCheck,
    },
    blocked: {
      label: 'Bloqueos',
      description: 'Requisitos pendientes, sin responsable o dependencias sin verificar.',
      icon: CircleX,
    },
    working: {
      label: 'En curso',
      description: 'Asuntos abiertos con dueño, plazo y siguiente paso.',
      icon: CircleDot,
    },
  };

export async function ManagementOverview() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const [board, mission, usage] = await Promise.all([
    readManagement(db).catch(() => null),
    readMissionProgress(db, user.id),
    readUsageToday(db, today),
  ]);
  const inbox = board
    ? buildManagementInbox(board.cases, user.id, today, user.role === 'org_admin')
    : null;
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const people = new Map(
    (board?.people ?? []).map((person) => [person.id, person.name || person.email]),
  );
  const totalItems = inbox?.all.length ?? null;

  return (
    <section className="mb-4 space-y-4 rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-primary-soft text-primary">
            <Gauge className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 className="text-base font-bold text-ink">Gerencia para hoy</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">
              Una vista priorizada para decidir, desbloquear y comprobar resultados en este espacio.
            </p>
          </div>
        </div>
        <Link
          href={href('/management')}
          className="inline-flex items-center gap-1 text-sm font-semibold text-primary"
        >
          Abrir gerencia <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </header>

      {inbox ? (
        <div className="grid gap-5 border-y border-border py-4 md:grid-cols-3">
          {(['decisions', 'blocked', 'working'] as const).map((bucket) => {
            const meta = bucketMeta[bucket];
            const Icon = meta.icon;
            const items = inbox[bucket];
            return (
              <section key={bucket} aria-labelledby={`management-${bucket}`} className="min-w-0">
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0">
                    <h3
                      id={`management-${bucket}`}
                      className="text-xs font-semibold uppercase tracking-wider text-ink-muted"
                    >
                      {meta.label} · {items.length}
                    </h3>
                    <p className="mt-1 text-xs text-ink-faint">{meta.description}</p>
                  </div>
                </div>
                {items.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-faint">Sin asuntos en esta vista.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-border">
                    {items.slice(0, 3).map((item) => (
                      <li key={item.id}>
                        <Link href={href(item.href)} className="block py-3 hover:text-primary">
                          <span className="block break-words text-sm font-semibold">
                            {item.title}
                          </span>
                          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                            <span>{people.get(item.ownerId ?? '') ?? 'Sin responsable'}</span>
                            <span>Plazo {item.dueOn}</span>
                          </span>
                          <span className="mt-1 block break-words text-xs text-ink-muted">
                            {item.evidenceLabel}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {items.length > 3 && (
                  <Link
                    href={href('/management')}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary"
                  >
                    {items.length - 3} más <ArrowUpRight className="h-3 w-3" aria-hidden />
                  </Link>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-sm text-ink-muted">
          No se pudo leer la agenda de Gerencia. Reintenta para comprobar el estado real.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={SearchCheck} label="Simulaciones" value={mission.runs.simulated} />
        <Metric label="Asuntos creados" value={mission.results.created} />
        <Metric label="Cierres con evidencia" value={mission.results.verified} />
        <Metric label="Uso registrado hoy" value={usage} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            {mission.objective ?? 'Prepara una primera misión con un objetivo comprobable.'}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {mission.results.verified > 0
              ? 'Hay un resultado cerrado con evidencia revisada.'
              : mission.results.created > 0
                ? 'Hay resultados preparados; falta la revisión humana del cierre.'
                : 'El ciclo sugerido es objetivo → fuente → simulación → primer resultado.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={href(mission.resumeHref ?? '/management/mission')}
            className="text-sm font-semibold text-primary"
          >
            {mission.resumeHref ? 'Retomar misión' : 'Preparar misión'}{' '}
            <ArrowUpRight className="inline h-4 w-4" aria-hidden />
          </Link>
          {user.role === 'org_admin' && (
            <Link
              href={href('/admin/usage')}
              className="text-xs font-semibold text-ink-muted hover:text-ink"
            >
              Ver uso detallado
            </Link>
          )}
        </div>
      </div>
      {mission.errors.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs text-ink-muted"
        >
          <p className="font-semibold text-ink">Algunas cifras necesitan comprobación</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {mission.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-ink-faint">
        {totalItems === null
          ? 'La bandeja no está disponible.'
          : `${totalItems} asunto${totalItems === 1 ? '' : 's'} requiere${totalItems === 1 ? '' : 'n'} atención según los registros consultados.`}{' '}
        Las cifras de uso son actividad registrada; no representan un costo facturado.
      </p>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon?: typeof SearchCheck;
  label: string;
  value: number | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-muted">
        {Icon && <Icon className="h-3.5 w-3.5 text-primary" aria-hidden />}
        {label}
      </div>
      <strong className="mt-1 block text-xl tabular-nums text-ink">
        {value === null ? '—' : value.toLocaleString('es-CO')}
      </strong>
    </div>
  );
}

async function readUsageToday(
  db: ReturnType<typeof getOrgScopedClient>,
  today: string,
): Promise<number | null> {
  const start = new Date(`${today}T05:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  try {
    const result = await db
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .not('tool_id', 'in', '("__agent_turn","__approval_decision")')
      .neq('status', 'attempted');
    return result.error ? null : (result.count ?? 0);
  } catch {
    return null;
  }
}
