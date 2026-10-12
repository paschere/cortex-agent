import {
  type ComputedPortal,
  type ComputedTablero,
  type ViewRow,
  type ViewSource,
  buildPortalRole,
  computePortalFromSources,
  computeTableroFromSources,
  portalSchema,
  tableroSchema,
} from '@cortex/agent-tools';

/**
 * Datos inventados para ver un Tablero y un Portal con las MISMAS funciones
 * que los calculan en producción (computeTableroFromSources /
 * computePortalFromSources): filas sintéticas, scope real. Sólo desarrollo.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const CLIENTS = ['Andina SAS', 'Pacífico Ltda', 'Café del Norte', 'Distribuciones Sol'];
const STATES = ['Recibido', 'En bodega', 'Despachado', 'Entregado'];
const WORKERS = ['Ana Gómez', 'Luis Pérez', 'Marta Ríos'];

function day(offset: number, hour = 14): string {
  const d = new Date(NOW.getTime() - offset * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
function ymd(offset: number): string {
  return day(offset).slice(0, 10);
}

const envios = {
  slug: 'envios',
  name: 'Envíos',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'guia', label: 'Guía', type: 'text', required: false },
    { key: 'estado', label: 'Estado', type: 'select', required: false, options: STATES },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'vence', label: 'Entrega prometida', type: 'date', required: false },
    { key: 'responsable', label: 'Responsable', type: 'text', required: false },
  ],
} as never;

export function fixtureEnvios(): ViewRow[] {
  const rows: ViewRow[] = [];
  for (let i = 0; i < 260; i++) {
    const age = Math.floor(((i * 37) % 130) / (1 + (i % 3) * 0.2));
    const state = STATES[(i * 7 + age) % 4] as string;
    rows.push({
      id: `r${i}`,
      label: `GU-${20000 + i}`,
      values: {
        cliente: CLIENTS[i % CLIENTS.length] as string,
        guia: `${123 + (i % 9)}-${40000000 + i * 17}`,
        estado: age < 10 && i % 4 === 0 ? 'En bodega' : state,
        valor: 180_000 + ((i * 53_000) % 1_900_000),
        vence: ymd(age - 3 - (i % 5)),
        responsable: WORKERS[i % WORKERS.length] as string,
      },
      created_at: day(age, 9 + (i % 9)),
      updated_at: day(age, 10 + (i % 9)),
      created_by: i % 3 === 0 ? 'me' : `u${i % 3}`,
    });
  }
  return rows;
}

const sources = (): Map<string, ViewSource> =>
  new Map([['envios', { tracker: envios, rows: fixtureEnvios(), truncated: false }]]);

const ctx = (name: string) => ({
  now: NOW,
  user: { id: 'me', name },
  basePath: '/a/demo',
  visibleScreens: new Set(['guias', 'vuelos']),
});

export type TableroKind = 'operario' | 'supervisor' | 'gerencia';

export function fixtureTablero(kind: TableroKind): ComputedTablero {
  const openFilter = [{ field: 'estado', op: 'neq', value: 'Entregado' }];
  const defs = {
    operario: {
      id: 'lo_mio',
      title: 'Lo mío hoy',
      description: 'Lo que hiciste y lo que te falta.',
      roles: ['operario'],
      widgets: [
        {
          id: 'hoy',
          kind: 'kpi',
          title: 'Lo que registré hoy',
          source: 'envios',
          mine: { by: 'creator' },
          period: 'day',
          tone: 'emerald',
          screen: 'guias',
        },
        {
          id: 'semana',
          kind: 'kpi',
          title: 'Esta semana',
          source: 'envios',
          mine: { by: 'creator' },
          period: 'week',
        },
        {
          id: 'abiertos',
          kind: 'kpi',
          title: 'Abiertos míos',
          source: 'envios',
          mine: { by: 'creator' },
          filters: openFilter,
          period: 'all',
          goodWhen: 'down',
          tone: 'amber',
        },
        {
          id: 'mis',
          kind: 'pending',
          title: 'Mis pendientes',
          source: 'envios',
          mine: { by: 'creator' },
          filters: openFilter,
          dateField: 'vence',
          subtitleField: 'cliente',
          screen: 'guias',
          width: 'half',
        },
        {
          id: 'dias',
          kind: 'chart',
          title: 'Mis registros por día',
          source: 'envios',
          mine: { by: 'creator' },
          tone: 'emerald',
          width: 'half',
          noun: 'guías',
          screen: 'guias',
        },
      ],
    },
    supervisor: {
      id: 'equipo',
      title: 'Equipo y atrasos',
      description: 'Cómo va el equipo y qué se está atrasando.',
      roles: ['supervisor'],
      widgets: [
        {
          id: 'abiertos',
          kind: 'kpi',
          title: 'Abiertos',
          source: 'envios',
          filters: openFilter,
          period: 'all',
          goodWhen: 'down',
          tone: 'amber',
        },
        {
          id: 'atrasados',
          kind: 'kpi',
          title: 'Atrasados',
          source: 'envios',
          filters: [...openFilter, { field: 'vence', op: 'before_today' }],
          period: 'all',
          goodWhen: 'down',
          tone: 'rose',
          goal: 0,
        },
        {
          id: 'semana',
          kind: 'kpi',
          title: 'Registros de la semana',
          source: 'envios',
          period: 'week',
        },
        {
          id: 'estado',
          kind: 'status',
          title: 'Por estado',
          source: 'envios',
          field: 'estado',
          screen: 'guias',
        },
        {
          id: 'resp',
          kind: 'ranking',
          title: 'Por responsable',
          source: 'envios',
          groupBy: 'responsable',
          tone: 'sky',
        },
        {
          id: 'atr',
          kind: 'pending',
          title: 'Lo atrasado',
          source: 'envios',
          filters: [...openFilter, { field: 'vence', op: 'before_today' }],
          dateField: 'vence',
          subtitleField: 'cliente',
          screen: 'guias',
          width: 'full',
          limit: 5,
        },
        {
          id: 'ritmo',
          kind: 'chart',
          title: 'Registros del equipo por día',
          source: 'envios',
          noun: 'guías',
          screen: 'guias',
        },
      ],
    },
    gerencia: {
      id: 'indicadores',
      title: 'Indicadores',
      description: 'Cómo va el negocio, mes contra mes.',
      roles: ['gerencia'],
      widgets: [
        {
          id: 'mes',
          kind: 'kpi',
          title: 'Valor del mes',
          source: 'envios',
          aggregate: 'sum',
          field: 'valor',
          period: 'month',
          tone: 'primary',
          goal: 90_000_000,
        },
        {
          id: 'mes_n',
          kind: 'kpi',
          title: 'Envíos del mes',
          source: 'envios',
          period: 'month',
          tone: 'sky',
        },
        {
          id: 'atr',
          kind: 'kpi',
          title: 'Atrasados',
          source: 'envios',
          filters: [...openFilter, { field: 'vence', op: 'before_today' }],
          period: 'all',
          goodWhen: 'down',
          tone: 'rose',
        },
        {
          id: 'evo',
          kind: 'chart',
          title: 'Valor por día',
          source: 'envios',
          aggregate: 'sum',
          field: 'valor',
          noun: 'envíos',
          screen: 'guias',
        },
        {
          id: 'est',
          kind: 'status',
          title: 'Cómo está lo que se mueve',
          source: 'envios',
          field: 'estado',
        },
        {
          id: 'cli',
          kind: 'ranking',
          title: 'Quién pesa más (cliente)',
          source: 'envios',
          groupBy: 'cliente',
          aggregate: 'sum',
          field: 'valor',
          tone: 'emerald',
        },
      ],
    },
  } as const;
  return computeTableroFromSources(tableroSchema.parse(defs[kind]), sources(), ctx('Ana'));
}

const facturas = {
  slug: 'facturas',
  name: 'Facturas',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'vence', label: 'Vence', type: 'date', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Pagada'],
    },
    { key: 'enlace', label: 'Enlace de pago', type: 'text', required: false },
  ],
} as never;
const soportes = {
  slug: 'soportes',
  name: 'Soportes',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'archivo', label: 'Archivo', type: 'file', required: false },
  ],
} as never;
const docs = {
  slug: 'documentos',
  name: 'Documentos',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'archivo', label: 'Archivo', type: 'file', required: false },
  ],
} as never;

const file = (name: string) =>
  JSON.stringify([
    { url: `https://example.com/${name}`, name, mime: 'application/pdf', size: 184_000 },
  ]);

/** `conPago`: las facturas traen enlace de pago (si no, «Pagar» no existe). */
export function fixturePortal(client: string, conPago: boolean): ComputedPortal {
  const portal = portalSchema.parse({
    enabled: true,
    title: 'Portal de clientes',
    welcome: 'Aquí ves tus envíos, lo que debes y tus documentos.',
    shipments: {
      source: 'envios',
      clientField: 'cliente',
      columns: ['guia', 'vence'],
      statusField: 'estado',
    },
    invoices: {
      source: 'facturas',
      clientField: 'cliente',
      amountField: 'valor',
      dueField: 'vence',
      statusField: 'estado',
      ...(conPago ? { payUrlField: 'enlace' } : {}),
    },
    documents: { source: 'documentos', clientField: 'cliente', fileField: 'archivo' },
    upload: {
      source: 'soportes',
      clientField: 'cliente',
      fileField: 'archivo',
      hint: 'Sube el soporte de tu pago (foto o PDF).',
    },
  });
  const row = (id: string, label: string, values: Record<string, string | number>): ViewRow => ({
    id,
    label,
    values,
    created_at: day(3),
    updated_at: day(1),
  });
  const map = new Map<string, ViewSource>([
    ['envios', { tracker: envios, rows: fixtureEnvios().slice(0, 40), truncated: false }],
    [
      'facturas',
      {
        tracker: facturas,
        truncated: false,
        rows: CLIENTS.flatMap((c, k) => [
          row(`f${k}a`, `FE-${2200 + k}`, {
            cliente: c,
            valor: 4_850_000 + k * 120_000,
            vence: ymd(9 + k),
            estado: 'Pendiente',
            enlace: 'https://pagos.example.com/p/abc123',
          }),
          row(`f${k}b`, `FE-${2100 + k}`, {
            cliente: c,
            valor: 2_300_000,
            vence: ymd(-12 - k),
            estado: 'Pendiente',
            enlace: 'https://pagos.example.com/p/def456',
          }),
          row(`f${k}c`, `FE-${2000 + k}`, {
            cliente: c,
            valor: 1_100_000,
            vence: ymd(40),
            estado: 'Pagada',
            enlace: '',
          }),
        ]),
      },
    ],
    [
      'documentos',
      {
        tracker: docs,
        truncated: false,
        rows: CLIENTS.flatMap((c, k) => [
          row(`d${k}a`, 'Certificado de entrega septiembre', {
            cliente: c,
            archivo: file('certificado-sep.pdf'),
          }),
          row(`d${k}b`, 'Contrato marco 2026', { cliente: c, archivo: file('contrato-marco.pdf') }),
        ]),
      },
    ],
    ['soportes', { tracker: soportes, truncated: false, rows: [] }],
  ]);
  return computePortalFromSources(portal, map, {
    now: NOW,
    role: {
      key: 'cliente',
      name: 'Cliente',
      admin: false,
      permissions: buildPortalRole(portal).permissions,
    },
    user: { id: 'cli1', name: 'Contacto', attributes: { cliente: client }, external: true },
    basePath: '/a/demo',
    visibleScreens: new Set(['subir_soporte']),
    appName: 'Control en planta',
  });
}
