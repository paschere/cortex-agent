import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager, listDirectory } from '../directory/store';
import { registerTool } from '../index';
import { internalSourcesOf } from '../views/sources';
import { viewSpecSchema } from '../views/spec';
import { updateView, validateSpec } from '../views/store';
import { SPEC_GRAMMAR } from '../views/tools';
import { inviteAppUser, listAppUsers } from './external';
import { installAppTemplate } from './install';
import { appPermissionsSchema, roleKeySchema } from './permissions';
import {
  MAX_APP_ROLES,
  MAX_APP_SCREENS,
  addScreen,
  appSummary,
  attributesSchema,
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

export const appsUpdate = registerTool({
  id: 'apps.update',
  description: `Change an existing application (get its slugs first with apps.get): rename it, change its description/icon/home screen, add, edit, remove or reorder screens, and replace its set of roles with their permissions. Every piece is validated exactly like the visual editor: screen specs against the real tables (same grammar as views.create / views.update), roles against the permission contract. Removing a role also removes the Cortex members and keeps NO external users on it (change their role first). Removing a screen archives its view (data in the tables is untouched). Does NOT publish (apps.publish) nor assign people (apps.assign_members / apps.invite_users). If the app is published, a screen cannot read internal sources (Feed, personal, platform-internal). Requires confirmation; company owners/admins only.
${PERMISSIONS_GRAMMAR}
${SPEC_GRAMMAR}`,
  inputSchema: z
    .object({
      app: z.string().trim().min(1).max(80).describe('App id or slug.'),
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
    if (
      input.name !== undefined ||
      input.description !== undefined ||
      input.icon !== undefined ||
      input.homeScreen !== undefined
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
        userId: ctx.userId,
      });
      changes.push('datos de la app');
    }
    const summary = appSummary(app, await listScreens(ctx.db, app.id));
    return {
      app: summary,
      changes,
      markdown: `Listo, cambié **${app.name}**: ${changes.join('; ')}. ${app.status === 'published' ? 'Sigue publicada.' : 'Está en borrador: publícala con apps.publish.'}`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.publish
// ---------------------------------------------------------------------------

export const appsPublish = registerTool({
  id: 'apps.publish',
  description:
    'Publish an application (so its members and invited external users can enter) or unpublish it back to draft. Publishing is refused, with the list, if any screen reads an internal source (Feed, personal, platform-internal): an app opens screens to people outside the team. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    publish: z.boolean().default(true).describe('false = unpublish (back to draft).'),
  }),
  outputSchema: z.object({ app: summarySchema, markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const current = await mustGetApp(ctx.db, input.app);
    const publish = input.publish !== false;
    const app = await updateApp(ctx.db, current.id, {
      status: publish ? 'published' : 'draft',
      userId: ctx.userId,
    });
    return {
      app: appSummary(app, await listScreens(ctx.db, app.id)),
      markdown: publish
        ? `**${app.name}** está publicada. Entrada para usuarios externos: /a/${app.id}; los miembros entran por ${`/apps/${app.slug}`}.`
        : `**${app.name}** volvió a borrador: nadie más que quien administra puede abrirla.`,
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
