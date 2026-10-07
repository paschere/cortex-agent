import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hashSessionToken, newSessionToken } from './external';
import type { CustomAppRow } from './store';

/**
 * MODO KIOSCO: UN CELULAR DE PLANTA PARA VARIAS PERSONAS (migración 0211).
 *
 * El flujo, de punta a punta:
 *
 *   1. Quien administra (editor de la app) crea un DISPOSITIVO y recibe un
 *      enlace de un solo uso (15 min). El celular lo abre y queda «en modo
 *      kiosco»: guarda un token de dispositivo en una cookie httpOnly; aquí
 *      sólo su sha256. Un supervisor con el permiso `kiosk` de su rol puede
 *      además dejar así el celular que tiene en la mano (`enrollDevice`).
 *   2. En ese celular cada persona toca su nombre y escribe su PIN de 4 a 6
 *      dígitos (`pinLogin`). Si es correcto se abre una sesión NORMAL de la app
 *      (la misma `custom_app_sessions`, con su rol, su scope de filas y su
 *      `created_by_app_user`) pero atada al dispositivo y con vencimiento por
 *      inactividad (`resolveExternalSession` lo exige en cada petición).
 *   3. Pasados N minutos sin uso (configurable por app, 5 por omisión) la
 *      sesión se cierra sola y el celular vuelve a la lista de nombres.
 *
 * LO QUE PROTEGE QUÉ
 *   - El PIN sólo sirve con un dispositivo autorizado y no revocado: en un
 *     navegador cualquiera no abre nada. Un PIN de 4 dígitos son diez mil
 *     posibilidades, así que el único freno real es el bloqueo.
 *   - Bloqueo: a los 5 intentos fallidos esa persona queda bloqueada
 *     `PIN_LOCK_MINUTES` aunque escriba bien el PIN después; el contador vive en
 *     la fila del usuario, no en el dispositivo, así que cambiar de celular no
 *     lo reinicia. Un acierto lo pone en cero.
 *   - Del PIN sólo se guarda un hash con sal (scrypt) y una llave del servidor.
 *     Una fila filtrada no da los PIN ni con tabla arcoíris. PIN triviales
 *     (0000, 1234, 1111…) se rechazan.
 *   - Revocar el dispositivo corta en el mismo paso todas las sesiones abiertas
 *     en él; desactivar a la persona corta las suyas como siempre.
 *   - Nada de esto da acceso a otra empresa: todo pasa por el handle con alcance.
 */

export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 6;
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;
export const DEFAULT_KIOSK_IDLE_MINUTES = 5;
export const MIN_KIOSK_IDLE_MINUTES = 1;
export const MAX_KIOSK_IDLE_MINUTES = 120;
/** Tope duro de una sesión de kiosco aunque la persona no pare de usarla: un turno. */
export const KIOSK_SESSION_HOURS = 12;
export const MAX_DEVICES_PER_APP = 20;
export const PAIRING_TTL_MINUTES = 15;
/** Cuánto se espera antes de volver a anotar «visto» en el dispositivo o la sesión. */
export const KIOSK_TOUCH_SECONDS = 20;

const DEVICE_COLUMNS =
  'id, app_id, name, created_by, created_by_kind, created_at, last_seen_at, revoked_at, token_hash, pairing_expires_at';

// ---------------------------------------------------------------------------
// PIN: forma y hash (puros)
// ---------------------------------------------------------------------------

/** Quita espacios; el resto lo juzga `pinProblem`. */
export function cleanPin(raw: string): string {
  return String(raw ?? '').replace(/\s/g, '');
}

/** Por qué este PIN no sirve, o null si sirve. Mensajes para la persona. */
export function pinProblem(raw: string): string | null {
  const pin = cleanPin(raw);
  if (!new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`).test(pin))
    return `El PIN son de ${PIN_MIN_DIGITS} a ${PIN_MAX_DIGITS} números.`;
  if (/^(\d)\1+$/.test(pin)) return 'Ese PIN es muy fácil de adivinar (todos los números iguales).';
  const digits = [...pin].map(Number);
  const step = (digits[1] ?? 0) - (digits[0] ?? 0);
  if (
    (step === 1 || step === -1) &&
    digits.every((d, i) => i === 0 || d - (digits[i - 1] as number) === step)
  )
    return 'Ese PIN es muy fácil de adivinar (números seguidos).';
  return null;
}

/**
 * El hash del PIN: scrypt con sal propia y la llave del servidor mezclada en la
 * sal. Formato `s1$<sal>$<hash>` (base64url) para poder cambiar de algoritmo.
 */
export function hashPin(secret: string, userId: string, pin: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('base64url');
  const key = scryptSync(cleanPin(pin), `${secret}:${userId}:${s}`, 32, { N: 16384 });
  return `s1$${s}$${key.toString('base64url')}`;
}

export function verifyPinHash(
  secret: string,
  userId: string,
  pin: string,
  stored: string | null,
): boolean {
  // Mismo trabajo de scrypt aunque no haya PIN guardado: no se distingue por tiempo.
  const parts = (stored ?? 's1$sin-sal$').split('$');
  const salt = parts[1] ?? 'sin-sal';
  const probe = hashPin(secret, userId, pin, salt);
  if (!stored || parts[0] !== 's1' || parts.length !== 3) return false;
  const a = Buffer.from(probe);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Ajustes de kiosco de la app
// ---------------------------------------------------------------------------

export interface KioskSettings {
  enabled: boolean;
  idleMinutes: number;
}

export function clampIdleMinutes(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_KIOSK_IDLE_MINUTES;
  return Math.min(MAX_KIOSK_IDLE_MINUTES, Math.max(MIN_KIOSK_IDLE_MINUTES, n));
}

export async function getKioskSettings(db: SupabaseClient, appId: string): Promise<KioskSettings> {
  const { data, error } = await db
    .from('custom_apps')
    .select('kiosk_enabled, kiosk_idle_minutes')
    .eq('id', appId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa aplicación no existe.');
  const row = data as { kiosk_enabled: boolean | null; kiosk_idle_minutes: number | null };
  return {
    enabled: row.kiosk_enabled === true,
    idleMinutes: clampIdleMinutes(row.kiosk_idle_minutes ?? DEFAULT_KIOSK_IDLE_MINUTES),
  };
}

export async function setKioskSettings(
  db: SupabaseClient,
  appId: string,
  input: { enabled?: boolean; idleMinutes?: number },
): Promise<KioskSettings> {
  const patch: Record<string, unknown> = {};
  if (input.enabled !== undefined) patch.kiosk_enabled = input.enabled === true;
  if (input.idleMinutes !== undefined) {
    const n = Math.round(Number(input.idleMinutes));
    if (!Number.isFinite(n) || n < MIN_KIOSK_IDLE_MINUTES || n > MAX_KIOSK_IDLE_MINUTES)
      throw new ValidationError(
        `Los minutos sin uso van de ${MIN_KIOSK_IDLE_MINUTES} a ${MAX_KIOSK_IDLE_MINUTES}.`,
      );
    patch.kiosk_idle_minutes = n;
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from('custom_apps').update(patch).eq('id', appId);
    if (error) throw error;
  }
  const settings = await getKioskSettings(db, appId);
  // Apagar el kiosco corta lo que está abierto en los dispositivos: nadie sigue dentro por inercia.
  if (!settings.enabled) await revokeAllDeviceSessions(db, appId);
  return settings;
}

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

export interface KioskDevice {
  id: string;
  appId: string;
  name: string;
  /** `pending` = el enlace de emparejamiento aún no se abrió en un celular. */
  state: 'active' | 'pending' | 'revoked';
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

function adaptDevice(row: Record<string, unknown>, now: Date = new Date()): KioskDevice {
  const revoked = typeof row.revoked_at === 'string' ? row.revoked_at : null;
  const claimed = typeof row.token_hash === 'string' && row.token_hash.length > 0;
  return {
    id: String(row.id),
    appId: String(row.app_id),
    name: String(row.name),
    state: revoked ? 'revoked' : claimed ? 'active' : 'pending',
    createdAt: String(row.created_at),
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    revokedAt: revoked,
  };
}

const deviceNameSchema = (raw: string): string => {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 60)
    throw new ValidationError(
      'Ponle un nombre al dispositivo (hasta 60 letras), por ejemplo «Muelle 3».',
    );
  return name;
};

export async function listDevices(db: SupabaseClient, appId: string): Promise<KioskDevice[]> {
  const { data, error } = await db
    .from('custom_app_devices')
    .select(DEVICE_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((r) => adaptDevice(r as Record<string, unknown>));
}

async function assertRoomForDevice(db: SupabaseClient, appId: string) {
  const live = (await listDevices(db, appId)).filter((d) => d.state !== 'revoked');
  if (live.length >= MAX_DEVICES_PER_APP)
    throw new ValidationError(
      `Una aplicación tiene hasta ${MAX_DEVICES_PER_APP} dispositivos. Revoca alguno que ya no uses.`,
    );
}

/**
 * Deja un celular en modo kiosco AHORA (el que tiene en la mano quien llama):
 * devuelve el token que la ruta guarda en la cookie del dispositivo.
 */
export async function enrollDevice(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  input: { name: string; by: string; kind: 'member' | 'app_user' },
): Promise<{ device: KioskDevice; token: string }> {
  const settings = await getKioskSettings(db, app.id);
  if (!settings.enabled)
    throw new ValidationError(
      'Activa el modo kiosco de la aplicación antes de dejar un dispositivo.',
    );
  await assertRoomForDevice(db, app.id);
  const token = newSessionToken();
  const { data, error } = await db
    .from('custom_app_devices')
    .insert({
      id: randomUUID(),
      app_id: app.id,
      name: deviceNameSchema(input.name),
      token_hash: hashSessionToken(token),
      created_by: input.by,
      created_by_kind: input.kind,
    })
    .select(DEVICE_COLUMNS)
    .single();
  if (error) throw error;
  return { device: adaptDevice(data as Record<string, unknown>), token };
}

/**
 * Prepara un dispositivo desde el editor y devuelve el código de emparejamiento
 * (un solo uso, 15 minutos). El celular lo reclama con `claimPairing`.
 */
export async function createPairing(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  input: { name: string; by: string; now?: Date },
): Promise<{ device: KioskDevice; code: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  const settings = await getKioskSettings(db, app.id);
  if (!settings.enabled)
    throw new ValidationError(
      'Activa el modo kiosco de la aplicación antes de agregar un dispositivo.',
    );
  await assertRoomForDevice(db, app.id);
  const code = randomBytes(18).toString('base64url');
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await db
    .from('custom_app_devices')
    .insert({
      id: randomUUID(),
      app_id: app.id,
      name: deviceNameSchema(input.name),
      token_hash: null,
      pairing_hash: hashSessionToken(code),
      pairing_expires_at: expiresAt,
      created_by: input.by,
      created_by_kind: 'member',
    })
    .select(DEVICE_COLUMNS)
    .single();
  if (error) throw error;
  return { device: adaptDevice(data as Record<string, unknown>), code, expiresAt };
}

/**
 * El celular abre el enlace: si el código existe, no venció y no se usó, el
 * dispositivo queda emparejado y se entrega SU token. Un código se usa una vez.
 */
export async function claimPairing(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  code: string,
  options: { now?: Date } = {},
): Promise<{ device: KioskDevice; token: string } | null> {
  const now = options.now ?? new Date();
  if (!code || code.length < 20 || code.length > 100) return null;
  const { data, error } = await db
    .from('custom_app_devices')
    .select(`${DEVICE_COLUMNS}, pairing_hash`)
    .eq('app_id', app.id)
    .eq('pairing_hash', hashSessionToken(code))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  const row = data as (Record<string, unknown> & { pairing_expires_at: string | null }) | null;
  if (!row || row.token_hash) return null;
  if (!row.pairing_expires_at || new Date(row.pairing_expires_at).getTime() <= now.getTime())
    return null;
  const settings = await getKioskSettings(db, app.id);
  if (!settings.enabled) return null;
  const token = newSessionToken();
  // Reclamar es un paso atómico: sólo gana quien encuentre el código todavía sin token.
  const { data: won, error: upError } = await db
    .from('custom_app_devices')
    .update({
      token_hash: hashSessionToken(token),
      pairing_hash: null,
      pairing_expires_at: null,
      last_seen_at: now.toISOString(),
    })
    .eq('id', String(row.id))
    .is('token_hash', null)
    .select(DEVICE_COLUMNS);
  if (upError) throw upError;
  if (!won || (won as unknown[]).length === 0) return null;
  return {
    device: adaptDevice((won as Record<string, unknown>[])[0] as Record<string, unknown>),
    token,
  };
}

/**
 * El dispositivo detrás de la cookie, o null si no existe, está sin emparejar,
 * se revocó o el kiosco de la app está apagado. Anota «visto» sin escribir en
 * cada petición.
 */
export async function resolveDevice(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  token: string | null | undefined,
  options: { now?: Date } = {},
): Promise<KioskDevice | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const now = options.now ?? new Date();
  const { data, error } = await db
    .from('custom_app_devices')
    .select(DEVICE_COLUMNS)
    .eq('app_id', app.id)
    .eq('token_hash', hashSessionToken(token))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const device = adaptDevice(data as Record<string, unknown>);
  if (device.state !== 'active') return null;
  if (!(await getKioskSettings(db, app.id)).enabled) return null;
  const seen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  if (now.getTime() - seen > 10 * 60_000) {
    const { error: touchError } = await db
      .from('custom_app_devices')
      .update({ last_seen_at: now.toISOString() })
      .eq('id', device.id);
    if (touchError) throw touchError;
  }
  return device;
}

/** Revocar: el celular deja de ser kiosco y las sesiones abiertas en él se cortan en el mismo paso. */
export async function revokeDevice(
  db: SupabaseClient,
  appId: string,
  deviceId: string,
): Promise<void> {
  const { data, error } = await db
    .from('custom_app_devices')
    .update({ revoked_at: new Date().toISOString(), pairing_hash: null })
    .eq('app_id', appId)
    .eq('id', deviceId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw error;
  if (!data || (data as unknown[]).length === 0)
    throw new NotFoundError('Ese dispositivo ya no está o ya estaba revocado.');
  const { error: sesError } = await db
    .from('custom_app_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('device_id', deviceId)
    .is('revoked_at', null);
  if (sesError) throw sesError;
}

async function revokeAllDeviceSessions(db: SupabaseClient, appId: string): Promise<void> {
  const { error } = await db
    .from('custom_app_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('app_id', appId)
    .not('device_id', 'is', null)
    .is('revoked_at', null);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Personas y PIN
// ---------------------------------------------------------------------------

export interface KioskPerson {
  id: string;
  name: string;
}

/** Quién aparece en la lista del kiosco: usuarios activos con PIN. Sólo nombres. */
export async function listKioskPeople(db: SupabaseClient, appId: string): Promise<KioskPerson[]> {
  const { data, error } = await db
    .from('custom_app_users')
    .select('id, name, pin_hash')
    .eq('app_id', appId)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .limit(300);
  if (error) throw error;
  return (data ?? [])
    .filter((r) => typeof (r as { pin_hash?: unknown }).pin_hash === 'string')
    .map((r) => ({
      id: String((r as { id: string }).id),
      name: String((r as { name: string }).name),
    }));
}

export interface PinState {
  userId: string;
  hasPin: boolean;
  lockedUntil: string | null;
}

/** Para el editor: quién tiene PIN y quién está bloqueado. */
export async function listPinStates(
  db: SupabaseClient,
  appId: string,
  options: { now?: Date } = {},
): Promise<PinState[]> {
  const { data, error } = await db
    .from('custom_app_users')
    .select('id, pin_hash, pin_locked_until')
    .eq('app_id', appId);
  if (error) throw error;
  const now = (options.now ?? new Date()).getTime();
  return (data ?? []).map((r) => {
    const row = r as { id: string; pin_hash: string | null; pin_locked_until: string | null };
    const locked = row.pin_locked_until && new Date(row.pin_locked_until).getTime() > now;
    return {
      userId: row.id,
      hasPin: typeof row.pin_hash === 'string' && row.pin_hash.length > 0,
      lockedUntil: locked ? row.pin_locked_until : null,
    };
  });
}

interface PinRow {
  id: string;
  name: string;
  status: string;
  pin_hash: string | null;
  pin_attempts: number;
  pin_locked_until: string | null;
}

async function pinRow(db: SupabaseClient, appId: string, userId: string): Promise<PinRow | null> {
  const { data, error } = await db
    .from('custom_app_users')
    .select('id, name, status, pin_hash, pin_attempts, pin_locked_until')
    .eq('app_id', appId)
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as PinRow | null) ?? null;
}

/**
 * Pone o cambia el PIN de alguien (lo asigna el administrador o lo define la
 * propia persona). Destraba y reinicia los intentos: poner un PIN nuevo es la
 * forma de recuperar a quien se bloqueó.
 */
export async function setUserPin(
  db: SupabaseClient,
  appId: string,
  userId: string,
  pin: string,
  options: { secret: string; now?: Date },
): Promise<void> {
  const problem = pinProblem(pin);
  if (problem) throw new ValidationError(problem);
  const row = await pinRow(db, appId, userId);
  if (!row) throw new NotFoundError('Ese usuario ya no está en la aplicación.');
  const { error } = await db
    .from('custom_app_users')
    .update({
      pin_hash: hashPin(options.secret, userId, pin),
      pin_set_at: (options.now ?? new Date()).toISOString(),
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq('app_id', appId)
    .eq('id', userId);
  if (error) throw error;
}

export async function clearUserPin(
  db: SupabaseClient,
  appId: string,
  userId: string,
): Promise<void> {
  const row = await pinRow(db, appId, userId);
  if (!row) throw new NotFoundError('Ese usuario ya no está en la aplicación.');
  const { error } = await db
    .from('custom_app_users')
    .update({ pin_hash: null, pin_set_at: null, pin_attempts: 0, pin_locked_until: null })
    .eq('app_id', appId)
    .eq('id', userId);
  if (error) throw error;
  // Sin PIN no hay forma de volver a entrar al kiosco: se cierran sus sesiones de dispositivo.
  const { error: sesError } = await db
    .from('custom_app_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('app_user_id', userId)
    .not('device_id', 'is', null)
    .is('revoked_at', null);
  if (sesError) throw sesError;
}

export type PinChange =
  | { ok: true }
  | { ok: false; reason: 'wrong' | 'locked' | 'weak'; message: string; lockedUntil?: string };

/**
 * «Cambiar mi PIN». Quien entró por correo (sesión normal) ya probó que es esa
 * persona y puede fijar uno sin saber el anterior. Quien entró por un
 * dispositivo kiosco (`viaDevice`) tiene que escribir el PIN actual, y ese
 * intento cuenta para el bloqueo como cualquier otro.
 */
export async function changeOwnPin(
  db: SupabaseClient,
  appId: string,
  userId: string,
  input: { current?: string; next: string; viaDevice: boolean },
  options: { secret: string; now?: Date },
): Promise<PinChange> {
  const now = options.now ?? new Date();
  const weak = pinProblem(input.next);
  if (weak) return { ok: false, reason: 'weak', message: weak };
  const row = await pinRow(db, appId, userId);
  if (!row) return { ok: false, reason: 'wrong', message: 'No se pudo cambiar el PIN.' };
  if (input.viaDevice && row.pin_hash) {
    const check = await checkPin(db, appId, row, input.current ?? '', options.secret, now);
    if (check !== 'ok')
      return check.locked
        ? {
            ok: false,
            reason: 'locked',
            message: 'Demasiados intentos. Espera un rato o pide que te reinicien el PIN.',
            lockedUntil: check.locked,
          }
        : { ok: false, reason: 'wrong', message: 'El PIN actual no es correcto.' };
  }
  await setUserPin(db, appId, userId, input.next, options);
  return { ok: true };
}

/** Compara un PIN con el guardado y lleva la cuenta de fallos: el corazón del bloqueo. */
async function checkPin(
  db: SupabaseClient,
  appId: string,
  row: PinRow,
  pin: string,
  secret: string,
  now: Date,
): Promise<'ok' | { locked: string | null; attemptsLeft: number }> {
  if (row.pin_locked_until && new Date(row.pin_locked_until).getTime() > now.getTime())
    // Bloqueado: ni el PIN bueno entra, y no se cuenta un intento más.
    return { locked: row.pin_locked_until, attemptsLeft: 0 };
  const good = verifyPinHash(secret, row.id, pin, row.pin_hash);
  if (good) {
    if (row.pin_attempts > 0 || row.pin_locked_until) {
      const { error } = await db
        .from('custom_app_users')
        .update({ pin_attempts: 0, pin_locked_until: null })
        .eq('app_id', appId)
        .eq('id', row.id);
      if (error) throw error;
    }
    return 'ok';
  }
  // Compare-and-set sobre el contador: dos intentos en paralelo no pueden contar como uno.
  let attempts = row.pin_attempts;
  for (let i = 0; i < 4; i++) {
    const next = attempts + 1;
    const lock = next >= MAX_PIN_ATTEMPTS;
    const { data, error } = await db
      .from('custom_app_users')
      .update({
        pin_attempts: lock ? 0 : next,
        pin_locked_until: lock
          ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000).toISOString()
          : null,
      })
      .eq('app_id', appId)
      .eq('id', row.id)
      .eq('pin_attempts', attempts)
      .select('pin_attempts, pin_locked_until');
    if (error) throw error;
    if (data && (data as unknown[]).length > 0)
      return lock
        ? {
            locked: new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000).toISOString(),
            attemptsLeft: 0,
          }
        : { locked: null, attemptsLeft: MAX_PIN_ATTEMPTS - next };
    const fresh = await pinRow(db, appId, row.id);
    if (!fresh) break;
    if (fresh.pin_locked_until && new Date(fresh.pin_locked_until).getTime() > now.getTime())
      return { locked: fresh.pin_locked_until, attemptsLeft: 0 };
    attempts = fresh.pin_attempts;
  }
  return { locked: null, attemptsLeft: 0 };
}

export type PinLoginOutcome =
  | { ok: true; token: string; expiresAt: string; userId: string; idleMinutes: number }
  | { ok: false; reason: 'invalid'; attemptsLeft?: number }
  | { ok: false; reason: 'locked'; lockedUntil: string };

/**
 * Entrar con el PIN en un dispositivo kiosco. `deviceToken` es el de la cookie
 * del dispositivo: sin un dispositivo autorizado y vivo no hay PIN que valga.
 * Todo lo que no es «bloqueado» sale como `invalid` sin explicar (dispositivo
 * revocado, persona desactivada o sin PIN, PIN malo).
 */
export async function pinLogin(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  deviceToken: string | null | undefined,
  userId: string,
  pin: string,
  options: { secret: string; now?: Date },
): Promise<PinLoginOutcome> {
  const now = options.now ?? new Date();
  const device = await resolveDevice(db, app, deviceToken, { now });
  const row = device ? await pinRow(db, app.id, userId) : null;
  if (!device || !row || row.status !== 'active' || !row.pin_hash) {
    // Mismo trabajo de hash que un intento real.
    verifyPinHash(options.secret, userId, pin, null);
    return { ok: false, reason: 'invalid' };
  }
  const settings = await getKioskSettings(db, app.id);
  const check = await checkPin(db, app.id, row, pin, options.secret, now);
  if (check !== 'ok') {
    if (check.locked) return { ok: false, reason: 'locked', lockedUntil: check.locked };
    return { ok: false, reason: 'invalid', attemptsLeft: check.attemptsLeft };
  }
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + KIOSK_SESSION_HOURS * 3_600_000).toISOString();
  const { error: sesError } = await db.from('custom_app_sessions').insert({
    id: randomUUID(),
    app_id: app.id,
    app_user_id: userId,
    token_hash: hashSessionToken(token),
    expires_at: expiresAt,
    last_seen_at: now.toISOString(),
    device: device.name.slice(0, 120),
    device_id: device.id,
    idle_minutes: settings.idleMinutes,
    created_at: now.toISOString(),
  });
  if (sesError) throw sesError;
  const { error: seenError } = await db
    .from('custom_app_users')
    .update({ last_seen_at: now.toISOString() })
    .eq('id', userId);
  if (seenError) throw seenError;
  return {
    ok: true,
    token,
    expiresAt,
    idleMinutes: settings.idleMinutes,
    userId: row.id,
  };
}
