import { z } from 'zod';
import { registerTool } from '../../index';
import { trackerSlugSchema } from '../../trackers/schema';
import {
  type LookupStatusInfo,
  createRowLookup,
  findRowLookup,
  listRowLookups,
  rowLookupStatus,
  trackerBySlug,
  updateRowLookup,
} from './store';
import {
  DEFAULT_DAILY_CAP,
  DEFAULT_PER_RUN_CAP,
  type RowLookupRow,
  lookupFilterSchema,
  lookupNearSchema,
} from './types';

/**
 * CONSULTA POR FILA, DESDE EL CHAT (migración 0198).
 *
 * «Consulta el estado de cada vuelo en AeroDataBox cada 5 minutos, solo los de
 * hoy que no hayan aterrizado, máximo 2.000 consultas al día»: una URL por
 * fila, con filtro, intervalo que se acorta cerca de la hora y un tope diario.
 * Crear y cambiar piden confirmación (dejan un trabajo que gasta cuota de una
 * API con una llave de la empresa); ver cómo va no.
 */

const mappingInput = z
  .array(
    z.object({
      path: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .describe(
          'Path in the JSON response, e.g. "status" or "arrival.estimated" or "data.0.status".',
        ),
      field: z
        .string()
        .trim()
        .min(1)
        .max(32)
        .describe(
          'Key of the table column to write, e.g. "estado". Created as a text column when the table lacks it.',
        ),
      label: z.string().trim().min(1).max(60).optional().describe('Label for a new column.'),
      translate: z
        .record(z.string().max(80), z.string().max(80))
        .optional()
        .describe('Rename API values, e.g. {"Arrived":"aterrizado"}.'),
    }),
  )
  .min(1)
  .max(10);

const FILTER_HELP =
  'Same filters as the table views: {match:"all"|"any", filters:[{key,op,value}]}; op = eq|neq|contains|not_contains|gt|gte|lt|lte|between|in|not_in|empty|not_empty|before|after|last_days|next_days. For dates the value "hoy" means today in Bogotá. The filter is also the STOP RULE: a row that stops matching (estado not in aterrizado, cancelado) is not queried again.';

function when(iso: string | null): string {
  if (!iso) return 'aún no';
  return iso.slice(0, 16).replace('T', ' ');
}

function describe(info: LookupStatusInfo): string {
  const l = info.lookup;
  const state = !l.enabled
    ? 'en pausa'
    : l.last_status === 'error'
      ? 'con error'
      : l.last_status === 'capped'
        ? 'tope alcanzado'
        : 'activa';
  const near = l.near
    ? ` · cada ${l.near.everyMinutes} min desde ${l.near.beforeMinutes} min antes hasta ${l.near.afterMinutes} min después de «${l.near.field}»${l.near.outside === 'skip' ? ' (fuera de esa ventana no consulta)' : `, y cada ${l.base_interval_minutes} min fuera`}`
    : ` · cada ${l.base_interval_minutes} min`;
  const lines = [
    `- **${l.name}** (${info.trackerName}) · ${state}${near}`,
    `  Hoy: ${info.callsToday} de ${l.daily_cap} consultas (tope por vuelta ${l.per_run_cap}). Tocan ahora: ${info.dueNow}${info.deferred ? ` (${info.deferred} esperan por el tope)` : ''}. Filas fuera del filtro: ${info.skipped.filter}${info.skipped.window ? `, fuera de la ventana: ${info.skipped.window}` : ''}${info.skipped.missing ? `, sin algún campo de la dirección: ${info.skipped.missing}` : ''}.`,
    `  Última vuelta: ${when(l.last_run_at)} (${l.last_calls} consultas, ${l.last_updated} filas cambiaron). Próxima: ${when(l.next_run_at)}.`,
  ];
  if (l.last_error) lines.push(`  Último error: ${l.last_error}`);
  for (const e of info.errors.slice(0, 3)) lines.push(`  · ${e.label}: ${e.message}`);
  return lines.join('\n');
}

export const trackersRowLookupCreate = registerTool({
  id: 'trackers.row_lookup_create',
  description: `Set up an automatic PER-ROW API lookup for a company table: for each row that matches a filter, call an API URL built from the row fields (e.g. https://api.example.com/flights/{vuelo}/{fecha:YYYY-MM-DD}) and write chosen response fields back into the row (e.g. status → estado, arrival.estimated → hora_estimada). Use it when the person wants to know the live status of each row from an external API ("consulta el estado de cada vuelo en AeroDataBox cada 5 minutos, solo los de hoy que no hayan aterrizado, máximo 2.000 consultas al día"). Different from trackers.update_from_source, which reads ONE list per run. Needs: the table, the URL template ({campo} or {campo:formato}; formats YYYY-MM-DD, DD/MM/YYYY, HH:mm, iso, unix, upper, lower, digits, compact; {hoy} and {ahora} are built in), a credential (name of a custom tool that stores the API key, same host; omit for public APIs), the mapping, a filter, the base interval (min 5 minutes) and an optional "near" rule that speeds it up around a date/time column (e.g. every 5 min within 2 h before and 1 h after hora_estimada). A daily cap on API calls is ALWAYS applied (default 1000) plus a per-run cap; when it is reached it stops and notifies once, and resumes at midnight Bogotá. It tests one row first; if the API answers badly the lookup is saved PAUSED. ${FILTER_HELP} Requires confirmation.`,
  inputSchema: z.object({
    table: trackerSlugSchema.describe('Slug of the existing table, e.g. "llegadas".'),
    name: z.string().trim().min(1).max(80).describe('Short name, e.g. "Estado del vuelo".'),
    urlTemplate: z.string().trim().min(8).max(1000),
    credential: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Name or slug of the custom tool that holds the API key. The key is only sent to the same host.',
      ),
    mapping: mappingInput,
    filter: lookupFilterSchema.optional(),
    intervalMinutes: z.number().int().min(5).max(1440).default(30),
    near: lookupNearSchema.optional(),
    dailyCap: z.number().int().min(1).max(100000).default(DEFAULT_DAILY_CAP),
    perRunCap: z.number().int().min(1).max(1000).default(DEFAULT_PER_RUN_CAP),
  }),
  outputSchema: z.object({
    id: z.string(),
    enabled: z.boolean(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const { lookup, tracker, added, preview } = await createRowLookup(ctx.db, {
      trackerSlug: input.table,
      actorId: ctx.userId,
      name: input.name,
      urlTemplate: input.urlTemplate,
      credential: input.credential,
      mapping: input.mapping,
      filter: input.filter,
      baseIntervalMinutes: input.intervalMinutes ?? 30,
      near: input.near ?? null,
      dailyCap: input.dailyCap ?? DEFAULT_DAILY_CAP,
      perRunCap: input.perRunCap ?? DEFAULT_PER_RUN_CAP,
      probe: true,
    });
    const test = !preview
      ? ''
      : preview.ok
        ? ` Prueba con «${preview.rowLabel ?? 'una fila'}»: ${preview.fields.map((f) => `${f.label} ${f.current ? `«${f.current}» → ` : ''}«${f.next ?? 'sin dato'}»`).join(', ')}.`
        : preview.calls > 0
          ? ` La prueba con «${preview.rowLabel ?? 'una fila'}» falló: ${preview.message}. La dejé EN PAUSA para no gastar consultas; corrígela con trackers.row_lookup_update.`
          : ` No pude probarla todavía: ${preview.message}`;
    const queued = lookup.enabled
      ? await ctx.enqueueJob?.('table-sync/run', {
          organizationId: ctx.organizationId,
          lookupId: lookup.id,
        })
      : false;
    return {
      id: lookup.id,
      enabled: lookup.enabled,
      markdown: `Listo: «${lookup.name}» consulta ${tracker.name} fila por fila${lookup.enabled ? '' : ' (en pausa)'}, cada ${lookup.near ? `${lookup.near.everyMinutes} min cerca de «${lookup.near.field}» y ${lookup.base_interval_minutes} min fuera` : `${lookup.base_interval_minutes} min`}, con tope de ${lookup.daily_cap} consultas al día.${added.length ? ` Agregué las columnas ${added.map((a) => `«${a}»`).join(', ')}.` : ''}${test}${queued ? ' La primera vuelta ya está corriendo.' : ''} Se ve en Tablas › ${tracker.name} › Consultas automáticas.`,
    };
  },
});

export const trackersRowLookupStatus = registerTool({
  id: 'trackers.row_lookup_status',
  description:
    'How the automatic per-row API lookups are going: queries used today against the daily cap, how many rows are due now, the next run, the last error and the rows that failed. Optionally for one table or one lookup. Read-only.',
  inputSchema: z.object({
    table: trackerSlugSchema.optional(),
    lookup: z.string().trim().min(1).max(120).optional().describe('Name or id of one lookup.'),
  }),
  outputSchema: z.object({ total: z.number().int(), markdown: z.string() }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    let lookups: RowLookupRow[];
    if (input.lookup) lookups = [await findRowLookup(ctx.db, input.lookup, input.table)];
    else {
      const tracker = input.table ? await trackerBySlug(ctx.db, input.table) : null;
      lookups = await listRowLookups(ctx.db, tracker?.id);
    }
    if (!lookups.length)
      return {
        total: 0,
        markdown:
          'Ninguna tabla tiene consultas automáticas por fila todavía. Se configuran con trackers.row_lookup_create.',
      };
    const infos = await Promise.all(lookups.slice(0, 10).map((l) => rowLookupStatus(ctx.db, l)));
    return { total: lookups.length, markdown: infos.map(describe).join('\n\n') };
  },
});

export const trackersRowLookupUpdate = registerTool({
  id: 'trackers.row_lookup_update',
  description: `Change an automatic per-row API lookup: pause or resume it (enabled), change the daily cap or per-run cap, the interval, the near rule (null removes it), the filter, the URL template, the mapping or the name; or run it now. Use trackers.row_lookup_status first to see it. Changing the URL, mapping, filter or near rule makes every row due again. Requires confirmation. ${FILTER_HELP}`,
  inputSchema: z.object({
    lookup: z.string().trim().min(1).max(120).describe('Name or id of the lookup.'),
    table: trackerSlugSchema.optional().describe('Table slug, to disambiguate the name.'),
    name: z.string().trim().min(1).max(80).optional(),
    urlTemplate: z.string().trim().min(8).max(1000).optional(),
    mapping: mappingInput.optional(),
    filter: lookupFilterSchema.optional(),
    intervalMinutes: z.number().int().min(5).max(1440).optional(),
    near: lookupNearSchema.nullable().optional(),
    dailyCap: z.number().int().min(1).max(100000).optional(),
    perRunCap: z.number().int().min(1).max(1000).optional(),
    enabled: z.boolean().optional().describe('false pauses it, true resumes it.'),
    runNow: z.boolean().optional().describe('Run a round right now.'),
  }),
  outputSchema: z.object({ id: z.string(), enabled: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const current = await findRowLookup(ctx.db, input.lookup, input.table);
    const { lookup, added } = await updateRowLookup(
      ctx.db,
      current,
      {
        name: input.name,
        urlTemplate: input.urlTemplate,
        mapping: input.mapping,
        filter: input.filter,
        baseIntervalMinutes: input.intervalMinutes,
        near: input.near,
        dailyCap: input.dailyCap,
        perRunCap: input.perRunCap,
        enabled: input.enabled,
      },
      ctx.userId,
    );
    const queued =
      lookup.enabled && (input.runNow || input.enabled === true)
        ? await ctx.enqueueJob?.('table-sync/run', {
            organizationId: ctx.organizationId,
            lookupId: lookup.id,
          })
        : false;
    const changes = [
      input.enabled === true ? 'la reanudé' : input.enabled === false ? 'la dejé en pausa' : '',
      input.dailyCap ? `tope diario ${lookup.daily_cap}` : '',
      input.perRunCap ? `tope por vuelta ${lookup.per_run_cap}` : '',
      input.intervalMinutes ? `cada ${lookup.base_interval_minutes} min` : '',
      input.near !== undefined
        ? input.near
          ? 'regla «cerca de» nueva'
          : 'sin regla «cerca de»'
        : '',
      input.filter ? 'filtro nuevo' : '',
      input.urlTemplate ? 'dirección nueva' : '',
      input.mapping ? 'mapeo nuevo' : '',
      input.name ? `ahora se llama «${lookup.name}»` : '',
    ].filter(Boolean);
    return {
      id: lookup.id,
      enabled: lookup.enabled,
      markdown: `Listo, «${lookup.name}»: ${changes.join(', ') || 'sin cambios'}.${added.length ? ` Agregué las columnas ${added.map((a) => `«${a}»`).join(', ')}.` : ''}${queued ? ' Ya la estoy corriendo.' : ''}`,
    };
  },
});
