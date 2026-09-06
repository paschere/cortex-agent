import { CompanyLaunch } from '@/components/ui/company-launch';
import { readSetupDiagnostics } from '@/lib/management/diagnostics';
import { readLaunchPlan } from '@/lib/management/launch-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
export const dynamic = 'force-dynamic';
// The inline profile organizer has a 60-second model timeout.
export const maxDuration = 90;
/** Permanent setup center. Legacy dismissed_at never hides or completes this journey. */
export default async function OnboardingPage({
  searchParams,
}: { searchParams: Promise<{ step?: string }> }) {
  const user = await requireSession();
  const { step } = await searchParams;
  const db = getOrgScopedClient(user.organization.id);
  const [result, diagnostics] = await Promise.all([
    readLaunchPlan(
      db,
      user.id,
      !!(process.env.BROWSER_SERVICE_URL && process.env.BROWSER_SERVICE_TOKEN),
      user.role === 'org_admin',
    ),
    readSetupDiagnostics(db, user.id),
  ]);
  return (
    <CompanyLaunch
      diagnostics={diagnostics}
      name={user.organization.name}
      steps={result.steps}
      initialStep={step}
      isAdmin={user.role === 'org_admin'}
      profile={result.board?.profile ?? null}
      people={result.board?.people ?? []}
      readAt={result.readAt}
    />
  );
}
