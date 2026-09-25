import { z } from 'zod';
import { TRACKER_SLUG_RE, type TrackerField } from '../trackers/schema';

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

const sourceRef = z
  .string()
  .refine(
    (v) => TRACKER_SLUG_RE.test(v) || PLATFORM_SOURCE_RE.test(v),
    'Usa el slug de una tabla del espacio o el id de una fuente de la plataforma (cortex.…).',
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
  tone: z.enum(TONES).default('primary'),
  caption: z.string().trim().max(200).optional(),
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
    kind: z.enum(['set_field', 'notify']),
    field: fieldRef.optional(),
    value: z.union([z.string().max(200), z.number()]).optional(),
    confirm: z.boolean().default(false),
    tone: z.enum(TONES).default('primary'),
  })
  .superRefine((a, ctx) => {
    if (a.kind === 'set_field' && (!a.field || a.value === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El botón «${a.label}» cambia un campo: necesita field y value.`,
        path: ['field'],
      });
  });
export type RowAction = z.infer<typeof rowActionSchema>;

export const tableBlockSchema = z.object({
  ...base,
  ...source,
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

export const chartBlockSchema = z.object({
  ...base,
  ...source,
  type: z.literal('chart'),
  title,
  chart: z.enum(['bar', 'line', 'donut']).default('bar'),
  /** Campo por el que se agrupa; las fechas se agrupan por `bucket`. */
  groupBy: fieldRef,
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
});

export const blockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  metricBlockSchema,
  tableBlockSchema,
  chartBlockSchema,
  boardBlockSchema,
  formBlockSchema,
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
  message: z.string().trim().max(120).optional(),
  sound: z.boolean().default(true),
  desktop: z.boolean().default(false),
  bell: z.boolean().default(false),
});
export type ViewAlert = z.infer<typeof viewAlertSchema>;

/** Cada cuánto se refresca sola una vista abierta. 0 = nunca. */
export const REFRESH_CHOICES = [0, 10, 30, 60] as const;

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
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const [i, block] of spec.blocks.entries()) {
      if (seen.has(block.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El id de bloque «${block.id}» está repetido.`,
          path: ['blocks', i, 'id'],
        });
      }
      seen.add(block.id);
    }
  });
export type ViewSpec = z.infer<typeof viewSpecSchema>;

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

/**
 * Qué del spec nombra cosas que no existen. Devuelve una lista de problemas en
 * español, vacía si todo cuadra. Es lo que el diseñador le devuelve al modelo
 * para que corrija, y lo que las herramientas usan para rechazar un guardado.
 */
export function checkSpecAgainst(spec: ViewSpec, catalog: CatalogTracker[]): string[] {
  const problems: string[] = [];
  const bySlug = new Map(catalog.map((t) => [t.slug, t]));
  for (const block of spec.blocks) {
    if (block.type === 'text') continue;
    const where = `Bloque «${block.id}»`;
    const tracker = bySlug.get(block.tracker);
    if (!tracker) {
      problems.push(
        isPlatformSourceId(block.tracker)
          ? `${where}: «${block.tracker}» no es una fuente de la plataforma.`
          : `${where}: la tabla «${block.tracker}» no existe.`,
      );
      continue;
    }
    const need = (key: string, what: string) => {
      if (!fieldType(tracker, key)) {
        problems.push(
          `${where}: «${key}» no es un campo de ${tracker.name} (${what}). Campos: label, ${tracker.fields.map((f) => f.key).join(', ')}.`,
        );
        return false;
      }
      return true;
    };
    /** Lo que escribe: columnas editables y botones que cambian un campo. */
    const checkWrites = (editable: string[], actions: RowAction[]) => {
      const writes = editable.length > 0 || actions.length > 0;
      if (!writes) return;
      if (isPlatformSourceId(block.tracker)) {
        problems.push(
          `${where}: «${tracker.name}» es una fuente de la plataforma y es de sólo lectura; sólo las tablas propias se editan o llevan botones en una vista.`,
        );
        return;
      }
      for (const key of editable) {
        if (key === 'label' || key === 'created_at' || key === 'updated_at')
          problems.push(`${where}: «${key}» no se edita; edita los campos de la tabla.`);
        else need(key, 'editable');
      }
      for (const a of actions) {
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
    switch (block.type) {
      case 'metric':
      case 'chart': {
        if (block.aggregate !== 'count') {
          if (!block.field)
            problems.push(`${where}: «${block.aggregate}» necesita un campo numérico.`);
          else if (
            need(block.field, 'cifra') &&
            !NUMERIC.has(String(fieldType(tracker, block.field)))
          )
            problems.push(
              `${where}: «${block.field}» no es numérico; usa count o un campo de número o dinero.`,
            );
        }
        if (block.type === 'chart') need(block.groupBy, 'agrupar');
        break;
      }
      case 'table':
        for (const c of block.columns) need(c, 'columna');
        if (block.sort) need(block.sort.field, 'orden');
        checkWrites(block.editable, block.actions);
        break;
      case 'board': {
        if (
          need(block.groupBy, 'columnas del tablero') &&
          fieldType(tracker, block.groupBy) !== 'select'
        )
          problems.push(
            `${where}: el tablero agrupa por un campo de opciones; «${block.groupBy}» no lo es.`,
          );
        for (const c of block.cardFields) need(c, 'tarjeta');
        checkWrites(block.draggable ? [block.groupBy] : [], block.actions);
        break;
      }
      case 'form':
        if (isPlatformSourceId(block.tracker)) {
          problems.push(
            `${where}: un formulario sólo agrega filas a una tabla propia del espacio; «${tracker.name}» es una fuente de la plataforma y es de sólo lectura. Crea una tabla para lo que el formulario recibe.`,
          );
          break;
        }
        for (const c of block.fields) {
          if (c === 'label' || c === 'created_at' || c === 'updated_at')
            problems.push(`${where}: el formulario sólo pide campos de la tabla, no «${c}».`);
          else need(c, 'formulario');
        }
        break;
    }
  }
  for (const alert of spec.alerts) {
    const tracker = bySlug.get(alert.source);
    if (!tracker) {
      problems.push(`Alerta «${alert.id}»: «${alert.source}» no existe.`);
      continue;
    }
    for (const f of alert.filters)
      if (!fieldType(tracker, f.field))
        problems.push(`Alerta «${alert.id}»: «${f.field}» no es un campo de ${tracker.name}.`);
  }
  const writes = spec.blocks.some(
    (b) =>
      (b.type === 'table' && (b.editable.length > 0 || b.actions.length > 0)) ||
      (b.type === 'board' && (b.draggable || b.actions.length > 0)),
  );
  if (writes && spec.editing === 'off')
    problems.push(
      'La vista tiene columnas editables, tableros que se arrastran o botones, pero `editing` está en "off": ponlo en "team" o "public" para que funcionen.',
    );
  return problems;
}

/** Las tablas y fuentes que una vista lee, sin repetir. */
export function trackersOf(spec: ViewSpec): string[] {
  return [
    ...new Set([
      ...spec.blocks.flatMap((b) => (b.type === 'text' ? [] : [b.tracker])),
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
  form: 'Formulario',
};
