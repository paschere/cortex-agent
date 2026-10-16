import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { duplicateRuleSchema, getDuplicateRule } from './duplicates';
import {
  displayTrackerValue,
  trackerFieldSchema,
  trackerFieldsSchema,
  trackerSlugSchema,
} from './schema';
import {
  defineTracker,
  getTrackerBySlug,
  listTrackers,
  queryRows,
  removeRow,
  removeTracker,
  upsertRow,
} from './store';

/**
 * Tablas que esta empresa se inventa.
 *
 * No sustituyen a clientes, vencimientos, cartera ni vehículos. Esas cosas
 * ya tienen módulo, y colgarlas aquí duplicaría la fuente. Esto es para lo
 * que no cabe ahí: un tablero de remates, números de contenedor, las placas
 * que un cliente quiere vigilar aparte. El agente define los campos, llena
 * las filas y las consulta. Quien lee el chat ve una tabla.
 */

const trackerSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  fields: z.array(trackerFieldSchema),
  rowCount: z.number().int().optional(),
  duplicates: duplicateRuleSchema.nullish(),
});

const entrySchema = z.object({
  id: z.string(),
  label: z.string(),
  values: z.record(z.union([z.string(), z.number()])),
  updatedAt: z.string(),
});

function fieldsMarkdown(fields: z.infer<typeof trackerFieldsSchema>): string {
  return fields
    .map((f) => {
      const rules = [
        f.required ? 'obligatorio' : null,
        f.unique ? 'único' : null,
        f.format ?? null,
        f.showIf ? `solo si ${f.showIf.field}` : null,
      ].filter(Boolean);
      const auto = [
        f.formula ? `= ${f.formula}` : null,
        f.lookup ? `trae ${f.lookup.via}.${f.lookup.field}` : null,
        f.autofill ? `Cortex llena ${f.autofill.fills.join('/')}` : null,
      ].filter(Boolean);
      return `${f.label} (${f.key}, ${f.type}${rules.length ? `; ${rules.join(', ')}` : ''}${auto.length ? `; ${auto.join(', ')}` : ''})`;
    })
    .join(', ');
}

export const trackersDefine = registerTool({
  id: 'trackers.define',
  description:
    'Create or update a company-specific table the first-class modules do not cover. Use this when the person needs to track something this workspace has no screen for — remates, container numbers, a custom plate list, a board of invoices that are not in Siigo. Do NOT use it for clients (clients.register), due dates (commitments.record), receivables (payments.*), or fleet plates (vehicles.register). Pass a slug, a name, and the fields; add validations (min/max, format, unique), defaults and showIf conditions when the person describes rules like "required only if there is a problem", "not a future date" or "valid NIT". Creating or changing the schema requires confirmation.',
  inputSchema: z.object({
    slug: trackerSlugSchema.describe('Stable id, e.g. "remates" or "contenedores".'),
    name: z.string().trim().min(1).max(80).describe('What people call it out loud.'),
    description: z
      .string()
      .trim()
      .max(500)
      .default('')
      .describe('One line on what belongs here, so a later turn does not invent a second table.'),
    fields: trackerFieldsSchema.describe(
      'The columns. key is snake_case. type is text, longtext (multi-line notes), number, date (YYYY-MM-DD), time (HH:MM, 24h), money, select, checkbox (yes/no, stored as 1/0), file (photo/upload; accept "image"|"any"|"signature", multiple up to 5; evidence true on a photo field stamps date, time and GPS into the file and watermark true also burns them into the image; type "signature" is a drawn signature stored as an image file), location (GPS "lat,lng") or relation (a row of another table; needs tracker: its slug). select needs options. Every field may also carry, all optional: min/max (number or money; for date "today"/"today-30"/"2026-01-01", for time "now"/"HH:MM" — a date with max "today" cannot be in the future); minLength/maxLength (text); format "email"|"phone"|"nit" (Colombian NIT with check digit)|"plate"|"awb" (air waybill 3-8 digits with mod-7 check digit)|"digits", or pattern (short regex, no nested quantifiers like (a+)+); unique true (blocks a value that already exists in another row — unlike duplicates, which only flags); message (custom error text); default "today"|"now"|"viewer"|fixed value; help, placeholder, example (guidance shown in forms); showIf {field, equals: string|string[] | notEmpty: true} (the field only applies when ANOTHER field matches; hidden fields are not required and are not saved); scan true on a text or longtext field (filled by the camera barcode/QR scanner; scanMode "continuous" keeps the camera open and adds each code on its own line — use it with longtext for counting many items; type "barcode" is a text field with scan). A select field may carry `flow` {states (ordered, all must be in options), transitions [{from,to,roles}] (omit = one after another), requirements {"<state>": [{kind:"field"|"photo"|"signature"|"comment", field:"<column key>"}]}, notify {"<state>": {roles, message}}} — a flow by state the server enforces; to add one to an existing table use trackers.set_flow. FIELDS THAT FILL THEMSELVES (all optional, set on the field): (1) `formula` — a calculated field from OTHER fields of the same row, written like a spreadsheet; `type` is the result type (number, money, date, time, text, checkbox; add percent:true to a number to show it as %). Translate «Total = Kilos × Tarifa» into {key:"total", label:"Total", type:"money", formula:"[Kilos] × [Tarifa]"}. Syntax: fields as [Visible name] or [key]; + − × ÷ (or + - * /), ^, & joins text, parentheses, 20% = 0.2, comparisons = <> < <= > >=; arguments separated by «;» (a «1,5» is ONE number with decimal comma; thousands as 1.234.567); functions redondear(x;dec), redondear_mas, redondear_menos, entero, abs, min, max, suma, promedio, raiz, potencia, residuo, si(cond;a;b), si_error(x;alt), y, o, no, vacio(x), concatenar, unir(sep;a;b…), texto, numero, mayusculas, minusculas, largo, izquierda, derecha, reemplazar, contiene, hoy(), ahora(), fecha(a;m;d), fecha_hora(fecha;hora), dias_entre(desde;hasta), horas_entre, minutos_entre, año/mes/dia/dia_semana, sumar_dias, sumar_meses, fin_de_mes. Date − date = days. Empty input fields leave the result empty; division by zero leaves it empty with a warning. It is computed on save, shown instantly in forms, read-only, and usable in tables, cards, metrics, charts and filters; changing a formula recalculates existing rows. Never reference a field that does not exist or make formulas depend on each other in a loop — the save is rejected with the reason. ALWAYS show the person the formula in plain words before saving (the approval card lists it). (2) `lookup` {via:"<relation field key of THIS table>", field:"<key of a field in the related table>", editable?} — brings a value from the related row (e.g. cliente → nit, tarifa); filled when the relation is chosen; editable true lets the person change it after. (3) `autofill` {instruction:"<plain text>", from:["<trigger field keys, including this field>"], fills:["<keys Cortex proposes>"]} — e.g. on numero_vuelo: {instruction:"Con el número de vuelo identifica la aerolínea y el próximo arribo; llena aerolínea, origen, fecha y hora estimada", from:["numero_vuelo"], fills:["aerolinea","origen","fecha_arribo","hora_arribo"]}. When the triggers are complete (or the person taps «Llenar con Cortex») Cortex looks it up with read-only tools (web, flights if configured, other tables) and proposes values highlighted and editable; it never overwrites what the person already typed and writes nothing without the person saving. Examples: inspection with resultado select ["Conforme","Con novedad"] and descripcion longtext required with showIf {field:"resultado",equals:"Con novedad"}; fecha_recibo date with max "today" and default "today"; nit text with format "nit"; guia text with format "awb" and unique true.',
    ),
    duplicates: duplicateRuleSchema
      .nullish()
      .describe(
        'Optional duplicate rule. When two or more rows share the same `key` value (compared ignoring case, spaces and dashes) AND differ in `distinctBy`, ALL of them get `flagValue` written into `flagField`; the mark disappears by itself once the conflict is fixed (a date corrected, a row deleted). Example for air waybills: {key:"numero_guia", distinctBy:"fecha", flagField:"estado", flagValue:"Duplicada"}. Omit distinctBy to flag ANY repeated key. flagField must be a select that has flagValue among its options (or a text field), and different from key/distinctBy. Omit `duplicates` to leave the current rule untouched; pass null to remove it.',
      ),
  }),
  outputSchema: z.object({
    tracker: trackerSummary,
    created: z.boolean(),
    /** Dónde está la tabla en la app (ruta relativa). */
    url: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const fields = trackerFieldsSchema.parse(input.fields);
    const { tracker, created } = await defineTracker(ctx.db, {
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      fields,
      userId: ctx.userId,
      duplicates: input.duplicates ? duplicateRuleSchema.parse(input.duplicates) : input.duplicates,
    });
    const rule = (await getDuplicateRule(ctx.db, tracker.id))?.rule ?? null;
    const ruleNote = rule
      ? ` Regla de duplicados: si «${rule.key}» se repite${rule.distinctBy ? ` con distinto «${rule.distinctBy}»` : ''}, se marca «${rule.flagValue}» en «${rule.flagField}».`
      : '';
    return {
      tracker: {
        id: tracker.id,
        slug: tracker.slug,
        name: tracker.name,
        description: tracker.description,
        fields: tracker.fields,
        duplicates: rule,
      },
      created,
      url: `/trackers/${tracker.slug}`,
      markdown: created
        ? `Tabla **${tracker.name}** creada (\`${tracker.slug}\`). Campos: ${fieldsMarkdown(tracker.fields)}.${ruleNote} Para llenarla usa trackers.upsert; para verla, trackers.query.`
        : `Tabla **${tracker.name}** actualizada (\`${tracker.slug}\`). Campos ahora: ${fieldsMarkdown(tracker.fields)}.${ruleNote}`,
    };
  },
});

export const trackersList = registerTool({
  id: 'trackers.list',
  description:
    'List the company-specific tables this workspace invented. Use it when someone asks what boards you are keeping, or before creating a new one so you do not duplicate. Read-only.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(40).default(20),
  }),
  outputSchema: z.object({
    trackers: z.array(trackerSummary),
    total: z.number().int(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const rows = await listTrackers(ctx.db, input.limit ?? 20);
    const trackers = rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      fields: t.fields,
      rowCount: t.rowCount,
    }));
    const markdown =
      trackers.length === 0
        ? 'Todavía no hay tablas inventadas en este espacio. Se crean con trackers.define cuando algo no cabe en clientes, vencimientos, cartera o vehículos.'
        : trackers
            .map((t) => {
              const n = t.rowCount ?? 0;
              const count = n === 1 ? '1 fila' : `${n} filas`;
              return `- **${t.name}** (\`${t.slug}\`) — ${count}${t.description ? `. ${t.description}` : ''}`;
            })
            .join('\n');
    return { trackers, total: trackers.length, markdown };
  },
});

export const trackersQuery = registerTool({
  id: 'trackers.query',
  description:
    'Read the rows of a company-specific table. Use it when someone asks what is in a board you defined (plates, remates, containers). Filter with equals when they name one field and one value. Read-only. The table is identified by its slug.',
  inputSchema: z.object({
    tracker: trackerSlugSchema.describe('The slug of the table, e.g. "remates".'),
    equals: z
      .object({
        key: z.string().min(1).max(32),
        value: z.string().min(1).max(200),
      })
      .optional()
      .describe('Keep only rows whose field equals this value.'),
    limit: z.number().int().min(1).max(80).default(40),
  }),
  outputSchema: z.object({
    tracker: trackerSummary,
    rows: z.array(entrySchema),
    total: z.number().int(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) {
      throw new NotFoundError(
        `No hay una tabla «${input.tracker}» en este espacio. Mira trackers.list o créala con trackers.define.`,
      );
    }
    if (input.equals && !tracker.fields.some((f) => f.key === input.equals?.key)) {
      throw new ValidationError(
        `«${input.equals.key}» no es un campo de ${tracker.name}. Campos: ${tracker.fields.map((f) => f.key).join(', ')}.`,
      );
    }
    const rows = await queryRows(ctx.db, {
      trackerId: tracker.id,
      equals: input.equals,
      limit: input.limit ?? 40,
    });
    const summary = {
      id: tracker.id,
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields: tracker.fields,
    };
    const mapped = rows.map((r) => ({
      id: r.id,
      label: r.label,
      values: r.values,
      updatedAt: r.updated_at,
    }));
    const markdown =
      mapped.length === 0
        ? `La tabla **${tracker.name}** no tiene filas${input.equals ? ' con ese filtro' : ''}. Se llenan con trackers.upsert.`
        : mapped
            .map((r) => {
              const bits = tracker.fields
                .map((f) => {
                  const v = r.values[f.key];
                  return v === undefined || v === ''
                    ? null
                    : `${f.label}: ${displayTrackerValue(f, v)}`;
                })
                .filter(Boolean);
              return `- **${r.label}**${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
            })
            .join('\n');
    return { tracker: summary, rows: mapped, total: mapped.length, markdown };
  },
});

export const trackersUpsert = registerTool({
  id: 'trackers.upsert',
  description:
    'Add or update a row in a company-specific table. Use it when the person gives you a new item for a board you already defined, or a correction to one. Pass the slug, the field values, and optionally the row id to update. Do not invent fields that are not in the schema — change the schema with trackers.define first.',
  inputSchema: z.object({
    tracker: trackerSlugSchema,
    rowId: z.string().uuid().optional().describe('If set, updates that row instead of inserting.'),
    values: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .describe(
        'Map of field key to value. Keys must exist on the table. checkbox takes true/false (or "sí"/"no"); time takes "HH:MM"; location takes "lat,lng"; relation takes the target row id; file takes a JSON {url,name,mime,size}. Rules of the field (min/max, format, unique, showIf) are enforced: a rejected value comes back as an error to fix. If the table has a duplicate rule, a row that repeats a key with a different date comes back flagged — tell the person.',
      ),
    label: z
      .string()
      .max(200)
      .optional()
      .describe('How to name the row out loud. Defaults to the first required text field.'),
  }),
  outputSchema: z.object({
    row: entrySchema,
    tracker: z.object({ slug: z.string(), name: z.string() }),
    created: z.boolean(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  // Para poder deshacer una edición: los valores de antes de los campos que
  // esta llamada va a escribir (sólo los que ya tenían valor).
  audit: {
    before: async (input, ctx) => {
      if (!input.rowId) return null;
      const tracker = await getTrackerBySlug(ctx.db, input.tracker);
      if (!tracker) return null;
      const prior = await ctx.db
        .from('tracker_rows')
        .select('values')
        .eq('id', input.rowId)
        .eq('tracker_id', tracker.id)
        .maybeSingle();
      if (prior.error || !prior.data) return null;
      const previous = (prior.data as { values?: Record<string, unknown> }).values ?? {};
      const picked: Record<string, unknown> = {};
      for (const key of Object.keys(input.values)) {
        // Un campo que no tenía valor no se puede «restaurar» a vacío: no se
        // ofrece deshacer si la edición toca alguno.
        if (!(key in previous)) return null;
        picked[key] = previous[key];
      }
      return picked;
    },
  },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) {
      throw new NotFoundError(
        `No hay una tabla «${input.tracker}» en este espacio. Créala con trackers.define antes de llenarla.`,
      );
    }
    const row = await upsertRow(ctx.db, {
      tracker,
      rowId: input.rowId,
      values: input.values,
      label: input.label,
      userId: ctx.userId,
    });
    const created = !input.rowId;
    // `upsertRow` ya aplicó la regla de duplicados: si la fila quedó marcada, se dice.
    const rule = (await getDuplicateRule(ctx.db, tracker.id))?.rule;
    const flagged = Boolean(rule && String(row.values[rule.flagField] ?? '') === rule.flagValue);
    const warning = flagged
      ? ` ⚠ Quedó marcada «${rule?.flagValue}»: «${rule?.key}» se repite en otra fila${rule?.distinctBy ? ` con distinto «${rule.distinctBy}»` : ''}. Hay que corregir una de las dos.`
      : '';
    return {
      row: { id: row.id, label: row.label, values: row.values, updatedAt: row.updated_at },
      tracker: { slug: tracker.slug, name: tracker.name },
      created,
      markdown:
        (created
          ? `Anotado en **${tracker.name}**: ${row.label}.`
          : `Actualizado en **${tracker.name}**: ${row.label}.`) + warning,
    };
  },
});

export const trackersRemove = registerTool({
  id: 'trackers.remove',
  description:
    'Delete a row, or the whole company-specific table. Pass rowId to delete one row; omit it to drop the table and every row in it. Dropping a table requires confirmation. Prefer this over emptying rows one by one when the person says the board should no longer exist.',
  inputSchema: z.object({
    tracker: trackerSlugSchema,
    rowId: z.string().uuid().optional(),
  }),
  outputSchema: z.object({
    removed: z.boolean(),
    droppedTable: z.boolean(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) {
      throw new NotFoundError(`No hay una tabla «${input.tracker}» en este espacio.`);
    }
    if (input.rowId) {
      const removed = await removeRow(ctx.db, tracker.id, input.rowId);
      return {
        removed,
        droppedTable: false,
        markdown: removed
          ? `Saqué esa fila de **${tracker.name}**.`
          : `Esa fila ya no estaba en **${tracker.name}**.`,
      };
    }
    const dropped = await removeTracker(ctx.db, tracker.slug);
    return {
      removed: dropped,
      droppedTable: dropped,
      markdown: dropped
        ? `Eliminé la tabla **${tracker.name}** y todas sus filas.`
        : `La tabla **${tracker.name}** ya no estaba.`,
    };
  },
});
