import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { getDuplicateRule } from '../trackers/duplicates';
import {
  FIELD_TYPES,
  type TrackerField,
  coerceValue,
  trackerFieldsSchema,
  trackerSlugSchema,
} from '../trackers/schema';
import { defineTracker, getTrackerBySlug } from '../trackers/store';
import {
  type DriveAccess,
  driveFolderMeta,
  findDriveFolders,
  listDriveFolderSyncs,
  listFolderFiles,
  upsertDriveFolderSync,
} from './engine';
import {
  DRIVE_TABLE_PRESETS,
  type ExtractField,
  REVIEW_FIELD,
  compact,
  findReviewField,
  parseFolderRef,
} from './plan';
import { proposeTableFromFolder } from './propose';

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

async function resolveFolder(drive: DriveAccess, ref: string) {
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
    'Make a company table fill itself from the documents dropped in a Google Drive folder (PDF, Word, Excel, Google Docs/Sheets): every few minutes each new or changed file is read and its fields become a row (or several rows if the file lists several records), identified by key fields (e.g. the invoice or waybill number). Works for any document type: supplier invoices, purchase orders, delivery notes, waybills, CVs, contracts. Values are only stored when a literal sentence of the document backs them; doubtful or missing ones leave the row marked "Por revisar". Fields come from `fields`, or a `preset`, or the existing table, or — if none — they are proposed from a sample file in the folder. Creates the table if missing. Runs with the Google credentials of the person who asks. Requires confirmation.',
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
    preset: z
      .enum(PRESET_IDS)
      .optional()
      .describe(
        'Optional starting point: guias_aereas (air waybills), facturas_proveedor (supplier invoices), ordenes_compra (purchase orders). Omit for anything else.',
      ),
    fields: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          label: z.string().trim().min(1).max(60),
          type: z.enum(FIELD_TYPES),
          options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
          hint: z
            .string()
            .trim()
            .max(200)
            .optional()
            .describe('Where the value is in the document.'),
          fromDocument: z
            .boolean()
            .default(true)
            .describe('false for fields the team fills (status, owner), not read from files.'),
        }),
      )
      .min(1)
      .max(19)
      .optional()
      .describe('The columns, when the person says which ones. Omit to use preset/table/sample.'),
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
    let description = existing?.description ?? '';
    let proposedFrom: string | null = null;

    if (input.fields?.length) {
      wanted = input.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: false,
        ...(f.options?.length ? { options: f.options } : {}),
      }));
      extract = input.fields
        .filter((f) => f.fromDocument !== false)
        .map((f) => ({ key: f.key, hint: f.hint ?? '' }));
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
      const files = await listFolderFiles(drive, folder.id);
      const proposal = await proposeTableFromFolder(drive, files);
      wanted = proposal.fields;
      extract = proposal.extract;
      if (!keyRefs.length) keyRefs = proposal.keyFields;
      name ??= proposal.name;
      description ||= proposal.description;
      proposedFrom = proposal.sampleName;
    }
    if (!extract.length)
      throw new ValidationError('Dime al menos un campo que se lea de los documentos.');

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
            ...(!existing && preset?.duplicates ? { duplicates: preset.duplicates } : {}),
          })
        ).tracker
      : existing;

    // 3. La clave, que tiene que leerse del documento.
    const extractable = extract.filter((e) => tracker.fields.some((f) => f.key === e.key));
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
      if (!extractable.some((e) => e.key === key))
        throw new ValidationError(
          `«${ref}» identifica la fila, así que tiene que leerse de los documentos.`,
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
      extractable.some((e) => e.key === rule.distinctBy)
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
    });
    const queued = await ctx.enqueueJob?.('drive-table/run', {
      organizationId: ctx.organizationId,
      syncId: sync.id,
    });

    const read = extractable
      .map((e) => tracker.fields.find((f) => f.key === e.key)?.label)
      .filter(Boolean)
      .join(', ');
    const keyLabels = keyFields
      .map((k) => tracker.fields.find((f) => f.key === k)?.label ?? k)
      .join(' + ');
    const lines = [
      `${existing ? `La tabla **${tracker.name}**` : `Creé la tabla **${tracker.name}** (\`${tracker.slug}\`), que`} se va a llenar con los archivos de la carpeta «${folder.name}», cada ${sync.interval_minutes} minutos.`,
      proposedFrom
        ? `Propuse las columnas leyendo «${proposedFrom}»; si quieres otras, las cambio.`
        : '',
      `De cada archivo leo: ${read}. Cada fila se identifica por ${keyLabels}.`,
      'Sólo guardo un valor si está escrito en el documento; lo dudoso o lo que falte deja la fila «Por revisar».',
      queued
        ? 'Ya empecé la primera lectura; te aviso en la campana cuando entren filas.'
        : `La primera lectura empieza en los próximos ${sync.interval_minutes} minutos; te aviso en la campana.`,
    ].filter(Boolean);
    return {
      status: 'scheduled' as const,
      table: tracker.slug,
      fields: tracker.fields.map((f) => f.key),
      markdown: lines.join('\n'),
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
