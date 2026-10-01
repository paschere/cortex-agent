import { z } from 'zod';
import { registerTool } from '../index';
import { trackerSlugSchema } from '../trackers/schema';
import { createUpdateOnlySync } from './enrich';
import { resolveSource } from './tools';

/**
 * «Que la API de vuelos marque en cada guía si su vuelo ya aterrizó»
 * (migración 0163). Cruza la fuente contra una tabla que YA EXISTE por unas
 * columnas (vuelo + fecha) y escribe en las filas que coinciden sólo las
 * columnas pedidas. Nunca agrega filas. Pide confirmación por la misma razón
 * que `trackers.sync_from_source`: deja un trabajo que corre solo con datos
 * del Feed privado de quien lo configura.
 */
export const trackersUpdateFromSource = registerTool({
  id: 'trackers.update_from_source',
  description:
    'Keep columns of an EXISTING company table updated from a connected Feed source, without adding rows: rows are matched by key columns (e.g. flight number + date) and only the chosen columns are written (e.g. flight status, actual arrival time). Use it when a table already has its rows (e.g. air waybills/guías from Drive) and another source (e.g. a flights API) must update their status. Flight numbers match ignoring case, spaces and leading zeros (AV009 = AV9), but IATA vs ICAO codes (AV9 vs AVA9) do not match: pick the right source column. Missing target columns are added to the table as text. Requires confirmation.',
  inputSchema: z.object({
    source: z.string().trim().min(1).max(240).describe('Name or id of the connected Feed source.'),
    table: trackerSlugSchema.describe('Slug of the existing table to update, e.g. "guias".'),
    match: z
      .array(
        z.object({
          column: z.string().trim().min(1).max(120),
          field: z.string().trim().min(1).max(32),
        }),
      )
      .min(1)
      .max(3)
      .describe(
        'Source column ↔ table field pairs that identify the same thing, e.g. flight.iata↔vuelo, flight_date↔fecha_vuelo.',
      ),
    set: z
      .array(
        z.object({
          column: z.string().trim().min(1).max(120),
          field: z.string().trim().min(1).max(32).optional(),
          label: z.string().trim().min(1).max(60).optional(),
        }),
      )
      .min(1)
      .max(10)
      .describe(
        'Source columns to write into the table, e.g. flight_status → estado_vuelo, arrival.actual → llegada.',
      ),
    intervalMinutes: z.number().int().min(5).max(1440).default(10),
    notify: z.boolean().default(true),
    sheet: z.number().int().min(0).max(19).default(0),
  }),
  outputSchema: z.object({ updated: z.number().int(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const source = await resolveSource(ctx.db, ctx.userId, input.source);
    const { tracker, outcome, added } = await createUpdateOnlySync(ctx.db, {
      sourceId: source.id,
      sheetIndex: input.sheet ?? 0,
      actorId: ctx.userId,
      tableSlug: input.table,
      match: input.match,
      set: input.set,
      intervalMinutes: input.intervalMinutes ?? 10,
      notify: input.notify ?? true,
    });
    return {
      updated: outcome.updated,
      markdown: `Listo: «${source.name}» actualiza **${tracker.name}** cada ${input.intervalMinutes ?? 10} minutos cruzando por ${input.match.map((m) => `${m.column}↔${m.field}`).join(' + ')}.${added.length ? ` Agregué las columnas ${added.map((a) => `«${a}»`).join(', ')}.` : ''} Primera pasada: ${outcome.updated} ${outcome.updated === 1 ? 'fila actualizada' : 'filas actualizadas'}${outcome.unchanged ? `, ${outcome.unchanged} ya estaban al día` : ''}. No agrega filas nuevas.`,
    };
  },
});
