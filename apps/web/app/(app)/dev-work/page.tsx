import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  DEV_REPO_COLUMNS,
  DEV_TASK_COLUMNS,
  type DevTask,
  formatCost,
  isMissingTable,
  repoLabel,
  toDevRepository,
  toDevTask,
} from '@/lib/dev-work';
import { requireSession } from '@/lib/session';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import { Hammer, Hourglass, Loader, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { RefreshButton } from '../schedules/_components/RefreshButton';
import { TaskCard } from './_components/TaskCard';

export const dynamic = 'force-dynamic';

/** How many runs the page holds. Everything older lives in the database. */
const PAGE_SIZE = 100;
const WINDOW_DAYS = 7;

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
  return (
    <div className="field-label mb-2.5 flex items-center gap-2 border-b border-border-strong pb-1.5">
      {icon}
      {children}
      <span className={chipClass(tone)}>{count}</span>
    </div>
  );
}

export default async function DevWorkPage() {
  await requireSession();
  const db = getSupabaseServiceClient();

  const [taskRes, repoRes] = await Promise.all([
    db
      .from('dev_tasks')
      .select(DEV_TASK_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE),
    db.from('dev_repositories').select(DEV_REPO_COLUMNS).order('name'),
  ]);

  // The intake agent owns these tables. Until its migration lands they simply
  // do not exist, and a database error is not something the person reading this
  // page can act on — so say what is true instead.
  const notReady = isMissingTable(taskRes.error) || isMissingTable(repoRes.error);

  const tasks: DevTask[] = ((taskRes.data ?? []) as unknown as Record<string, unknown>[]).map(
    toDevTask,
  );
  const repos = ((repoRes.data ?? []) as unknown as Record<string, unknown>[]).map(toDevRepository);
  const repoById = new Map(repos.map((r) => [r.id, r]));

  // Requester names, resolved in one round trip.
  const requesterIds = [...new Set(tasks.map((t) => t.requestedBy).filter(Boolean))] as string[];
  const nameById = new Map<string, string>();
  if (requesterIds.length > 0) {
    const { data: people } = await db
      .from('users')
      .select('id, name, email')
      .in('id', requesterIds);
    for (const p of people ?? []) {
      nameById.set(p.id as string, (p.name as string | null) ?? (p.email as string));
    }
  }
  const requesterFor = (t: DevTask): string | null =>
    (t.requestedBy ? nameById.get(t.requestedBy) : null) ?? t.requestedByName;

  const needsYou = tasks.filter((t) => t.status === 'needs_review');
  const inFlight = tasks.filter((t) => t.status === 'queued' || t.status === 'running');
  const finished = tasks.filter(
    (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled',
  );

  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const recent = tasks.filter((t) => new Date(t.createdAt).getTime() >= since);
  const failedRecently = recent.filter((t) => t.status === 'failed').length;
  const shippedRecently = recent.filter((t) => t.status === 'done').length;
  const spend = recent.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const spendText = recent.some((t) => t.costUsd !== null) ? formatCost(spend) : null;
  const enabledRepos = repos.filter((r) => r.enabled).length;

  // Colour only where the figure carries a meaning: amber when a person is
  // holding something up, red when runs are failing. Counts stay in ink.
  const stats: Array<{ label: string; value: string; sub: string; tone?: 'amber' | 'rose' }> = [
    {
      label: 'Trabajando ahora',
      value: String(inFlight.length),
      sub: inFlight.length > 0 ? 'en curso' : 'nada corriendo',
    },
    {
      label: 'Te esperan',
      value: String(needsYou.length),
      sub: needsYou.length > 0 ? 'necesitan una persona' : 'todo revisado',
      tone: needsYou.length > 0 ? 'amber' : undefined,
    },
    {
      label: `Entregados · ${WINDOW_DAYS}d`,
      value: String(shippedRecently),
      sub: 'cambios entregados',
    },
    {
      label: `Fallidos · ${WINDOW_DAYS}d`,
      value: String(failedRecently),
      sub: failedRecently > 0 ? 'vale la pena mirarlos' : 'ninguno',
      tone: failedRecently > 0 ? 'rose' : undefined,
    },
    spendText
      ? {
          label: `Costo · ${WINDOW_DAYS}d`,
          value: spendText,
          sub: 'de estas ejecuciones',
        }
      : {
          label: 'Repositorios',
          value: String(enabledRepos),
          sub:
            enabledRepos === 1 ? 'Cortex puede editar uno' : `Cortex puede editar ${enabledRepos}`,
        },
  ];

  return (
    <>
      <PageHeader
        title="Trabajo de desarrollo"
        subtitle="Todo lo que Cortex está cambiando en tu propio software, por su cuenta. Míralo aquí y detenlo aquí."
        icon={<Hammer className="h-5 w-5" />}
        actions={
          <>
            <Link
              href="/dev-work/repositories"
              className="inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Repositorios
            </Link>
            <RefreshButton />
          </>
        }
      />

      {notReady ? (
        <Panel className="p-10 text-center text-[13px] text-ink-muted">
          <Hammer className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="mb-1 text-[15px] font-bold text-ink">
            Todavía no está activo en este ambiente
          </p>
          <p className="mx-auto max-w-md leading-relaxed">
            Aquí Cortex no puede tomar trabajo de desarrollo porque falta instalar la base de datos
            que lo soporta. Cuando esté, cada ejecución aparece en esta página mientras pasa.
          </p>
        </Panel>
      ) : (
        <>
          <Panel className="mb-5 grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((s) => (
              <div key={s.label} className="bg-surface px-4 py-3">
                <div className="field-label truncate" title={s.label}>
                  {s.label}
                </div>
                <div
                  className={clsx(
                    'stat-num mt-1 truncate text-[20px] leading-none',
                    s.tone === 'amber'
                      ? 'text-amber'
                      : s.tone === 'rose'
                        ? 'text-rose'
                        : 'text-ink',
                  )}
                  title={s.value}
                >
                  {s.value}
                </div>
                <div className="mt-1 truncate text-[10.5px] text-ink-faint" title={s.sub}>
                  {s.sub}
                </div>
              </div>
            ))}
          </Panel>

          {tasks.length === 0 ? (
            <Panel className="p-10 text-center text-[13px] text-ink-muted">
              <Hammer className="mx-auto mb-3 h-7 w-7 text-primary" />
              <p className="mb-1 text-[15px] font-bold text-ink">
                Nadie le ha pedido nada a Cortex
              </p>
              <p className="mx-auto max-w-md leading-relaxed">
                Asígnale un issue de Linear a Cortex y aparece aquí. Vas a verlo tomar el trabajo, y
                puedes detenerlo en cualquier momento.
              </p>
            </Panel>
          ) : (
            <div className="space-y-8">
              {needsYou.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Hourglass className="h-3.5 w-3.5 text-amber" />}
                    count={needsYou.length}
                    tone="amber"
                  >
                    Te esperan
                  </SectionLabel>
                  <div className="space-y-3">
                    {needsYou.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        repository={repoLabel(repoById.get(t.repositoryId ?? ''))}
                        requester={requesterFor(t)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {inFlight.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Loader className="h-3.5 w-3.5 text-primary" />}
                    count={inFlight.length}
                    tone="primary"
                  >
                    Pasando ahora
                  </SectionLabel>
                  <div className="space-y-3">
                    {inFlight.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        repository={repoLabel(repoById.get(t.repositoryId ?? ''))}
                        requester={requesterFor(t)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {finished.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Hammer className="h-3.5 w-3.5 text-ink-faint" />}
                    count={finished.length}
                    tone="neutral"
                  >
                    Terminados
                  </SectionLabel>
                  <div className="space-y-3">
                    {finished.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        repository={repoLabel(repoById.get(t.repositoryId ?? ''))}
                        requester={requesterFor(t)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
