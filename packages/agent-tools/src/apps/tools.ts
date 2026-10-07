import { z } from 'zod';
import { registerTool } from '../index';
import { viewSpecSchema } from '../views/spec';
import { SPEC_GRAMMAR } from '../views/tools';
import { installAppTemplate } from './install';
import { appPermissionsSchema, roleKeySchema } from './permissions';
import {
  MAX_APP_ROLES,
  MAX_APP_SCREENS,
  appSummary,
  listApps,
  listScreens,
  roleInputSchema,
} from './store';
import { APP_TEMPLATES, type AppTemplate } from './templates';

/**
 * Aplicaciones desde el chat (migración 0208): listar y crear.
 *
 * Crear SÍ pide confirmación: una app crea tablas, pantallas y roles de una
 * sola vez, y publicarla abre pantallas a gente que no es «del equipo». La
 * regla de siempre aplica antes: si la fuente es una hoja o una carpeta de
 * Drive, primero se propone la tabla (`trackers.propose_from_source` /
 * `trackers.propose_from_drive_folder`) y se espera el visto bueno; sólo
 * después se arma la app sobre esa tabla.
 *
 * Editar pantallas, roles y miembros se hace desde /apps/<id>/edit (el
 * editor visual) o, pantalla por pantalla, con `views.update` sobre la vista
 * de la pantalla: una pantalla ES una vista.
 */

const summarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  status: z.enum(['draft', 'published']),
  screens: z.array(z.object({ slug: z.string(), title: z.string(), roles: z.array(z.string()) })),
  url: z.string(),
  editUrl: z.string(),
  updatedAt: z.string(),
});

const PERMISSIONS_GRAMMAR = `Role permissions: {tables: {"<table slug>": {read: "all" | "own" | {field, equals: "$user.<attribute>"}, create: boolean, edit: "none"|"own"|"all", fields?: [field keys the role may write], actions?: [row action ids; "__approve" and "__reject" for approval]}}, export: boolean}. A table NOT listed is invisible to that role (deny by default). "own" = rows the person created. Company owners/admins always enter as "administrador" (everything); do not define that role.`;

export const appsList = registerTool({
  id: 'apps.list',
  description:
    'List the applications (multi-screen apps with roles and members) this workspace built on top of its tables, with their screens and who sees each. Use it before creating one, or when someone asks what apps exist. Read-only.',
  inputSchema: z.object({ limit: z.number().int().min(1).max(60).default(30) }),
  outputSchema: z.object({
    apps: z.array(summarySchema),
    total: z.number().int(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const rows = await listApps(ctx.db, input.limit ?? 30);
    const apps = await Promise.all(
      rows.map(async (a) => appSummary(a, await listScreens(ctx.db, a.id))),
    );
    const markdown = apps.length
      ? apps
          .map(
            (a) =>
              `- ${a.icon} **[${a.name}](${a.url})** (\`${a.slug}\`, ${a.status === 'published' ? 'publicada' : 'borrador'}) — ${a.screens.length} pantallas: ${a.screens.map((s) => s.title).join(', ') || 'ninguna'}.`,
          )
          .join('\n')
      : 'Esta empresa todavía no tiene aplicaciones. Puedo armar una desde una plantilla («Control en planta») o desde una descripción.';
    return { apps, total: apps.length, markdown };
  },
});

const screenInput = z.object({
  title: z.string().trim().min(1).max(60),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,47}$/)
    .optional(),
  icon: z
    .string()
    .trim()
    .max(60)
    .optional()
    .describe('A lucide icon name (ClipboardPlus, ListChecks, BadgeCheck, BarChart3) or an emoji.'),
  roles: z
    .array(roleKeySchema)
    .max(MAX_APP_ROLES)
    .default([])
    .describe('Role keys that see this screen; empty = everyone.'),
  spec: viewSpecSchema,
});

const roleInput = z.object({
  key: roleKeySchema,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  permissions: appPermissionsSchema,
});

export const appsCreate = registerTool({
  id: 'apps.create',
  description: `Create an application: several screens with a menu, roles with row-level permissions, and members of this workspace assigned to roles. Two ways: template ("control_planta": operators register shipping guides with photo and offline, supervisor approves and resolves duplicates, management sees the dashboard and exports) or a custom design (name, roles, screens). Each screen is a view spec, same grammar as views.create. Before designing on a Google Sheet or a Drive folder, ALWAYS call trackers.propose_from_source / trackers.propose_from_drive_folder first and wait for approval of the table. Tables named by screens must exist (trackers.list) unless the template creates them. The app is created as a draft; the person publishes it and assigns members from /apps/<id>/edit. Requires confirmation.
${PERMISSIONS_GRAMMAR}
${SPEC_GRAMMAR}`,
  inputSchema: z
    .object({
      template: z.enum(APP_TEMPLATES.map((t) => t.id) as [string, ...string[]]).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(500).optional(),
      icon: z.string().trim().max(400).optional().describe('An emoji.'),
      roles: z.array(roleInput).max(MAX_APP_ROLES).optional(),
      screens: z.array(screenInput).min(1).max(MAX_APP_SCREENS).optional(),
      homeScreen: z.string().trim().max(48).optional(),
    })
    .superRefine((v, ctx) => {
      if (!v.template && (!v.name || !v.screens?.length || !v.roles?.length))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Sin plantilla hacen falta name, roles y screens.',
        });
    }),
  outputSchema: z.object({ app: summarySchema, markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const template: AppTemplate | null = input.template
      ? (APP_TEMPLATES.find((t) => t.id === input.template) ?? null)
      : {
          id: 'custom',
          name: input.name ?? 'Aplicación',
          icon: input.icon ?? '📱',
          body: input.description ?? '',
          accent: 'primary',
          trackers: [],
          roles: (input.roles ?? []).map((r) => roleInputSchema.parse(r)),
          screens: (input.screens ?? []).map((s, i) => ({
            slug: s.slug ?? `pantalla_${i + 1}`,
            title: s.title,
            icon: s.icon || 'LayoutPanelTop',
            roles: s.roles ?? [],
            spec: viewSpecSchema.parse(s.spec),
          })),
          homeScreen: input.homeScreen ?? input.screens?.[0]?.slug ?? 'pantalla_1',
        };
    if (!template) throw new Error('Plantilla desconocida.');
    const { app, screens, createdTrackers } = await installAppTemplate(ctx.db, template, {
      userId: ctx.userId,
      name: input.name,
      description: input.description,
    });
    const summary = appSummary(app, screens);
    const roles = template.roles.map((r) => r.name).join(', ');
    return {
      app: summary,
      markdown: `Aplicación **${app.name}** creada como borrador con ${screens.length} pantallas (${screens.map((s) => s.title).join(', ')}) y los roles ${roles}.${createdTrackers.length ? ` Se creó la tabla ${createdTrackers.map((t) => `«${t}»`).join(', ')}.` : ''} Edítala, asigna miembros a los roles y publícala en ${summary.editUrl}.`,
    };
  },
});
