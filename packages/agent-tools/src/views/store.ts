import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { appBaseUrl } from '../reports/store';
import { rowLabel } from '../trackers/schema';
import { TRACKER_COLUMNS, type TrackerRow, listTrackers, shapeValues } from '../trackers/store';
import type { ViewRow, ViewSource } from './compute';
import {
  FEED_NO_VIEWER_MESSAGE,
  FEED_PUBLIC_MESSAGE,
  listFeedSources,
  readFeedSource,
} from './feed-sources';
import {
  PLATFORM_SOURCES,
  type SourceSensitivity,
  internalShareRefusal,
  internalSourcesOf,
} from './sources';
import {
  type CatalogTracker,
  type ViewSpec,
  checkSpecAgainst,
  isFeedSourceId,
  isPlatformSourceId,
  isReadOnlySource,
  slugify,
  trackersOf,
  viewSpecSchema,
} from './spec';

/**
 * Lectura y escritura de las vistas (migración 0156).
 *
 * `db` es siempre un handle con alcance de espacio: nada de aquí filtra por
 * organization_id a mano. La única excepción es `findViewByToken`, que recibe
 * el cliente de servicio SIN alcance porque el enlace público no trae sesión
 * — el token es la credencial y la fila encontrada trae su propio espacio.
 * Todo lo que se lee después de esa fila se lee con un handle de ESE espacio.
 *
 * FUENTES DE LA PLATAFORMA. Además de las tablas inventadas, un bloque puede
 * leer una fuente `cortex.*` (sources.ts). Entran por el mismo catálogo y la
 * misma carga, con el mismo tope de filas, y con una regla más: una vista que
 * usa una fuente `internal` no abre su puerta de afuera (`setViewAccess`,
 * `updateView`), y la página pública no la lee aunque la tenga
 * (`loadViewSources` con `audience: 'public'`).
 *
 * FUENTES DE CADA PERSONA. Las `personal` de la plataforma (activaciones,
 * seguimientos, operaciones, rutinas) y las tablas del Feed (feed-sources.ts)
 * dependen de QUIÉN MIRA: se leen con `viewerId` y cada quien ve lo suyo (en
 * el Feed, sólo el dueño ve la tabla). Sin `viewerId` —el enlace público,
 * cualquier llamador que no lo pase— no se leen: salen como aviso. Tampoco
 * abren la puerta de afuera, igual que las internas.
 */

// El hash de la contraseña NO está en esta lista: ninguna lectura normal lo
// necesita, y así no hay forma de que viaje por accidente a un componente. La
// única que lo lee es `custom_view_reserve_unlock`, dentro de la base.
export const VIEW_COLUMNS =
  'id, slug, name, description, spec, version, visibility, share_token, share_expires_at, share_views, pinned, created_by, updated_by, created_at, updated_at, archived_at';

export type ViewVisibility = 'workspace' | 'link' | 'password';

export interface CustomViewRow {
  id: string;
  organization_id?: string;
  slug: string;
  name: string;
  description: string;
  spec: ViewSpec;
  version: number;
  visibility: ViewVisibility;
  share_token: string | null;
  share_expires_at: string | null;
  share_views: number;
  pinned: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** Tope de filas que una vista lee por tabla. Lo que pase de aquí se marca parcial. */
export const VIEW_ROW_CAP = 2000;
/** Envíos por hora que un formulario compartido acepta desde afuera. */
export const PUBLIC_SUBMISSIONS_PER_HOUR = 60;

function adapt(row: Record<string, unknown>): CustomViewRow {
  const parsed = viewSpecSchema.safeParse(row.spec);
  return {
    ...(row as unknown as CustomViewRow),
    description: typeof row.description === 'string' ? row.description : '',
    // Un spec guardado que ya no pasa el contrato (por un cambio de código) no
    // tumba la pantalla: se pinta un único bloque que lo dice.
    spec: parsed.success
      ? parsed.data
      : {
          version: 1,
          accent: 'primary',
          refreshSeconds: 0,
          editing: 'off',
          alerts: [],
          blocks: [
            {
              id: 'aviso',
              width: 'full',
              type: 'text',
              markdown:
                'Esta vista quedó con un formato que ya no se puede leer. Pídele a Cortex que la rehaga o restaura una versión anterior.',
            },
          ],
        },
  };
}

// ---------------------------------------------------------------------------
// Contraseñas
// ---------------------------------------------------------------------------

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const MIN_PASSWORD = 6;

export async function hashViewPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD || password.length > 200)
    throw new ValidationError(
      `La contraseña tiene que tener entre ${MIN_PASSWORD} y 200 caracteres.`,
    );
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyViewPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const got = await scrypt(
    password.normalize('NFKC'),
    Buffer.from(saltB64, 'base64url'),
    expected.length,
  );
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------------------------------------------------------------------------
// Enlaces
// ---------------------------------------------------------------------------

export function mintViewToken(): string {
  return randomBytes(24).toString('base64url');
}

export const VIEW_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

/** Dentro de la app, detrás de la sesión. */
export function viewUrl(slug: string): string {
  return `${appBaseUrl()}/views/${slug}`;
}

/** Afuera, autenticado por el token (y la contraseña, si la hay). */
export function publicViewUrl(token: string): string {
  return `${appBaseUrl()}/v/${token}`;
}

export function shareIsOpen(row: Pick<CustomViewRow, 'share_token' | 'share_expires_at'>): boolean {
  if (!row.share_token) return false;
  return !row.share_expires_at || Date.parse(row.share_expires_at) > Date.now();
}

// ---------------------------------------------------------------------------
// Catálogo y datos
// ---------------------------------------------------------------------------

export interface ViewCatalogEntry extends CatalogTracker {
  /** El id de la tabla; en una fuente de la plataforma o del Feed, su mismo id. */
  id: string;
  description: string;
  /** Nulo en las fuentes de la plataforma: contarlas cuesta una lectura por fuente. */
  rowCount: number | null;
  kind: 'tracker' | 'platform' | 'feed';
  sensitivity: SourceSensitivity;
  /** Sólo en las del Feed: hasta tres filas ya leídas (el diseñador no las relee). */
  sample?: ViewRow[];
}

export interface ViewCatalogOptions {
  /** Quién pregunta. Sin él, el catálogo no trae tablas del Feed. */
  viewerId?: string | null;
  /**
   * Las fuentes que la vista YA usa (el spec guardado o el borrador). Una
   * tabla del Feed de esa lista que quien pregunta no puede leer entra como
   * `opaque`: se conserva sin comprobar campos (ver spec.ts, CatalogTracker).
   */
  keep?: string[];
  /**
   * Resolver sólo estas tablas del Feed en vez de listar el Feed entero. Es lo
   * que usa `validateSpec`: para comprobar un spec basta leer lo que nombra.
   */
  feedRefs?: string[];
}

/**
 * Las tablas del espacio, las fuentes de la plataforma (sin contar filas) y
 * las tablas del Feed de quien pregunta (sólo las suyas).
 */
export async function viewCatalog(
  db: SupabaseClient,
  options: ViewCatalogOptions = {},
): Promise<ViewCatalogEntry[]> {
  const rows = await listTrackers(db, 40);
  const feed = options.viewerId
    ? await feedCatalog(db, options.viewerId, options.feedRefs).catch(
        // Un Feed que no contesta no impide diseñar sobre lo demás.
        () => [] as ViewCatalogEntry[],
      )
    : [];
  const seen = new Set(feed.map((f) => f.slug));
  const opaque = (options.keep ?? [])
    .filter((ref) => isFeedSourceId(ref) && !seen.has(ref))
    .map(
      (ref): ViewCatalogEntry => ({
        id: ref,
        slug: ref,
        name: 'Tabla del Feed no disponible para ti',
        description:
          'Tabla del Feed privado de otra persona, o ya vencida. Se conserva tal cual; no la cambies.',
        fields: [],
        rowCount: null,
        kind: 'feed',
        sensitivity: 'personal',
        opaque: true,
      }),
    );
  return [
    ...rows.map(
      (t): ViewCatalogEntry => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        fields: t.fields,
        rowCount: t.rowCount,
        kind: 'tracker',
        sensitivity: 'shareable',
      }),
    ),
    ...[...PLATFORM_SOURCES.values()].map(
      (s): ViewCatalogEntry => ({
        id: s.id,
        slug: s.id,
        name: s.name,
        description: s.description,
        fields: s.fields,
        rowCount: null,
        kind: 'platform',
        sensitivity: s.sensitivity,
      }),
    ),
    ...feed,
    ...opaque,
  ];
}

async function feedCatalog(
  db: SupabaseClient,
  viewerId: string,
  only?: string[],
): Promise<ViewCatalogEntry[]> {
  const entry = (
    id: string,
    name: string,
    description: string,
    fields: CatalogTracker['fields'],
    rowCount: number | null,
    sample: ViewRow[],
  ): ViewCatalogEntry => ({
    id,
    slug: id,
    name,
    description,
    fields,
    rowCount,
    kind: 'feed',
    sensitivity: 'personal',
    sample,
  });
  if (only) {
    const refs = [...new Set(only.filter(isFeedSourceId))];
    const read = await Promise.all(
      refs.map(async (ref) => ({ ref, r: await readFeedSource(db, ref, viewerId, 3) })),
    );
    return read.flatMap(({ ref, r }) =>
      r.ok ? [entry(ref, r.name, r.description, r.fields, null, r.rows.slice(0, 3))] : [],
    );
  }
  return (await listFeedSources(db, viewerId)).map((f) =>
    entry(f.id, f.name, f.description, f.fields, f.rowCount, f.sample),
  );
}

function adaptEntry(row: Record<string, unknown>): ViewRow {
  const values =
    row.values && typeof row.values === 'object' && !Array.isArray(row.values)
      ? (row.values as Record<string, string | number>)
      : {};
  return {
    id: String(row.id),
    label: String(row.label),
    values,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export const INTERNAL_SOURCE_BLOCKED =
  'Esta información es interna del equipo y no se muestra fuera de Cortex.';
export const PERSONAL_SOURCE_BLOCKED =
  'Esta información es de cada persona y no se muestra fuera de Cortex.';
export const PERSONAL_SOURCE_NO_VIEWER =
  'Esta información es de cada persona: abre la vista dentro de Cortex para ver la tuya.';

export interface LoadViewSourcesOptions {
  /**
   * `public` para la página de afuera (/v/<token>): las fuentes `internal`,
   * las `personal` y las del Feed NO SE LEEN y sus bloques se pintan como
   * aviso. Es la segunda llave: la primera es que `setViewAccess` no deja
   * compartir una vista así; ésta cubre la vista que quedó compartida por
   * otro camino (una versión vieja, una fuente que cambió de sensibilidad en
   * un despliegue).
   */
  audience?: 'team' | 'public';
  /**
   * Quién mira (dentro de la app). Las fuentes `personal` leen SUS filas; las
   * del Feed sólo se leen si es su dueño. Sin él, ninguna de las dos se lee.
   */
  viewerId?: string | null;
}

/** Lee las tablas y fuentes que el spec nombra y sus filas, hasta el tope. */
export async function loadViewSources(
  db: SupabaseClient,
  spec: ViewSpec,
  options: LoadViewSourcesOptions = {},
): Promise<Map<string, ViewSource>> {
  const refs = trackersOf(spec);
  const sources = new Map<string, ViewSource>();
  if (!refs.length) return sources;
  const slugs = refs.filter((r) => !isReadOnlySource(r));
  const platform = refs.filter(isPlatformSourceId);
  const feed = refs.filter(isFeedSourceId);
  const viewerId = options.audience === 'public' ? null : (options.viewerId ?? null);

  await Promise.all(
    feed.map(async (id) => {
      // Sin nombre ni campos: lo que no se leyó no puede describirse.
      const tracker = { slug: id, name: 'Tabla del Feed', fields: [] };
      const blocked = (message: string) =>
        sources.set(id, { tracker, rows: [], truncated: false, blocked: message });
      if (options.audience === 'public') return blocked(FEED_PUBLIC_MESSAGE);
      if (!viewerId) return blocked(FEED_NO_VIEWER_MESSAGE);
      try {
        const read = await readFeedSource(db, id, viewerId, VIEW_ROW_CAP);
        if (!read.ok) return blocked(read.message);
        sources.set(id, {
          tracker: { slug: id, name: read.name, fields: read.fields },
          rows: read.rows.slice(0, VIEW_ROW_CAP),
          truncated: read.truncated,
        });
      } catch {
        blocked(
          'No se pudo leer esta tabla del Feed en este momento. Vuelve a intentarlo en un rato.',
        );
      }
    }),
  );

  await Promise.all(
    platform.map(async (id) => {
      const def = PLATFORM_SOURCES.get(id);
      // Una fuente que ya no existe se queda fuera del mapa: `computeView` la
      // pinta como «ya no existe», igual que una tabla borrada.
      if (!def) return;
      const tracker = { slug: def.id, name: def.name, fields: def.fields };
      if (options.audience === 'public' && def.sensitivity !== 'shareable') {
        sources.set(id, {
          tracker,
          rows: [],
          truncated: false,
          blocked:
            def.sensitivity === 'internal' ? INTERNAL_SOURCE_BLOCKED : PERSONAL_SOURCE_BLOCKED,
        });
        return;
      }
      if (def.sensitivity === 'personal' && !viewerId) {
        sources.set(id, {
          tracker,
          rows: [],
          truncated: false,
          blocked: PERSONAL_SOURCE_NO_VIEWER,
        });
        return;
      }
      try {
        const read = await def.read(db, VIEW_ROW_CAP, bogotaToday(), { viewerId });
        sources.set(id, {
          tracker,
          rows: read.rows.slice(0, VIEW_ROW_CAP),
          truncated: read.truncated,
        });
      } catch {
        // Una fuente de la plataforma que no contesta (una migración que falta
        // en este despliegue, un módulo apagado) no tumba la vista entera: sus
        // bloques dicen que no se pudo leer y los demás siguen. El detalle del
        // error es de los registros, no de una pantalla que puede ser pública.
        sources.set(id, {
          tracker,
          rows: [],
          truncated: false,
          blocked: `No se pudo leer ${def.name} en este momento. Vuelve a intentarlo en un rato.`,
        });
      }
    }),
  );

  if (!slugs.length) return sources;
  const { data, error } = await db.from('trackers').select(TRACKER_COLUMNS).in('slug', slugs);
  if (error) throw error;
  const trackers = (data ?? []) as unknown as TrackerRow[];
  await Promise.all(
    trackers.map(async (t) => {
      const { data: rows, error: rowsError } = await db
        .from('tracker_rows')
        .select('id, label, values, created_at, updated_at')
        .eq('tracker_id', t.id)
        .order('updated_at', { ascending: false })
        .limit(VIEW_ROW_CAP + 1);
      if (rowsError) throw rowsError;
      const list = (rows ?? []).map((r) => adaptEntry(r as Record<string, unknown>));
      sources.set(t.slug, {
        tracker: { slug: t.slug, name: t.name, fields: Array.isArray(t.fields) ? t.fields : [] },
        rows: list.slice(0, VIEW_ROW_CAP),
        truncated: list.length > VIEW_ROW_CAP,
      });
    }),
  );
  return sources;
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

export async function listViews(db: SupabaseClient, limit = 60): Promise<CustomViewRow[]> {
  const { data, error } = await db
    .from('custom_views')
    .select(VIEW_COLUMNS)
    .is('archived_at', null)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

export async function listPinnedViews(db: SupabaseClient, limit = 3): Promise<CustomViewRow[]> {
  const { data, error } = await db
    .from('custom_views')
    .select(VIEW_COLUMNS)
    .is('archived_at', null)
    .eq('pinned', true)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Por id o por slug: el chat nombra vistas como la gente, la app por id. */
export async function getView(db: SupabaseClient, ref: string): Promise<CustomViewRow | null> {
  const q = db.from('custom_views').select(VIEW_COLUMNS).is('archived_at', null);
  const { data, error } = await (UUID_RE.test(ref)
    ? q.eq('id', ref)
    : q.eq('slug', ref)
  ).maybeSingle();
  if (error) throw error;
  return data ? adapt(data as Record<string, unknown>) : null;
}

export async function mustGetView(db: SupabaseClient, ref: string): Promise<CustomViewRow> {
  const view = await getView(db, ref);
  if (!view) throw new NotFoundError(`No hay una vista «${ref}» en este espacio.`);
  return view;
}

async function freeSlug(db: SupabaseClient, wanted: string): Promise<string> {
  const { data, error } = await db
    .from('custom_views')
    .select('slug')
    .is('archived_at', null)
    .like('slug', `${wanted}%`);
  if (error) throw error;
  const taken = new Set((data ?? []).map((r) => String((r as { slug: string }).slug)));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 500; i++) {
    const candidate = `${wanted.slice(0, 44)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted.slice(0, 36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * Valida forma y catálogo. Lanza ValidationError con TODOS los problemas.
 * `viewerId` deja comprobar las tablas del Feed de quien guarda; `keep` son
 * las fuentes de la versión guardada (ver `ViewCatalogOptions.keep`).
 */
export async function validateSpec(
  db: SupabaseClient,
  raw: unknown,
  options: { viewerId?: string | null; keep?: string[] } = {},
): Promise<ViewSpec> {
  const parsed = viewSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `La vista no tiene la forma esperada: ${parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`)
        .join('; ')}.`,
    );
  }
  const catalog = await viewCatalog(db, {
    viewerId: options.viewerId,
    keep: options.keep,
    feedRefs: trackersOf(parsed.data),
  });
  const problems = checkSpecAgainst(parsed.data, catalog);
  if (problems.length) throw new ValidationError(problems.slice(0, 8).join(' '));
  return parsed.data;
}

async function writeVersion(
  db: SupabaseClient,
  view: Pick<CustomViewRow, 'id' | 'version' | 'name' | 'spec'>,
  userId: string | null,
  prompt: string | null,
) {
  const { error } = await db.from('custom_view_versions').insert({
    view_id: view.id,
    version: view.version,
    name: view.name,
    spec: view.spec,
    prompt: prompt?.slice(0, 2000) ?? null,
    created_by: userId,
  });
  if (error) throw error;
}

export async function createView(
  db: SupabaseClient,
  input: {
    name: string;
    description?: string;
    slug?: string;
    spec: ViewSpec;
    userId: string;
    prompt?: string | null;
  },
): Promise<CustomViewRow> {
  const slug = await freeSlug(db, input.slug ?? slugify(input.name));
  const { data, error } = await db
    .from('custom_views')
    .insert({
      slug,
      name: input.name.trim().slice(0, 80),
      description: (input.description ?? '').trim().slice(0, 500),
      spec: input.spec,
      version: 1,
      created_by: input.userId,
      updated_by: input.userId,
    })
    .select(VIEW_COLUMNS)
    .single();
  if (error) throw error;
  const view = adapt(data as Record<string, unknown>);
  await writeVersion(db, view, input.userId, input.prompt ?? null);
  return view;
}

export class ViewConflictError extends Error {
  constructor() {
    super('Alguien cambió esta vista mientras tanto. Recarga y vuelve a pedir el cambio.');
    this.name = 'ViewConflictError';
  }
}

/**
 * Guarda una versión nueva. `expectedVersion` evita que dos ediciones por texto
 * simultáneas se pisen en silencio: la segunda recibe un conflicto.
 */
export async function updateView(
  db: SupabaseClient,
  id: string,
  input: {
    name?: string;
    description?: string;
    spec?: ViewSpec;
    userId: string;
    prompt?: string | null;
    expectedVersion?: number;
  },
): Promise<CustomViewRow> {
  const current = await mustGetView(db, id);
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version)
    throw new ViewConflictError();
  // Una vista que ya está afuera no puede empezar a mostrar algo interno: el
  // enlace lo vería al siguiente clic. Primero se cierra la puerta.
  if (input.spec && current.visibility !== 'workspace') {
    const internal = internalSourcesOf(input.spec);
    if (internal.length)
      throw new ValidationError(
        `Esta vista está compartida afuera y no puede usar información interna del equipo ni de cada persona (${internal.map((s) => `«${s.name}»`).join(', ')}). Deja de compartirla primero, o usa otra fuente.`,
      );
  }
  const next = current.version + 1;
  const { data, error } = await db
    .from('custom_views')
    .update({
      name: input.name?.trim().slice(0, 80) ?? current.name,
      description: input.description?.trim().slice(0, 500) ?? current.description,
      spec: input.spec ?? current.spec,
      version: next,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', current.id)
    .eq('version', current.version)
    .select(VIEW_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ViewConflictError();
  const view = adapt(data as Record<string, unknown>);
  await writeVersion(db, view, input.userId, input.prompt ?? null);
  return view;
}

export interface ViewVersionRow {
  version: number;
  name: string;
  prompt: string | null;
  created_by: string | null;
  created_at: string;
}

export async function listViewVersions(
  db: SupabaseClient,
  viewId: string,
  limit = 15,
): Promise<ViewVersionRow[]> {
  const { data, error } = await db
    .from('custom_view_versions')
    .select('version, name, prompt, created_by, created_at')
    .eq('view_id', viewId)
    .order('version', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ViewVersionRow[];
}

/** Restaurar es copiar la versión vieja como versión nueva; la historia no se reescribe. */
export async function restoreViewVersion(
  db: SupabaseClient,
  viewId: string,
  version: number,
  userId: string,
): Promise<CustomViewRow> {
  const { data, error } = await db
    .from('custom_view_versions')
    .select('version, name, spec')
    .eq('view_id', viewId)
    .eq('version', version)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa versión no existe.');
  const old = data as { name: string; spec: unknown };
  const spec = viewSpecSchema.parse(old.spec);
  return updateView(db, viewId, {
    name: old.name,
    spec,
    userId,
    prompt: `Restaurada la versión ${version}`,
  });
}

export async function archiveView(db: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await db
    .from('custom_views')
    .update({
      archived_at: new Date().toISOString(),
      pinned: false,
      visibility: 'workspace',
      share_token: null,
      share_expires_at: null,
      password_hash: null,
    })
    .eq('id', id)
    .is('archived_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Cambia la puerta. Pasar de interna a enlace acuña un token; volver a interna
 * lo borra (el enlace viejo muere). `rotate` acuña uno nuevo aunque ya hubiera,
 * para cuando un enlace se filtró. La contraseña sólo se toca si viene.
 */
export async function setViewAccess(
  db: SupabaseClient,
  id: string,
  input: {
    visibility?: ViewVisibility;
    password?: string;
    days?: number | null;
    pinned?: boolean;
    rotate?: boolean;
    userId: string;
  },
): Promise<CustomViewRow> {
  const current = await mustGetView(db, id);
  const visibility = input.visibility ?? current.visibility;
  const patch: Record<string, unknown> = { updated_by: input.userId };

  // Abrir la puerta de una vista con fuentes internas es la única decisión de
  // compartir que ni un administrador puede tomar: esas fuentes nombran a gente
  // del equipo y su trabajo. Sólo se mira cuando se PIDE abrir (fijarla en
  // Inicio no toca la puerta y no debe fallar por esto).
  if (input.visibility && input.visibility !== 'workspace') {
    const internal = internalSourcesOf(current.spec);
    if (internal.length) throw new ValidationError(internalShareRefusal(internal));
  }

  if (input.pinned !== undefined) patch.pinned = input.pinned;

  if (visibility === 'workspace') {
    Object.assign(patch, {
      visibility,
      share_token: null,
      share_expires_at: null,
      password_hash: null,
      failed_unlocks: 0,
      locked_until: null,
    });
  } else {
    const token = !current.share_token || input.rotate ? mintViewToken() : current.share_token;
    patch.visibility = visibility;
    patch.share_token = token;
    if (token !== current.share_token) patch.share_views = 0;
    if (input.days !== undefined) {
      patch.share_expires_at =
        input.days === null
          ? null
          : new Date(
              Date.now() + Math.min(Math.max(Math.round(input.days), 1), 365) * 86_400_000,
            ).toISOString();
    }
    if (visibility === 'password') {
      if (input.password) {
        patch.password_hash = await hashViewPassword(input.password);
        patch.failed_unlocks = 0;
        patch.locked_until = null;
      } else if (current.visibility !== 'password') {
        throw new ValidationError('Para proteger la vista con contraseña, escribe una contraseña.');
      }
    } else {
      patch.password_hash = null;
    }
  }

  const { data, error } = await db
    .from('custom_views')
    .update(patch)
    .eq('id', current.id)
    .select(VIEW_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// La puerta de afuera
// ---------------------------------------------------------------------------

export interface PublicViewRow extends CustomViewRow {
  organization_id: string;
}

/**
 * Busca por token con el cliente de servicio SIN alcance. Devuelve la fila
 * sólo si la puerta está abierta de verdad: no archivada, no interna, no
 * vencida. Cualquier otro caso es null, sin distinguir, porque la ruta pública
 * contesta lo mismo en todos.
 *
 * Encontrar la fila no es poder pintarlo todo: quien la pinte lee sus fuentes
 * con `loadViewSources(..., { audience: 'public' })`, que deja sin leer las
 * fuentes internas de la plataforma aunque el spec las nombre.
 */
export async function findViewByToken(
  serviceDb: SupabaseClient,
  token: string,
): Promise<PublicViewRow | null> {
  if (!VIEW_TOKEN_RE.test(token)) return null;
  const { data, error } = await serviceDb
    .from('custom_views')
    .select(`organization_id, ${VIEW_COLUMNS}`)
    .eq('share_token', token)
    .is('archived_at', null)
    .maybeSingle();
  if (error || !data) return null;
  const row = adapt(data as Record<string, unknown>) as PublicViewRow;
  if (row.visibility === 'workspace' || !shareIsOpen(row)) return null;
  return row;
}

export async function countPublicOpen(db: SupabaseClient, view: CustomViewRow): Promise<void> {
  await db
    .from('custom_views')
    .update({ share_views: view.share_views + 1 })
    .eq('id', view.id);
}

export type UnlockOutcome = { ok: true } | { ok: false; reason: 'wrong' | 'locked' };

/** Gasta el intento en la base ANTES de comparar; ver la 0156. */
export async function unlockView(
  db: SupabaseClient,
  view: Pick<CustomViewRow, 'id'>,
  password: string,
): Promise<UnlockOutcome> {
  const { data, error } = await db.rpc('custom_view_reserve_unlock', { p_view_id: view.id });
  if (error) throw error;
  const reserved = data as { locked?: boolean; hash?: string } | null;
  if (!reserved) return { ok: false, reason: 'wrong' };
  if (reserved.locked || !reserved.hash) return { ok: false, reason: 'locked' };
  if (!(await verifyViewPassword(password.slice(0, 200), reserved.hash)))
    return { ok: false, reason: 'wrong' };
  await db.rpc('custom_view_clear_unlocks', { p_view_id: view.id });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

export class SubmissionLimitError extends Error {
  constructor() {
    super('Este formulario recibió demasiados envíos en la última hora. Intenta más tarde.');
    this.name = 'SubmissionLimitError';
  }
}

/**
 * Escribe la fila que un bloque de formulario envió. Sólo acepta los campos
 * que el bloque pide — un formulario de «novedades» no puede escribir el
 * campo «valor» de la misma tabla aunque alguien lo mande a mano.
 */
export async function submitViewForm(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    values: Record<string, unknown>;
    submittedBy: string | null;
  },
): Promise<{ rowId: string; message: string }> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || block.type !== 'form')
    throw new NotFoundError('Ese formulario no está en esta vista.');
  if (isReadOnlySource(block.tracker))
    throw new ValidationError(
      'Este formulario apunta a una fuente de sólo lectura; no recibe filas.',
    );

  if (!input.submittedBy) {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error } = await db
      .from('custom_view_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('view_id', view.id)
      .is('submitted_by', null)
      .gte('created_at', since);
    if (error) throw error;
    if ((count ?? 0) >= PUBLIC_SUBMISSIONS_PER_HOUR) throw new SubmissionLimitError();
  }

  const { data: t, error: tError } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', block.tracker)
    .maybeSingle();
  if (tError) throw tError;
  if (!t) throw new NotFoundError('La tabla de este formulario ya no existe.');
  const tracker = t as unknown as TrackerRow;

  const allowed = new Set(block.fields.length ? block.fields : tracker.fields.map((f) => f.key));
  const asked = tracker.fields.filter((f) => allowed.has(f.key));
  const raw: Record<string, unknown> = {};
  for (const f of asked) raw[f.key] = input.values[f.key];
  const values = shapeValues(asked, raw);

  const { data: row, error } = await db
    .from('tracker_rows')
    .insert({
      tracker_id: tracker.id,
      label: rowLabel(tracker.fields, values),
      values,
      created_by: input.submittedBy,
    })
    .select('id')
    .single();
  if (error) throw error;
  const rowId = String((row as { id: string }).id);

  await db.from('custom_view_submissions').insert({
    view_id: view.id,
    block_id: block.id,
    tracker_row_id: rowId,
    submitted_by: input.submittedBy,
  });

  return { rowId, message: block.successMessage };
}

// ---------------------------------------------------------------------------
// Editar y botones (migración 0160)
// ---------------------------------------------------------------------------

/** Cambios por hora que una vista acepta desde afuera (ediciones + botones). */
export const PUBLIC_WRITES_PER_HOUR = 120;

export class ViewWriteLimitError extends Error {
  constructor() {
    super('Esta vista recibió demasiados cambios en la última hora. Intenta más tarde.');
    this.name = 'ViewWriteLimitError';
  }
}

/**
 * ¿Puede ESTA persona escribir en ESTA vista? La regla vive aquí para que la
 * pantalla, la ruta pública y el cálculo digan lo mismo:
 *   - `editing: 'off'`  nadie.
 *   - `editing: 'team'` sólo alguien del espacio, dentro de la app.
 *   - `editing: 'public'` también quien abre el enlace (y, si la vista pide
 *     contraseña, ya la escribió: eso lo comprueba la ruta antes de llegar).
 */
export function canWriteView(view: Pick<CustomViewRow, 'spec'>, who: 'member' | 'public'): boolean {
  if (view.spec.editing === 'off') return false;
  if (who === 'member') return true;
  return view.spec.editing === 'public';
}

async function assertPublicBudget(db: SupabaseClient, viewId: string) {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error } = await db
    .from('custom_view_events')
    .select('id', { count: 'exact', head: true })
    .eq('view_id', viewId)
    .is('actor', null)
    .gte('created_at', since);
  if (error) throw error;
  if ((count ?? 0) >= PUBLIC_WRITES_PER_HOUR) throw new ViewWriteLimitError();
}

async function trackerForBlock(db: SupabaseClient, slug: string): Promise<TrackerRow> {
  if (isReadOnlySource(slug))
    throw new ValidationError('Esa fuente es de la plataforma o del Feed y es de sólo lectura.');
  const { data, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('La tabla de este bloque ya no existe.');
  return data as unknown as TrackerRow;
}

/**
 * Cambia campos de UNA fila. `allowed` son los campos que el bloque deja
 * tocar; lo que llegue fuera de esa lista se rechaza entero, no se ignora en
 * silencio. Se valida con el esquema de la tabla sobre la fila COMPLETA (lo que
 * había más lo nuevo), así que un cambio no puede dejar vacío un obligatorio.
 */
async function patchRow(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    tracker: TrackerRow;
    rowId: string;
    patch: Record<string, unknown>;
    allowed: ReadonlySet<string>;
    kind: 'edit' | 'move' | 'action';
    actionId?: string;
    actor: string | null;
  },
): Promise<{ label: string; changes: Record<string, { from: unknown; to: unknown }> }> {
  const keys = Object.keys(input.patch);
  if (!keys.length) throw new ValidationError('No hay nada que cambiar.');
  const outside = keys.filter((k) => !input.allowed.has(k));
  if (outside.length)
    throw new ValidationError(
      `Esta vista no deja cambiar ${outside.map((k) => `«${k}»`).join(', ')}.`,
    );

  const { data: current, error: readError } = await db
    .from('tracker_rows')
    .select('id, values')
    .eq('id', input.rowId)
    .eq('tracker_id', input.tracker.id)
    .maybeSingle();
  if (readError) throw readError;
  if (!current) throw new NotFoundError('Esa fila ya no está en la tabla.');
  const before = ((current as { values: Record<string, string | number> }).values ?? {}) as Record<
    string,
    string | number
  >;
  // Sólo lo que la tabla todavía declara: un campo que se borró del esquema no
  // puede tumbar la edición de otro.
  const known = Object.fromEntries(
    Object.entries(before).filter(([k]) => input.tracker.fields.some((f) => f.key === k)),
  );
  const values = shapeValues(input.tracker.fields, { ...known, ...input.patch });
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys)
    if (before[k] !== values[k]) changes[k] = { from: before[k] ?? null, to: values[k] ?? null };
  const label = rowLabel(input.tracker.fields, values);
  if (!Object.keys(changes).length) return { label, changes };

  const { error } = await db
    .from('tracker_rows')
    .update({ values, label, updated_at: new Date().toISOString() })
    .eq('id', input.rowId)
    .eq('tracker_id', input.tracker.id);
  if (error) throw error;
  await db.from('custom_view_events').insert({
    view_id: view.id,
    block_id: input.blockId,
    kind: input.kind,
    action_id: input.actionId ?? null,
    tracker_row_id: input.rowId,
    changes,
    actor: input.actor,
  });
  return { label, changes };
}

/** Editar una celda de una tabla o mover una tarjeta del tablero. */
export async function editViewRow(
  db: SupabaseClient,
  view: CustomViewRow,
  input: { blockId: string; rowId: string; patch: Record<string, unknown>; actor: string | null },
): Promise<{ label: string }> {
  if (!canWriteView(view, input.actor ? 'member' : 'public'))
    throw new ValidationError('Esta vista no se puede editar.');
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || (block.type !== 'table' && block.type !== 'board'))
    throw new NotFoundError('Ese bloque no está en esta vista.');
  const allowed = new Set(
    block.type === 'table' ? block.editable : block.draggable ? [block.groupBy] : [],
  );
  if (!allowed.size) throw new ValidationError('Este bloque no se edita.');
  if (!input.actor) await assertPublicBudget(db, view.id);
  const tracker = await trackerForBlock(db, block.tracker);
  const { label } = await patchRow(db, view, {
    blockId: block.id,
    tracker,
    rowId: input.rowId,
    patch: input.patch,
    allowed,
    kind: block.type === 'board' ? 'move' : 'edit',
    actor: input.actor,
  });
  return { label };
}

export type ViewActionOutcome =
  | { kind: 'set_field'; label: string; message: string }
  | { kind: 'notify'; label: string; message: string; actionLabel: string };

/**
 * Un botón de fila. `set_field` escribe el valor que dice el SPEC (nunca uno
 * que mande el navegador); `notify` no escribe nada en la tabla y devuelve lo
 * necesario para que la capa web mande los avisos de campana.
 */
export async function runViewAction(
  db: SupabaseClient,
  view: CustomViewRow,
  input: { blockId: string; actionId: string; rowId: string; actor: string | null },
): Promise<ViewActionOutcome> {
  if (!canWriteView(view, input.actor ? 'member' : 'public'))
    throw new ValidationError('Los botones de esta vista no están activos.');
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || (block.type !== 'table' && block.type !== 'board'))
    throw new NotFoundError('Ese bloque no está en esta vista.');
  const action = block.actions.find((a) => a.id === input.actionId);
  if (!action) throw new NotFoundError('Ese botón ya no está en la vista.');
  if (!input.actor) await assertPublicBudget(db, view.id);

  if (action.kind === 'set_field' && action.field && action.value !== undefined) {
    const tracker = await trackerForBlock(db, block.tracker);
    const { label } = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId: input.rowId,
      patch: { [action.field]: action.value },
      allowed: new Set([action.field]),
      kind: 'action',
      actionId: action.id,
      actor: input.actor,
    });
    return {
      kind: 'set_field',
      label,
      message: `Listo: ${action.label.toLowerCase()} en «${label}».`,
    };
  }

  // notify: la fila tiene que existir y ser de la tabla del bloque.
  const tracker = await trackerForBlock(db, block.tracker);
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label')
    .eq('id', input.rowId)
    .eq('tracker_id', tracker.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa fila ya no está en la tabla.');
  const label = String((data as { label: string }).label);
  await db.from('custom_view_events').insert({
    view_id: view.id,
    block_id: block.id,
    kind: 'action',
    action_id: action.id,
    tracker_row_id: input.rowId,
    changes: {},
    actor: input.actor,
  });
  return {
    kind: 'notify',
    label,
    actionLabel: action.label,
    message: 'Listo, avisamos al equipo.',
  };
}

/** Si un envío por el formulario de este bloque debe sonar en la campana. */
export function bellAlertFor(view: Pick<CustomViewRow, 'spec'>, trackerSlug: string) {
  return view.spec.alerts.find((a) => a.bell && a.source === trackerSlug) ?? null;
}

export function viewSummary(view: CustomViewRow) {
  return {
    id: view.id,
    slug: view.slug,
    name: view.name,
    description: view.description,
    version: view.version,
    visibility: view.visibility,
    pinned: view.pinned,
    blocks: view.spec.blocks.length,
    url: viewUrl(view.slug),
    publicUrl: view.share_token && shareIsOpen(view) ? publicViewUrl(view.share_token) : null,
    updatedAt: view.updated_at,
  };
}
