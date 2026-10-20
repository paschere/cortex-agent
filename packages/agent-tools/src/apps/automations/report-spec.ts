import { z } from 'zod';
import { filterSchema } from '../../views/spec';
import { roleKeySchema } from '../permissions';
import { RANGE_PRESETS } from './report-range';

/**
 * LA FORMA DE UN REPORTE QUE SALE SOLO (acción `report` de las automatizaciones).
 *
 * Módulo puro. Dos fuentes:
 *   - `query`: una consulta agregada sobre UNA tabla (agrupa por un campo,
 *     suma/cuenta/promedia otros, con filtros y un rango de fechas relativo:
 *     «la semana pasada», «el mes pasado»…).
 *   - `screen`: una pantalla de la app tal cual está (sus cifras, tablas y
 *     gráficos), la misma que baja «Exportar».
 * y el reporte sale por correo (tabla en el cuerpo) con Excel y/o PDF adjuntos.
 */

const slug = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, 'Un identificador en minúsculas, sin espacios.');
const fieldKey = z.string().trim().min(1).max(32);
const emailSchema = z.string().trim().toLowerCase().email().max(200);

export const REPORT_OPS = ['sum', 'count', 'avg', 'min', 'max'] as const;
export type ReportOp = (typeof REPORT_OPS)[number];
export const REPORT_OP_LABEL: Record<ReportOp, string> = {
  sum: 'Suma',
  count: 'Conteo',
  avg: 'Promedio',
  min: 'Mínimo',
  max: 'Máximo',
};

export const REPORT_FORMATS = ['xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const REPORT_FORMAT_LABEL: Record<ReportFormat, string> = { xlsx: 'Excel', pdf: 'PDF' };

/** Topes de envío (decididos para que un reporte mal armado no inunde a nadie). */
export const REPORT_MAX_RECIPIENTS = 25;
export const REPORT_MAX_GROUPS = 200;
export const REPORT_DETAIL_ROWS = 500;
export const REPORT_MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
/** Cuántos envíos por día de UNA regla que NO es de horario (las de horario ya salen una vez por franja). */
export const REPORT_DEFAULT_PER_DAY = 3;
export const REPORT_MAX_PER_DAY = 20;

export const reportMetricSchema = z.object({
  op: z.enum(REPORT_OPS),
  /** Campo number/money; el conteo no lo necesita. */
  field: fieldKey.optional(),
  /** Título de la columna; por defecto «Suma de costo». */
  label: z.string().trim().min(1).max(60).optional(),
});
export type ReportMetric = z.infer<typeof reportMetricSchema>;

export const reportRangeSchema = z.object({
  /** Campo de fecha de la tabla, o `created_at` / `updated_at`. */
  field: fieldKey,
  preset: z.enum(RANGE_PRESETS),
});

export const reportQuerySourceSchema = z.object({
  kind: z.literal('query'),
  tracker: slug,
  /** Agrupar por este campo; vacío = una sola fila con el total. */
  groupBy: fieldKey.optional(),
  metrics: z.array(reportMetricSchema).min(1).max(4).default([{ op: 'count' }]),
  where: z.array(filterSchema).max(6).default([]),
  range: reportRangeSchema.optional(),
  /** desc/asc = por la primera cifra; label = alfabético por el grupo. */
  sort: z.enum(['desc', 'asc', 'label']).default('desc'),
  limit: z.number().int().min(1).max(REPORT_MAX_GROUPS).default(50),
  /** Además del resumen, una segunda tabla con las filas que lo componen (sólo en los adjuntos). */
  detail: z.boolean().default(false),
});
export type ReportQuerySource = z.infer<typeof reportQuerySourceSchema>;

export const reportScreenSourceSchema = z.object({
  kind: z.literal('screen'),
  /** Pantalla (slug) de la app. */
  screen: slug,
});

export const reportSourceSchema = z.discriminatedUnion('kind', [
  reportQuerySourceSchema,
  reportScreenSourceSchema,
]);
export type ReportSource = z.infer<typeof reportSourceSchema>;

/** El cuerpo de la acción `report` (sin `type` ni ramas, que pone el spec de automatizaciones). */
export const reportBodySchema = {
  title: z.string().trim().min(1).max(120),
  source: reportSourceSchema,
  to: z.array(emailSchema).max(REPORT_MAX_RECIPIENTS).default([]),
  /** Usuarios de la app con estos roles. */
  roles: z.array(roleKeySchema).max(8).default([]),
  /** Adjuntos; vacío = sólo la tabla en el cuerpo del correo. */
  formats: z.array(z.enum(REPORT_FORMATS)).max(2).default(['xlsx']),
  subject: z.string().trim().min(1).max(160).optional(),
  /** Una frase de contexto sobre la tabla; admite {{plantillas}}. */
  intro: z.string().trim().min(1).max(600).optional(),
  /** Tope de envíos por día de esta regla (aplica a las que no son de horario). */
  maxPerDay: z.number().int().min(1).max(REPORT_MAX_PER_DAY).optional(),
  /** Si no hay filas en el rango, no manda nada (por defecto sí manda: «sin movimiento» también es un dato). */
  skipIfEmpty: z.boolean().optional(),
};
