import type { GridColumn, GridOption, GridRow, GridView } from '@/components/datagrid/types';
import type {
  CrmActivityRow,
  CrmAnalytics,
  CrmChurnAssessment,
  CrmForecast,
  CrmOpportunityRow,
  CrmStageDef,
  CrmStaleDeal,
  CrmTimelineItem,
  NpsResponseRow,
  NpsSurveyRow,
} from '@cortex/agent-tools';
import {
  ACTIVITY_LABEL,
  LOST_REASONS,
  LOST_REASON_LABEL,
  NPS_BUCKET_LABEL,
  RISK_LABEL,
  SOURCES,
  SOURCE_LABEL,
  effectiveProbability,
  formatAmount,
  isClosedStage,
  npsBucket,
  npsScore,
  stageOf,
} from '@cortex/agent-tools/src/crm/shape';
import type {
  AnalyticsView,
  ClientOpportunityView,
  CrmTile,
  ForecastView,
  MarginRowView,
  NpsSummaryView,
  RateRowView,
  RiskView,
  StaleView,
  SurveyView,
  TaskView,
  TimelineEntryView,
  Tone,
} from './shape';

/**
 * DE LOS DATOS DEL EMBUDO A LO QUE LA PANTALLA PINTA (migración 0193).
 *
 * Funciones puras: las usan la página (con los datos de verdad) y el
 * escaparate de desarrollo (con datos inventados), así las dos pintan lo
 * mismo. Las cifras salen como texto en español; los tonos como palabras.
 */

const money = (n: number, currency = 'COP') => formatAmount(n, currency);
const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)} %`);

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? month} ${String(y).slice(2)}`;
}

export function dayLabel(day: string | null, today: string): string {
  if (!day) return 'Sin fecha';
  const d = day.slice(0, 10);
  if (d === today) return 'Hoy';
  const diff = Math.round(
    (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const base = `${dd} ${MONTHS[m - 1]}`;
  return y === Number(today.slice(0, 4)) ? base : `${base} ${y}`;
}

function stageTone(stage: CrmStageDef | null): Tone {
  switch (stage?.role) {
    case 'won':
      return 'emerald';
    case 'lost':
      return 'rose';
    case 'at_risk':
      return 'amber';
    case 'quote_sent':
      return 'primary';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// La grilla de oportunidades (tablero y tabla)
// ---------------------------------------------------------------------------

export function opportunityColumns(
  stages: readonly CrmStageDef[],
  team: ReadonlyArray<{ id: string; name: string }>,
): GridColumn[] {
  const stageOptions: GridOption[] = stages.map((s) => ({
    value: s.key,
    label: s.label,
    tone: stageTone(s),
  }));
  return [
    {
      key: 'titulo',
      label: 'Negocio',
      type: 'text',
      editable: true,
      required: true,
      pinned: true,
      primary: true,
      width: 230,
    },
    { key: 'cliente', label: 'Cliente', type: 'text', editable: true, required: true, width: 180 },
    {
      key: 'etapa',
      label: 'Etapa',
      type: 'status',
      editable: true,
      options: stageOptions,
      width: 160,
      description:
        'Arrastra la tarjeta en el tablero para moverla. Con una cotización atada se mueve sola: enviada, aceptada o vencida.',
    },
    { key: 'valor', label: 'Valor', type: 'money', editable: true, width: 140 },
    {
      key: 'probabilidad',
      label: 'Probabilidad',
      type: 'percent',
      editable: true,
      width: 110,
      description: 'Vacía = la de la etapa. Cambiar de etapa la devuelve a la de la etapa.',
    },
    {
      key: 'ponderado',
      label: 'Ponderado',
      type: 'money',
      width: 130,
      description: 'Valor × probabilidad: lo que el pronóstico cuenta.',
    },
    { key: 'cierre', label: 'Cierre esperado', type: 'date', editable: true, width: 130 },
    {
      key: 'responsable',
      label: 'Responsable',
      type: 'select',
      editable: true,
      options: team.map((t) => ({ value: t.id, label: t.name })),
      width: 150,
    },
    { key: 'siguiente', label: 'Siguiente paso', type: 'text', editable: true, width: 220 },
    { key: 'siguiente_fecha', label: 'Para cuándo', type: 'date', editable: true, width: 120 },
    {
      key: 'origen',
      label: 'Origen',
      type: 'select',
      editable: true,
      options: SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
      width: 120,
    },
    {
      key: 'quieto',
      label: 'Días quieto',
      type: 'number',
      width: 100,
      description: 'Días desde la última actividad o cambio de etapa.',
    },
    {
      key: 'razon',
      label: 'Por qué se perdió',
      type: 'select',
      editable: true,
      options: LOST_REASONS.map((r) => ({ value: r, label: LOST_REASON_LABEL[r] })),
      width: 170,
    },
    { key: 'cotizacion', label: 'Cotización', type: 'text', width: 110 },
  ];
}

export function opportunityRow(
  o: CrmOpportunityRow,
  stages: readonly CrmStageDef[],
  today: string,
  quoteLabels: Map<string, string> = new Map(),
): GridRow {
  const prob = effectiveProbability(o, stages);
  const quiet = Math.max(
    0,
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(o.last_activity_at)) / 86_400_000),
  );
  return {
    id: o.id,
    values: {
      titulo: o.title,
      cliente: o.client_name,
      etapa: o.stage,
      valor: o.value,
      probabilidad: prob,
      ponderado: Math.round((o.value * prob) / 100),
      cierre: o.expected_close,
      responsable: o.owner_user_id,
      siguiente: o.next_step,
      siguiente_fecha: o.next_step_due,
      origen: o.source,
      quieto: isClosedStage(stages, o.stage) ? null : quiet,
      razon: o.lost_reason_kind,
      cotizacion: o.quote_id ? (quoteLabels.get(o.quote_id) ?? 'Atada') : null,
    },
  };
}

const AGGREGATES: GridView['aggregates'] = {
  probabilidad: 'avg',
  quieto: 'none',
};

export function opportunityPresets(
  stages: readonly CrmStageDef[],
  userId: string | null,
): Array<{ id: string; label: string; view: Partial<GridView> }> {
  const open = stages.filter((s) => s.role !== 'won' && s.role !== 'lost').map((s) => s.key);
  const won = stages.filter((s) => s.role === 'won').map((s) => s.key);
  const lost = stages.filter((s) => s.role === 'lost').map((s) => s.key);
  const presets: Array<{ id: string; label: string; view: Partial<GridView> }> = [
    {
      id: 'abiertas',
      label: 'Abiertas',
      view: {
        filters: [{ key: 'etapa', op: 'in', value: open }],
        sort: [{ key: 'ponderado', dir: 'desc' }],
      },
    },
    {
      id: 'mias',
      label: 'Mías',
      view: {
        filters: [
          { key: 'etapa', op: 'in', value: open },
          ...(userId ? [{ key: 'responsable', op: 'eq' as const, value: userId }] : []),
        ],
        sort: [{ key: 'cierre', dir: 'asc' }],
      },
    },
    {
      id: 'quietas',
      label: 'Quietas',
      view: {
        filters: [
          { key: 'etapa', op: 'in', value: open },
          { key: 'quieto', op: 'gte', value: 14 },
        ],
        sort: [{ key: 'valor', dir: 'desc' }],
      },
    },
    {
      id: 'ganadas',
      label: 'Ganadas',
      view: { filters: [{ key: 'etapa', op: 'in', value: won }], sort: [] },
    },
    {
      id: 'perdidas',
      label: 'Perdidas',
      view: {
        filters: [{ key: 'etapa', op: 'in', value: lost }],
        sort: [],
        groupBy: 'razon',
      },
    },
    { id: 'todas', label: 'Todas', view: { filters: [], sort: [] } },
  ];
  return presets.map((p) => ({ ...p, view: { ...p.view, aggregates: AGGREGATES } }));
}

/** El tablero: lo abierto y lo cerrado en los últimos 45 días. */
export function boardRows(
  opps: readonly CrmOpportunityRow[],
  stages: readonly CrmStageDef[],
  today: string,
  quoteLabels?: Map<string, string>,
): GridRow[] {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86_400_000).toISOString();
  return opps
    .filter((o) => !isClosedStage(stages, o.stage) || (o.won_at ?? o.lost_at ?? '') >= since)
    .map((o) => opportunityRow(o, stages, today, quoteLabels));
}

// ---------------------------------------------------------------------------
// Cifras de arriba, pronóstico y lo quieto
// ---------------------------------------------------------------------------

export function crmTiles(input: {
  opportunities: readonly CrmOpportunityRow[];
  stages: readonly CrmStageDef[];
  forecast: CrmForecast;
  stale: number;
  tasksDue: number;
  atRisk: number | null;
  today: string;
}): CrmTile[] {
  const open = input.opportunities.filter((o) => !isClosedStage(input.stages, o.stage));
  const monthStart = `${input.today.slice(0, 7)}-01`;
  const wonMonth = input.opportunities.filter(
    (o) => o.won_at && o.won_at.slice(0, 10) >= monthStart && o.currency === 'COP',
  );
  const first = input.forecast.months[0];
  return [
    {
      label: 'Embudo abierto',
      value: money(input.forecast.pipelineTotal),
      note: `${open.length} negocio${open.length === 1 ? '' : 's'}; ponderado ${money(input.forecast.pipelineWeighted)}.`,
      tone: 'neutral',
    },
    {
      label: 'Pronóstico del mes',
      value: money(first?.weighted ?? 0),
      note: first?.count
        ? `${first.count} negocio${first.count === 1 ? '' : 's'} que cierran este mes, por su probabilidad.`
        : 'Nada con cierre esperado este mes.',
      tone: 'primary',
    },
    {
      label: 'Ganado este mes',
      value: money(wonMonth.reduce((s, o) => s + o.value, 0)),
      note: `${wonMonth.length} negocio${wonMonth.length === 1 ? '' : 's'} cerrado${wonMonth.length === 1 ? '' : 's'}.`,
      tone: 'emerald',
    },
    {
      label: 'Para mover hoy',
      value: String(input.stale + input.tasksDue),
      note: `${input.stale} quieto${input.stale === 1 ? '' : 's'} y ${input.tasksDue} tarea${input.tasksDue === 1 ? '' : 's'} para hoy o vencida${input.tasksDue === 1 ? '' : 's'}.`,
      tone: input.stale + input.tasksDue > 0 ? 'amber' : 'neutral',
    },
    {
      label: 'Clientes en riesgo',
      value: input.atRisk === null ? '—' : String(input.atRisk),
      note:
        input.atRisk === null
          ? 'Se calcula en la pestaña En riesgo y cada mañana.'
          : 'Con señales de que se están yendo.',
      tone: input.atRisk ? 'rose' : 'neutral',
    },
  ];
}

export function forecastView(f: CrmForecast): ForecastView {
  const max = Math.max(1, ...f.months.map((m) => m.weighted));
  const notes: string[] = [];
  if (f.overdue.count)
    notes.push(
      `${f.overdue.count} negocio${f.overdue.count === 1 ? '' : 's'} ya debía${f.overdue.count === 1 ? '' : 'n'} haber cerrado (${money(f.overdue.weighted)} ponderado): cuentan en este mes, ponles fecha nueva.`,
    );
  if (f.undated.count)
    notes.push(
      `${f.undated.count} sin fecha de cierre (${money(f.undated.weighted)} ponderado) no entran en ningún mes.`,
    );
  if (f.otherCurrencies.length)
    notes.push(`Negocios en ${f.otherCurrencies.join(', ')} no se suman a los pesos.`);
  return {
    bars: f.months.map((m) => ({
      month: m.month,
      label: monthLabel(m.month),
      weighted: m.weighted,
      weightedLabel: money(m.weighted),
      totalLabel: money(m.total),
      count: m.count,
      share: m.weighted / max,
    })),
    pipelineWeightedLabel: money(f.pipelineWeighted),
    pipelineTotalLabel: money(f.pipelineTotal),
    notes,
  };
}

export function staleViews(
  stale: readonly CrmStaleDeal[],
  stages: readonly CrmStageDef[],
  owners: Map<string, string>,
): StaleView[] {
  return stale.slice(0, 12).map((d) => ({
    id: d.id,
    title: d.title,
    clientName: d.clientName,
    valueLabel: money(d.value, d.currency),
    why: d.why,
    suggestion: d.suggestion,
    ownerName: d.ownerUserId ? (owners.get(d.ownerUserId) ?? null) : null,
    stageLabel: stageOf(stages, d.stage)?.label ?? d.stage,
  }));
}

// ---------------------------------------------------------------------------
// Tareas
// ---------------------------------------------------------------------------

const ORIGIN_LABEL: Record<string, string | null> = {
  manual: null,
  rule: 'Regla automática',
  nps: 'Encuesta',
  autopilot: 'Piloto automático',
  agent: 'Desde el chat',
};

export function taskViews(
  tasks: readonly CrmActivityRow[],
  opps: Map<string, { title: string; clientName: string }>,
  clients: Map<string, string>,
  owners: Map<string, string>,
  today: string,
): TaskView[] {
  const in7 = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return tasks
    .filter((t) => t.kind === 'task' && !t.done_at && (!t.due_on || t.due_on <= in7))
    .map((t) => {
      const opp = t.opportunity_id ? opps.get(t.opportunity_id) : null;
      const bucket: TaskView['bucket'] = !t.due_on
        ? 'sin_fecha'
        : t.due_on < today
          ? 'vencida'
          : t.due_on === today
            ? 'hoy'
            : 'proxima';
      return {
        id: t.id,
        title: t.title,
        body: t.body,
        kindLabel: ACTIVITY_LABEL[t.kind],
        due: t.due_on,
        dueLabel: dayLabel(t.due_on, today),
        bucket,
        oppId: t.opportunity_id,
        oppTitle: opp?.title ?? null,
        clientName: opp?.clientName ?? (t.client_id ? (clients.get(t.client_id) ?? null) : null),
        clientId: t.client_id,
        ownerId: t.owner_user_id,
        ownerName: t.owner_user_id ? (owners.get(t.owner_user_id) ?? null) : null,
        originLabel: ORIGIN_LABEL[t.origin] ?? null,
      };
    })
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
}

// ---------------------------------------------------------------------------
// Riesgo
// ---------------------------------------------------------------------------

export function riskViews(
  list: readonly CrmChurnAssessment[],
  owners: Map<string, string | null>,
): RiskView[] {
  return list
    .filter((a): a is CrmChurnAssessment & { level: 'alto' | 'medio' } => a.level !== 'bajo')
    .map((a) => ({
      clientId: a.clientId,
      clientName: a.clientName,
      level: a.level,
      levelLabel: RISK_LABEL[a.level],
      tone: a.level === 'alto' ? 'rose' : 'amber',
      score: a.score,
      evidence: a.signals.map((s) => s.evidence),
      action: a.action,
      ownerName: owners.get(a.clientId) ?? null,
      revenueLabel:
        a.revenue12m > 0 ? `${money(a.revenue12m)} en 12 meses` : 'Sin facturas en 12 meses',
      href: `/clients/${a.clientId}`,
    }));
}

// ---------------------------------------------------------------------------
// Análisis
// ---------------------------------------------------------------------------

function rateRow(r: {
  key: string;
  label: string;
  won: number;
  lost: number;
  open: number;
  rate: number | null;
}): RateRowView {
  return {
    key: r.key,
    label: r.label,
    rate: r.rate,
    rateLabel: pct(r.rate),
    detail: `${r.won} ganada${r.won === 1 ? '' : 's'} · ${r.lost} perdida${r.lost === 1 ? '' : 's'}${r.open ? ` · ${r.open} abierta${r.open === 1 ? '' : 's'}` : ''}`,
  };
}

function marginRow(r: CrmAnalytics['margins']['byClient'][number]): MarginRowView {
  return {
    key: r.key,
    label: r.label,
    revenueLabel: money(r.revenue),
    marginLabel: r.margin === null ? 'Sin costo' : pct(r.margin),
    marginTone:
      r.margin === null
        ? 'neutral'
        : r.margin < 0.15
          ? 'rose'
          : r.margin < 0.3
            ? 'amber'
            : 'emerald',
    coverageLabel:
      r.coverage >= 0.995 ? 'Todo con costo' : `${Math.round(r.coverage * 100)} % con costo`,
    discountLabel: r.avgDiscount
      ? `${r.avgDiscount.toLocaleString('es-CO')} % dcto.`
      : 'Sin descuento',
    priceLabel:
      r.avgPrice !== undefined
        ? r.minPrice !== r.maxPrice
          ? `${money(r.avgPrice)} prom. (${money(r.minPrice ?? 0)}–${money(r.maxPrice ?? 0)})`
          : `${money(r.avgPrice)} c/u`
        : null,
  };
}

export function analyticsView(a: CrmAnalytics): AnalyticsView {
  const c = a.conversion.overall;
  const w = a.winLoss;
  const maxReason = Math.max(1, ...w.reasons.map((r) => r.count));
  return {
    tiles: [
      {
        label: 'Conversión de cotizaciones',
        value: pct(c.rate),
        note: `${c.won} ganadas de ${c.won + c.lost} decididas${c.open ? `; ${c.open} siguen abiertas` : ''}.`,
        tone:
          c.rate === null
            ? 'neutral'
            : c.rate >= 0.4
              ? 'emerald'
              : c.rate >= 0.25
                ? 'amber'
                : 'rose',
      },
      {
        label: 'Cierre de oportunidades',
        value: pct(w.winRate),
        note: `${w.won.count} ganadas (${money(w.won.value)}) y ${w.lost.count} perdidas.`,
        tone: 'neutral',
      },
      {
        label: 'Ticket promedio',
        value: w.averageDeal === null ? '—' : money(w.averageDeal),
        note: 'Lo ganado en los últimos 12 meses.',
        tone: 'primary',
      },
      {
        label: 'Ciclo de venta',
        value:
          w.opportunityCycle.medianDays === null ? '—' : `${w.opportunityCycle.medianDays} días`,
        note:
          w.quoteCycle.medianDays === null
            ? 'Mediana de la oportunidad abierta a ganada.'
            : `De abierta a ganada; de cotización a sí: ${w.quoteCycle.medianDays} días.`,
        tone: 'neutral',
      },
    ],
    byMonth: a.conversion.byMonth
      .slice(-12)
      .map((r) => rateRow({ ...r, label: monthLabel(r.key) })),
    byOwner: a.conversion.byOwner.map(rateRow),
    byProduct: a.conversion.byProduct.map(rateRow),
    reasons: w.reasons.map((r) => ({
      label: r.label,
      count: r.count,
      valueLabel: money(r.value),
      share: r.count / maxReason,
    })),
    bySource: w.bySource.map((s) => ({
      label: SOURCE_LABEL[s.source as keyof typeof SOURCE_LABEL] ?? s.source,
      detail: `${s.won} ganada${s.won === 1 ? '' : 's'} (${money(s.value)}) · ${s.lost} perdida${s.lost === 1 ? '' : 's'}`,
    })),
    marginTotals: {
      revenueLabel: money(a.margins.totals.revenue),
      marginLabel: a.margins.totals.margin === null ? 'Sin costo' : pct(a.margins.totals.margin),
      coverageLabel: `${Math.round(a.margins.totals.coverage * 100)} % de la venta con costo`,
    },
    marginNote: a.margins.note,
    marginsByClient: a.margins.byClient.slice(0, 15).map(marginRow),
    marginsByProduct: a.margins.byProduct.slice(0, 15).map(marginRow),
    missing: a.missing,
  };
}

// ---------------------------------------------------------------------------
// Encuestas
// ---------------------------------------------------------------------------

const SURVEY_STATUS: Record<string, { label: string; tone: Tone }> = {
  pendiente: { label: 'Enlace creado', tone: 'neutral' },
  enviada: { label: 'Enviada', tone: 'primary' },
  respondida: { label: 'Respondida', tone: 'emerald' },
  anulada: { label: 'Anulada', tone: 'neutral' },
};

export function surveyViews(
  surveys: readonly NpsSurveyRow[],
  responses: readonly NpsResponseRow[],
  today: string,
  linkOf: (token: string) => string,
): SurveyView[] {
  const bySurvey = new Map(responses.map((r) => [r.survey_id, r]));
  return surveys.map((s) => {
    const r = bySurvey.get(s.id);
    const st = SURVEY_STATUS[s.status] ?? { label: s.status, tone: 'neutral' as Tone };
    const bucket = r ? npsBucket(r.score) : null;
    return {
      id: s.id,
      clientName: s.client_name,
      clientId: s.client_id,
      contact: s.contact_name ?? s.contact_email,
      statusLabel: st.label,
      tone: bucket === 'detractor' ? 'rose' : bucket === 'pasivo' ? 'amber' : st.tone,
      sentLabel: dayLabel((r?.created_at ?? s.sent_at ?? s.created_at).slice(0, 10), today),
      score: r?.score ?? null,
      bucketLabel: bucket ? NPS_BUCKET_LABEL[bucket] : null,
      comment: r?.comment ?? null,
      respondent: r?.respondent_name ?? null,
      link: linkOf(s.token),
      followUp: !!r?.follow_up_id,
    };
  });
}

export function npsSummary(
  surveys: readonly NpsSurveyRow[],
  responses: readonly NpsResponseRow[],
): NpsSummaryView {
  const scores = responses.map((r) => r.score);
  const n = npsScore(scores);
  const count = (b: string) => scores.filter((s) => npsBucket(s) === b).length;
  return {
    scoreLabel: n === null ? '—' : `${n > 0 ? '+' : ''}${n}`,
    tone: n === null ? 'neutral' : n >= 30 ? 'emerald' : n >= 0 ? 'amber' : 'rose',
    responses: scores.length,
    promoters: count('promotor'),
    passives: count('pasivo'),
    detractors: count('detractor'),
    pending: surveys.filter((s) => s.status === 'pendiente' || s.status === 'enviada').length,
    note:
      scores.length < 10
        ? 'Con menos de 10 respuestas el NPS se mueve mucho con cada una: léelo como pista, no como verdad.'
        : 'Promotores (9–10) menos detractores (0–6), sobre el total de respuestas.',
  };
}

// ---------------------------------------------------------------------------
// Línea de tiempo y ficha del cliente
// ---------------------------------------------------------------------------

export function timelineViews(
  items: readonly CrmTimelineItem[],
  today: string,
): TimelineEntryView[] {
  return items.map((i) => ({
    id: i.id,
    whenLabel: dayLabel(i.at.slice(0, 10), today),
    kindLabel: i.kindLabel,
    title: i.title,
    detail: i.detail,
    by: i.by,
    href: i.href,
    from: i.from,
    done: i.done,
  }));
}

export function clientOpportunityViews(
  opps: readonly CrmOpportunityRow[],
  stages: readonly CrmStageDef[],
  today: string,
): ClientOpportunityView[] {
  return opps.slice(0, 8).map((o) => {
    const stage = stageOf(stages, o.stage);
    return {
      id: o.id,
      title: o.title,
      stageLabel: stage?.label ?? o.stage,
      tone: stageTone(stage),
      valueLabel: money(o.value, o.currency),
      closeLabel: o.expected_close
        ? `Cierre ${dayLabel(o.expected_close, today).toLowerCase()}`
        : null,
      nextStep: o.next_step,
      href: `/comercial?tab=oportunidades&abrir=${o.id}`,
    };
  });
}
