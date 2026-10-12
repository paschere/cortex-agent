import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { updateView, validateSpec } from '../views/store';
import {
  type AppRoleRow,
  type AppScreenRow,
  type CustomAppRow,
  addScreen,
  assertAppSources,
  listRoles,
  listScreens,
  loadPublishedSnapshot,
  mustGetApp,
  removeScreen,
  reorderScreens,
  saveRoles,
  screenViews,
  updateApp,
  updateScreen,
} from './store';
import {
  type Snapshot,
  type VersionChange,
  buildSnapshot,
  diffSnapshots,
  hasUnpublishedChanges,
  parseSnapshot,
  summarizeChanges,
} from './versions-shape';

/**
 * VERSIONES DE UNA APP: LA PARTE QUE TOCA LA BASE (migración 0225).
 *
 * Las reglas (qué guarda una foto, cómo se compara, qué ve cada quien) son
 * puras y viven en versions-shape.ts. Aquí: sacar la foto del borrador,
 * guardarla como versión N al publicar, listar el historial con su resumen de
 * cambios, y «Volver a esta versión» —que devuelve el BORRADOR a lo que decía
 * esa versión (y, si se pide, la publica de una vez).
 *
 * Publicar es lo único que cambia lo que ven los usuarios. Todo lo demás
 * (el editor, el chat con apps.update, plantillas, restaurar) deja cambios en el
 * borrador, visibles sólo para quien administra («Ver como…»).
 */

/** Cuántas versiones se conservan por app; las más viejas se podan al publicar. */
export const MAX_VERSIONS_KEPT = 50;

export interface AppVersionRow {
  id: string;
  app_id: string;
  number: number;
  note: string;
  created_by: string | null;
  created_at: string;
  spec: unknown;
}

const VERSION_COLUMNS = 'id, app_id, number, note, created_by, created_at, spec';

/** La foto del borrador de hoy (lo que se publicaría ahora). */
export async function draftSnapshot(db: SupabaseClient, app: CustomAppRow): Promise<Snapshot> {
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  const views = await screenViews(db, screens);
  const roles = await listRoles(db, app.id);
  return buildSnapshot({
    app,
    screens,
    views: new Map([...views.entries()].map(([id, v]) => [id, { name: v.name, spec: v.spec }])),
    roles,
  });
}

export interface VersionSummary {
  number: number;
  note: string;
  createdAt: string;
  createdBy: string | null;
  /** Es la que ven los usuarios hoy. */
  current: boolean;
  /** Qué cambió respecto a la anterior (la primera: «Primera versión…»). */
  changes: VersionChange[];
  summary: string;
  screens: number;
  roles: number;
}

/** El historial, de la más nueva a la más vieja, con el resumen de cambios de cada una. */
export async function listVersions(
  db: SupabaseClient,
  appId: string,
  limit = 30,
): Promise<VersionSummary[]> {
  const { data, error } = await db
    .from('app_versions')
    .select(VERSION_COLUMNS)
    .eq('app_id', appId)
    .order('number', { ascending: false })
    .limit(limit + 1);
  if (error) throw error;
  const rows = (data ?? []) as AppVersionRow[];
  const snaps = rows.map((r) => parseSnapshot(r.spec));
  return rows.slice(0, limit).map((row, i) => {
    const snap = snaps[i];
    const prev = snaps[i + 1] ?? null;
    const changes = snap ? diffSnapshots(prev, snap) : [];
    return {
      number: row.number,
      note: row.note,
      createdAt: row.created_at,
      createdBy: row.created_by,
      current: i === 0,
      changes,
      summary: snap ? summarizeChanges(changes) : 'No se pudo leer esta versión',
      screens: snap?.screens.length ?? 0,
      roles: snap?.roles.length ?? 0,
    };
  });
}

export async function getVersion(
  db: SupabaseClient,
  appId: string,
  number: number,
): Promise<{ row: AppVersionRow; snapshot: Snapshot }> {
  const { data, error } = await db
    .from('app_versions')
    .select(VERSION_COLUMNS)
    .eq('app_id', appId)
    .eq('number', number)
    .maybeSingle();
  if (error) throw error;
  const row = data as AppVersionRow | null;
  if (!row) throw new NotFoundError(`No hay una versión ${number} de esta aplicación.`);
  const snapshot = parseSnapshot(row.spec);
  if (!snapshot) throw new ValidationError(`La versión ${number} no se puede leer.`);
  return { row, snapshot };
}

export interface AppDraftStatus {
  /** Número de la versión que ven los usuarios; null = nunca se publicó. */
  publishedNumber: number | null;
  publishedAt: string | null;
  hasChanges: boolean;
  changes: VersionChange[];
  summary: string;
}

/** ¿El borrador difiere de lo publicado, y en qué? */
export async function draftStatus(db: SupabaseClient, app: CustomAppRow): Promise<AppDraftStatus> {
  const published = await loadPublishedSnapshot(db, app.id);
  const draft = await draftSnapshot(db, app);
  if (!published)
    return {
      publishedNumber: null,
      publishedAt: null,
      hasChanges: true,
      changes: diffSnapshots(null, draft),
      summary: 'Todavía no se ha publicado',
    };
  const changes = diffSnapshots(published.snapshot, draft);
  const { data } = await db
    .from('app_versions')
    .select('created_at')
    .eq('app_id', app.id)
    .eq('number', published.number)
    .maybeSingle();
  return {
    publishedNumber: published.number,
    publishedAt: (data as { created_at?: string } | null)?.created_at ?? null,
    hasChanges: hasUnpublishedChanges(published.snapshot, draft),
    changes,
    summary: summarizeChanges(changes),
  };
}

/**
 * PUBLICAR: foto del borrador → versión N+1, y la app queda abierta a sus
 * usuarios. Se comprueban las fuentes de todas las pantallas (una pantalla que
 * lee algo interno no se abre a gente de afuera). Sin cambios desde la última
 * versión no se crea otra (devuelve `created: false`), salvo que la app esté
 * en borrador y se vaya a abrir.
 */
export async function publishVersion(
  db: SupabaseClient,
  appRef: string,
  input: { userId: string; note?: string },
): Promise<{
  app: CustomAppRow;
  number: number;
  created: boolean;
  changes: VersionChange[];
}> {
  const app = await mustGetApp(db, appRef);
  await assertAppSources(db, app.id);
  const published = await loadPublishedSnapshot(db, app.id);
  const draft = await draftSnapshot(db, app);
  if (
    !draft.screens.length &&
    !draft.dashboards.length &&
    !draft.portal.enabled &&
    !draft.home?.enabled
  )
    throw new ValidationError('No se puede publicar una app sin pantallas, tableros ni portal.');
  const changes = diffSnapshots(published?.snapshot ?? null, draft);
  if (published && !changes.length) {
    const opened =
      app.status === 'published'
        ? app
        : await updateApp(db, app.id, { status: 'published', userId: input.userId });
    return { app: opened, number: published.number, created: false, changes: [] };
  }
  const number = (published?.number ?? 0) + 1;
  const { error } = await db.from('app_versions').insert({
    ...(app.organization_id ? { organization_id: app.organization_id } : {}),
    app_id: app.id,
    number,
    spec: draft,
    note: (input.note ?? '').trim().slice(0, 500),
    created_by: input.userId,
  });
  if (error) throw error;
  const opened = await updateApp(db, app.id, { status: 'published', userId: input.userId });
  if (number > MAX_VERSIONS_KEPT) {
    await db
      .from('app_versions')
      .delete()
      .eq('app_id', app.id)
      .lte('number', number - MAX_VERSIONS_KEPT);
  }
  return { app: opened, number, created: true, changes };
}

/** Cerrar la app a sus usuarios. Las versiones se conservan. */
export async function unpublishApp(db: SupabaseClient, appRef: string, userId: string) {
  const app = await mustGetApp(db, appRef);
  return updateApp(db, app.id, { status: 'draft', userId });
}

// ---------------------------------------------------------------------------
// Volver a una versión
// ---------------------------------------------------------------------------

export interface RestoreResult {
  app: CustomAppRow;
  /** Lo que se hizo, en frases. */
  done: string[];
  /** Lo que NO se pudo devolver (una tabla que cambió, un límite) y por qué. */
  skipped: string[];
  published: { number: number } | null;
}

/**
 * Devuelve el BORRADOR a lo que decía la versión `number`: pantallas (con su
 * contenido de entonces), roles, inicio, apariencia, tableros y portal. Nada
 * de lo que tiene gente se borra por el camino: un rol que hoy tiene miembros
 * o usuarios y que esa versión no tenía se conserva tal cual. Las pantallas
 * que hoy existen y esa versión no tenía se archivan (como `removeScreen`). Lo
 * que no pasa la validación de hoy (una tabla que cambió) se salta y se
 * cuenta en `skipped`. Con `publish`, lo restaurado se publica como una
 * versión nueva (nunca se reescribe la historia).
 */
export async function restoreVersion(
  db: SupabaseClient,
  appRef: string,
  number: number,
  input: { userId: string; publish?: boolean },
): Promise<RestoreResult> {
  const app = await mustGetApp(db, appRef);
  const { snapshot } = await getVersion(db, app.id, number);
  const done: string[] = [];
  const skipped: string[] = [];

  // Roles: los de la versión, más los de hoy que tienen gente.
  const live = await listRoles(db, app.id);
  const withPeople = await rolesWithPeople(db, app.id, live);
  const keep = live.filter(
    (r) => withPeople.has(r.key) && !snapshot.roles.some((s) => s.key === r.key),
  );
  const nextRoles = [
    ...snapshot.roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
    ...keep.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
  ];
  try {
    await saveRoles(db, app.id, nextRoles);
    done.push(`roles (${snapshot.roles.length})`);
    for (const r of keep)
      skipped.push(
        `El rol «${r.name}» no estaba en esa versión pero tiene personas: se dejó como está.`,
      );
  } catch (err) {
    skipped.push(`Roles: ${err instanceof Error ? err.message : 'no se pudieron devolver'}`);
  }

  // Pantallas.
  const screens = await listScreens(db, app.id);
  const bySlug = new Map(screens.map((s) => [s.slug, s]));
  const wanted = new Set(snapshot.screens.map((s) => s.slug));
  for (const s of screens) {
    if (wanted.has(s.slug)) continue;
    await removeScreen(db, app.id, s.id);
    done.push(`pantalla quitada: ${s.title}`);
  }
  const orderIds: string[] = [];
  for (const s of snapshot.screens) {
    try {
      const spec = await validateSpec(db, s.spec, { viewerId: input.userId });
      const existing = bySlug.get(s.slug);
      if (existing) {
        await updateView(db, existing.view_id, {
          spec,
          userId: input.userId,
          prompt: `Volver a la versión ${number}`,
          appScreen: true,
        });
        const updated = await updateScreen(db, app.id, existing.id, {
          title: s.title,
          icon: s.icon,
          roles: s.roles,
        });
        orderIds.push(updated.id);
      } else {
        const added: AppScreenRow = await addScreen(db, app, {
          title: s.title,
          slug: s.slug,
          icon: s.icon,
          roles: s.roles,
          spec,
          userId: input.userId,
          prompt: `Volver a la versión ${number}`,
        });
        orderIds.push(added.id);
      }
      done.push(`pantalla: ${s.title}`);
    } catch (err) {
      skipped.push(
        `Pantalla «${s.title}»: ${err instanceof Error ? err.message : 'no se pudo devolver'}`,
      );
    }
  }
  if (orderIds.length) await reorderScreens(db, app.id, orderIds);

  // La app: nombre, apariencia, inicio, tableros, portal.
  const homeScreen =
    snapshot.app.homeScreen && snapshot.screens.some((s) => s.slug === snapshot.app.homeScreen)
      ? snapshot.app.homeScreen
      : null;
  const restored = await updateApp(db, app.id, {
    name: snapshot.app.name,
    description: snapshot.app.description,
    icon: snapshot.app.icon,
    theme: snapshot.app.theme,
    homeScreen,
    brand: snapshot.brand,
    home: snapshot.home,
    dashboards: snapshot.dashboards,
    portal: snapshot.portal,
    userId: input.userId,
  });
  done.push('datos, apariencia, inicio, tableros y portal');

  let published: { number: number } | null = null;
  if (input.publish) {
    const res = await publishVersion(db, app.id, {
      userId: input.userId,
      note: `Vuelta a la versión ${number}`,
    });
    published = { number: res.number };
    return { app: res.app, done, skipped, published };
  }
  return { app: restored, done, skipped, published };
}

async function rolesWithPeople(
  db: SupabaseClient,
  appId: string,
  roles: AppRoleRow[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!roles.length) return out;
  const [members, users] = await Promise.all([
    db.from('custom_app_members').select('role_key').eq('app_id', appId),
    db.from('custom_app_users').select('role_key').eq('app_id', appId),
  ]);
  for (const r of [...(members.data ?? []), ...(users.data ?? [])] as Array<{ role_key: string }>)
    out.add(r.role_key);
  return out;
}
