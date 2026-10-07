import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requiredAttributes, roleKeySchema } from './permissions';
import {
  APP_COLUMNS,
  type AppAccess,
  type CustomAppRow,
  adaptApp,
  attributesSchema,
  getApp,
  listRoles,
  listScreens,
} from './store';

/**
 * LOS USUARIOS EXTERNOS DE UNA APLICACIÓN (migración 0209).
 *
 * Un operario o un cliente no tienen cuenta de Cortex: reciben un enlace por
 * correo, escriben un código de 6 dígitos y entran a SU app con SU rol. Aquí
 * vive todo lo que decide eso, sin tocar el navegador (la cookie y la ruta
 * son de la capa web, lib/apps/external-session.ts):
 *
 *   - el CÓDIGO: 6 dígitos, vence a los 10 minutos, se guarda sólo su hash y
 *     se bloquea a los 5 intentos fallidos. Pedir códigos nuevos también tiene
 *     tope por usuario (CODES_PER_HOUR), si no, 5 intentos por código serían
 *     un millón de intentos con paciencia.
 *   - NO REVELAR SI EL CORREO EXISTE: `requestLoginCode` y `verifyLoginCode`
 *     devuelven lo mismo para «no hay ese correo», «está desactivado» y
 *     «código malo»; la ruta contesta el mismo mensaje en los tres casos.
 *   - la SESIÓN: un token al azar que sólo vive en la cookie; el servidor
 *     guarda su sha256. Vence a los 30 días y se desliza (cada uso la
 *     renueva). Desactivar al usuario o cerrar sesión la revoca, y
 *     `resolveExternalSession` vuelve a mirar al usuario en CADA petición:
 *     un desactivado queda fuera en la siguiente, sin esperar a que venza.
 *
 * `db` es el handle con alcance de espacio. La única lectura sin alcance es
 * `findPublishedApp` (encontrar la app por id para saber de qué empresa es),
 * como `findViewByToken` en las vistas.
 */

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const CODES_PER_HOUR = 5;
export const SESSION_DAYS = 30;
/** La sesión se renueva (se desliza) a lo sumo una vez por hora, para no escribir en cada petición. */
export const SESSION_TOUCH_MINUTES = 60;
export const MAX_APP_USERS_IMPORT = 500;
/** Minutos sin uso de una sesión de kiosco cuando la fila no los trae (kiosk.ts los fija al entrar). */
const DEFAULT_IDLE_MINUTES = 5;

const USER_COLUMNS =
  'id, app_id, name, email, role_key, attributes, status, invited_at, last_seen_at, created_by, created_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type AppUserStatus = 'invited' | 'active' | 'disabled';

export interface ExternalUserRow {
  id: string;
  app_id: string;
  name: string;
  email: string;
  role_key: string;
  attributes: Record<string, string>;
  status: AppUserStatus;
  invited_at: string | null;
  last_seen_at: string | null;
  created_by: string | null;
  created_at: string;
}

function adaptUser(row: Record<string, unknown>): ExternalUserRow {
  const attrs = attributesSchema.safeParse(row.attributes);
  return {
    ...(row as unknown as ExternalUserRow),
    attributes: attrs.success ? attrs.data : {},
    invited_at: typeof row.invited_at === 'string' ? row.invited_at : null,
    last_seen_at: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
  };
}

// ---------------------------------------------------------------------------
// Primitivas puras
// ---------------------------------------------------------------------------

export function normalizeAppEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 200 && EMAIL_RE.test(email);
}

/** Seis dígitos, con ceros a la izquierda. */
export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Un código mal escrito («123 456», con guiones) se limpia antes de comparar. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * El hash del código: HMAC con la llave del servidor y el usuario, no un sha256
 * pelado — un millón de códigos posibles se invertirían al instante.
 */
export function hashLoginCode(secret: string, userId: string, code: string): string {
  return createHmac('sha256', secret).update(`${userId}:${code}`).digest('base64url');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** El token es aleatorio de 256 bits: un sha256 sin sal alcanza para guardarlo. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_DAYS * 86_400_000);
}

/** Un nombre corto del dispositivo a partir del user agent: «Chrome · Android». */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Navegador';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iPhone'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return (os ? `${browser} · ${os}` : browser).slice(0, 120);
}

// ---------------------------------------------------------------------------
// La app, vista desde afuera
// ---------------------------------------------------------------------------

export interface PublishedApp extends CustomAppRow {
  organization_id: string;
}

/**
 * Busca la app por id con el cliente de servicio SIN alcance: quien abre
 * /a/<id> no tiene sesión, así que todavía no se sabe de qué empresa es. Sólo
 * devuelve apps publicadas y no archivadas; todo lo demás es null, sin
 * distinguir (la ruta contesta lo mismo). Lo que sigue se lee con el handle
 * de la empresa que esta fila trae.
 */
export async function findPublishedApp(
  serviceDb: SupabaseClient,
  id: string,
): Promise<PublishedApp | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await serviceDb
    .from('custom_apps')
    .select(APP_COLUMNS)
    .eq('id', id)
    .eq('status', 'published')
    .is('archived_at', null)
    .maybeSingle();
  if (error || !data) return null;
  const row = adaptApp(data as Record<string, unknown>);
  return { ...row, organization_id: String((data as { organization_id: string }).organization_id) };
}

// ---------------------------------------------------------------------------
// Administrar usuarios (editor de la app)
// ---------------------------------------------------------------------------

export const appUserInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().transform(normalizeAppEmail).refine(isValidEmail, 'Ese correo no es válido.'),
  roleKey: roleKeySchema,
  attributes: attributesSchema.optional(),
});
export type AppUserInput = z.input<typeof appUserInputSchema>;

export async function listAppUsers(db: SupabaseClient, appId: string): Promise<ExternalUserRow[]> {
  const { data, error } = await db
    .from('custom_app_users')
    .select(USER_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => adaptUser(r as Record<string, unknown>));
}

async function mustGetUser(db: SupabaseClient, appId: string, id: string) {
  const { data, error } = await db
    .from('custom_app_users')
    .select(USER_COLUMNS)
    .eq('app_id', appId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Ese usuario ya no está en la aplicación.');
  return adaptUser(data as Record<string, unknown>);
}

async function assertRole(
  db: SupabaseClient,
  appId: string,
  roleKey: string,
  attributes: Record<string, string> = {},
) {
  const roles = await listRoles(db, appId);
  const role = roles.find((r) => r.key === roleKey);
  if (!role) throw new ValidationError(`La aplicación no tiene el rol «${roleKey}».`);
  // Portal de clientes: un rol que filtra filas por atributo no sirve sin ese atributo
  // (la persona entraría y no vería nada). Se pide al invitar, con el valor real.
  const missing = requiredAttributes(role.permissions).filter((a) => !attributes[a]?.trim());
  if (missing.length)
    throw new ValidationError(
      `El rol «${role.name}» ve las filas según ${missing.map((m) => `«${m}»`).join(', ')}: indica ${missing.length === 1 ? 'ese dato' : 'esos datos'} de la persona.`,
    );
}

/**
 * Invita (o actualiza) a un usuario externo por correo. Si el correo ya está
 * en la app se cambian su nombre, rol y atributos; un desactivado se reactiva
 * sólo con `setAppUserStatus`, nunca por reinvitar.
 */
export async function inviteAppUser(
  db: SupabaseClient,
  appId: string,
  raw: AppUserInput,
  by: string,
): Promise<{ user: ExternalUserRow; created: boolean }> {
  const input = appUserInputSchema.parse(raw);
  await assertRole(db, appId, input.roleKey, input.attributes ?? {});
  const existing = (await listAppUsers(db, appId)).find((u) => u.email === input.email);
  const patch = {
    name: input.name,
    role_key: input.roleKey,
    attributes: input.attributes ?? {},
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const { data, error } = await db
      .from('custom_app_users')
      .update(patch)
      .eq('app_id', appId)
      .eq('id', existing.id)
      .select(USER_COLUMNS)
      .single();
    if (error) throw error;
    return { user: adaptUser(data as Record<string, unknown>), created: false };
  }
  const { data, error } = await db
    .from('custom_app_users')
    .insert({
      id: randomUUID(),
      app_id: appId,
      email: input.email,
      status: 'invited',
      invited_at: new Date().toISOString(),
      created_by: by,
      ...patch,
    })
    .select(USER_COLUMNS)
    .single();
  if (error) throw error;
  return { user: adaptUser(data as Record<string, unknown>), created: true };
}

export interface ImportResult {
  invited: ExternalUserRow[];
  skipped: Array<{ line: number; reason: string }>;
}

/**
 * Importa una lista (la fila 1 ya sin encabezado). Cada fila: nombre, correo,
 * rol y atributos opcionales. Una fila mala se salta con su razón; no tumba
 * a las demás.
 */
export async function importAppUsers(
  db: SupabaseClient,
  appId: string,
  rows: Array<{
    name: string;
    email: string;
    roleKey: string;
    attributes?: Record<string, string>;
  }>,
  by: string,
): Promise<ImportResult> {
  if (rows.length > MAX_APP_USERS_IMPORT)
    throw new ValidationError(`Se importan hasta ${MAX_APP_USERS_IMPORT} usuarios por vez.`);
  const out: ImportResult = { invited: [], skipped: [] };
  for (const [i, row] of rows.entries()) {
    try {
      const { user } = await inviteAppUser(db, appId, row, by);
      out.invited.push(user);
    } catch (err) {
      const reason =
        err instanceof z.ZodError
          ? (err.issues[0]?.message ?? 'Datos no válidos.')
          : err instanceof Error
            ? err.message
            : 'No se pudo importar.';
      out.skipped.push({ line: i + 1, reason });
    }
  }
  return out;
}

export async function updateAppUser(
  db: SupabaseClient,
  appId: string,
  id: string,
  input: { name?: string; roleKey?: string; attributes?: Record<string, string> },
): Promise<ExternalUserRow> {
  const current = await mustGetUser(db, appId, id);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = z.string().trim().min(1).max(80).parse(input.name);
  if (input.attributes !== undefined) patch.attributes = attributesSchema.parse(input.attributes);
  if (input.roleKey !== undefined || input.attributes !== undefined) {
    // El rol y los atributos se juzgan juntos: quien pasa a «Cliente» trae su cliente.
    const attrs = (patch.attributes as Record<string, string> | undefined) ?? current.attributes;
    await assertRole(db, appId, input.roleKey ?? current.role_key, attrs);
  }
  if (input.roleKey !== undefined) patch.role_key = input.roleKey;
  const { data, error } = await db
    .from('custom_app_users')
    .update(patch)
    .eq('app_id', appId)
    .eq('id', id)
    .select(USER_COLUMNS)
    .single();
  if (error) throw error;
  return adaptUser(data as Record<string, unknown>);
}

/**
 * Desactivar corta TODAS sus sesiones en el mismo paso: no se espera a que
 * venzan. Reactivar lo deja «invitado» (vuelve a entrar con código).
 */
export async function setAppUserStatus(
  db: SupabaseClient,
  appId: string,
  id: string,
  status: 'active' | 'disabled',
): Promise<ExternalUserRow> {
  const user = await mustGetUser(db, appId, id);
  const next: AppUserStatus =
    status === 'disabled' ? 'disabled' : user.last_seen_at ? 'active' : 'invited';
  const { data, error } = await db
    .from('custom_app_users')
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq('app_id', appId)
    .eq('id', id)
    .select(USER_COLUMNS)
    .single();
  if (error) throw error;
  if (status === 'disabled') await revokeUserSessions(db, id);
  return adaptUser(data as Record<string, unknown>);
}

export async function removeAppUser(db: SupabaseClient, appId: string, id: string) {
  await revokeUserSessions(db, id);
  const { error } = await db.from('custom_app_users').delete().eq('app_id', appId).eq('id', id);
  if (error) throw error;
}

/** Marca como enviada la invitación (vuelve a empezar su reloj). */
export async function markInvited(db: SupabaseClient, appId: string, id: string) {
  const { error } = await db
    .from('custom_app_users')
    .update({ invited_at: new Date().toISOString() })
    .eq('app_id', appId)
    .eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Código de entrada
// ---------------------------------------------------------------------------

async function findUserByEmail(
  db: SupabaseClient,
  appId: string,
  email: string,
): Promise<ExternalUserRow | null> {
  const { data, error } = await db
    .from('custom_app_users')
    .select(USER_COLUMNS)
    .eq('app_id', appId)
    .eq('email', normalizeAppEmail(email))
    .maybeSingle();
  if (error) throw error;
  return data ? adaptUser(data as Record<string, unknown>) : null;
}

export type CodeRequest =
  /** Hay que mandar el correo con este código a esta persona. */
  | { issued: true; code: string; user: ExternalUserRow }
  /** No hay nada que mandar (no existe, desactivado, tope). La ruta contesta igual. */
  | { issued: false };

/**
 * Crea un código de entrada para ese correo. NUNCA dice por qué no lo creó:
 * correo desconocido, usuario desactivado o tope de la hora son `issued:
 * false` y la ruta contesta lo mismo que cuando sí lo mandó.
 */
export async function requestLoginCode(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  email: string,
  options: { secret: string; now?: Date },
): Promise<CodeRequest> {
  const now = options.now ?? new Date();
  const user = await findUserByEmail(db, app.id, email);
  if (!user || user.status === 'disabled') return { issued: false };
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const { count, error } = await db
    .from('custom_app_login_codes')
    .select('id', { count: 'exact', head: true })
    .eq('app_user_id', user.id)
    .gte('created_at', since);
  if (error) throw error;
  if ((count ?? 0) >= CODES_PER_HOUR) return { issued: false };
  // Un código nuevo anula los anteriores: sólo vale el último.
  const { error: voidError } = await db
    .from('custom_app_login_codes')
    .update({ consumed_at: now.toISOString() })
    .eq('app_user_id', user.id)
    .is('consumed_at', null);
  if (voidError) throw voidError;
  const code = generateLoginCode();
  const { error: insError } = await db.from('custom_app_login_codes').insert({
    id: randomUUID(),
    app_id: app.id,
    app_user_id: user.id,
    code_hash: hashLoginCode(options.secret, user.id, code),
    channel: 'email',
    expires_at: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000).toISOString(),
    attempts: 0,
    created_at: now.toISOString(),
  });
  if (insError) throw insError;
  return { issued: true, code, user };
}

export type LoginOutcome =
  | { ok: true; token: string; expiresAt: string; user: ExternalUserRow }
  /** Un solo fallo para todo: no existe, desactivado, vencido, bloqueado o equivocado. */
  | { ok: false };

/**
 * Comprueba el código y, si es el bueno, abre una sesión. Cada fallo cuenta un
 * intento sobre el código vigente; al quinto ese código queda bloqueado
 * (`attempts >= 5`) aunque después se escriba bien.
 */
export async function verifyLoginCode(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  email: string,
  rawCode: string,
  options: { secret: string; device?: string; now?: Date },
): Promise<LoginOutcome> {
  const now = options.now ?? new Date();
  const code = cleanCode(rawCode);
  const user = await findUserByEmail(db, app.id, email);
  // El mismo trabajo de hash aunque no haya usuario: no se distingue por tiempo.
  const probe = hashLoginCode(options.secret, user?.id ?? 'sin-usuario', code);
  if (!user || user.status === 'disabled' || code.length !== 6) return { ok: false };

  const { data, error } = await db
    .from('custom_app_login_codes')
    .select('id, code_hash, expires_at, attempts')
    .eq('app_user_id', user.id)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const current = (data ?? [])[0] as
    | { id: string; code_hash: string; expires_at: string; attempts: number }
    | undefined;
  if (!current) return { ok: false };
  if (new Date(current.expires_at).getTime() <= now.getTime()) return { ok: false };
  if (current.attempts >= MAX_CODE_ATTEMPTS) return { ok: false };

  if (!sameHash(probe, current.code_hash)) {
    const { error: upError } = await db
      .from('custom_app_login_codes')
      .update({ attempts: current.attempts + 1 })
      .eq('id', current.id);
    if (upError) throw upError;
    return { ok: false };
  }

  const { error: useError } = await db
    .from('custom_app_login_codes')
    .update({ consumed_at: now.toISOString() })
    .eq('id', current.id);
  if (useError) throw useError;
  const token = newSessionToken();
  const expiresAt = sessionExpiry(now).toISOString();
  const { error: sesError } = await db.from('custom_app_sessions').insert({
    id: randomUUID(),
    app_id: app.id,
    app_user_id: user.id,
    token_hash: hashSessionToken(token),
    expires_at: expiresAt,
    last_seen_at: now.toISOString(),
    device: (options.device ?? '').slice(0, 120),
    created_at: now.toISOString(),
  });
  if (sesError) throw sesError;
  const { error: seenError } = await db
    .from('custom_app_users')
    .update({ status: 'active', last_seen_at: now.toISOString() })
    .eq('id', user.id);
  if (seenError) throw seenError;
  return { ok: true, token, expiresAt, user: { ...user, status: 'active' } };
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

export interface ExternalSession {
  sessionId: string;
  user: ExternalUserRow;
  expiresAt: string;
  /** True si esta lectura renovó la sesión: la ruta vuelve a escribir la cookie. */
  renewed: boolean;
  /** Si es una sesión de kiosco (0211): el dispositivo donde se abrió y sus minutos sin uso. */
  deviceId: string | null;
  idleMinutes: number | null;
}

/**
 * Resuelve el token de la cookie a un usuario, o null. Se llama en CADA
 * petición y mira de nuevo todo: sesión no revocada ni vencida, de ESTA app, y
 * usuario que sigue «activo» con un rol que existe. Por eso desactivar a
 * alguien lo saca en la siguiente petición.
 */
export async function resolveExternalSession(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  token: string | null | undefined,
  options: { now?: Date } = {},
): Promise<ExternalSession | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const now = options.now ?? new Date();
  const { data, error } = await db
    .from('custom_app_sessions')
    .select('id, app_user_id, expires_at, last_seen_at, revoked_at, device_id, idle_minutes')
    .eq('app_id', app.id)
    .eq('token_hash', hashSessionToken(token))
    .maybeSingle();
  if (error) throw error;
  const session = data as {
    id: string;
    app_user_id: string;
    expires_at: string;
    last_seen_at: string;
    revoked_at: string | null;
    device_id?: string | null;
    idle_minutes?: number | null;
  } | null;
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= now.getTime()) return null;
  const user = await mustGetUser(db, app.id, session.app_user_id).catch(() => null);
  if (!user || user.status !== 'active') return null;
  const roles = await listRoles(db, app.id);
  if (!roles.some((r) => r.key === user.role_key)) return null;

  if (session.device_id) {
    // SESIÓN DE KIOSCO (0211): vive sólo mientras su dispositivo siga autorizado
    // y la persona lo use. Sin uso durante `idle_minutes` se cierra sola (queda
    // revocada, no sólo ignorada) y el celular vuelve a la lista de nombres.
    const idleMinutes = session.idle_minutes ?? DEFAULT_IDLE_MINUTES;
    const idle = now.getTime() - new Date(session.last_seen_at).getTime();
    const closeIt = async () => {
      await db
        .from('custom_app_sessions')
        .update({ revoked_at: now.toISOString() })
        .eq('id', session.id)
        .is('revoked_at', null);
      return null;
    };
    if (idle >= idleMinutes * 60_000) return closeIt();
    const { data: device, error: deviceError } = await db
      .from('custom_app_devices')
      .select('id, revoked_at, token_hash')
      .eq('app_id', app.id)
      .eq('id', session.device_id)
      .maybeSingle();
    if (deviceError) throw deviceError;
    const dev = device as { revoked_at: string | null; token_hash: string | null } | null;
    if (!dev || dev.revoked_at || !dev.token_hash) return closeIt();
    if (idle >= 15_000) {
      // El «último uso» sube en cada petición (con un respiro de segundos): es lo que mide la inactividad.
      const { error: touchError } = await db
        .from('custom_app_sessions')
        .update({ last_seen_at: now.toISOString() })
        .eq('id', session.id);
      if (touchError) throw touchError;
    }
    return {
      sessionId: session.id,
      user,
      expiresAt: session.expires_at,
      renewed: false,
      deviceId: session.device_id,
      idleMinutes,
    };
  }

  let expiresAt = session.expires_at;
  let renewed = false;
  const idleMs = now.getTime() - new Date(session.last_seen_at).getTime();
  if (idleMs >= SESSION_TOUCH_MINUTES * 60_000) {
    expiresAt = sessionExpiry(now).toISOString();
    const { error: touchError } = await db
      .from('custom_app_sessions')
      .update({ last_seen_at: now.toISOString(), expires_at: expiresAt })
      .eq('id', session.id);
    if (touchError) throw touchError;
    const { error: seenError } = await db
      .from('custom_app_users')
      .update({ last_seen_at: now.toISOString() })
      .eq('id', user.id);
    if (seenError) throw seenError;
    renewed = true;
  }
  return { sessionId: session.id, user, expiresAt, renewed, deviceId: null, idleMinutes: null };
}

/** Cerrar ESTA sesión (el token de la cookie). */
export async function revokeSessionByToken(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  token: string,
): Promise<void> {
  const { error } = await db
    .from('custom_app_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('app_id', app.id)
    .eq('token_hash', hashSessionToken(token))
    .is('revoked_at', null);
  if (error) throw error;
}

/** «Cerrar todas mis sesiones» y desactivar: todas las de ese usuario. */
export async function revokeUserSessions(db: SupabaseClient, appUserId: string): Promise<void> {
  const { error } = await db
    .from('custom_app_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('app_user_id', appUserId)
    .is('revoked_at', null);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Acceso resuelto
// ---------------------------------------------------------------------------

/**
 * El `AppAccess` de un usuario externo: el mismo que arma `resolveAppAccess`
 * para un miembro, con `user.external = true` para que «own» mire
 * `created_by_app_user`. El administrador nunca es externo.
 */
export async function externalAppAccess(
  db: SupabaseClient,
  app: CustomAppRow,
  user: ExternalUserRow,
): Promise<AppAccess | null> {
  if (app.status !== 'published' || user.status !== 'active') return null;
  const role = (await listRoles(db, app.id)).find((r) => r.key === user.role_key);
  if (!role) return null;
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  return {
    app,
    screens,
    role: { key: role.key, name: role.name, permissions: role.permissions, admin: false },
    user: { id: user.id, name: user.name, attributes: user.attributes, external: true },
  };
}

/** Para la ruta: la app de la empresa (con su handle) por id, vista como un miembro la vería. */
export async function appOfOrganization(db: SupabaseClient, id: string): Promise<CustomAppRow> {
  const app = await getApp(db, id);
  if (!app) throw new NotFoundError('Esa aplicación no existe.');
  return app;
}

// ---------------------------------------------------------------------------
// Importar desde CSV
// ---------------------------------------------------------------------------

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function headerKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Lee un CSV de usuarios: encabezado con `nombre`, `correo` y `rol`; cualquier
 * otra columna es un atributo ($user.<columna> en los filtros). Acepta coma,
 * punto y coma o tabulador (Excel en español exporta con punto y coma).
 */
export function parseUsersCsv(text: string): {
  rows: Array<{ name: string; email: string; roleKey: string; attributes: Record<string, string> }>;
  error: string | null;
} {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const first = lines[0];
  if (!first) return { rows: [], error: 'El archivo está vacío.' };
  const delimiter = [';', '\t', ','].sort(
    (a, b) => first.split(b).length - first.split(a).length,
  )[0] as string;
  const headers = splitCsvLine(first, delimiter).map(headerKey);
  const nameCol = headers.findIndex((h) => ['nombre', 'name'].includes(h));
  const emailCol = headers.findIndex((h) =>
    ['correo', 'email', 'e_mail', 'correo_electronico'].includes(h),
  );
  const roleCol = headers.findIndex((h) => ['rol', 'role'].includes(h));
  if (nameCol < 0 || emailCol < 0 || roleCol < 0)
    return {
      rows: [],
      error: 'La primera fila debe tener las columnas «nombre», «correo» y «rol».',
    };
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line, delimiter);
    const attributes: Record<string, string> = {};
    for (const [i, h] of headers.entries()) {
      if (i === nameCol || i === emailCol || i === roleCol) continue;
      const v = (cells[i] ?? '').trim();
      if (v && /^[a-z][a-z0-9_]{0,39}$/.test(h)) attributes[h] = v.slice(0, 120);
    }
    return {
      name: cells[nameCol] ?? '',
      email: cells[emailCol] ?? '',
      roleKey: headerKey(cells[roleCol] ?? ''),
      attributes,
    };
  });
  return { rows, error: rows.length ? null : 'No hay usuarios debajo del encabezado.' };
}
