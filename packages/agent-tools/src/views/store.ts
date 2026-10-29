import { TRM_LIST_ID } from '../trackers/trm';
import { ensureTrm } from '../trackers/trm-store';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitAutomationEvent, watchesTracker } from '../apps/automations/emit';
import {
  type RowAccess,
  type RowScope,
  SCOPE_BLOCKED_MESSAGE,
  applyRowScope,
} from '../apps/permissions';
import { bogotaToday } from '../commitments/shape';
import { moduleByKey } from '../modules/catalog';
import { enabledModules, moduleOffMessage } from '../modules/store';
import { notFoundWithHints } from '../not-found-hints';
import { appBaseUrl } from '../reports/store';
import { adaptLookupValue, lookupSources } from '../trackers/computed';
import { applyDuplicateRule, duplicateMessage, getDuplicateRule } from '../trackers/duplicates';
import { matchExistingRelation, nitKeys } from './sheet-edit';
import { flowOf } from '../trackers/flow';
import {
  ANONYMOUS_ACTOR,
  UNSCOPED_ACTOR,
  currentFlowActor,
  guardFlowWrite,
} from '../trackers/flow-guard';
import { creatingOrigin, parseOrigins } from '../trackers/origin';
import { assertRowWriteAllowed } from '../trackers/origin-guard';
import { displayTrackerValue, rowLabel } from '../trackers/schema';
import {
  TRACKER_COLUMNS,
  type TrackerRow,
  getTrackerBySlug,
  listTrackers,
  prepareValues,
} from '../trackers/store';
import {
  type SheetWindowData,
  type ViewRow,
  type ViewSource,
  blockWriteFields,
} from './compute';
import { loadSourceAggregates } from './aggregate-load';
import type { ViewFilterState } from './view-filters';
import { loadSheetWindow, windowRowsInMemory } from './sheet-window-load';
import type { SheetWindowRequest } from './sheet-window';
import {
  FEED_NO_VIEWER_MESSAGE,
  FEED_PUBLIC_MESSAGE,
  listFeedSources,
  readFeedSource,
} from './feed-sources';
import {
  EDIT_MESSAGES,
  canEditSubmission,
  editDeadline,
  isPendingReview,
  reviewPatch,
} from './form-extras';
import {
  type FormLine,
  LINES_KEY,
  checkLines,
  formLineSections,
  isLinesKey,
  linesIndexOf,
  normalizeLines,
  parseLinesValue,
} from './form-lines';
import { UNDO_ACTION_ID } from './row-history-shape';
import {
  PLATFORM_SOURCES,
  type SourceSensitivity,
  internalShareRefusal,
  internalSourcesOf,
} from './sources';
import {
  APPROVE_ACTION_ID,
  type CatalogTracker,
  type FormBlock,
  type FormLines,
  REJECT_ACTION_ID,
  type RowAction,
  type ViewSpec,
  approvalFor,
  autofixSpecAgainst,
  checkSpecAgainst,
  editWindowOf,
  findWriteBlock,
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
  'id, slug, name, description, spec, version, visibility, share_token, share_expires_at, share_views, pinned, app_id, created_by, updated_by, created_at, updated_at, archived_at';

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
  /** La aplicación de la que esta vista es pantalla (0208); null = vista suelta. */
  app_id?: string | null;
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
  /**
   * Sólo en las fuentes de la plataforma de un módulo APAGADO: el aviso de por
   * qué no se lee. Siguen en el catálogo (un spec guardado que las usa se
   * valida igual); el diseñador y el lienzo no las ofrecen.
   */
  moduleOff?: string;
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
  // Un módulo apagado deja su fuente en el catálogo, marcada: ver `moduleOff`.
  const modulesOn = await enabledModules(db);
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
        ...(t.origins?.length ? { origins: t.origins } : {}),
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
        ...(s.module && !modulesOn.has(s.module)
          ? { moduleOff: moduleOffMessage(moduleByKey(s.module)) }
          : {}),
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
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_by_app_user:
      typeof row.created_by_app_user === 'string' ? row.created_by_app_user : null,
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
  /**
   * EL SCOPE DE UNA APLICACIÓN (0208): qué filas de cada fuente ve el rol de
   * quien mira. Se aplica AQUÍ, al leer, y no en el navegador ni después de
   * calcular: las cifras, los gráficos y el Excel de un operario salen de SUS
   * filas porque las demás nunca entraron al mapa. Una fuente del spec que no
   * esté en la lista se lee entera, así que `rowScopeFor` entrega una entrada por
   * fuente; `none` la bloquea con aviso. «own» se filtra además en la consulta
   * (`created_by`), para no traer lo que no se va a mostrar.
   */
  scope?: RowScope[];
  /**
   * Una fila que tiene que estar en el mapa aunque no sea de las 2.000 más
   * recientes (el enlace profundo `?fila=` de un registro viejo). Se lee con
   * el mismo scope que el resto; si el rol no la ve, simplemente no entra.
   */
  ensureRowId?: string;
  /**
   * Las hojas con `window`: qué pidió el navegador por bloque (hasta dónde se
   * cargó, búsqueda y filtros de columna en todo el histórico). Sin esto cada
   * hoja con ventana trae su primer bloque. Ver views/sheet-window.ts.
   */
  sheetWindows?: Record<string, SheetWindowRequest>;
  /** Exportar «todo»: las hojas con ventana se leen enteras (hasta el tope de la ventana). */
  allSheetRows?: boolean;
  /**
   * Lo elegido en la barra de filtros (ya validado). Con una tabla de más de
   * VIEW_ROW_CAP filas, las cifras se calculan en la base sobre TODA la tabla y
   * necesitan saber de qué barra: pásalo igual que a `computeView`; si no
   * coincide, esa cifra vuelve a calcularse sobre las filas cargadas y se avisa.
   */
  filters?: ViewFilterState;
}

/** Tablas del espacio que los campos con `match` de los formularios del spec usan como lista. */
async function matchSourceRefs(db: SupabaseClient, spec: ViewSpec): Promise<string[]> {
  const formSlugs = [
    ...new Set(
      spec.blocks.flatMap((b) =>
        b.type === 'form' && !isReadOnlySource(b.tracker) ? [b.tracker] : [],
      ),
    ),
  ];
  if (!formSlugs.length) return [];
  const { data } = await db.from('trackers').select('fields').in('slug', formSlugs);
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{ fields: unknown }>)
    if (Array.isArray(row.fields))
      for (const f of row.fields as Array<{ match?: { source?: unknown } }>) {
        const source = f?.match?.source;
        if (typeof source === 'string' && !source.startsWith('cortex.')) out.add(source);
      }
  return [...out];
}

/** Lee las tablas y fuentes que el spec nombra y sus filas, hasta el tope. */
export async function loadViewSources(
  db: SupabaseClient,
  spec: ViewSpec,
  options: LoadViewSourcesOptions = {},
): Promise<Map<string, ViewSource>> {
  const refs = [...trackersOf(spec)];
  const sources = new Map<string, ViewSource>();
  if (!refs.length) return sources;
  // Las tablas de referencia de «Buscar en una lista» se leen como cualquier fuente del formulario.
  for (const extra of await matchSourceRefs(db, spec))
    if (!refs.includes(extra)) refs.push(extra);
  const slugs = refs.filter((r) => !isReadOnlySource(r));
  const platform = refs.filter(isPlatformSourceId);
  const feed = refs.filter(isFeedSourceId);
  const viewerId = options.audience === 'public' ? null : (options.viewerId ?? null);
  const scopes = new Map((options.scope ?? []).map((s) => [s.tracker, s.access]));
  const accessOf = (ref: string): RowAccess => scopes.get(ref) ?? { kind: 'all' };
  /** Las fuentes de sólo lectura no tienen `created_by`: «own» ahí es nada. */
  const readOnlyAccess = (ref: string): RowAccess => {
    const access = accessOf(ref);
    return access.kind === 'own' ? { kind: 'none' } : access;
  };

  await Promise.all(
    feed.map(async (id) => {
      // Sin nombre ni campos: lo que no se leyó no puede describirse.
      const tracker = { slug: id, name: 'Tabla del Feed', fields: [] };
      const blocked = (message: string) =>
        sources.set(id, { tracker, rows: [], truncated: false, blocked: message });
      if (options.audience === 'public') return blocked(FEED_PUBLIC_MESSAGE);
      if (!viewerId) return blocked(FEED_NO_VIEWER_MESSAGE);
      const access = readOnlyAccess(id);
      if (access.kind === 'none') return blocked(SCOPE_BLOCKED_MESSAGE);
      try {
        const read = await readFeedSource(db, id, viewerId, VIEW_ROW_CAP);
        if (!read.ok) return blocked(read.message);
        sources.set(id, {
          tracker: { slug: id, name: read.name, fields: read.fields },
          rows: applyRowScope(read.rows.slice(0, VIEW_ROW_CAP), access),
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
      const access = readOnlyAccess(id);
      if (access.kind === 'none') {
        sources.set(id, { tracker, rows: [], truncated: false, blocked: SCOPE_BLOCKED_MESSAGE });
        return;
      }
      try {
        const read = await def.read(db, VIEW_ROW_CAP, bogotaToday(), { viewerId });
        // Un módulo apagado o una cifra sólo para quien administra: sin filas
        // y con la razón, no con un «no se pudo leer».
        if (read.blocked) {
          sources.set(id, { tracker, rows: [], truncated: false, blocked: read.blocked });
          return;
        }
        sources.set(id, {
          tracker,
          rows: applyRowScope(read.rows.slice(0, VIEW_ROW_CAP), access),
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

  const windowed = spec.blocks.flatMap((b) => (b.type === 'sheet' && b.window ? [b] : []));
  const today = bogotaToday();
  const requestOf = (id: string): SheetWindowRequest | undefined =>
    options.allSheetRows ? { reach: 'all' } : options.sheetWindows?.[id];
  // Fuentes de sólo lectura (plataforma, Feed): ya están en memoria, la ventana se recorta ahí.
  for (const b of windowed) {
    const src = sources.get(b.tracker);
    if (!src || src.blocked || !isReadOnlySource(b.tracker) || !b.window) continue;
    (src.windows ??= new Map()).set(
      b.id,
      windowRowsInMemory(src.rows, {
        block: { id: b.id, columns: b.columns, window: b.window, group: b.group },
        fields: src.tracker.fields,
        request: requestOf(b.id),
        today,
      }),
    );
  }
  if (!slugs.length) return sources;
  const { data, error } = await db.from('trackers').select(TRACKER_COLUMNS).in('slug', slugs);
  if (error) throw error;
  const trackers = (data ?? []) as unknown as TrackerRow[];
  // «Buscar en cortex.trm» corre en el navegador sobre las vigencias que viajan con el bloque.
  if (
    trackers.some(
      (t) => Array.isArray(t.fields) && t.fields.some((f) => f.match?.source === TRM_LIST_ID),
    )
  )
    await ensureTrm(db);
  // La marca de duplicados, en una lectura aparte y tolerante: si la migración
  // 0201 aún no está, las vistas siguen funcionando, sólo sin resaltar.
  const flags = new Map<string, { field: string; value: string }>();
  const { data: ruleRows } = await db
    .from('trackers')
    .select('slug, duplicates')
    .in('slug', slugs)
    .not('duplicates', 'is', null);
  for (const r of (ruleRows ?? []) as Array<{ slug: string; duplicates: unknown }>) {
    const d = r.duplicates as { flagField?: unknown; flagValue?: unknown } | null;
    if (d && typeof d.flagField === 'string' && typeof d.flagValue === 'string')
      flags.set(r.slug, { field: d.flagField, value: d.flagValue });
  }
  await Promise.all(
    trackers.map(async (t) => {
      const tracker = {
        slug: t.slug,
        name: t.name,
        fields: Array.isArray(t.fields) ? t.fields : [],
        ...(parseOrigins(t.origins).length ? { origins: parseOrigins(t.origins) } : {}),
        ...(flags.has(t.slug) ? { alertFlag: flags.get(t.slug) } : {}),
      };
      const access = accessOf(t.slug);
      if (access.kind === 'none') {
        sources.set(t.slug, {
          tracker,
          rows: [],
          truncated: false,
          blocked: SCOPE_BLOCKED_MESSAGE,
        });
        return;
      }
      let query = db
        .from('tracker_rows')
        .select('id, label, values, created_by, created_by_app_user, created_at, updated_at')
        .eq('tracker_id', t.id);
      // «Own» de un miembro mira `created_by`; el de un usuario externo de la
      // app (0209) mira `created_by_app_user`. Nunca se cruzan.
      if (access.kind === 'own')
        query = query.eq(access.external ? 'created_by_app_user' : 'created_by', access.userId);
      const { data: rows, error: rowsError } = await query
        .order('updated_at', { ascending: false })
        .limit(VIEW_ROW_CAP + 1);
      if (rowsError) throw rowsError;
      // El scope se aplica otra vez en memoria: es la misma regla que
      // `rowVisible` usa antes de escribir, y así la lectura no depende de que
      // la consulta lo haya hecho.
      const read = (rows ?? []).map((r) => adaptEntry(r as Record<string, unknown>));
      if (options.ensureRowId && !read.some((r) => r.id === options.ensureRowId)) {
        let one = db
          .from('tracker_rows')
          .select('id, label, values, created_by, created_by_app_user, created_at, updated_at')
          .eq('tracker_id', t.id)
          .eq('id', options.ensureRowId);
        if (access.kind === 'own')
          one = one.eq(access.external ? 'created_by_app_user' : 'created_by', access.userId);
        const { data: extra } = await one.maybeSingle();
        if (extra) read.push(adaptEntry(extra as Record<string, unknown>));
      }
      const list = applyRowScope(read, access);
      const kept = list.slice(0, VIEW_ROW_CAP);
      const ensured = options.ensureRowId
        ? list.find((r) => r.id === options.ensureRowId)
        : undefined;
      if (ensured && !kept.includes(ensured)) kept.push(ensured);
      const windows = new Map<string, SheetWindowData>();
      for (const b of windowed) {
        if (b.tracker !== t.slug || !b.window) continue;
        windows.set(
          b.id,
          await loadSheetWindow(db, {
            trackerId: t.id,
            fields: tracker.fields,
            block: { id: b.id, columns: b.columns, window: b.window, group: b.group },
            access,
            parentAccess: b.group?.parentTracker ? accessOf(b.group.parentTracker) : undefined,
            request: requestOf(b.id),
            today,
            adapt: adaptEntry,
          }),
        );
      }
      const truncated = list.length > VIEW_ROW_CAP;
      // Tabla truncada: las cifras se calculan en la base sobre TODA la tabla.
      const aggregates = truncated
        ? await loadSourceAggregates(db, {
            trackerId: t.id,
            slug: t.slug,
            tracker,
            spec,
            access,
            filters: options.filters ?? {},
            today,
          })
        : undefined;
      sources.set(t.slug, {
        tracker,
        rows: kept,
        truncated,
        ...(aggregates ? { aggregates } : {}),
        ...(windows.size ? { windows } : {}),
      });
    }),
  );
  return sources;
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

/**
 * Las vistas del espacio. Las pantallas de una aplicación (0208, `app_id`)
 * también son filas de `custom_views`, pero no son «vistas» para la gente: se
 * ven y se editan desde su app, no desde /views ni desde Inicio.
 */
export async function listViews(db: SupabaseClient, limit = 60): Promise<CustomViewRow[]> {
  const { data, error } = await db
    .from('custom_views')
    .select(VIEW_COLUMNS)
    .is('archived_at', null)
    .is('app_id', null)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

/** Las archivadas (sin pantallas de app), la más reciente primero. */
export async function listArchivedViews(db: SupabaseClient, limit = 60): Promise<CustomViewRow[]> {
  const { data, error } = await db
    .from('custom_views')
    .select(VIEW_COLUMNS)
    .not('archived_at', 'is', null)
    .is('app_id', null)
    .order('archived_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

export async function listPinnedViews(db: SupabaseClient, limit = 3): Promise<CustomViewRow[]> {
  const { data, error } = await db
    .from('custom_views')
    .select(VIEW_COLUMNS)
    .is('archived_at', null)
    .is('app_id', null)
    .eq('pinned', true)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Por id o por slug: el chat nombra vistas como la gente, la app por id. */
/**
 * Una vista por id o slug. Las pantallas de una aplicación (0208, `app_id`)
 * NO se devuelven salvo que quien llama lo pida (`appScreens`): las rutas y
 * acciones de /views, el enlace público y las herramientas del chat reciben
 * «no existe» para ellas, porque abrirlas por ahí saltaría el rol de la app
 * (filas de otros, exportar, botones). Sólo la capa de apps y el editor de
 * quien administra la empresa usan `appScreens: true`.
 */
export async function getView(
  db: SupabaseClient,
  ref: string,
  options: { appScreens?: boolean; includeArchived?: boolean } = {},
): Promise<CustomViewRow | null> {
  let q = db.from('custom_views').select(VIEW_COLUMNS);
  if (!options.includeArchived) q = q.is('archived_at', null);
  if (!options.appScreens) q = q.is('app_id', null);
  const { data, error } = await (UUID_RE.test(ref)
    ? q.eq('id', ref)
    : q.eq('slug', ref)
  ).maybeSingle();
  if (error) throw error;
  return data ? adapt(data as Record<string, unknown>) : null;
}

export async function mustGetView(
  db: SupabaseClient,
  ref: string,
  options: { appScreens?: boolean; includeArchived?: boolean } = {},
): Promise<CustomViewRow> {
  const view = await getView(db, ref, options);
  if (!view)
    throw new NotFoundError(
      await notFoundWithHints(
        db,
        `No hay una vista «${ref}» en este espacio. Mira views_list.`,
        ref,
        'vista',
      ),
    );
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
export async function validateSpecDetailed(
  db: SupabaseClient,
  raw: unknown,
  options: { viewerId?: string | null; keep?: string[] } = {},
): Promise<{ spec: ViewSpec; fixes: string[] }> {
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
  // Lo trivial se corrige antes de comprobar (y se avisa): ver autofixSpecAgainst.
  const fixed = autofixSpecAgainst(parsed.data, catalog);
  const problems = checkSpecAgainst(fixed.spec, catalog);
  if (problems.length) throw new ValidationError(problems.slice(0, 8).join(' '));
  return fixed;
}

export async function validateSpec(
  db: SupabaseClient,
  raw: unknown,
  options: { viewerId?: string | null; keep?: string[] } = {},
): Promise<ViewSpec> {
  return (await validateSpecDetailed(db, raw, options)).spec;
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
    /** La app de la que esta vista es pantalla (0208). Sin él, una vista suelta. */
    appId?: string | null;
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
      ...(input.appId ? { app_id: input.appId } : {}),
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
    /** La vista es la pantalla de una app (0208): sólo lo pide quien ya comprobó que administra. */
    appScreen?: boolean;
  },
): Promise<CustomViewRow> {
  const current = await mustGetView(db, id, { appScreens: input.appScreen });
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
  /** `appScreen`: la vista es una pantalla de una app (0208); `updateView` la oculta si no se pide. */
  options: { appScreen?: boolean } = {},
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
    appScreen: options.appScreen,
  });
}

export async function archiveView(
  db: SupabaseClient,
  id: string,
  options: { appScreen?: boolean } = {},
): Promise<boolean> {
  let q = db
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
    .is('archived_at', null);
  // Una pantalla de app (0208) se archiva sólo desde su app.
  if (!options.appScreen) q = q.is('app_id', null);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Saca una vista del archivo. Archivar le quitó el enlace y la fijó en nada,
 * así que vuelve sólo para el equipo. Si su nombre corto ya lo usa otra vista
 * activa, recibe uno libre. Devuelve false si no estaba archivada.
 */
export async function restoreView(
  db: SupabaseClient,
  id: string,
  options: { appScreen?: boolean } = {},
): Promise<boolean> {
  const { data: row, error: readErr } = await db
    .from('custom_views')
    .select('id, slug')
    .eq('id', id)
    .not('archived_at', 'is', null)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!row) return false;
  const slug = String((row as { slug: string }).slug);
  const patch: Record<string, unknown> = { archived_at: null };
  if (!options.appScreen) {
    const { data: clash, error: clashErr } = await db
      .from('custom_views')
      .select('id')
      .eq('slug', slug)
      .is('archived_at', null)
      .neq('id', id)
      .limit(1);
    if (clashErr) throw clashErr;
    if ((clash ?? []).length > 0) patch.slug = await freeSlug(db, slug);
  }
  let q = db.from('custom_views').update(patch).eq('id', id).not('archived_at', 'is', null);
  if (!options.appScreen) q = q.is('app_id', null);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Borra la vista de verdad (no la archiva): sus versiones, envíos, eventos y
 * resúmenes se van con ella (ON DELETE CASCADE). Los datos de las tablas no se
 * tocan. Una vista que es pantalla de una aplicación no se borra aquí: se
 * rechaza con el nombre de las apps que la usan.
 */
export async function deleteView(db: SupabaseClient, id: string): Promise<boolean> {
  const { data: used, error: usedErr } = await db
    .from('custom_app_screens')
    .select('app_id')
    .eq('view_id', id);
  if (usedErr) throw usedErr;
  const appIds = [...new Set((used ?? []).map((r) => String((r as { app_id: string }).app_id)))];
  if (appIds.length > 0) {
    const { data: apps } = await db.from('custom_apps').select('name').in('id', appIds);
    const names = (apps ?? []).map((a) => `«${String((a as { name: string }).name)}»`);
    throw new ValidationError(
      `Esta vista es pantalla de ${names.length === 1 ? 'la aplicación' : 'las aplicaciones'} ${
        names.join(', ') || 'una aplicación'
      }. Quítala de ahí o elimina la aplicación primero.`,
    );
  }
  const { data, error } = await db
    .from('custom_views')
    .delete()
    .eq('id', id)
    .is('app_id', null)
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
    .is('app_id', null)
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

/** Lo que devuelve un envío: la fila y, si el formulario deja corregir, con qué token y hasta cuándo. */
export interface SubmitOutcome {
  rowId: string;
  message: string;
  duplicate: string | null;
  /** Para corregir sin sesión; null si el formulario no deja corregir. */
  editToken: string | null;
  editUntil: string | null;
  /** True si era un reintento de un envío que ya había llegado. */
  replayed?: boolean;
}

/** Quién escribe: un miembro de Cortex o un usuario externo de una app (0209). */
export type ActorKind = 'member' | 'app_user';

export class SubmissionLimitError extends Error {
  constructor() {
    super('Este formulario recibió demasiados envíos en la última hora. Intenta más tarde.');
    this.name = 'SubmissionLimitError';
  }
}

/**
 * Los valores que un formulario guardaría: qué campos entran (los del bloque,
 * los forzados, los que se llenan solos), defaults, campos ocultos, reglas de
 * cada campo y relaciones. No escribe nada: lo usan el envío de verdad y el
 * «modo prueba» de «Ver como…», que muestra «se habría guardado esto».
 */
async function prepareFormValues(
  db: SupabaseClient,
  view: CustomViewRow,
  block: FormBlock,
  tracker: TrackerRow,
  input: {
    values: Record<string, unknown>;
    submittedBy: string | null;
    submittedByKind?: ActorKind;
    viewer?: string | null;
    forced?: Record<string, string>;
    fillDefaults?: boolean;
  },
): Promise<Record<string, string | number>> {
  const allowed = new Set(block.fields.length ? block.fields : tracker.fields.map((f) => f.key));
  // El campo de estado de la aprobación no se pide: lo pone el servidor.
  if (block.approval) allowed.add(block.approval.field);
  const forced = input.forced ?? {};
  for (const key of Object.keys(forced)) allowed.add(key);
  const defaultOnly = new Set<string>();
  if (input.fillDefaults)
    for (const f of tracker.fields)
      if (!allowed.has(f.key) && f.default !== undefined && f.default !== '') {
        allowed.add(f.key);
        defaultOnly.add(f.key);
      }
  // Los campos que se llenan solos (fórmula, lookup) se calculan aunque el
  // formulario no los muestre: la fila que se guarda es la de la tabla.
  for (const f of tracker.fields)
    if ((f.formula || (f.lookup && !f.lookup.editable)) && !allowed.has(f.key)) {
      allowed.add(f.key);
      defaultOnly.add(f.key);
    }
  const asked = tracker.fields.filter((f) => allowed.has(f.key));
  const raw: Record<string, unknown> = {};
  for (const f of asked)
    raw[f.key] = defaultOnly.has(f.key) || f.formula ? undefined : input.values[f.key];
  for (const [key, value] of Object.entries(forced)) raw[key] = value;
  if (block.approval) raw[block.approval.field] = block.approval.pending;
  // Defaults, campos ocultos (showIf), reglas de cada campo y relaciones. Una
  // relación de un enlace público sólo puede apuntar a las tablas de ESTA vista:
  // el resto del espacio no se asoma por un select de la página pública.
  return prepareValues(db, { ...tracker, fields: asked }, raw, {
    applyDefaults: true,
    viewer: input.viewer,
    allowedRelationTrackers:
      input.submittedBy && input.submittedByKind !== 'app_user'
        ? undefined
        : new Set(trackersOf(view.spec)),
  });
}

/**
 * El «modo prueba» de un formulario: pasa por las mismas reglas que un envío
 * de verdad (campos que pide, ocultos, validaciones, relaciones) y devuelve la
 * fila tal como se guardaría, SIN escribir nada. Lanza `ValidationError` con el
 * mismo texto que daría el envío real.
 */
export async function previewViewForm(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    values: Record<string, unknown>;
    submittedBy: string | null;
    submittedByKind?: ActorKind;
    viewer?: string | null;
    forced?: Record<string, string>;
    fillDefaults?: boolean;
  },
): Promise<{ values: Record<string, string | number>; tracker: TrackerRow }> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || block.type !== 'form')
    throw new NotFoundError('Ese formulario no está en esta vista.');
  if (isReadOnlySource(block.tracker))
    throw new ValidationError(
      'Este formulario apunta a una fuente de sólo lectura; no recibe filas.',
    );
  const { data: t, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', block.tracker)
    .maybeSingle();
  if (error) throw error;
  if (!t) throw new NotFoundError('La tabla de este formulario ya no existe.');
  const tracker = t as unknown as TrackerRow;
  const values = await prepareFormValues(db, view, block, tracker, input);
  return { values, tracker };
}

/**
 * Las líneas de cada sección del formulario, leídas del envío, ordenadas y
 * juzgadas (topes y cantidades). Lanza `ValidationError` con la frase de la sección.
 */
function readLineSections(
  block: FormBlock,
  values: Record<string, unknown>,
): Array<{ key: string; cfg: FormLines; lines: FormLine[] }> {
  return formLineSections<FormLines>(block).map(({ key, cfg }) => {
    const parsed = parseLinesValue(values[key]);
    if (!parsed) throw new ValidationError('La lista de ítems no se entiende. Vuelve a armarla.');
    const lines = normalizeLines(parsed);
    const problem = checkLines(lines, {
      min: cfg.min,
      max: cfg.max,
      decimals: cfg.decimals,
      title: cfg.title,
    });
    if (problem) throw new ValidationError(problem);
    return { key, cfg, lines };
  });
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
    /**
     * Quién es `submittedBy`: un miembro de Cortex (por omisión) o un usuario
     * externo de una app (0209). El externo está autenticado —no cuenta en el
     * tope del enlace público— pero lee relaciones sólo de las tablas de la
     * pantalla, y la fila queda con `created_by_app_user`.
     */
    submittedByKind?: ActorKind;
    /** Nombre de quien llena (para `default: 'viewer'`); sin sesión, vacío. */
    viewer?: string | null;
    /**
     * Id que el navegador inventó para ESTE envío (cola sin internet): si ya
     * llegó uno igual, no se escribe otra fila — se devuelve la de la primera vez.
     */
    clientId?: string | null;
    /**
     * Valores que pone el SERVIDOR aunque el formulario no pida ese campo (el
     * campo del scope de una app: «Cliente» = el cliente de quien escribe).
     * Pisan lo que mande el navegador.
     */
    forced?: Record<string, string>;
    /**
     * Rellena con su `default` los campos de la tabla que el formulario no
     * pide (por ejemplo el estado inicial «Solicitada»). Nunca toma el valor
     * del navegador para esos campos. Lo usa la capa de apps.
     */
    fillDefaults?: boolean;
  },
): Promise<SubmitOutcome> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || block.type !== 'form')
    throw new NotFoundError('Ese formulario no está en esta vista.');
  if (isReadOnlySource(block.tracker))
    throw new ValidationError(
      'Este formulario apunta a una fuente de sólo lectura; no recibe filas.',
    );

  // Las líneas (ítems con cantidad) viajan aparte de los campos de la tabla, una llave por sección.
  const sections = readLineSections(block, input.values);

  const clientId = input.clientId?.trim().slice(0, 64) || null;
  const replay = async (): Promise<SubmitOutcome | null> => {
    if (!clientId) return null;
    const { data, error } = await db
      .from('custom_view_submissions')
      .select('tracker_row_id, edit_token, created_at')
      .eq('view_id', view.id)
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const d = data as {
      tracker_row_id: string | null;
      edit_token: string | null;
      created_at: string;
    };
    return {
      rowId: String(d.tracker_row_id ?? ''),
      message: block.successMessage,
      duplicate: null,
      editToken: d.edit_token,
      editUntil: d.edit_token ? editDeadline(d.created_at, editWindowOf(block)) : null,
      replayed: true,
    };
  };
  const earlier = await replay();
  if (earlier) return earlier;

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
  // Una tabla que se llena sola desde una integración no recibe filas a mano (0237).
  assertRowWriteAllowed(tracker, { creating: true, after: {} });

  const values = await prepareFormValues(db, view, block, tracker, input);

  // Flujo por estados: la fila nueva nace en el primer estado.
  Object.assign(
    values,
    guardFlowWrite(
      tracker,
      null,
      values,
      currentFlowActor(input.submittedBy ? UNSCOPED_ACTOR : ANONYMOUS_ACTOR),
    ),
  );
  const byApp = input.submittedByKind === 'app_user';
  const { data: row, error } = await db
    .from('tracker_rows')
    .insert({
      tracker_id: tracker.id,
      label: rowLabel(tracker.fields, values),
      values,
      created_by: byApp ? null : input.submittedBy,
      ...(byApp ? { created_by_app_user: input.submittedBy } : {}),
    })
    .select('id')
    .single();
  if (error) throw error;
  const rowId = String((row as { id: string }).id);

  // Las líneas: una fila hija por ítem, un insert por sección. Si algo falla, la fila
  // del formulario no se queda sola: se borra (con lo ya creado) y el error le llega a la persona.
  const made: Array<{
    cfg: FormLines;
    ids: string[];
    trackerId: string;
    rows: Array<{ id: string; label: string; values: Record<string, unknown> }>;
  }> = [];
  try {
    for (const sec of sections) {
      if (!sec.lines.length) continue;
      const got = await insertLineRows(db, {
        view,
        block,
        cfg: sec.cfg,
        parent: { id: rowId, label: rowLabel(tracker.fields, values), tracker },
        lines: sec.lines,
        submittedBy: input.submittedBy,
        byApp,
        viewer: input.viewer,
        restrictRelations: !(input.submittedBy && input.submittedByKind !== 'app_user'),
      });
      made.push({ cfg: sec.cfg, ...got });
    }
  } catch (err) {
    for (const m of made)
      await db.from('tracker_rows').delete().in('id', m.ids).eq('tracker_id', m.trackerId);
    await db.from('tracker_rows').delete().eq('id', rowId).eq('tracker_id', tracker.id);
    throw err;
  }

  const editToken = editWindowOf(block) > 0 ? randomBytes(18).toString('base64url') : null;
  const { data: sub, error: subError } = await db
    .from('custom_view_submissions')
    .insert({
      view_id: view.id,
      block_id: block.id,
      tracker_row_id: rowId,
      submitted_by: input.submittedBy,
      client_id: clientId,
      edit_token: editToken,
    })
    .select('created_at')
    .single();
  if (subError) {
    // Dos reintentos a la vez del mismo envío: gana el primero; esta fila sobra.
    if ((subError as { code?: string }).code === '23505' && clientId) {
      await db.from('tracker_rows').delete().eq('id', rowId).eq('tracker_id', tracker.id);
      for (const m of made)
        await db.from('tracker_rows').delete().in('id', m.ids).eq('tracker_id', m.trackerId);
      const first = await replay();
      if (first) return first;
    }
    throw subError;
  }

  // La regla de duplicados de la tabla (si tiene): si esta fila chocó con otra,
  // se avisa a quien la mandó para que corrija ya, no después de despachar.
  const rule = await getDuplicateRule(db, tracker.id);
  let duplicate: string | null = null;
  if (rule) {
    const outcome = await applyDuplicateRule(db, tracker.id, [values]);
    duplicate = duplicateMessage(
      rule.rule,
      rule.fields,
      outcome.conflicts.find((c) => c.rowId === rowId),
    );
  }

  // Automatizaciones (0210): una fila nueva y un formulario enviado. Después de
  // la regla de duplicados, para que `after` ya lleve la marca si la hubo.
  if (await watchesTracker(db, tracker.id)) {
    const actor = {
      kind: byApp ? ('app_user' as const) : ('member' as const),
      id: input.submittedBy,
    };
    const common = {
      trackerId: tracker.id,
      trackerSlug: tracker.slug,
      rowId,
      after: values as Record<string, string | number>,
      label: rowLabel(tracker.fields, values),
      version: new Date().toISOString(),
      actor,
      viewId: view.id,
      blockId: block.id,
    };
    await emitAutomationEvent(db, { ...common, kind: 'row_created' });
    await emitAutomationEvent(db, { ...common, kind: 'form_submitted' });
  }

  // Las filas hijas de las líneas también son filas nuevas: una regla que mire
  // esa tabla («al crear un equipo usado, suma el costo en la atención») tiene
  // que enterarse, igual que si se hubieran escrito una por una.
  for (const m of made) {
    if (!m.rows.length || !(await watchesTracker(db, m.trackerId))) continue;
    const actor = {
      kind: byApp ? ('app_user' as const) : ('member' as const),
      id: input.submittedBy,
    };
    for (const child of m.rows)
      await emitAutomationEvent(db, {
        kind: 'row_created',
        trackerId: m.trackerId,
        trackerSlug: m.cfg.tracker,
        rowId: child.id,
        after: child.values as Record<string, string | number>,
        label: child.label,
        version: new Date().toISOString(),
        actor,
        viewId: view.id,
        blockId: block.id,
      });
  }

  return {
    rowId,
    message: block.successMessage,
    duplicate,
    editToken,
    editUntil: editToken
      ? editDeadline((sub as { created_at: string }).created_at, editWindowOf(block))
      : null,
  };
}

/**
 * Escribe las filas hijas de un formulario con líneas. Cada línea pasa por
 * `prepareValues` (tipos, relaciones, lookups, fórmulas de la tabla hija) igual
 * que cualquier fila; las relaciones apuntan a la fila recién creada y al ítem
 * elegido. Desde un enlace público o un usuario externo, el ítem sólo puede ser
 * de la tabla que el formulario declara.
 */
async function insertLineRows(
  db: SupabaseClient,
  input: {
    view: CustomViewRow;
    block: Extract<CustomViewRow['spec']['blocks'][number], { type: 'form' }>;
    cfg: FormLines;
    parent: { id: string; label: string; tracker: TrackerRow };
    lines: FormLine[];
    submittedBy: string | null;
    byApp: boolean;
    viewer?: string | null;
    restrictRelations: boolean;
  },
): Promise<{
  ids: string[];
  trackerId: string;
  rows: Array<{ id: string; label: string; values: Record<string, unknown> }>;
}> {
  const cfg = input.cfg;
  const child = await trackerForBlock(db, cfg.tracker);
  assertRowWriteAllowed(child, { creating: true, after: {} });
  const itemField = child.fields.find((f) => f.key === cfg.item);
  const allowed = input.restrictRelations
    ? new Set([...trackersOf(input.view.spec), input.parent.tracker.slug, itemField?.tracker ?? ''])
    : undefined;
  const rows: Array<Record<string, unknown>> = [];
  for (const line of input.lines) {
    const values = await prepareValues(
      db,
      child,
      {
        [cfg.parent]: JSON.stringify({ id: input.parent.id, label: input.parent.label }),
        [cfg.item]: JSON.stringify({ id: line.item.id, label: line.item.label }),
        [cfg.qty]: line.qty,
      },
      { applyDefaults: true, viewer: input.viewer, allowedRelationTrackers: allowed },
    );
    rows.push({
      tracker_id: child.id,
      label: rowLabel(child.fields, values),
      values,
      created_by: input.byApp ? null : input.submittedBy,
      ...(input.byApp && input.submittedBy ? { created_by_app_user: input.submittedBy } : {}),
    });
  }
  const { data, error } = await db.from('tracker_rows').insert(rows).select('id');
  if (error) throw error;
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
  return {
    ids,
    trackerId: child.id,
    rows: ids.map((id, i) => ({
      id,
      label: String(rows[i]?.label ?? ''),
      values: (rows[i]?.values ?? {}) as Record<string, unknown>,
    })),
  };
}

async function labelOfRow(db: SupabaseClient, trackerId: string, rowId: string): Promise<string> {
  const { data } = await db
    .from('tracker_rows')
    .select('label')
    .eq('id', rowId)
    .eq('tracker_id', trackerId)
    .maybeSingle();
  return String((data as { label?: string } | null)?.label ?? '');
}

/** El id de la fila relacionada que guarda un valor de relación (JSON `{id,label}` o el id suelto). */
function relationRowId(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (/^[0-9a-f-]{36}$/i.test(s)) return s.toLowerCase();
  try {
    const o = JSON.parse(s) as { id?: unknown };
    return typeof o.id === 'string' ? o.id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Deja las líneas de UNA sección tal como la persona las armó: agrega las que
 * faltan, cambia la cantidad de las que cambiaron y quita las que ya no están.
 * Cada fila hija pasa por `prepareValues` (fórmulas y lookups de la tabla hija se
 * recalculan), y las reglas que miran esa tabla se enteran de lo creado y lo cambiado.
 * Sirve tanto para corregir un envío como para completar un registro existente.
 */
async function syncLineRows(
  db: SupabaseClient,
  input: {
    view: CustomViewRow;
    block: FormBlock;
    cfg: FormLines;
    parent: { id: string; label: string; tracker: TrackerRow };
    lines: FormLine[];
    actor: string | null;
    actorKind?: ActorKind;
    viewer?: string | null;
  },
): Promise<{ added: number; changed: number; removed: number }> {
  const { cfg } = input;
  const child = await trackerForBlock(db, cfg.tracker);
  const byApp = input.actorKind === 'app_user';
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, external_key')
    .eq('tracker_id', child.id)
    .ilike(`values->>${cfg.parent}`, `%${input.parent.id}%`)
    .limit(500);
  if (error) throw error;
  const existing = ((data ?? []) as Array<{
    id: string;
    label: string;
    values: Record<string, unknown>;
  }>).filter((r) => relationRowId(r.values?.[cfg.parent]) === input.parent.id.toLowerCase());
  const wanted = new Map(input.lines.map((l) => [l.item.id.toLowerCase(), l] as const));
  const keep = new Map<string, (typeof existing)[number]>();
  const drop: string[] = [];
  for (const row of existing) {
    const item = relationRowId(row.values?.[cfg.item]);
    if (item && wanted.has(item) && !keep.has(item)) keep.set(item, row);
    else drop.push(row.id);
  }
  const allowed = !(input.actor && !byApp)
    ? new Set([...trackersOf(input.view.spec), input.parent.tracker.slug])
    : undefined;
  let changed = 0;
  for (const [itemId, row] of keep) {
    const line = wanted.get(itemId);
    if (!line || Number(row.values?.[cfg.qty]) === line.qty) continue;
    const known = Object.fromEntries(
      Object.entries(row.values ?? {}).filter(([k]) => child.fields.some((f) => f.key === k)),
    );
    const values = await prepareValues(
      db,
      child,
      { ...known, [cfg.qty]: line.qty },
      { selfId: row.id, only: new Set([cfg.qty]), allowedRelationTrackers: allowed },
    );
    assertRowWriteAllowed(child, {
      before: known,
      after: values,
      keys: [cfg.qty],
      externalKey: (row as { external_key?: string | null }).external_key ?? null,
    });
    const label = rowLabel(child.fields, values);
    const { error: upError } = await db
      .from('tracker_rows')
      .update({ values, label, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('tracker_id', child.id);
    if (upError) throw upError;
    changed += 1;
    if (await watchesTracker(db, child.id))
      await emitAutomationEvent(db, {
        kind: 'row_updated',
        trackerId: child.id,
        trackerSlug: child.slug,
        rowId: row.id,
        before: row.values as Record<string, string | number>,
        after: values as Record<string, string | number>,
        label,
        version: new Date().toISOString(),
        actor: { kind: input.actorKind ?? ('member' as const), id: input.actor },
        viewId: input.view.id,
        blockId: input.block.id,
      });
  }
  const fresh = input.lines.filter((l) => !keep.has(l.item.id.toLowerCase()));
  let added = 0;
  if (fresh.length) {
    const made = await insertLineRows(db, {
      view: input.view,
      block: input.block,
      cfg,
      parent: input.parent,
      lines: fresh,
      submittedBy: input.actor,
      byApp,
      viewer: input.viewer,
      restrictRelations: !(input.actor && !byApp),
    });
    added = made.ids.length;
    if (made.rows.length && (await watchesTracker(db, made.trackerId)))
      for (const c of made.rows)
        await emitAutomationEvent(db, {
          kind: 'row_created',
          trackerId: made.trackerId,
          trackerSlug: cfg.tracker,
          rowId: c.id,
          after: c.values as Record<string, string | number>,
          label: c.label,
          version: new Date().toISOString(),
          actor: { kind: input.actorKind ?? ('member' as const), id: input.actor },
          viewId: input.view.id,
          blockId: input.block.id,
        });
  }
  if (drop.length)
    await db.from('tracker_rows').delete().in('id', drop).eq('tracker_id', child.id);
  return { added, changed, removed: drop.length };
}

/**
 * Completar un registro que ya existe con un formulario `onRecord` (comenzar una
 * atención y, al cerrarla, llenar el resto y los equipos usados): escribe los
 * campos que el formulario pide sobre ESA fila (por `patchRow`, con todas sus
 * reglas) y deja sus líneas como quedaron. Lo que el formulario no pide no se toca.
 */
export async function saveFormRecord(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    rowId: string;
    values: Record<string, unknown>;
    actor: string | null;
    actorKind?: ActorKind;
    viewer?: string | null;
  },
): Promise<{ label: string; duplicate: string | null; lines: { added: number; changed: number; removed: number } }> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || block.type !== 'form' || !block.onRecord)
    throw new NotFoundError('Ese formulario no completa un registro.');
  const tracker = await trackerForBlock(db, block.tracker);
  const sections = readLineSections(block, input.values);
  const allowed = new Set(
    (block.fields.length ? block.fields : tracker.fields.map((f) => f.key)).filter(
      (k) => k !== block.approval?.field,
    ),
  );
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.values))
    if (allowed.has(k)) {
      const f = tracker.fields.find((x) => x.key === k);
      if (f?.formula || (f?.lookup && !f.lookup.editable)) continue;
      patch[k] = v;
    }
  let label = '';
  let duplicate: string | null = null;
  if (Object.keys(patch).length) {
    const r = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId: input.rowId,
      patch,
      allowed,
      kind: 'edit',
      actor: input.actor,
      actorKind: input.actorKind,
    });
    label = r.label;
    duplicate = r.duplicate;
  }
  const total = { added: 0, changed: 0, removed: 0 };
  if (!label && sections.some((sec) => sec.key in input.values))
    label = await labelOfRow(db, tracker.id, input.rowId);
  for (const sec of sections) {
    if (!(sec.key in input.values)) continue;
    const r = await syncLineRows(db, {
      view,
      block,
      cfg: sec.cfg,
      parent: { id: input.rowId, label, tracker },
      lines: sec.lines,
      actor: input.actor,
      actorKind: input.actorKind,
      viewer: input.viewer,
    });
    total.added += r.added;
    total.changed += r.changed;
    total.removed += r.removed;
  }
  return { label, duplicate, lines: total };
}

/**
 * Corrige lo que ya se envió, dentro de la ventana del formulario
 * (`editWindowMinutes`) y sólo por quien lo envió: con sesión, el mismo
 * usuario; sin sesión, con el token de edición del envío. Escribe por
 * `patchRow` con la lista blanca del formulario (sin el campo de estado de la
 * aprobación), y si el envío ya fue aprobado o rechazado, no se toca.
 */
export async function editViewSubmission(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    rowId: string;
    values: Record<string, string>;
    actor: string | null;
    actorKind?: ActorKind;
    token?: string | null;
  },
): Promise<{ label: string; duplicate: string | null }> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || block.type !== 'form')
    throw new NotFoundError('Ese formulario no está en esta vista.');
  if (editWindowOf(block) <= 0) throw new ValidationError(EDIT_MESSAGES.off);
  const { data, error } = await db
    .from('custom_view_submissions')
    .select('created_at, submitted_by, edit_token')
    .eq('view_id', view.id)
    .eq('block_id', block.id)
    .eq('tracker_row_id', input.rowId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Ese envío ya no existe.');
  const decision = canEditSubmission({
    submission: data as {
      created_at: string;
      submitted_by: string | null;
      edit_token: string | null;
    },
    minutes: editWindowOf(block),
    actor: input.actor,
    token: input.token,
  });
  if (!decision.ok) throw new ValidationError(EDIT_MESSAGES[decision.reason]);
  if (!input.actor) await assertPublicBudget(db, view.id);

  const tracker = await trackerForBlock(db, block.tracker);
  if (block.approval) {
    const { data: cur, error: curError } = await db
      .from('tracker_rows')
      .select('values')
      .eq('id', input.rowId)
      .eq('tracker_id', tracker.id)
      .maybeSingle();
    if (curError) throw curError;
    if (!cur) throw new NotFoundError('Esa fila ya no está en la tabla.');
    if (!isPendingReview(block.approval, (cur as { values: Record<string, unknown> }).values))
      throw new ValidationError(EDIT_MESSAGES.reviewed);
  }
  const allowed = new Set(
    (block.fields.length ? block.fields : tracker.fields.map((f) => f.key)).filter(
      (k) => k !== block.approval?.field,
    ),
  );
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.values)) if (allowed.has(k)) patch[k] = v;
  // Las líneas también se corrigen: si vienen (aunque sea vacías), la lista queda como se armó.
  const sections = readLineSections(block, input.values).filter((sec) => sec.key in input.values);
  let label = '';
  let duplicate: string | null = null;
  if (Object.keys(patch).length || !sections.length) {
    const r = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId: input.rowId,
      patch,
      allowed,
      kind: 'edit',
      actor: input.actor,
      actorKind: input.actorKind,
    });
    label = r.label;
    duplicate = r.duplicate;
  }
  if (sections.length && !label) label = await labelOfRow(db, tracker.id, input.rowId);
  for (const sec of sections) {
    await syncLineRows(db, {
      view,
      block,
      cfg: sec.cfg,
      parent: { id: input.rowId, label, tracker },
      lines: sec.lines,
      actor: input.actor,
      actorKind: input.actorKind,
    });
  }
  return { label, duplicate };
}

/**
 * Las filas que un campo de relación de un formulario puede elegir, con
 * búsqueda. La tabla relacionada la decide el ESQUEMA (campo `tracker`), no la
 * petición, y desde un enlace público sólo se lee si esa tabla es una fuente de
 * la misma vista: una página pública no se asoma al resto del espacio. Sólo se
 * devuelven id y nombre de la fila (lo que `shapeValues` guardaría igual).
 */
export async function searchRelationOptions(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    field: string;
    q: string;
    audience: 'team' | 'public';
    /**
     * Tablas que, además de las de la vista, quien mira puede leer enteras
     * (en una app: las que su rol lee con `read: 'all'`). Sin esto, un
     * desplegable a una tabla que la pantalla no muestra salía vacío para el
     * operario aunque su rol sí pudiera leerla (2026-10-19, tarifario).
     */
    readable?: readonly string[];
  },
): Promise<
  Array<{
    id: string;
    label: string;
    /** Una línea para reconocer la fila («Medellín · 300 123 4567»): la tarjeta del elegido. */
    detail?: string;
    pick?: Record<string, string | number>;
  }>
> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || (block.type !== 'form' && block.type !== 'sheet'))
    throw new NotFoundError('Ese formulario no está en esta vista.');
  // `__lines`, `__lines2`…: los ítems que se pueden elegir en las líneas del formulario
  // (el campo `item` de la tabla hija de esa sección). Se trata como una relación más.
  const forLines = block.type === 'form' && isLinesKey(input.field);
  const section =
    forLines && block.type === 'form'
      ? formLineSections<FormLines>(block).find((x) => x.key === input.field)?.cfg
      : undefined;
  if (forLines && !section)
    throw new NotFoundError('Este formulario no tiene lista de ítems.');
  const source = await trackerForBlock(db, section ? section.tracker : block.tracker);
  // En las líneas se piden además los campos que la tabla hija trae de la fila elegida
  // (la tarifa de un equipo): así el monto de cada línea se calcula al instante.
  const asked = new Set(
    section
      ? [
          section.item,
          ...source.fields.filter((f) => f.lookup?.via === section.item).map((f) => f.key),
        ]
      : block.type === 'sheet'
        ? block.editable
        : block.fields.length
          ? block.fields
          : source.fields.map((f) => f.key),
  );
  const field = source.fields.find((f) => f.key === (section ? section.item : input.field));
  if (!field || field.type !== 'relation' || !field.tracker || !asked.has(field.key))
    throw new NotFoundError('Ese campo no es una relación de este formulario.');
  if (
    input.audience === 'public' &&
    !forLines &&
    !trackersOf(view.spec).includes(field.tracker) &&
    !input.readable?.includes(field.tracker)
  )
    throw new ValidationError('Esta vista no comparte esa tabla.');
  const target = await trackerForBlock(db, field.tracker);
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values')
    .eq('tracker_id', target.id)
    .order('updated_at', { ascending: false })
    .limit(400);
  if (error) throw error;
  // Lookups: lo que cada fila trae para los campos «traídos» de esta relación,
  // para que el formulario los llene al elegir (sólo los campos configurados).
  const lookups = lookupSources(source.fields).filter(
    (l) => l.via === field.key && asked.has(l.field.key),
  );
  // Sin tildes ni mayúsculas, en memoria: «peña» encuentra «Pena» (ver clients/store.ts).
  const fold = (t: string) =>
    t
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const needle = fold(input.q.trim().slice(0, 60));
  return ((data ?? []) as Array<{ id: string; label: string; values?: Record<string, unknown> }>)
    .filter((r) => !needle || fold(String(r.label)).includes(needle))
    .slice(0, 20)
    .map((r) => {
      const pick: Record<string, string | number> = {};
      for (const l of lookups) {
        const v = adaptLookupValue(l.field, r.values?.[l.target]);
        if (v !== undefined) pick[l.field.key] = v;
      }
      const detail = detailOf(target.fields, r);
      return {
        id: String(r.id),
        label: String(r.label),
        ...(detail ? { detail } : {}),
        ...(lookups.length ? { pick } : {}),
      };
    });
}

/** Dos datos cortos de una fila (texto, opciones, números, fechas) para reconocerla en una lista. */
function detailOf(
  fields: TrackerRow['fields'],
  row: { label: string; values?: Record<string, unknown> },
): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (parts.length >= 2) break;
    if (
      f.type === 'file' ||
      f.type === 'relation' ||
      f.type === 'longtext' ||
      f.type === 'location'
    )
      continue;
    const text = displayTrackerValue(f, row.values?.[f.key]).trim();
    if (!text || text === row.label || text.length > 60) continue;
    parts.push(text);
  }
  return parts.join(' · ');
}

/**
 * «+ Agregar» en una relación de un formulario: crea la fila que falta en la
 * tabla relacionada con SÓLO su nombre, sin salir del formulario («+ Agregar
 * proveedor»). Sólo vale si esa tabla no pide nada más sin valor por defecto:
 * si pide más, se dice y la persona la llena desde la tabla. Si ya hay una fila
 * con ese nombre (sin tildes ni mayúsculas), se devuelve esa: no se duplica.
 * Quien llama decide si la persona puede crear ahí (`mayCreate`).
 */
export async function createRelationRow(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    field: string;
    label: string;
    createdBy: string | null;
    createdByApp?: boolean;
    mayCreate?: (slug: string) => boolean;
  },
): Promise<{ id: string; label: string; created: boolean }> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (block?.type === 'sheet') return createRelationRowForSheet(db, block, input);
  if (!block || block.type !== 'form')
    throw new NotFoundError('Ese formulario no está en esta vista.');
  const forLines = isLinesKey(input.field);
  const section = forLines
    ? formLineSections<FormLines>(block).find((x) => x.key === input.field)?.cfg
    : undefined;
  if (forLines && !section)
    throw new NotFoundError('Este formulario no tiene lista de ítems.');
  const source = await trackerForBlock(db, section ? section.tracker : block.tracker);
  const key = section ? section.item : input.field;
  const field = source.fields.find((f) => f.key === key);
  if (!field || field.type !== 'relation' || !field.tracker)
    throw new NotFoundError('Ese campo no es una relación de este formulario.');
  if (!forLines && block.fields.length && !block.fields.includes(field.key))
    throw new NotFoundError('Ese campo no está en el formulario.');
  const target = await trackerForBlock(db, field.tracker);
  return createRowInTarget(db, target, input);
}

/**
 * «+ Crear «texto»» desde una celda de relación de la hoja: la misma creación
 * que en un formulario, pero el campo sale de las columnas que la hoja deja
 * editar (nunca de una que el spec no ofrece).
 */
async function createRelationRowForSheet(
  db: SupabaseClient,
  block: Extract<ViewSpec['blocks'][number], { type: 'sheet' }>,
  input: Parameters<typeof createRelationRow>[2],
): Promise<{ id: string; label: string; created: boolean }> {
  if (!block.editable.includes(input.field))
    throw new NotFoundError('Ese campo no se edita en esta hoja.');
  const source = await trackerForBlock(db, block.tracker);
  const field = source.fields.find((f) => f.key === input.field);
  if (!field || field.type !== 'relation' || !field.tracker)
    throw new NotFoundError('Ese campo no es una relación de esta hoja.');
  const target = await trackerForBlock(db, field.tracker);
  return createRowInTarget(db, target, input);
}

/** Las filas de la tabla destino con las que se compara lo escrito (nombre y NIT). */
async function findExistingRelationRow(
  db: SupabaseClient,
  target: TrackerRow,
  label: string,
): Promise<{ id: string; label: string } | null> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values')
    .eq('tracker_id', target.id)
    .order('updated_at', { ascending: false })
    .limit(2000);
  if (error) throw error;
  const hit = matchExistingRelation(
    ((data ?? []) as Array<{ id: string; label: string; values?: Record<string, unknown> | null }>).map((r) => ({
      id: String(r.id),
      label: String(r.label),
      values: r.values ?? null,
    })),
    label,
  );
  return hit ? { id: hit.id, label: hit.label } : null;
}

async function createRowInTarget(
  db: SupabaseClient,
  target: TrackerRow,
  input: { label: string; createdBy: string | null; createdByApp?: boolean; mayCreate?: (slug: string) => boolean },
): Promise<{ id: string; label: string; created: boolean }> {
  assertRowWriteAllowed(target, { creating: true, after: {} });
  if (input.mayCreate && !input.mayCreate(target.slug))
    throw new ValidationError(`Tu rol no agrega filas en «${target.name}».`);
  const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (label.length < 2) throw new ValidationError('Escribe el nombre (al menos 2 letras).');
  const main =
    target.fields.find((f) => f.type === 'text' && f.required) ??
    target.fields.find((f) => f.type === 'text');
  if (!main)
    throw new ValidationError(
      `«${target.name}» no tiene un campo de nombre para agregar desde aquí.`,
    );
  const others = target.fields.filter(
    (f) =>
      f.key !== main.key &&
      f.required &&
      f.default === undefined &&
      !f.formula &&
      !(f.lookup && !f.lookup.editable),
  );
  if (others.length)
    throw new ValidationError(
      `«${target.name}» pide más datos (${others.map((f) => f.label).join(', ')}): agrégalo desde su tabla.`,
    );
  const same = await findExistingRelationRow(db, target, label);
  if (same) return { id: same.id, label: same.label, created: false };
  const values = await prepareValues(db, target, { [main.key]: label }, { applyDefaults: true });
  const { data: row, error } = await db
    .from('tracker_rows')
    .insert({
      tracker_id: target.id,
      label: rowLabel(target.fields, values),
      values,
      created_by: input.createdByApp ? null : input.createdBy,
      ...(input.createdByApp && input.createdBy ? { created_by_app_user: input.createdBy } : {}),
    })
    .select('id, label')
    .single();
  if (error) throw error;
  const made = row as { id: string; label: string };
  return { id: String(made.id), label: String(made.label), created: true };
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
/** Otra persona tomó la fila entre que se leyó y se escribió. */
export class ClaimLostError extends Error {
  constructor() {
    super('La fila ya la tomó otra persona.');
    this.name = 'ClaimLostError';
  }
}

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
    actorKind?: ActorKind;
    /** Motivo de un rechazo, para las automatizaciones (`{{motivo}}`). */
    reason?: string | null;
    /**
     * Compare-and-set: la fila se escribe SÓLO si, en el mismo UPDATE, `unset` está vacío
     * y (si se pide) `statusIs.field` vale `statusIs.value`. Si otra persona se adelantó,
     * no se escribe nada y se lanza `ClaimLostError`.
     */
    guard?: { unset: string; statusIs?: { field: string; value: string } };
  },
): Promise<{
  label: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  duplicate: string | null;
}> {
  const keys = Object.keys(input.patch);
  if (!keys.length) throw new ValidationError('No hay nada que cambiar.');
  const outside = keys.filter((k) => !input.allowed.has(k));
  if (outside.length)
    throw new ValidationError(
      `Esta vista no deja cambiar ${outside.map((k) => `«${k}»`).join(', ')}.`,
    );
  const computed = input.tracker.fields.filter(
    (f) => keys.includes(f.key) && (f.formula || (f.lookup && !f.lookup.editable)),
  );
  if (computed.length)
    throw new ValidationError(
      `${computed.map((f) => `«${f.label}»`).join(', ')} se llena${computed.length > 1 ? 'n' : ''} sola${computed.length > 1 ? 's' : ''}: no se cambia a mano.`,
    );

  const { data: current, error: readError } = await db
    .from('tracker_rows')
    .select('id, values, external_key')
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
  // Las reglas se juzgan sólo en lo que se cambia (`only`): una fila vieja con un
  // valor que hoy no cumple no puede bloquear la edición de otra celda.
  const values = await prepareValues(
    db,
    input.tracker,
    { ...known, ...input.patch },
    {
      selfId: input.rowId,
      only: new Set(keys),
      allowedRelationTrackers:
        input.actor && input.actorKind !== 'app_user' ? undefined : new Set(trackersOf(view.spec)),
    },
  );
  // Flujo por estados: el salto de estado se juzga aquí, con el rol de quien escribe.
  Object.assign(
    values,
    guardFlowWrite(
      input.tracker,
      before,
      values,
      currentFlowActor(input.actor ? UNSCOPED_ACTOR : ANONYMOUS_ACTOR),
    ),
  );
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys)
    if (before[k] !== values[k]) changes[k] = { from: before[k] ?? null, to: values[k] ?? null };
  const label = rowLabel(input.tracker.fields, values);
  if (!Object.keys(changes).length) return { label, changes, duplicate: null };
  // Un campo que viene de una integración no se cambia desde una vista (0237).
  assertRowWriteAllowed(input.tracker, {
    before,
    after: values,
    keys: Object.keys(changes),
    externalKey: (current as { external_key?: string | null }).external_key ?? null,
  });

  let upd = db
    .from('tracker_rows')
    .update({ values, label, updated_at: new Date().toISOString() })
    .eq('id', input.rowId)
    .eq('tracker_id', input.tracker.id);
  if (input.guard) {
    upd = upd.or(`values->>${input.guard.unset}.is.null,values->>${input.guard.unset}.eq.`);
    if (input.guard.statusIs)
      upd = upd.eq(`values->>${input.guard.statusIs.field}`, input.guard.statusIs.value);
  }
  const { data: written, error } = await upd.select('id');
  if (error) throw error;
  if (input.guard && !(written ?? []).length) throw new ClaimLostError();
  // Cambiar la guía o su fecha puede crear o resolver un conflicto de duplicados;
  // se revisa la guía de antes y la de ahora.
  const dupRule = await getDuplicateRule(db, input.tracker.id);
  let duplicate: string | null = null;
  if (dupRule) {
    const outcome = await applyDuplicateRule(db, input.tracker.id, [before, values]);
    duplicate = duplicateMessage(
      dupRule.rule,
      dupRule.fields,
      outcome.conflicts.find((c) => c.rowId === input.rowId),
    );
  }
  await db.from('custom_view_events').insert({
    view_id: view.id,
    block_id: input.blockId,
    kind: input.kind,
    action_id: input.actionId ?? null,
    tracker_row_id: input.rowId,
    changes,
    actor: input.actor,
    actor_kind: input.actorKind ?? 'member',
  });
  // Automatizaciones (0210): la fila cambió y, si fue Aprobar/Rechazar, se decidió.
  if (await watchesTracker(db, input.tracker.id)) {
    const common = {
      trackerId: input.tracker.id,
      trackerSlug: input.tracker.slug,
      rowId: input.rowId,
      before: before as Record<string, string | number>,
      after: values as Record<string, string | number>,
      label,
      version: new Date().toISOString(),
      actor: { kind: input.actorKind ?? ('member' as const), id: input.actor },
      viewId: view.id,
      blockId: input.blockId,
    };
    await emitAutomationEvent(db, { ...common, kind: 'row_updated' });
    if (input.actionId === APPROVE_ACTION_ID || input.actionId === REJECT_ACTION_ID)
      await emitAutomationEvent(db, {
        ...common,
        kind: 'approval_decided',
        decision: input.actionId === APPROVE_ACTION_ID ? 'approved' : 'rejected',
        reason: input.reason ?? undefined,
      });
  }
  return { label, changes, duplicate };
}

/** Los bloques cuyas filas se tocan: celdas, tarjetas, fichas, eventos. */
const ROW_BLOCKS: ReadonlySet<string> = new Set([
  'table',
  'sheet',
  'board',
  'zones',
  'gallery',
  'calendar',
  'cards',
  'map',
  'detail',
]);

/** Editar una celda de una tabla, mover una tarjeta o cambiar un campo desde la ficha. */
export async function editViewRow(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    rowId: string;
    patch: Record<string, unknown>;
    actor: string | null;
    actorKind?: ActorKind;
  },
): Promise<{ label: string; duplicate: string | null }> {
  if (!canWriteView(view, input.actor ? 'member' : 'public'))
    throw new ValidationError('Esta vista no se puede editar.');
  const block = findWriteBlock(view.spec, input.blockId);
  if (!block || !ROW_BLOCKS.has(block.type) || !('tracker' in block))
    throw new NotFoundError('Ese bloque no está en esta vista.');
  // La lista blanca es la del bloque: celdas editables, el campo que se
  // arrastra y los campos que la ficha deja editar (`recordEditable`). La
  // misma función que el cálculo usa para decir qué se edita en pantalla.
  const allowed = new Set(blockWriteFields(block));
  if (!allowed.size && block.type !== 'detail' && block.type !== 'cards')
    throw new ValidationError('Este bloque no se edita.');
  if (!input.actor) await assertPublicBudget(db, view.id);
  const tracker = await trackerForBlock(db, block.tracker);
  // Flujo por estados: el detalle y las tarjetas dejan pasar de estado (con lo que ese
  // estado pide); el servidor juzga el salto y el rol en `patchRow`.
  const flow = flowOf(tracker.fields);
  if (flow && (block.type === 'detail' || block.type === 'cards')) {
    allowed.add(flow.field.key);
    for (const reqs of Object.values(flow.flow.requirements))
      for (const r of reqs) allowed.add(r.field);
  }
  if (!allowed.size) throw new ValidationError('Este bloque no se edita.');
  const { label, duplicate } = await patchRow(db, view, {
    blockId: block.id,
    tracker,
    rowId: input.rowId,
    patch: input.patch,
    allowed,
    kind:
      block.type === 'board' || block.type === 'zones'
        ? Object.keys(input.patch).every((k) => k === block.groupBy)
          ? 'move'
          : 'edit'
        : 'edit',
    actor: input.actor,
    actorKind: input.actorKind,
  });
  return { label, duplicate };
}


// ---------------------------------------------------------------------------
// Pegar en la hoja
// ---------------------------------------------------------------------------

export const SHEET_PASTE_MAX_ROWS = 500;

/** Las claves con que se compara un NIT (ver `sheet-edit.ts`); exportada para probarla. */
export { nitKeys };

export interface SheetPasteLine {
  /** Posición (1-based) en lo pegado. */
  line: number;
  action: 'create' | 'update' | 'same' | 'error';
  /** Cómo se llama la fila (la clave o el nombre). */
  label: string;
  /** Campos que cambian en un `update` (rótulos). */
  changed?: string[];
  error?: string;
}

export interface SheetPasteResult {
  applied: boolean;
  lines: SheetPasteLine[];
  created: number;
  updated: number;
  same: number;
  errors: number;
}

const foldKey = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Pegar filas desde Excel / Sheets en una hoja. `apply: false` sólo valida y
 * dice qué haría cada fila (crear, actualizar, igual, error); `apply: true` lo
 * hace. IDEMPOTENTE: con `pasteKey` la fila que ya existe se actualiza (o queda
 * igual si nada cambia); sin clave, una fila idéntica a una existente no se
 * duplica. Los campos permitidos son los `editable` de la hoja y pasan por el
 * mismo `prepareValues` que cualquier escritura (tipos, reglas, relaciones,
 * lookups, fórmulas, campos con origen). `create` / `update` los decide quien
 * llama según el rol; `forced` pone valores del servidor (el scope de una app).
 */
export async function pasteViewRows(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    rows: Array<Record<string, string>>;
    apply: boolean;
    actor: string | null;
    actorKind?: ActorKind;
    create: boolean;
    update: boolean;
    forced?: Record<string, string>;
    /** Duplicar o escribir en la fila fantasma: una fila igual a otra SÍ se crea (sin clave no se compara). */
    fresh?: boolean;
  },
): Promise<SheetPasteResult> {
  if (!canWriteView(view, input.actor ? 'member' : 'public'))
    throw new ValidationError('Esta vista no se puede editar.');
  const block = findWriteBlock(view.spec, input.blockId);
  if (!block || block.type !== 'sheet')
    throw new NotFoundError('Esa hoja no está en esta vista.');
  if (!block.paste && !block.addRow) throw new ValidationError('Esta hoja no recibe filas.');
  if (!input.rows.length) throw new ValidationError('No hay filas que pegar.');
  if (input.rows.length > SHEET_PASTE_MAX_ROWS)
    throw new ValidationError(`Pega hasta ${SHEET_PASTE_MAX_ROWS} filas por vez.`);
  if (!input.actor) await assertPublicBudget(db, view.id);
  const tracker = await trackerForBlock(db, block.tracker);
  const allowed = new Set(block.editable);
  const fieldOf = (k: string) => tracker.fields.find((f) => f.key === k);
  const makerBlocked = creatingOrigin(tracker) ? true : false;

  // Filas que ya existen (para actualizar sin duplicar).
  const { data: existingData, error: exErr } = await db
    .from('tracker_rows')
    .select('id, label, values, external_key')
    .eq('tracker_id', tracker.id)
    .limit(5000);
  if (exErr) throw exErr;
  const existing = (existingData ?? []) as Array<{
    id: string;
    label: string;
    values: Record<string, string | number>;
    external_key: string | null;
  }>;
  const keyField = block.pasteKey ? fieldOf(block.pasteKey) : undefined;
  const keyOf = (values: Record<string, unknown>): string => {
    if (!keyField) return '';
    const raw = values[keyField.key];
    return keyField.type === 'relation'
      ? foldKey(displayTrackerValue({ type: 'relation' }, raw))
      : foldKey(raw);
  };
  const byKey = new Map<string, (typeof existing)[number]>();
  if (keyField) for (const r of existing) if (keyOf(r.values)) byKey.set(keyOf(r.values), r);

  // Relaciones por nombre: «Cliente X» → la fila de la tabla relacionada. Si la tabla
  // destino tiene un campo `nit`, el NIT (con o sin puntos y dígito de verificación)
  // sirve como clave alternativa.
  const relations = new Map<string, Map<string, Array<{ id: string; label: string }>>>();
  const relationNits = new Map<string, Map<string, Array<{ id: string; label: string }>>>();
  for (const f of tracker.fields) {
    if (f.type !== 'relation' || !f.tracker || !allowed.has(f.key)) continue;
    const touched = input.rows.some((r) => (r[f.key] ?? '') !== '');
    if (!touched) continue;
    const other = await getTrackerBySlug(db, f.tracker);
    if (!other) continue;
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label, values')
      .eq('tracker_id', other.id)
      .limit(5000);
    if (error) throw error;
    const idx = new Map<string, Array<{ id: string; label: string }>>();
    const nitIdx = new Map<string, Array<{ id: string; label: string }>>();
    const hasNit = other.fields.some((x) => x.key === 'nit');
    for (const r of (data ?? []) as Array<{
      id: string;
      label: string;
      values?: Record<string, unknown>;
    }>) {
      const k = foldKey(r.label);
      idx.set(k, [...(idx.get(k) ?? []), { id: r.id, label: r.label }]);
      if (hasNit)
        for (const nk of nitKeys(r.values?.nit))
          nitIdx.set(nk, [...(nitIdx.get(nk) ?? []), { id: r.id, label: r.label }]);
    }
    relations.set(f.key, idx);
    if (hasNit) relationNits.set(f.key, nitIdx);
  }

  const lines: SheetPasteLine[] = [];
  const seenKeys = new Set<string>();
  const plan: Array<
    | { kind: 'create'; line: number; values: Record<string, string | number>; label: string }
    | {
        kind: 'update';
        line: number;
        rowId: string;
        patch: Record<string, string | number>;
        label: string;
      }
  > = [];
  const actor = currentFlowActor(input.actor ? UNSCOPED_ACTOR : ANONYMOUS_ACTOR);

  for (const [i, raw] of input.rows.entries()) {
    const line = i + 1;
    const fail = (error: string, label = ''): void => {
      lines.push({ line, action: 'error', label: label || `Fila ${line}`, error });
    };
    const keys = Object.keys(raw).filter((k) => (raw[k] ?? '') !== '');
    const outside = keys.filter((k) => !allowed.has(k));
    if (outside.length) {
      fail(`Esta hoja no deja escribir ${outside.map((k) => `«${k}»`).join(', ')}.`);
      continue;
    }
    if (!keys.length) {
      fail('La fila está vacía.');
      continue;
    }
    // Relaciones por nombre → {id,label}.
    const given: Record<string, string> = {};
    let bad: string | null = null;
    for (const k of keys) {
      const f = fieldOf(k);
      let v = String(raw[k]);
      if (f?.type === 'relation' && !/^\s*[{[]/.test(v) && !/^[0-9a-f-]{36}$/i.test(v.trim())) {
        let hits = relations.get(k)?.get(foldKey(v)) ?? [];
        if (!hits.length) {
          const nk = nitKeys(v)[0];
          const byNit = nk ? (relationNits.get(k)?.get(nk) ?? []) : [];
          // Varias filas con el mismo NIT son la misma empresa: sólo vale si es una.
          if (byNit.length) hits = byNit;
        }
        if (hits.length !== 1) {
          bad = hits.length
            ? `«${f.label}»: «${v}» está más de una vez; escribe el nombre completo.`
            : `«${f.label}»: «${v}» no está en la lista de ${f.tracker}.`;
          break;
        }
        v = JSON.stringify({ id: (hits[0] as { id: string }).id, label: (hits[0] as { label: string }).label });
      }
      given[k] = v;
    }
    if (bad) {
      fail(bad);
      continue;
    }
    const k0 = keyField ? foldKey(keyField.type === 'relation' ? displayTrackerValue({ type: 'relation' }, given[keyField.key]) : given[keyField.key]) : '';
    if (keyField && k0) {
      if (seenKeys.has(k0)) {
        fail(`«${keyField.label}» repetida en lo pegado.`, String(raw[keyField.key] ?? ''));
        continue;
      }
      seenKeys.add(k0);
    }
    const match = keyField && k0 ? byKey.get(k0) : undefined;
    try {
      if (match) {
        if (!input.update) throw new ValidationError('Tu rol no edita filas que ya existen.');
        const prepared = await prepareValues(
          db,
          tracker,
          { ...match.values, ...given },
          { selfId: match.id, only: new Set(keys) },
        );
        const changedKeys = keys.filter(
          (k) => String(prepared[k] ?? '') !== String(match.values[k] ?? ''),
        );
        const label = match.label || String(raw[keyField?.key ?? ''] ?? '');
        if (!changedKeys.length) {
          lines.push({ line, action: 'same', label });
          continue;
        }
        const patch = Object.fromEntries(changedKeys.map((k) => [k, given[k] as string]));
        lines.push({
          line,
          action: 'update',
          label,
          changed: changedKeys.map((k) => fieldOf(k)?.label ?? k),
        });
        plan.push({ kind: 'update', line, rowId: match.id, patch, label });
        continue;
      }
      if (!input.create) throw new ValidationError('Tu rol no agrega filas nuevas.');
      if (makerBlocked)
        throw new ValidationError(
          'Esta tabla se llena sola desde una integración y no recibe filas a mano.',
        );
      const values = await prepareValues(
        db,
        tracker,
        { ...given, ...(input.forced ?? {}) },
        { applyDefaults: true, viewer: null },
      );
      Object.assign(values, guardFlowWrite(tracker, null, values, actor));
      // Sin clave: una fila idéntica a una que ya existe no se duplica.
      if (!keyField && !input.fresh) {
        const dup = existing.find((r) =>
          keys.every((k) => String(r.values[k] ?? '') === String(values[k] ?? '')),
        );
        if (dup) {
          lines.push({ line, action: 'same', label: dup.label });
          continue;
        }
      }
      const label = rowLabel(tracker.fields, values);
      lines.push({ line, action: 'create', label });
      plan.push({ kind: 'create', line, values, label });
    } catch (err) {
      if (err instanceof ValidationError) fail(err.message);
      else throw err;
    }
  }

  const count = (a: SheetPasteLine['action']) => lines.filter((l) => l.action === a).length;
  const result: SheetPasteResult = {
    applied: false,
    lines,
    created: count('create'),
    updated: count('update'),
    same: count('same'),
    errors: count('error'),
  };
  // Con errores no se aplica nada a medias: se corrige y se pega de nuevo.
  if (!input.apply || result.errors > 0 || !plan.length) return result;

  const byApp = input.actorKind === 'app_user';
  for (const step of plan) {
    try {
      if (step.kind === 'update') {
        await patchRow(db, view, {
          blockId: block.id,
          tracker,
          rowId: step.rowId,
          patch: step.patch,
          allowed,
          kind: 'edit',
          actor: input.actor,
          actorKind: input.actorKind,
        });
      } else {
        const { data: row, error } = await db
          .from('tracker_rows')
          .insert({
            tracker_id: tracker.id,
            label: step.label,
            values: step.values,
            created_by: byApp ? null : input.actor,
            ...(byApp ? { created_by_app_user: input.actor } : {}),
          })
          .select('id')
          .single();
        if (error) throw error;
        const rowId = String((row as { id: string }).id);
        const rule = await getDuplicateRule(db, tracker.id);
        if (rule) await applyDuplicateRule(db, tracker.id, [step.values]);
        if (await watchesTracker(db, tracker.id))
          await emitAutomationEvent(db, {
            kind: 'row_created',
            trackerId: tracker.id,
            trackerSlug: tracker.slug,
            rowId,
            after: step.values as Record<string, string | number>,
            label: step.label,
            version: new Date().toISOString(),
            actor: { kind: byApp ? ('app_user' as const) : ('member' as const), id: input.actor },
            viewId: view.id,
            blockId: block.id,
          });
      }
    } catch (err) {
      // Lo ya escrito queda (cada fila es independiente); se dice cuál falló.
      const l = lines.find((x) => x.line === step.line);
      if (l) {
        l.action = 'error';
        l.error = err instanceof Error ? err.message : 'No se pudo guardar.';
      }
      result.errors += 1;
    }
  }
  result.applied = true;
  result.created = count('create');
  result.updated = count('update');
  return result;
}

/**
 * Devuelve campos de una fila a su valor de antes («Deshacer este cambio» del
 * historial). La lista blanca es la de los campos que se devuelven (el rol ya
 * se comprobó en la capa de apps): lo demás —reglas del campo, flujo por
 * estados, duplicados, automatizaciones— pasa igual que en cualquier edición, y
 * queda registrado como un cambio hecho al deshacer (`__undo`).
 */
export async function undoViewRowChange(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    rowId: string;
    patch: Record<string, string | number>;
    actor: string;
    actorKind?: ActorKind;
  },
): Promise<{ label: string; duplicate: string | null }> {
  const block = findWriteBlock(view.spec, input.blockId);
  if (!block || !('tracker' in block)) throw new NotFoundError('Ese bloque no está en esta vista.');
  const tracker = await trackerForBlock(db, block.tracker);
  const { label, duplicate } = await patchRow(db, view, {
    blockId: block.id,
    tracker,
    rowId: input.rowId,
    patch: input.patch,
    allowed: new Set(Object.keys(input.patch)),
    kind: 'edit',
    actionId: UNDO_ACTION_ID,
    actor: input.actor,
    actorKind: input.actorKind,
  });
  return { label, duplicate };
}

export type ViewActionOutcome =
  | { kind: 'set_field'; label: string; message: string }
  | { kind: 'notify'; label: string; message: string; actionLabel: string }
  | {
      kind: 'assign';
      label: string;
      message: string;
      rowId: string;
      /** La pantalla que abre el aviso a la persona (del botón), o null = la app. */
      screen: string | null;
    }
  | {
      kind: 'claim';
      label: string;
      message: string;
      rowId: string;
      /** True si ya era suya: tocar de nuevo no cambia nada. */
      already: boolean;
    };

/** La persona a quien se asigna: ya resuelta y comprobada por la capa de apps. */
export interface AssignedPerson {
  id: string;
  name: string;
}

/**
 * Un botón de fila. `set_field` escribe el valor que dice el SPEC (nunca uno
 * que mande el navegador); `notify` no escribe nada en la tabla y devuelve lo
 * necesario para que la capa web mande los avisos de campana.
 */
export async function runViewAction(
  db: SupabaseClient,
  view: CustomViewRow,
  input: {
    blockId: string;
    actionId: string;
    rowId: string;
    actor: string | null;
    actorKind?: ActorKind;
    /** Motivo opcional de un rechazo (Aprobar / Rechazar). */
    reason?: string | null;
    /** Sólo en un botón «Asignar a…» (kind `assign`): a quién. */
    person?: AssignedPerson | null;
  },
): Promise<ViewActionOutcome> {
  if (!canWriteView(view, input.actor ? 'member' : 'public'))
    throw new ValidationError('Los botones de esta vista no están activos.');
  const block = findWriteBlock(view.spec, input.blockId);
  if (!block || !ROW_BLOCKS.has(block.type) || !('actions' in block) || !('tracker' in block))
    throw new NotFoundError('Ese bloque no está en esta vista.');
  if (input.actionId === APPROVE_ACTION_ID || input.actionId === REJECT_ACTION_ID) {
    const found = approvalFor(view.spec, block.tracker);
    if (!found) throw new NotFoundError('Esta tabla no tiene aprobación en esta vista.');
    if (!input.actor) await assertPublicBudget(db, view.id);
    const tracker = await trackerForBlock(db, block.tracker);
    const { data: cur, error: curError } = await db
      .from('tracker_rows')
      .select('values')
      .eq('id', input.rowId)
      .eq('tracker_id', tracker.id)
      .maybeSingle();
    if (curError) throw curError;
    if (!cur) throw new NotFoundError('Esa fila ya no está en la tabla.');
    if (!isPendingReview(found.approval, (cur as { values: Record<string, unknown> }).values))
      throw new ValidationError('Esa fila ya fue revisada.');
    const approve = input.actionId === APPROVE_ACTION_ID;
    const patch = reviewPatch(found.approval, approve ? 'approve' : 'reject', input.reason);
    const { label } = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId: input.rowId,
      patch,
      allowed: new Set(Object.keys(patch)),
      kind: 'action',
      actionId: input.actionId,
      actor: input.actor,
      actorKind: input.actorKind,
      reason: input.reason,
    });
    return {
      kind: 'set_field',
      label,
      message: `${approve ? 'Aprobado' : 'Rechazado'}: «${label}».`,
    };
  }
  const action = block.actions.find((a) => a.id === input.actionId);
  if (!action) throw new NotFoundError('Ese botón ya no está en la vista.');
  if (!input.actor) await assertPublicBudget(db, view.id);

  if (action.kind === 'claim' && action.field && action.nameField) {
    if (!input.person) throw new ValidationError('No se sabe quién toca el botón.');
    return claimRow(db, view, block, action, input.rowId, input.person, input.actor, input.actorKind);
  }

  if (action.kind === 'assign' && action.field) {
    if (!input.person) throw new ValidationError('Elige a quién asignar.');
    const tracker = await trackerForBlock(db, block.tracker);
    const patch: Record<string, unknown> = { [action.field]: input.person.id };
    if (action.nameField) patch[action.nameField] = input.person.name;
    if (action.statusField && action.value !== undefined) patch[action.statusField] = action.value;
    const { label } = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId: input.rowId,
      patch,
      allowed: new Set(Object.keys(patch)),
      kind: 'action',
      actionId: action.id,
      actor: input.actor,
      actorKind: input.actorKind,
    });
    return {
      kind: 'assign',
      label,
      rowId: input.rowId,
      screen: action.screen ?? null,
      message: `Listo: «${label}» quedó asignada a ${input.person.name}.`,
    };
  }

  if (action.kind === 'set_field' && action.field && action.value !== undefined) {
    const tracker = await trackerForBlock(db, block.tracker);
    if (action.requireFields?.length) {
      const { data: cur, error: curError } = await db
        .from('tracker_rows')
        .select('values')
        .eq('id', input.rowId)
        .eq('tracker_id', tracker.id)
        .maybeSingle();
      if (curError) throw curError;
      if (!cur) throw new NotFoundError('Esa fila ya no está en la tabla.');
      const values = (cur as { values: Record<string, unknown> }).values ?? {};
      const missing = action.requireFields.filter((k) => {
        const v = values[k];
        return v === undefined || v === null || String(v).trim() === '';
      });
      if (missing.length) {
        const names = missing.map((k) => tracker.fields.find((f) => f.key === k)?.label ?? k);
        throw new ValidationError(`Antes de «${action.label}» completa: ${names.join(', ')}.`);
      }
    }
    const { label } = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId: input.rowId,
      patch: { [action.field]: action.value },
      allowed: new Set([action.field]),
      kind: 'action',
      actionId: action.id,
      actor: input.actor,
      actorKind: input.actorKind,
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
    actor_kind: input.actorKind ?? 'member',
  });
  return {
    kind: 'notify',
    label,
    actionLabel: action.label,
    message: 'Listo, avisamos al equipo.',
  };
}

/**
 * «TOMAR»: quien toca se queda con la fila si todavía es de nadie. ATÓMICO: la
 * escritura es un solo UPDATE condicionado a que el campo siga vacío (y el estado
 * sea el pedido), así que dos que la toquen a la vez dejan UN ganador; el otro lee
 * quién la tiene. IDEMPOTENTE: quien ya la tiene la toca de nuevo y no pasa nada.
 * La identidad sale de la sesión (`person`), nunca de lo que mande el navegador.
 */
async function claimRow(
  db: SupabaseClient,
  view: CustomViewRow,
  block: { id: string; tracker: string },
  action: RowAction,
  rowId: string,
  person: AssignedPerson,
  actor: string | null,
  actorKind?: ActorKind,
): Promise<ViewActionOutcome> {
  const field = action.field as string;
  const nameField = action.nameField as string;
  const tracker = await trackerForBlock(db, block.tracker);
  const read = async () => {
    const { data, error } = await db
      .from('tracker_rows')
      .select('values, label')
      .eq('id', rowId)
      .eq('tracker_id', tracker.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('Esa fila ya no está en la tabla.');
    return data as { values: Record<string, unknown>; label: string };
  };
  const judge = (cur: { values: Record<string, unknown>; label: string }) => {
    const holder = String(cur.values[field] ?? '').trim();
    if (holder === person.id)
      return {
        kind: 'claim',
        label: cur.label,
        rowId,
        already: true,
        message: `«${cur.label}» ya es tuya.`,
      } as const;
    if (holder)
      throw new ValidationError(
        `Ya la tomó ${String(cur.values[nameField] ?? '').trim() || 'otra persona'}.`,
      );
    if (
      action.statusField &&
      action.when !== undefined &&
      String(cur.values[action.statusField] ?? '') !== action.when
    )
      throw new ValidationError(
        `Ya no se puede tomar: está en «${String(cur.values[action.statusField] ?? '—')}».`,
      );
    return null;
  };
  const first = judge(await read());
  if (first) return first;
  const patch: Record<string, unknown> = { [field]: person.id, [nameField]: person.name };
  if (action.statusField && action.value !== undefined) patch[action.statusField] = action.value;
  if (action.dateField || action.timeField) {
    const now = new Date();
    if (action.dateField) patch[action.dateField] = bogotaToday(now);
    if (action.timeField)
      patch[action.timeField] = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Bogota',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now);
  }
  try {
    const { label } = await patchRow(db, view, {
      blockId: block.id,
      tracker,
      rowId,
      patch,
      allowed: new Set(Object.keys(patch)),
      kind: 'action',
      actionId: action.id,
      actor,
      actorKind,
      guard: {
        unset: field,
        statusIs:
          action.statusField && action.when !== undefined
            ? { field: action.statusField, value: action.when }
            : undefined,
      },
    });
    return {
      kind: 'claim',
      label,
      rowId,
      already: false,
      message: `Listo: «${label}» es tuya.`,
    };
  } catch (err) {
    if (!(err instanceof ClaimLostError)) throw err;
    // Perdió la carrera: se lee quién ganó (si fue ella misma por un doble toque, es idempotente).
    const again = judge(await read());
    if (again) return again;
    throw new ValidationError('Ya la tomó otra persona.');
  }
}

export interface NewTaskInput {
  blockId: string;
  person: AssignedPerson;
  title: string;
  description?: string | null;
  due?: string | null;
  dueTime?: string | null;
  priority?: string | null;
  /** «lat,lng» del lugar de la tarea, si se eligió. */
  location?: string | null;
  actor: string;
  actorKind?: ActorKind;
  viewer?: string | null;
}

/**
 * «Asignar tarea» desde el mapa: una fila NUEVA en la tabla del bloque, con los
 * campos que el `assign` del bloque nombra (nada más) y el estado inicial. Pasa
 * por el esquema de la tabla como cualquier fila, así que las opciones, las
 * fechas y los obligatorios se validan igual. Quién puede asignar lo decide la
 * capa de apps (`assignTaskFromMap`) ANTES de llegar aquí.
 */
export async function createViewTask(
  db: SupabaseClient,
  view: CustomViewRow,
  input: NewTaskInput,
): Promise<{ rowId: string; label: string; screen: string | null }> {
  if (!canWriteView(view, 'member'))
    throw new ValidationError('Las tareas de esta vista no están activas (editing en "off").');
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  if (!block || block.type !== 'map' || !block.assign)
    throw new NotFoundError('Ese mapa no asigna tareas.');
  const a = block.assign;
  const title = input.title.trim();
  if (!title) throw new ValidationError('Escribe qué hay que hacer.');
  const tracker = await trackerForBlock(db, block.tracker);
  assertRowWriteAllowed(tracker, { creating: true, after: {} });
  const raw: Record<string, unknown> = {
    [a.titleField]: title.slice(0, 400),
    [a.assigneeField]: input.person.id,
  };
  if (a.nameField) raw[a.nameField] = input.person.name;
  if (a.descriptionField && input.description?.trim())
    raw[a.descriptionField] = input.description.trim().slice(0, 4000);
  if (a.dueField && input.due) raw[a.dueField] = input.due;
  if (a.dueTimeField && input.dueTime) raw[a.dueTimeField] = input.dueTime;
  if (a.priorityField && input.priority) raw[a.priorityField] = input.priority;
  if (input.location) raw[block.locationField] = input.location;
  if (a.statusField && a.pendingValue) raw[a.statusField] = a.pendingValue;
  const values = await prepareValues(db, tracker, raw, {
    applyDefaults: true,
    viewer: input.viewer,
    allowedRelationTrackers: new Set(trackersOf(view.spec)),
  });
  const byApp = input.actorKind === 'app_user';
  const { data: row, error } = await db
    .from('tracker_rows')
    .insert({
      tracker_id: tracker.id,
      label: rowLabel(tracker.fields, values),
      values,
      created_by: byApp ? null : input.actor,
      ...(byApp ? { created_by_app_user: input.actor } : {}),
    })
    .select('id')
    .single();
  if (error) throw error;
  const rowId = String((row as { id: string }).id);
  const label = rowLabel(tracker.fields, values);
  if (await watchesTracker(db, tracker.id))
    await emitAutomationEvent(db, {
      kind: 'row_created',
      trackerId: tracker.id,
      trackerSlug: tracker.slug,
      rowId,
      after: values as Record<string, string | number>,
      label,
      version: new Date().toISOString(),
      actor: { kind: byApp ? 'app_user' : 'member', id: input.actor },
      viewId: view.id,
      blockId: block.id,
    });
  return { rowId, label, screen: a.screen ?? null };
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
