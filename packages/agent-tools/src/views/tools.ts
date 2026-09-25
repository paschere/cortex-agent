import { z } from 'zod';
import { registerTool } from '../index';
import { PLATFORM_SOURCES, platformSourcesGrammar } from './sources';
import { BLOCK_LABEL, trackersOf, viewSpecSchema } from './spec';
import {
  archiveView,
  createView,
  listViews,
  mustGetView,
  publicViewUrl,
  setViewAccess,
  updateView,
  validateSpec,
  viewSummary,
} from './store';

/**
 * Vistas: pantallas que la empresa se arma hablando (migración 0156).
 *
 * El agente escribe el spec —bloques declarativos sobre las tablas
 * inventadas y, en sólo lectura, sobre las fuentes de la plataforma
 * (`cortex.ventas`, `cortex.pagos`…, ver sources.ts)— y la persona lo ve en
 * /views/<slug>, en Inicio si la fija, o
 * afuera por enlace. Crear y editar no piden confirmación porque cada guardado
 * es una versión y se deshace desde la pantalla. ABRIR LA PUERTA SÍ la pide,
 * siempre, sin mandato ni gracia que valga (mandatory-confirmation.ts): un
 * enlace saca filas de la empresa a quien lo tenga.
 *
 * La contraseña NO pasa por aquí. Lo que entra a una herramienta queda en la
 * auditoría, y una contraseña en un registro deja de serlo. Se pone desde la
 * pantalla de la vista.
 */

const SPEC_GRAMMAR = `Spec: {version:1, subtitle?, accent?: primary|emerald|amber|sky|rose, blocks:[...]} with 1-24 blocks. Every block has id (short, unique, a-z0-9_-) and width: full|half|third (three thirds or two halves share a row).
Block types (tracker = a table slug from trackers.list OR a built-in platform source id below; field = a field key of that table/source, or label/created_at/updated_at):
- text {markdown}
- metric {title, tracker, aggregate: count|sum|avg|min|max, field? (numeric, required unless count), filters?, format?: number|money|percent, goal?, tone?, caption?}
- table {title, tracker, columns?: [field], filters?, sort?: {field, dir: asc|desc}, limit? (≤200), searchable?}
- chart {title, tracker, chart: bar|line|donut, groupBy: field (dates group by bucket: day|week|month), aggregate, field?, filters?, limit?, tone?}
- board {title, tracker, groupBy: a select field, cardFields?: [field], filters?}
- form {title, tracker, intro?, fields?: [field keys to ask], submitLabel?, successMessage?} — adds a row to the table. Only on trackers: platform sources are read-only.
filters: [{field, op, value?}] with op eq|neq|contains|gt|gte|lt|lte|empty|not_empty|before_today|after_today|next_days|last_days (next/last_days take a number of days).
Interactive (custom tables only, never platform sources): table {editable?: [field keys editable in place], actions?: [row buttons]}; board {draggable?: true (drag cards between columns to change the select field), actions?}. Row button: {id, label (≤32), kind: "set_field" (with field + value, e.g. estado=Pagada; select values must be options) | "notify" (pings the view owner and admins with the row name), confirm?: bool, tone?}. Any editable/draggable/button needs spec.editing: "team" (only the workspace, inside the app) or "public" (also whoever has the link); default "off".
Live: spec.refreshSeconds 0|10|30|60 (default 30). Alerts: spec.alerts: [{id, source: table slug or platform source id, filters?, message?, sound?: bool (default true), desktop?: bool, bell?: bool (bell notification to the view owner when a row arrives through this view's form)}] — fires when a new row matching the filters appears while the view is open.
Put the headline metrics first as thirds, then charts as halves, then the full-width table.
Built-in platform sources (read-only, live company data; money fields are COP only, other currencies go to the *_otra_moneda number field). "Ventas" means cortex.ventas (confirmed sales invoices; cartera = its saldo/estado). PERSONAL sources read only the rows of whoever opens the view (their own activations, operations, routines):
${platformSourcesGrammar()}
Feed tables (read-only, PRIVATE to the person who added them): feed.<attachment uuid>.<sheet index from 0> (a fixed Feed capture), feedsrc.<connected source uuid>.<sheet index> (always the latest sync of a connected Feed source; the open view refreshes by itself when the source syncs), feedview.<prepared view uuid>. Fields are the sheet headers without accents in lower_snake_case. Only the owner sees the rows; teammates see a notice on those blocks, and a view using them can never be shared by link. Prefer designing Feed views from /views, which lists the person's Feed tables with their fields.`;

const INTERNAL_SOURCE_IDS = [...PLATFORM_SOURCES.values()]
  .filter((s) => s.sensitivity !== 'shareable')
  .map((s) => s.id)
  .join(', ');

const summarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int(),
  visibility: z.enum(['workspace', 'link', 'password']),
  pinned: z.boolean(),
  blocks: z.number().int(),
  url: z.string(),
  publicUrl: z.string().nullable(),
  updatedAt: z.string(),
});

const DOOR: Record<'workspace' | 'link' | 'password', string> = {
  workspace: 'sólo el equipo',
  link: 'cualquiera con el enlace',
  password: 'enlace con contraseña',
};

export const viewsList = registerTool({
  id: 'views.list',
  description:
    'List the custom views (screens, dashboards, portals, forms) this workspace built on top of its tables. Use it before creating a view so you do not duplicate one, or when someone asks what dashboards exist. Read-only.',
  inputSchema: z.object({ limit: z.number().int().min(1).max(60).default(30) }),
  outputSchema: z.object({
    views: z.array(summarySchema),
    total: z.number().int(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const views = (await listViews(ctx.db, input.limit ?? 30)).map(viewSummary);
    const markdown = views.length
      ? views
          .map(
            (v) =>
              `- **[${v.name}](${v.url})** (\`${v.slug}\`) — ${v.blocks} bloques, ${DOOR[v.visibility]}${v.pinned ? ', fijada en Inicio' : ''}.`,
          )
          .join('\n')
      : 'Todavía no hay vistas. Se crean con views.create sobre las tablas de trackers.list.';
    return { views, total: views.length, markdown };
  },
});

export const viewsGet = registerTool({
  id: 'views.get',
  description:
    'Read one custom view including its full spec, so you can change it with views.update. Identify it by slug or id. Read-only.',
  inputSchema: z.object({
    view: z.string().trim().min(1).max(80).describe('Slug or id of the view.'),
  }),
  outputSchema: z.object({ view: summarySchema, spec: viewSpecSchema, markdown: z.string() }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const view = await mustGetView(ctx.db, input.view);
    const summary = viewSummary(view);
    const blocks = view.spec.blocks
      .map((b) => `${BLOCK_LABEL[b.type]}${'title' in b ? ` «${b.title}»` : ''} (${b.id})`)
      .join(', ');
    return {
      view: summary,
      spec: view.spec,
      markdown: `Vista **[${view.name}](${summary.url})**, versión ${view.version}. Bloques: ${blocks}.`,
    };
  },
});

export const viewsCreate = registerTool({
  id: 'views.create',
  description: `Create a custom view: a screen, dashboard, client portal or intake form built from this workspace's tables (trackers) and/or the platform's own data (sales invoices, payments, clients, deadlines, goals… listed below as cortex.* sources). Use it when someone asks for a dashboard, panel, tablero, portal, interface or form over data they keep in a table or that Cortex already holds. Call trackers.list first to know the table slugs and field keys; prefer a cortex.* source over copying platform data into a table; if the data exists nowhere yet, create a table with trackers.define first. The view opens at /views/<slug>. It stays internal to the team until someone shares it (views.share).
${SPEC_GRAMMAR}`,
  inputSchema: z.object({
    name: z.string().trim().min(1).max(80).describe('What people call the view.'),
    description: z
      .string()
      .trim()
      .max(500)
      .default('')
      .describe('One line on what the view is for.'),
    spec: viewSpecSchema,
    pinned: z.boolean().default(false).describe('Show it on the home dashboard.'),
  }),
  outputSchema: z.object({ view: summarySchema, markdown: z.string() }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const spec = await validateSpec(ctx.db, input.spec, { viewerId: ctx.userId });
    let view = await createView(ctx.db, {
      name: input.name,
      description: input.description,
      spec,
      userId: ctx.userId,
      prompt: 'Creada desde el chat',
    });
    if (input.pinned)
      view = await setViewAccess(ctx.db, view.id, { pinned: true, userId: ctx.userId });
    const summary = viewSummary(view);
    return {
      view: summary,
      markdown: `Vista **[${view.name}](${summary.url})** creada con ${spec.blocks.length} bloques. Por ahora la ve sólo el equipo; desde la vista se puede compartir por enlace o con contraseña, y editar escribiendo lo que quieras cambiar.`,
    };
  },
});

export const viewsUpdate = registerTool({
  id: 'views.update',
  description: `Change an existing custom view: its name, description, blocks, or whether it is pinned on the home dashboard. Read it with views.get first and send the WHOLE new spec (not a diff). Every save is a new version the person can undo from the view.
${SPEC_GRAMMAR}`,
  inputSchema: z.object({
    view: z.string().trim().min(1).max(80).describe('Slug or id of the view.'),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    spec: viewSpecSchema.optional(),
    pinned: z.boolean().optional(),
    change: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe('One line describing the change, shown in the history.'),
  }),
  outputSchema: z.object({ view: summarySchema, markdown: z.string() }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const current = await mustGetView(ctx.db, input.view);
    let view = current;
    if (input.spec || input.name || input.description !== undefined) {
      const spec = input.spec
        ? await validateSpec(ctx.db, input.spec, {
            viewerId: ctx.userId,
            keep: trackersOf(current.spec),
          })
        : undefined;
      view = await updateView(ctx.db, current.id, {
        name: input.name,
        description: input.description,
        spec,
        userId: ctx.userId,
        prompt: input.change ?? 'Editada desde el chat',
      });
    }
    if (input.pinned !== undefined && input.pinned !== view.pinned)
      view = await setViewAccess(ctx.db, view.id, { pinned: input.pinned, userId: ctx.userId });
    const summary = viewSummary(view);
    return {
      view: summary,
      markdown: `Vista **[${view.name}](${summary.url})** actualizada (versión ${view.version}).${view.pinned ? ' Está fijada en Inicio.' : ''}`,
    };
  },
});

export const viewsShare = registerTool({
  id: 'views.share',
  description: `Open or close the outside door of a custom view. visibility "link" gives a public URL anyone with it can open without an account (optionally expiring after N days); "workspace" closes it again and kills the old link. Password protection cannot be set from chat: tell the person to set it from the view screen (Compartir). A view that uses an INTERNAL or PERSONAL platform source (${INTERNAL_SOURCE_IDS}) or any Feed table (feed.*, feedsrc.*, feedview.*) can never be shared by link or password; say so instead of trying. Always requires the person's explicit approval, because a link exposes the table rows the view shows.`,
  inputSchema: z.object({
    view: z.string().trim().min(1).max(80).describe('Slug or id of the view.'),
    visibility: z.enum(['workspace', 'link']),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Expire the link after this many days. Omit for no expiry.'),
    rotate: z.boolean().default(false).describe('Issue a new link and kill the previous one.'),
  }),
  outputSchema: z.object({ view: summarySchema, markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const current = await mustGetView(ctx.db, input.view);
    const view = await setViewAccess(ctx.db, current.id, {
      visibility: input.visibility,
      days: input.visibility === 'link' ? (input.days ?? null) : undefined,
      rotate: input.rotate,
      userId: ctx.userId,
    });
    const summary = viewSummary(view);
    return {
      view: summary,
      markdown:
        view.visibility === 'workspace'
          ? `La vista **${view.name}** volvió a ser sólo del equipo. El enlace anterior ya no abre.`
          : `Enlace de **${view.name}**: ${view.share_token ? publicViewUrl(view.share_token) : ''}${view.share_expires_at ? ` (vence el ${view.share_expires_at.slice(0, 10)})` : ''}. Quien lo tenga ve lo que muestra la vista, sin cuenta.`,
    };
  },
});

export const viewsArchive = registerTool({
  id: 'views.archive',
  description:
    'Archive a custom view: it disappears from the list and from the home dashboard, and its outside link stops working. The table data is untouched. Requires confirmation.',
  inputSchema: z.object({
    view: z.string().trim().min(1).max(80).describe('Slug or id of the view.'),
  }),
  outputSchema: z.object({ archived: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const view = await mustGetView(ctx.db, input.view);
    const archived = await archiveView(ctx.db, view.id);
    return {
      archived,
      markdown: archived
        ? `Vista **${view.name}** archivada. Los datos de sus tablas siguen intactos.`
        : 'Esa vista ya no estaba activa.',
    };
  },
});
