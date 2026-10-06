import type { ModuleKey, ViewSpec } from '@cortex/agent-tools';

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
  /**
   * El módulo (0186) del que lee. Con el módulo apagado la plantilla no se
   * ofrece (`startersFor`): abriría una vista sin datos y con un aviso.
   */
  module?: ModuleKey;
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

/**
 * Cómo va el equipo: el registro de trabajo (0174) en una vista. Las dos
 * fuentes dependen de quién mira (work/access.ts): cada persona ve lo suyo y
 * quien administra, a todo el equipo. La tabla va en orden alfabético y no hay
 * gráfico por persona: nada que se lea como ranking.
 */
const TODOS: ViewSpec['alerts'][number]['filters'] = [{ field: 'tipo', op: 'eq', value: 'Todos' }];
const ABIERTO: ViewSpec['alerts'][number]['filters'] = [
  { field: 'estado', op: 'eq', value: 'Por hacer' },
];

const comoVaElEquipo: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'El trabajo de los últimos 30 días: lo abierto, lo vencido y lo cerrado, por persona.',
  blocks: [
    {
      id: 'abiertos',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.trabajo',
      filters: [...ABIERTO],
      title: 'Abiertos',
      aggregate: 'count',
      format: 'number',
      tone: 'primary',
    },
    {
      id: 'vencidos',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.trabajo',
      filters: [...ABIERTO, { field: 'vencido', op: 'eq', value: 'Sí' }],
      title: 'Vencidos',
      aggregate: 'count',
      format: 'number',
      tone: 'rose',
    },
    {
      id: 'cerrados',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.equipo',
      filters: [...TODOS],
      title: 'Cerrados en 30 días',
      aggregate: 'sum',
      field: 'cerrados',
      format: 'number',
      tone: 'emerald',
    },
    {
      id: 'abiertos_tipo',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.trabajo',
      filters: [...ABIERTO],
      title: 'Abiertos por tipo de trabajo',
      chart: 'bar',
      groupBy: 'tipo',
      bucket: 'month',
      aggregate: 'count',
      format: 'number',
      limit: 8,
      tone: 'primary',
    },
    {
      id: 'vencidos_lista',
      type: 'table',
      width: 'half',
      tracker: 'cortex.trabajo',
      filters: [...ABIERTO, { field: 'vencido', op: 'eq', value: 'Sí' }],
      title: 'Lo vencido',
      columns: ['titulo', 'persona', 'tipo', 'vence'],
      sort: { field: 'vence', dir: 'asc' },
      limit: 50,
      searchable: true,
      editable: [],
      actions: [],
    },
    {
      id: 'personas',
      type: 'table',
      width: 'full',
      tracker: 'cortex.equipo',
      filters: [...TODOS],
      title: 'Por persona (orden alfabético)',
      columns: [
        'persona',
        'equipo',
        'abiertos',
        'vencidos',
        'cerrados',
        'cerrados_antes',
        'a_tiempo',
        'ciclo_horas',
        'senales',
      ],
      sort: { field: 'persona', dir: 'asc' },
      limit: 100,
      searchable: true,
      editable: [],
      actions: [],
    },
  ],
};

/**
 * Las plantillas de los módulos de operación (0181–0197): vistas ya armadas
 * sobre fuentes `cortex.*` de cada módulo. Cada una lleva su `module`: con el
 * módulo apagado no se ofrece (`startersFor`). Son internas (no se comparten
 * por enlace), como las fuentes.
 */
const ABIERTAS: ViewSpec['alerts'][number]['filters'] = [
  { field: 'estado', op: 'neq', value: 'Pagada' },
  { field: 'estado', op: 'neq', value: 'Rechazada' },
];

const programaDePagos: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'Las facturas de proveedores que siguen abiertas, las más próximas a vencer primero.',
  blocks: [
    {
      id: 'por_pagar',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.por_pagar',
      filters: [...ABIERTAS],
      title: 'Por pagar (neto)',
      aggregate: 'sum',
      field: 'neto',
      format: 'money',
      tone: 'primary',
    },
    {
      id: 'programado',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.por_pagar',
      filters: [{ field: 'estado', op: 'eq', value: 'Programada' }],
      title: 'Ya programado',
      aggregate: 'sum',
      field: 'neto',
      format: 'money',
      tone: 'emerald',
    },
    {
      id: 'vencidas',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.por_pagar',
      filters: [...ABIERTAS, { field: 'dias', op: 'lt', value: 0 }],
      title: 'Facturas vencidas',
      aggregate: 'count',
      format: 'number',
      tone: 'rose',
    },
    {
      id: 'por_estado',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.por_pagar',
      filters: [...ABIERTAS],
      title: 'Por pagar según su estado',
      chart: 'donut',
      groupBy: 'estado',
      bucket: 'month',
      aggregate: 'sum',
      field: 'neto',
      format: 'money',
      limit: 6,
      tone: 'primary',
    },
    {
      id: 'proveedores',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.por_pagar',
      filters: [...ABIERTAS],
      title: 'Proveedores a los que más se les debe',
      chart: 'bar',
      groupBy: 'proveedor',
      bucket: 'month',
      aggregate: 'sum',
      field: 'neto',
      format: 'money',
      limit: 8,
      tone: 'primary',
    },
    {
      id: 'facturas',
      type: 'table',
      width: 'full',
      tracker: 'cortex.por_pagar',
      filters: [...ABIERTAS],
      title: 'Facturas abiertas',
      columns: ['proveedor', 'numero', 'vence', 'dias', 'neto', 'estado', 'pagar_el', 'alertas'],
      sort: { field: 'vence', dir: 'asc' },
      limit: 100,
      searchable: true,
      editable: [],
      actions: [],
    },
  ],
};

const inventarioBajoMinimo: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'Lo que hay que reponer: agotado, bajo el mínimo o a punto de agotarse.',
  blocks: [
    {
      id: 'bajo_minimo',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.inventario',
      filters: [{ field: 'alerta', op: 'eq', value: 'Bajo el mínimo' }],
      title: 'Bajo el mínimo',
      aggregate: 'count',
      format: 'number',
      tone: 'amber',
    },
    {
      id: 'agotados',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.inventario',
      filters: [{ field: 'alerta', op: 'eq', value: 'Agotado' }],
      title: 'Agotados',
      aggregate: 'count',
      format: 'number',
      tone: 'rose',
    },
    {
      id: 'ordenes_atrasadas',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.ordenes_compra',
      filters: [{ field: 'atrasada', op: 'eq', value: 'Sí' }],
      title: 'Órdenes de compra atrasadas',
      aggregate: 'count',
      format: 'number',
      tone: 'primary',
    },
    {
      id: 'faltante_categoria',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.inventario',
      filters: [{ field: 'alerta', op: 'neq', value: 'Al día' }],
      title: 'Productos con alerta por categoría',
      chart: 'bar',
      groupBy: 'categoria',
      bucket: 'month',
      aggregate: 'count',
      format: 'number',
      limit: 8,
      tone: 'amber',
    },
    {
      id: 'en_camino',
      type: 'table',
      width: 'half',
      tracker: 'cortex.ordenes_compra',
      filters: [
        { field: 'estado', op: 'neq', value: 'Borrador' },
        { field: 'dias_para_llegar', op: 'not_empty' },
      ],
      title: 'Pedidos en camino',
      columns: ['proveedor', 'estado', 'esperada', 'dias_para_llegar', 'total'],
      sort: { field: 'esperada', dir: 'asc' },
      limit: 30,
      searchable: false,
      editable: [],
      actions: [],
    },
    {
      id: 'productos',
      type: 'table',
      width: 'full',
      tracker: 'cortex.inventario',
      filters: [{ field: 'alerta', op: 'neq', value: 'Al día' }],
      title: 'Productos que piden atención',
      columns: [
        'sku',
        'categoria',
        'existencia',
        'minimo',
        'faltante',
        'dias_cobertura',
        'alerta',
        'proveedor',
      ],
      sort: { field: 'faltante', dir: 'desc' },
      limit: 100,
      searchable: true,
      editable: [],
      actions: [],
    },
  ],
};

const embudoComercial: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'Lo que hay en negociación, por etapa, con lo que se espera cerrar.',
  blocks: [
    {
      id: 'en_embudo',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.comercial',
      filters: [{ field: 'estado', op: 'eq', value: 'Abierta' }],
      title: 'En el embudo',
      aggregate: 'sum',
      field: 'valor',
      format: 'money',
      tone: 'primary',
    },
    {
      id: 'ponderado',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.comercial',
      filters: [{ field: 'estado', op: 'eq', value: 'Abierta' }],
      title: 'Valor ponderado por probabilidad',
      aggregate: 'sum',
      field: 'ponderado',
      format: 'money',
      tone: 'amber',
    },
    {
      id: 'ganado_30',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.comercial',
      filters: [
        { field: 'estado', op: 'eq', value: 'Ganada' },
        { field: 'ganada', op: 'last_days', value: 30 },
      ],
      title: 'Ganado en 30 días',
      aggregate: 'sum',
      field: 'valor',
      format: 'money',
      tone: 'emerald',
    },
    {
      id: 'por_etapa',
      type: 'board',
      width: 'full',
      tracker: 'cortex.comercial',
      filters: [{ field: 'estado', op: 'eq', value: 'Abierta' }],
      title: 'Oportunidades por etapa',
      groupBy: 'etapa',
      cardFields: ['cliente', 'valor'],
      limit: 20,
      draggable: false,
      actions: [],
    },
    {
      id: 'por_responsable',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.comercial',
      filters: [{ field: 'estado', op: 'eq', value: 'Abierta' }],
      title: 'Valor abierto por responsable',
      chart: 'bar',
      groupBy: 'responsable',
      bucket: 'month',
      aggregate: 'sum',
      field: 'valor',
      format: 'money',
      limit: 8,
      tone: 'primary',
    },
    {
      id: 'cierres',
      type: 'table',
      width: 'half',
      tracker: 'cortex.comercial',
      filters: [{ field: 'estado', op: 'eq', value: 'Abierta' }],
      title: 'Próximos cierres',
      columns: [
        'cliente',
        'etapa',
        'valor',
        'probabilidad',
        'cierre_esperado',
        'dias_sin_actividad',
      ],
      sort: { field: 'cierre_esperado', dir: 'asc' },
      limit: 30,
      searchable: true,
      editable: [],
      actions: [],
    },
  ],
};

const vencimientosEmpresa: ViewSpec = {
  version: 1,
  ...LIVE(),
  subtitle: 'SOAT, pólizas, licencias y permisos: lo vencido y lo que viene.',
  blocks: [
    {
      id: 'vencidos',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.documentos_vencen',
      filters: [{ field: 'estado', op: 'eq', value: 'Vencido' }],
      title: 'Vencidos',
      aggregate: 'count',
      format: 'number',
      tone: 'rose',
    },
    {
      id: 'por_vencer',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.documentos_vencen',
      filters: [{ field: 'estado', op: 'eq', value: 'Por vencer' }],
      title: 'Por vencer',
      aggregate: 'count',
      format: 'number',
      tone: 'amber',
    },
    {
      id: 'vigentes',
      type: 'metric',
      width: 'third',
      tracker: 'cortex.documentos_vencen',
      filters: [{ field: 'estado', op: 'eq', value: 'Vigente' }],
      title: 'Vigentes',
      aggregate: 'count',
      format: 'number',
      tone: 'emerald',
    },
    {
      id: 'por_tipo',
      type: 'chart',
      width: 'half',
      tracker: 'cortex.documentos_vencen',
      filters: [{ field: 'estado', op: 'neq', value: 'Vigente' }],
      title: 'Lo que pide renovación, por tipo',
      chart: 'donut',
      groupBy: 'tipo',
      bucket: 'month',
      aggregate: 'count',
      format: 'number',
      limit: 8,
      tone: 'amber',
    },
    {
      id: 'agenda',
      type: 'calendar',
      width: 'half',
      tracker: 'cortex.documentos_vencen',
      title: 'Calendario de vencimientos',
      dateField: 'vence',
      labelField: 'label',
      colorField: 'estado',
      mode: 'agenda',
      days: 60,
      filters: [],
      actions: [],
    },
    {
      id: 'papeles',
      type: 'table',
      width: 'full',
      tracker: 'cortex.documentos_vencen',
      filters: [],
      title: 'Todos los papeles que se vigilan',
      columns: ['tipo', 'sujeto', 'vence', 'dias', 'estado', 'responsable'],
      sort: { field: 'vence', dir: 'asc' },
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
    id: 'registro_sin_duplicados',
    kind: 'prompt',
    icon: 'inbox',
    category: 'Operación',
    sketch: [
      S('form', 'full'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('table', 'full'),
    ],
    title: 'Registro con control de duplicados',
    body: 'Para el equipo en operación, desde el celular: registrar (también dictando) guías, pedidos, facturas o lo que llegue, y ver marcado lo que se repite.',
    prompt:
      'Registro con control de duplicados: una pantalla para el equipo en operación, que se usa desde el celular. Usa theme.layout "operator" (una columna, el formulario primero, controles grandes). Pregúntame qué se registra (guías, pedidos, facturas, órdenes, seriales…) si no es obvio por mis tablas. Si no existe la tabla, créala con trackers.define con: un código que identifica cada registro (número de guía, pedido, factura…), la fecha, los 2–4 datos que más importen y un estado (opciones que incluyan Duplicado), con la regla duplicates {key: <el código>, distinctBy: "fecha", flagField: "estado", flagValue: "Duplicado"} para que un código repetido con otra fecha quede marcado y se corrija a tiempo. Arriba el formulario de registro, con el dictado activo para hablarle en vez de teclear. Luego tres métricas pequeñas: registros de hoy, duplicados por corregir y cerrados. Debajo, los registros como tarjetas grandes con el estado bien visible y un buscador por código. Si los documentos llegan a una carpeta de Drive o a una hoja de Google, ofrece llenar la tabla desde ahí (trackers.sync_from_drive_folder con key_fields = código Y fecha, o trackers.sync_from_source). Que la vista pite, titile y avise en pantalla cuando llegue un registro nuevo y cuando uno pase a Duplicado: alerta {on: "both", sound: true} sobre esa tabla y refreshSeconds 10.',
  },
  {
    id: 'recepcion_planta',
    kind: 'prompt',
    icon: 'boxes',
    category: 'Operación',
    sketch: [S('form', 'full'), S('metric', 'half'), S('metric', 'half'), S('table', 'full')],
    title: 'Recepción de mercancía',
    body: 'Registro de llegadas desde el celular: hora, proveedor o cliente, cantidad, novedades e inspección.',
    prompt:
      'Recepción de mercancía: una pantalla para quien recibe en bodega, planta o tienda, pensada para el celular. Usa theme.layout "operator". Si no existe una tabla de recepciones, créala con trackers.define con los campos fecha (fecha), hora (hora), proveedor_cliente (texto), documento (texto: remisión, factura o guía), cantidad (número), novedades (texto largo) e inspeccionado (casilla). Arriba un formulario grande para registrar una llegada, con dictado. Después dos métricas pequeñas: llegadas de hoy y llegadas con novedades. Debajo, las últimas llegadas como tarjetas grandes con un buscador. Si las remisiones o actas llegan a una carpeta de Drive, ofrece llenar la tabla desde ahí con trackers.sync_from_drive_folder con key_fields que incluyan documento y fecha. Que la vista pite y titile cuando llegue una recepción nueva o una cambie (por ejemplo, con novedades): alerta {on: "both", sound: true} sobre esa tabla y refreshSeconds 10.',
  },
  {
    id: 'inspeccion_checklist',
    kind: 'prompt',
    icon: 'truck',
    category: 'Operación',
    sketch: [S('form', 'full'), S('metric', 'half'), S('metric', 'half'), S('table', 'full')],
    title: 'Inspección con lista de chequeo',
    body: 'Preoperacional de vehículos, equipos o locales desde el celular: casillas, novedades y lo que no pasó.',
    prompt:
      'Inspección con lista de chequeo: una pantalla para hacer la inspección diaria (preoperacional de vehículos, equipos, máquinas o locales) desde el celular. Usa theme.layout "operator". Pregúntame qué se inspecciona si no es obvio. Si no existe la tabla, créala con trackers.define con: fecha (fecha), hora (hora), qué se inspeccionó (texto: placa, equipo o sitio), quién (texto), de 4 a 8 puntos de chequeo como casillas, observaciones (texto largo) y resultado (opciones: Aprobado, Con novedad, No apto). Arriba el formulario con dictado. Dos métricas: inspecciones de hoy y con novedad o no aptas. Debajo, las inspecciones como tarjetas, las que no pasaron resaltadas. Que la vista pite y titile cuando entre una inspección nueva o una pase a Con novedad o No apto: alerta {on: "both", sound: true} sobre esa tabla y refreshSeconds 10.',
  },
  {
    id: 'conteo_inventario',
    kind: 'prompt',
    icon: 'boxes',
    category: 'Operación',
    sketch: [
      S('form', 'full'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('metric', 'third'),
      S('table', 'full'),
    ],
    title: 'Conteo de inventario',
    body: 'Contar en bodega con el celular: referencia, ubicación y cantidad, dictando, con los conteos repetidos marcados.',
    prompt:
      'Conteo de inventario: una pantalla para contar en bodega desde el celular. Usa theme.layout "operator". Si no existe la tabla, créala con trackers.define con: fecha (fecha), referencia (texto), ubicacion (texto), cantidad (número), contado_por (texto), observaciones (texto largo) y estado (opciones: Contado, Diferencia, Duplicado), con la regla duplicates {key: "referencia", distinctBy: "ubicacion", flagField: "estado", flagValue: "Duplicado"} si la misma referencia no debería estar en dos ubicaciones; pregúntame si aplica. Arriba el formulario con dictado («referencia A-102, estante 3, cuarenta unidades»). Tres métricas: referencias contadas hoy, unidades contadas y con diferencia o duplicadas. Debajo, los conteos como tarjetas con buscador por referencia. Que la vista pite y titile cuando entre un conteo nuevo o uno cambie (por ejemplo, con diferencia): alerta {on: "both", sound: true} sobre esa tabla y refreshSeconds 10.',
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
    id: 'como_va_el_equipo',
    kind: 'spec',
    icon: 'users',
    category: 'Clientes y equipo',
    title: 'Cómo va el equipo',
    body: 'Lo abierto, lo vencido y lo cerrado de cada persona, del registro de trabajo. Sin ranking.',
    name: 'Cómo va el equipo',
    description: 'Trabajo del equipo en los últimos 30 días, por persona y tipo.',
    spec: comoVaElEquipo,
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
  {
    id: 'programa_pagos',
    kind: 'spec',
    icon: 'wallet',
    category: 'Ventas y cartera',
    module: 'payables',
    title: 'Programa de pagos',
    body: 'Las facturas de proveedores abiertas por vencimiento, lo ya programado y a quién se le debe más.',
    name: 'Programa de pagos',
    description: 'Facturas de proveedores por pagar, por vencimiento.',
    spec: programaDePagos,
  },
  {
    id: 'inventario_bajo_minimo',
    kind: 'spec',
    icon: 'boxes',
    category: 'Operación',
    module: 'inventory',
    title: 'Inventario bajo mínimo',
    body: 'Lo agotado y lo que está bajo el mínimo, con los pedidos en camino y los atrasados.',
    name: 'Inventario bajo mínimo',
    description: 'Productos que piden reposición y órdenes de compra en camino.',
    spec: inventarioBajoMinimo,
  },
  {
    id: 'embudo_comercial',
    kind: 'spec',
    icon: 'kanban',
    category: 'Ventas y cartera',
    module: 'crm',
    title: 'Embudo comercial',
    body: 'Las oportunidades por etapa, lo ponderado por probabilidad y los próximos cierres.',
    name: 'Embudo comercial',
    description: 'Oportunidades abiertas por etapa, con lo que se espera cerrar.',
    spec: embudoComercial,
  },
  {
    id: 'vencimientos_empresa',
    kind: 'spec',
    icon: 'calendar',
    category: 'Operación',
    module: 'doc_expirations',
    title: 'Vencimientos de la empresa',
    body: 'SOAT, pólizas, licencias y permisos: lo vencido, lo que viene y a quién le toca renovarlo.',
    name: 'Vencimientos de la empresa',
    description: 'Papeles que vencen, por fecha y estado.',
    spec: vencimientosEmpresa,
  },
];

/**
 * Las plantillas que se pueden ofrecer con estos módulos APAGADOS: una de un
 * módulo apagado abriría una vista sin datos. Las que no dependen de ninguno,
 * siempre.
 */
export function startersFor(modulesOff: readonly ModuleKey[] = []): StarterTemplate[] {
  if (!modulesOff.length) return STARTER_TEMPLATES;
  const off = new Set<ModuleKey>(modulesOff);
  return STARTER_TEMPLATES.filter((t) => !t.module || !off.has(t.module));
}
