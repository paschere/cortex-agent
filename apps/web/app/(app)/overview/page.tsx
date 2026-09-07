import { CompanyGroups } from '@/components/overview/CompanyGroups';
import { FounderOverview } from '@/components/overview/FounderOverview';
import { PageHeader } from '@/components/ui/page-header';
import { auth } from '@/lib/auth';
import { listCompanyGroups, listUngroupedOwnedCompanies } from '@/lib/company-groups';
import { readFounderOverview } from '@/lib/founder-overview';
import { listMemberships } from '@/lib/organization';
import { requireSession } from '@/lib/session';
import { LayoutDashboard } from 'lucide-react';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const user = await requireSession();
  const betterAuth = await auth.api.getSession({ headers: await headers() });
  const accountId = betterAuth?.user?.id;
  if (!accountId) throw new Error('La sesión no tiene una cuenta asociada.');
  const memberships = await listMemberships(accountId);
  const [data, groups, availableCompanies] = await Promise.all([
    readFounderOverview(memberships, user.email),
    listCompanyGroups(accountId),
    listUngroupedOwnedCompanies(accountId),
  ]);
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Decisiones, riesgos y pendientes de todos los espacios a los que tienes acceso."
        icon={<LayoutDashboard className="h-5 w-5" />}
      />
      <FounderOverview data={data} activeId={user.organization.id} />
      <div className="mt-6">
        <CompanyGroups initialGroups={groups} initialAvailable={availableCompanies} />
      </div>
    </>
  );
}
