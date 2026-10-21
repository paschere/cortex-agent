import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { sheetsFetch } from '../gsheets/client';
import { registerTool } from '../index';
import { originsOf } from '../trackers/origin';
import { rowLabel, trackerSlugSchema } from '../trackers/schema';
import { getTrackerBySlug, setTrackerOrigin, shapeValuesDetailed } from '../trackers/store';
import { ENTRY_COLUMNS_FOR_WRITE_BACK, planSheetWrite } from './write-back-shape';

/**
 * ESCRITURA DE VUELTA A UNA HOJA (0237).
 *
 * Una tabla que viene de una hoja es de sólo lectura en sus columnas de la hoja.
 * Si la empresa quiere lo contrario para ESA tabla, lo enciende
 * (`trackers.set_sheet_writeback`) y desde entonces un cambio a una columna de
 * la hoja se hace con `trackers.write_back_sheet`: escribe la celda en la hoja
 * (con el acceso de Google de quien lo pide) y deja la fila igual que la hoja.
 * CADA cambio pide confirmación. La próxima lectura de la hoja ya trae el mismo
 * valor, así que nada diverge.
 */

const WRITE_SCOPES: Array<{ provider: 'google'; scopes: string[] }> = [
  { provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
];

export const trackersSetSheetWriteback = registerTool({
  id: 'trackers.set_sheet_writeback',
  description:
    'Turn ON or OFF «write back to the sheet» for a company table that is filled from a Google Sheet. OFF (default): the columns that come from the sheet are read-only and changes are made in the sheet. ON: those columns can be changed from Cortex with trackers.write_back_sheet, which writes the cell in the sheet itself (each change asks for confirmation) and also lets people add rows from forms. Use it only when the person asks to edit the sheet from Cortex. Requires confirmation.',
  inputSchema: z.object({
    tracker: trackerSlugSchema.describe('Slug of the table that comes from a sheet.'),
    enabled: z.boolean().describe('true = allow writing back to the sheet; false = read-only.'),
  }),
  outputSchema: z.object({ enabled: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) throw new NotFoundError(`No hay una tabla «${input.tracker}».`);
    const sheets = originsOf(tracker).filter((o) => o.kind === 'sheet');
    if (!sheets.length)
      throw new ValidationError(
        `«${tracker.name}» no se llena desde una hoja de Google: no hay nada a dónde escribir de vuelta.`,
      );
    for (const o of sheets)
      await setTrackerOrigin(ctx.db, tracker.id, { ...o, writeBack: input.enabled });
    return {
      enabled: input.enabled,
      markdown: input.enabled
        ? `Listo: desde ahora los cambios a las columnas de la hoja en «${tracker.name}» se escriben en la hoja (cada uno te pide confirmar).`
        : `Listo: «${tracker.name}» vuelve a ser de sólo lectura en las columnas de la hoja.`,
    };
  },
});

export const trackersWriteBackSheet = registerTool({
  id: 'trackers.write_back_sheet',
  description:
    'Change one row of a company table that is filled from a Google Sheet by WRITING the new value into the sheet itself (and keeping the row the same). Only works when write-back is enabled for the table (trackers.set_sheet_writeback); otherwise the sheet columns are read-only and the person changes them in the sheet. Pass the row id and the fields to change (keys of the table that come from the sheet). Each call asks the person to confirm, showing the change. The row is found in the sheet by its key columns; if it is not found or the sheet changed, nothing is written.',
  inputSchema: z.object({
    tracker: trackerSlugSchema,
    rowId: z.string().uuid().describe('The row to change (from trackers.query).'),
    values: z
      .record(z.string().min(1).max(32), z.union([z.string().max(400), z.number()]))
      .describe('Field key → new value. Only fields that come from the sheet.'),
  }),
  outputSchema: z.object({ written: z.number().int(), markdown: z.string() }),
  requiresConfirmation: true,
  requiredScopes: WRITE_SCOPES,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) throw new NotFoundError(`No hay una tabla «${input.tracker}».`);
    const origin = originsOf(tracker).find((o) => o.kind === 'sheet' && o.writeBack);
    if (!origin)
      throw new ValidationError(
        'Esta tabla no tiene activada la escritura a la hoja (trackers.set_sheet_writeback). Cambia el dato en la hoja.',
      );
    const keys = Object.keys(input.values);
    const outside = keys.filter((k) => !origin.fields.includes(k));
    if (outside.length)
      throw new ValidationError(
        `${outside.map((k) => `«${k}»`).join(', ')} no viene de la hoja: es un campo propio, se edita con trackers.upsert.`,
      );
    const { data: syncRow, error: syncError } = await ctx.db
      .from('tracker_syncs')
      .select('id, source_id, sheet_index, mapping, key_fields')
      .eq('id', origin.ref)
      .maybeSingle();
    if (syncError) throw syncError;
    if (!syncRow) throw new NotFoundError('La sincronización con la hoja ya no existe.');
    const sync = syncRow as {
      source_id: string;
      sheet_index: number;
      mapping: Record<string, string>;
      key_fields: string[];
    };
    const { data: source, error: sourceError } = await ctx.db
      .from('feed_sources')
      .select('config')
      .eq('id', sync.source_id)
      .maybeSingle();
    if (sourceError) throw sourceError;
    const config = (source as { config?: { spreadsheetId?: string; tabs?: string[] } } | null)
      ?.config;
    if (!config?.spreadsheetId) throw new ValidationError('No encuentro la hoja de esta tabla.');
    const { data: entry, error: rowError } = await ctx.db
      .from('tracker_rows')
      .select(ENTRY_COLUMNS_FOR_WRITE_BACK)
      .eq('id', input.rowId)
      .eq('tracker_id', tracker.id)
      .maybeSingle();
    if (rowError) throw rowError;
    if (!entry) throw new NotFoundError('Esa fila no está en la tabla.');
    const current = ((entry as { values?: Record<string, unknown> }).values ?? {}) as Record<
      string,
      unknown
    >;

    // La pestaña: la guardada en la fuente o la primera del libro.
    let tab = config.tabs?.[sync.sheet_index];
    if (!tab) {
      const meta = await sheetsFetch<{ sheets: Array<{ properties: { title: string } }> }>(
        ctx,
        `/${config.spreadsheetId}?fields=sheets.properties.title`,
      );
      tab = meta.sheets[sync.sheet_index]?.properties.title ?? meta.sheets[0]?.properties.title;
    }
    if (!tab) throw new ValidationError('La hoja no tiene pestañas legibles.');
    const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
    const live = await sheetsFetch<{ values?: unknown[][] }>(
      ctx,
      `/${config.spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`,
    );
    const plan = planSheetWrite({
      sheet: live.values ?? [],
      mapping: sync.mapping,
      keyFields: sync.key_fields,
      rowValues: current,
      changes: input.values,
    });
    if (!plan.ok) throw new ValidationError(plan.error);
    await sheetsFetch(ctx, `/${config.spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: plan.cells.map((c) => ({
          range: `'${tab.replace(/'/g, "''")}'!${c.a1}`,
          values: [[c.value]],
        })),
      }),
    });
    // La fila queda como la hoja (la próxima lectura trae lo mismo).
    const shaped = shapeValuesDetailed(
      tracker.fields,
      { ...current, ...input.values },
      {
        lenient: true,
      },
    );
    const { error: updateError } = await ctx.db
      .from('tracker_rows')
      .update({
        values: shaped.values,
        label: rowLabel(tracker.fields, shaped.values),
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.rowId)
      .eq('tracker_id', tracker.id);
    if (updateError) throw updateError;
    return {
      written: plan.cells.length,
      markdown: `Escribí ${plan.cells.length === 1 ? 'la celda' : `${plan.cells.length} celdas`} en la fila ${plan.rowNumber} de la pestaña «${tab}» y la fila de «${tracker.name}» quedó igual.`,
    };
  },
});
