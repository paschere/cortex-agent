import { FounderPeople } from '@/components/overview/FounderPeople';
import { FounderTabs } from '@/components/overview/FounderTabs';
import { PageHeader } from '@/components/ui/page-header';
import { requireFounderContext } from '@/lib/founder-guard';
import { groupPeople, ownerCounts } from '@/lib/founder-rules';
import { listCompanyInvitations, listCompanyMembers } from '@/lib/team/membership-admin';
import { Building2, Users } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Personas de todas las empresas que diriges, en una tabla.
 *
 * Sólo empresas propias: las filas salen de `listCompanyMembers` con los ids de
 * `requireFounderContext`, nunca de la URL. Quien es gerente de una empresa
 * administra a su gente dentro de ella (/admin/users), con los permisos de esa
 * empresa; esta vista es la del fundador, que mira varias a la vez.
 */
export default async function FounderPeoplePage() {
  const context = await requireFounderContext();
  const ids = context.owned.map((company) => company.id);
  const [rows, invitations] = await Promise.all([
    listCompanyMembers(ids),
    listCompanyInvitations(ids),
  ]);
  const people = groupPeople(rows);
  const owners = Object.fromEntries(ownerCounts(rows));
  const companies = context.owned.map((company) => ({ id: company.id, name: company.name }));
  const nameOf = new Map(companies.map((company) => [company.id, company.name]));

  return (
    <>
      <PageHeader
        title="Personas"
        subtitle={
          context.owned.length > 0
            ? `${people.length} ${people.length === 1 ? 'persona' : 'personas'} en ${companies.length} ${companies.length === 1 ? 'empresa' : 'empresas'} · ${invitations.length} ${invitations.length === 1 ? 'invitación pendiente' : 'invitaciones pendientes'}`
            : 'Invita, cambia roles y retira accesos en todas las empresas que diriges.'
        }
        icon={<Users className="h-5 w-5" />}
      />
      <FounderTabs current="people" showPeople />
      {context.owned.length === 0 ? (
        <div className="rounded-card border border-dashed border-border px-6 py-12 text-center">
          <Building2 className="mx-auto mb-3 h-6 w-6 text-ink-faint" aria-hidden />
          <p className="text-sm font-semibold text-ink">Todavía no diriges ninguna empresa</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
            Esta vista reúne a la gente de las empresas que fundas. Crea una desde el{' '}
            <Link href="/overview" className="font-semibold text-primary hover:underline">
              centro de mando
            </Link>{' '}
            para empezar a invitar.
          </p>
        </div>
      ) : (
        <FounderPeople
          actorAccountId={context.accountId}
          companies={companies}
          people={people}
          ownerCounts={owners}
          invitations={invitations.map((invitation) => ({
            ...invitation,
            organizationName: nameOf.get(invitation.organizationId) ?? 'Empresa',
          }))}
        />
      )}
    </>
  );
}
