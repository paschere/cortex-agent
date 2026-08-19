import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { trackerFieldSchema, trackerFieldsSchema, trackerSlugSchema } from './schema';
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
});

const entrySchema = z.object({
  id: z.string(),
  label: z.string(),
  values: z.record(z.union([z.string(), z.number()])),
  updatedAt: z.string(),
});

function fieldsMarkdown(fields: z.infer<typeof trackerFieldsSchema>): string {
  return fields.map((f) => `${f.label} (${f.key}, ${f.type})`).join(', ');
}

export const trackersDefine = registerTool({
  id: 'trackers.define',
  description:
    'Create or update a company-specific table the first-class modules do not cover. Use this when the person needs to track something this workspace has no screen for — remates, container numbers, a custom plate list, a board of invoices that are not in Siigo. Do NOT use it for clients (clients.register), due dates (commitments.record), receivables (payments.*), or fleet plates (vehicles.register). Pass a slug, a name, and the fields. Creating or changing the schema requires confirmation.',
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
      'The columns. key is snake_case. type is text, number, date, money or select. select needs options.',
    ),
  }),
  outputSchema: z.object({
    tracker: trackerSummary,
    created: z.boolean(),
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
    });
    return {
      tracker: {
        id: tracker.id,
        slug: tracker.slug,
        name: tracker.name,
        description: tracker.description,
        fields: tracker.fields,
      },
      created,
      markdown: created
        ? `Tabla **${tracker.name}** creada (\`${tracker.slug}\`). Campos: ${fieldsMarkdown(tracker.fields)}. Para llenarla usa trackers.upsert; para verla, trackers.query.`
        : `Tabla **${tracker.name}** actualizada (\`${tracker.slug}\`). Campos ahora: ${fieldsMarkdown(tracker.fields)}.`,
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
                  return v === undefined || v === '' ? null : `${f.label}: ${v}`;
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
      .record(z.union([z.string(), z.number()]))
      .describe('Map of field key to value. Keys must exist on the table.'),
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
    return {
      row: { id: row.id, label: row.label, values: row.values, updatedAt: row.updated_at },
      tracker: { slug: tracker.slug, name: tracker.name },
      created,
      markdown: created
        ? `Anotado en **${tracker.name}**: ${row.label}.`
        : `Actualizado en **${tracker.name}**: ${row.label}.`,
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
