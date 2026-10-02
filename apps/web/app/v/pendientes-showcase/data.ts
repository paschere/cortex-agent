import 'server-only';
import type { ActionView } from '@/lib/actions-shape';
import { type GroupView, actionGroups } from '@/lib/follow-through/pending-groups';
import type { WaitingIndex } from '@/lib/waiting';
import {
  type ActionRow,
  EMPTY_ACTIVITY,
  FOLLOW_UP_HEADING,
  type RecommendationRecord,
  adaptAction,
  fallbackWeekly,
  followUpSection,
  renderWeekly,
  resolveHref,
  resolveStepFor,
  weeklyFacts,
  weeklyRecommendations,
} from '@cortex/agent-tools';

/**
 * LOGÍSTICA ANDINA, CON LO PENDIENTE APILADO. SÓLO EN DESARROLLO.
 *
 * Todo lo que se pinta sale de las funciones de verdad: los grupos de
 * `actionGroups` (follow-through/group.ts), «Lo que recomendé y qué pasó» de
 * `followUpSection` (follow-through/recommendations/report.ts) metido en
 * `renderWeekly`, y los botones «Que Cortex lo resuelva» de `resolveStepFor`.
 * Lo inventado son las filas.
 */

// Viernes 2 de octubre de 2026, 10:00 de Bogotá.
export const NOW = new Date('2026-10-02T15:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const CLIENTS = [
  ['Nexa Logística', 'cartera@nexa.com.co', 'FV-1021', '$ 12.000.000', 41],
  ['Ferretería El Tornillo', 'pagos@eltornillo.co', 'FV-0998', '$ 3.000.000', 33],
  ['Agroandina', 'tesoreria@agroandina.co', 'FV-1007', '$ 2.450.000', 29],
  ['Coltrans', 'cxp@coltrans.com', 'FV-1012', '$ 1.980.000', 26],
  ['Distribuidora Paisa', 'facturas@dpaisa.co', 'FV-1015', '$ 1.200.000', 24],
  ['Servientrega Norte', 'pagos@snorte.co', 'FV-1019', '$ 860.000', 22],
] as const;

type Client = readonly [string, string, string, string, number];

function row(i: number, client: Client, ageHours: number): ActionRow {
  const [name, to, invoice, amount, days] = client;
  const subject = `Factura ${invoice} vencida hace ${days} días`;
  return {
    id: `00000000-0000-4000-8000-00000000000${i}`,
    user_id: 'u-dueno',
    agent_id: 'a-1',
    conversation_id: null,
    kind: 'collect_payment',
    tool_id: 'gmail.send_message',
    tool_input: {
      to: [to],
      subject,
      body: `Buenos días, equipo de ${name}:\n\nLes escribimos por la factura ${invoice} por ${amount}, que lleva ${days} días vencida…`,
    },
    content_hash: `${'a'.repeat(63)}${i}`,
    recipient: to,
    subject,
    origin_kind: 'commitment',
    origin_id: null,
    rationale: `${name} debe ${amount} de la ${invoice}.`,
    client_id: null,
    state: 'proposed',
    expires_at: new Date(Date.parse(hoursAgo(ageHours)) + 7 * 86_400_000).toISOString(),
    decided_at: null,
    decided_by: null,
    decided_via: null,
    dismissed_reason: null,
    executed_at: null,
    execution_status: null,
    execution_error: null,
    execution_result: null,
    thread_id: null,
    outcome: 'none',
    outcome_at: null,
    outcome_note: null,
    edited_count: 0,
    escalated_at: null,
    escalated_to: null,
    escalated_via: null,
    created_at: hoursAgo(ageHours),
    updated_at: hoursAgo(ageHours),
  };
}

/** Seis cobros parecidos de esta semana y dos que ya llevan días. */
export function fixtureActions(): {
  stale: GroupView | null;
  groups: GroupView[];
  views: Record<string, ActionView>;
} {
  const rows = [
    ...CLIENTS.map((c, i) => row(i + 1, c, 20 + i * 6)),
    row(7, ['Transportes del Valle', 'pagos@tvalle.co', 'FV-0950', '$ 4.100.000', 58], 6 * 24),
    row(8, ['Cementos del Sur', 'cartera@csur.co', 'FV-0961', '$ 2.000.000', 51], 5 * 24 + 3),
  ];
  const { stale, groups } = actionGroups(rows, NOW);
  return {
    stale,
    groups,
    views: Object.fromEntries(rows.map((r) => [r.id, adaptAction(r) as ActionView])),
  };
}

const rec = (over: Partial<RecommendationRecord>): RecommendationRecord => ({
  id: 'r',
  source: 'weekly_review',
  kind: 'collect_counterparty',
  subjectKind: 'counterparty',
  subjectKey: 'nexa',
  subjectLabel: 'Nexa',
  text: '',
  headline: '',
  suggestedAction: null,
  expectedEffect: 'collect',
  severity: 'warn',
  baseline: {},
  createdFor: 'u-dueno',
  createdAt: '2026-09-21T12:30:00Z',
  status: 'open',
  followedAt: null,
  followEvidence: {},
  outcome: null,
  outcomeEvidence: {},
  evaluatedAt: null,
  ...over,
});

/** Lo que se recomendó las semanas pasadas, ya juzgado. */
export const PAST: RecommendationRecord[] = [
  rec({
    id: 'r-nexa',
    headline: 'cobrarle primero a Nexa',
    status: 'followed',
    followedAt: '2026-09-29T15:00:00Z',
    followEvidence: { what: 'collection_sent', at: '2026-09-29T15:00:00Z', count: 1 },
    outcome: 'good',
    outcomeEvidence: { what: 'payment', at: '2026-10-01', amount: 12_000_000, currency: 'COP' },
  }),
  rec({
    id: 'r-laura',
    source: 'work_signals',
    kind: 'rebalance_person',
    subjectKind: 'person',
    subjectKey: 'u-laura',
    subjectLabel: 'Laura',
    headline: 'repartir los despachos de Laura',
    status: 'not_followed',
    outcome: 'none',
    outcomeEvidence: { what: 'count', from: 15, to: 15 },
  }),
  rec({
    id: 'r-rutina',
    kind: 'fix_routine',
    subjectKind: 'routine',
    subjectKey: 'cartera de los viernes',
    headline: 'arreglar la rutina «Cartera de los viernes»',
    status: 'followed',
    followedAt: '2026-09-23T14:00:00Z',
    followEvidence: { what: 'routine_changed', at: '2026-09-23T14:00:00Z' },
    outcome: 'good',
    outcomeEvidence: { what: 'no_errors' },
  }),
  rec({
    id: 'r-compromisos',
    kind: 'close_commitments',
    subjectKind: 'company',
    subjectKey: 'close_commitments',
    headline: 'cerrar o reprogramar los compromisos vencidos',
    status: 'followed',
    outcome: 'good',
    followEvidence: { what: 'count_dropped', count: 4 },
    outcomeEvidence: { what: 'count', from: 6, to: 2 },
  }),
];

/** La revisión del viernes, con su sección nueva. */
export function fixtureWeekly(): { markdown: string; lines: string[] } {
  const today = '2026-10-02';
  const comp = weeklyFacts({
    today,
    from: '2026-09-25',
    to: '2026-10-01',
    current: null,
    base: null,
    activity: {
      ...EMPTY_ACTIVITY,
      actionsSent: 4,
      actionsFailed: 0,
      receivableNotices: 3,
      commitmentNotices: 2,
      recoveredCop: 12_000_000,
      recoveredInvoices: 1,
      routineRuns: 12,
      routineErrors: 0,
      failingRoutines: [],
      approvalsPending: 0,
      draftsPending: 8,
      tasksDone: 20,
      closures: 1,
      cashAlerts: [],
      gaps: [],
    },
  });
  const followUp = followUpSection(PAST, { today, max: 4 });
  const recs = weeklyRecommendations(comp.facts, comp, { hasPulse: true });
  const markdown = renderWeekly(comp, fallbackWeekly(comp, recs), {
    today,
    hasPulse: true,
    fallback: true,
    followUp: { heading: FOLLOW_UP_HEADING, lines: followUp.lines },
  });
  return { markdown, lines: followUp.lines };
}

function resolve(
  kind: Parameters<typeof resolveStepFor>[0]['kind'],
  title: string,
  detail: string | null,
) {
  const step = resolveStepFor({ kind, title, detail });
  const href = resolveHref(step);
  return step && href ? { label: step.label, href } : null;
}

/** «Te espera» con lo viejo marcado y el botón del siguiente paso seguro. */
export function fixtureWaiting(): WaitingIndex {
  return {
    counts: { approvals: 0, commitments: 3, actions: 8, errands: 1 },
    total: 12,
    sentence: 'Doce cosas te esperan: dos ya se vencieron y una lleva seis días.',
    queues: [
      {
        queue: 'approvals',
        label: 'Aprobaciones',
        href: '/approvals',
        count: 0,
        items: [],
        error: null,
      },
      {
        queue: 'commitments',
        label: 'Vencimientos',
        href: '/commitments',
        count: 3,
        error: null,
        items: [
          {
            id: 'c1',
            title: 'SOAT del camión WMK-341',
            detail: 'SOAT · Seguros Bolívar',
            when: 'se venció hace cuatro días',
            tone: 'rose',
            stale: true,
            resolve: resolve('commitment', 'SOAT del camión WMK-341', 'Seguros Bolívar'),
          },
          {
            id: 'c2',
            title: 'Declaración de importación DI-2207',
            detail: 'Aduana · DHL',
            when: 'vence mañana',
            tone: 'amber',
            resolve: resolve('commitment', 'Declaración de importación DI-2207', 'DHL'),
          },
        ],
      },
      {
        queue: 'actions',
        label: 'Acciones',
        href: '/actions',
        count: 8,
        error: null,
        items: [
          {
            id: 'a7',
            title: 'Factura FV-0950 vencida hace 58 días',
            detail: 'Cobro de cartera · pagos@tvalle.co',
            when: 'redactada hace seis días',
            tone: 'amber',
            stale: true,
            resolve: resolve('action', 'Factura FV-0950 vencida hace 58 días', 'pagos@tvalle.co'),
          },
          {
            id: 'a1',
            title: 'Factura FV-1021 vencida hace 41 días',
            detail: 'Cobro de cartera · cartera@nexa.com.co',
            when: 'redactada hace un día',
            tone: 'primary',
          },
        ],
      },
      {
        queue: 'errands',
        label: 'Encargos',
        href: '/errands',
        count: 1,
        error: null,
        items: [
          {
            id: 'e1',
            title: 'Conciliar los recibos de caja de septiembre',
            detail: 'Te preguntó algo y está esperando',
            when: 'encargado hace dos días',
            tone: 'amber',
            resolve: resolve('errand', 'Conciliar los recibos de caja de septiembre', null),
          },
        ],
      },
    ],
  };
}
