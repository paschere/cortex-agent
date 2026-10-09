import { CompanyLaunch } from '@/components/ui/company-launch';
import { readFirstRunFacts } from '@/lib/first-run/read';
import { buildFlow, resolveStep, shouldShowFirstRun } from '@/lib/first-run/steps';
import { readSetupDiagnostics } from '@/lib/management/diagnostics';
import { readLaunchPlan } from '@/lib/management/launch-store';
import { readMissionProgress } from '@/lib/management/mission-progress-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { getSyncState } from '@cortex/agent-tools';
import { Suspense } from 'react';
import { AccountingSection } from '../integrations/_components/AccountingSection';
import { MailboxLearning } from '../settings/_components/MailboxLearning';
import { FirstFifteen } from './_components/FirstFifteen';
import { ModulesQuestion } from './_components/ModulesQuestion';
export const dynamic = 'force-dynamic';
// The inline profile organizer has a 60-second model timeout.
export const maxDuration = 90;
const CONNECTED_NAME: Record<string, string> = {
  google: 'Google',
  quickbooks: 'QuickBooks',
  QuickBooks: 'QuickBooks',
  siigo: 'Siigo',
  alegra: 'Alegra',
};

/**
 * Permanent setup center. Legacy dismissed_at never hides or completes this journey.
 *
 * MIENTRAS FALTE ALGO enseña «Los primeros 15 minutos» (4 pasos con barra y
 * promesa de tiempo, derivados de los datos). Con todo hecho, o con
 * `?guia=completa`, enseña la guía completa de siempre. `?step=` sigue siendo
 * de la guía completa (los enlaces viejos no se rompen).
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{
    step?: string;
    paso?: string;
    guia?: string;
    connected?: string;
    error?: string;
  }>;
}) {
  const user = await requireSession();
  const { step, paso, guia, connected, error } = await searchParams;
  const db = getOrgScopedClient(user.organization.id);

  const wantsFull = guia === 'completa' || !!step;
  if (!wantsFull) {
    const facts = await readFirstRunFacts(db, user.id);
    const flow = buildFlow(facts);
    if (shouldShowFirstRun(flow)) {
      const mailbox = facts.googleConnected
        ? await getSyncState(db, user.id).catch(() => null)
        : null;
      return (
        <div className="flex flex-col gap-6">
          <FirstFifteen
            flow={flow}
            initialStep={resolveStep(paso, flow)}
            googleConnected={facts.googleConnected}
            accountingConnected={facts.accountingConnected}
            whatsappConnected={facts.whatsappConnected}
            interviewState={facts.interviewState}
            autopilotEnabled={facts.autopilotEnabled}
            fullGuideHref={workspaceHref(user.organization.id, '/onboarding?guia=completa')}
            notice={
              connected
                ? {
                    kind: 'ok',
                    text: `Listo: quedó conectado ${CONNECTED_NAME[connected] ?? 'el sistema'}. Ya empecé a leer; abajo ves el avance.`,
                  }
                : error
                  ? {
                      kind: 'error',
                      text: 'No se pudo completar la conexión. Inténtalo otra vez o conéctala desde Integraciones.',
                    }
                  : null
            }
            slots={{
              modules: (
                <Suspense fallback={null}>
                  <ModulesQuestion organizationId={user.organization.id} userId={user.id} />
                </Suspense>
              ),
              accounting: (
                <AccountingSection
                  organizationId={user.organization.id}
                  role={user.organization.role}
                />
              ),
              mailbox: (
                <MailboxLearning
                  googleConnected={facts.googleConnected}
                  state={
                    mailbox
                      ? {
                          emailAddress: mailbox.emailAddress,
                          backfillWindow: mailbox.backfillWindow,
                          backfillThreads: mailbox.backfillThreads,
                          backfillDoneAt: mailbox.backfillDoneAt,
                          lastSyncedAt: mailbox.lastSyncedAt,
                          lastError: mailbox.lastError,
                          paused: mailbox.paused,
                        }
                      : null
                  }
                />
              ),
            }}
          />
        </div>
      );
    }
  }
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
