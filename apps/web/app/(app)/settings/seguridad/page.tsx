import { PageHeader } from '@/components/ui/page-header';
import { auth } from '@/lib/auth';
import { listOwnedCompanies } from '@/lib/founder-guard';
import { decideLeave, decideStepDown, normalizeMembershipRole } from '@/lib/founder-rules';
import { requireSession } from '@/lib/session';
import { listCompanyMembers } from '@/lib/team/membership-admin';
import { ROLES_INFO, roleKeyOf } from '@/lib/team/role-matrix';
import { readStepUp } from '@/lib/team/step-up';
import { ShieldCheck } from 'lucide-react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { CompanyPlacement } from './CompanyPlacement';
import { PasswordPanel } from './PasswordPanel';
import { SessionsPanel } from './SessionsPanel';
import { TwoFactorPanel } from './TwoFactorPanel';

export const dynamic = 'force-dynamic';

/**
 * /settings/seguridad — «Seguridad de tu cuenta».
 *
 * La cuenta es de la PERSONA, no de la empresa: aquí no hay ids en la URL ni
 * se lee nada de otro usuario. Lo único que depende de la empresa activa es
 * «Tu lugar en la empresa», y sus permisos se calculan con las mismas reglas
 * (founder-rules.ts) que repiten las acciones de servidor.
 */
export default async function SecuritySettingsPage() {
  const user = await requireSession();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) redirect('/login');
  const accountId = session.user.id;

  const [stepUp, owned, members] = await Promise.all([
    readStepUp(accountId, requestHeaders),
    listOwnedCompanies(accountId),
    user.organization.kind === 'company'
      ? listCompanyMembers([user.organization.id])
      : Promise.resolve([]),
  ]);
  const isFounder = owned.length > 0;
  const role = normalizeMembershipRole(user.organization.role);
  const ownerCount = members.filter((row) => normalizeMembershipRole(row.role) === 'owner').length;
  const placement = {
    workspaceKind: user.organization.kind ?? 'company',
    actorRole: role,
    ownerCount,
  };

  return (
    <>
      <PageHeader
        title="Seguridad de tu cuenta"
        subtitle="Protege el acceso a Cortex: un segundo paso al entrar, tus sesiones abiertas y tu contraseña."
        icon={<ShieldCheck className="h-5 w-5" />}
      />
      <div className="space-y-5">
        <TwoFactorPanel
          enabled={stepUp.twoFactorEnabled}
          hasPassword={stepUp.hasPassword}
          isFounder={isFounder}
        />
        <SessionsPanel />
        <PasswordPanel email={session.user.email} hasPassword={stepUp.hasPassword} />
        {user.organization.kind === 'company' && (
          <CompanyPlacement
            companyName={user.organization.name}
            roleLabel={ROLES_INFO[roleKeyOf(role, user.role)].label}
            isOwner={role === 'owner'}
            ownerCount={ownerCount}
            canStepDown={decideStepDown(placement).ok}
            canLeave={decideLeave(placement).ok}
            requirement={stepUp.requirement}
            hasTwoFactor={stepUp.twoFactorEnabled}
          />
        )}
      </div>
    </>
  );
}
