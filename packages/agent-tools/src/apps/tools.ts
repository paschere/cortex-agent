import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager, listDirectory } from '../directory/store';
import { registerTool } from '../index';
import { internalSourcesOf } from '../views/sources';
import { viewSpecSchema } from '../views/spec';
import { updateView, validateSpec } from '../views/store';
import { viewCatalog } from '../views/store';
import { SPEC_GRAMMAR } from '../views/tools';
import { savePortal, saveTableros } from './app-extras';
import { appBrandPatchSchema, appHomeSchema, mergeBrand } from './appearance';
import { portalPatchSchema } from './client-portal';
import { inviteAppUser, listAppUsers } from './external';
import { GEOFENCE_MAX, geofenceIdFor, geofenceProblems, geofenceSchema } from './geofence';
import { APP_ICON_NAMES, normalizeAppIcon } from './icon-names';
import { installAppTemplate } from './install';
import { locationSettingsPatchSchema } from './location-shape';
import { appPermissionsSchema, roleKeySchema } from './permissions';
import {
  MAX_APP_ROLES,
  MAX_APP_SCREENS,
  addScreen,
  appSummary,
  attributesSchema,
  deleteApp,
  listApps,
  listMembers,
  listRoles,
  listScreens,
  mustGetApp,
  removeMember,
  removeScreen,
  reorderScreens,
  roleInputSchema,
  saveRoles,
  screenViews,
  setMember,
  updateApp,
  updateScreen,
} from './store';
import { describeTableros, suggestTableros, tableroSchema } from './tablero';
import { APP_TEMPLATES, type AppTemplate } from './templates';
import { formatDuration, loadUsage } from './usage';
import { renderComparison } from './versions-compare';
import {
  compareVersions,
  draftStatus,
  listVersions,
  publishVersion,
  restoreVersion,
  unpublishApp,
} from './versions';

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

/** Crear y cambiar apps es de quien administra la empresa, como el editor (`requireAppAdmin`). */
async function requireAppAdmin(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede cambiar una aplicación.',
    );
}

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

const PERMISSIONS_GRAMMAR = `Role permissions: {tables: {"<table slug>": {read: "all" | "own" | {field, equals: "$user.<attribute>"}, create: boolean, edit: "none"|"own"|"all", fields?: [field keys the role may write], actions?: [row action ids; "__approve" and "__reject" for approval]}}, export: boolean, location?: {share?: boolean, view?: boolean, assign?: boolean}}. A table NOT listed is invisible to that role (deny by default). "own" = rows the person created; the special attribute "$user.id" is the person themself (a task table with read {field:"asignado", equals:"$user.id"} shows each person only the tasks assigned to them, nothing to type when inviting). location (all off by default; only works when the app has location.enabled): share = people of this role may share their location (they must accept the consent text and start a shift), view = this role sees where people on shift are on the map, assign = this role assigns tasks to people (map or "assign" row buttons). Company owners/admins always enter as "administrador" (everything); do not define that role.`;

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
    .describe(
      `Screen icon: one of ${APP_ICON_NAMES.join(', ')} — or an emoji. Any other name is replaced by LayoutPanelTop.`,
    ),
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
  description: `Create an application: several screens with a menu, roles with row-level permissions, and members of this workspace assigned to roles. Two ways: template ("control_planta": operators register shipping guides with photo and offline, supervisor approves and resolves duplicates, management sees the dashboard and exports; "portal_clientes": customers see only their own orders and documents; "equipo_en_campo": a coordinator sees a map with the people on shift (who accepted to share their location) and the tasks by status and assigns tasks from the map or a list, each person sees only their tasks and starts/finishes them with photo and note) or a custom design (name, roles, screens). Each screen is a view spec, same grammar as views.create. Before designing on a Google Sheet or a Drive folder, ALWAYS call trackers.propose_from_source / trackers.propose_from_drive_folder first and wait for approval of the table. Tables named by screens must exist (trackers.list) unless the template creates them. The app is created as a draft; the person publishes it and assigns members from /apps/<id>/edit. Requires confirmation.
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
    await requireAppAdmin(ctx);
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
            icon: normalizeAppIcon(s.icon),
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

// ---------------------------------------------------------------------------
// apps.get
// ---------------------------------------------------------------------------

export const appsGet = registerTool({
  id: 'apps.get',
  description:
    'Read ONE application in full: whether it is published, its screens (slug, title, who sees each, the blocks it has), its roles with their permissions, the Cortex members assigned to roles and, for company admins, the external users invited (name, email, role, status). Use it before apps.update / apps.publish / apps.assign_members / apps.invite_users. Read-only. Accepts the app id or slug.',
  inputSchema: z.object({ app: z.string().trim().min(1).max(80) }),
  outputSchema: z.object({
    app: summarySchema,
    screens: z.array(
      z.object({
        slug: z.string(),
        title: z.string(),
        icon: z.string(),
        roles: z.array(z.string()),
        blocks: z.array(z.string()),
      }),
    ),
    roles: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        description: z.string(),
        permissions: appPermissionsSchema,
      }),
    ),
    members: z.array(
      z.object({ userId: z.string(), roleKey: z.string(), attributes: z.record(z.string()) }),
    ),
    users: z
      .array(
        z.object({
          name: z.string(),
          email: z.string(),
          roleKey: z.string(),
          status: z.string(),
          attributes: z.record(z.string()),
        }),
      )
      .nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const app = await mustGetApp(ctx.db, input.app);
    const [screens, roles, members] = await Promise.all([
      listScreens(ctx.db, app.id),
      listRoles(ctx.db, app.id),
      listMembers(ctx.db, app.id),
    ]);
    const views = await screenViews(ctx.db, screens);
    const admin = await isCompanyManager(ctx.db, ctx.userId);
    const users = admin ? await listAppUsers(ctx.db, app.id) : null;
    const summary = appSummary(app, screens);
    const screenOut = screens.map((s) => ({
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      roles: s.roles,
      blocks: (views.get(s.view_id)?.spec.blocks ?? []).map(
        (b) => `${b.type}${'tracker' in b ? `:${b.tracker}` : ''}`,
      ),
    }));
    const markdown = [
      `**${app.icon} ${app.name}** (\`${app.slug}\`) — ${app.status === 'published' ? 'publicada' : 'borrador'}. Entrada para usuarios externos: /a/${app.id}`,
      `Pantallas: ${screenOut.map((s) => `${s.title} (${s.slug}${s.roles.length ? `; ${s.roles.join(', ')}` : '; todos'})`).join(', ') || 'ninguna'}.`,
      `Roles: ${roles.map((r) => `${r.name} (${r.key})`).join(', ') || 'ninguno'}.`,
      `Miembros de Cortex: ${members.length}. Usuarios externos: ${users ? users.length : 'sólo los ve quien administra'}.`,
    ].join('\n');
    return {
      app: summary,
      screens: screenOut,
      roles: roles.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      })),
      members: members.map((m) => ({
        userId: m.user_id,
        roleKey: m.role_key,
        attributes: m.attributes,
      })),
      users: users
        ? users.map((u) => ({
            name: u.name,
            email: u.email,
            roleKey: u.role_key,
            status: u.status,
            attributes: u.attributes,
          }))
        : null,
      markdown,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.update
// ---------------------------------------------------------------------------

const screenPatch = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,47}$/),
  title: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().max(60).optional(),
  roles: z.array(roleKeySchema).max(MAX_APP_ROLES).optional(),
  spec: viewSpecSchema
    .optional()
    .describe('Replaces the whole spec of this screen (same grammar as views.update).'),
});

const APPEARANCE_GRAMMAR = `APPEARANCE (field "brand", optional): the app's OWN look on top of the company's brand (which stays the default). Partial: only the keys you send change, null clears one. { primary?: "#RRGGBB", accent?: "#RRGGBB", shortName?: <=12 chars (name under the installed icon), font?: "system"|"serif"|"rounded", welcome?: { title?, text? } (shown on the entry screen) }. Colors are adjusted automatically to pass WCAG AA in light and dark. Logo and welcome image are uploaded from the editor's "Apariencia" tab, not from chat.
LOCATION (field "location", optional, partial {enabled?, retentionDays? 1-365, default 30}): "Compartir ubicación del equipo", OFF by default. When on, people whose role has location.share can share where they are while the app is open and they are "on shift"; each person accepts a clear consent text once (stored with date and text version) and can withdraw any time (their position and trail are deleted); the position trail is deleted automatically after retentionDays. Only roles with location.view see people on a "map" block (people:true); a public link never shows people. Turning it off deletes every stored position. Colombian data-protection law (Ley 1581): never turn it on without telling the owner what it shares.
HOME (field "home", optional): replaces the whole "Inicio" screen: { enabled, greeting (name + date), cards: [<=8] }. Each card has id, roles (role keys that see it; [] = all) and one of: { kind:"counter", source:<table slug>, filters:[...same filter grammar as view blocks; value "{hoy}", "{ayer}" or "{manana}" = that date], text:"Hoy llegan {n} vuelos", zeroText?:"Aún no hay vuelos hoy", screen?:<screen slug it opens>, tone? } | { kind:"pending", same fields as counter, shows the first 3 rows; openFilterId/openFilterValue open the target screen already filtered by one of its filter-bar items } | { kind:"shortcut", label:"Registrar atención", hint?, screen:<screen slug>, icon? }. Counts respect each role's row scope; a card over a table the role cannot read is hidden. "inicio" is a reserved screen slug. enabled:true makes Inicio the first screen.`;

const DASHBOARD_GRAMMAR = `DASHBOARDS (field "dashboards", optional; or suggestDashboards:true): screen kind "Tablero", computed with the viewer's role and row scope (a widget over a table the role cannot read disappears). [{id (a-z0-9_), title, roles:[role keys; [] = all], widgets:[<=12]}]. Widget kinds, each with id, title, width?:"full"|"half"|"third", screen? (slug it opens), source (table slug), filters?:[view filter grammar; "{hoy}" tokens ok], mine?:{by:"creator"}|{by:"field",field}: { kind:"kpi", aggregate:"count"|"sum"|"avg"|"min"|"max", field?, format?:"number"|"money"|"percent", period:"day"|"week"|"month"|"all" (compare with previous period + sparkline; "all" = no period), dateField?, goodWhen:"up"|"down", goal?, tone? } | { kind:"chart", aggregate:"count"|"sum", field?, dateField?, noun?, ... interactive: ranges, compare, zoom, drill-down to the records } | { kind:"status", field:<select field> } (segments by state) | { kind:"ranking", groupBy, aggregate, field?, limit<=10 } | { kind:"pending", dateField? (overdue first), subtitleField?, limit<=10, emptyText? }. Money is shown in full pesos. Changes land in the DRAFT; apps.publish publishes.`;
const PORTAL_GRAMMAR = `PORTAL (field "portal", partial patch, null removes a section): client portal = a role (roleKey, default "cliente") whose users are EXTERNAL users each linked to ONE client via attribute $user.<attribute> (default "cliente"). { enabled, roleKey, attribute, title?, welcome?, shipments?:{source,clientField,columns?,statusField?,screen?}, invoices?:{source,clientField,amountField?,dueField?,statusField?,paidValues?,payUrlField?}, documents?:{source,clientField,fileField,labelField?}, upload?:{source,clientField,fileField,noteField?,kindField?} }. The role, the "Subir soporte" screen and the staff notification are created automatically. "Pagar" shows ONLY for invoices whose payUrlField holds an https payment link; with no such field there is no pay button. Invite clients with apps.invite_users (roleKey + attributes {"cliente":"<name exactly as in the table>"}). Changes land in the DRAFT.`;

export const appsUpdate = registerTool({
  id: 'apps.update',
  description: `Change an existing application (get its slugs first with apps.get): rename it, change its description/icon/home screen, its own appearance (colors, short name, font, welcome text) and its "Inicio" cards screen, add, edit, remove or reorder screens, and replace its set of roles with their permissions. Every piece is validated exactly like the visual editor: screen specs against the real tables (same grammar as views.create / views.update), roles against the permission contract. Removing a role also removes the Cortex members and keeps NO external users on it (change their role first). Removing a screen archives its view (data in the tables is untouched). Does NOT publish (apps.publish) nor assign people (apps.assign_members / apps.invite_users). AFTER IT you MUST call apps.inspect for the role the change is about (with expect = the field/block names the person asked for) and report «listo» only if it shows up working for that role; otherwise fix it and inspect again. If the app is published, a screen cannot read internal sources (Feed, personal, platform-internal). Requires confirmation; company owners/admins only.
${PERMISSIONS_GRAMMAR}
${APPEARANCE_GRAMMAR}
${DASHBOARD_GRAMMAR}
${PORTAL_GRAMMAR}
${SPEC_GRAMMAR}`,
  inputSchema: z
    .object({
      app: z.string().trim().min(1).max(80).describe('App id or slug.'),
      brand: appBrandPatchSchema.optional(),
      home: appHomeSchema.optional(),
      location: locationSettingsPatchSchema.optional(),
      dashboards: z
        .array(tableroSchema)
        .max(6)
        .optional()
        .describe('COMPLETE list of dashboards (screen kind "Tablero"). See DASHBOARDS.'),
      suggestDashboards: z
        .boolean()
        .optional()
        .describe(
          'true = replace dashboards with one suggested per role (operario / supervisor / gerencia).',
        ),
      portal: portalPatchSchema.partial().optional().describe('Client portal patch. See PORTAL.'),
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(500).optional(),
      icon: z.string().trim().max(400).optional(),
      homeScreen: z.string().trim().max(48).nullable().optional(),
      addScreens: z.array(screenInput).max(MAX_APP_SCREENS).optional(),
      updateScreens: z.array(screenPatch).max(MAX_APP_SCREENS).optional(),
      removeScreens: z.array(z.string().trim().max(48)).max(MAX_APP_SCREENS).optional(),
      screenOrder: z
        .array(z.string().trim().max(48))
        .max(MAX_APP_SCREENS)
        .optional()
        .describe('Screen slugs from first to last; missing ones go at the end.'),
      roles: z
        .array(roleInput)
        .max(MAX_APP_ROLES)
        .optional()
        .describe('The COMPLETE set of roles; roles not listed are deleted.'),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.description !== undefined ||
        v.icon !== undefined ||
        v.homeScreen !== undefined ||
        v.brand !== undefined ||
        v.home !== undefined ||
        v.location !== undefined ||
        v.dashboards !== undefined ||
        v.suggestDashboards ||
        v.portal !== undefined ||
        v.addScreens?.length ||
        v.updateScreens?.length ||
        v.removeScreens?.length ||
        v.screenOrder?.length ||
        v.roles,
      { message: 'No hay nada que cambiar.' },
    ),
  outputSchema: z.object({
    app: summarySchema,
    changes: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    let app = await mustGetApp(ctx.db, input.app);
    const changes: string[] = [];
    const published = app.status === 'published';

    // Todo lo que se puede comprobar ANTES de escribir, se comprueba antes: una
    // pantalla con una fuente interna en una app publicada se rechaza entera.
    const newSpecs = [
      ...(input.addScreens ?? []).map((s) => s.spec),
      ...(input.updateScreens ?? []).flatMap((s) => (s.spec ? [s.spec] : [])),
    ];
    if (published)
      for (const spec of newSpecs) {
        const bad = internalSourcesOf(viewSpecSchema.parse(spec));
        if (bad.length)
          throw new ValidationError(
            `La app está publicada y una pantalla usaría información interna (${bad.map((b) => `«${b.name}»`).join(', ')}). Despublícala primero o usa otra fuente.`,
          );
      }
    if (input.roles) {
      const taken = (await listAppUsers(ctx.db, app.id)).filter(
        (u) => !input.roles?.some((r) => r.key === u.role_key),
      );
      if (taken.length)
        throw new ValidationError(
          `Hay usuarios externos con un rol que quitarías (${[...new Set(taken.map((u) => u.role_key))].join(', ')}). Cámbiales el rol antes.`,
        );
    }

    if (input.roles) {
      await saveRoles(
        ctx.db,
        app.id,
        input.roles.map((r) => roleInputSchema.parse(r)),
      );
      changes.push(`roles: ${input.roles.map((r) => r.name).join(', ')}`);
    }
    for (const slug of input.removeScreens ?? []) {
      const screen = (await listScreens(ctx.db, app.id)).find((s) => s.slug === slug);
      if (!screen) throw new NotFoundError(`No hay una pantalla «${slug}» en esta app.`);
      await removeScreen(ctx.db, app.id, screen.id);
      changes.push(`pantalla quitada: ${slug}`);
    }
    for (const s of input.addScreens ?? []) {
      const added = await addScreen(ctx.db, app, {
        title: s.title,
        slug: s.slug,
        icon: s.icon,
        roles: s.roles,
        spec: s.spec,
        userId: ctx.userId,
        prompt: 'apps.update',
      });
      changes.push(`pantalla nueva: ${added.title}`);
    }
    for (const patch of input.updateScreens ?? []) {
      const screen = (await listScreens(ctx.db, app.id)).find((s) => s.slug === patch.slug);
      if (!screen) throw new NotFoundError(`No hay una pantalla «${patch.slug}» en esta app.`);
      if (patch.spec) {
        const spec = await validateSpec(ctx.db, patch.spec, { viewerId: ctx.userId });
        await updateView(ctx.db, screen.view_id, {
          spec,
          userId: ctx.userId,
          prompt: 'apps.update',
          appScreen: true,
        });
      }
      if (patch.title !== undefined || patch.icon !== undefined || patch.roles !== undefined)
        await updateScreen(ctx.db, app.id, screen.id, {
          title: patch.title,
          icon: patch.icon,
          roles: patch.roles,
        });
      changes.push(`pantalla cambiada: ${patch.slug}`);
    }
    if (input.screenOrder?.length) {
      const screens = await listScreens(ctx.db, app.id);
      const ids = input.screenOrder.map((slug) => {
        const hit = screens.find((s) => s.slug === slug);
        if (!hit) throw new NotFoundError(`No hay una pantalla «${slug}» en esta app.`);
        return hit.id;
      });
      await reorderScreens(ctx.db, app.id, ids);
      changes.push('orden de pantallas');
    }
    if (input.dashboards || input.suggestDashboards) {
      let list = input.dashboards;
      if (!list) {
        const screens = await listScreens(ctx.db, app.id);
        const views = await screenViews(ctx.db, screens);
        const used = new Map<string, number>();
        for (const v of views.values())
          for (const b of v.spec.blocks)
            if ('tracker' in b) used.set(b.tracker, (used.get(b.tracker) ?? 0) + 1);
        const catalog = await viewCatalog(ctx.db, {});
        const ordered = [...used.entries()]
          .sort((a, b) => b[1] - a[1])
          .flatMap(([slug]) => catalog.filter((c) => c.slug === slug));
        list = suggestTableros({
          trackers: ordered,
          roles: await listRoles(ctx.db, app.id),
          screen: screens[0]?.slug,
        });
        if (!list.length)
          throw new ValidationError(
            'No encontré una tabla propia en las pantallas para sugerir tableros.',
          );
      }
      const saved = await saveTableros(ctx.db, app, list, ctx.userId);
      app = saved.app;
      changes.push(`tableros: ${describeTableros(saved.tableros).join(' · ')}`);
    }
    if (input.portal) {
      const saved = await savePortal(ctx.db, app, input.portal as never, ctx.userId);
      app = saved.app;
      changes.push(
        `portal de clientes ${saved.portal.enabled ? 'encendido' : 'apagado'} (${saved.notes.join('; ') || 'sin cambios de estructura'})`,
      );
    }
    const home = input.home ? appHomeSchema.parse(input.home) : undefined;
    if (home) {
      // Las tarjetas se comprueban contra lo que existe: una pantalla o una tabla
      // inventada se rechaza aquí y no se descubre al abrir la app.
      const slugs = new Set((await listScreens(ctx.db, app.id)).map((s) => s.slug));
      for (const card of home.cards) {
        if ('screen' in card && card.screen && !slugs.has(card.screen))
          throw new NotFoundError(
            `La tarjeta «${card.id}» apunta a la pantalla «${card.screen}», que no existe en esta app.`,
          );
      }
    }
    if (
      input.name !== undefined ||
      input.description !== undefined ||
      input.icon !== undefined ||
      input.homeScreen !== undefined ||
      input.brand !== undefined ||
      input.home !== undefined ||
      input.location !== undefined
    ) {
      if (input.homeScreen) {
        const exists = (await listScreens(ctx.db, app.id)).some((s) => s.slug === input.homeScreen);
        if (!exists)
          throw new NotFoundError(`No hay una pantalla «${input.homeScreen}» para abrir primero.`);
      }
      app = await updateApp(ctx.db, app.id, {
        name: input.name,
        description: input.description,
        icon: input.icon,
        homeScreen: input.homeScreen,
        brand: input.brand ? mergeBrand(app.brand, input.brand) : undefined,
        home,
        location: input.location,
        userId: ctx.userId,
      });
      changes.push(
        input.brand || input.home
          ? 'datos, apariencia o inicio de la app'
          : input.location
            ? `ubicación del equipo ${app.location.enabled ? 'encendida' : 'apagada'}`
            : 'datos de la app',
      );
    }
    const summary = appSummary(app, await listScreens(ctx.db, app.id));
    return {
      app: summary,
      changes,
      markdown: `Listo, cambié **${app.name}**: ${changes.join('; ')}. ${app.status === 'published' ? 'Los cambios quedan en el BORRADOR: los usuarios siguen viendo la versión publicada hasta que la publiques con apps.publish.' : 'Está en borrador: publícala con apps.publish.'}`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.geofences
// ---------------------------------------------------------------------------

export const appsGeofences = registerTool({
  id: 'apps.geofences',
  description: `Define the NAMED PLACES with a radius («Bodega Norte», «Cliente Éxito Calle 80») of an application and what happens when people on shift ENTER or LEAVE them: the arrival is recorded («Ana llegó a Bodega Norte»), shown on the team map and the roles chosen are notified. Needs the app's location sharing on (apps.update location.enabled) and people on shift who accepted to share. Operations (all in one call): add [{name, lat, lng, radiusM 30-5000 default 150, on "enter"|"leave"|"both" default both, notifyRoles: [role keys], notifyAdmins: boolean, message?: "{{persona}} llegó a {{lugar}}"}], update [{id, ...same fields}], remove [ids], and list:true to only read. Coordinates must be real (ask for the address or have the person pick the point on the map in the app editor, "Lugares"); never invent them. Evaluation has hysteresis: leaving needs about 25% more than the radius, so standing at the edge does not fire alerts. Does NOT push to phones by itself outside shifts. Requires confirmation; company owners/admins only.`,
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    list: z.boolean().optional().describe('true = only list the current places.'),
    add: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(60),
          lat: z.number().finite().min(-90).max(90),
          lng: z.number().finite().min(-180).max(180),
          radiusM: z.number().int().min(30).max(5000).optional(),
          on: z.enum(['enter', 'leave', 'both']).optional(),
          notifyRoles: z.array(roleKeySchema).max(8).optional(),
          notifyAdmins: z.boolean().optional(),
          message: z.string().trim().min(1).max(200).optional(),
        }),
      )
      .max(10)
      .optional(),
    update: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(40),
          name: z.string().trim().min(1).max(60).optional(),
          lat: z.number().finite().min(-90).max(90).optional(),
          lng: z.number().finite().min(-180).max(180).optional(),
          radiusM: z.number().int().min(30).max(5000).optional(),
          on: z.enum(['enter', 'leave', 'both']).optional(),
          notifyRoles: z.array(roleKeySchema).max(8).optional(),
          notifyAdmins: z.boolean().optional(),
          message: z.string().trim().min(1).max(200).nullable().optional(),
        }),
      )
      .max(GEOFENCE_MAX)
      .optional(),
    remove: z.array(z.string().trim().min(1).max(40)).max(GEOFENCE_MAX).optional(),
  }),
  outputSchema: z.object({
    geofences: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        lat: z.number(),
        lng: z.number(),
        radiusM: z.number(),
        on: z.string(),
        notifyRoles: z.array(z.string()),
        notifyAdmins: z.boolean(),
      }),
    ),
    changes: z.array(z.string()),
    markdown: z.string(),
  }),
  // Leer no cambia nada, pero la herramienta se aprueba como una sola; el chat muestra la tarjeta.
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    let app = await mustGetApp(ctx.db, input.app);
    const current = app.location.geofences;
    const changes: string[] = [];
    let next = [...current];
    for (const id of input.remove ?? []) {
      const hit = next.find((g) => g.id === id);
      if (!hit) throw new NotFoundError(`No hay un lugar «${id}» en esta app.`);
      next = next.filter((g) => g.id !== id);
      changes.push(`lugar quitado: ${hit.name}`);
    }
    for (const patch of input.update ?? []) {
      const at = next.findIndex((g) => g.id === patch.id);
      if (at < 0) throw new NotFoundError(`No hay un lugar «${patch.id}» en esta app.`);
      const old = next[at] as (typeof next)[number];
      next[at] = geofenceSchema.parse({
        ...old,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...(patch.radiusM !== undefined ? { radiusM: patch.radiusM } : {}),
        ...(patch.on !== undefined ? { on: patch.on } : {}),
        notify: {
          roles: patch.notifyRoles ?? old.notify.roles,
          admins: patch.notifyAdmins ?? old.notify.admins,
        },
        message: patch.message === null ? undefined : (patch.message ?? old.message),
      });
      changes.push(`lugar cambiado: ${(next[at] as (typeof next)[number]).name}`);
    }
    for (const add of input.add ?? []) {
      const place = geofenceSchema.parse({
        id: geofenceIdFor(
          add.name,
          next.map((g) => g.id),
        ),
        name: add.name,
        lat: add.lat,
        lng: add.lng,
        radiusM: add.radiusM,
        on: add.on,
        notify: { roles: add.notifyRoles ?? [], admins: add.notifyAdmins ?? false },
        message: add.message,
      });
      next.push(place);
      changes.push(`lugar nuevo: ${place.name} (${place.radiusM} m)`);
    }
    if (next.length > GEOFENCE_MAX)
      throw new ValidationError(`Una app admite hasta ${GEOFENCE_MAX} lugares.`);
    const problems = geofenceProblems(next);
    if (problems.length) throw new ValidationError(problems.join(' '));
    // Los roles a avisar tienen que existir en la app.
    const roles = new Set((await listRoles(ctx.db, app.id)).map((r) => r.key));
    for (const g of next)
      for (const r of g.notify.roles)
        if (!roles.has(r)) throw new ValidationError(`El rol «${r}» no existe en esta app.`);
    if (changes.length) {
      app = await updateApp(ctx.db, app.id, {
        location: { geofences: next },
        userId: ctx.userId,
      });
    }
    const list = app.location.geofences;
    const lines = list.map(
      (g) =>
        `- **${g.name}** · ${g.radiusM} m · ${g.on === 'both' ? 'llega y sale' : g.on === 'enter' ? 'al llegar' : 'al salir'}${
          g.notify.roles.length || g.notify.admins
            ? ` · avisa a ${[...g.notify.roles, ...(g.notify.admins ? ['administradores'] : [])].join(', ')}`
            : ''
        }`,
    );
    const warn = app.location.enabled
      ? ''
      : '\n\nOjo: la ubicación del equipo está apagada en esta app; los lugares no se evalúan hasta encenderla (apps.update location.enabled).';
    return {
      geofences: list.map((g) => ({
        id: g.id,
        name: g.name,
        lat: g.lat,
        lng: g.lng,
        radiusM: g.radiusM,
        on: g.on,
        notifyRoles: g.notify.roles,
        notifyAdmins: g.notify.admins,
      })),
      changes,
      markdown: `${
        changes.length
          ? `Listo en **${app.name}**: ${changes.join('; ')}.`
          : `Lugares de **${app.name}**.`
      }${lines.length ? `\n\n${lines.join('\n')}` : '\n\nTodavía no hay lugares.'}${warn}`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.publish
// ---------------------------------------------------------------------------

export const appsPublish = registerTool({
  id: 'apps.publish',
  description:
    'Publish the DRAFT of an application as a new numbered version (what its members and invited external users see), or unpublish it back to draft. Changes made with apps.update, the editor or templates stay in the draft until this runs; people using the app keep seeing the last published version meanwhile. Optional note describes the version. Publishing is refused, with the list, if any screen reads an internal source (Feed, personal, platform-internal). Before publishing, run apps.inspect with version "draft" for the roles that use the app and fix what it reports; after publishing, inspect version "published" for the role that matters before saying it is ready for users. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    publish: z.boolean().default(true).describe('false = unpublish (back to draft).'),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('What this version changes, in a sentence.'),
  }),
  outputSchema: z.object({
    app: summarySchema,
    version: z.number().int().nullable(),
    changes: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const current = await mustGetApp(ctx.db, input.app);
    if (input.publish === false) {
      const app = await unpublishApp(ctx.db, current.id, ctx.userId);
      return {
        app: appSummary(app, await listScreens(ctx.db, app.id)),
        version: null,
        changes: [],
        markdown: `**${app.name}** volvió a borrador: nadie más que quien administra puede abrirla. Las versiones se conservan.`,
      };
    }
    const res = await publishVersion(ctx.db, current.id, { userId: ctx.userId, note: input.note });
    const changes = res.changes.map((c) => c.text);
    return {
      app: appSummary(res.app, await listScreens(ctx.db, res.app.id)),
      version: res.number,
      changes,
      markdown: res.created
        ? `**${res.app.name}** publicada como versión ${res.number}${changes.length ? `: ${changes.slice(0, 5).join('; ')}` : ''}. Entrada para usuarios externos: /a/${res.app.id}; los miembros entran por /apps/${res.app.slug}.`
        : `**${res.app.name}** no tenía cambios sin publicar: sigue en la versión ${res.number}.`,
    };
  },
});

const versionRefSchema = z.union([z.number().int().min(1), z.enum(['draft', 'published'])]);

export const appsVersions = registerTool({
  id: 'apps.versions',
  description:
    'Read-only. List the published versions of an application with a summary of what each changed and whether the draft has unpublished changes; or COMPARE two versions in plain Spanish with `compare: {from, to}` (each one a version number, "published" or "draft"): which screens, blocks, form fields, permissions per role and look were added, removed or changed. Use compare before restoring, or when someone asks «¿qué cambió entre la versión 3 y la 5?» / «¿qué cambié desde que publiqué?». Automations and table data are not part of a version and are not compared. To go back to a version use apps.restore_version. Company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    compare: z
      .object({ from: versionRefSchema, to: versionRefSchema.default('draft') })
      .optional()
      .describe('Compare two versions. `to` defaults to the current draft.'),
  }),
  outputSchema: z.object({ markdown: z.string(), changes: z.array(z.string()).optional() }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    if (input.compare) {
      const res = await compareVersions(ctx.db, app.id, input.compare.from, input.compare.to ?? 'draft');
      return {
        markdown: renderComparison(res.lines, `**${app.name}**: de ${res.from} a ${res.to}.`),
        changes: res.lines.map((l) => l.text),
      };
    }
    const [versions, status] = await Promise.all([
      listVersions(ctx.db, app.id, 15),
      draftStatus(ctx.db, app),
    ]);
    const lines = versions.map(
      (v) =>
        `- v${v.number}${v.current ? ' (publicada)' : ''} · ${(v.createdAt ?? '').slice(0, 10)} · ${v.note || v.summary}`,
    );
    return {
      markdown: `**${app.name}**: ${status.hasChanges ? `borrador con cambios sin publicar (${status.summary})` : 'el borrador coincide con lo publicado'}.\n${lines.join('\n') || 'Aún no hay versiones publicadas.'}`,
    };
  },
});

export const appsRestoreVersion = registerTool({
  id: 'apps.restore_version',
  description:
    'Go back to a previous published version of an application: the DRAFT goes back to exactly what that version said (screens with their content, roles and permissions, home, look, dashboards, portal); with publish:true it is also published as a NEW version (history is never rewritten). Roles that have people are kept, rows and automations are not touched. Before asking, call apps.versions with compare {from: <version>, to: "draft"} so the person sees in plain words what will change. The result lists what came back and what could not (a table that changed). Then call apps.inspect for the affected role. The editor has the same «Volver a esta versión» button. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    version: z.number().int().min(1).describe('Version number to go back to.'),
    publish: z
      .boolean()
      .default(false)
      .describe('Also publish the restored draft as a new version.'),
  }),
  outputSchema: z.object({
    app: summarySchema,
    changes: z.array(z.string()),
    skipped: z.array(z.string()),
    published: z.number().nullable(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    // Lo que va a cambiar en el borrador, antes de tocarlo.
    const preview = await compareVersions(ctx.db, app.id, 'draft', input.version).catch(
      () => null,
    );
    const res = await restoreVersion(ctx.db, app.id, input.version, {
      userId: ctx.userId,
      publish: input.publish,
    });
    const changes = (preview?.lines ?? []).map((l) => l.text);
    return {
      app: appSummary(res.app, await listScreens(ctx.db, res.app.id)),
      changes,
      skipped: res.skipped,
      published: res.published?.number ?? null,
      markdown: `Devolví **${res.app.name}** a la versión ${input.version}${res.published ? ` y la publiqué como versión ${res.published.number}` : ' (queda en borrador; publícala con apps.publish)'}.${changes.length ? ` Cambió: ${changes.slice(0, 8).join('; ')}${changes.length > 8 ? ` y ${changes.length - 8} más` : ''}.` : ''}${res.skipped.length ? ` No pude devolver: ${res.skipped.join(' · ')}` : ''} Revisa el resultado con apps.inspect para el rol afectado.`,
    };
  },
});

export const appsUsage = registerTool({
  id: 'apps.usage',
  description:
    'Usage of an application over the last 30 days: active users (7 and 30 days, per role), records created per day, most used screens, median time to complete a form and drop-offs (forms started but never sent) when tracked. Read-only; company owners/admins only.',
  inputSchema: z.object({ app: z.string().trim().min(1).max(80).describe('App id or slug.') }),
  outputSchema: z.object({ markdown: z.string() }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const u = await loadUsage(ctx.db, app);
    if (!u.hasData)
      return { markdown: `**${app.name}** todavía no tiene uso en los últimos 30 días.` };
    const parts = [
      `Activos: ${u.active.d7} en 7 días, ${u.active.d30} en 30.`,
      `Registros creados en 30 días: ${u.created.total}.`,
      u.topScreens.length
        ? `Pantallas más usadas: ${u.topScreens
            .slice(0, 4)
            .map((s) => `${s.title} (${s.opens})`)
            .join(', ')}.`
        : '',
      u.medianSeconds !== null
        ? `Tiempo mediano para completar un formulario: ${formatDuration(u.medianSeconds)} (${u.measured} medidos).`
        : '',
      u.dropoffs
        ? `Formularios empezados y no enviados: ${u.dropoffs.abandoned} de ${u.dropoffs.started}.`
        : '',
      u.byRole.length
        ? `Por rol: ${u.byRole.map((r) => `${r.name} ${r.active30}`).join(', ')}.`
        : '',
    ].filter(Boolean);
    return { markdown: `**${app.name}**: ${parts.join(' ')}` };
  },
});

// ---------------------------------------------------------------------------
// apps.delete
// ---------------------------------------------------------------------------

export const appsDelete = registerTool({
  id: 'apps.delete',
  description:
    'Permanently DELETE an application (not just archive it): its screens (views made for the app), roles, members, invited external users, kiosk devices, automations and push subscriptions go with it; the link /a/<id> stops working. Independent views in the library and ALL table data are untouched. Cannot be undone. Requires human confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
  }),
  outputSchema: z.object({ deleted: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const deleted = await deleteApp(ctx.db, app.id);
    return {
      deleted,
      markdown: deleted
        ? `Aplicación **${app.name}** eliminada con sus pantallas, roles y usuarios. Los datos de las tablas siguen intactos.`
        : 'Esa aplicación ya no existía.',
    };
  },
});

// ---------------------------------------------------------------------------
// apps.assign_members
// ---------------------------------------------------------------------------

export const appsAssignMembers = registerTool({
  id: 'apps.assign_members',
  description:
    'Assign members of THIS workspace (people with a Cortex account) to roles of an application, with optional attributes ($user.<attribute> in row filters, e.g. {"cliente": "Andina"}), or remove them. People are matched by exact email or full name from the directory. Owners/admins always enter as administrator and need no assignment. For people WITHOUT a Cortex account use apps.invite_users. Requires confirmation; company owners/admins only.',
  inputSchema: z
    .object({
      app: z.string().trim().min(1).max(80).describe('App id or slug.'),
      assign: z
        .array(
          z.object({
            person: z.string().trim().min(1).max(200).describe('Email or full name.'),
            roleKey: roleKeySchema,
            attributes: attributesSchema.optional(),
          }),
        )
        .max(50)
        .default([]),
      remove: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    })
    .refine((v) => v.assign.length + v.remove.length > 0, {
      message: 'No hay a quién asignar o quitar.',
    }),
  outputSchema: z.object({
    assigned: z.number().int(),
    removed: z.number().int(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const directory = await listDirectory(ctx.db);
    const find = (who: string) => {
      const w = who.trim().toLowerCase();
      const hits = directory.filter(
        (p) => p.email.toLowerCase() === w || (p.name ?? '').trim().toLowerCase() === w,
      );
      if (hits.length === 0)
        throw new NotFoundError(`No encuentro a «${who}» entre las personas del espacio.`);
      if (hits.length > 1)
        throw new ValidationError(`«${who}» coincide con varias personas; usa el correo.`);
      return hits[0] as (typeof directory)[number];
    };
    // Se resuelve todo antes de escribir: una persona que no existe no deja la mitad hecha.
    const assign = (input.assign ?? []).map((a) => ({ ...a, person: find(a.person) }));
    const remove = (input.remove ?? []).map(find);
    for (const a of assign)
      await setMember(ctx.db, app.id, {
        userId: a.person.id,
        roleKey: a.roleKey,
        attributes: a.attributes,
        by: ctx.userId,
      });
    for (const p of remove) await removeMember(ctx.db, app.id, p.id);
    return {
      assigned: assign.length,
      removed: remove.length,
      markdown: `Listo en **${app.name}**: ${assign.length} asignados${assign.length ? ` (${assign.map((a) => `${a.person.email} → ${a.roleKey}`).join(', ')})` : ''} y ${remove.length} quitados.`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.invite_users
// ---------------------------------------------------------------------------

const inviteUserInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().min(3).max(200),
  roleKey: roleKeySchema,
  attributes: attributesSchema.optional(),
});

export const appsInviteUsers = registerTool({
  id: 'apps.invite_users',
  description:
    'Invite EXTERNAL users (operators, clients: people with no Cortex account) to an application: name, email, role and optional attributes ($user.<attribute> in row filters, e.g. {"cliente": "Andina"}). They get an email with the link /a/<app> and enter with a 6-digit code sent by email. They do NOT count as seats. Re-inviting an email updates its name/role/attributes. The app must be published for the link to open (the email is held back with a note if it is a draft). Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    users: z
      .array(inviteUserInput)
      .min(1)
      .max(100)
      .describe('Each: name, email, roleKey (an existing role of the app), attributes?.'),
    send: z.boolean().default(true).describe('false = add to the list without emailing yet.'),
  }),
  outputSchema: z.object({
    invited: z.number().int(),
    emailed: z.number().int(),
    notes: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const ids: string[] = [];
    const notes: string[] = [];
    for (const u of input.users) {
      try {
        const { user } = await inviteAppUser(ctx.db, app.id, u, ctx.userId);
        ids.push(user.id);
      } catch (err) {
        notes.push(`${u.email}: ${err instanceof Error ? err.message : 'no se pudo invitar'}`);
      }
    }
    let emailed = 0;
    if (input.send !== false && ids.length) {
      if (!ctx.sendAppInvitations)
        notes.push(
          'Desde aquí no puedo mandar correos: quedaron en la lista; envía la invitación desde la pestaña «Usuarios» del editor.',
        );
      else {
        const res = await ctx.sendAppInvitations({ appId: app.id, userIds: ids });
        emailed = res.sent;
        for (const f of res.failed) notes.push(`${f.email}: ${f.reason}`);
      }
    }
    return {
      invited: ids.length,
      emailed,
      notes,
      markdown: `Invité a ${ids.length} persona(s) a **${app.name}**${emailed ? ` y mandé ${emailed} correo(s) con el enlace /a/${app.id}` : ''}.${notes.length ? ` Ojo: ${notes.join(' · ')}` : ''}`,
    };
  },
});
