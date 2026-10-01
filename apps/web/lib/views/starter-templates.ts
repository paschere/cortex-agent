import type { ViewSpec } from '@cortex/agent-tools';

/**
 * LAS PLANTILLAS DEL PRIMER CLIC EN /views.
 *
 * Dos clases, y la diferencia importa:
 *
 *   - `spec`: una vista ya armada sobre fuentes de la plataforma que existen en
 *     TODO espacio (`cortex.ventas`). Abre directo en el lienzo con datos de
 *     verdad, sin gastar una respuesta del plan. Sólo sirve para lo que la
 *     plataforma ya sabe: la cartera y la facturación.
 *   - `prompt`: lo que depende de las tablas de cada empresa (las guías y los
 *     dollies de una, las solicitudes de otra). Una plantilla fija nombraría
 *     tablas que no existen; la frase se la pasa a Cortex, que la arma con las
 *     tablas reales y, si faltan, propone crearlas.
 *
 * Los specs de aquí pasan el contrato y el catálogo de la plataforma: lo
 * comprueba `starter-templates.test.ts` contra el registro de verdad, para que
 * renombrar un campo de `cortex.ventas` rompa la prueba y no la plantilla.
 */

export type StarterIcon = 'truck' | 'wallet' | 'trending' | 'inbox';

interface StarterBase {
  id: string;
  title: string;
  body: string;
  icon: StarterIcon;
}

export type StarterTemplate =
  | (StarterBase & { kind: 'spec'; name: string; description: string; spec: ViewSpec })
  | (StarterBase & { kind: 'prompt'; prompt: string });

const LIVE = (): Pick<ViewSpec, 'refreshSeconds' | 'editing' | 'alerts' | 'accent'> => ({
  refreshSeconds: 30,
  editing: 'off',
  alerts: [],
  accent: 'primary',
});

const cartera: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'Lo que los clientes deben hoy, lo vencido primero.',
  blocks: [
    {
      id: 'por_cobrar',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'neq', value: 'Pagada' }],
      title: 'Por cobrar',
      aggregate: 'sum',
      field: 'saldo',
      format: 'money',
      tone: 'primary',
    },
    {
      id: 'vencido',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'eq', value: 'Vencida' }],
      title: 'Vencido',
      aggregate: 'sum',
      field: 'saldo',
      format: 'money',
      tone: 'rose',
    },
    {
      id: 'facturas_vencidas',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'eq', value: 'Vencida' }],
      title: 'Facturas vencidas',
      aggregate: 'count',
      format: 'number',
      tone: 'amber',
    },
    {
      id: 'saldo_estado',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'neq', value: 'Pagada' }],
      title: 'Saldo por estado',
      chart: 'donut',
      groupBy: 'estado',
      bucket: 'month',
      aggregate: 'sum',
      field: 'saldo',
      format: 'money',
      limit: 6,
      tone: 'primary',
    },
    {
      id: 'clientes_saldo',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'neq', value: 'Pagada' }],
      title: 'Clientes con más saldo',
      chart: 'bar',
      groupBy: 'cliente',
      bucket: 'month',
      aggregate: 'sum',
      field: 'saldo',
      format: 'money',
      limit: 8,
      tone: 'primary',
    },
    {
      id: 'facturas',
      type: 'table',
      width: 'full',
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'neq', value: 'Pagada' }],
      title: 'Facturas por cobrar',
      columns: ['numero', 'cliente', 'vence', 'dias_mora', 'saldo', 'estado'],
      sort: { field: 'dias_mora', dir: 'desc' },
      limit: 100,
      searchable: true,
      editable: [],
      actions: [],
    },
  ],
};

const LAST_30: ViewSpec['alerts'][number]['filters'] = [
  { field: 'emitida', op: 'last_days', value: 30 },
];

const ventasDelMes: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'Facturas de venta de los últimos 30 días.',
  blocks: [
    {
      id: 'facturado',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ventas',
      filters: [...LAST_30],
      title: 'Facturado',
      aggregate: 'sum',
      field: 'total',
      format: 'money',
      tone: 'primary',
    },
    {
      id: 'facturas',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ventas',
      filters: [...LAST_30],
      title: 'Facturas',
      aggregate: 'count',
      format: 'number',
      tone: 'sky',
    },
    {
      id: 'promedio',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ventas',
      filters: [...LAST_30],
      title: 'Factura promedio',
      aggregate: 'avg',
      field: 'total',
      format: 'money',
      tone: 'emerald',
    },
    {
      id: 'por_dia',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.ventas',
      filters: [...LAST_30],
      title: 'Facturación por día',
      chart: 'line',
      groupBy: 'emitida',
      bucket: 'day',
      aggregate: 'sum',
      field: 'total',
      format: 'money',
      limit: 24,
      tone: 'primary',
    },
    {
      id: 'por_cliente',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.ventas',
      filters: [...LAST_30],
      title: 'Principales clientes',
      chart: 'bar',
      groupBy: 'cliente',
      bucket: 'month',
      aggregate: 'sum',
      field: 'total',
      format: 'money',
      limit: 8,
      tone: 'primary',
    },
    {
      id: 'lista',
      type: 'table',
      width: 'full',
      tracker: 'cortex.ventas',
      filters: [...LAST_30],
      title: 'Facturas del período',
      columns: ['numero', 'cliente', 'emitida', 'total', 'saldo', 'estado'],
      sort: { field: 'emitida', dir: 'desc' },
      limit: 100,
      searchable: true,
      editable: [],
      actions: [],
    },
  ],
};

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'operacion_carga',
    kind: 'prompt',
    icon: 'truck',
    title: 'Operación de carga: guías y dollies',
    body: 'Guías por estado en un tablero, dollies en uso y un formulario para registrar una guía.',
    prompt:
      'Operación de carga: un tablero de guías por estado que se pueda arrastrar, cuántas guías entraron hoy, los dollies en uso y disponibles, y un formulario para registrar una guía nueva.',
  },
  {
    id: 'cartera',
    kind: 'spec',
    icon: 'wallet',
    title: 'Cartera',
    body: 'Lo por cobrar, lo vencido y qué clientes deben más, con las facturas abiertas.',
    name: 'Cartera',
    description: 'Saldo por cobrar y vencido, por cliente.',
    spec: cartera,
  },
  {
    id: 'ventas_mes',
    kind: 'spec',
    icon: 'trending',
    title: 'Ventas del mes',
    body: 'Lo facturado en los últimos 30 días, por día y por cliente.',
    name: 'Ventas del mes',
    description: 'Facturación de los últimos 30 días.',
    spec: ventasDelMes,
  },
  {
    id: 'solicitudes',
    kind: 'prompt',
    icon: 'inbox',
    title: 'Seguimiento de solicitudes',
    body: 'Solicitudes por estado, las que llevan más días abiertas y un formulario para recibirlas.',
    prompt:
      'Seguimiento de solicitudes de clientes: cuántas están abiertas, un tablero por estado que se pueda arrastrar, las que llevan más de 5 días sin cerrar y un formulario para registrar una solicitud nueva.',
  },
];
