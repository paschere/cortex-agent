import { randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { TRACKER_COLUMNS, type TrackerRow } from '../trackers/store';
import { type ComputedView, type ViewSource, computeView } from '../views/compute';
import { internalShareRefusal, internalSourcesOf } from '../views/sources';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, type ViewSpec, slugify } from '../views/spec';
import {
  type ActorKind,
  type CustomViewRow,
  SubmissionLimitError,
  VIEW_COLUMNS,
  ViewWriteLimitError,
  archiveView,
  createView,
  editViewRow,
  editViewSubmission,
  loadViewSources,
  runViewAction,
  submitViewForm,
  updateView,
  validateSpec,
} from '../views/store';
import type { ViewFilterState } from '../views/view-filters';
import {
  type AppPermissions,
  type AppUser,
  type ResolvedRole,
  type RowScope,
  adminRole,
  appPermissionsSchema,
  canCreateIn,
  canExport,
  canRunAction,
  canSeeScreen,
  editAccessFor,
  fieldsOutside,
  isOwnRow,
  parsePermissions,
  roleKeySchema,
  rowAccessFor,
  rowScopeFor,
  rowVisible,
} from './permissions';

/**
 * Lectura y escritura de las aplicaciones (migración 0208).
 *
 * `db` es siempre un handle con alcance de espacio (`getOrgScopedClient`):
 * nada de aquí filtra por organization_id a mano, y una app de otra empresa
 * simplemente no existe para este handle (NotFound, nunca Forbidden).
 *
 * UNA PANTALLA ES UNA VISTA. Su spec vive en `custom_views` con `app_id`, y
 * las escrituras de una pantalla (`submitAppForm`, `editAppRow`,
 * `runAppAction`, `editAppSubmission`) son las funciones de las vistas con UNA
 * capa delante: el rol. Esa capa decide, con el spec y el rol GUARDADOS,
 * nunca con lo que mande el navegador:
 *
 *   - qué pantallas ve (`screenFor`: una ajena es null → 404 en la ruta);
 *   - qué filas lee (`readScreen`: el scope entra a `loadViewSources` ANTES de
 *     calcular métricas, gráficos o el Excel);
 *   - qué escribe: crear, editar own/all, qué campos, qué botones; y una fila
 *     que el rol no VE tampoco se toca («no puedes tocar lo que no ves»).
 *
 * FUENTES. Para quien no es administrador de la empresa, una app usa la misma
 * barrera que el enlace público: sólo tablas propias y fuentes `cortex.*`
 * shareables; nunca el Feed ni fuentes internas o personales (`audience:
 * 'public'` en `loadViewSources`). Publicar una pantalla con una fuente así
 * se rechaza con la lista (`assertAppSources`), igual que `setViewAccess`.
 */

export const APP_COLUMNS =
  'id, organization_id, slug, name, description, icon, theme, home_screen, status, version, created_by, updated_by, created_at, updated_at, archived_at';
const SCREEN_COLUMNS =
  'id, app_id, view_id, slug, title, icon, position, roles, created_at, updated_at';
const ROLE_COLUMNS = 'id, app_id, key, name, description, permissions, position';
const MEMBER_COLUMNS = 'id, app_id, user_id, role_key, attributes, created_by, created_at';

export const MAX_APP_SCREENS = 12;
export const MAX_APP_ROLES = 8;

export type AppStatus = 'draft' | 'published';

export interface AppTheme {
  accent?: 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';
  style?: 'clean' | 'bold' | 'dark-panel';
}

export const appThemeSchema = z.object({
  accent: z.enum(['primary', 'emerald', 'amber', 'sky', 'rose']).optional(),
  style: z.enum(['clean', 'bold', 'dark-panel']).optional(),
});

export interface CustomAppRow {
  id: string;
  organization_id?: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  theme: AppTheme;
  home_screen: string | null;
  status: AppStatus;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface AppScreenRow {
  id: string;
  app_id: string;
  view_id: string;
  slug: string;
  title: string;
  icon: string;
  position: number;
  roles: string[];
}

export interface AppRoleRow {
  id: string;
  app_id: string;
  key: string;
  name: string;
  description: string;
  permissions: AppPermissions;
  position: number;
}

export interface AppMemberRow {
  id: string;
  app_id: string;
  user_id: string;
  role_key: string;
  attributes: Record<string, string>;
  created_by: string | null;
  created_at: string;
}

export const APP_SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adaptApp(row: Record<string, unknown>): CustomAppRow {
  const theme = appThemeSchema.safeParse(row.theme ?? {});
  return {
    ...(row as unknown as CustomAppRow),
    description: typeof row.description === 'string' ? row.description : '',
    theme: theme.success ? theme.data : {},
    home_screen: typeof row.home_screen === 'string' ? row.home_screen : null,
  };
}

function adaptScreen(row: Record<string, unknown>): AppScreenRow {
  return {
    ...(row as unknown as AppScreenRow),
    roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
    position: Number(row.position ?? 0),
  };
}

function adaptRole(row: Record<string, unknown>): AppRoleRow {
  return {
    ...(row as unknown as AppRoleRow),
    description: typeof row.description === 'string' ? row.description : '',
    permissions: parsePermissions(row.permissions),
    position: Number(row.position ?? 0),
  };
}

function adaptMember(row: Record<string, unknown>): AppMemberRow {
  const attrs =
    row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? Object.fromEntries(
          Object.entries(row.attributes as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, String(v)]),
        )
      : {};
  return { ...(row as unknown as AppMemberRow), attributes: attrs };
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export async function listApps(db: SupabaseClient, limit = 60): Promise<CustomAppRow[]> {
  const { data, error } = await db
    .from('custom_apps')
    .select(APP_COLUMNS)
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adaptApp(r as Record<string, unknown>));
}

/** Por id o por slug: el chat nombra apps como la gente, la app por id. */
export async function getApp(db: SupabaseClient, ref: string): Promise<CustomAppRow | null> {
  const q = db.from('custom_apps').select(APP_COLUMNS).is('archived_at', null);
  const { data, error } = await (UUID_RE.test(ref)
    ? q.eq('id', ref)
    : q.eq('slug', ref)
  ).maybeSingle();
  if (error) throw error;
  return data ? adaptApp(data as Record<string, unknown>) : null;
}

export async function mustGetApp(db: SupabaseClient, ref: string): Promise<CustomAppRow> {
  const app = await getApp(db, ref);
  if (!app) throw new NotFoundError(`No hay una aplicación «${ref}» en este espacio.`);
  return app;
}

async function freeAppSlug(db: SupabaseClient, wanted: string): Promise<string> {
  const base = APP_SLUG_RE.test(wanted) ? wanted : slugify(wanted);
  const { data, error } = await db.from('custom_apps').select('slug').like('slug', `${base}%`);
  if (error) throw error;
  const taken = new Set((data ?? []).map((r) => String((r as { slug: string }).slug)));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base.slice(0, 44)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 36)}_${randomBytes(4).toString('hex')}`;
}

export async function createApp(
  db: SupabaseClient,
  input: {
    name: string;
    description?: string;
    slug?: string;
    icon?: string;
    theme?: AppTheme;
    userId: string;
  },
): Promise<CustomAppRow> {
  const slug = await freeAppSlug(db, input.slug ?? slugify(input.name));
  const { data, error } = await db
    .from('custom_apps')
    .insert({
      slug,
      name: input.name.trim().slice(0, 80),
      description: (input.description ?? '').trim().slice(0, 500),
      icon: (input.icon ?? '').trim().slice(0, 400) || '📱',
      theme: input.theme ?? {},
      status: 'draft',
      version: 1,
      created_by: input.userId,
      updated_by: input.userId,
    })
    .select(APP_COLUMNS)
    .single();
  if (error) throw error;
  return adaptApp(data as Record<string, unknown>);
}

export async function updateApp(
  db: SupabaseClient,
  id: string,
  input: {
    name?: string;
    description?: string;
    icon?: string;
    theme?: AppTheme;
    homeScreen?: string | null;
    status?: AppStatus;
    userId: string;
  },
): Promise<CustomAppRow> {
  const current = await mustGetApp(db, id);
  const patch: Record<string, unknown> = {
    updated_by: input.userId,
    updated_at: new Date().toISOString(),
    version: current.version + 1,
  };
  if (input.name !== undefined) patch.name = input.name.trim().slice(0, 80);
  if (input.description !== undefined) patch.description = input.description.trim().slice(0, 500);
  if (input.icon !== undefined) patch.icon = input.icon.trim().slice(0, 400) || '📱';
  if (input.theme !== undefined) patch.theme = input.theme;
  if (input.homeScreen !== undefined) patch.home_screen = input.homeScreen;
  if (input.status !== undefined) {
    // Publicar es abrirle la puerta a quien no es del equipo: se comprueban
    // las fuentes de todas las pantallas, como `setViewAccess`.
    if (input.status === 'published') await assertAppSources(db, current.id);
    patch.status = input.status;
  }
  const { data, error } = await db
    .from('custom_apps')
    .update(patch)
    .eq('id', current.id)
    .select(APP_COLUMNS)
    .single();
  if (error) throw error;
  return adaptApp(data as Record<string, unknown>);
}

/** Archiva la app y sus pantallas (las vistas con su `app_id`). Los datos de las tablas no se tocan. */
export async function archiveApp(db: SupabaseClient, id: string): Promise<boolean> {
  const app = await getApp(db, id);
  if (!app) return false;
  const screens = await listScreens(db, app.id);
  for (const s of screens) await archiveView(db, s.view_id, { appScreen: true });
  const { error } = await db
    .from('custom_apps')
    .update({ archived_at: new Date().toISOString(), status: 'draft' })
    .eq('id', app.id)
    .is('archived_at', null);
  if (error) throw error;
  return true;
}

/**
 * Las fuentes que una app NO puede usar: las mismas que una vista no puede
 * compartir (internas, personales, Feed). Lanza con la lista si alguna
 * pantalla las usa.
 */
export async function assertAppSources(db: SupabaseClient, appId: string): Promise<void> {
  const screens = await listScreens(db, appId);
  const views = await screenViews(db, screens);
  const bad = [...views.values()].flatMap((v) => internalSourcesOf(v.spec));
  if (bad.length) {
    const unique = [...new Map(bad.map((b) => [b.id, b])).values()];
    throw new ValidationError(
      `No se puede publicar: ${internalShareRefusal(unique).replace('Esta vista usa', 'una pantalla usa')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------

export async function listScreens(db: SupabaseClient, appId: string): Promise<AppScreenRow[]> {
  const { data, error } = await db
    .from('custom_app_screens')
    .select(SCREEN_COLUMNS)
    .eq('app_id', appId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => adaptScreen(r as Record<string, unknown>));
}

/** Las vistas de estas pantallas, por id de vista. Una archivada no aparece. */
export async function screenViews(
  db: SupabaseClient,
  screens: AppScreenRow[],
): Promise<Map<string, CustomViewRow>> {
  const out = new Map<string, CustomViewRow>();
  if (!screens.length) return out;
  const { data, error } = await db
    .from('custom_views')
    .select(VIEW_COLUMNS)
    .in(
      'id',
      screens.map((s) => s.view_id),
    )
    .is('archived_at', null);
  if (error) throw error;
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const view = adaptView(row);
    out.set(view.id, view);
  }
  return out;
}

/** El mismo `adapt` de views/store, que no se exporta: un spec que no pasa el contrato se pinta como aviso. */
function adaptView(row: Record<string, unknown>): CustomViewRow {
  // `getView` adapta; aquí se reusa su contrato leyendo por id.
  return {
    ...(row as unknown as CustomViewRow),
    description: typeof row.description === 'string' ? row.description : '',
    spec: row.spec as ViewSpec,
  };
}

/**
 * Nombres que una pantalla no puede usar porque son rutas fijas bajo
 * /a/<app>/ (apps/web/app/a/[app]/): la pantalla quedaría tapada. Las demás
 * rutas fijas (manifest, íconos, sw.js) llevan punto o guion y el patrón de
 * slug ya las excluye.
 */
export const RESERVED_SCREEN_SLUGS = new Set(['kiosco']);

const screenSlugSchema = z
  .string()
  .trim()
  .regex(APP_SLUG_RE)
  .refine((s) => !RESERVED_SCREEN_SLUGS.has(s), 'Ese nombre de pantalla está reservado.');

async function freeScreenSlug(db: SupabaseClient, appId: string, wanted: string): Promise<string> {
  const raw = APP_SLUG_RE.test(wanted) ? wanted : slugify(wanted);
  const base = RESERVED_SCREEN_SLUGS.has(raw) ? `${raw}_pantalla` : raw;
  const existing = new Set((await listScreens(db, appId)).map((s) => s.slug));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base.slice(0, 44)}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base.slice(0, 36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * Crea la pantalla con su vista. El spec pasa por `validateSpec` (forma y
 * catálogo) y la vista nace con `app_id`, así que no sale en /views.
 */
export async function addScreen(
  db: SupabaseClient,
  app: CustomAppRow,
  input: {
    title: string;
    slug?: string;
    icon?: string;
    spec: unknown;
    roles?: string[];
    userId: string;
    prompt?: string | null;
  },
): Promise<AppScreenRow> {
  const screens = await listScreens(db, app.id);
  if (screens.length >= MAX_APP_SCREENS)
    throw new ValidationError(`Una aplicación lleva hasta ${MAX_APP_SCREENS} pantallas.`);
  const spec = await validateSpec(db, input.spec, { viewerId: input.userId });
  const slug = await freeScreenSlug(db, app.id, input.slug ?? slugify(input.title));
  const view = await createView(db, {
    name: `${app.name} · ${input.title}`.slice(0, 80),
    description: '',
    slug: `${app.slug}_${slug}`.slice(0, 48),
    spec,
    userId: input.userId,
    prompt: input.prompt ?? null,
    appId: app.id,
  });
  const { data, error } = await db
    .from('custom_app_screens')
    .insert({
      app_id: app.id,
      view_id: view.id,
      slug,
      title: input.title.trim().slice(0, 60),
      icon: (input.icon ?? '').trim().slice(0, 60) || 'LayoutPanelTop',
      position: screens.length,
      roles: (input.roles ?? []).filter((r) => roleKeySchema.safeParse(r).success),
    })
    .select(SCREEN_COLUMNS)
    .single();
  if (error) throw error;
  return adaptScreen(data as Record<string, unknown>);
}

export async function updateScreen(
  db: SupabaseClient,
  appId: string,
  screenId: string,
  input: { title?: string; icon?: string; roles?: string[]; slug?: string },
): Promise<AppScreenRow> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title.trim().slice(0, 60);
  if (input.icon !== undefined) patch.icon = input.icon.trim().slice(0, 60) || 'LayoutPanelTop';
  if (input.roles !== undefined)
    patch.roles = input.roles.filter((r) => roleKeySchema.safeParse(r).success);
  if (input.slug !== undefined) patch.slug = screenSlugSchema.parse(input.slug);
  const { data, error } = await db
    .from('custom_app_screens')
    .update(patch)
    .eq('app_id', appId)
    .eq('id', screenId)
    .select(SCREEN_COLUMNS)
    .single();
  if (error) throw error;
  return adaptScreen(data as Record<string, unknown>);
}

/** El orden nuevo: ids de pantalla, de arriba abajo. Las que falten van al final. */
export async function reorderScreens(
  db: SupabaseClient,
  appId: string,
  orderedIds: string[],
): Promise<void> {
  const screens = await listScreens(db, appId);
  const wanted = orderedIds.filter((id) => screens.some((s) => s.id === id));
  const rest = screens.map((s) => s.id).filter((id) => !wanted.includes(id));
  const order = [...wanted, ...rest];
  for (const [i, id] of order.entries()) {
    const { error } = await db
      .from('custom_app_screens')
      .update({ position: i })
      .eq('app_id', appId)
      .eq('id', id);
    if (error) throw error;
  }
}

/** Quita la pantalla y archiva su vista (versiones y envíos se conservan). */
export async function removeScreen(db: SupabaseClient, appId: string, screenId: string) {
  const screens = await listScreens(db, appId);
  const screen = screens.find((s) => s.id === screenId);
  if (!screen) throw new NotFoundError('Esa pantalla ya no está en la aplicación.');
  const { error } = await db
    .from('custom_app_screens')
    .delete()
    .eq('app_id', appId)
    .eq('id', screenId);
  if (error) throw error;
  await archiveView(db, screen.view_id, { appScreen: true });
}

// ---------------------------------------------------------------------------
// Roles y miembros
// ---------------------------------------------------------------------------

export async function listRoles(db: SupabaseClient, appId: string): Promise<AppRoleRow[]> {
  const { data, error } = await db
    .from('custom_app_roles')
    .select(ROLE_COLUMNS)
    .eq('app_id', appId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => adaptRole(r as Record<string, unknown>));
}

export const roleInputSchema = z.object({
  key: roleKeySchema,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  permissions: appPermissionsSchema.default({ tables: {}, export: false }),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

/**
 * Guarda el conjunto de roles de la app: los que vienen se crean o actualizan
 * (por clave), los que no vienen se borran y sus miembros quedan sin rol
 * (fuera de la app hasta que se les asigne otro). La clave del administrador
 * está reservada.
 */
export async function saveRoles(
  db: SupabaseClient,
  appId: string,
  roles: RoleInput[],
): Promise<AppRoleRow[]> {
  if (roles.length > MAX_APP_ROLES)
    throw new ValidationError(`Una aplicación lleva hasta ${MAX_APP_ROLES} roles.`);
  const keys = new Set<string>();
  for (const r of roles) {
    if (r.key === 'administrador')
      throw new ValidationError('«administrador» es el rol de quien administra la empresa.');
    if (keys.has(r.key)) throw new ValidationError(`El rol «${r.key}» está repetido.`);
    keys.add(r.key);
  }
  const current = await listRoles(db, appId);
  const gone = current.filter((c) => !keys.has(c.key));
  if (gone.length) {
    const { error } = await db
      .from('custom_app_roles')
      .delete()
      .eq('app_id', appId)
      .in(
        'key',
        gone.map((g) => g.key),
      );
    if (error) throw error;
    const { error: mErr } = await db
      .from('custom_app_members')
      .delete()
      .eq('app_id', appId)
      .in(
        'role_key',
        gone.map((g) => g.key),
      );
    if (mErr) throw mErr;
  }
  for (const [i, r] of roles.entries()) {
    const existing = current.find((c) => c.key === r.key);
    const row = {
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      position: i,
      updated_at: new Date().toISOString(),
    };
    const { error } = existing
      ? await db.from('custom_app_roles').update(row).eq('app_id', appId).eq('key', r.key)
      : await db.from('custom_app_roles').insert({ ...row, app_id: appId, key: r.key });
    if (error) throw error;
  }
  return listRoles(db, appId);
}

export async function listMembers(db: SupabaseClient, appId: string): Promise<AppMemberRow[]> {
  const { data, error } = await db
    .from('custom_app_members')
    .select(MEMBER_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => adaptMember(r as Record<string, unknown>));
}

export const attributesSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().trim().max(120))
  .default({});

/** Asigna (o cambia) el rol de un miembro de Cortex en la app, con sus atributos. */
export async function setMember(
  db: SupabaseClient,
  appId: string,
  input: { userId: string; roleKey: string; attributes?: Record<string, string>; by: string },
): Promise<AppMemberRow> {
  const roles = await listRoles(db, appId);
  if (!roles.some((r) => r.key === input.roleKey))
    throw new ValidationError(`La aplicación no tiene el rol «${input.roleKey}».`);
  const attributes = attributesSchema.parse(input.attributes ?? {});
  const existing = (await listMembers(db, appId)).find((m) => m.user_id === input.userId);
  const row = { role_key: input.roleKey, attributes, updated_at: new Date().toISOString() };
  const res = existing
    ? await db
        .from('custom_app_members')
        .update(row)
        .eq('app_id', appId)
        .eq('user_id', input.userId)
        .select(MEMBER_COLUMNS)
        .single()
    : await db
        .from('custom_app_members')
        .insert({ ...row, app_id: appId, user_id: input.userId, created_by: input.by })
        .select(MEMBER_COLUMNS)
        .single();
  if (res.error) throw res.error;
  return adaptMember(res.data as Record<string, unknown>);
}

export async function removeMember(db: SupabaseClient, appId: string, userId: string) {
  const { error } = await db
    .from('custom_app_members')
    .delete()
    .eq('app_id', appId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Acceso: quién entra y con qué rol
// ---------------------------------------------------------------------------

/** Quien pide, tal como lo conoce la sesión. `companyAdmin` lo decide la capa web. */
export interface AppViewer {
  id: string;
  name: string;
  /** Owner o admin de la empresa: entra a cualquier app como administrador. */
  companyAdmin: boolean;
}

/** Todo lo que una ruta necesita para pintar y escribir: la app, el rol y quien mira. */
export interface AppAccess {
  app: CustomAppRow;
  role: ResolvedRole;
  user: AppUser;
  screens: AppScreenRow[];
}

/**
 * Resuelve el acceso de un miembro a una app, o null si no entra. Un
 * administrador de la empresa entra siempre; cualquier otro necesita una
 * fila en `custom_app_members` con un rol que exista. Una app sin publicar
 * sólo la abren quienes administran (los demás la ven cuando se publique).
 *
 * `preview` = «Ver como…»: un administrador mira la app con un rol concreto y
 * datos reales, sin escribir (la ruta lo pinta en sólo lectura).
 */
export async function resolveAppAccess(
  db: SupabaseClient,
  ref: string,
  viewer: AppViewer,
  options: { preview?: { roleKey: string; attributes?: Record<string, string> } } = {},
): Promise<AppAccess | null> {
  const app = await getApp(db, ref);
  if (!app) return null;
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  if (viewer.companyAdmin) {
    if (options.preview) {
      const roles = await listRoles(db, app.id);
      const role = roles.find((r) => r.key === options.preview?.roleKey);
      if (!role) return null;
      return {
        app,
        screens,
        role: { key: role.key, name: role.name, permissions: role.permissions, admin: false },
        user: {
          id: viewer.id,
          name: viewer.name,
          attributes: attributesSchema.parse(options.preview.attributes ?? {}),
        },
      };
    }
    return {
      app,
      screens,
      role: adminRole(),
      user: { id: viewer.id, name: viewer.name, attributes: {} },
    };
  }
  if (app.status !== 'published') return null;
  const member = (await listMembers(db, app.id)).find((m) => m.user_id === viewer.id);
  if (!member) return null;
  const role = (await listRoles(db, app.id)).find((r) => r.key === member.role_key);
  if (!role) return null;
  return {
    app,
    screens,
    role: { key: role.key, name: role.name, permissions: role.permissions, admin: false },
    user: { id: viewer.id, name: viewer.name, attributes: member.attributes },
  };
}

/** Las pantallas que este rol ve, en el orden del menú. */
export function visibleScreens(access: AppAccess): AppScreenRow[] {
  return access.screens.filter((s) => canSeeScreen(access.role, s.roles));
}

/**
 * La pantalla pedida (por slug o id) SI el rol la ve; si no, null, que la
 * ruta convierte en 404 — una pantalla ajena no existe para ese rol, y no se
 * distingue de una que no existe para nadie.
 */
export function screenFor(access: AppAccess, ref: string | null | undefined): AppScreenRow | null {
  const visible = visibleScreens(access);
  if (!ref) {
    const home = access.app.home_screen
      ? visible.find((s) => s.slug === access.app.home_screen)
      : undefined;
    return home ?? visible[0] ?? null;
  }
  return visible.find((s) => s.slug === ref || s.id === ref) ?? null;
}

/** La vista de una pantalla, o NotFound si se archivó por debajo. */
export async function screenView(db: SupabaseClient, screen: AppScreenRow): Promise<CustomViewRow> {
  const views = await screenViews(db, [screen]);
  const view = views.get(screen.view_id);
  if (!view) throw new NotFoundError('Esa pantalla ya no existe.');
  return view;
}

// ---------------------------------------------------------------------------
// Lectura con scope
// ---------------------------------------------------------------------------

export interface ScreenRead {
  view: CustomViewRow;
  sources: Map<string, ViewSource>;
  computed: ComputedView;
  scope: RowScope[];
}

/**
 * Lee y calcula una pantalla PARA ESTE ROL. El scope de filas entra a
 * `loadViewSources`, así que lo que `computeView` recibe ya es sólo lo que el
 * rol puede ver: cifras, gráficos, tablas y el Excel salen de ese mapa y de
 * ningún otro. `writable` lo decide el rol (edita o tiene botones en alguna
 * tabla), nunca `spec.editing` solo.
 */
export async function readScreen(
  db: SupabaseClient,
  access: AppAccess,
  screen: AppScreenRow,
  options: { spec?: ViewSpec; filters?: ViewFilterState; readOnly?: boolean; now?: Date } = {},
): Promise<ScreenRead> {
  const view = await screenView(db, screen);
  const spec = options.spec ?? view.spec;
  const scope = rowScopeFor(access.role, access.user, spec);
  const sources = await loadViewSources(db, spec, {
    // Quien no administra la empresa ve la app con la barrera del enlace
    // público: nada interno, personal ni del Feed. El administrador la ve
    // como una vista del equipo (y con sus fuentes personales).
    audience: access.role.admin ? 'team' : 'public',
    viewerId: access.role.admin ? access.user.id : null,
    scope,
  });
  const computed = computeView(spec, sources, options.now ?? new Date(), {
    writable: !options.readOnly && roleWrites(access.role, spec),
    audience: access.role.admin ? 'team' : 'public',
    filters: options.filters ?? {},
  });
  return { view, sources, computed, scope };
}

/** ¿Este rol escribe algo en alguna tabla de este spec? */
export function roleWrites(role: ResolvedRole, spec: ViewSpec): boolean {
  if (spec.editing === 'off') return false;
  if (role.admin) return true;
  return Object.values(role.permissions.tables).some(
    (t) => t.edit !== 'none' || t.actions.length > 0,
  );
}

// ---------------------------------------------------------------------------
// Escrituras con rol
// ---------------------------------------------------------------------------

function trackerOfBlock(view: CustomViewRow, blockId: string): string {
  const block = view.spec.blocks.find((b) => b.id === blockId);
  if (!block || !('tracker' in block))
    throw new NotFoundError('Ese bloque no está en esta pantalla.');
  return block.tracker;
}

async function trackerRow(db: SupabaseClient, slug: string): Promise<TrackerRow> {
  const { data, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('La tabla de este bloque ya no existe.');
  return data as unknown as TrackerRow;
}

interface RowOwner {
  values: Record<string, string | number>;
  created_by: string | null;
  created_by_app_user?: string | null;
}

/** Quién escribe: un usuario externo de la app (0209) o un miembro de Cortex. */
export function actorKindOf(access: AppAccess): ActorKind {
  return access.user.external ? 'app_user' : 'member';
}

/**
 * LOS TOPES DE USO DE UN USUARIO EXTERNO, por usuario y por app (decidido
 * 2026-10-06: los usuarios son ilimitados y no cuentan como asientos, pero lo
 * que hacen sí tiene tope). Una hora deslizante. Un miembro de Cortex no pasa
 * por aquí: tiene el tope del plan.
 */
export const EXTERNAL_SUBMISSIONS_PER_USER_HOUR = 60;
export const EXTERNAL_SUBMISSIONS_PER_APP_HOUR = 1000;
export const EXTERNAL_WRITES_PER_USER_HOUR = 240;
export const EXTERNAL_WRITES_PER_APP_HOUR = 3000;

export async function assertExternalBudget(
  db: SupabaseClient,
  access: AppAccess,
  kind: 'submit' | 'write',
  now: Date = new Date(),
): Promise<void> {
  if (!access.user.external) return;
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const viewIds = access.screens.map((s) => s.view_id);
  const table = kind === 'submit' ? 'custom_view_submissions' : 'custom_view_events';
  const userColumn = kind === 'submit' ? 'submitted_by' : 'actor';
  const [mine, all] = await Promise.all([
    db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq(userColumn, access.user.id)
      .gte('created_at', since),
    viewIds.length
      ? db
          .from(table)
          .select('id', { count: 'exact', head: true })
          .in('view_id', viewIds)
          .gte('created_at', since)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  if (mine.error) throw mine.error;
  if (all.error) throw all.error;
  const userCap =
    kind === 'submit' ? EXTERNAL_SUBMISSIONS_PER_USER_HOUR : EXTERNAL_WRITES_PER_USER_HOUR;
  const appCap =
    kind === 'submit' ? EXTERNAL_SUBMISSIONS_PER_APP_HOUR : EXTERNAL_WRITES_PER_APP_HOUR;
  if ((mine.count ?? 0) >= userCap || (all.count ?? 0) >= appCap)
    throw kind === 'submit' ? new SubmissionLimitError() : new ViewWriteLimitError();
}

/**
 * La fila tiene que ser VISIBLE para el rol antes de tocarla. Una que no pasa
 * el scope es «no existe» (NotFound), no «prohibida»: no se confirma que esté.
 */
async function assertRowVisible(
  db: SupabaseClient,
  access: AppAccess,
  slug: string,
  rowId: string,
): Promise<RowOwner> {
  const tracker = await trackerRow(db, slug);
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, values, created_by, created_by_app_user')
    .eq('id', rowId)
    .eq('tracker_id', tracker.id)
    .maybeSingle();
  if (error) throw error;
  const row = data as RowOwner | null;
  if (!row || !rowVisible(rowAccessFor(access.role, access.user, slug), row))
    throw new NotFoundError('Esa fila ya no está en la tabla.');
  return row;
}

function assertFields(access: AppAccess, slug: string, keys: string[]) {
  const outside = fieldsOutside(access.role, slug, keys);
  if (outside.length)
    throw new ValidationError(
      `Tu rol no puede escribir ${outside.map((k) => `«${k}»`).join(', ')}.`,
    );
}

/** Enviar un formulario de una pantalla: el rol tiene que poder crear en esa tabla. */
export async function submitAppForm(
  db: SupabaseClient,
  access: AppAccess,
  view: CustomViewRow,
  input: {
    blockId: string;
    values: Record<string, unknown>;
    clientId?: string | null;
  },
) {
  const slug = trackerOfBlock(view, input.blockId);
  if (!canCreateIn(access.role, slug))
    throw new ValidationError('Tu rol en esta aplicación no registra en esta tabla.');
  const values = { ...input.values };
  assertFields(
    access,
    slug,
    Object.keys(values).filter((k) => values[k] !== undefined && values[k] !== ''),
  );
  // Quien ve «las filas donde Cliente = su cliente» sólo crea filas de SU
  // cliente: el campo del scope lo pone el servidor, no el formulario.
  const scope = rowAccessFor(access.role, access.user, slug);
  let forced: Record<string, string> | undefined;
  if (scope.kind === 'equals') {
    if (scope.value === null)
      throw new ValidationError('Tu usuario no tiene el atributo que esta tabla necesita.');
    // `forced`, no `values`: el formulario puede no pedir ese campo (el cliente
    // no lo ve ni lo escribe) y aun así la fila tiene que quedar con su valor.
    forced = { [scope.field]: scope.value };
  }
  await assertExternalBudget(db, access, 'submit');
  return submitViewForm(db, view, {
    blockId: input.blockId,
    values,
    forced,
    fillDefaults: true,
    submittedBy: access.user.id,
    submittedByKind: actorKindOf(access),
    viewer: access.user.name,
    clientId: input.clientId,
  });
}

/** Corregir lo enviado (dentro de la ventana): quien pudo crear puede corregir lo suyo. */
export async function editAppSubmission(
  db: SupabaseClient,
  access: AppAccess,
  view: CustomViewRow,
  input: { blockId: string; rowId: string; values: Record<string, string> },
) {
  const slug = trackerOfBlock(view, input.blockId);
  if (!canCreateIn(access.role, slug) && editAccessFor(access.role, slug) === 'none')
    throw new ValidationError('Tu rol en esta aplicación no corrige en esta tabla.');
  await assertRowVisible(db, access, slug, input.rowId);
  assertFields(access, slug, Object.keys(input.values));
  await assertExternalBudget(db, access, 'write');
  return editViewSubmission(db, view, {
    ...input,
    actor: access.user.id,
    actorKind: actorKindOf(access),
  });
}

/** Editar una celda, mover una tarjeta o cambiar un campo desde la ficha. */
export async function editAppRow(
  db: SupabaseClient,
  access: AppAccess,
  view: CustomViewRow,
  input: { blockId: string; rowId: string; patch: Record<string, unknown> },
) {
  const slug = trackerOfBlock(view, input.blockId);
  const edit = editAccessFor(access.role, slug);
  if (edit === 'none') throw new ValidationError('Tu rol en esta aplicación no edita esta tabla.');
  const row = await assertRowVisible(db, access, slug, input.rowId);
  if (edit === 'own' && !isOwnRow(access.user, row))
    throw new ValidationError('Sólo puedes editar lo que registraste tú.');
  assertFields(access, slug, Object.keys(input.patch));
  await assertExternalBudget(db, access, 'write');
  return editViewRow(db, view, { ...input, actor: access.user.id, actorKind: actorKindOf(access) });
}

/** Un botón de fila, incluidos Aprobar y Rechazar: el rol lo tiene que tener. */
export async function runAppAction(
  db: SupabaseClient,
  access: AppAccess,
  view: CustomViewRow,
  input: { blockId: string; actionId: string; rowId: string; reason?: string | null },
) {
  const slug = trackerOfBlock(view, input.blockId);
  if (!canRunAction(access.role, slug, input.actionId)) {
    const approval = input.actionId === APPROVE_ACTION_ID || input.actionId === REJECT_ACTION_ID;
    throw new ValidationError(
      approval
        ? 'Tu rol en esta aplicación no aprueba ni rechaza.'
        : 'Tu rol en esta aplicación no tiene ese botón.',
    );
  }
  await assertRowVisible(db, access, slug, input.rowId);
  await assertExternalBudget(db, access, 'write');
  return runViewAction(db, view, {
    ...input,
    actor: access.user.id,
    actorKind: actorKindOf(access),
  });
}

export function appCanExport(access: AppAccess): boolean {
  return canExport(access.role);
}

// ---------------------------------------------------------------------------
// Resumen (chat y listados)
// ---------------------------------------------------------------------------

export function appUrl(slug: string): string {
  return `/apps/${slug}`;
}

export function appSummary(app: CustomAppRow, screens: AppScreenRow[] = []) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    icon: app.icon,
    status: app.status,
    screens: screens.map((s) => ({ slug: s.slug, title: s.title, roles: s.roles })),
    url: appUrl(app.slug),
    editUrl: `/apps/${app.id}/edit`,
    updatedAt: app.updated_at,
  };
}

/** Quién mira, a partir de la sesión: la regla de «administrador» en un solo sitio. */
export function viewerFromSession(user: {
  id: string;
  name: string | null;
  email: string;
  role: string;
  organization: { role: string };
}): AppViewer {
  return {
    id: user.id,
    name: user.name || user.email,
    companyAdmin:
      user.role === 'org_admin' ||
      user.organization.role === 'owner' ||
      user.organization.role === 'admin',
  };
}

/** Guardar el spec de una pantalla: quien llama ya comprobó que administra la empresa. */
export function updateScreenView(
  db: SupabaseClient,
  id: string,
  input: Parameters<typeof updateView>[2],
) {
  return updateView(db, id, { ...input, appScreen: true });
}
