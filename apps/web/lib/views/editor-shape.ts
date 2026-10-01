/**
 * EL VOCABULARIO DE UNA VISTA, REPETIDO PARA EL NAVEGADOR.
 *
 * El lienzo (components/views/editor) es un componente de cliente y necesita
 * las listas del contrato —operadores de filtro, agregados, anchos, tonos,
 * cada cuánto se refresca— para ofrecerlas en menús. No puede importarlas de
 * `@cortex/agent-tools`: el paquete no tiene subrutas y su barril arrastra
 * `node:dns`, que rompe el build de producción mientras typecheck y pruebas
 * siguen en verde (ver lib/reports-shape.ts, que pasó por lo mismo).
 *
 * Así que son copias, y las copias se desvían. `editor-shape.test.ts` corre en
 * Node, importa las de verdad y falla el día que no coincidan: si alguien
 * agrega un operador al contrato, el lienzo lo ofrece o la prueba se pone roja.
 *
 * Lo que sí es propio de aquí son los NOMBRES en español de cada opción: el
 * contrato habla de `gte` y `before_today`; quien arma un tablero de cartera
 * elige «mayor o igual que» y «antes de hoy».
 */

export const FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'empty',
  'not_empty',
  'before_today',
  'after_today',
  'next_days',
  'last_days',
] as const;
export type EditorFilterOp = (typeof FILTER_OPS)[number];

export const VALUELESS_OPS: ReadonlySet<EditorFilterOp> = new Set([
  'empty',
  'not_empty',
  'before_today',
  'after_today',
]);

/** Los que piden un número de días, no un valor del campo. */
export const DAYS_OPS: ReadonlySet<EditorFilterOp> = new Set(['next_days', 'last_days']);

export const FILTER_OP_LABEL: Record<EditorFilterOp, string> = {
  eq: 'es',
  neq: 'no es',
  contains: 'contiene',
  gt: 'mayor que',
  gte: 'mayor o igual que',
  lt: 'menor que',
  lte: 'menor o igual que',
  empty: 'está vacío',
  not_empty: 'tiene algo',
  before_today: 'antes de hoy',
  after_today: 'después de hoy',
  next_days: 'en los próximos días',
  last_days: 'en los últimos días',
};

export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type EditorAggregate = (typeof AGGREGATES)[number];
export const AGGREGATE_LABEL: Record<EditorAggregate, string> = {
  count: 'Contar filas',
  sum: 'Sumar',
  avg: 'Promedio',
  min: 'Mínimo',
  max: 'Máximo',
};

export const WIDTHS = ['third', 'half', 'full'] as const;
export type EditorWidth = (typeof WIDTHS)[number];
export const WIDTH_LABEL: Record<EditorWidth, { short: string; long: string }> = {
  third: { short: '⅓', long: 'Un tercio' },
  half: { short: '½', long: 'Media' },
  full: { short: 'Completo', long: 'Ancho completo' },
};

export const TONES = ['primary', 'emerald', 'amber', 'sky', 'rose'] as const;
export type EditorTone = (typeof TONES)[number];
export const TONE_LABEL: Record<EditorTone, string> = {
  primary: 'Índigo',
  emerald: 'Verde',
  amber: 'Ámbar',
  sky: 'Azul',
  rose: 'Rosa',
};

export const FORMATS = ['number', 'money', 'percent'] as const;
export const FORMAT_LABEL: Record<(typeof FORMATS)[number], string> = {
  number: 'Número',
  money: 'Pesos',
  percent: 'Porcentaje',
};

export const REFRESH_CHOICES = [0, 10, 30, 60] as const;
export const REFRESH_LABEL: Record<(typeof REFRESH_CHOICES)[number], string> = {
  0: 'Nunca',
  10: 'Cada 10 s',
  30: 'Cada 30 s',
  60: 'Cada minuto',
};

export const EDITING_MODES = ['off', 'team', 'public'] as const;
export type EditorEditingMode = (typeof EDITING_MODES)[number];
export const EDITING_LABEL: Record<EditorEditingMode, { title: string; body: string }> = {
  off: { title: 'Sólo lectura', body: 'Nadie cambia filas desde la vista.' },
  team: { title: 'El equipo', body: 'Quien está en Cortex edita celdas, arrastra y usa botones.' },
  public: {
    title: 'También el enlace',
    body: 'Quien abre el enlace compartido también puede cambiar filas.',
  },
};

export const CHART_KINDS = ['bar', 'line', 'donut'] as const;
export const CHART_LABEL: Record<(typeof CHART_KINDS)[number], string> = {
  bar: 'Barras',
  line: 'Línea',
  donut: 'Dona',
};

export const BUCKETS = ['day', 'week', 'month'] as const;
export const BUCKET_LABEL: Record<(typeof BUCKETS)[number], string> = {
  day: 'Por día',
  week: 'Por semana',
  month: 'Por mes',
};

export const MAX_VIEW_BLOCKS = 24;
export const BLOCK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Los seis tipos que el lienzo sabe armar. Otro tipo (p. ej. «zones») se conserva tal cual. */
export const KNOWN_BLOCK_TYPES = ['metric', 'table', 'chart', 'board', 'form', 'text'] as const;
export type KnownBlockType = (typeof KNOWN_BLOCK_TYPES)[number];

export const BLOCK_LABEL: Record<string, string> = {
  text: 'Texto',
  metric: 'Cifra',
  table: 'Tabla',
  chart: 'Gráfico',
  board: 'Tablero',
  form: 'Formulario',
  zones: 'Plano',
};

/** Los tres campos que toda fila tiene, con el nombre que ve la gente. */
export const BUILTIN_FIELD_LABEL: Record<string, string> = {
  label: 'Nombre',
  created_at: 'Creada',
  updated_at: 'Actualizada',
};

// Las tres familias de ids de fuente (spec.ts). Sólo las tablas propias se escriben.
const PLATFORM_SOURCE_RE = /^cortex\.[a-z][a-z0-9_]{1,40}$/;
const FEED_PREFIX_RE = /^(?:feed|feedsrc|feedview)\./;

export function isReadOnlySourceId(ref: string): boolean {
  return PLATFORM_SOURCE_RE.test(ref) || FEED_PREFIX_RE.test(ref);
}
