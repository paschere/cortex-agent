import type { ComputedBlock, ComputedRecords, ComputedView } from '@cortex/agent-tools';

/**
 * UNA VISTA INVENTADA CON UN BLOQUE DE CADA TIPO.
 *
 * Es un `ComputedView` escrito a mano —lo que `computeView` devolvería— para
 * mirar el lienzo entero sin base de datos: cifras con KPI, los tres
 * gráficos, la tabla con botones y ficha, el tablero, el plano, el
 * calendario, el avance, la galería, el formulario, los enlaces, la imagen
 * vacía y un bloque con problema. Ninguna cifra de aquí sale de una base.
 */

const NOW = '2026-10-02T15:30:00.000Z';
const TODAY = '2026-10-02';

const MONEY = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const money = (n: number) => MONEY.format(n);

const ACTIONS = [
  {
    id: 'pagada',
    label: 'Marcar pagada',
    kind: 'set_field' as const,
    confirm: true,
    tone: 'emerald' as const,
  },
  {
    id: 'revisar',
    label: 'Pedir revisión',
    kind: 'notify' as const,
    confirm: false,
    tone: 'primary' as const,
  },
];

const CLIENTES = [
  ['Ferretería El Tornillo', 'Bogotá', 'Pagada', 12_400_000, '2026-09-12'],
  ['Distribuidora La 14', 'Cali', 'Pendiente', 8_950_000, '2026-10-05'],
  ['Agro Llanos S.A.S.', 'Villavicencio', 'Vencida', 21_300_000, '2026-08-28'],
  ['Comercial Andina', 'Medellín', 'Pendiente', 4_200_000, '2026-10-09'],
  ['Hotel Mirador', 'Cartagena', 'Pagada', 15_750_000, '2026-09-20'],
  ['Clínica San Rafael', 'Bogotá', 'En revisión', 32_000_000, '2026-10-15'],
  ['Panadería Doña Rosa', 'Tunja', 'Vencida', 1_850_000, '2026-09-01'],
] as const;

const record: ComputedRecords = {
  fields: [
    { key: 'cliente', label: 'Cliente', kind: 'text' },
    { key: 'ciudad', label: 'Ciudad', kind: 'text' },
    {
      key: 'estado',
      label: 'Estado',
      kind: 'text',
      edit: {
        type: 'select',
        options: ['Pendiente', 'En revisión', 'Pagada', 'Vencida'],
        required: true,
      },
    },
    { key: 'valor', label: 'Valor', kind: 'number' },
    { key: 'vence', label: 'Vence', kind: 'date' },
  ],
  rows: Object.fromEntries(
    CLIENTES.map(([name, city, status, value, due], i) => [
      `f${i}`,
      {
        label: name,
        values: [name, city, status, money(value), due],
        raw: [name, city, status, value, due],
        createdAt: '2026-09-01T14:00:00.000Z',
        updatedAt: '2026-10-01T18:20:00.000Z',
      },
    ]),
  ),
};

const SALES_SERIES = [
  { label: 'may', value: 182_000_000 },
  { label: 'jun', value: 201_500_000 },
  { label: 'jul', value: 194_300_000 },
  { label: 'ago', value: 226_900_000 },
  { label: 'sep', value: 241_200_000 },
  { label: 'oct', value: 268_400_000 },
];

const blocks: ComputedBlock[] = [
  {
    id: 'intro',
    width: 'full',
    type: 'text',
    markdown:
      '## Así va la operación\nLas cifras se calculan con los datos de hoy. **Cartera**, ventas y despachos en un solo lugar; toca una fila para ver su ficha.',
  },
  {
    id: 'ventas',
    width: 'third',
    type: 'metric',
    title: 'Ventas',
    value: 268_400_000,
    display: money(268_400_000),
    rows: 142,
    goal: null,
    tone: 'primary',
    caption: null,
    source: 'Ventas',
    compare: {
      period: 'month',
      currentLabel: 'Este mes',
      previousLabel: 'vs. mes anterior',
      previous: 241_200_000,
      previousDisplay: money(241_200_000),
      delta: 0.1128,
      direction: 'up',
      good: true,
      series: SALES_SERIES,
    },
  },
  {
    id: 'devoluciones',
    width: 'third',
    type: 'metric',
    title: 'Devoluciones',
    value: 14,
    display: '14',
    rows: 14,
    goal: null,
    tone: 'rose',
    caption: 'Pedidos devueltos por el cliente.',
    source: 'Despachos',
    compare: {
      period: 'month',
      currentLabel: 'Este mes',
      previousLabel: 'vs. mes anterior',
      previous: 9,
      previousDisplay: '9',
      delta: 0.5556,
      direction: 'up',
      good: false,
      series: [
        { label: 'may', value: 11 },
        { label: 'jun', value: 7 },
        { label: 'jul', value: 8 },
        { label: 'ago', value: 12 },
        { label: 'sep', value: 9 },
        { label: 'oct', value: 14 },
      ],
    },
  },
  {
    id: 'cartera',
    width: 'third',
    type: 'metric',
    title: 'Recaudo del mes',
    value: 96_500_000,
    display: money(96_500_000),
    rows: 38,
    goal: { value: 120_000_000, display: money(120_000_000), ratio: 0.804 },
    tone: 'emerald',
    caption: null,
    source: 'Pagos',
    compare: null,
  },
  {
    id: 'por-ciudad',
    width: 'half',
    type: 'chart',
    title: 'Ventas por ciudad',
    chart: 'bar',
    points: [
      { label: 'Bogotá', value: 98_000_000, display: money(98_000_000) },
      { label: 'Medellín', value: 64_500_000, display: money(64_500_000) },
      { label: 'Cali', value: 47_200_000, display: money(47_200_000) },
      { label: 'Barranquilla', value: 31_800_000, display: money(31_800_000) },
      { label: 'Bucaramanga', value: 26_900_000, display: money(26_900_000) },
    ],
    total: money(268_400_000),
    tone: 'primary',
    source: 'Ventas',
  },
  {
    id: 'canales',
    width: 'half',
    type: 'chart',
    title: 'Pedidos por canal',
    chart: 'donut',
    points: [
      { label: 'WhatsApp', value: 61, display: '61' },
      { label: 'Vendedores', value: 44, display: '44' },
      { label: 'Tienda web', value: 23, display: '23' },
      { label: 'Teléfono', value: 14, display: '14' },
    ],
    total: '142',
    tone: 'primary',
    source: 'Ventas',
  },
  {
    id: 'tendencia',
    width: 'full',
    type: 'chart',
    title: 'Ventas por semana',
    chart: 'line',
    points: [
      { label: '4 ago', value: 48_200_000, display: money(48_200_000) },
      { label: '11 ago', value: 52_900_000, display: money(52_900_000) },
      { label: '18 ago', value: 50_100_000, display: money(50_100_000) },
      { label: '25 ago', value: 61_400_000, display: money(61_400_000) },
      { label: '1 sep', value: 57_800_000, display: money(57_800_000) },
      { label: '8 sep', value: 63_300_000, display: money(63_300_000) },
      { label: '15 sep', value: 59_900_000, display: money(59_900_000) },
      { label: '22 sep', value: 70_200_000, display: money(70_200_000) },
      { label: '29 sep', value: 74_600_000, display: money(74_600_000) },
    ],
    total: money(538_400_000),
    tone: 'primary',
    source: 'Ventas',
  },
  {
    id: 'facturas',
    width: 'full',
    type: 'table',
    title: 'Facturas por cobrar',
    columns: [
      { key: 'cliente', label: 'Cliente', kind: 'text' },
      { key: 'ciudad', label: 'Ciudad', kind: 'text' },
      { key: 'estado', label: 'Estado', kind: 'text' },
      { key: 'valor', label: 'Valor', kind: 'number' },
      { key: 'vence', label: 'Vence', kind: 'date' },
    ],
    rows: CLIENTES.map(([name, city, status, value, due], i) => ({
      id: `f${i}`,
      cells: [name, city, status, money(value), due],
      sort: [name, city, status, value, due],
    })),
    total: 23,
    searchable: true,
    source: 'Facturas',
    actions: ACTIONS,
    record,
  },
  {
    id: 'pedidos',
    width: 'full',
    type: 'board',
    title: 'Pedidos en curso',
    dragField: 'estado',
    actions: [],
    record,
    source: 'Pedidos',
    columns: [
      {
        key: 'Recibido',
        label: 'Recibido',
        count: 3,
        cards: [
          {
            id: 'f1',
            label: 'Distribuidora La 14',
            details: [
              { label: 'Valor', value: money(8_950_000) },
              { label: 'Ciudad', value: 'Cali' },
            ],
          },
          {
            id: 'f3',
            label: 'Comercial Andina',
            details: [
              { label: 'Valor', value: money(4_200_000) },
              { label: 'Ciudad', value: 'Medellín' },
            ],
          },
        ],
      },
      {
        key: 'Alistando',
        label: 'Alistando',
        count: 2,
        cards: [
          {
            id: 'f5',
            label: 'Clínica San Rafael',
            details: [
              { label: 'Valor', value: money(32_000_000) },
              { label: 'Ciudad', value: 'Bogotá' },
            ],
          },
          {
            id: 'f6',
            label: 'Panadería Doña Rosa',
            details: [
              { label: 'Valor', value: money(1_850_000) },
              { label: 'Ciudad', value: 'Tunja' },
            ],
          },
        ],
      },
      {
        key: 'En ruta',
        label: 'En ruta',
        count: 1,
        cards: [
          {
            id: 'f2',
            label: 'Agro Llanos S.A.S.',
            details: [
              { label: 'Valor', value: money(21_300_000) },
              { label: 'Ciudad', value: 'Villavicencio' },
            ],
          },
        ],
      },
      { key: 'Entregado', label: 'Entregado', count: 0, cards: [] },
    ],
  },
  {
    id: 'bodega',
    width: 'full',
    type: 'zones',
    title: 'Plano de la bodega',
    dragField: 'muelle',
    actions: [],
    record,
    source: 'Vehículos',
    columns: [
      {
        key: 'Muelle 1',
        label: 'Muelle 1',
        count: 2,
        cards: [
          { id: 'f0', label: 'WXK-482', details: [{ label: 'Conductor', value: 'Jairo' }] },
          { id: 'f1', label: 'TSM-119', details: [{ label: 'Conductor', value: 'Luz' }] },
        ],
      },
      {
        key: 'Muelle 2',
        label: 'Muelle 2',
        count: 1,
        cards: [{ id: 'f2', label: 'GHT-730', details: [{ label: 'Conductor', value: 'Andrés' }] }],
      },
      { key: 'Muelle 3', label: 'Muelle 3', count: 0, cards: [] },
      {
        key: 'Patio',
        label: 'Patio de espera',
        count: 3,
        cards: [
          { id: 'f3', label: 'KLM-204', details: [{ label: 'Conductor', value: 'Sofía' }] },
          { id: 'f4', label: 'BCD-551', details: [{ label: 'Conductor', value: 'Nelson' }] },
          { id: 'f5', label: 'XYZ-090', details: [{ label: 'Conductor', value: 'Marta' }] },
        ],
      },
      {
        key: '__none',
        label: 'Sin zona',
        count: 1,
        cards: [{ id: 'f6', label: 'PQR-318', details: [] }],
      },
    ],
    layout: [
      { zone: 'Muelle 1', x: 0, y: 0, w: 4, h: 2 },
      { zone: 'Muelle 2', x: 4, y: 0, w: 4, h: 2 },
      { zone: 'Muelle 3', x: 8, y: 0, w: 4, h: 2 },
      { zone: 'Patio', x: 0, y: 2, w: 8, h: 2 },
      { zone: '__none', x: 8, y: 2, w: 4, h: 2 },
    ],
  },
  {
    id: 'entregas',
    width: 'half',
    type: 'calendar',
    title: 'Entregas',
    mode: 'month',
    today: TODAY,
    range: { from: '2026-09-01', to: '2026-11-30' },
    months: ['2026-09', '2026-10', '2026-11'],
    events: [
      { id: 'f0', day: '2026-10-02', label: 'Ferretería El Tornillo', tag: 'Bogotá', tone: 'sky' },
      { id: 'f1', day: '2026-10-02', label: 'Distribuidora La 14', tag: 'Cali', tone: 'emerald' },
      { id: 'f2', day: '2026-10-06', label: 'Agro Llanos', tag: 'Villavicencio', tone: 'amber' },
      { id: 'f3', day: '2026-10-09', label: 'Comercial Andina', tag: 'Medellín', tone: 'sky' },
      { id: 'f4', day: '2026-10-14', label: 'Hotel Mirador', tag: 'Cartagena', tone: 'emerald' },
      { id: 'f5', day: '2026-10-14', label: 'Clínica San Rafael', tag: 'Bogotá', tone: 'sky' },
      { id: 'f6', day: '2026-10-14', label: 'Panadería Doña Rosa', tag: 'Tunja', tone: 'rose' },
      { id: 'f2', day: '2026-10-22', label: 'Agro Llanos (2)', tag: null, tone: null },
    ],
    legend: [
      { label: 'Programada', tone: 'sky' },
      { label: 'Confirmada', tone: 'emerald' },
      { label: 'En riesgo', tone: 'amber' },
      { label: 'Cancelada', tone: 'rose' },
    ],
    hidden: 0,
    source: 'Despachos',
    actions: [],
    record,
  },
  {
    id: 'metas',
    width: 'half',
    type: 'progress',
    title: 'Meta de ventas por vendedor',
    tone: 'primary',
    relative: false,
    items: [
      {
        label: 'Camila Rojas',
        value: 84_000_000,
        display: money(84_000_000),
        target: 80_000_000,
        targetDisplay: money(80_000_000),
        ratio: 1.05,
      },
      {
        label: 'Julián Pérez',
        value: 61_000_000,
        display: money(61_000_000),
        target: 80_000_000,
        targetDisplay: money(80_000_000),
        ratio: 0.7625,
      },
      {
        label: 'Daniela Gómez',
        value: 47_500_000,
        display: money(47_500_000),
        target: 70_000_000,
        targetDisplay: money(70_000_000),
        ratio: 0.6786,
      },
      {
        label: 'Andrés Mejía',
        value: 22_000_000,
        display: money(22_000_000),
        target: 60_000_000,
        targetDisplay: money(60_000_000),
        ratio: 0.3667,
      },
    ],
    source: 'Ventas',
  },
  {
    id: 'flota',
    width: 'full',
    type: 'gallery',
    title: 'Flota',
    columns: 4,
    cards: [
      {
        id: 'f0',
        title: 'WXK-482',
        subtitle: 'Kenworth T800 · 2019',
        meta: [
          { label: 'Conductor', value: 'Jairo Muñoz' },
          { label: 'Km', value: '182.400' },
        ],
        badge: { label: 'En ruta', tone: 'sky' },
        image: null,
      },
      {
        id: 'f1',
        title: 'TSM-119',
        subtitle: 'Chevrolet NPR · 2021',
        meta: [
          { label: 'Conductor', value: 'Luz Ángela' },
          { label: 'Km', value: '64.120' },
        ],
        badge: { label: 'Disponible', tone: 'emerald' },
        image: null,
      },
      {
        id: 'f2',
        title: 'GHT-730',
        subtitle: 'International 4400 · 2017',
        meta: [
          { label: 'Conductor', value: 'Andrés Ruiz' },
          { label: 'Km', value: '241.900' },
        ],
        badge: { label: 'Taller', tone: 'amber' },
        image: null,
      },
      {
        id: 'f3',
        title: 'KLM-204',
        subtitle: 'Hino 500 · 2022',
        meta: [
          { label: 'Conductor', value: 'Sofía Peña' },
          { label: 'Km', value: '38.700' },
        ],
        badge: { label: 'SOAT vencido', tone: 'rose' },
        image: null,
      },
    ],
    total: 9,
    source: 'Vehículos',
    actions: [ACTIONS[1] as (typeof ACTIONS)[number]],
    record,
  },
  {
    id: 'pqr',
    width: 'half',
    type: 'form',
    title: 'Reportar una novedad',
    intro: 'Cuéntanos qué pasó en la entrega. Llega directo al equipo de operación.',
    tracker: 'novedades',
    submitLabel: 'Enviar novedad',
    successMessage: 'Recibido. Gracias.',
    fields: [
      { key: 'guia', label: 'Número de guía', type: 'text', required: true, options: [] },
      {
        key: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        options: ['Daño', 'Faltante', 'Retraso', 'Otro'],
      },
      { key: 'fecha', label: 'Fecha', type: 'date', required: false, options: [] },
      { key: 'valor', label: 'Valor afectado', type: 'money', required: false, options: [] },
      { key: 'detalle', label: 'Detalle', type: 'text', required: false, options: [] },
    ],
  },
  {
    id: 'atajos',
    width: 'half',
    type: 'links',
    title: 'Atajos',
    style: 'cards',
    links: [
      {
        label: 'Pedir un despacho',
        href: '/procesos',
        external: false,
        description: 'Abre el proceso de despachos con los datos del cliente.',
        tone: 'primary',
      },
      {
        label: 'Portal de la DIAN',
        href: 'https://www.dian.gov.co',
        external: true,
        description: 'Facturación electrónica.',
        tone: 'sky',
      },
      {
        label: 'Tablero de cartera',
        href: '/views',
        external: false,
        description: null,
        tone: 'emerald',
      },
      {
        label: 'Reportar incidente',
        href: '/procesos',
        external: false,
        description: 'Para lo que no puede esperar.',
        tone: 'rose',
      },
    ],
  },
  {
    id: 'botones',
    width: 'half',
    type: 'links',
    title: null,
    style: 'buttons',
    links: [
      {
        label: 'Ver todas las facturas',
        href: '/views',
        external: false,
        description: null,
        tone: 'primary',
      },
      {
        label: 'Manual de marca',
        href: 'https://example.com',
        external: true,
        description: null,
        tone: 'sky',
      },
    ],
  },
  {
    id: 'foto',
    width: 'half',
    type: 'media',
    title: 'Video de la bodega',
    kind: 'embed',
    src: null,
    provider: null,
    alt: null,
    caption: null,
    aspect: '16:9',
  },
  {
    id: 'roto',
    width: 'full',
    type: 'problem',
    title: 'Inventario',
    message:
      'La tabla «inventario» ya no tiene el campo «bodega». Cambia el bloque o vuelve a crear el campo.',
  },
];

export function showcaseView(opts: { pages?: boolean; empty?: boolean } = {}): ComputedView {
  const list = opts.empty
    ? blocks.map((b): ComputedBlock => {
        if (b.type === 'table') return { ...b, rows: [], total: 0 };
        if (b.type === 'chart') return { ...b, points: [] };
        if (b.type === 'gallery') return { ...b, cards: [], total: 0 };
        if (b.type === 'progress') return { ...b, items: [] };
        if (b.type === 'calendar') return { ...b, events: [], legend: [] };
        return b;
      })
    : blocks;
  return {
    blocks: list,
    computedAt: NOW,
    partial: [],
    refreshSeconds: 30,
    writable: true,
    alerts: [
      {
        id: 'nuevos',
        source: 'Pedidos',
        message: 'Entró un pedido',
        sound: true,
        desktop: false,
        rows: [],
      },
    ],
    filtersBar: [
      {
        id: 'sede',
        label: 'Sede',
        kind: 'select',
        source: 'Ventas',
        options: ['Bogotá', 'Medellín', 'Cali'],
        value: null,
      },
      {
        id: 'fechas',
        label: 'Fechas',
        kind: 'date_range',
        source: 'Ventas',
        options: [],
        value: null,
      },
      {
        id: 'buscar',
        label: 'Buscar cliente',
        kind: 'search',
        source: 'Facturas',
        options: [],
        value: null,
      },
    ],
    pages: opts.pages
      ? [
          { id: 'resumen', title: 'Resumen', blockIds: list.slice(0, 7).map((b) => b.id) },
          { id: 'operacion', title: 'Operación', blockIds: list.slice(7).map((b) => b.id) },
        ]
      : [],
    theme: {
      accent: 'primary',
      density: 'comfortable',
      header: 'plain',
      layout: 'dashboard',
      style: 'clean',
      cover: null,
    },
  };
}

export const SHOWCASE_TITLE = 'Cómo va Transportes Andinos';
export const SHOWCASE_SUBTITLE = 'Ventas, cartera y despachos de la semana, al día.';
