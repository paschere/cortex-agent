import { CreateCompanyButton } from '@/components/nav/WorkspaceSwitcher';
import { CompanyGroups } from '@/components/overview/CompanyGroups';
import { FounderOverview } from '@/components/overview/FounderOverview';
import { FounderTabs } from '@/components/overview/FounderTabs';
import { QualityHealth } from '@/components/overview/QualityHealth';
import { PageHeader } from '@/components/ui/page-header';
import { signupMode } from '@/lib/billing/config';
import { isPlatformOperator } from '@/lib/billing/operators';
import { readOwnedBusiness } from '@/lib/founder-business';
import { readFounderConsole } from '@/lib/founder-console';
import { buildConsoleRows } from '@/lib/founder-console-shape';
import { requireFounderContext } from '@/lib/founder-guard';
import { readOwnedQuality } from '@/lib/quality-health';
import { workspaceHref } from '@/lib/workspace-context';
import { LayoutDashboard, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * El inicio global, que para quien funda empresas es su centro de mando.
 *
 * Todas las lecturas se hacen aquí, en el servidor, a partir de las membresías
 * y propiedades que `requireFounderContext` leyó de `ba_member`; el componente
 * de cliente sólo filtra y cambia de vista sobre lo que ya recibió.
 *
 * Dos tiempos: los pendientes y el plan de cada empresa se esperan (son
 * conteos baratos) y la página se pinta con ellos; las cifras de negocio
 * —cartera, recuperado, ventas, procesos, puesta en marcha— se piden en
 * paralelo y viajan como una PROMESA sin esperar: React la sigue resolviendo
 * en el mismo flujo de respuesta y las tarjetas se llenan cuando llega
 * (founder-business.ts lee de a pocas empresas, cada cifra con su tope).
 */
export default async function OverviewPage({
  searchParams,
}: { searchParams: Promise<{ inicio?: string }> }) {
  const { inicio } = await searchParams;
  const context = await requireFounderContext();
  // Con una sola empresa propia y llegando desde `/`, lo más probable es que
  // esta página redirija: no se gasta la lectura de negocio hasta saberlo.
  const mayRedirect = inicio === '1' && context.owned.length <= 1;
  let business = mayRedirect ? null : readOwnedBusiness(context.owned, context.user.email);
  const data = await readFounderConsole(context.accountId, context.user.email, context.owned);
  const rows = buildConsoleRows(
    data.overview,
    data.health,
    data.groupOf,
    context.user.organization.id,
  );
  const founder = context.owned.length > 0;

  // AL ENTRAR, QUIEN TIENE UNA SOLA EMPRESA VA A SU INICIO.
  // El centro de mando sirve para comparar varias; con una sola es una tabla
  // de una fila entre la persona y su trabajo. Sólo cuando se llega desde `/`
  // (`?inicio=1`): abrir /overview a propósito sigue mostrándolo.
  if (inicio === '1') {
    const companies = rows.filter((row) => row.kind === 'company');
    if (companies.length <= 1) {
      redirect(companies[0] ? workspaceHref(companies[0].id, '/dashboard') : '/dashboard');
    }
  }
  business ??= readOwnedBusiness(context.owned, context.user.email);
  return (
    <>
      <PageHeader
        title={founder ? 'Centro de mando' : 'Inicio global'}
        subtitle={
          founder
            ? 'Cómo va cada empresa que diriges y dónde actuar hoy, en una sola vista.'
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
      <FounderTabs
        current="companies"
        showPeople={founder}
        showAccess={signupMode() === 'request' && (await isPlatformOperator(context.accountId))}
      />
      <FounderOverview
        rows={rows}
        business={business}
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
      {founder && <QualityHealth companies={await readOwnedQuality(context.owned)} />}
    </>
  );
}
