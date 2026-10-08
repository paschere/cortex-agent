import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ConsentText,
  HIDE_AFTER_SECONDS,
  LOCATION_TEXT_VERSION,
  MIN_PING_INTERVAL_SECONDS,
  type PersonKind,
  type Position,
  type RawPosition,
  SHIFT_MAX_HOURS,
  STALE_AFTER_SECONDS,
  consentText,
  historyDue,
  parsePosition,
  personRef,
  retentionCutoff,
} from './location-shape';
import { canAssignTasks, canShareLocation, canViewLocations } from './permissions';
import { type AppAccess, listRoles } from './store';

/**
 * LA UBICACIÓN DEL EQUIPO, LADO SERVIDOR (migración 0216).
 *
 * Una persona que usa la app puede compartir dónde está para que el equipo la
 * vea en un mapa y le asigne tareas. Es lo más delicado que guarda Cortex sobre
 * alguien, así que cada puerta se cierra por defecto y se comprueba aquí, en
 * el servidor, con el rol GUARDADO (nunca con lo que mande el navegador):
 *
 *   1. LA APP lo permite (`custom_apps.location.enabled`, apagado por defecto).
 *   2. EL ROL puede compartir (`permissions.location.share`).
 *   3. LA PERSONA aceptó el texto vigente y no lo revocó (consentimiento con
 *      versión y fecha).
 *   4. LA PERSONA tiene el turno abierto (Iniciar / Terminar turno).
 *
 * Sin las cuatro, `recordPosition` NO guarda nada (y el navegador ni siquiera
 * pide el GPS). Ver la ubicación de otros es otro permiso (`view`), y la vista
 * pública por enlace nunca llega aquí: no tiene `AppAccess`.
 *
 * Una persona es (kind, id): un miembro de Cortex (users.id) o un usuario
 * externo de la app (custom_app_users.id). Los dos mundos no se cruzan.
 */

export interface LocationActor {
  kind: PersonKind;
  id: string;
}

export function actorOf(access: AppAccess): LocationActor {
  return access.user.external
    ? { kind: 'app_user', id: access.user.id }
    : { kind: 'member', id: access.user.id };
}

export interface LocationStatus {
  /** La app tiene «Compartir ubicación del equipo» encendido. */
  enabled: boolean;
  retentionDays: number;
  /** Su rol puede compartir su ubicación. */
  canShare: boolean;
  canView: boolean;
  canAssign: boolean;
  /** Aceptó el texto vigente y no lo revocó. */
  consented: boolean;
  /** Aceptó un texto anterior: hay que volver a aceptar. */
  consentOutdated: boolean;
  consentAcceptedAt: string | null;
  onShift: boolean;
  shiftSince: string | null;
  /** El texto que se le muestra para aceptar (incluye quién lo ve y cuánto se guarda). */
  text: ConsentText;
}

interface ConsentRow {
  id: string;
  text_version: string;
  accepted_at: string;
  revoked_at: string | null;
  on_shift: boolean;
  shift_started_at: string | null;
}

const CONSENT_COLUMNS = 'id, text_version, accepted_at, revoked_at, on_shift, shift_started_at';

async function consentOf(
  db: SupabaseClient,
  appId: string,
  actor: LocationActor,
): Promise<ConsentRow | null> {
  const { data, error } = await db
    .from('custom_app_location_consents')
    .select(CONSENT_COLUMNS)
    .eq('app_id', appId)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id)
    .maybeSingle();
  if (error) throw error;
  return (data as ConsentRow | null) ?? null;
}

/** Nombres de los roles que ven ubicaciones (para el texto que se acepta). */
async function viewerRoleNames(db: SupabaseClient, appId: string): Promise<string[]> {
  const roles = await listRoles(db, appId);
  return roles
    .filter((r) => r.permissions.location?.view === true)
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b, 'es'));
}

export async function locationStatus(
  db: SupabaseClient,
  access: AppAccess,
): Promise<LocationStatus> {
  const settings = access.app.location;
  const canShare = settings.enabled && canShareLocation(access.role);
  const consent = canShare ? await consentOf(db, access.app.id, actorOf(access)) : null;
  const current = Boolean(
    consent && !consent.revoked_at && consent.text_version === LOCATION_TEXT_VERSION,
  );
  return {
    enabled: settings.enabled,
    retentionDays: settings.retentionDays,
    canShare,
    canView: settings.enabled && canViewLocations(access.role),
    canAssign: canAssignTasks(access.role),
    consented: current,
    consentOutdated: Boolean(
      consent && !consent.revoked_at && consent.text_version !== LOCATION_TEXT_VERSION,
    ),
    consentAcceptedAt: current && consent ? consent.accepted_at : null,
    onShift: current && Boolean(consent?.on_shift),
    shiftSince: current && consent?.on_shift ? consent.shift_started_at : null,
    text: consentText({
      appName: access.app.name,
      retentionDays: settings.retentionDays,
      viewerRoleNames: canShare ? await viewerRoleNames(db, access.app.id) : [],
    }),
  };
}

/** La puerta común de compartir: app encendida y rol con permiso. */
function assertCanShare(access: AppAccess) {
  if (!access.app.location.enabled)
    throw new ValidationError('Esta aplicación no comparte la ubicación del equipo.');
  if (!canShareLocation(access.role))
    throw new ValidationError('Tu rol en esta aplicación no comparte ubicación.');
}

/** Acepta el texto vigente (o lo vuelve a aceptar). Queda la fecha y la versión. */
export async function acceptLocationConsent(
  db: SupabaseClient,
  access: AppAccess,
  now: Date = new Date(),
): Promise<void> {
  assertCanShare(access);
  const actor = actorOf(access);
  const iso = now.toISOString();
  const existing = await consentOf(db, access.app.id, actor);
  if (existing) {
    const { error } = await db
      .from('custom_app_location_consents')
      .update({
        text_version: LOCATION_TEXT_VERSION,
        accepted_at: iso,
        revoked_at: null,
        // Aceptar no abre el turno: el turno es otro botón.
        on_shift: false,
        updated_at: iso,
      })
      .eq('id', existing.id);
    if (error) throw error;
    return;
  }
  const { error } = await db.from('custom_app_location_consents').insert({
    organization_id: access.app.organization_id,
    app_id: access.app.id,
    subject_kind: actor.kind,
    subject_id: actor.id,
    text_version: LOCATION_TEXT_VERSION,
    accepted_at: iso,
  });
  // Dos pestañas aceptando a la vez: la segunda ya está aceptada.
  if (error && (error as { code?: string }).code !== '23505') throw error;
}

/**
 * Retira la autorización: se deja de compartir, se borra la posición actual Y
 * el rastro guardado de esta persona en esta app. (Supresión, Ley 1581.)
 */
export async function revokeLocation(
  db: SupabaseClient,
  access: AppAccess,
  now: Date = new Date(),
): Promise<void> {
  const actor = actorOf(access);
  const iso = now.toISOString();
  await db
    .from('custom_app_location_consents')
    .update({ revoked_at: iso, on_shift: false, shift_ended_at: iso, updated_at: iso })
    .eq('app_id', access.app.id)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id);
  await db
    .from('custom_app_locations')
    .delete()
    .eq('app_id', access.app.id)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id);
  await db
    .from('custom_app_location_history')
    .delete()
    .eq('app_id', access.app.id)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id);
}

/** Iniciar turno: exige consentimiento vigente. */
export async function startShift(
  db: SupabaseClient,
  access: AppAccess,
  now: Date = new Date(),
): Promise<void> {
  assertCanShare(access);
  const actor = actorOf(access);
  const consent = await consentOf(db, access.app.id, actor);
  if (!consent || consent.revoked_at || consent.text_version !== LOCATION_TEXT_VERSION)
    throw new ValidationError('Primero acepta compartir tu ubicación.');
  const iso = now.toISOString();
  const { error } = await db
    .from('custom_app_location_consents')
    .update({ on_shift: true, shift_started_at: iso, shift_ended_at: null, updated_at: iso })
    .eq('id', consent.id);
  if (error) throw error;
}

/** Terminar turno: se deja de compartir y se borra la posición actual (el rastro sigue hasta su retención). */
export async function endShift(
  db: SupabaseClient,
  access: AppAccess,
  now: Date = new Date(),
): Promise<void> {
  const actor = actorOf(access);
  const iso = now.toISOString();
  await db
    .from('custom_app_location_consents')
    .update({ on_shift: false, shift_ended_at: iso, updated_at: iso })
    .eq('app_id', access.app.id)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id);
  await db
    .from('custom_app_locations')
    .delete()
    .eq('app_id', access.app.id)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id);
}

export type PositionOutcome =
  | { saved: true }
  | { saved: false; reason: 'rate' | 'invalid' | 'inactive' };

/**
 * Guarda la posición de QUIEN LA ENVÍA. Nunca recibe la de otro: la persona es
 * `access`, no un parámetro. Si falta cualquiera de las cuatro puertas, no
 * guarda nada y lo dice (`inactive`), para que el navegador deje de pedir el GPS.
 * Más de una por `MIN_PING_INTERVAL_SECONDS` se descarta sin error (`rate`); la
 * comparación es condicionada en la base, así que dos envíos a la vez dejan uno.
 */
export async function recordPosition(
  db: SupabaseClient,
  access: AppAccess,
  raw: RawPosition,
  now: Date = new Date(),
): Promise<PositionOutcome> {
  if (!access.app.location.enabled || !canShareLocation(access.role))
    return { saved: false, reason: 'inactive' };
  const actor = actorOf(access);
  const consent = await consentOf(db, access.app.id, actor);
  if (
    !consent ||
    consent.revoked_at ||
    consent.text_version !== LOCATION_TEXT_VERSION ||
    !consent.on_shift
  )
    return { saved: false, reason: 'inactive' };
  const position = parsePosition(raw);
  if (!position) return { saved: false, reason: 'invalid' };
  return writePosition(db, access, actor, position, now);
}

interface LiveRow {
  id: string;
  recorded_at: string;
  history_at: string | null;
}

async function writePosition(
  db: SupabaseClient,
  access: AppAccess,
  actor: LocationActor,
  p: Position,
  now: Date,
): Promise<PositionOutcome> {
  const iso = now.toISOString();
  const fields = {
    lat: p.lat,
    lng: p.lng,
    accuracy_m: p.accuracyM,
    heading: p.heading,
    speed_mps: p.speedMps,
    battery_pct: p.batteryPct,
    recorded_at: iso,
  };
  const { data: current, error: readError } = await db
    .from('custom_app_locations')
    .select('id, recorded_at, history_at')
    .eq('app_id', access.app.id)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id)
    .maybeSingle();
  if (readError) throw readError;
  const live = current as LiveRow | null;
  const keepHistory = historyDue(live?.history_at ?? null, now);
  const historyPatch = keepHistory ? { history_at: iso } : {};
  if (live) {
    // La condición va en la base: dos envíos a la vez no se saltan el tope.
    const earliest = new Date(now.getTime() - MIN_PING_INTERVAL_SECONDS * 1000).toISOString();
    const { data: won, error } = await db
      .from('custom_app_locations')
      .update({ ...fields, ...historyPatch })
      .eq('id', live.id)
      .lte('recorded_at', earliest)
      .select('id');
    if (error) throw error;
    if (!won?.length) return { saved: false, reason: 'rate' };
  } else {
    const { error } = await db.from('custom_app_locations').insert({
      organization_id: access.app.organization_id,
      app_id: access.app.id,
      subject_kind: actor.kind,
      subject_id: actor.id,
      ...fields,
      ...historyPatch,
    });
    if (error) {
      if ((error as { code?: string }).code === '23505') return { saved: false, reason: 'rate' };
      throw error;
    }
  }
  if (keepHistory) {
    await db.from('custom_app_location_history').insert({
      organization_id: access.app.organization_id,
      app_id: access.app.id,
      subject_kind: actor.kind,
      subject_id: actor.id,
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.accuracyM,
      recorded_at: iso,
    });
  }
  return { saved: true };
}

export interface LiveTeamPerson {
  /** «m:uuid» / «u:uuid». */
  ref: string;
  name: string;
  roleKey: string;
  roleName: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  heading: number | null;
  speedMps: number | null;
  batteryPct: number | null;
  recordedAt: string;
  ageSeconds: number;
  /** Más de cinco minutos sin posición nueva: se pinta apagado («sin señal»). */
  stale: boolean;
  onShift: true;
  shiftSince: string | null;
  self: boolean;
}

interface LocationRow {
  subject_kind: PersonKind;
  subject_id: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  battery_pct: number | null;
  recorded_at: string;
}

/**
 * Dónde están ahora las personas en turno. SÓLO para un rol con permiso de ver
 * (`location.view`) y con la función encendida; para cualquier otro, error.
 * Une la posición con el consentimiento vigente y con la persona activa de ESTA
 * app: quien revocó, terminó turno, fue desactivada o ya no está no aparece.
 */
export async function listLivePeople(
  db: SupabaseClient,
  access: AppAccess,
  filter: { roles?: readonly string[] } = {},
  now: Date = new Date(),
): Promise<LiveTeamPerson[]> {
  if (!access.app.location.enabled)
    throw new ValidationError('Esta aplicación no comparte la ubicación del equipo.');
  if (!canViewLocations(access.role))
    throw new ValidationError('Tu rol en esta aplicación no ve la ubicación del equipo.');
  const appId = access.app.id;
  const [locs, consents, roles] = await Promise.all([
    db
      .from('custom_app_locations')
      .select(
        'subject_kind, subject_id, lat, lng, accuracy_m, heading, speed_mps, battery_pct, recorded_at',
      )
      .eq('app_id', appId)
      .limit(500),
    db
      .from('custom_app_location_consents')
      .select('subject_kind, subject_id, shift_started_at')
      .eq('app_id', appId)
      .eq('on_shift', true)
      .is('revoked_at', null)
      .eq('text_version', LOCATION_TEXT_VERSION)
      .limit(500),
    listRoles(db, appId),
  ]);
  if (locs.error) throw locs.error;
  if (consents.error) throw consents.error;
  const shift = new Map(
    (
      (consents.data ?? []) as Array<{
        subject_kind: string;
        subject_id: string;
        shift_started_at: string | null;
      }>
    ).map((c) => [`${c.subject_kind}:${c.subject_id}`, c.shift_started_at]),
  );
  const live = ((locs.data ?? []) as LocationRow[]).filter((l) =>
    shift.has(`${l.subject_kind}:${l.subject_id}`),
  );
  const memberIds = live.filter((l) => l.subject_kind === 'member').map((l) => l.subject_id);
  const userIds = live.filter((l) => l.subject_kind === 'app_user').map((l) => l.subject_id);
  const [memberRows, memberNames, appUsers] = await Promise.all([
    memberIds.length
      ? db
          .from('custom_app_members')
          .select('user_id, role_key')
          .eq('app_id', appId)
          .in('user_id', memberIds)
      : Promise.resolve({ data: [], error: null }),
    memberIds.length
      ? db.from('users').select('id, name, email').in('id', memberIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? db
          .from('custom_app_users')
          .select('id, name, role_key, status')
          .eq('app_id', appId)
          .in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (memberRows.error) throw memberRows.error;
  if (memberNames.error) throw memberNames.error;
  if (appUsers.error) throw appUsers.error;
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const memberRole = new Map(
    ((memberRows.data ?? []) as Array<{ user_id: string; role_key: string }>).map((m) => [
      m.user_id,
      m.role_key,
    ]),
  );
  const memberName = new Map(
    ((memberNames.data ?? []) as Array<{ id: string; name: string | null; email: string }>).map(
      (u) => [u.id, u.name || u.email],
    ),
  );
  const appUser = new Map(
    ((appUsers.data ?? []) as Array<{ id: string; name: string; role_key: string; status: string }>)
      .filter((u) => u.status !== 'disabled')
      .map((u) => [u.id, u]),
  );
  const self = actorOf(access);
  const wantedRoles = filter.roles?.length ? new Set(filter.roles) : null;
  const out: LiveTeamPerson[] = [];
  for (const l of live) {
    let name: string | undefined;
    let roleKey: string | undefined;
    if (l.subject_kind === 'member') {
      name = memberName.get(l.subject_id);
      roleKey = memberRole.get(l.subject_id);
    } else {
      const u = appUser.get(l.subject_id);
      name = u?.name;
      roleKey = u?.role_key;
    }
    if (!name || !roleKey) continue;
    if (wantedRoles && !wantedRoles.has(roleKey)) continue;
    const age = Math.max(0, Math.round((now.getTime() - Date.parse(l.recorded_at)) / 1000));
    if (age > HIDE_AFTER_SECONDS) continue;
    out.push({
      ref: personRef(l.subject_kind, l.subject_id),
      name,
      roleKey,
      roleName: roleName.get(roleKey) ?? roleKey,
      lat: l.lat,
      lng: l.lng,
      accuracyM: l.accuracy_m,
      heading: l.heading,
      speedMps: l.speed_mps,
      batteryPct: l.battery_pct,
      recordedAt: l.recorded_at,
      ageSeconds: age,
      stale: age > STALE_AFTER_SECONDS,
      onShift: true,
      shiftSince: shift.get(`${l.subject_kind}:${l.subject_id}`) ?? null,
      self: l.subject_kind === self.kind && l.subject_id === self.id,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export interface AssignablePerson {
  ref: string;
  name: string;
  roleKey: string;
  roleName: string;
  onShift: boolean;
}

/**
 * A quién se le puede asignar una tarea: usuarios activos de la app y miembros
 * de Cortex con rol en ella. SIN coordenadas: asignar es otro permiso que ver
 * ubicaciones. `roles` limita a ciertos roles.
 */
export async function listAssignablePeople(
  db: SupabaseClient,
  access: AppAccess,
  filter: { roles?: readonly string[] } = {},
): Promise<AssignablePerson[]> {
  if (!canAssignTasks(access.role))
    throw new ValidationError('Tu rol en esta aplicación no asigna tareas.');
  const appId = access.app.id;
  const [roles, users, members, shifts] = await Promise.all([
    listRoles(db, appId),
    db
      .from('custom_app_users')
      .select('id, name, role_key')
      .eq('app_id', appId)
      .neq('status', 'disabled')
      .limit(500),
    db.from('custom_app_members').select('user_id, role_key').eq('app_id', appId).limit(500),
    db
      .from('custom_app_location_consents')
      .select('subject_kind, subject_id')
      .eq('app_id', appId)
      .eq('on_shift', true)
      .is('revoked_at', null)
      .limit(500),
  ]);
  if (users.error) throw users.error;
  if (members.error) throw members.error;
  if (shifts.error) throw shifts.error;
  const memberRows = (members.data ?? []) as Array<{ user_id: string; role_key: string }>;
  const names = memberRows.length
    ? await db
        .from('users')
        .select('id, name, email')
        .in(
          'id',
          memberRows.map((m) => m.user_id),
        )
    : { data: [], error: null };
  if (names.error) throw names.error;
  const nameOf = new Map(
    ((names.data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name || u.email,
    ]),
  );
  const onShift = new Set(
    ((shifts.data ?? []) as Array<{ subject_kind: string; subject_id: string }>).map(
      (s) => `${s.subject_kind}:${s.subject_id}`,
    ),
  );
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const wanted = filter.roles?.length ? new Set(filter.roles) : null;
  const out: AssignablePerson[] = [];
  for (const u of (users.data ?? []) as Array<{ id: string; name: string; role_key: string }>) {
    if (wanted && !wanted.has(u.role_key)) continue;
    out.push({
      ref: personRef('app_user', u.id),
      name: u.name,
      roleKey: u.role_key,
      roleName: roleName.get(u.role_key) ?? u.role_key,
      onShift: onShift.has(`app_user:${u.id}`),
    });
  }
  for (const m of memberRows) {
    const name = nameOf.get(m.user_id);
    if (!name || (wanted && !wanted.has(m.role_key))) continue;
    out.push({
      ref: personRef('member', m.user_id),
      name,
      roleKey: m.role_key,
      roleName: roleName.get(m.role_key) ?? m.role_key,
      onShift: onShift.has(`member:${m.user_id}`),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// ---------------------------------------------------------------------------
// Trabajo programado: retención y turnos olvidados
// ---------------------------------------------------------------------------

/** Borra el historial más viejo que la retención de la app. Devuelve cuántas muestras. */
export async function purgeLocationHistory(
  db: SupabaseClient,
  appId: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(retentionDays, now).toISOString();
  const { data, error } = await db
    .from('custom_app_location_history')
    .delete()
    .eq('app_id', appId)
    .lt('recorded_at', cutoff)
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Cierra los turnos que se quedaron abiertos (el teléfono se apagó, se olvidó
 * terminar) pasadas `SHIFT_MAX_HOURS`, y borra su posición actual. Una posición
 * sin turno abierto tampoco se conserva.
 */
export async function closeStaleShifts(
  db: SupabaseClient,
  appId: string,
  now: Date = new Date(),
): Promise<number> {
  const limit = new Date(now.getTime() - SHIFT_MAX_HOURS * 3_600_000).toISOString();
  const { data, error } = await db
    .from('custom_app_location_consents')
    .update({ on_shift: false, shift_ended_at: now.toISOString() })
    .eq('app_id', appId)
    .eq('on_shift', true)
    .lt('shift_started_at', limit)
    .select('subject_kind, subject_id');
  if (error) throw error;
  for (const s of (data ?? []) as Array<{ subject_kind: string; subject_id: string }>)
    await db
      .from('custom_app_locations')
      .delete()
      .eq('app_id', appId)
      .eq('subject_kind', s.subject_kind)
      .eq('subject_id', s.subject_id);
  // Las posiciones que quedaron sin turno abierto (por una revocación a medias o un cierre manual).
  const { data: open } = await db
    .from('custom_app_location_consents')
    .select('subject_kind, subject_id')
    .eq('app_id', appId)
    .eq('on_shift', true)
    .limit(2000);
  const openKeys = new Set(
    ((open ?? []) as Array<{ subject_kind: string; subject_id: string }>).map(
      (c) => `${c.subject_kind}:${c.subject_id}`,
    ),
  );
  const { data: live } = await db
    .from('custom_app_locations')
    .select('id, subject_kind, subject_id')
    .eq('app_id', appId)
    .limit(2000);
  const orphans = ((live ?? []) as Array<{ id: string; subject_kind: string; subject_id: string }>)
    .filter((l) => !openKeys.has(`${l.subject_kind}:${l.subject_id}`))
    .map((l) => l.id);
  if (orphans.length) await db.from('custom_app_locations').delete().in('id', orphans);
  return (data?.length ?? 0) + orphans.length;
}
