import type { SupabaseClient } from '@supabase/supabase-js';
import type { ViewSpec } from '../../views/spec';
import { type AppPermissions, parsePermissions } from '../permissions';
import {
  listRoles,
  listScreens,
  loadPublishedSnapshot,
  screenViews,
} from '../store';
import { type NoticeAppModel, type NoticeScreenModel, trackersInApp } from './interest';
import type { NoticePerson, NoticeTracker, PlannedNotice } from './plan';
import {
  BURST_ROW_CAP,
  BURST_WINDOW_MS,
  type BurstMode,
  DEFAULT_PREFS,
  type InboxNotice,
  type NoticeConfig,
  type AppNoticeKind,
  type NoticePersonKind,
  type NoticePrefs,
  type PersonKey,
  burstMode,
  isMuted,
  parseNoticeConfig,
  parsePrefs,
  personKey,
} from './shape';

/**
 * LA BASE DE LOS AVISOS AUTOMÁTICOS (0231): la bandeja por persona, las
 * preferencias, lo configurado por app y el modelo de la app que el
 * planificador cruza con cada cambio de fila. Todo con el cliente acotado a la
 * empresa (`organization_id` lo pone el cliente, como en el resto de las apps).
 */

const MAX_APPS_PER_TRACKER = 20;
const MODEL_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Tabla y modelos de app (con memoria de 30 s: una escritura de fila no puede
// pagar 10 consultas)
// ---------------------------------------------------------------------------

const trackerCache = new Map<string, { at: number; value: NoticeTracker | null }>();
const modelCache = new Map<string, { at: number; value: NoticeAppModel[] }>();

/** Olvida lo recordado (al cambiar la configuración en este proceso y en las pruebas). */
export function forgetNoticeModels(): void {
  trackerCache.clear();
  modelCache.clear();
}

export async function loadNoticeTracker(
  db: SupabaseClient,
  trackerId: string,
  now = Date.now(),
): Promise<NoticeTracker | null> {
  const hit = trackerCache.get(trackerId);
  if (hit && now - hit.at < MODEL_TTL_MS) return hit.value;
  const { data, error } = await db
    .from('trackers')
    .select('id, slug, name, fields')
    .eq('id', trackerId)
    .maybeSingle();
  if (error) return null;
  const row = data as { id: string; slug: string; name: string; fields: unknown } | null;
  const value: NoticeTracker | null = row
    ? {
        id: row.id,
        slug: row.slug,
        name: row.name,
        fields: Array.isArray(row.fields)
          ? (row.fields as NoticeTracker['fields']).map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type,
              ...(f.options ? { options: f.options } : {}),
            }))
          : [],
      }
    : null;
  trackerCache.set(trackerId, { at: now, value });
  return value;
}

export async function getNoticeConfig(db: SupabaseClient, appId: string): Promise<NoticeConfig> {
  const { data } = await db
    .from('custom_app_notice_config')
    .select('config')
    .eq('app_id', appId)
    .maybeSingle();
  return parseNoticeConfig((data as { config?: unknown } | null)?.config);
}

export async function saveNoticeConfig(
  db: SupabaseClient,
  appId: string,
  config: NoticeConfig,
  userId: string | null,
): Promise<void> {
  const { error } = await db.from('custom_app_notice_config').upsert(
    {
      app_id: appId,
      config,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'app_id' },
  );
  if (error) throw error;
  forgetNoticeModels();
}

/**
 * El modelo de UNA app tal como lo ven sus usuarios: la versión publicada
 * (pantallas con su spec y roles) o, en apps anteriores a las versiones, lo vivo.
 */
export async function loadNoticeAppModel(
  db: SupabaseClient,
  app: { id: string; slug: string; name: string },
  options: { live?: boolean } = {},
): Promise<NoticeAppModel> {
  const [published, config] = await Promise.all([
    options.live ? Promise.resolve(null) : loadPublishedSnapshot(db, app.id),
    getNoticeConfig(db, app.id),
  ]);
  if (published) {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      screens: published.snapshot.screens.map((s) => ({
        slug: s.slug,
        title: s.title,
        roles: s.roles,
        spec: s.spec,
      })),
      roles: published.snapshot.roles.map((r) => ({
        key: r.key,
        name: r.name,
        permissions: r.permissions,
      })),
      config,
    };
  }
  const [roles, screens] = await Promise.all([listRoles(db, app.id), listScreens(db, app.id)]);
  const views = await screenViews(db, screens);
  const live: NoticeScreenModel[] = screens.flatMap((s) => {
    const view = views.get(s.view_id);
    return view
      ? [{ slug: s.slug, title: s.title, roles: s.roles, spec: view.spec as ViewSpec }]
      : [];
  });
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    screens: live,
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      permissions: parsePermissions(r.permissions) as AppPermissions,
    })),
    config,
  };
}

/** Las apps publicadas cuyas pantallas usan esta tabla. Recordado 30 s por tabla. */
export async function noticeModelsForTracker(
  db: SupabaseClient,
  tracker: NoticeTracker,
  now = Date.now(),
): Promise<NoticeAppModel[]> {
  const hit = modelCache.get(tracker.id);
  if (hit && now - hit.at < MODEL_TTL_MS) return hit.value;
  let value: NoticeAppModel[] = [];
  try {
    const { data, error } = await db
      .from('custom_apps')
      .select('id, slug, name')
      .eq('status', 'published')
      .is('archived_at', null)
      .limit(MAX_APPS_PER_TRACKER);
    if (!error) {
      const apps = (data ?? []) as Array<{ id: string; slug: string; name: string }>;
      const models = await Promise.all(apps.map((a) => loadNoticeAppModel(db, a).catch(() => null)));
      value = models.filter(
        (m): m is NoticeAppModel => m !== null && trackersInApp(m).includes(tracker.slug),
      );
    }
  } catch {
    value = [];
  }
  modelCache.set(tracker.id, { at: now, value });
  return value;
}

// ---------------------------------------------------------------------------
// Personas y preferencias
// ---------------------------------------------------------------------------

/** Quién está en la app: miembros de Cortex con rol y usuarios externos activos. */
export async function loadNoticePeople(
  db: SupabaseClient,
  appId: string,
): Promise<NoticePerson[]> {
  const [members, externals] = await Promise.all([
    db.from('custom_app_members').select('user_id, role_key, attributes').eq('app_id', appId),
    db
      .from('custom_app_users')
      .select('id, name, email, role_key, attributes, status')
      .eq('app_id', appId)
      .neq('status', 'disabled'),
  ]);
  const memberRows = (members.data ?? []) as Array<{
    user_id: string;
    role_key: string;
    attributes: Record<string, string> | null;
  }>;
  const names = new Map<string, { name: string | null; email: string }>();
  if (memberRows.length) {
    const { data } = await db
      .from('users')
      .select('id, name, email')
      .in(
        'id',
        memberRows.map((m) => m.user_id),
      );
    for (const u of (data ?? []) as Array<{ id: string; name: string | null; email: string }>)
      names.set(u.id, u);
  }
  const out: NoticePerson[] = [];
  for (const m of memberRows) {
    const u = names.get(m.user_id);
    out.push({
      kind: 'member',
      id: m.user_id,
      name: u?.name || u?.email || 'Alguien del equipo',
      email: u?.email ?? null,
      roleKey: m.role_key,
      attributes: m.attributes ?? {},
    });
  }
  for (const u of (externals.data ?? []) as Array<{
    id: string;
    name: string;
    email: string;
    role_key: string;
    attributes: Record<string, string> | null;
  }>)
    out.push({
      kind: 'app_user',
      id: u.id,
      name: u.name,
      email: u.email,
      roleKey: u.role_key,
      attributes: u.attributes ?? {},
    });
  return out;
}

export async function loadNoticePrefs(
  db: SupabaseClient,
  appId: string,
): Promise<Map<PersonKey, NoticePrefs>> {
  const { data } = await db
    .from('custom_app_notice_prefs')
    .select('recipient_kind, recipient_id, level, email, muted_until')
    .eq('app_id', appId);
  const out = new Map<PersonKey, NoticePrefs>();
  for (const r of (data ?? []) as Array<{
    recipient_kind: NoticePersonKind;
    recipient_id: string;
    level: string;
    email: boolean;
    muted_until: string | null;
  }>)
    out.set(
      personKey(r.recipient_kind, r.recipient_id),
      parsePrefs({ level: r.level, email: r.email, mutedUntil: r.muted_until }),
    );
  return out;
}

export async function getNoticePrefs(
  db: SupabaseClient,
  appId: string,
  person: { kind: NoticePersonKind; id: string },
): Promise<NoticePrefs> {
  const all = await db
    .from('custom_app_notice_prefs')
    .select('level, email, muted_until')
    .eq('app_id', appId)
    .eq('recipient_kind', person.kind)
    .eq('recipient_id', person.id)
    .maybeSingle();
  const r = all.data as { level: string; email: boolean; muted_until: string | null } | null;
  return r ? parsePrefs({ level: r.level, email: r.email, mutedUntil: r.muted_until }) : DEFAULT_PREFS;
}

export async function saveNoticePrefs(
  db: SupabaseClient,
  appId: string,
  person: { kind: NoticePersonKind; id: string },
  prefs: NoticePrefs,
): Promise<void> {
  const { error } = await db.from('custom_app_notice_prefs').upsert(
    {
      app_id: appId,
      recipient_kind: person.kind,
      recipient_id: person.id,
      level: prefs.level,
      email: prefs.email,
      muted_until: prefs.mutedUntil,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'app_id,recipient_kind,recipient_id' },
  );
  if (error) throw error;
}

export async function loadRowOwner(
  db: SupabaseClient,
  rowId: string,
): Promise<{ created_by: string | null; created_by_app_user: string | null }> {
  const { data } = await db
    .from('tracker_rows')
    .select('created_by, created_by_app_user')
    .eq('id', rowId)
    .maybeSingle();
  const r = data as { created_by?: string | null; created_by_app_user?: string | null } | null;
  return { created_by: r?.created_by ?? null, created_by_app_user: r?.created_by_app_user ?? null };
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------

export interface StoredNotice {
  planned: PlannedNotice;
  id: string;
  /** Cómo suena: uno por uno, el resumen de la ráfaga o nada. */
  mode: BurstMode;
  /** Silenciado por la persona: se guarda pero no suena. */
  muted: boolean;
  prefs: NoticePrefs;
}

/**
 * Guarda los avisos planificados: idempotente (la misma clave de suceso deja
 * UNA fila) y anti-ráfaga (cuenta cuántos del mismo grupo llegaron en la
 * ventana para decidir si suena uno por uno, como resumen o nada, y no guarda
 * más allá del tope). Devuelve sólo lo que de verdad se guardó ahora.
 */
export async function storeNotices(
  db: SupabaseClient,
  appId: string,
  planned: readonly PlannedNotice[],
  prefs: ReadonlyMap<PersonKey, NoticePrefs>,
  now = Date.now(),
): Promise<StoredNotice[]> {
  const out: StoredNotice[] = [];
  const since = new Date(now - BURST_WINDOW_MS).toISOString();
  for (const p of planned) {
    const pref = prefs.get(personKey(p.person.kind, p.person.id)) ?? DEFAULT_PREFS;
    let mode: BurstMode = 'single';
    if (p.kind === 'new' || p.kind === 'changed') {
      const { count } = await db
        .from('custom_app_notices')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', appId)
        .eq('recipient_kind', p.person.kind)
        .eq('recipient_id', p.person.id)
        .eq('kind', p.kind)
        .eq('tracker_id', p.trackerId)
        .gte('created_at', since);
      const n = (count ?? 0) + 1;
      if (n > BURST_ROW_CAP) continue;
      mode = burstMode(p.kind, n);
    }
    const muted = isMuted(pref, now);
    const { data, error } = await db
      .from('custom_app_notices')
      .upsert(
        {
          app_id: appId,
          recipient_kind: p.person.kind,
          recipient_id: p.person.id,
          kind: p.kind,
          tracker_id: p.trackerId,
          tracker_name: p.trackerName,
          screen: p.screen,
          row_id: p.rowId,
          title: p.title,
          body: p.body,
          actor_name: p.actorName,
          silent: muted || mode === 'silent',
          dedupe_key: p.dedupeKey.slice(0, 300),
        },
        { onConflict: 'dedupe_key', ignoreDuplicates: true },
      )
      .select('id');
    if (error) continue;
    const id = (data as Array<{ id: string }> | null)?.[0]?.id;
    if (id) out.push({ planned: p, id, mode, muted, prefs: pref });
  }
  return out;
}

const INBOX_COLUMNS =
  'id, kind, title, body, screen, row_id, tracker_name, tracker_id, created_at, read_at, silent';

interface InboxRow {
  id: string;
  kind: AppNoticeKind;
  title: string;
  body: string;
  screen: string | null;
  row_id: string | null;
  tracker_name: string;
  tracker_id: string | null;
  created_at: string;
  read_at: string | null;
  silent: boolean;
}

function adaptInbox(r: InboxRow): InboxNotice & { silent: boolean } {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    screen: r.screen,
    rowId: r.row_id,
    trackerName: r.tracker_name,
    trackerId: r.tracker_id,
    createdAt: r.created_at,
    readAt: r.read_at,
    silent: r.silent,
  };
}

/** La bandeja de una persona en una app, de lo más nuevo a lo más viejo. */
export async function listInbox(
  db: SupabaseClient,
  appId: string,
  person: { kind: NoticePersonKind; id: string },
  limit = 80,
): Promise<Array<InboxNotice & { silent: boolean }>> {
  const { data, error } = await db
    .from('custom_app_notices')
    .select(INBOX_COLUMNS)
    .eq('app_id', appId)
    .eq('recipient_kind', person.kind)
    .eq('recipient_id', person.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as InboxRow[]).map(adaptInbox);
}

/** Marca como leídos: ids concretos, todos los de una pantalla o todos. Sólo los de esta persona. */
export async function markInboxRead(
  db: SupabaseClient,
  appId: string,
  person: { kind: NoticePersonKind; id: string },
  what: { ids: string[] } | { screen: string | null } | { all: true },
): Promise<void> {
  let q = db
    .from('custom_app_notices')
    .update({ read_at: new Date().toISOString() })
    .eq('app_id', appId)
    .eq('recipient_kind', person.kind)
    .eq('recipient_id', person.id)
    .is('read_at', null);
  if ('ids' in what) {
    if (!what.ids.length) return;
    q = q.in('id', what.ids.slice(0, 200));
  } else if ('screen' in what) {
    q = what.screen === null ? q.is('screen', null) : q.eq('screen', what.screen);
  }
  const { error } = await q;
  if (error) throw error;
}
