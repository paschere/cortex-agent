import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { getDuplicateRule } from '../trackers/duplicates';
import { duplicateRuleSchema } from '../trackers/duplicates';
import {
  type TrackerField,
  coerceValue,
  trackerFieldSchema,
  trackerFieldsSchema,
  trackerSlugSchema,
} from '../trackers/schema';
import { defineTracker, getTrackerBySlug } from '../trackers/store';
import {
  type DriveAccess,
  driveFolderMeta,
  findDriveFolders,
  listDriveFolderSyncs,
  upsertDriveFolderSync,
} from './engine';
import {
  CARPETA_KEY,
  DRIVE_TABLE_PRESETS,
  type ExtractField,
  REVIEW_FIELD,
  compact,
  findReviewField,
  parseFolderRef,
} from './plan';
import { proposeFromDriveFolder } from './propose-folder';

/**
 * Llenar una tabla de la empresa desde una carpeta de Google Drive (0164).
 *
 * «A esta carpeta nos llegan las facturas de los proveedores / las guías / las
 * órdenes de compra: que cada archivo sea una fila.» Pide confirmación: lee
 * documentos del Drive de la persona, con SUS credenciales, y los copia a una
 * tabla que ve todo el equipo, y deja un trabajo que corre solo.
 *
 * Los campos salen, en este orden, de lo que la persona dijo (`fields`), de un
 * ejemplo de partida (`preset`), de la tabla que ya existe, o —si no hay nada
 * de eso— de un archivo de muestra de la carpeta, que el modelo lee para
 * proponerlos. La primera lectura no se hace aquí: se encola, porque leer diez
 * documentos con el modelo no cabe en un turno de chat; la campana avisa.
 */

const PRESET_IDS = Object.keys(DRIVE_TABLE_PRESETS) as [string, ...string[]];

export async function resolveFolder(drive: DriveAccess, ref: string) {
  const parsed = parseFolderRef(ref);
  if ('id' in parsed) return driveFolderMeta(drive, parsed.id);
  const found = await findDriveFolders(drive, parsed.name);
  if (!found.length)
    throw new NotFoundError(
      `No encontré en tu Drive una carpeta llamada «${parsed.name}». Pega el enlace de la carpeta.`,
    );
  const exact = found.filter((f) => compact(f.name) === compact(parsed.name));
  const pick = exact.length === 1 ? exact : found;
  if (pick.length > 1)
    throw new ValidationError(
      `Hay varias carpetas que se llaman parecido: ${pick
        .slice(0, 5)
        .map((f) => `«${f.name}»`)
        .join(', ')}. Pega el enlace de la que es.`,
    );
  return pick[0] as { id: string; name: string };
}

function resolveKey(fields: TrackerField[], ref: string): string | null {
  const c = compact(ref);
  return fields.find((f) => f.key === ref.trim() || compact(f.label) === c)?.key ?? null;
}

export const trackersSyncFromDriveFolder = registerTool({
  id: 'trackers.sync_from_drive_folder',
  description:
    'Make a company table fill itself from the files dropped in a Google Drive folder, optionally including its subfolders. Spreadsheets inside (Google Sheets, .xlsx, .csv) are read row by row with no model — every row is a record, columns matched to fields by header — and re-reading updates rows instead of duplicating them. PDFs, Word and Google Docs are read by a model (fields -> row, or several rows if the file lists several records); photos and scanned PDFs (up to 15 pages) are read by the model as images. Values from documents are only stored when a literal sentence backs them; doubtful or missing ones leave the row marked "Por revisar". For a table that does not exist yet you MUST first call trackers.propose_from_drive_folder, show its markdown and wait for the person to approve or change it, then pass the approved `fields` here (each with sourceColumn for sheet columns, fromDocument for fields read from documents; the proposal also adds a `carpeta` field filled with each file\'s subfolder) plus keyFields, duplicates and recursive. Only the explicit `preset` (guias_aereas, facturas_proveedor, ordenes_compra) or an existing table may skip the proposal. Rows deleted from a sheet are NOT deleted from the table. Runs with the Google credentials of the person who asks. Requires confirmation.',
  inputSchema: z.object({
    folder: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Google Drive folder link, id or exact name.'),
    table: trackerSlugSchema.describe(
      'Slug of the table to fill (created if it does not exist), e.g. "facturas_proveedor".',
    ),
    tableName: z.string().trim().min(1).max(80).optional().describe('Name for a new table.'),
    tableDescription: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('Description for a new table.'),
    preset: z
      .enum(PRESET_IDS)
      .optional()
      .describe(
        'Optional starting point: guias_aereas (air waybills), facturas_proveedor (supplier invoices), ordenes_compra (purchase orders). Omit for anything else.',
      ),
    fields: z
      .array(
        trackerFieldSchema.and(
          z.object({
            sourceColumn: z
              .string()
              .trim()
              .max(120)
              .optional()
              .describe('Header of the sheet column that fills this field (sheets in the folder).'),
            hint: z
              .string()
              .trim()
              .max(200)
              .optional()
              .describe('Where the value is in a PDF/Word/photo.'),
            fromDocument: z
              .boolean()
              .optional()
              .describe(
                'true when a model reads this field from documents; false for fields the team fills (status, owner) or sheets fill.',
              ),
            fromFolder: z
              .boolean()
              .optional()
              .describe('The carpeta field: filled with each file subfolder.'),
          }),
        ),
      )
      .min(1)
      .max(20)
      .optional()
      .describe(
        'REQUIRED when the table does not exist yet (unless `preset`): the fields the person approved from trackers.propose_from_drive_folder, with any changes they asked for, exactly as proposed (sourceColumn / fromDocument / hint / fromFolder included).',
      ),
    duplicates: duplicateRuleSchema
      .optional()
      .describe('Duplicate rule the person approved (from the proposal), for a new table.'),
    recursive: z
      .boolean()
      .optional()
      .describe(
        'Also read the subfolders (up to 3 levels, 2000 files). Pass what the proposal used.',
      ),
    keyFields: z
      .array(z.string().trim().min(1).max(60))
      .min(1)
      .max(5)
      .optional()
      .describe(
        'Field keys or labels that identify a record, e.g. ["numero"] or ["proveedor","numero"].',
      ),
    defaults: z
      .record(z.union([z.string().max(400), z.number()]))
      .optional()
      .describe('Values a new row starts with, e.g. {"estado": "Pendiente"}.'),
    instructions: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe(
        'Context for reading these documents, e.g. "weights in Miami waybills are in pounds".',
      ),
    intervalMinutes: z.number().int().min(10).max(1440).default(10),
    notify: z.boolean().default(true).describe('Ring the bell when rows are added.'),
  }),
  outputSchema: z.object({
    status: z.literal('scheduled'),
    table: z.string(),
    fields: z.array(z.string()),
    /** Dónde quedó la tabla en la app (ruta relativa: «Quedó en Tablas → …»). */
    url: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const drive: DriveAccess = { integrations: ctx.integrations, signal: ctx.signal };
    const folder = await resolveFolder(drive, input.folder);
    const existing = await getTrackerBySlug(ctx.db, input.table);
    const preset = input.preset ? DRIVE_TABLE_PRESETS[input.preset] : undefined;

    // 1. Qué columnas hay y cuáles se leen del documento.
    let wanted: TrackerField[] = [];
    let extract: ExtractField[] = [];
    let keyRefs = input.keyFields ?? [];
    let defaults: Record<string, string | number> = { ...(input.defaults ?? {}) };
    let name = input.tableName ?? existing?.name;
    let description = existing?.description ?? input.tableDescription ?? '';
    let sheetMapping: Record<string, string> = {};

    if (input.fields?.length) {
      // Una llamada que dice qué es cada campo (hoja, documento, subcarpeta) se
      // toma al pie de la letra; una antigua, sin nada de eso, lee todo del documento.
      const explicit = input.fields.some(
        (f) => f.sourceColumn !== undefined || f.fromDocument !== undefined || f.fromFolder,
      );
      wanted = input.fields.map(
        ({ sourceColumn: _s, hint: _h, fromDocument: _d, fromFolder: _f, ...field }) =>
          field as TrackerField,
      );
      extract = input.fields
        .filter((f) => f.fromDocument ?? (!explicit && !f.sourceColumn))
        .filter((f) => f.key !== CARPETA_KEY || f.fromDocument)
        .map((f) => ({ key: f.key, hint: f.hint ?? '' }));
      sheetMapping = Object.fromEntries(
        input.fields.flatMap((f) => (f.sourceColumn ? [[f.key, f.sourceColumn]] : [])),
      );
    } else if (preset) {
      wanted = preset.fields;
      extract = preset.extract;
      if (!keyRefs.length) keyRefs = preset.keyFields;
      defaults = { ...preset.defaults, ...defaults };
      name ??= preset.name;
      description ||= preset.description;
    } else if (existing) {
      // Una tabla que ya existe: se lee todo menos lo que es del equipo (los
      // campos de opciones, como un estado) y lo que nace con un valor fijo.
      wanted = existing.fields;
      extract = existing.fields
        .filter((f) => f.type !== 'select' && !(f.key in defaults))
        .map((f) => ({ key: f.key, hint: '' }));
    } else {
      // Una tabla nueva no se crea a ciegas: primero se lee la carpeta y se le
      // propone a la persona (igual que con una hoja suelta).
      throw new ValidationError(
        'Una tabla nueva desde una carpeta se propone primero: llama a trackers.propose_from_drive_folder con la carpeta, muéstrale a la persona el markdown (campos, de dónde sale cada uno, clave, duplicados, subcarpetas) y espera su aprobación o sus cambios; después vuelve a llamar aquí con esos `fields`, keyFields, duplicates y recursive.',
      );
    }
    if (!extract.length && !Object.keys(sheetMapping).length)
      throw new ValidationError(
        'Dime al menos un campo que se lea de los documentos o de las hojas.',
      );

    // 2. La tabla: la que existe más lo que falte, o una nueva. Siempre con un
    // campo de revisión, que es donde se ve lo que hay que mirar.
    const base = existing?.fields ?? [];
    const fields = [...base, ...wanted.filter((w) => !base.some((b) => b.key === w.key))];
    if (!findReviewField(fields) && !fields.some((f) => f.key === REVIEW_FIELD.key))
      fields.push(REVIEW_FIELD);
    if (fields.length > 20)
      throw new ValidationError(
        'La tabla quedaría con más de 20 campos. Quita algunos o usa una tabla nueva.',
      );
    const parsedFields = trackerFieldsSchema.parse(fields);
    const tableName = name ?? input.table.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const newRule = input.duplicates
      ? duplicateRuleSchema.parse(input.duplicates)
      : preset?.duplicates;
    const changed = !existing || parsedFields.length !== existing.fields.length;
    const tracker = changed
      ? (
          await defineTracker(ctx.db, {
            slug: input.table,
            name: tableName.slice(0, 80),
            description: (description || `Se llena sola desde la carpeta «${folder.name}».`).slice(
              0,
              500,
            ),
            fields: parsedFields,
            userId: ctx.userId,
            // Una tabla NUEVA desde un preset nace con su regla de duplicados;
            // a una que ya existe no se le pone una regla que nadie pidió.
            ...(!existing && newRule ? { duplicates: newRule } : {}),
          })
        ).tracker
      : existing;

    // 3. La clave, que tiene que leerse del documento.
    const extractable = extract.filter((e) => tracker.fields.some((f) => f.key === e.key));
    sheetMapping = Object.fromEntries(
      Object.entries(sheetMapping).filter(([k]) => tracker.fields.some((f) => f.key === k)),
    );
    // Los campos que alguien llena con algo: documento, hoja o subcarpeta.
    const filled = (key: string) =>
      extractable.some((e) => e.key === key) ||
      key in sheetMapping ||
      (key === CARPETA_KEY && tracker.fields.some((f) => f.key === CARPETA_KEY));
    if (!keyRefs.length)
      throw new ValidationError(
        `Dime qué campo identifica cada documento (su número, por ejemplo). Campos: ${tracker.fields.map((f) => f.label).join(', ')}.`,
      );
    const keyFields = keyRefs.map((ref) => {
      const key = resolveKey(tracker.fields, ref);
      if (!key)
        throw new ValidationError(
          `«${ref}» no es un campo de la tabla. Campos: ${tracker.fields.map((f) => f.label).join(', ')}.`,
        );
      if (!filled(key))
        throw new ValidationError(
          `«${ref}» identifica la fila, así que tiene que leerse de los documentos o de una columna de la hoja.`,
        );
      return key;
    });

    // 3b. Si la tabla marca duplicados «misma clave, distinta fecha», la fecha
    // tiene que ser parte de la clave del documento: si no, la segunda guía
    // con otra fecha pisa la primera y nunca hay dos filas que marcar.
    const rule = (await getDuplicateRule(ctx.db, tracker.id))?.rule;
    if (
      rule?.distinctBy &&
      keyFields.includes(rule.key) &&
      !keyFields.includes(rule.distinctBy) &&
      filled(rule.distinctBy)
    )
      keyFields.push(rule.distinctBy);

    // 4. Los valores con que nace una fila, contra el tipo de cada campo.
    for (const [key, value] of Object.entries(defaults)) {
      const field = tracker.fields.find((f) => f.key === key);
      if (!field) throw new ValidationError(`«${key}» no es un campo de la tabla.`);
      const coerced = coerceValue(field, value);
      if (!coerced.ok) throw new ValidationError(coerced.message);
      defaults[key] = coerced.value;
    }

    const sync = await upsertDriveFolderSync(ctx.db, {
      actorId: ctx.userId,
      folder,
      trackerId: tracker.id,
      extract: extractable,
      keyFields: [...new Set(keyFields)],
      defaults,
      instructions: input.instructions ?? '',
      intervalMinutes: input.intervalMinutes ?? 10,
      notify: input.notify ?? true,
      sheetMapping,
      recursive: input.recursive ?? false,
      maxDepth: 3,
    });
    const queued = await ctx.enqueueJob?.('drive-table/run', {
      organizationId: ctx.organizationId,
      syncId: sync.id,
    });

    const labelOf = (key: string) => tracker.fields.find((f) => f.key === key)?.label;
    const read = extractable
      .map((e) => labelOf(e.key))
      .filter(Boolean)
      .join(', ');
    const fromSheets = Object.keys(sheetMapping).map(labelOf).filter(Boolean).join(', ');
    const keyLabels = keyFields
      .map((k) => tracker.fields.find((f) => f.key === k)?.label ?? k)
      .join(' + ');
    const lines = [
      `${existing ? `La tabla **${tracker.name}**` : `Creé la tabla **${tracker.name}** (\`${tracker.slug}\`), que`} se va a llenar con los archivos de la carpeta «${folder.name}», cada ${sync.interval_minutes} minutos.`,
      sync.recursive ? 'Incluye las subcarpetas (hasta 3 niveles).' : '',
      fromSheets
        ? `De las hojas leo cada fila sin modelo (${fromSheets}); si la hoja cambia, actualizo sus filas; las filas que borren de la hoja NO se borran de la tabla.`
        : '',
      read ? `De los documentos leo: ${read}.` : '',
      `Cada fila se identifica por ${keyLabels}.`,
      'De documentos y fotos sólo guardo un valor si se lee en el archivo; lo dudoso o lo que falte deja la fila «Por revisar».',
      queued
        ? 'Ya empecé la primera lectura; te aviso en la campana cuando entren filas.'
        : `La primera lectura empieza en los próximos ${sync.interval_minutes} minutos; te aviso en la campana.`,
    ].filter(Boolean);
    return {
      status: 'scheduled' as const,
      table: tracker.slug,
      fields: tracker.fields.map((f) => f.key),
      url: `/trackers/${tracker.slug}`,
      markdown: lines.join('\n'),
    };
  },
});

/**
 * Leer la carpeta y PROPONER la tabla, sin crear nada. Es el paso obligado
 * antes de trackers.sync_from_drive_folder con una tabla nueva (ver
 * propose-folder.ts), igual que trackers.propose_from_source con una hoja.
 */
export const trackersProposeFromDriveFolder = registerTool({
  id: 'trackers.propose_from_drive_folder',
  description:
    'Look inside a Google Drive folder and PROPOSE the company table that will be filled from it, without creating anything. It inventories the folder (spreadsheets, documents, images, files it cannot read, subfolders), reads the spreadsheets (headers and data) and a sample document, and returns the fields with where each comes from (sheet column, document, or the subfolder), why and examples, the key that identifies a record, a duplicate rule when it sees the risk, and whether subfolders are included (they are by default when the folder has them, with a `carpeta` field filled with each file subfolder). Spreadsheets with compatible headers are merged; if some have different headers it says so and asks whether to make one table or several. ALWAYS call this before trackers.sync_from_drive_folder creates a new table: show the returned markdown to the person and wait for their approval or changes, then pass the approved fields to trackers.sync_from_drive_folder. Accepts a folder link, id or name. Read-only; uses the Google credentials of the person who asks.',
  inputSchema: z.object({
    folder: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Google Drive folder link, id or exact name.'),
    includeSubfolders: z
      .boolean()
      .optional()
      .describe(
        'Omit to include subfolders when the folder has them (up to 3 levels, 500 files); false to read only the folder itself.',
      ),
  }),
  outputSchema: z.object({
    folder: z.object({ id: z.string(), name: z.string() }),
    recursive: z.boolean(),
    inventory: z.object({
      total: z.number().int(),
      sheets: z.number().int(),
      documents: z.number().int(),
      images: z.number().int(),
      unreadable: z.number().int(),
      subfolders: z.array(z.object({ path: z.string(), files: z.number().int() })),
    }),
    name: z.string(),
    fields: z.array(z.record(z.unknown())),
    keyFields: z.array(z.string()),
    duplicates: z.record(z.unknown()).nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const drive: DriveAccess = { integrations: ctx.integrations, signal: ctx.signal };
    const folder = await resolveFolder(drive, input.folder);
    const p = await proposeFromDriveFolder(drive, folder, {
      includeSubfolders: input.includeSubfolders,
    });
    const { why: _why, ...duplicates } = p.duplicates ?? { why: '' };
    return {
      folder: p.folder,
      recursive: p.recursive,
      inventory: {
        total: p.inventory.total,
        sheets: p.inventory.counts.sheet,
        documents: p.inventory.counts.document,
        images: p.inventory.counts.image,
        unreadable: p.inventory.counts.unreadable,
        subfolders: p.inventory.folders.map((f) => ({ path: f.path, files: f.files })),
      },
      name: p.name,
      fields: p.fields as unknown as Record<string, unknown>[],
      keyFields: p.keyFields,
      duplicates: p.duplicates ? (duplicates as Record<string, unknown>) : null,
      markdown: p.markdown,
    };
  },
});

export const trackersDriveSyncs = registerTool({
  id: 'trackers.drive_syncs',
  description:
    'List the tables that fill themselves from Google Drive folders: which folder, which table, how often, the last run (files read, rows added, rows to review, files that failed) and the latest files that need review or failed, with the reason. Read-only.',
  inputSchema: z.object({}),
  outputSchema: z.object({ markdown: z.string(), total: z.number().int() }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const syncs = await listDriveFolderSyncs(ctx.db);
    if (!syncs.length)
      return {
        total: 0,
        markdown:
          'Ninguna tabla se llena desde una carpeta de Drive todavía. Se configura con trackers.sync_from_drive_folder.',
      };
    const blocks = syncs.map((s) => {
      const head = `- **${s.tracker?.name ?? 'Tabla borrada'}** ← carpeta «${s.folder_name || s.folder_id}» · cada ${s.interval_minutes} min · ${s.enabled ? 'activa' : 'en pausa'}`;
      const last = s.last_run_at
        ? `  Última: ${s.last_run_at.slice(0, 16).replace('T', ' ')} UTC — ${
            s.last_status === 'error'
              ? `error: ${s.last_error}`
              : `${s.last_files} archivos, +${s.last_inserted} nuevas, ${s.last_updated} actualizadas, ${s.last_needs_review} por revisar, ${s.last_failed} con error`
          }`
        : '  Todavía no ha corrido.';
      const problems = s.problems.map(
        (p) =>
          `  - «${p.file_name}» ${p.status === 'error' ? `no se pudo leer: ${p.error ?? ''}` : `por revisar: ${p.notes.slice(0, 3).join(' ')}`}`,
      );
      return [head, last, ...problems].join('\n');
    });
    return { total: syncs.length, markdown: blocks.join('\n') };
  },
});
