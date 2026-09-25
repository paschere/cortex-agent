import { FounderPeople } from '@/components/overview/FounderPeople';
import { RenameCompany } from '@/components/overview/RenameCompany';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead, StatCard } from '@/components/ui/panel';
import { readOwnedCompanyHealth } from '@/lib/founder-console';
import { answersPercent, seatsLabel } from '@/lib/founder-console-shape';
import { requireFounderContext } from '@/lib/founder-guard';
import { groupPeople, ownerCounts } from '@/lib/founder-rules';
import { relativeTime } from '@/lib/relative-time';
import { chipClass } from '@/lib/status-chip';
import { listCompanyInvitations, listCompanyMembers } from '@/lib/team/membership-admin';
import { workspaceHref } from '@/lib/workspace-context';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Building2,
  CreditCard,
  Gauge,
  Plug,
  Repeat,
  ScrollText,
  Settings2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * La ficha de UNA empresa propia: salud, plan, equipo y atajos para entrar.
 *
 * El id de la URL sólo dice CUÁL; lo que permite verla es que esté entre las
 * empresas de las que la cuenta es fundadora, leídas de `ba_member` en esta
 * petición. Una empresa ajena da 404, igual que una inexistente, para no
 * confirmar que existe.
 *
 * Los atajos llevan `?workspace=` (workspaceHref): abren la pantalla de ESA
 * empresa en esta pestaña sin cambiar la empresa activa de las demás, y el
 * servidor vuelve a comprobar la membresía al llegar.
 */
export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  const context = await requireFounderContext();
  const company = context.owned.find((item) => item.id === organizationId);
  if (!company) notFound();

  const [health, rows, invitations] = await Promise.all([
    readOwnedCompanyHealth(company),
    listCompanyMembers([company.id]),
    listCompanyInvitations([company.id]),
  ]);
  const people = groupPeople(rows);
  const pct = answersPercent(health.answers);
  const links = [
    { href: '/admin/users', label: 'Personas y jefes', Icon: Users },
    { href: '/plan', label: 'Plan y consumo', Icon: CreditCard },
    { href: '/integrations', label: 'Integraciones', Icon: Plug },
    { href: '/admin/audit', label: 'Auditoría', Icon: ScrollText },
    { href: '/team/activity', label: 'Actividad del equipo', Icon: Activity },
    { href: '/schedules', label: 'Rutinas', Icon: Repeat },
  ];

  return (
    <>
      <Link
        href="/overview"
        className="mb-4 inline-flex min-h-8 items-center gap-1.5 rounded-pill px-2 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Centro de mando
      </Link>
      <PageHeader
        title={company.name}
        subtitle={`Empresa que fundaste${health.planName ? ` · Plan ${health.planName}` : ''}${health.createdAt ? ` · creada el ${new Date(health.createdAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}`}
        icon={<Building2 className="h-5 w-5" />}
        actions={
          <span
            className={chipClass(health.health.tone === 'neutral' ? 'neutral' : health.health.tone)}
          >
            {health.health.label}
          </span>
        }
      />

      {health.status === 'unavailable' && (
        <p className="mb-6 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-xs text-ink-muted">
          El plan y el consumo de esta empresa no respondieron. El equipo sí está disponible abajo.
        </p>
      )}

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Estado de la empresa"
      >
        <StatCard
          label="Asientos"
          value={seatsLabel(health.seats)}
          sub={`${health.members} ${health.members === 1 ? 'persona' : 'personas'} · ${health.pendingInvitations} por aceptar`}
          icon={<Users className="h-4 w-4" />}
          tone={health.seats?.full ? 'amber' : 'primary'}
        />
        <StatCard
          label="Respuestas este mes"
          value={health.answers ? health.answers.used.toLocaleString('es-CO') : '—'}
          sub={
            health.answers
              ? health.answers.limit === null
                ? 'Sin límite en este plan'
                : `${pct ?? 0}% de ${health.answers.limit.toLocaleString('es-CO')}`
              : undefined
          }
          icon={<Gauge className="h-4 w-4" />}
          tone={
            health.answers?.state === 'blocked'
              ? 'rose'
              : health.answers?.state === 'grace' || health.answers?.state === 'warning'
                ? 'amber'
                : 'primary'
          }
        />
        <StatCard
          label="Rutinas activas"
          value={String(health.routines?.active ?? '—')}
          sub={
            health.routines
              ? `${health.routines.failedRecently} ejecuciones con error en 7 días`
              : undefined
          }
          icon={<Repeat className="h-4 w-4" />}
          tone={(health.routines?.failedRecently ?? 0) > 0 ? 'amber' : 'emerald'}
        />
        <StatCard
          label="Integraciones"
          value={String(health.integrations ?? '—')}
          sub={
            health.lastActivityAt
              ? `Última actividad ${relativeTime(health.lastActivityAt)}`
              : 'Sin actividad registrada'
          }
          icon={<Plug className="h-4 w-4" />}
          tone="sky"
        />
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <FounderPeople
            actorAccountId={context.accountId}
            companies={[{ id: company.id, name: company.name }]}
            people={people}
            ownerCounts={Object.fromEntries(ownerCounts(rows))}
            invitations={invitations.map((invitation) => ({
              ...invitation,
              organizationName: company.name,
            }))}
          />
        </div>
        <aside className="space-y-6">
          <Panel>
            <PanelHead title="Entrar a la empresa" icon={<ArrowUpRight className="h-4 w-4" />} />
            <ul className="px-2 pb-3 pt-2">
              {links.map(({ href, label, Icon }) => (
                <li key={href}>
                  <Link
                    href={workspaceHref(company.id, href)}
                    className="flex min-h-10 items-center gap-2.5 rounded-sm px-3 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    <Icon className="h-4 w-4 text-ink-faint" aria-hidden />
                    <span className="flex-1">{label}</span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <PanelHead title="Ajustes de la empresa" icon={<Settings2 className="h-4 w-4" />} />
            <div className="px-5 pb-5 pt-3">
              <RenameCompany organizationId={company.id} currentName={company.name} />
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
