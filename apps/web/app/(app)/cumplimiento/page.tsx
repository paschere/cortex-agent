import { ComplianceHome } from '@/components/compliance/ComplianceHome';
import { loadTeam } from '@/lib/clients/read';
import { complianceScreen } from '@/lib/compliance/screen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, isCompanyManager } from '@cortex/agent-tools';
import { headers } from 'next/headers';
import {
  createPqrsAction,
  markItemAction,
  respondPqrsAction,
  saveCaseAction,
  saveProfileAction,
  setPublicFormAction,
  updatePqrsAction,
} from './actions';

/**
 * CUMPLIMIENTO (0195): la lista societaria y legal por área con su avance y
 * sus fechas, las PQRS con el contador de días hábiles, los procesos
 * judiciales y el perfil del que sale todo. No es asesoría legal: lo que
 * depende de un umbral o de una fecha incierta sale «por confirmar».
 */

export const dynamic = 'force-dynamic';

const TABS = ['lista', 'pqrs', 'procesos', 'perfil'] as const;

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const [team, canManage] = await Promise.all([
    loadTeam(db).catch(() => []),
    isCompanyManager(db, user.id),
  ]);
  const screen = await complianceScreen(db, {
    today: bogotaToday(),
    companyName: user.organization.name ?? 'La empresa',
    origin: process.env.NEXT_PUBLIC_APP_URL ?? `${proto}://${host}`,
    canManage,
    team,
  });
  const tab = TABS.find((t) => t === q.tab) ?? (screen.configured ? 'lista' : 'perfil');
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <ComplianceHome
        screen={screen}
        tab={tab}
        focusPqrs={typeof q.pqrs === 'string' ? q.pqrs : null}
        actions={{
          saveProfile: saveProfileAction,
          markItem: markItemAction,
          createPqrs: createPqrsAction,
          respondPqrs: respondPqrsAction,
          updatePqrs: updatePqrsAction,
          saveCase: saveCaseAction,
          setPublicForm: setPublicFormAction,
        }}
      />
    </div>
  );
}
