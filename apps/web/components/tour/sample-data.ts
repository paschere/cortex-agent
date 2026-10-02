import type { ComputedBlock, ComputedView } from '@cortex/agent-tools';

/**
 * LOS DATOS DE EJEMPLO DEL RECORRIDO DE BIENVENIDA.
 *
 * Una empresa inventada («Ferretería La Esquina») escrita a mano, como el
 * escaparate de /v/views-showcase: lo que `computeView` devolvería si la
 * empresa ya tuviera sus ventas y su cartera conectadas. Vive SÓLO en el
 * navegador — nada de aquí se escribe en ninguna tabla, ni se lee de ninguna.
 * Por eso cada pantalla del recorrido lleva la etiqueta «Datos de ejemplo».
 *
 * Tipos sólo de `@cortex/agent-tools` (el barril no entra al cliente).
 */

export const SAMPLE_COMPANY = 'Ferretería La Esquina';

const MONEY = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
export const money = (n: number) => MONEY.format(n);

/** Lo que el Inicio diría con datos: las colas, lo que hizo Cortex, la plata. */
export const SAMPLE_HOME = {
  sentence: 'Tres cosas te esperan y una lleva nueve días.',
  tiles: [
    {
      label: 'Por aprobar',
      value: '3',
      note: 'Un correo a un proveedor lleva 9 días',
      tone: 'amber' as const,
    },
    {
      label: 'Vence esta semana',
      value: money(18_400_000),
      note: '4 facturas de clientes',
      tone: 'primary' as const,
    },
    {
      label: 'Cartera vencida',
      value: money(23_150_000),
      note: '3 clientes, el mayor con 62 días',
      tone: 'rose' as const,
    },
  ],
  journal: [
    'Leyó 41 correos y apartó 6 que piden respuesta',
    'Concilió el extracto del banco: 2 pagos sin factura',
    'Redactó el recordatorio de cobro a Constructora Altos',
  ],
};

const WEEKS = [
  ['4 ago', 31_200_000],
  ['11 ago', 34_800_000],
  ['18 ago', 33_100_000],
  ['25 ago', 38_900_000],
  ['1 sep', 36_400_000],
  ['8 sep', 41_700_000],
  ['15 sep', 39_200_000],
  ['22 sep', 44_600_000],
  ['29 sep', 47_300_000],
] as const;

const DEBTORS = [
  ['Constructora Altos', 9_800_000, 62],
  ['Obras y Acabados Ruiz', 7_450_000, 48],
  ['Inmobiliaria Prado', 5_900_000, 35],
  ['Taller El Pistón', 2_150_000, 21],
] as const;

const PENDING = [
  ['Pagar a Cementos del Valle', 'Proveedor', money(6_300_000), '2026-10-03'],
  ['Cobrar a Constructora Altos', 'Cliente', money(9_800_000), '2026-10-04'],
  ['Renovar la póliza del local', 'Vencimiento', money(1_250_000), '2026-10-07'],
  ['Declaración de retención', 'Impuestos', money(3_480_000), '2026-10-09'],
] as const;

const blocks: ComputedBlock[] = [
  {
    id: 'resumen_hoy',
    width: 'full',
    type: 'text',
    markdown:
      '### Resumen de hoy\nLas ventas de septiembre cerraron **10,9 % arriba** de agosto. La cartera vencida subió a $23.150.000 por Constructora Altos (62 días): conviene llamar hoy. Esta semana vencen 4 pagos.',
  },
  {
    id: 'ventas',
    width: 'half',
    type: 'metric',
    title: 'Ventas del mes',
    value: 168_200_000,
    display: money(168_200_000),
    rows: 312,
    goal: null,
    tone: 'primary',
    caption: null,
    source: 'Ventas',
    compare: {
      period: 'month',
      currentLabel: 'Septiembre',
      previousLabel: 'vs. agosto',
      previous: 151_700_000,
      previousDisplay: money(151_700_000),
      delta: 0.1088,
      direction: 'up',
      good: true,
      series: [
        { label: 'abr', value: 128_000_000 },
        { label: 'may', value: 133_500_000 },
        { label: 'jun', value: 141_900_000 },
        { label: 'jul', value: 139_400_000 },
        { label: 'ago', value: 151_700_000 },
        { label: 'sep', value: 168_200_000 },
      ],
    },
  },
  {
    id: 'cartera',
    width: 'half',
    type: 'metric',
    title: 'Cartera vencida',
    value: 23_150_000,
    display: money(23_150_000),
    rows: 3,
    goal: null,
    tone: 'rose',
    caption: 'Facturas con la fecha de pago ya pasada.',
    source: 'Cartera',
    compare: {
      period: 'month',
      currentLabel: 'Hoy',
      previousLabel: 'vs. hace un mes',
      previous: 17_600_000,
      previousDisplay: money(17_600_000),
      delta: 0.3153,
      direction: 'up',
      good: false,
      series: [
        { label: 'abr', value: 12_100_000 },
        { label: 'may', value: 15_800_000 },
        { label: 'jun', value: 14_300_000 },
        { label: 'jul', value: 16_900_000 },
        { label: 'ago', value: 17_600_000 },
        { label: 'sep', value: 23_150_000 },
      ],
    },
  },
  {
    id: 'recaudo',
    width: 'half',
    type: 'metric',
    title: 'Recaudo del mes',
    value: 121_400_000,
    display: money(121_400_000),
    rows: 87,
    goal: { value: 150_000_000, display: money(150_000_000), ratio: 0.809 },
    tone: 'emerald',
    caption: null,
    source: 'Pagos',
    compare: null,
  },
  {
    id: 'semana',
    width: 'half',
    type: 'metric',
    title: 'Vence esta semana',
    value: 18_400_000,
    display: money(18_400_000),
    rows: 4,
    goal: null,
    tone: 'amber',
    caption: '4 pagos: proveedores, la póliza y la retención.',
    source: 'Vencimientos',
    compare: null,
  },
  {
    id: 'tendencia',
    width: 'half',
    type: 'chart',
    title: 'Ventas por semana',
    chart: 'line',
    points: WEEKS.map(([label, value]) => ({ label, value, display: money(value) })),
    total: money(WEEKS.reduce((a, [, v]) => a + v, 0)),
    tone: 'primary',
    source: 'Ventas',
  },
  {
    id: 'deudores',
    width: 'half',
    type: 'chart',
    title: 'Quién debe más',
    chart: 'bar',
    points: DEBTORS.map(([label, value]) => ({ label, value, display: money(value) })),
    total: money(DEBTORS.reduce((a, [, v]) => a + v, 0)),
    tone: 'rose',
    source: 'Cartera',
  },
  {
    id: 'pendientes',
    width: 'full',
    type: 'table',
    title: 'Lo que vence esta semana',
    columns: [
      { key: 'que', label: 'Qué', kind: 'text' },
      { key: 'tipo', label: 'Tipo', kind: 'text' },
      { key: 'valor', label: 'Valor', kind: 'number' },
      { key: 'vence', label: 'Vence', kind: 'date' },
    ],
    rows: PENDING.map((cells, i) => ({ id: `p${i}`, cells: [...cells], sort: [...cells] })),
    total: PENDING.length,
    searchable: false,
    source: 'Vencimientos',
    actions: [],
    record: null,
  },
];

export function samplePulseView(): ComputedView {
  return {
    blocks,
    computedAt: '2026-10-02T12:00:00.000Z',
    partial: [],
    // Nada que recalcular: es un dibujo fijo, sin red.
    refreshSeconds: 0,
    alerts: [],
    writable: false,
    pages: [],
    theme: { accent: 'primary', density: 'comfortable', header: 'plain', cover: null },
  };
}

/** El proceso de ejemplo: la cartera que avisa sola. */
export const SAMPLE_PROCESS = {
  name: 'Cartera que avisa sola',
  schedule: 'Cada mañana a las 7:00',
  steps: [
    {
      title: 'Revisa la cartera',
      body: 'Lee las facturas de tus clientes y mira cuáles ya pasaron su fecha de pago.',
    },
    {
      title: 'Encuentra lo que importa',
      body: `3 facturas vencidas por ${money(23_150_000)}; la de Constructora Altos lleva 62 días.`,
    },
    {
      title: 'Te avisa y deja listo el cobro',
      body: 'Te escribe por WhatsApp y redacta el recordatorio al cliente. Nada sale sin tu visto bueno.',
    },
  ],
  message: `Buenos días. Hay 3 facturas vencidas por ${money(23_150_000)}. La mayor es de Constructora Altos (${money(9_800_000)}, 62 días). Dejé listo el recordatorio para que lo apruebes.`,
};

/** La caja de preguntas, con una pregunta y su respuesta de ejemplo. */
export const SAMPLE_ASK = {
  question: '¿Quién me debe más de 60 días?',
  answer: [
    `Sólo Constructora Altos: ${money(9_800_000)} en 2 facturas, la más vieja de hace 62 días.`,
    'Su último pago fue el 14 de agosto. ¿Quieres que le redacte un recordatorio?',
  ],
  suggestions: ['Resúmeme cómo va la semana', '¿Qué vence en los próximos 7 días?'],
};
