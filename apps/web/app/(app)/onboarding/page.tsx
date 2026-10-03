import { CompanyLaunch } from '@/components/ui/company-launch';
import { readSetupDiagnostics } from '@/lib/management/diagnostics';
import { readLaunchPlan } from '@/lib/management/launch-store';
import { readMissionProgress } from '@/lib/management/mission-progress-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { Suspense } from 'react';
import { ModulesQuestion } from './_components/ModulesQuestion';
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
  const [result, diagnostics, mission] = await Promise.all([
    readLaunchPlan(
      db,
      user.id,
      !!(process.env.BROWSER_SERVICE_URL && process.env.BROWSER_SERVICE_TOKEN),
      user.role === 'org_admin',
    ),
    readSetupDiagnostics(db, user.id),
    readMissionProgress(db, user.id),
  ]);
  return (
    <div className="flex flex-col gap-6">
      {/* «¿Qué hace tu empresa?» (0186): qué módulos prender. */}
      <Suspense fallback={null}>
        <ModulesQuestion organizationId={user.organization.id} userId={user.id} />
      </Suspense>
      <CompanyLaunch
        workspaceId={user.organization.id}
        diagnostics={diagnostics}
        name={user.organization.name}
        steps={result.steps}
        initialStep={step}
        isAdmin={user.role === 'org_admin'}
        profile={result.board?.profile ?? null}
        people={result.board?.people ?? []}
        readAt={result.readAt}
        mission={mission}
      />
    </div>
  );
}
