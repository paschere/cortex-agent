import { BoardHome } from '@/components/board/BoardHome';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  DEFAULT_BOARD_SETTINGS,
  boardPeriodLabel,
  bogotaToday,
  defaultBoardPeriod,
  isCompanyManager,
  listBoardReports,
  readBoardSettings,
} from '@cortex/agent-tools';
import { generateBoardAction, saveBoardSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * INFORME PARA SOCIOS (0191): la lista de informes, armar uno y la
 * configuración de la rutina mensual. Cualquiera de la empresa ve la lista;
 * armar, configurar, compartir y mandar lo hace quien administra.
 */
export default async function BoardPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const [reports, settings, canEdit] = await Promise.all([
    listBoardReports(db),
    readBoardSettings(db).catch(() => ({ ...DEFAULT_BOARD_SETTINGS })),
    isCompanyManager(db, user.id),
  ]);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const periods: Array<{ value: string; label: string }> = [];
  let [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < 13; i++) {
    const value = `${y}-${String(m).padStart(2, '0')}`;
    const label = boardPeriodLabel(value);
    periods.push({
      value,
      label: `${label.charAt(0).toUpperCase()}${label.slice(1)}${i === 0 ? ' (en curso)' : ''}`,
    });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return (
    <BoardHome
      today={today}
      reports={reports}
      settings={settings}
      canEdit={canEdit}
      defaultPeriod={defaultBoardPeriod(today)}
      periods={periods}
      links={{
        self: href('/informe-socios'),
        statements: href('/estados'),
        budget: href('/presupuesto'),
        integrations: href('/integrations'),
        schedules: href('/schedules'),
      }}
      hrefs={Object.fromEntries(
        reports.map((r) => [
          r.id,
          { detail: href(`/informe-socios/${r.id}`), pdf: href(`/api/board/${r.id}/pdf`) },
        ]),
      )}
      actions={{ generate: generateBoardAction, saveSettings: saveBoardSettingsAction }}
    />
  );
}
