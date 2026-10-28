import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { notFoundWithHints } from '../not-found-hints';
import { duplicateKeyFor, duplicateSentence, findLikelyDuplicates } from './duplicate-check';
import { duplicateRuleSchema, getDuplicateRule, normalizeDuplicateKey } from './duplicates';
import {
  FIELD_KEY_RE,
  displayTrackerValue,
  trackerFieldSchema,
  trackerFieldsPartialSchema,
  trackerFieldsSchema,
  trackerSlugSchema,
} from './schema';
import { countFieldValues, fieldUsesSentence, findFieldUses } from './field-usage';
import { mergeFields } from './merge-fields';
import { creatingOrigin, originName, originsOf } from './origin';
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
    'Create or update a company-specific table the first-class modules do not cover. Use this when the person needs to track something this workspace has no screen for — remates, container numbers, a custom plate list, a board of invoices that are not in Siigo. Do NOT use it for clients (clients.register), due dates (commitments.record), receivables (payments.*), or fleet plates (vehicles.register). Pass a slug, a name, and the fields; add validations (min/max, format, unique), defaults and showIf conditions when the person describes rules like "required only if there is a problem", "not a future date" or "valid NIT". Creating or changing the schema requires confirmation. ON AN EXISTING TABLE the call MERGES: the fields you pass are added or replaced by key and every other field is KEPT — you only need to send the new or changed fields. To drop a field you must name it in removeFields (the approval card shows it in red with how many saved values it holds; screens that use it are listed as broken). Never remove a field just to "clean up". ON A TABLE THAT COMES FROM AN INTEGRATION (Siigo/Alegra/QuickBooks, a Google Sheet, a Drive folder) you may only ADD or change the OWN fields of the company: the fields the source writes cannot be changed or removed (the save is rejected naming the source) — add fields like «estado de cobro interno» or «responsable» on top and they survive every sync. To fill a field from a fixed equivalence (airline from a flight code, bank, country) prefer `match` (a lookup list, no AI) over `autofill`; use autofill (Cortex) only for data that needs reasoning or the web, or as the fallback after a match.',
  inputSchema: z.object({
    slug: trackerSlugSchema.describe('Stable id, e.g. "remates" or "contenedores".'),
    name: z.string().trim().min(1).max(80).describe('What people call it out loud.'),
    description: z
      .string()
      .trim()
      .max(500)
      .default('')
      .describe('One line on what belongs here, so a later turn does not invent a second table.'),
    fields: trackerFieldsPartialSchema.describe(
      'The columns. key is snake_case. type is text, longtext (multi-line notes), number, date (YYYY-MM-DD), time (HH:MM, 24h), money, select, checkbox (yes/no, stored as 1/0), file (photo/upload; accept "image"|"any"|"signature", multiple up to 5; evidence true on a photo field stamps date, time and GPS into the file and watermark true also burns them into the image; type "signature" is a drawn signature stored as an image file), location (GPS "lat,lng") or relation (a row of another table; needs tracker: its slug). select needs options. Every field may also carry, all optional: min/max (number or money; for date "today"/"today-30"/"2026-01-01", for time "now"/"HH:MM" — a date with max "today" cannot be in the future); minLength/maxLength (text); format "email"|"phone"|"nit" (Colombian NIT with check digit)|"plate"|"awb" (air waybill 3-8 digits with mod-7 check digit)|"digits", or pattern (short regex, no nested quantifiers like (a+)+); unique true (blocks a value that already exists in another row — unlike duplicates, which only flags); message (custom error text); default "today"|"now"|"viewer"|fixed value; help, placeholder, example (guidance shown in forms); showIf {field, equals: string|string[] | notEmpty: true} (the field only applies when ANOTHER field matches; hidden fields are not required and are not saved); scan true on a text or longtext field (filled by the camera barcode/QR scanner; scanMode "continuous" keeps the camera open and adds each code on its own line — use it with longtext for counting many items; type "barcode" is a text field with scan). A select field may carry `flow` {states (ordered, all must be in options), transitions [{from,to,roles}] (omit = one after another), requirements {"<state>": [{kind:"field"|"photo"|"signature"|"comment", field:"<column key>"}]}, notify {"<state>": {roles, message}}} — a flow by state the server enforces; to add one to an existing table use trackers.set_flow. FIELDS THAT FILL THEMSELVES (all optional, set on the field): (1) `formula` — a calculated field from OTHER fields of the same row, written like a spreadsheet; `type` is the result type (number, money, date, time, text, checkbox; add percent:true to a number to show it as %). Translate «Total = Kilos × Tarifa» into {key:"total", label:"Total", type:"money", formula:"[Kilos] × [Tarifa]"}. Syntax: fields as [Visible name] or [key]; + − × ÷ (or + - * /), ^, & joins text, parentheses, 20% = 0.2, comparisons = <> < <= > >=; arguments separated by «;» (a «1,5» is ONE number with decimal comma; thousands as 1.234.567); functions redondear(x;dec), redondear_mas, redondear_menos, entero, abs, min, max, suma, promedio, raiz, potencia, residuo, si(cond;a;b), si_error(x;alt), y, o, no, vacio(x), concatenar, unir(sep;a;b…), texto, numero, mayusculas, minusculas, largo, izquierda, derecha, reemplazar, contiene, hoy(), ahora(), fecha(a;m;d), fecha_hora(fecha;hora), dias_entre(desde;hasta), horas_entre, minutos_entre, año/mes/dia/dia_semana, sumar_dias, sumar_meses, fin_de_mes, trm([fecha]) (the official TRM in pesos per dollar valid that day — weekends and holidays included —; without a date, the one of today; empty with a warning when the date has no published TRM; e.g. Total COP = [Total USD] × trm([Fecha traslado])). A money field may carry currency "USD" (3-letter ISO code; default COP): it is shown with that currency (USD with 2 decimals, COP in full pesos). Date − date = days. Empty input fields leave the result empty; division by zero leaves it empty with a warning. It is computed on save, shown instantly in forms, read-only, and usable in tables, cards, metrics, charts and filters; changing a formula recalculates existing rows. Never reference a field that does not exist or make formulas depend on each other in a loop — the save is rejected with the reason. ALWAYS show the person the formula in plain words before saving (the approval card lists it). (2) `lookup` {via:"<relation field key of THIS table>", field:"<key of a field in the related table>", editable?} — brings a value from the related row (e.g. cliente → nit, tarifa); filled when the relation is chosen; editable true lets the person change it after. (2b) `match` — «Buscar en una lista», NO AI, instant, works offline: {from:"<trigger field key, usually this field>", extract?:{mode:"full"}|{mode:"prefix",length:2}|{mode:"regex",pattern:"^([A-Z0-9]{2})"}, source:"cortex.aerolineas"|<slug of a table of this workspace>, key:"<column of the source with the code>", fills:{"<target field key>":"<source column>"}}. The trigger is normalised (uppercase, no spaces/dashes/accents) and the key is looked up; if found, the target fields are proposed (never overwriting what the person typed). PREFER IT over `autofill` whenever the data is a fixed equivalence (flight code to airline, IATA to city, bank to code, currency). Platform lists: cortex.aerolineas (codigo,nombre,pais), cortex.aeropuertos (codigo,nombre,ciudad,pais), cortex.bancos_colombia (codigo,nombre,tipo), cortex.monedas (codigo,nombre,simbolo), cortex.trm (vigencia_desde,vigencia_hasta,valor: the OFFICIAL TRM of the Superfinanciera, updated daily; matched by DATE, not by code: the row whose validity covers the date, weekends and holidays included — e.g. on fecha_traslado: {match:{from:"fecha_traslado",source:"cortex.trm",key:"vigencia_desde",fills:{trm:"valor"}}}, so the TRM field fills itself and stays editable). Example on numero_vuelo: {match:{from:"numero_vuelo",extract:{mode:"prefix",length:2},source:"cortex.aerolineas",key:"codigo",fills:{aerolinea:"nombre"}}}. CASCADE: the same field may also carry `autofill`; Cortex then runs ONLY if the list found nothing (autofill.when "no_match", the default) or, with autofill.when "rest", completes the targets the list did not fill (e.g. date and time of the flight). (3) `autofill` {instruction:"<plain text>", from:["<trigger field keys, including this field>"], fills:["<keys Cortex proposes>"]} — e.g. on numero_vuelo: {instruction:"Con el número de vuelo identifica la aerolínea y el próximo arribo; llena aerolínea, origen, fecha y hora estimada", from:["numero_vuelo"], fills:["aerolinea","origen","fecha_arribo","hora_arribo"]}. When the triggers are complete (or the person taps «Llenar con Cortex») Cortex looks it up with read-only tools (web, flights if configured, other tables) and proposes values highlighted and editable; it never overwrites what the person already typed and writes nothing without the person saving. Examples: inspection with resultado select ["Conforme","Con novedad"] and descripcion longtext required with showIf {field:"resultado",equals:"Con novedad"}; fecha_recibo date with max "today" and default "today"; nit text with format "nit"; guia text with format "awb" and unique true.',
    ),
    removeFields: z
      .array(z.string().regex(FIELD_KEY_RE))
      .max(20)
      .optional()
      .describe(
        'Keys of fields to REMOVE from an existing table. The only way to drop a field: omitting a field from `fields` keeps it. Values already saved in rows are not erased but stop showing, and screens/views that use the field break, so ask the person first.',
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
    const before = await getTrackerBySlug(ctx.db, input.slug);
    const incoming = trackerFieldsPartialSchema.parse(input.fields);
    let merge: ReturnType<typeof mergeFields<(typeof incoming)[number]>>;
    try {
      merge = mergeFields(before?.fields ?? [], incoming, input.removeFields ?? []);
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : 'Campos inválidos.');
    }
    // La coherencia (fórmulas, showIf, flujo, autofill) se valida sobre la definición completa.
    const fields = trackerFieldsSchema.parse(merge.fields);
    const broken =
      before && merge.removed.length
        ? fieldUsesSentence(await findFieldUses(ctx.db, input.slug, merge.removed))
        : '';
    const savedValues =
      before && merge.removed.length ? await countFieldValues(ctx.db, before.id, merge.removed) : {};
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
        : `Tabla **${tracker.name}** actualizada (\`${tracker.slug}\`). Campos ahora: ${fieldsMarkdown(tracker.fields)}.${ruleNote}${
            merge.removed.length
              ? ` Se quitaron: ${merge.removed.map((k) => `${k} (${savedValues[k] ?? 0} valores guardados)`).join(', ')}.${broken ? ` Pantallas que los usaban y ahora avisan: ${broken}.` : ''}`
              : ''
          }${merge.unknownRemovals.length ? ` (removeFields no encontró: ${merge.unknownRemovals.join(', ')}.)` : ''}`,
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
      origins: t.origins ?? [],
      rowCount: t.rowCount,
    }));
    const markdown =
      trackers.length === 0
        ? 'Todavía no hay tablas inventadas en este espacio. Se crean con trackers.define cuando algo no cabe en clientes, vencimientos, cartera o vehículos.'
        : trackers
            .map((t) => {
              const n = t.rowCount ?? 0;
              const count = n === 1 ? '1 fila' : `${n} filas`;
              const from = originsOf(t)[0];
              const src = from
                ? ` · viene de ${originName(from)}: sólo lectura salvo campos propios${creatingOrigin(t) ? ', sin filas a mano' : ''}`
                : '';
              return `- **${t.name}** (\`${t.slug}\`) — ${count}${src}${t.description ? `. ${t.description}` : ''}`;
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
        await notFoundWithHints(
          ctx.db,
          `No hay una tabla «${input.tracker}» en este espacio. Mira trackers.list o créala con trackers.define.`,
          input.tracker,
          'tabla',
        ),
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
    'Add or update a row in a company-specific table. Use it when the person gives you a new item for a board you already defined, or a correction to one. Pass the slug, the field values, and optionally the row id to update. Do not invent fields that are not in the schema — change the schema with trackers.define first. ONE row per call: for two or more rows use trackers.upsert_many (rows: [...], up to 200, one call). Tables that come from an integration (Siigo, a Sheet, a Drive folder) accept writes ONLY on the company\'s own fields: writing a source field, or adding a row by hand, is rejected with a message saying where to change it (for Siigo, the «Por enviar a Siigo» tray).',
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
    allowDuplicate: z
      .boolean()
      .optional()
      .describe(
        'Creating a row that looks like one that already exists (same key, or same name) is NOT done: the existing row comes back instead and you tell the person. Pass true ONLY after the person confirms they really want a second one.',
      ),
  }),
  outputSchema: z.object({
    row: entrySchema,
    tracker: z.object({ slug: z.string(), name: z.string() }),
    created: z.boolean(),
    duplicateOf: z.string().uuid().optional(),
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
        await notFoundWithHints(
          ctx.db,
          `No hay una tabla «${input.tracker}» en este espacio. Créala con trackers.define antes de llenarla.`,
          input.tracker,
          'tabla',
        ),
      );
    }
    // Crear lo que ya existe es el duplicado de siempre: se avisa y no se crea.
    if (!input.rowId && !input.allowDuplicate) {
      const found = await findLikelyDuplicates(ctx.db, tracker, input.values, { limit: 3 });
      const first = found.matches[0];
      if (first)
        return {
          row: { id: first.id, label: first.label, values: first.values as Record<string, string | number>, updatedAt: first.updatedAt },
          tracker: { slug: tracker.slug, name: tracker.name },
          created: false,
          duplicateOf: first.id,
          markdown: `${duplicateSentence(found.matches)} en **${tracker.name}**: no la creé de nuevo. Si quieres cambiarla, edítala con rowId \`${first.id}\`; si de verdad quieres una segunda, confírmalo con la persona y repite con allowDuplicate=true.`,
        };
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

export const MAX_UPSERT_MANY_ROWS = 200;

export const trackersUpsertMany = registerTool({
  id: 'trackers.upsert_many',
  description: `Add (or update) MANY rows of a company-specific table in ONE call (up to ${MAX_UPSERT_MANY_ROWS}). Use it whenever there is more than one row to write — loading a price list, a spreadsheet, a month of receipts. Do NOT call trackers.upsert once per row: it hits the per-minute limit and wastes turns. Pass the slug and rows: [{ values: {fieldKey: value, ...}, label?, rowId? }]. Same rules as trackers.upsert for each row (keys must exist on the table; types, options, required, unique and showIf are enforced). Rows are written in order; a row that is rejected does NOT stop the others: the result lists which ones failed and why, so fix only those and send them again. If the call runs out of time it reports how many rows are left: send the rest in another call. Counts as ONE call for the rate limit. Tables that come from an integration (Siigo, a Sheet, a Drive folder) reject rows by hand and writes to the source\'s fields; only the company\'s own fields can be written.`,
  inputSchema: z.object({
    tracker: trackerSlugSchema,
    rows: z
      .array(
        z.object({
          values: z.record(z.union([z.string(), z.number(), z.boolean()])),
          label: z.string().max(200).optional(),
          rowId: z
            .string()
            .uuid()
            .optional()
            .describe('If set, updates that row instead of inserting.'),
        }),
      )
      .min(1)
      .max(MAX_UPSERT_MANY_ROWS),
    allowDuplicates: z
      .boolean()
      .optional()
      .describe(
        'New rows that look like ones already in the table (same key or name), or repeat each other inside this call, are SKIPPED and reported instead of duplicated. Pass true ONLY after the person confirms they want them anyway.',
      ),
  }),
  outputSchema: z.object({
    tracker: z.object({ slug: z.string(), name: z.string() }),
    created: z.number().int(),
    updated: z.number().int(),
    skippedDuplicates: z
      .array(z.object({ index: z.number().int(), label: z.string(), existing: z.string() }))
      .optional(),
    failed: z.array(z.object({ index: z.number().int(), label: z.string(), error: z.string() })),
    remaining: z.number().int(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) {
      throw new NotFoundError(
        await notFoundWithHints(
          ctx.db,
          `No hay una tabla «${input.tracker}» en este espacio. Créala con trackers.define antes de llenarla.`,
          input.tracker,
          'tabla',
        ),
      );
    }
    // Un tope propio para no agotar el turno: lo que no alcance se informa y se
    // reenvía en otra llamada (cada fila son varias idas a la base).
    const budgetMs = Math.max(15_000, Math.min(120_000, (ctx.turnMsLeft?.() ?? 120_000) - 20_000));
    const deadline = Date.now() + budgetMs;
    let created = 0;
    let updated = 0;
    let processed = 0;
    const failed: Array<{ index: number; label: string; error: string }> = [];
    const skipped: Array<{ index: number; label: string; existing: string }> = [];
    const ruleKey = (await getDuplicateRule(ctx.db, tracker.id))?.rule.key ?? null;
    const keyOfRow = duplicateKeyFor(tracker.fields, ruleKey);
    const seenInCall = new Set<string>();
    for (const [index, item] of input.rows.entries()) {
      if (Date.now() > deadline || ctx.signal?.aborted) break;
      processed = index + 1;
      try {
        if (!item.rowId && !input.allowDuplicates && keyOfRow) {
          const mine = item.values[keyOfRow.field.key];
          const norm =
            keyOfRow.mode === 'key'
              ? normalizeDuplicateKey(mine)
              : String(mine ?? '').trim().toLowerCase();
          const label0 = item.label ?? String(mine ?? `fila ${index + 1}`);
          if (norm && seenInCall.has(norm)) {
            skipped.push({ index, label: label0, existing: 'otra fila de esta misma llamada' });
            continue;
          }
          const found = await findLikelyDuplicates(ctx.db, tracker, item.values, { ruleKey, limit: 1 });
          if (found.matches[0]) {
            skipped.push({ index, label: label0, existing: found.matches[0].label });
            continue;
          }
          if (norm) seenInCall.add(norm);
        }
        await upsertRow(ctx.db, {
          tracker,
          rowId: item.rowId,
          values: item.values,
          label: item.label,
          userId: ctx.userId,
        });
        if (item.rowId) updated += 1;
        else created += 1;
      } catch (err) {
        failed.push({
          index,
          label: item.label ?? String(Object.values(item.values)[0] ?? `fila ${index + 1}`),
          error: err instanceof Error ? err.message.slice(0, 240) : 'No se pudo guardar.',
        });
      }
    }
    const remaining = input.rows.length - processed;
    const parts = [
      `En **${tracker.name}**: ${created} fila${created === 1 ? '' : 's'} nueva${created === 1 ? '' : 's'}`,
      updated ? `${updated} actualizada${updated === 1 ? '' : 's'}` : null,
      skipped.length
        ? `${skipped.length} ya existía${skipped.length === 1 ? '' : 'n'} (no se duplicaron)`
        : null,
      failed.length ? `${failed.length} con error` : null,
    ].filter(Boolean);
    const skippedLines = skipped
      .slice(0, 15)
      .map((f) => `- fila ${f.index + 1} (${f.label}): ya existe «${f.existing}»`)
      .join('\n');
    const lines = failed
      .slice(0, 15)
      .map((f) => `- fila ${f.index + 1} (${f.label}): ${f.error}`)
      .join('\n');
    return {
      tracker: { slug: tracker.slug, name: tracker.name },
      created,
      updated,
      failed: failed.slice(0, 50),
      ...(skipped.length ? { skippedDuplicates: skipped.slice(0, 50) } : {}),
      remaining,
      markdown: `${parts.join(', ')}.${skippedLines ? `\n\nNo se crearon por parecerse a algo que ya está (confirma con la persona y repite con allowDuplicates=true si las quiere igual):\n${skippedLines}` : ''}${lines ? `\n\nNo se guardaron:\n${lines}` : ''}${
        remaining > 0
          ? `\n\nQuedaron ${remaining} sin procesar por tiempo: envía las filas desde la ${processed + 1} en otra llamada.`
          : ''
      }`,
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
