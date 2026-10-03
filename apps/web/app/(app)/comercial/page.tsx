import { CrmScreen } from '@/components/crm/CrmScreen';
import { loadCrmPage } from '@/lib/crm/read';
import { parseCrmTab } from '@/lib/crm/shape';
import {
  analyticsView,
  boardRows,
  crmTiles,
  forecastView,
  npsSummary,
  opportunityColumns,
  opportunityPresets,
  opportunityRow,
  riskViews,
  staleViews,
  surveyViews,
  taskViews,
} from '@/lib/crm/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, npsSurveyPublicUrl } from '@cortex/agent-tools';
import {
  bulkEditOpportunities,
  completeTaskAction,
  createOpportunityRow,
  editOpportunityCell,
  logActivityAction,
  opportunityTimeline,
  sendSurveyAction,
} from './actions';

/**
 * El embudo comercial (migración 0193): el tablero por etapa, la tabla de
 * oportunidades, las tareas de hoy, los clientes que se están yendo, el
 * análisis de conversión, pérdidas y márgenes, y las encuestas de
 * satisfacción.
 */

export const dynamic = 'force-dynamic';

export default async function ComercialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = parseCrmTab(q.tab);
  const open = typeof q.abrir === 'string' ? q.abrir : null;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const data = await loadCrmPage(db, { today, tab });
  const { board } = data;
  const people = new Map(data.team.map((t) => [t.id, t.name]));
  const oppIndex = new Map(
    board.opportunities.map((o) => [o.id, { title: o.title, clientName: o.client_name }]),
  );
  const tasks = taskViews(board.tasks, oppIndex, data.clients, people, today);
  const tasksDue = tasks.filter((t) => t.bucket === 'vencida' || t.bucket === 'hoy').length;
  const openOpps = board.opportunities.filter((o) => !o.won_at && !o.lost_at);

  return (
    <CrmScreen
      tab={tab}
      userId={user.id}
      openId={open}
      tiles={crmTiles({
        opportunities: board.opportunities,
        stages: board.stages,
        forecast: board.forecast,
        stale: board.stale.length,
        tasksDue,
        atRisk: data.risk.count,
        today,
      })}
      columns={opportunityColumns(board.stages, data.team)}
      boardRows={boardRows(board.opportunities, board.stages, today, data.quoteLabels)}
      rows={board.opportunities.map((o) =>
        opportunityRow(o, board.stages, today, data.quoteLabels),
      )}
      presets={opportunityPresets(board.stages, user.id)}
      forecast={forecastView(board.forecast)}
      stale={staleViews(board.stale, board.stages, people)}
      tasks={tasks}
      team={data.team}
      opportunities={openOpps.map((o) => ({ id: o.id, label: `${o.title} · ${o.client_name}` }))}
      risk={riskViews(data.risk.list, data.risk.owners)}
      analytics={data.analytics ? analyticsView(data.analytics) : null}
      surveys={surveyViews(data.surveys, data.responses, today, npsSurveyPublicUrl)}
      nps={npsSummary(data.surveys, data.responses)}
      missing={data.missing}
      counts={{
        oportunidades: openOpps.length,
        actividades: tasksDue,
        riesgo: data.risk.count ?? 0,
      }}
      handlers={{
        onEdit: editOpportunityCell,
        onBulkEdit: bulkEditOpportunities,
        onCreate: createOpportunityRow,
        timeline: opportunityTimeline,
        logActivity: logActivityAction,
        completeTask: completeTaskAction,
        sendSurvey: sendSurveyAction,
      }}
    />
  );
}
