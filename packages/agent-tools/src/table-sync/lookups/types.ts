import { z } from 'zod';
import { FIELD_KEY_RE } from '../../trackers/schema';

/**
 * LA FORMA DE UNA CONSULTA POR FILA (migración 0198).
 *
 * El filtro habla el mismo idioma que las vistas de la grilla (`GridFilter` en
 * apps/web/components/datagrid/types.ts): `{ key, op, value }` y un `match`
 * «todos» / «alguno». Aquí se redeclara porque el paquete no puede importar
 * de la app; `GRID_FILTER_OPS` es la misma lista y la prueba la compara.
 */

export const GRID_FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'empty',
  'not_empty',
  'before',
  'after',
  'last_days',
  'next_days',
] as const;
export type LookupFilterOp = (typeof GRID_FILTER_OPS)[number];

export const lookupFilterSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  filters: z
    .array(
      z.object({
        key: z.string().regex(FIELD_KEY_RE),
        op: z.enum(GRID_FILTER_OPS),
        value: z
          .union([
            z.string().max(200),
            z.number(),
            z.boolean(),
            z.array(z.union([z.string().max(200), z.number()])).max(30),
          ])
          .optional(),
      }),
    )
    .max(10),
});
export type LookupFilter = z.infer<typeof lookupFilterSchema>;
export type LookupFilterInput = z.input<typeof lookupFilterSchema>;

/** De la respuesta de la API a una columna de la tabla. */
export const lookupMappingEntrySchema = z.object({
  /** Camino con puntos en la respuesta: «arrival.estimated», «data.0.status». */
  path: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (v) => !v.split(/[.[\]]/).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)),
    ),
  /** Clave de la columna de la tabla donde se escribe. */
  field: z.string().regex(FIELD_KEY_RE),
  /** «landed» → «aterrizado»: cómo se llama en la tabla lo que dice la API. */
  translate: z.record(z.string().max(80), z.string().max(80)).optional(),
});
export type LookupMappingEntry = z.infer<typeof lookupMappingEntrySchema>;

export const lookupMappingSchema = z.array(lookupMappingEntrySchema).min(1).max(10);

/**
 * La regla «cerca de»: la consulta se acelera cuando falta poco para una hora
 * (o ya pasó hace poco). `outside`: qué hacer con las filas fuera de la
 * ventana: `base` las consulta al intervalo base; `skip` no las consulta.
 */
export const lookupNearSchema = z.object({
  /** Campo (fecha u hora) de la fila. */
  field: z.string().regex(FIELD_KEY_RE),
  beforeMinutes: z.number().int().min(0).max(1440).default(120),
  afterMinutes: z.number().int().min(0).max(1440).default(60),
  everyMinutes: z.number().int().min(5).max(1440).default(5),
  outside: z.enum(['base', 'skip']).default('base'),
});
export type LookupNear = z.infer<typeof lookupNearSchema>;
export type LookupNearInput = z.input<typeof lookupNearSchema>;

export type LookupStatus = 'ok' | 'error' | 'capped';

/** Una fila de `row_lookups`, como la devuelve Postgres. */
export interface RowLookupRow {
  id: string;
  organization_id?: string;
  tracker_id: string;
  name: string;
  url_template: string;
  credential_tool_id: string | null;
  /** El nombre de la credencial al crear: avisa si la herramienta se borró. */
  credential_name: string | null;
  mapping: LookupMappingEntry[];
  filter: LookupFilter;
  base_interval_minutes: number;
  near: LookupNear | null;
  daily_cap: number;
  per_run_cap: number;
  enabled: boolean;
  created_by: string;
  next_run_at: string;
  last_run_at: string | null;
  last_status: LookupStatus | null;
  last_error: string | null;
  last_calls: number;
  last_updated: number;
  calls_today: number;
  calls_day: string | null;
}

export const LOOKUP_COLUMNS =
  'id, tracker_id, name, url_template, credential_tool_id, credential_name, mapping, filter, base_interval_minutes, near, daily_cap, per_run_cap, enabled, created_by, next_run_at, last_run_at, last_status, last_error, last_calls, last_updated, calls_today, calls_day';

export interface LookupStateRow {
  lookup_id: string;
  row_id: string;
  next_at: string;
  last_at: string | null;
  last_status: 'ok' | 'error' | 'no_data' | null;
  last_error: string | null;
  fail_count: number;
}

export const DEFAULT_DAILY_CAP = 1000;
export const DEFAULT_PER_RUN_CAP = 100;
