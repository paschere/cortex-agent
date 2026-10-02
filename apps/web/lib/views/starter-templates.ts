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

export type StarterIcon =
  | 'truck'
  | 'wallet'
  | 'trending'
  | 'inbox'
  | 'users'
  | 'boxes'
  | 'calendar'
  | 'kanban';

/** Para qué área es: la galería de «Nueva vista» las agrupa así. */
export type StarterCategory = 'Ventas y cartera' | 'Operación' | 'Clientes y equipo';

/** La forma de una vista, para dibujar su miniatura sin calcularla. */
export interface StarterSketch {
  type: string;
  width: 'full' | 'half' | 'third';
}

interface StarterBase {
  id: string;
  title: string;
  body: string;
  icon: StarterIcon;
  category: StarterCategory;
}

/**
 * Las de frase llevan además `sketch`: la forma que se espera que Cortex arme,
 * sólo para la miniatura de la galería (la vista real la decide el diseñador
 * con las tablas de la empresa y puede salir distinta).
 */
export type StarterTemplate =
  | (StarterBase & { kind: 'spec'; name: string; description: string; spec: ViewSpec })
  | (StarterBase & { kind: 'prompt'; prompt: string; sketch: StarterSketch[] });

/** La forma de una plantilla, venga de su spec o de su boceto. */
export function templateShape(t: StarterTemplate): StarterSketch[] {
  return t.kind === 'spec'
    ? t.spec.blocks.map((b) => ({ type: b.type, width: b.width as StarterSketch['width'] }))
    : t.sketch;
}

const S = (type: string, width: StarterSketch['width']): StarterSketch => ({ type, width });

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
    // El pulso depende de qué datos tiene cada empresa (Siigo, facturas
    // confirmadas, pagos, metas…), así que es de frase: el diseñador lo arma
    // sólo con las fuentes que tienen filas. Desde el chat, «dime cómo va la
    // empresa» lo arma `views.company_pulse` y programa su resumen diario.
    id: 'pulso_empresa',
    kind: 'prompt',
    icon: 'trending',
    category: 'Ventas y cartera',
    sketch: [
      S('text', 'full'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('chart', 'half'),
      S('chart', 'half'),
      S('table', 'full'),
    ],
    title: 'Pulso de la empresa',
    body: 'Cómo va la empresa hoy: ventas contra el mes anterior, cartera vencida, lo que entró, metas y pendientes, con un resumen cada mañana.',
    prompt:
      'Pulso de la empresa: un tablero ejecutivo de cómo va la empresa hoy. Arriba un texto «Resumen de hoy». Luego las cifras clave contra el mes anterior: ventas del mes, cartera vencida (plata en riesgo), lo recuperado con Cortex, pagos recibidos, metas cumplidas y pendientes de Gerencia. Después las ventas y los pagos por mes, los clientes que más compran y quién debe más. Usa sólo las fuentes que tienen datos y dime qué falta conectar.',
  },
  {
    id: 'operacion_carga',
    kind: 'prompt',
    icon: 'truck',
    category: 'Operación',
    sketch: [
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('board', 'full'),
      S('form', 'half'),
      S('table', 'half'),
    ],
    title: 'Operación de carga: guías y dollies',
    body: 'Guías por estado en un tablero, dollies en uso y un formulario para registrar una guía.',
    prompt:
      'Operación de carga: un tablero de guías por estado que se pueda arrastrar, cuántas guías entraron hoy, los dollies en uso y disponibles, y un formulario para registrar una guía nueva.',
  },
  {
    id: 'cartera',
    kind: 'spec',
    icon: 'wallet',
    category: 'Ventas y cartera',
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
    category: 'Ventas y cartera',
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
    category: 'Clientes y equipo',
    sketch: [
      S('metric', 'third'),
      S('metric', 'third'),
      S('chart', 'third'),
      S('board', 'full'),
      S('form', 'full'),
    ],
    title: 'Seguimiento de solicitudes',
    body: 'Solicitudes por estado, las que llevan más días abiertas y un formulario para recibirlas.',
    prompt:
      'Seguimiento de solicitudes de clientes: cuántas están abiertas, un tablero por estado que se pueda arrastrar, las que llevan más de 5 días sin cerrar y un formulario para registrar una solicitud nueva.',
  },
  {
    id: 'crm_ventas',
    kind: 'prompt',
    icon: 'kanban',
    category: 'Ventas y cartera',
    sketch: [
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('board', 'full'),
      S('chart', 'half'),
      S('table', 'half'),
    ],
    title: 'CRM de ventas',
    body: 'Negocios por etapa en un tablero, lo que está por cerrar y cuánto suma cada vendedor.',
    prompt:
      'CRM de ventas: un tablero de negocios por etapa (prospecto, propuesta, negociación, ganado, perdido) que se pueda arrastrar, el valor total en negociación, cuántos se ganaron este mes, un gráfico del valor por vendedor y la lista de negocios con su próximo paso.',
  },
  {
    id: 'inventario',
    kind: 'prompt',
    icon: 'boxes',
    category: 'Operación',
    sketch: [
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('chart', 'half'),
      S('table', 'half'),
      S('form', 'full'),
    ],
    title: 'Inventario',
    body: 'Existencias por bodega, lo que está bajo el mínimo y un formulario para registrar movimientos.',
    prompt:
      'Inventario: cuántos productos hay, cuáles están por debajo del mínimo, un gráfico de existencias por bodega, la lista de productos con su cantidad y un formulario para registrar una entrada o salida.',
  },
  {
    id: 'agenda_citas',
    kind: 'prompt',
    icon: 'calendar',
    category: 'Clientes y equipo',
    sketch: [S('metric', 'half'), S('metric', 'half'), S('table', 'full'), S('form', 'full')],
    title: 'Agenda de citas',
    body: 'Las citas de hoy y de la semana, quién atiende cada una y un formulario para agendar.',
    prompt:
      'Agenda de citas: cuántas citas hay hoy y en los próximos 7 días, la lista de citas ordenada por fecha con cliente, responsable y estado, y un formulario público para que un cliente pida una cita.',
  },
  {
    id: 'proyectos',
    kind: 'prompt',
    icon: 'kanban',
    category: 'Clientes y equipo',
    sketch: [
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('board', 'full'),
      S('table', 'full'),
    ],
    title: 'Proyectos',
    body: 'Proyectos por estado, los atrasados primero y quién es responsable de cada uno.',
    prompt:
      'Seguimiento de proyectos: cuántos hay en curso, cuántos están atrasados, un tablero por estado que se pueda arrastrar y la lista con responsable, fecha de entrega y avance.',
  },
];
