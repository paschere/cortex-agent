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
import { margins, quoteConversion, winLoss } from '@cortex/agent-tools/src/crm/analytics';
import { assessChurn, atRiskList } from '@cortex/agent-tools/src/crm/churn';
import { weightedForecast } from '@cortex/agent-tools/src/crm/forecast';
import { staleDeals } from '@cortex/agent-tools/src/crm/rules';
import { DEFAULT_STAGES } from '@cortex/agent-tools/src/crm/shape';
import { notFound } from 'next/navigation';
import { ComercialFixture } from './Showcase';
import {
  CHURN_INPUTS,
  CLIENT_NAMES,
  OPPORTUNITIES,
  PRODUCT_COSTS,
  QUOTES,
  QUOTE_LABELS,
  RESPONSES,
  RISK_OWNERS,
  SALES,
  SURVEYS,
  TASKS,
  TEAM,
  TIMELINE,
  TODAY,
} from './data';

/**
 * EL EMBUDO COMERCIAL CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /comercial pide sesión; aquí se pintan los mismos componentes
 * (components/crm) con los datos de una distribuidora, armados con las
 * mismas funciones de lib/crm/views.ts y el motor de verdad (riesgo,
 * pronóstico, análisis).
 *
 * Parámetros: `?tab=embudo|oportunidades|actividades|riesgo|analisis|encuestas`,
 * `?abrir=o1` (la ficha de un negocio), `?pantalla=encuesta` (lo que ve el
 * cliente), `?modo=oscuro`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function ComercialShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const stages = [...DEFAULT_STAGES];
  const open = OPPORTUNITIES.filter((o) => !o.won_at && !o.lost_at);
  const forecast = weightedForecast(open, stages, { today: TODAY, months: 6 });
  const stale = staleDeals(open, stages, TODAY);
  const people = new Map(TEAM.map((t) => [t.id, t.name]));
  const oppIndex = new Map(
    OPPORTUNITIES.map((o) => [o.id, { title: o.title, clientName: o.client_name }]),
  );
  const tasks = taskViews(TASKS, oppIndex, CLIENT_NAMES, people, TODAY);
  const risk = atRiskList(CHURN_INPUTS.map(assessChurn));
  const names = (id: string | null) => (id ? (people.get(id) ?? 'Alguien') : 'Sin responsable');
  return (
    <ComercialFixture
      dark={one('modo') === 'oscuro'}
      pantalla={one('pantalla') === 'encuesta' ? 'encuesta' : 'lista'}
      timeline={TIMELINE}
      screen={{
        tab: parseCrmTab(one('tab')),
        userId: 'u1',
        openId: one('abrir'),
        tiles: crmTiles({
          opportunities: OPPORTUNITIES,
          stages,
          forecast,
          stale: stale.length,
          tasksDue: tasks.filter((t) => t.bucket === 'vencida' || t.bucket === 'hoy').length,
          atRisk: risk.length,
          today: TODAY,
        }),
        columns: opportunityColumns(stages, TEAM),
        boardRows: boardRows(OPPORTUNITIES, stages, TODAY, QUOTE_LABELS),
        rows: OPPORTUNITIES.map((o) => opportunityRow(o, stages, TODAY, QUOTE_LABELS)),
        presets: opportunityPresets(stages, 'u1'),
        forecast: forecastView(forecast),
        stale: staleViews(stale, stages, people),
        tasks,
        team: TEAM,
        opportunities: open.map((o) => ({ id: o.id, label: `${o.title} · ${o.client_name}` })),
        risk: riskViews(risk, RISK_OWNERS),
        analytics: analyticsView({
          conversion: quoteConversion(QUOTES, { today: TODAY, ownerName: names }),
          winLoss: winLoss(OPPORTUNITIES, QUOTES, stages, TODAY),
          margins: margins(SALES, PRODUCT_COSTS),
          missing: [],
        }),
        surveys: surveyViews(
          SURVEYS,
          RESPONSES,
          TODAY,
          (t) => `http://localhost:3100/encuesta/${t}`,
        ),
        nps: npsSummary(SURVEYS, RESPONSES),
        missing: [],
        counts: {
          oportunidades: open.length,
          actividades: tasks.filter((t) => t.bucket === 'vencida' || t.bucket === 'hoy').length,
          riesgo: risk.length,
        },
      }}
    />
  );
}
