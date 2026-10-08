import { z } from 'zod';
import { TRACKER_SLUG_RE, type TrackerField } from '../trackers/schema';
import { embedSrc, httpsUrl, safeHref } from './embeds';

/**
 * EL CONTRATO DE UNA VISTA (migración 0156).
 *
 * Una vista es una lista de bloques declarativos sobre las tablas inventadas
 * del espacio y, en sólo lectura, sobre las tablas propias de la plataforma
 * (ventas, pagos, clientes…; ver sources.ts). El modelo escribe este JSON y la
 * persona lo edita hablando;
 * nadie escribe HTML ni JavaScript. Es lo que permite abrirla desde afuera sin
 * miedo: un spec no puede ejecutar nada, sólo pedir datos que el servidor
 * calcula con el mismo handle de espacio que usa todo lo demás.
 *
 * Todo lo que un bloque nombra —tabla, campo— se comprueba contra el catálogo
 * real en `checkSpecAgainst`. zod garantiza la FORMA; el catálogo garantiza que
 * la forma habla de cosas que existen. Un spec que pasa zod pero nombra un
 * campo que no existe no se rechaza en la lectura (la tabla pudo cambiar
 * después): el bloque se pinta como un aviso y el resto de la vista sigue.
 */

export const VIEW_SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

/**
 * LAS FUENTES DE LA PLATAFORMA SE NOMBRAN DISTINTO, A PROPÓSITO.
 *
 * Un bloque lee de una tabla inventada («remates») o de una tabla propia de
 * Cortex («cortex.ventas», ver sources.ts). El punto no cabe en un slug de
 * tabla (TRACKER_SLUG_RE no lo admite), así que las dos familias no pueden
 * chocar nunca: nadie puede crear una tabla que se llame como una fuente de la
 * plataforma y cambiarle a una vista guardada de dónde saca sus números.
 *
 * El campo del bloque sigue llamándose `tracker` para que los specs que ya
 * están guardados sigan pasando el contrato sin migrar nada.
 */
export const PLATFORM_SOURCE_RE = /^cortex\.[a-z][a-z0-9_]{1,40}$/;

export function isPlatformSourceId(ref: string): boolean {
  return PLATFORM_SOURCE_RE.test(ref);
}

/**
 * LAS TABLAS DEL FEED, TERCERA FAMILIA (ver feed-sources.ts).
 *
 * Una hoja de una captura del Feed, una hoja de la última captura de una
 * fuente conectada, o una vista preparada. Sus ids llevan el uuid de la fila
 * dueña y, en las hojas, el número de hoja (0–19, el tope del Feed):
 *
 *   feed.<uuid de la captura>.<hoja>       una captura fija (archivo, texto, URL)
 *   feedsrc.<uuid de la conexión>.<hoja>   la ÚLTIMA captura de una fuente conectada
 *   feedview.<uuid de la vista preparada>  la tabla que Cortex preparó de un texto
 *
 * Tampoco caben en un slug de tabla (llevan puntos y guiones) ni en un
 * `cortex.*`, así que las tres familias no chocan. Son de sólo lectura, como
 * las de la plataforma: el Feed no se escribe desde una vista.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHEET = '(?:1[0-9]|[0-9])';
export const FEED_SOURCE_RE = new RegExp(
  `^(?:feed\\.${UUID}\\.${SHEET}|feedsrc\\.${UUID}\\.${SHEET}|feedview\\.${UUID})$`,
);

export type FeedSourceRef =
  | { kind: 'entry'; id: string; sheet: number }
  | { kind: 'connection'; id: string; sheet: number }
  | { kind: 'prepared'; id: string; sheet: 0 };

export function isFeedSourceId(ref: string): boolean {
  return FEED_SOURCE_RE.test(ref);
}

/** Desarma un id del Feed. Null si no es uno. */
export function parseFeedSourceId(ref: string): FeedSourceRef | null {
  if (!FEED_SOURCE_RE.test(ref)) return null;
  const [prefix, id = '', sheet] = ref.split('.');
  if (prefix === 'feedview') return { kind: 'prepared', id, sheet: 0 };
  return { kind: prefix === 'feed' ? 'entry' : 'connection', id, sheet: Number(sheet) };
}

export function feedSourceId(ref: FeedSourceRef): string {
  if (ref.kind === 'prepared') return `feedview.${ref.id}`;
  return `${ref.kind === 'entry' ? 'feed' : 'feedsrc'}.${ref.id}.${ref.sheet}`;
}

/**
 * Lo que una vista NO puede escribir: las fuentes de la plataforma y las del
 * Feed. Formularios, celdas editables, tableros que se arrastran y botones
 * sólo existen sobre las tablas propias del espacio.
 */
export function isReadOnlySource(ref: string): boolean {
  return isPlatformSourceId(ref) || isFeedSourceId(ref);
}

const sourceRef = z
  .string()
  .refine(
    (v) => TRACKER_SLUG_RE.test(v) || PLATFORM_SOURCE_RE.test(v) || FEED_SOURCE_RE.test(v),
    'Usa el slug de una tabla del espacio, el id de una fuente de la plataforma (cortex.…) o el de una tabla del Feed (feed.…).',
  );
export const BLOCK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_VIEW_BLOCKS = 24;

/** Campos que toda fila tiene, además de los que la tabla declara. */
export const BUILTIN_FIELDS = ['label', 'created_at', 'updated_at'] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number];

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
export type FilterOp = (typeof FILTER_OPS)[number];

/** Operadores que no llevan valor. */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set([
  'empty',
  'not_empty',
  'before_today',
  'after_today',
]);

export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const WIDTHS = ['full', 'half', 'third'] as const;
export const TONES = ['primary', 'emerald', 'amber', 'sky', 'rose'] as const;
export type Tone = (typeof TONES)[number];

const fieldRef = z.string().trim().min(1).max(32);

/** Períodos del KPI que se compara con el anterior. */
export const PERIODS = ['day', 'week', 'month'] as const;
export type Period = (typeof PERIODS)[number];
const title = z.string().trim().min(1).max(120);

export const filterSchema = z
  .object({
    field: fieldRef,
    op: z.enum(FILTER_OPS),
    value: z.union([z.string().max(200), z.number()]).optional(),
  })
  .superRefine((f, ctx) => {
    if (!VALUELESS_OPS.has(f.op) && (f.value === undefined || f.value === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El filtro «${f.op}» necesita un valor.`,
        path: ['value'],
      });
    }
    if ((f.op === 'next_days' || f.op === 'last_days') && !(Number(f.value) > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `«${f.op}» necesita un número de días mayor que cero.`,
        path: ['value'],
      });
    }
  });
export type ViewFilter = z.infer<typeof filterSchema>;

const base = {
  id: z.string().regex(BLOCK_ID_RE),
  width: z.enum(WIDTHS).default('full'),
};
const source = {
  tracker: sourceRef,
  filters: z.array(filterSchema).max(8).default([]),
};

export const textBlockSchema = z.object({
  ...base,
  type: z.literal('text'),
  markdown: z.string().trim().min(1).max(4000),
});

export const metricBlockSchema = z.object({
  ...base,
  ...source,
  type: z.literal('metric'),
  title,
  aggregate: z.enum(AGGREGATES).default('count'),
  field: fieldRef.optional(),
  format: z.enum(['number', 'money', 'percent']).default('number'),
  /** Meta opcional: la cifra se pinta contra ella. */
  goal: z.number().finite().optional(),
  /**
   * Hacia dónde es bueno ir con la meta. `up` (por defecto): la meta es un
   * piso («vender 120 M»); `down`: es un techo («devoluciones, máx. 5»). Con
   * meta, la cifra lleva semáforo (verde / ámbar / rojo) según esta dirección.
   */
  goalDirection: z.enum(['up', 'down']).optional(),
  tone: z.enum(TONES).default('primary'),
  caption: z.string().trim().max(200).optional(),
  /**
   * EL KPI CONTRA EL PERÍODO ANTERIOR. Con `compare: 'previous_period'`, la
   * cifra deja de ser «todo lo que cumple los filtros» y pasa a ser «lo de
   * este período» (`period`, por `dateField`), con el delta contra el
   * anterior y una línea con los últimos períodos. `goodWhen` dice si subir es
   * bueno (ventas) o malo (devoluciones, días de mora): decide el color de la
   * flecha, no su dirección.
   *
   * Todo opcional y sin valores por defecto a propósito: los specs ya
   * guardados (y los escritos a mano como `ViewSpec`) siguen siendo válidos y
   * del mismo tipo.
   */
  compare: z.enum(['previous_period']).optional(),
  period: z.enum(PERIODS).optional(),
  dateField: fieldRef.optional(),
  goodWhen: z.enum(['up', 'down']).optional(),
});

/**
 * UN BOTÓN POR FILA. Dos clases y ninguna más:
 *   - `set_field`: pone un valor fijo en un campo de ESA fila («Marcar pagada»
 *     → estado = Pagada). Sólo en tablas propias; se valida con el esquema de
 *     la tabla como cualquier otra escritura.
 *   - `notify`: avisa en la campana a quien creó la vista y a los
 *     administradores («Pedir revisión»), con el nombre de la fila. No escribe
 *     nada en la tabla.
 * Nada de acciones libres: un botón que ejecutara «lo que diga el modelo» en
 * una vista pública sería una puerta sin cerradura.
 */
export const rowActionSchema = z
  .object({
    id: z.string().regex(BLOCK_ID_RE),
    label: z.string().trim().min(1).max(32),
    kind: z.enum(['set_field', 'notify', 'assign']),
    field: fieldRef.optional(),
    value: z.union([z.string().max(200), z.number()]).optional(),
    confirm: z.boolean().default(false),
    tone: z.enum(TONES).default('primary'),
    /**
     * `set_field`: campos que la fila ya tiene que traer llenos para que el
     * botón funcione («Terminar» pide foto y nota de cierre). El servidor lo
     * comprueba; el botón no cambia nada si falta alguno y dice cuál.
     */
    requireFields: z.array(fieldRef).max(6).optional(),
    /**
     * `assign` («Asignar a…», tareas): `field` guarda el id de la persona,
     * `nameField` su nombre, `statusField` recibe `value` al asignar («Pendiente»),
     * `roles` limita a qué roles de la app se puede asignar (vacío = todos) y
     * `screen` es la pantalla que abre el aviso que le llega a la persona.
     */
    nameField: fieldRef.optional(),
    statusField: fieldRef.optional(),
    roles: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/))
      .max(8)
      .optional(),
    screen: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,47}$/)
      .optional(),
  })
  .superRefine((a, ctx) => {
    if (a.kind === 'set_field' && (!a.field || a.value === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El botón «${a.label}» cambia un campo: necesita field y value.`,
        path: ['field'],
      });
    if (a.kind === 'assign' && !a.field)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El botón «${a.label}» asigna a una persona: necesita field (el campo donde se guarda quién).`,
        path: ['field'],
      });
  });
export type RowAction = z.infer<typeof rowActionSchema>;

/**
 * LA FICHA DE UNA FILA. Un clic en una fila de una tabla, una tarjeta, una
 * ficha del plano, una tarjeta de la galería o un evento del calendario abre
 * su ficha: todos los campos declarados de esa fila, sus fechas y sus botones.
 *
 *   - `openRecord` (por defecto sí): `false` la apaga para ese bloque.
 *   - `detailFields`: qué campos muestra. Vacío = todos los de una tabla
 *     propia; en una fuente de la plataforma o del Feed, los primeros ocho
 *     (ver `defaultDetailFields` en compute.ts).
 *   - `recordEditable`: qué campos se editan DESDE la ficha. Sólo tablas
 *     propias, y sólo si la vista deja escribir (`editing`): pasa por el mismo
 *     `editViewRow` que una celda, con la misma lista blanca.
 *
 * Opcionales sin valor por defecto, como el KPI: los specs viejos no cambian.
 */
const record = {
  openRecord: z.boolean().optional(),
  detailFields: z.array(fieldRef).max(16).optional(),
  recordEditable: z.array(fieldRef).max(12).optional(),
};

export const tableBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('table'),
  title,
  columns: z.array(fieldRef).max(10).default([]),
  sort: z.object({ field: fieldRef, dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  searchable: z.boolean().default(true),
  /** Columnas que se pueden editar en el sitio (sólo tablas propias). */
  editable: z.array(fieldRef).max(10).default([]),
  actions: z.array(rowActionSchema).max(3).default([]),
});

export const CHART_KINDS = ['bar', 'line', 'donut', 'funnel', 'heatmap'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const chartBlockSchema = z.object({
  ...base,
  ...source,
  type: z.literal('chart'),
  title,
  /**
   * `funnel`: embudo por etapas — `groupBy` es un campo de opciones y las
   * etapas salen en el orden de sus opciones (con las vacías en cero).
   * `heatmap`: día de la semana × hora; `groupBy` es una fecha (o created_at /
   * updated_at, que traen la hora) y, si la fecha no trae hora, `hourField`
   * nombra un campo de hora del día.
   */
  chart: z.enum(CHART_KINDS).default('bar'),
  /** Campo por el que se agrupa; las fechas se agrupan por `bucket`. */
  groupBy: fieldRef,
  hourField: fieldRef.optional(),
  bucket: z.enum(['day', 'week', 'month']).default('month'),
  aggregate: z.enum(AGGREGATES).default('count'),
  field: fieldRef.optional(),
  format: z.enum(['number', 'money', 'percent']).default('number'),
  limit: z.number().int().min(2).max(24).default(12),
  tone: z.enum(TONES).default('primary'),
});

export const boardBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('board'),
  title,
  /** Un campo de opciones: cada opción es una columna del tablero. */
  groupBy: fieldRef,
  cardFields: z.array(fieldRef).max(4).default([]),
  limit: z.number().int().min(1).max(60).default(30),
  /** Arrastrar una tarjeta a otra columna cambia su campo de opciones. */
  draggable: z.boolean().default(false),
  actions: z.array(rowActionSchema).max(3).default([]),
});

/**
 * EL PLANO. Un tablero con forma de lugar: cada opción del campo de opciones
 * es una ZONA dibujada en una rejilla de 12×12 (una posición de la
 * plataforma, un muelle, una puerta), y cada fila es una ficha dentro de su
 * zona. Arrastrar la ficha a otra zona cambia el campo, igual que el tablero.
 * Sin `layout`, las zonas se acomodan solas en filas de tres.
 */
export const zoneLayoutSchema = z.object({
  zone: z.string().trim().min(1).max(80),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(11),
  w: z.number().int().min(1).max(12).default(4),
  h: z.number().int().min(1).max(6).default(2),
});

export const zonesBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('zones'),
  title,
  groupBy: fieldRef,
  cardFields: z.array(fieldRef).max(2).default([]),
  limit: z.number().int().min(1).max(40).default(20),
  draggable: z.boolean().default(false),
  actions: z.array(rowActionSchema).max(3).default([]),
  layout: z.array(zoneLayoutSchema).max(30).default([]),
});

/** Minutos para corregir lo enviado cuando el formulario no dice. */
export const DEFAULT_EDIT_WINDOW_MINUTES = 10;

export const formApprovalSchema = z.object({
  field: fieldRef,
  pending: z.string().trim().min(1).max(60),
  approved: z.string().trim().min(1).max(60),
  rejected: z.string().trim().min(1).max(60),
  notesField: fieldRef.optional(),
});
export type FormApproval = z.infer<typeof formApprovalSchema>;

export const formStepSchema = z.object({
  title: z.string().trim().min(1).max(60),
  fields: z.array(fieldRef).min(1).max(20),
});
export type FormStep = z.infer<typeof formStepSchema>;

/** Las acciones que Aprobar / Rechazar agregan a los bloques de la misma tabla. */
export const APPROVE_ACTION_ID = '__approve';
export const REJECT_ACTION_ID = '__reject';

export const formBlockSchema = z.object({
  ...base,
  type: z.literal('form'),
  // La forma admite las dos familias para que el rechazo de un formulario
  // sobre una fuente de la plataforma llegue con su explicación desde
  // `checkSpecAgainst`, y no como un «no cumple el patrón» que nadie entiende.
  tracker: sourceRef,
  title,
  intro: z.string().trim().max(400).optional(),
  /** Campos que el formulario pide; vacío = todos los de la tabla. */
  fields: z.array(fieldRef).max(20).default([]),
  submitLabel: z.string().trim().min(1).max(40).default('Enviar'),
  successMessage: z.string().trim().min(1).max(200).default('Recibido. Gracias.'),
  /**
   * Minutos tras el envío en que quien lo mandó puede «Corregir» (0 = no; sin
   * valor = 10, ver `editWindowOf`). En el
   * enlace público lo valida un token de edición que el envío devuelve.
   */
  editWindowMinutes: z.number().int().min(0).max(1440).optional(),
  /**
   * Aprobación: los envíos nacen en `pending` (un campo de opciones de la
   * tabla); quien puede escribir ve Aprobar / Rechazar en las tablas y
   * tarjetas de la vista. `notesField` (opcional, de texto) guarda el motivo.
   */
  approval: formApprovalSchema.optional(),
  /** Formulario por pasos: cada paso pide algunos de los campos (máx. 10 pasos). */
  steps: z.array(formStepSchema).max(10).optional(),
  /**
   * Cómo se llena hablando: `off` sin voz, `dictate` (por defecto, el de
   * siempre) un botón para dictar el registro entero de una vez,
   * `conversation` además «Llenar hablando»: Cortex pregunta campo por campo
   * en voz alta, valida y lo envía al confirmar. Ver `VOICE_MODES`.
   */
  voice: z.enum(['off', 'dictate', 'conversation']).optional(),
});

/** Cómo se llena un formulario hablando (por defecto: dictar). */
export const VOICE_MODES = ['off', 'dictate', 'conversation'] as const;
export type FormVoiceMode = (typeof VOICE_MODES)[number];
export function formVoiceOf(block: Pick<FormBlock, 'voice'>): FormVoiceMode {
  return block.voice ?? 'dictate';
}

/**
 * EL ASISTENTE DE VOZ. Un panel grande que maneja el formulario `form` de la
 * MISMA vista conversando: Cortex pregunta campo por campo, escucha, valida y
 * envía al confirmar. Llena el formulario visible, así que la persona lo ve y
 * puede corregir con el dedo. `autoStart` arranca la conversación al abrir la
 * pantalla (el navegador puede pedir un toque antes de dejar sonar la voz).
 */
export const voiceBlockSchema = z.object({
  ...base,
  type: z.literal('voice'),
  title: title.optional(),
  /** El id de un bloque `form` de esta misma vista. */
  form: z.string().regex(BLOCK_ID_RE),
  autoStart: z.boolean().optional(),
});

/**
 * LA GALERÍA: TARJETAS EN REJILLA. Para catálogos, inmuebles, vehículos,
 * pacientes, cursos, proveedores: cualquier lista que se lee mejor por
 * tarjeta que por renglón. `badgeField` (un campo de opciones) pinta una
 * etiqueta con el color de su posición en las opciones; `imageField` es un
 * campo de texto con una dirección `https:` (las demás no se pintan).
 */
export const galleryBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('gallery'),
  title,
  titleField: fieldRef.default('label'),
  subtitleField: fieldRef.optional(),
  metaFields: z.array(fieldRef).max(3).default([]),
  badgeField: fieldRef.optional(),
  imageField: fieldRef.optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  sort: z.object({ field: fieldRef, dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
  limit: z.number().int().min(1).max(48).default(12),
  actions: z.array(rowActionSchema).max(3).default([]),
});

/**
 * EL CALENDARIO. Cada fila con fecha en `dateField` es un evento. `month`
 * pinta la cuadrícula del mes (el cálculo entrega el mes anterior, el actual
 * y el siguiente: se navega entre ellos sin volver a pedir datos); `agenda`
 * es la lista de los próximos `days` días. `colorField` (un campo de
 * opciones) colorea cada evento por su opción.
 */
export const CALENDAR_MODES = ['month', 'agenda', 'week', 'day'] as const;
export const CALENDAR_SWITCH_MODES = ['day', 'week', 'month'] as const;
export const calendarBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('calendar'),
  title,
  dateField: fieldRef,
  labelField: fieldRef.default('label'),
  colorField: fieldRef.optional(),
  /**
   * `week` y `day` son la agenda de planta: los eventos de una semana (siete
   * días) o de un día, ordenados por hora (`timeField`). Se navega entre los
   * tres meses que el cálculo entrega, igual que `month`.
   */
  mode: z.enum(CALENDAR_MODES).default('month'),
  /** Un campo de hora (HH:MM): ordena el día y se pinta al lado del nombre. */
  timeField: fieldRef.optional(),
  /**
   * Con más de una, la persona cambia entre día / semana / mes con un
   * selector; `mode` es con la que abre. Sin `modes`, la vista es fija.
   */
  modes: z.array(z.enum(CALENDAR_SWITCH_MODES)).max(3).optional(),
  /** Agenda: cuántos días hacia adelante, contando hoy. */
  days: z.number().int().min(1).max(60).default(14),
  actions: z.array(rowActionSchema).max(3).default([]),
});

/**
 * EL DETALLE DE UN REGISTRO. Una pantalla entera para UNA fila: se abre desde
 * una tabla, unas tarjetas, un tablero o una agenda que lean la misma tabla (o
 * por su enlace, `?fila=<id>`), y no se pinta mientras no haya fila elegida.
 *
 *   - Cabecera: el título (`titleField`), un subtítulo y el estado
 *     (`statusField`, un campo de opciones: chip con el color de su posición).
 *   - `sections`: los campos agrupados («Vuelo», «Carga», «Contacto»). Sin
 *     secciones, todos los de la tabla en una sola. Lo que no está aquí no sale.
 *   - `gallery`: campos de archivos/fotos del registro, en galería.
 *   - `related`: listas de otras tablas ligadas a este registro, con sus
 *     propios botones. Ver `relatedSchema`.
 *   - `actions` / `recordEditable`: botones y campos editables del registro.
 *   - `timeline`: la línea de tiempo del registro (quién lo creó, qué cambió
 *     de qué a qué, aprobaciones, automatizaciones, archivos subidos).
 *
 * Todo lo que lee pasa por `loadViewSources`, así que el scope por rol de una
 * aplicación aplica igual a la fila, a los relacionados y a la línea de tiempo.
 */
export const detailSectionSchema = z.object({
  title: z.string().trim().min(1).max(60),
  fields: z.array(fieldRef).min(1).max(12),
});
export type DetailSection = z.infer<typeof detailSectionSchema>;

/**
 * UNA LISTA DE REGISTROS RELACIONADOS dentro del detalle: «las guías de este
 * vuelo», «las atenciones de este cliente».
 *   - `match: 'relation'` (por defecto): `field` es un campo relación de la
 *     tabla relacionada que apunta a la tabla del detalle.
 *   - `match: 'value'`: un valor común. `field` (de la tabla relacionada) vale
 *     lo mismo que `parentField` (del registro): el número de vuelo escrito en
 *     las dos tablas, sin relación formal.
 */
export const RELATED_MATCHES = ['relation', 'value'] as const;
export const relatedSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,15}$/),
    title: z.string().trim().min(1).max(60),
    tracker: sourceRef,
    field: fieldRef,
    match: z.enum(RELATED_MATCHES).default('relation'),
    parentField: fieldRef.optional(),
    columns: z.array(fieldRef).max(4).default([]),
    sort: z.object({ field: fieldRef, dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
    limit: z.number().int().min(1).max(30).default(10),
    actions: z.array(rowActionSchema).max(3).default([]),
  })
  .superRefine((r, ctx) => {
    if (r.match === 'value' && !r.parentField)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Relacionar por un valor común necesita parentField (el campo del registro).',
        path: ['parentField'],
      });
  });
export type RelatedList = z.infer<typeof relatedSchema>;

export const TIMELINE_PARTS = ['created', 'changes', 'approvals', 'automations', 'files'] as const;
export type TimelinePart = (typeof TIMELINE_PARTS)[number];
export const timelineSchema = z.union([
  z.literal(false),
  z.object({
    show: z
      .array(z.enum(TIMELINE_PARTS))
      .min(1)
      .max(5)
      .default([...TIMELINE_PARTS]),
    limit: z.number().int().min(5).max(100).default(30),
  }),
]);

export const detailBlockSchema = z.object({
  ...base,
  ...source,
  recordEditable: record.recordEditable,
  type: z.literal('detail'),
  title: z.string().trim().max(120).optional(),
  titleField: fieldRef.default('label'),
  subtitleField: fieldRef.optional(),
  statusField: fieldRef.optional(),
  sections: z.array(detailSectionSchema).max(6).default([]),
  gallery: z.array(fieldRef).max(4).default([]),
  related: z.array(relatedSchema).max(4).default([]),
  actions: z.array(rowActionSchema).max(4).default([]),
  timeline: timelineSchema.optional(),
});
export type DetailBlock = z.infer<typeof detailBlockSchema>;

/**
 * LA LISTA DE TARJETAS CON FILTROS RÁPIDOS. Tarjetas grandes con imagen,
 * estado y dos a cuatro datos; arriba, el buscador, los chips de filtro y el
 * orden. Los filtros corren en el navegador sobre lo que el cálculo entregó
 * (hasta `limit` tarjetas): tocar un chip es instantáneo.
 *   - `chips`: `status` (una por opción de `statusField`), `today` y `week`
 *     (sobre `dateField`) y `mine` (los que creó quien mira).
 *   - `groupBy`: títulos de grupo por un campo (estado, sede, día…).
 *   - `sortOptions`: campos entre los que la persona elige el orden.
 *   - `paging`: `more` («Ver más») o `infinite` (carga al llegar al final).
 */
export const CARD_CHIPS = ['status', 'today', 'week', 'mine'] as const;
export type CardChip = (typeof CARD_CHIPS)[number];
export const cardsBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('cards'),
  title,
  titleField: fieldRef.default('label'),
  subtitleField: fieldRef.optional(),
  imageField: fieldRef.optional(),
  statusField: fieldRef.optional(),
  dataFields: z.array(fieldRef).max(4).default([]),
  dateField: fieldRef.optional(),
  chips: z.array(z.enum(CARD_CHIPS)).max(4).default([]),
  searchable: z.boolean().default(true),
  groupBy: fieldRef.optional(),
  sort: z.object({ field: fieldRef, dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
  sortOptions: z.array(fieldRef).max(4).default([]),
  pageSize: z.number().int().min(4).max(48).default(12),
  paging: z.enum(['more', 'infinite']).default('more'),
  limit: z.number().int().min(1).max(200).default(100),
  actions: z.array(rowActionSchema).max(3).default([]),
});

/**
 * EL AVANCE HACIA UNA META. Sin `groupBy`, una sola barra: el agregado contra
 * `target`. Con `groupBy`, una barra por grupo (vendedor, sede, curso, ruta)
 * contra la meta de ese grupo en `targets` o, si no tiene, contra `target`.
 * Sin ninguna meta, las barras se comparan con el grupo más grande.
 */
export const progressBlockSchema = z.object({
  ...base,
  ...source,
  type: z.literal('progress'),
  title,
  groupBy: fieldRef.optional(),
  aggregate: z.enum(AGGREGATES).default('count'),
  field: fieldRef.optional(),
  target: z.number().finite().positive().optional(),
  targets: z
    .array(
      z.object({
        group: z.string().trim().min(1).max(80),
        target: z.number().finite().positive(),
      }),
    )
    .max(24)
    .default([]),
  format: z.enum(['number', 'money', 'percent']).default('number'),
  limit: z.number().int().min(1).max(24).default(8),
  tone: z.enum(TONES).default('primary'),
});

const httpsField = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => httpsUrl(v) !== null, 'Usa una dirección que empiece por https://.');

/**
 * UNA IMAGEN O UN VIDEO/MAPA/PRESENTACIÓN INSERTADO. Nunca HTML: una
 * dirección `https:` y, si es inserción, de la lista corta de embeds.ts
 * (YouTube, Google Maps, Loom, Slides y Docs publicados). Sin `url`, el bloque
 * sale vacío con la invitación a ponerla (así nace en el lienzo).
 */
export const MEDIA_ASPECTS = ['16:9', '4:3', '1:1', '3:4'] as const;
export const mediaBlockSchema = z.object({
  ...base,
  type: z.literal('media'),
  title: z.string().trim().max(120).optional(),
  kind: z.enum(['image', 'embed']).default('image'),
  url: httpsField.optional(),
  alt: z.string().trim().max(200).optional(),
  caption: z.string().trim().max(300).optional(),
  aspect: z.enum(MEDIA_ASPECTS).default('16:9'),
});

/** Un botón de navegación: a otra pantalla de Cortex o a una página `https:`. */
export const viewLinkSchema = z.object({
  label: z.string().trim().min(1).max(40),
  href: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => safeHref(v) !== null, 'Usa una ruta de Cortex (/…) o una dirección https://.'),
  description: z.string().trim().max(120).optional(),
  tone: z.enum(TONES).default('primary'),
});

export const linksBlockSchema = z.object({
  ...base,
  type: z.literal('links'),
  title: z.string().trim().max(120).optional(),
  links: z.array(viewLinkSchema).min(1).max(8),
  /** `buttons`: una fila de botones; `cards`: tarjetas con su descripción. */
  style: z.enum(['buttons', 'cards']).default('buttons'),
});

/**
 * QUÉ SE PUEDE PEDIR AL ASIGNAR UNA TAREA desde el mapa. La tarea es una fila
 * nueva de la tabla del bloque: `assigneeField` guarda el id de la persona
 * (el que lee `$user.id` en el rol de «Mis tareas»), `nameField` su nombre; el
 * resto de campos son los que el cuadro «Asignar tarea» pide si están.
 * `statusField` recibe `pendingValue` (la opción «Pendiente»). `roles` limita a
 * qué roles de la app se asigna; `screen` es la pantalla que abre el aviso.
 */
export const mapAssignSchema = z.object({
  assigneeField: fieldRef,
  nameField: fieldRef.optional(),
  titleField: fieldRef,
  descriptionField: fieldRef.optional(),
  dueField: fieldRef.optional(),
  dueTimeField: fieldRef.optional(),
  priorityField: fieldRef.optional(),
  statusField: fieldRef.optional(),
  pendingValue: z.string().trim().min(1).max(80).optional(),
  roles: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/))
    .max(8)
    .optional(),
  screen: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,47}$/)
    .optional(),
});
export type MapAssign = z.infer<typeof mapAssignSchema>;

/**
 * EL MAPA. Dos capas, ninguna obligatoria:
 *   - registros: cada fila de la tabla con un punto válido en `locationField`
 *     (un campo de tipo ubicación) es un marcador; `colorField` (un campo de
 *     opciones) le da color por estado y `titleField`/`subtitleField` la
 *     tarjeta que sale al tocarlo (con «Abrir» hacia el detalle de la fila);
 *   - personas (`people: true`): dónde están AHORA las personas en turno de la
 *     app. Sólo existe dentro de una aplicación con «Compartir ubicación del
 *     equipo» encendido y sólo la ven los roles con permiso de ver ubicaciones
 *     (`peopleRoles` además limita a las personas de esos roles). En una vista
 *     normal o en un enlace público esta capa NUNCA se pinta.
 * `assign` activa «Asignar tarea» al tocar una persona (ver `mapAssignSchema`).
 * Mapa de OpenStreetMap; se refresca con la vista (y las personas cada 20 s).
 */
export const mapBlockSchema = z.object({
  ...base,
  ...source,
  ...record,
  type: z.literal('map'),
  title,
  locationField: fieldRef,
  titleField: fieldRef.default('label'),
  subtitleField: fieldRef.optional(),
  colorField: fieldRef.optional(),
  people: z.boolean().default(false),
  peopleRoles: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/))
    .max(8)
    .default([]),
  limit: z.number().int().min(1).max(500).default(200),
  assign: mapAssignSchema.optional(),
  actions: z.array(rowActionSchema).max(3).default([]),
});

export const blockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  metricBlockSchema,
  tableBlockSchema,
  chartBlockSchema,
  boardBlockSchema,
  zonesBlockSchema,
  formBlockSchema,
  galleryBlockSchema,
  calendarBlockSchema,
  detailBlockSchema,
  cardsBlockSchema,
  mapBlockSchema,
  progressBlockSchema,
  mediaBlockSchema,
  linksBlockSchema,
  voiceBlockSchema,
]);
export type ViewBlock = z.infer<typeof blockSchema>;
export type ViewBlockType = ViewBlock['type'];

/**
 * AVISAR CUANDO ENTRA ALGO NUEVO. Mientras la vista está abierta, cada
 * refresco compara lo que había con lo que hay; una fila nueva de `source` que
 * cumpla los filtros suena (`sound`), aparece en pantalla y, si la persona lo
 * permitió en su navegador, como notificación del sistema (`desktop`). `bell`
 * además deja un aviso en la campana de quien creó la vista cuando la fila
 * entra por un formulario de ESTA vista — ése sí lo manda el servidor, esté o
 * no la vista abierta.
 */
export const viewAlertSchema = z.object({
  id: z.string().regex(BLOCK_ID_RE),
  source: sourceRef,
  filters: z.array(filterSchema).max(4).default([]),
  /**
   * Qué cuenta como noticia: 'new' una fila que no estaba, 'change' una fila
   * ya vista cuyo contenido cambió (pasó a «Duplicado»), 'both' las dos.
   */
  on: z.enum(['new', 'change', 'both']).default('new'),
  message: z.string().trim().max(120).optional(),
  sound: z.boolean().default(true),
  desktop: z.boolean().default(false),
  bell: z.boolean().default(false),
});
export type ViewAlert = z.infer<typeof viewAlertSchema>;

/** Cada cuánto se refresca sola una vista abierta. 0 = nunca. */
export const REFRESH_CHOICES = [0, 10, 30, 60] as const;

/**
 * LA BARRA DE FILTROS DE LA VISTA ENTERA. Hasta seis controles arriba de todo
 * («Sede», «Fechas», «Buscar cliente»). Lo que se elige se aplica a TODOS los
 * bloques que leen esa misma fuente, y a sus avisos. Se calcula en el
 * servidor: el navegador manda la elección (`?f=` en /api/views/…/data), el
 * servidor la valida contra este spec (ver view-filters.ts) y recalcula.
 *
 *   - `select`: un menú con las opciones del campo (o sus valores, si no es
 *     de opciones).
 *   - `date_range`: desde / hasta sobre un campo de fecha.
 *   - `search`: texto que se busca en el campo y en el nombre de la fila.
 */
export const FILTER_BAR_KINDS = ['select', 'date_range', 'search'] as const;
export const filterBarItemSchema = z.object({
  id: z.string().regex(BLOCK_ID_RE),
  label: z.string().trim().min(1).max(40),
  source: sourceRef,
  field: fieldRef,
  kind: z.enum(FILTER_BAR_KINDS),
});
export type FilterBarItem = z.infer<typeof filterBarItemSchema>;
export const MAX_FILTER_BAR = 6;

/**
 * PÁGINAS: pestañas sobre la MISMA lista de bloques. Cada página nombra sus
 * bloques; los que no están en ninguna salen en la primera. Sin páginas, la
 * vista es una sola página, como siempre.
 */
export const viewPageSchema = z.object({
  id: z.string().regex(BLOCK_ID_RE),
  title: z.string().trim().min(1).max(40),
  blockIds: z.array(z.string().regex(BLOCK_ID_RE)).max(MAX_VIEW_BLOCKS).default([]),
});
export type ViewPage = z.infer<typeof viewPageSchema>;
export const MAX_VIEW_PAGES = 8;

/**
 * EL ASPECTO. Siempre con los tokens del sistema de diseño: un color de
 * acento de los cinco, una densidad y una cabecera. `hero` es una banda
 * grande con el título, el subtítulo y, si hay, una imagen de portada
 * `https:`. No hay colores libres ni CSS en el spec. El color de la empresa
 * (migración 0170, `company_branding`) no vive aquí: es el acento por defecto
 * de todas sus vistas y lo aplica el navegador con el contraste resuelto
 * (apps/web/lib/branding/colors.ts). `accent` distinto de `primary` gana.
 */
export const DENSITIES = ['comfortable', 'compact'] as const;
export const HEADER_STYLES = ['plain', 'hero'] as const;
/**
 * `layout`: `dashboard` (por defecto) es la rejilla de siempre; `operator` es
 * la pantalla de planta, pensada para el celular: UNA columna, el formulario
 * primero, controles grandes, tablas como tarjetas con el estado a la vista,
 * métricas compactas en una fila y alto contraste.
 * `style`: la piel. `clean` es la de siempre; `bold` pone títulos más fuertes y
 * tarjetas con borde del acento; `dark-panel` es un panel oscuro tipo pantalla
 * de planta o TV (siempre oscuro, también en el enlace público claro).
 */
export const LAYOUTS = ['dashboard', 'operator', 'tv'] as const;
export const VIEW_STYLES = ['clean', 'bold', 'dark-panel'] as const;
/**
 * EL TABLERO TV (`layout: 'tv'`): pantalla completa para la planta. Texto
 * grande, alto contraste (siempre oscuro), reloj, y rota sola entre sus
 * secciones —las páginas de la vista; sin páginas, un bloque por vez— cada
 * `rotateSeconds`. Se refresca en vivo (como mucho cada 30 s). Pantalla
 * completa con un botón; no hay nada que escribir ahí.
 */
export const TV_ROTATE = { min: 5, max: 120, default: 15 } as const;
export const tvSchema = z.object({
  rotateSeconds: z.number().int().min(TV_ROTATE.min).max(TV_ROTATE.max).default(TV_ROTATE.default),
  clock: z.boolean().default(true),
});
export type ViewTv = z.infer<typeof tvSchema>;
export const viewThemeSchema = z.object({
  tv: tvSchema.optional(),
  accent: z.enum(TONES).optional(),
  density: z.enum(DENSITIES).optional(),
  header: z.enum(HEADER_STYLES).optional(),
  layout: z.enum(LAYOUTS).optional(),
  style: z.enum(VIEW_STYLES).optional(),
  cover: httpsField.optional(),
});
export type ViewTheme = z.infer<typeof viewThemeSchema>;

/**
 * EL RESUMEN PERIÓDICO (migración 0203 guarda lo último que se envió). Cada
 * día o cada semana, a `hour` (hora de Bogotá), Cortex manda por correo a los
 * `recipients` —ids de usuario, sólo miembros del espacio— las cifras de la
 * vista, las filas nuevas desde el último envío y las novedades. Opcional y
 * sin valor por defecto: los specs ya guardados no cambian.
 * `weekday`: 1 lunes … 7 domingo; sólo cuenta si la cadencia es semanal.
 */
export const digestSchema = z.object({
  cadence: z.enum(['daily', 'weekly']),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(1).max(7).optional(),
  recipients: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
});
export type ViewDigest = z.infer<typeof digestSchema>;

export const viewSpecSchema = z
  .object({
    version: z.literal(1),
    /** Una línea bajo el título de la vista. */
    subtitle: z.string().trim().max(300).optional(),
    accent: z.enum(TONES).default('primary'),
    blocks: z.array(blockSchema).min(1).max(MAX_VIEW_BLOCKS),
    refreshSeconds: z
      .union([z.literal(0), z.literal(10), z.literal(30), z.literal(60)])
      .default(30),
    /**
     * Quién puede editar y usar botones: nadie, el equipo (dentro de la app)
     * o también quien abre el enlace. Por defecto nadie: editar es una
     * decisión, no un efecto secundario de agregar una columna editable.
     */
    editing: z.enum(['off', 'team', 'public']).default('off'),
    alerts: z.array(viewAlertSchema).max(5).default([]),
    // Opcionales, sin valor por defecto: un spec guardado antes de que
    // existieran sigue siendo el mismo objeto y del mismo tipo.
    filtersBar: z.array(filterBarItemSchema).max(MAX_FILTER_BAR).optional(),
    pages: z.array(viewPageSchema).max(MAX_VIEW_PAGES).optional(),
    theme: viewThemeSchema.optional(),
    digest: digestSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const issue = (message: string, path: Array<string | number>) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const seen = new Set<string>();
    for (const [i, block] of spec.blocks.entries()) {
      if (seen.has(block.id))
        issue(`El id de bloque «${block.id}» está repetido.`, ['blocks', i, 'id']);
      seen.add(block.id);
      // Lo que cruza dos propiedades de un mismo bloque: la unión discriminada
      // no deja refinar cada objeto, así que se comprueba aquí, con su ruta.
      if (block.type === 'media' && block.kind === 'embed' && block.url && !embedSrc(block.url))
        issue(
          'Ese enlace no se puede insertar. Sirven YouTube, Google Maps («Insertar un mapa»), Loom y Google Slides o Docs publicados en la web.',
          ['blocks', i, 'url'],
        );
      if (block.type === 'progress' && !block.groupBy && block.target === undefined)
        issue('Una barra de avance sin agrupar necesita una meta (target).', [
          'blocks',
          i,
          'target',
        ]);
      if (block.type === 'cards') {
        if ((block.chips.includes('today') || block.chips.includes('week')) && !block.dateField)
          issue('Los chips «hoy» y «semana» necesitan un campo de fecha (dateField).', [
            'blocks',
            i,
            'dateField',
          ]);
        if (block.chips.includes('status') && !block.statusField)
          issue('El chip «status» necesita un campo de opciones (statusField).', [
            'blocks',
            i,
            'statusField',
          ]);
      }
      if (block.type === 'detail') {
        const ids = new Set<string>();
        for (const [j, r] of block.related.entries()) {
          if (ids.has(r.id))
            issue(`La lista relacionada «${r.id}» está repetida.`, [
              'blocks',
              i,
              'related',
              j,
              'id',
            ]);
          ids.add(r.id);
        }
      }
      if (block.type === 'metric' && block.goalDirection && !block.goal)
        issue('goalDirection necesita una meta (goal).', ['blocks', i, 'goal']);
      if (block.type === 'metric' && block.compare && !block.dateField)
        issue('Comparar con el período anterior necesita un campo de fecha (dateField).', [
          'blocks',
          i,
          'dateField',
        ]);
    }
    const pageIds = new Set<string>();
    for (const [i, page] of (spec.pages ?? []).entries()) {
      if (pageIds.has(page.id)) issue(`La página «${page.id}» está repetida.`, ['pages', i, 'id']);
      pageIds.add(page.id);
      for (const id of page.blockIds)
        if (!seen.has(id))
          issue(`La página «${page.title}» nombra el bloque «${id}», que no existe.`, [
            'pages',
            i,
            'blockIds',
          ]);
    }
    const barIds = new Set<string>();
    for (const [i, item] of (spec.filtersBar ?? []).entries()) {
      if (barIds.has(item.id))
        issue(`El filtro «${item.id}» está repetido.`, ['filtersBar', i, 'id']);
      barIds.add(item.id);
    }
  });
export type ViewSpec = z.infer<typeof viewSpecSchema>;
export type FormBlock = z.infer<typeof formBlockSchema>;

export const viewSlugSchema = z.string().trim().regex(VIEW_SLUG_RE);

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const withLetter = /^[a-z]/.test(base) ? base : `v_${base}`;
  return withLetter.length >= 2 ? withLetter : 'vista';
}

// ---------------------------------------------------------------------------
// El spec contra el catálogo real
// ---------------------------------------------------------------------------

export interface CatalogTracker {
  slug: string;
  name: string;
  fields: TrackerField[];
  /**
   * La marca de la regla de duplicados de la tabla (0201): una fila con este
   * valor en este campo se pinta en tono de alerta (tabla, tarjetas, galería).
   */
  alertFlag?: { field: string; value: string };
  /**
   * Una tabla del Feed que la vista YA usaba y que quien la edita no puede
   * leer (es del Feed privado de otra persona, o venció). Se acepta tal cual
   * para no dejar a un compañero sin poder cambiar el resto de la vista, pero
   * sin comprobar campos: comprobarlos exigiría leer una tabla que no es suya.
   * Las reglas de sólo lectura sí se comprueban.
   */
  opaque?: boolean;
}

/** Tipo de un campo, incluidos los tres que toda fila tiene. */
export function fieldType(
  tracker: CatalogTracker,
  key: string,
): TrackerField['type'] | 'builtin_text' | 'builtin_date' | null {
  if (key === 'label') return 'builtin_text';
  if (key === 'created_at' || key === 'updated_at') return 'builtin_date';
  return tracker.fields.find((f) => f.key === key)?.type ?? null;
}

const NUMERIC = new Set(['number', 'money']);

const readOnlyWhat = (ref: string) =>
  isFeedSourceId(ref) ? 'una tabla del Feed' : 'una fuente de la plataforma';

/** La ventana efectiva para corregir un envío de este formulario, en minutos. */
export function editWindowOf(block: Pick<FormBlock, 'editWindowMinutes'>): number {
  return block.editWindowMinutes ?? DEFAULT_EDIT_WINDOW_MINUTES;
}

/** El formulario con aprobación que alimenta una tabla, si hay uno. */
export function approvalFor(
  spec: Pick<ViewSpec, 'blocks'>,
  trackerSlug: string,
): { block: FormBlock; approval: FormApproval } | null {
  for (const b of spec.blocks)
    if (b.type === 'form' && b.tracker === trackerSlug && b.approval)
      return { block: b, approval: b.approval };
  return null;
}

/**
 * Lo propio de un formulario con aprobación y/o pasos: el campo de estado es
 * un select de la tabla que ofrece los tres estados, las notas son texto, y
 * los pasos sólo nombran campos que el formulario pide, una vez cada uno.
 */
export function checkFormExtras(
  block: FormBlock,
  tracker: CatalogTracker,
  problems: string[],
  where: string,
): void {
  if (tracker.opaque) return;
  const a = block.approval;
  if (a) {
    const f = tracker.fields.find((x) => x.key === a.field);
    if (!f || f.type !== 'select')
      problems.push(
        `${where}: la aprobación necesita un campo de opciones (select) de la tabla; «${a.field}» no lo es.`,
      );
    else {
      const missing = [a.pending, a.approved, a.rejected].filter(
        (o) => !(f.options ?? []).includes(o),
      );
      if (missing.length)
        problems.push(
          `${where}: el campo «${a.field}» no tiene la${missing.length > 1 ? 's' : ''} opci${missing.length > 1 ? 'ones' : 'ón'} ${missing.map((m) => `«${m}»`).join(', ')}. Opciones: ${(f.options ?? []).join(', ')}.`,
        );
      if (new Set([a.pending, a.approved, a.rejected]).size < 3)
        problems.push(`${where}: pending, approved y rejected deben ser tres opciones distintas.`);
    }
    if (a.notesField) {
      const n = tracker.fields.find((x) => x.key === a.notesField);
      if (!n || (n.type !== 'text' && n.type !== 'longtext'))
        problems.push(
          `${where}: las notas de la aprobación van en un campo de texto; «${a.notesField}» no lo es.`,
        );
    }
  }
  if (block.steps) {
    const asked = block.fields.length ? block.fields : tracker.fields.map((f) => f.key);
    const seen = new Set<string>();
    for (const [i, step] of block.steps.entries()) {
      for (const k of step.fields) {
        if (!asked.includes(k))
          problems.push(`${where}: el paso ${i + 1} nombra «${k}», que el formulario no pide.`);
        else if (seen.has(k)) problems.push(`${where}: «${k}» está en dos pasos.`);
        seen.add(k);
      }
    }
  }
}

/**
 * Qué del spec nombra cosas que no existen. Devuelve una lista de problemas en
 * español, vacía si todo cuadra. Es lo que el diseñador le devuelve al modelo
 * para que corrija, y lo que las herramientas usan para rechazar un guardado.
 */
export function checkSpecAgainst(spec: ViewSpec, catalog: CatalogTracker[]): string[] {
  const problems: string[] = [];
  const bySlug = new Map(catalog.map((t) => [t.slug, t]));
  for (const block of spec.blocks) {
    if (block.type === 'voice') {
      const target = spec.blocks.find((b) => b.id === block.form);
      if (!target || target.type !== 'form')
        problems.push(
          `Bloque «${block.id}»: el asistente de voz maneja un formulario de esta vista; «${block.form}» no es un bloque form.`,
        );
      continue;
    }
    if (!('tracker' in block)) continue;
    const where = `Bloque «${block.id}»`;
    const tracker = bySlug.get(block.tracker);
    if (!tracker) {
      problems.push(
        isPlatformSourceId(block.tracker)
          ? `${where}: «${block.tracker}» no es una fuente de la plataforma.`
          : isFeedSourceId(block.tracker)
            ? `${where}: la tabla del Feed «${block.tracker}» no está disponible: venció, se borró o es del Feed privado de otra persona.`
            : `${where}: la tabla «${block.tracker}» no existe.`,
      );
      continue;
    }
    const need = (key: string, what: string) => {
      if (tracker.opaque) return true;
      if (!fieldType(tracker, key)) {
        problems.push(
          `${where}: «${key}» no es un campo de ${tracker.name} (${what}). Campos: label, ${tracker.fields.map((f) => f.key).join(', ')}.`,
        );
        return false;
      }
      return true;
    };
    /** Lo que escribe: columnas editables, campos de la ficha y botones que cambian un campo. */
    const checkWrites = (editable: string[], actions: RowAction[]) => {
      const writes = editable.length > 0 || actions.length > 0;
      if (!writes) return;
      if (isReadOnlySource(block.tracker)) {
        problems.push(
          `${where}: «${tracker.name}» es ${readOnlyWhat(block.tracker)} y es de sólo lectura; sólo las tablas propias se editan o llevan botones en una vista.`,
        );
        return;
      }
      for (const key of editable) {
        if (key === 'label' || key === 'created_at' || key === 'updated_at')
          problems.push(`${where}: «${key}» no se edita; edita los campos de la tabla.`);
        else need(key, 'editable');
      }
      for (const a of actions) {
        for (const k of a.requireFields ?? []) need(k, `requisito del botón «${a.label}»`);
        if (a.kind === 'assign') {
          if (a.field) need(a.field, `quién, botón «${a.label}»`);
          if (a.nameField) need(a.nameField, `nombre, botón «${a.label}»`);
          if (a.statusField) {
            if (need(a.statusField, `estado, botón «${a.label}»`)) {
              const sf = tracker.fields.find((f) => f.key === a.statusField);
              if (
                sf?.type === 'select' &&
                a.value !== undefined &&
                !sf.options?.includes(String(a.value))
              )
                problems.push(
                  `${where}: el botón «${a.label}» pone «${a.value}», que no es una opción de ${sf.label} (${sf.options?.join(', ')}).`,
                );
            }
          }
          continue;
        }
        if (a.kind !== 'set_field' || !a.field) continue;
        if (!need(a.field, `botón «${a.label}»`)) continue;
        const field = tracker.fields.find((f) => f.key === a.field);
        if (field?.type === 'select' && !field.options?.includes(String(a.value)))
          problems.push(
            `${where}: el botón «${a.label}» pone «${a.value}», que no es una opción de ${field.label} (${field.options?.join(', ')}).`,
          );
      }
    };
    if ('filters' in block) {
      for (const f of block.filters) need(f.field, 'filtro');
    }
    const recordEditable = 'recordEditable' in block ? (block.recordEditable ?? []) : [];
    if ('detailFields' in block) for (const k of block.detailFields ?? []) need(k, 'ficha');
    /** Un campo que tiene que ser de cierto tipo (fecha, opciones…). */
    const needType = (key: string, what: string, ok: (t: string) => boolean, wanted: string) => {
      if (!need(key, what) || tracker.opaque) return;
      if (!ok(String(fieldType(tracker, key))))
        problems.push(`${where}: «${key}» no es ${wanted} (${what}).`);
    };
    const isDate = (t: string) => t === 'date' || t === 'builtin_date';
    const isSelect = (t: string) => t === 'select';
    switch (block.type) {
      case 'progress':
        if (block.aggregate !== 'count') {
          if (!block.field)
            problems.push(`${where}: «${block.aggregate}» necesita un campo numérico.`);
          else needType(block.field, 'cifra', (t) => NUMERIC.has(t), 'un campo de número o dinero');
        }
        if (block.groupBy) need(block.groupBy, 'agrupar');
        break;
      case 'gallery':
        need(block.titleField, 'título de la tarjeta');
        if (block.subtitleField) need(block.subtitleField, 'subtítulo');
        for (const k of block.metaFields) need(k, 'dato de la tarjeta');
        if (block.badgeField)
          needType(block.badgeField, 'etiqueta', isSelect, 'un campo de opciones');
        if (block.imageField)
          needType(
            block.imageField,
            'imagen',
            (t) => t === 'text',
            'un campo de texto con la dirección de la imagen',
          );
        if (block.sort) need(block.sort.field, 'orden');
        checkWrites(recordEditable, block.actions);
        break;
      case 'calendar':
        needType(block.dateField, 'fecha del evento', isDate, 'un campo de fecha');
        need(block.labelField, 'nombre del evento');
        if (block.colorField) needType(block.colorField, 'color', isSelect, 'un campo de opciones');
        if (block.timeField)
          needType(block.timeField, 'hora del evento', (t) => t === 'time', 'un campo de hora');
        checkWrites(recordEditable, block.actions);
        break;
      case 'cards':
        need(block.titleField, 'título de la tarjeta');
        if (block.subtitleField) need(block.subtitleField, 'subtítulo');
        for (const k of block.dataFields) need(k, 'dato de la tarjeta');
        if (block.statusField)
          needType(block.statusField, 'estado', isSelect, 'un campo de opciones');
        if (block.imageField)
          needType(
            block.imageField,
            'imagen',
            (t) => t === 'text' || t === 'file',
            'un campo de texto con la dirección de la imagen o de fotos',
          );
        if (block.dateField)
          needType(block.dateField, 'fecha para hoy / semana', isDate, 'un campo de fecha');
        if (block.groupBy) need(block.groupBy, 'agrupar');
        if (block.sort) need(block.sort.field, 'orden');
        for (const k of block.sortOptions) need(k, 'orden elegible');
        checkWrites(recordEditable, block.actions);
        break;
      case 'map': {
        needType(
          block.locationField,
          'ubicación del registro',
          (t) => t === 'location',
          'un campo de tipo ubicación',
        );
        need(block.titleField, 'título del marcador');
        if (block.subtitleField) need(block.subtitleField, 'subtítulo');
        if (block.colorField)
          needType(block.colorField, 'color por estado', isSelect, 'un campo de opciones');
        const a = block.assign;
        if (a) {
          if (isReadOnlySource(block.tracker)) {
            problems.push(
              `${where}: asignar tareas escribe filas; «${tracker.name}» es de sólo lectura. Usa una tabla propia.`,
            );
            break;
          }
          need(a.assigneeField, 'quién tiene la tarea');
          need(a.titleField, 'título de la tarea');
          if (a.nameField) need(a.nameField, 'nombre de quien tiene la tarea');
          if (a.descriptionField) need(a.descriptionField, 'descripción de la tarea');
          if (a.dueField) needType(a.dueField, 'fecha límite', isDate, 'un campo de fecha');
          if (a.dueTimeField)
            needType(a.dueTimeField, 'hora límite', (t) => t === 'time', 'un campo de hora');
          if (a.priorityField)
            needType(a.priorityField, 'prioridad', isSelect, 'un campo de opciones');
          if (a.statusField) {
            needType(a.statusField, 'estado', isSelect, 'un campo de opciones');
            const sf = tracker.fields.find((f) => f.key === a.statusField);
            if (a.pendingValue && sf && !sf.options?.includes(a.pendingValue))
              problems.push(
                `${where}: «${a.pendingValue}» no es una opción de ${sf.label} (${sf.options?.join(', ')}).`,
              );
          }
        }
        checkWrites(recordEditable, block.actions);
        break;
      }
      case 'detail': {
        need(block.titleField, 'título del detalle');
        if (block.subtitleField) need(block.subtitleField, 'subtítulo');
        if (block.statusField)
          needType(block.statusField, 'estado', isSelect, 'un campo de opciones');
        for (const sec of block.sections)
          for (const k of sec.fields) need(k, `sección «${sec.title}»`);
        for (const k of block.gallery)
          needType(k, 'galería', (t) => t === 'file', 'un campo de archivos o fotos');
        checkWrites(recordEditable, block.actions);
        for (const rel of block.related) {
          const rw = `${where}, relacionados «${rel.title}»`;
          const other = bySlug.get(rel.tracker);
          if (!other) {
            problems.push(`${rw}: la tabla «${rel.tracker}» no existe.`);
            continue;
          }
          if (other.opaque) continue;
          const check = (key: string, what: string, t = other) => {
            if (!fieldType(t, key)) {
              problems.push(
                `${rw}: «${key}» no es un campo de ${t.name} (${what}). Campos: label, ${t.fields.map((f) => f.key).join(', ')}.`,
              );
              return false;
            }
            return true;
          };
          if (check(rel.field, 'cómo se relaciona') && rel.match === 'relation') {
            const f = other.fields.find((x) => x.key === rel.field);
            if (f?.type !== 'relation' || f.tracker !== block.tracker)
              problems.push(
                `${rw}: «${rel.field}» tiene que ser un campo relación hacia ${tracker.name} (o usa match «value» con parentField para ligar por un valor común).`,
              );
          }
          if (rel.match === 'value' && rel.parentField) need(rel.parentField, 'valor común');
          for (const c of rel.columns) check(c, 'columna');
          if (rel.sort) check(rel.sort.field, 'orden');
          if (rel.actions.length) {
            if (isReadOnlySource(rel.tracker))
              problems.push(
                `${rw}: «${other.name}» es de sólo lectura; los botones sólo van en tablas propias.`,
              );
            else
              for (const a of rel.actions) {
                if (a.kind !== 'set_field' || !a.field) continue;
                if (!check(a.field, `botón «${a.label}»`)) continue;
                const field = other.fields.find((f) => f.key === a.field);
                if (field?.type === 'select' && !field.options?.includes(String(a.value)))
                  problems.push(
                    `${rw}: el botón «${a.label}» pone «${a.value}», que no es una opción de ${field.label} (${field.options?.join(', ')}).`,
                  );
              }
          }
        }
        break;
      }
      case 'metric':
      case 'chart': {
        if (block.aggregate !== 'count') {
          if (!block.field)
            problems.push(`${where}: «${block.aggregate}» necesita un campo numérico.`);
          else if (
            need(block.field, 'cifra') &&
            !tracker.opaque &&
            !NUMERIC.has(String(fieldType(tracker, block.field)))
          )
            problems.push(
              `${where}: «${block.field}» no es numérico; usa count o un campo de número o dinero.`,
            );
        }
        if (block.type === 'chart') {
          need(block.groupBy, 'agrupar');
          if (block.chart === 'funnel')
            needType(block.groupBy, 'etapas del embudo', isSelect, 'un campo de opciones');
          if (block.chart === 'heatmap') {
            needType(block.groupBy, 'día del mapa de calor', isDate, 'un campo de fecha');
            if (block.hourField)
              needType(
                block.hourField,
                'hora del mapa de calor',
                (t) => t === 'time',
                'un campo de hora',
              );
          }
        }
        if (block.type === 'metric' && block.compare && block.dateField)
          needType(block.dateField, 'período', isDate, 'un campo de fecha');
        break;
      }
      case 'table':
        for (const c of block.columns) need(c, 'columna');
        if (block.sort) need(block.sort.field, 'orden');
        checkWrites([...block.editable, ...recordEditable], block.actions);
        break;
      case 'board': {
        if (
          need(block.groupBy, 'columnas del tablero') &&
          !tracker.opaque &&
          fieldType(tracker, block.groupBy) !== 'select'
        )
          problems.push(
            `${where}: el tablero agrupa por un campo de opciones; «${block.groupBy}» no lo es.`,
          );
        for (const c of block.cardFields) need(c, 'tarjeta');
        checkWrites(
          [...(block.draggable ? [block.groupBy] : []), ...recordEditable],
          block.actions,
        );
        break;
      }
      case 'zones': {
        if (
          need(block.groupBy, 'zonas del plano') &&
          !tracker.opaque &&
          fieldType(tracker, block.groupBy) !== 'select'
        )
          problems.push(
            `${where}: el plano reparte por un campo de opciones; «${block.groupBy}» no lo es.`,
          );
        const options = tracker.fields.find((f) => f.key === block.groupBy)?.options ?? [];
        for (const z of block.layout)
          if (!tracker.opaque && options.length && !options.includes(z.zone))
            problems.push(
              `${where}: «${z.zone}» no es una opción de ${block.groupBy} (${options.join(', ')}).`,
            );
          else if (z.x + z.w > 12)
            problems.push(`${where}: la zona «${z.zone}» se sale del plano (x + w > 12).`);
        for (const c of block.cardFields) need(c, 'ficha');
        checkWrites(
          [...(block.draggable ? [block.groupBy] : []), ...recordEditable],
          block.actions,
        );
        break;
      }
      case 'form':
        if (isReadOnlySource(block.tracker)) {
          problems.push(
            `${where}: un formulario sólo agrega filas a una tabla propia del espacio; «${tracker.name}» es ${readOnlyWhat(block.tracker)} y es de sólo lectura. Crea una tabla para lo que el formulario recibe.`,
          );
          break;
        }
        for (const c of block.fields) {
          if (c === 'label' || c === 'created_at' || c === 'updated_at')
            problems.push(`${where}: el formulario sólo pide campos de la tabla, no «${c}».`);
          else need(c, 'formulario');
        }
        checkFormExtras(block, tracker, problems, where);
        break;
    }
  }
  for (const alert of spec.alerts) {
    const tracker = bySlug.get(alert.source);
    if (!tracker) {
      problems.push(`Alerta «${alert.id}»: «${alert.source}» no existe.`);
      continue;
    }
    if (tracker.opaque) continue;
    for (const f of alert.filters)
      if (!fieldType(tracker, f.field))
        problems.push(`Alerta «${alert.id}»: «${f.field}» no es un campo de ${tracker.name}.`);
  }
  const used = new Set(spec.blocks.flatMap((b) => ('tracker' in b ? [b.tracker] : [])));
  for (const item of spec.filtersBar ?? []) {
    const where = `Filtro «${item.id}»`;
    const tracker = bySlug.get(item.source);
    if (!tracker) {
      problems.push(`${where}: «${item.source}» no existe.`);
      continue;
    }
    if (!used.has(item.source))
      problems.push(
        `${where}: ningún bloque lee «${tracker.name}»; el filtro no tendría qué filtrar.`,
      );
    if (tracker.opaque) continue;
    const t = fieldType(tracker, item.field);
    if (!t) {
      problems.push(`${where}: «${item.field}» no es un campo de ${tracker.name}.`);
      continue;
    }
    if (item.kind === 'date_range' && t !== 'date' && t !== 'builtin_date')
      problems.push(
        `${where}: un rango de fechas necesita un campo de fecha; «${item.field}» no lo es.`,
      );
    if (item.kind === 'select' && (t === 'date' || t === 'builtin_date'))
      problems.push(`${where}: para una fecha usa un rango (date_range), no un menú.`);
  }
  if (specWrites(spec) && spec.editing === 'off')
    problems.push(
      'La vista tiene columnas editables, tableros que se arrastran o botones, pero `editing` está en "off": ponlo en "team" o "public" para que funcionen.',
    );
  return problems;
}

/**
 * ¿El spec pide escribir? Celdas editables, campos editables en la ficha,
 * tableros o planos que se arrastran, y botones por fila. Si sí, `editing` no
 * puede quedar en `off`.
 */
export function specWrites(spec: Pick<ViewSpec, 'blocks'>): boolean {
  return spec.blocks.some((b) => {
    if ('recordEditable' in b && (b.recordEditable?.length ?? 0) > 0) return true;
    // Aprobar / Rechazar escribe en la tabla: la vista tiene que dejar escribir.
    if (b.type === 'form' && b.approval) return true;
    if ('actions' in b && b.actions.length > 0) return true;
    // Asignar una tarea desde el mapa crea una fila.
    if (b.type === 'map' && b.assign) return true;
    if (b.type === 'detail' && b.related.some((r) => r.actions.length > 0)) return true;
    if (b.type === 'table') return b.editable.length > 0;
    if (b.type === 'board' || b.type === 'zones') return b.draggable;
    return false;
  });
}

/** La fuente que un bloque lee, o null (texto, imagen, enlaces). */
export function blockSource(block: ViewBlock): string | null {
  return 'tracker' in block ? block.tracker : null;
}

/** Las tablas y fuentes que una vista lee, sin repetir. */
export function trackersOf(spec: ViewSpec): string[] {
  return [
    ...new Set([
      ...spec.blocks.flatMap((b) => ('tracker' in b ? [b.tracker] : [])),
      // Las listas relacionadas de un detalle también se leen (y llevan scope).
      ...spec.blocks.flatMap((b) => (b.type === 'detail' ? b.related.map((r) => r.tracker) : [])),
      ...spec.alerts.map((a) => a.source),
    ]),
  ];
}

export const BLOCK_LABEL: Record<ViewBlockType, string> = {
  text: 'Texto',
  metric: 'Cifra',
  table: 'Tabla',
  chart: 'Gráfico',
  board: 'Tablero',
  zones: 'Plano',
  form: 'Formulario',
  gallery: 'Galería',
  calendar: 'Calendario',
  detail: 'Detalle de un registro',
  cards: 'Tarjetas con filtros',
  map: 'Mapa',
  progress: 'Avance',
  media: 'Imagen o video',
  links: 'Botones',
  voice: 'Asistente de voz',
};

/**
 * El bloque sobre el que se escribe, dado el id que manda el navegador. Casi
 * siempre es un bloque de la vista. Una lista relacionada de un detalle se
 * nombra `<detalle>:<lista>` y se escribe como una tabla propia con sus botones
 * (la misma lista blanca y las mismas reglas que cualquier otra), pero los
 * eventos quedan a nombre del detalle.
 */
export function findWriteBlock(
  spec: Pick<ViewSpec, 'blocks'>,
  blockId: string,
): ViewBlock | undefined {
  const [head, tail] = blockId.split(':');
  const block = spec.blocks.find((b) => b.id === head);
  if (!tail) return block;
  if (!block || block.type !== 'detail') return undefined;
  const rel = block.related.find((r) => r.id === tail);
  if (!rel) return undefined;
  return {
    id: block.id,
    type: 'table',
    width: 'full',
    tracker: rel.tracker,
    filters: [],
    title: rel.title,
    columns: rel.columns,
    limit: rel.limit,
    searchable: false,
    editable: [],
    actions: rel.actions,
  };
}
