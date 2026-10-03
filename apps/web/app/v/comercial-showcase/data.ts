import type {
  CrmActivityRow,
  CrmOpportunityRow,
  NpsResponseRow,
  NpsSurveyRow,
} from '@cortex/agent-tools';
import type { QuoteIn, SaleIn } from '@cortex/agent-tools/src/crm/analytics';
import type { ChurnInput } from '@cortex/agent-tools/src/crm/churn';

/**
 * Una distribuidora de insumos industriales con su embudo de octubre. Datos
 * inventados para el escaparate de desarrollo de /comercial.
 */

export const TODAY = '2026-10-03';

export const TEAM = [
  { id: 'u1', name: 'Laura Gómez' },
  { id: 'u2', name: 'Andrés Ríos' },
  { id: 'u3', name: 'Camila Torres' },
];

const ago = (days: number) =>
  new Date(Date.parse(`${TODAY}T15:00:00Z`) - days * 86_400_000).toISOString();
const day = (days: number) => ago(-days).slice(0, 10);

function opp(id: string, over: Partial<CrmOpportunityRow>): CrmOpportunityRow {
  return {
    id,
    pipeline_id: null,
    client_id: `c-${id}`,
    client_name: 'Cliente',
    title: 'Negocio',
    value: 10_000_000,
    currency: 'COP',
    stage: 'nuevo',
    probability: null,
    expected_close: null,
    owner_user_id: 'u1',
    source: 'inbound',
    prospect_ref: null,
    next_step: null,
    next_step_due: null,
    lost_reason_kind: null,
    lost_reason: null,
    quote_id: null,
    order_id: null,
    notes: null,
    stage_changed_at: ago(10),
    last_activity_at: ago(3),
    won_at: null,
    lost_at: null,
    created_by: 'u1',
    created_at: ago(40),
    updated_at: ago(3),
    ...over,
  };
}

export const OPPORTUNITIES: CrmOpportunityRow[] = [
  opp('o1', {
    title: 'Guantes y EPP 2027',
    client_name: 'Constructora Andina',
    value: 48_000_000,
    stage: 'negociacion',
    expected_close: day(20),
    next_step: 'Confirmar descuento por volumen',
    next_step_due: day(2),
    source: 'referral',
  }),
  opp('o2', {
    title: 'Fletes Bogotá–Cali Q4',
    client_name: 'Nexa Logística',
    value: 32_500_000,
    stage: 'cotizacion_enviada',
    expected_close: day(12),
    quote_id: 'q12',
    last_activity_at: ago(19),
    owner_user_id: 'u2',
  }),
  opp('o3', {
    title: 'Tornillería planta Funza',
    client_name: 'Metalmecánica del Valle',
    value: 12_800_000,
    stage: 'contactado',
    expected_close: day(35),
    owner_user_id: 'u3',
    source: 'whatsapp',
  }),
  opp('o4', {
    title: 'Renovación contrato soporte',
    client_name: 'Coltrans',
    value: 24_000_000,
    stage: 'en_riesgo',
    expected_close: day(-4),
    quote_id: 'q9',
    last_activity_at: ago(25),
    next_step: 'Mandar cotización actualizada',
    next_step_due: day(-6),
  }),
  opp('o5', {
    title: 'Señalización bodega 3',
    client_name: 'Almacenes Éxito Sur',
    value: 7_400_000,
    stage: 'nuevo',
    owner_user_id: 'u2',
    source: 'email',
  }),
  opp('o6', {
    title: 'Dotación 2027',
    client_name: 'Clínica Santa Fe',
    value: 61_000_000,
    stage: 'negociacion',
    probability: 80,
    expected_close: day(45),
    owner_user_id: 'u3',
    source: 'prospect',
  }),
  opp('o7', {
    title: 'Cintas y empaques',
    client_name: 'Postobón Bucaramanga',
    value: 9_900_000,
    stage: 'cotizacion_enviada',
    expected_close: day(8),
    quote_id: 'q14',
  }),
  opp('o8', {
    title: 'Mangueras hidráulicas',
    client_name: 'Agroindustrial La Fe',
    value: 15_600_000,
    stage: 'ganada',
    won_at: ago(6),
    created_at: ago(38),
    quote_id: 'q7',
    order_id: 'p3',
  }),
  opp('o9', {
    title: 'Overoles planta 2',
    client_name: 'Constructora Andina',
    value: 18_200_000,
    stage: 'ganada',
    won_at: ago(15),
    created_at: ago(44),
    owner_user_id: 'u2',
  }),
  opp('o10', {
    title: 'Extintores sede norte',
    client_name: 'Colegio San Bartolomé',
    value: 5_300_000,
    stage: 'perdida',
    lost_at: ago(9),
    lost_reason_kind: 'precio',
    lost_reason: 'Otro proveedor cotizó 18 % menos.',
  }),
  opp('o11', {
    title: 'Botas dieléctricas',
    client_name: 'Enel Codensa contratista',
    value: 22_000_000,
    stage: 'perdida',
    lost_at: ago(20),
    lost_reason_kind: 'competencia',
    owner_user_id: 'u3',
  }),
  opp('o12', {
    title: 'Kit de primeros auxilios',
    client_name: 'Transportes Ruta 45',
    value: 3_100_000,
    stage: 'contactado',
    expected_close: day(60),
    owner_user_id: 'u2',
    last_activity_at: ago(16),
  }),
];

export const QUOTE_LABELS = new Map([
  ['q12', 'COT-12'],
  ['q9', 'COT-9'],
  ['q14', 'COT-14'],
  ['q7', 'COT-7'],
]);

function task(id: string, over: Partial<CrmActivityRow>): CrmActivityRow {
  return {
    id,
    opportunity_id: null,
    client_id: null,
    kind: 'task',
    title: 'Tarea',
    body: null,
    due_on: TODAY,
    done_at: null,
    owner_user_id: 'u1',
    origin: 'manual',
    created_by: 'u1',
    created_at: ago(2),
    ...over,
  };
}

export const TASKS: CrmActivityRow[] = [
  task('t1', {
    opportunity_id: 'o4',
    title: 'Mandar cotización actualizada a Coltrans',
    due_on: day(-2),
    origin: 'autopilot',
  }),
  task('t2', {
    opportunity_id: 'o1',
    title: 'Confirmar descuento por volumen con compras',
    due_on: TODAY,
  }),
  task('t3', {
    client_id: 'c-nps',
    title: 'Llamar a Metalmecánica del Valle: calificó 4/10 en la encuesta',
    body: 'Comentario de Jorge Pardo: «Los despachos llegan incompletos y nadie avisa».',
    due_on: TODAY,
    origin: 'nps',
  }),
  task('t4', {
    opportunity_id: 'o6',
    title: 'Visita técnica con dotación',
    due_on: day(3),
    owner_user_id: 'u3',
  }),
  task('t5', {
    opportunity_id: 'o2',
    title: 'Llamar a Nexa para saber qué le pareció la cotización',
    due_on: day(1),
    owner_user_id: 'u2',
    origin: 'rule',
  }),
];

export const CLIENT_NAMES = new Map([['c-nps', 'Metalmecánica del Valle']]);

export const TIMELINE = [
  {
    id: 'a1',
    whenLabel: 'Hoy',
    kindLabel: 'Llamada',
    title: 'Pidió 5 % por volumen si suben a 3.000 pares',
    detail: null,
    by: 'Laura Gómez',
    href: null,
    from: 'crm' as const,
    done: true,
  },
  {
    id: 'h1',
    whenLabel: 'Ayer',
    kindLabel: 'Correo',
    title: 'RE: Cotización COT-15 guantes nitrilo',
    detail: 'Compras pide fichas técnicas.',
    by: 'compras@andina.co',
    href: null,
    from: 'hub' as const,
    done: true,
  },
  {
    id: 'a2',
    whenLabel: '28 sep',
    kindLabel: 'Cambio de etapa',
    title: 'Cotización enviada → Negociación',
    detail: null,
    by: 'Laura Gómez',
    href: null,
    from: 'crm' as const,
    done: true,
  },
  {
    id: 'h2',
    whenLabel: '25 sep',
    kindLabel: 'Reunión',
    title: 'Visita a obra Calle 80',
    detail: null,
    by: null,
    href: null,
    from: 'hub' as const,
    done: true,
  },
  {
    id: 'a3',
    whenLabel: '22 sep',
    kindLabel: 'Cambio de etapa',
    title: 'Contactado → Cotización enviada',
    detail: 'Se le envió COT-15 al cliente.',
    by: 'Regla automática',
    href: null,
    from: 'crm' as const,
    done: true,
  },
];

const buys = (from: string, every: number, n: number, amount: number) => {
  const base = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    issuedOn: new Date(base + i * every * 86_400_000).toISOString().slice(0, 10),
    total: amount,
  }));
};

export const CHURN_INPUTS: ChurnInput[] = [
  {
    clientId: 'c-o4',
    clientName: 'Coltrans',
    today: TODAY,
    invoices: buys('2025-01-10', 21, 25, 3_200_000),
    lastContactAt: ago(70),
    paymentDays: { recent: { average: 58, sample: 3 }, prior: { average: 31, sample: 9 } },
  },
  {
    clientId: 'c-nps',
    clientName: 'Metalmecánica del Valle',
    today: TODAY,
    invoices: buys('2025-09-01', 30, 13, 2_100_000),
    lastContactAt: ago(5),
    nps: [{ at: ago(4), score: 4, comment: 'Los despachos llegan incompletos y nadie avisa.' }],
    escalations: [{ at: ago(12), reason: 'Reclamo por pedido incompleto' }],
  },
  {
    clientId: 'c-pos',
    clientName: 'Postobón Bucaramanga',
    today: TODAY,
    invoices: buys('2025-10-15', 30, 12, 1_400_000),
    lastContactAt: ago(95),
  },
  {
    clientId: 'c-ok',
    clientName: 'Agroindustrial La Fe',
    today: TODAY,
    invoices: buys('2025-10-05', 28, 13, 1_900_000),
    lastContactAt: ago(2),
  },
];

export const RISK_OWNERS = new Map<string, string | null>([
  ['c-o4', 'Laura Gómez'],
  ['c-nps', 'Camila Torres'],
  ['c-pos', null],
]);

const line = (
  description: string,
  productCode: string | null,
  quantity: number,
  unitPrice: number,
  discountPct = 0,
) => ({
  description,
  productCode,
  productRef: null,
  quantity,
  unitPrice,
  discountPct,
  base: Math.round(quantity * unitPrice * (1 - discountPct / 100)),
});

export const QUOTES: QuoteIn[] = [
  ['2026-05', 'aceptada', 'u1'],
  ['2026-05', 'rechazada', 'u2'],
  ['2026-06', 'pedido', 'u1'],
  ['2026-06', 'aceptada', 'u3'],
  ['2026-06', 'rechazada', 'u1'],
  ['2026-07', 'pedido', 'u2'],
  ['2026-07', 'vencida', 'u2'],
  ['2026-07', 'aceptada', 'u1'],
  ['2026-08', 'pedido', 'u3'],
  ['2026-08', 'rechazada', 'u3'],
  ['2026-08', 'aceptada', 'u1'],
  ['2026-09', 'pedido', 'u2'],
  ['2026-09', 'enviada', 'u1'],
  ['2026-09', 'vencida', 'u1'],
  ['2026-09', 'aceptada', 'u3'],
  ['2026-10', 'enviada', 'u2'],
].map(([m, status, by], i) => ({
  id: `qq${i}`,
  createdBy: by as string,
  issueDate: `${m}-10`,
  status: status as string,
  validUntil: status === 'enviada' ? '2026-10-20' : `${m}-25`,
  sentAt: `${m}-10T12:00:00Z`,
  acceptedAt: ['aceptada', 'pedido'].includes(status as string)
    ? `${m}-${String(14 + (i % 9)).padStart(2, '0')}T12:00:00Z`
    : null,
  currency: 'COP',
  total: 4_000_000 + i * 750_000,
  lines: [
    i % 3 === 0
      ? line('Guantes nitrilo caja x100', 'GN-100', 40, 38_000)
      : line('Botas de seguridad', 'BS-42', 25, 129_000, 5),
    ...(i % 2 ? [line('Overol jean industrial', 'OV-01', 30, 72_000)] : []),
  ],
}));

export const SALES: SaleIn[] = [
  {
    id: 's1',
    clientId: 'c1',
    clientName: 'Constructora Andina',
    issueDate: '2026-09-12',
    currency: 'COP',
    lines: [
      line('Guantes nitrilo caja x100', 'GN-100', 120, 38_000, 5),
      line('Overol jean industrial', 'OV-01', 60, 72_000),
    ],
  },
  {
    id: 's2',
    clientId: 'c2',
    clientName: 'Agroindustrial La Fe',
    issueDate: '2026-09-25',
    currency: 'COP',
    lines: [
      line('Mangueras hidráulicas 1/2', 'MH-12', 80, 96_000, 8),
      line('Instalación', null, 1, 1_200_000),
    ],
  },
  {
    id: 's3',
    clientId: 'c3',
    clientName: 'Clínica Santa Fe',
    issueDate: '2026-08-30',
    currency: 'COP',
    lines: [line('Botas de seguridad', 'BS-42', 50, 129_000, 12)],
  },
];

export const PRODUCT_COSTS = [
  { sku: 'GN-100', sourceRef: null, name: 'Guantes', cost: 24_500 },
  { sku: 'OV-01', sourceRef: null, name: 'Overol', cost: 41_000 },
  { sku: 'MH-12', sourceRef: null, name: 'Manguera', cost: 71_000 },
  { sku: 'BS-42', sourceRef: null, name: 'Botas', cost: 98_000 },
];

const survey = (id: string, over: Partial<NpsSurveyRow>): NpsSurveyRow => ({
  id,
  client_id: null,
  client_name: 'Cliente',
  contact_name: null,
  contact_email: null,
  token: `token-de-escaparate-numero-${id}-xxxxxxxxx`,
  channel: 'email',
  status: 'respondida',
  sent_at: ago(10),
  opened_at: ago(9),
  responded_at: ago(9),
  expires_on: null,
  created_by: 'u1',
  created_at: ago(10),
  ...over,
});

export const SURVEYS: NpsSurveyRow[] = [
  survey('n1', {
    client_name: 'Metalmecánica del Valle',
    client_id: 'c-nps',
    contact_name: 'Jorge Pardo',
  }),
  survey('n2', { client_name: 'Agroindustrial La Fe', contact_name: 'Diana Mejía' }),
  survey('n3', { client_name: 'Clínica Santa Fe', contact_name: 'Óscar Lozano' }),
  survey('n4', { client_name: 'Constructora Andina', contact_email: 'compras@andina.co' }),
  survey('n5', {
    client_name: 'Nexa Logística',
    status: 'enviada',
    responded_at: null,
    opened_at: null,
  }),
  survey('n6', {
    client_name: 'Postobón Bucaramanga',
    status: 'pendiente',
    channel: 'link',
    sent_at: null,
    responded_at: null,
    opened_at: null,
  }),
];

const resp = (
  id: string,
  survey_id: string,
  score: number,
  comment: string | null,
  over: Partial<NpsResponseRow> = {},
): NpsResponseRow => ({
  id,
  survey_id,
  client_id: null,
  score,
  comment,
  respondent_name: null,
  follow_up_id: null,
  created_at: ago(4),
  ...over,
});

export const RESPONSES: NpsResponseRow[] = [
  resp('r1', 'n1', 4, 'Los despachos llegan incompletos y nadie avisa.', {
    respondent_name: 'Jorge Pardo',
    follow_up_id: 't3',
  }),
  resp('r2', 'n2', 10, 'Siempre cumplen y el asesor responde rápido.'),
  resp('r3', 'n3', 9, null),
  resp('r4', 'n4', 8, 'Buen precio; mejoraría los tiempos de entrega.'),
];
