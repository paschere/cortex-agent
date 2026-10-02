import { AutopilotHome } from '@/components/autopilot/AutopilotHome';
import { buildRunView, buildSettingsView, dayLabel, runListEntry } from '@/lib/autopilot/screen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { qualifiedToolLabel } from '@/lib/tool-taxonomy';
import {
  bogotaHour,
  bogotaToday,
  isCompanyManager,
  listAutopilotItems,
  listAutopilotRuns,
  listOpenAsks,
  readAutopilotSettings,
} from '@cortex/agent-tools';
import { AUTOPILOT_ACTIONS } from './autopilot-actions';

export const dynamic = 'force-dynamic';

/**
 * PILOTO AUTOMÁTICO (0176): lo que Cortex hace solo cada mañana, lo que deja
 * para decidir y cómo se configura. Cualquiera de la empresa lo ve; encender,
 * apagar, cambiar niveles y decidir lo que espera es de quien administra o es
 * dueño (`isCompanyManager`), y lo vuelve a comprobar cada acción de servidor.
 */
export default async function PilotoPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const [settings, runs, asks, canEdit] = await Promise.all([
    readAutopilotSettings(db),
    listAutopilotRuns(db, { limit: 15 }),
    listOpenAsks(db, { limit: 200 }),
    isCompanyManager(db, user.id),
  ]);
  const todayRun = runs.find((r) => r.run_on === today) ?? null;
  const items = todayRun ? await listAutopilotItems(db, todayRun.id) : [];
  const mandateIds = [...new Set(items.map((i) => i.mandate_id).filter(Boolean))] as string[];
  const mandateNames = new Map<string, string>();
  if (mandateIds.length) {
    const { data, error } = await db.from('mandates').select('id, label').in('id', mandateIds);
    if (!error)
      for (const m of (data ?? []) as Array<{ id: string; label: string }>)
        mandateNames.set(m.id, m.label);
  }
  let actorLabel: string | null = null;
  if (settings.actorUserId) {
    const { data, error } = await db
      .from('users')
      .select('name, email')
      .eq('id', settings.actorUserId)
      .maybeSingle();
    if (!error && data) {
      const u = data as { name: string | null; email: string };
      actorLabel = u.name?.trim() || u.email;
    }
  }
  const label = (id: string) => qualifiedToolLabel(id);
  return (
    <AutopilotHome
      settings={buildSettingsView(settings, {
        today,
        hourNow: bogotaHour(new Date()),
        actorLabel,
      })}
      today={todayRun ? buildRunView(todayRun, items, label, mandateNames) : null}
      todayLabel={dayLabel(today)}
      history={runs.filter((r) => r.run_on !== today).map(runListEntry)}
      waiting={asks.length}
      actions={AUTOPILOT_ACTIONS}
      canEdit={canEdit}
    />
  );
}
