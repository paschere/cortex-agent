import { CreateCompanyButton } from '@/components/nav/WorkspaceSwitcher';
import { CompanyGroups } from '@/components/overview/CompanyGroups';
import { FounderOverview } from '@/components/overview/FounderOverview';
import { FounderTabs } from '@/components/overview/FounderTabs';
import { PageHeader } from '@/components/ui/page-header';
import { readFounderConsole } from '@/lib/founder-console';
import { buildConsoleRows } from '@/lib/founder-console-shape';
import { requireFounderContext } from '@/lib/founder-guard';
import { LayoutDashboard, MessagesSquare } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * El inicio global, que para quien funda empresas es su centro de mando.
 *
 * Todas las lecturas se hacen aquí, en el servidor, a partir de las membresías
 * y propiedades que `requireFounderContext` leyó de `ba_member`; el componente
 * de cliente sólo filtra y cambia de vista sobre lo que ya recibió.
 */
export default async function OverviewPage() {
  const context = await requireFounderContext();
  const data = await readFounderConsole(context.accountId, context.user.email, context.owned);
  const rows = buildConsoleRows(
    data.overview,
    data.health,
    data.groupOf,
    context.user.organization.id,
  );
  const founder = context.owned.length > 0;
  return (
    <>
      <PageHeader
        title={founder ? 'Centro de mando' : 'Inicio global'}
        subtitle={
          founder
            ? 'Salud, consumo, equipo y pendientes de cada empresa que diriges, en una sola vista.'
            : 'Decisiones, riesgos y pendientes de todos los espacios a los que tienes acceso.'
        }
        icon={<LayoutDashboard className="h-5 w-5" />}
        actions={
          <>
            <Link
              href="/chat/global"
              className="inline-flex min-h-9 items-center gap-2 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
            >
              <MessagesSquare className="h-4 w-4" aria-hidden /> Consultar varios espacios
            </Link>
            {data.ownedCount < data.ownedLimit && <CreateCompanyButton />}
          </>
        }
      />
      <FounderTabs current="companies" showPeople={founder} />
      <FounderOverview
        rows={rows}
        totals={data.overview.totals}
        unavailable={data.overview.unavailable}
        groups={data.groups.map((group) => ({ id: group.id, name: group.name }))}
        ownedCount={data.ownedCount}
        ownedLimit={data.ownedLimit}
      />
      {founder && (
        <div className="mt-8">
          <CompanyGroups initialGroups={data.groups} initialAvailable={data.availableForGroups} />
        </div>
      )}
    </>
  );
}
