import { randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type SiteRule, decideConsent } from './consent';
import {
  PAIRING_TTL_MS,
  TOKEN_TTL_MS,
  bearerOf,
  deviceOnline,
  deviceUsable,
  generateDeviceToken,
  generatePairingCode,
  hashSecret,
  looksLikeDeviceToken,
  normalizePairingCode,
} from './credentials';
import { hostOf, siteOfUrl, validSite } from './domain';
import {
  type Command,
  type CommandBody,
  type CommandResult,
  LIMITS,
  capDecision,
  newSessionId,
  parseResult,
} from './protocol';

/**
 * Persistencia y cola de «Cortex en tu Chrome».
 *
 * Todas las funciones reciben un cliente. El de la organización
 * (`ctx.db` / `getOrgScopedClient`) para casi todo; el canje del código y la
 * autenticación del token reciben el cliente de servicio porque ocurren ANTES
 * de saber la organización (y por eso viven detrás de lib/browser-device/auth.ts,
 * una entrada permitida en tenancy-guard). Cada consulta además filtra por
 * `user_id`: el cliente de organización protege entre empresas, no entre
 * personas de la misma empresa, y el navegador de una persona es de ella sola.
 */

export const MAX_DEVICES_PER_USER = 5;
export const MAX_LIVE_SESSIONS_PER_DEVICE = 3;

export interface DeviceInfo {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  extVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  online: boolean;
}

interface DeviceDbRow {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  ext_version: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

const DEVICE_COLS =
  'id, organization_id, user_id, name, ext_version, created_at, last_seen_at, expires_at, revoked_at';

function toDevice(r: DeviceDbRow): DeviceInfo {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    name: r.name,
    extVersion: r.ext_version,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    online: deviceUsable(r) && deviceOnline(r.last_seen_at),
  };
}

// ---------------------------------------------------------------------------
// Emparejamiento
// ---------------------------------------------------------------------------

/** Un código nuevo para esta persona. Los anteriores sin usar dejan de servir. */
export async function createPairingCode(
  db: SupabaseClient,
  userId: string,
): Promise<{ code: string; expiresAt: string }> {
  const live = await listDevices(db, userId);
  if (live.filter((d) => !d.revokedAt).length >= MAX_DEVICES_PER_USER) {
    throw new Error(
      `Ya tienes ${MAX_DEVICES_PER_USER} Chrome conectados. Revoca uno antes de conectar otro.`,
    );
  }
  await db
    .from('browser_pairing_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_at', null);
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const { error } = await db
    .from('browser_pairing_codes')
    .insert({ user_id: userId, code_hash: hashSecret(code), expires_at: expiresAt });
  if (error) throw new Error('No se pudo crear el código. Intenta de nuevo.');
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true; token: string; device: { id: string; name: string }; expiresAt: string }
  | { ok: false; reason: string };

/**
 * Canjea el código por un token. `serviceDb` SIN organización: el código es lo
 * que la determina. La baja del código es atómica (`used_at is null`), así que
 * dos canjes simultáneos no pueden ganar los dos.
 */
export async function redeemPairingCode(
  serviceDb: SupabaseClient,
  rawCode: string,
  info: { deviceName: string; extVersion?: string; userAgent?: string },
): Promise<RedeemResult> {
  const code = normalizePairingCode(rawCode);
  const invalid = { ok: false as const, reason: 'Ese código no sirve o ya venció.' };
  if (!code) return invalid;
  const nowIso = new Date().toISOString();
  const { data: claimed } = await serviceDb
    .from('browser_pairing_codes')
    .update({ used_at: nowIso })
    .eq('code_hash', hashSecret(code))
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .select('organization_id, user_id')
    .maybeSingle();
  if (!claimed) return invalid;
  const owner = claimed as { organization_id: string; user_id: string };
  const { count } = await serviceDb
    .from('browser_devices')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', owner.organization_id)
    .eq('user_id', owner.user_id)
    .is('revoked_at', null);
  if ((count ?? 0) >= MAX_DEVICES_PER_USER) {
    return { ok: false, reason: 'Esta cuenta ya tiene el máximo de Chrome conectados.' };
  }
  const { token, hash, prefix } = generateDeviceToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const name = info.deviceName.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chrome';
  const { data: device, error } = await serviceDb
    .from('browser_devices')
    .insert({
      organization_id: owner.organization_id,
      user_id: owner.user_id,
      name,
      token_hash: hash,
      token_prefix: prefix,
      ext_version: info.extVersion?.slice(0, 32) ?? null,
      user_agent: info.userAgent?.slice(0, 300) ?? null,
      expires_at: expiresAt,
      last_seen_at: nowIso,
    })
    .select('id, name')
    .single();
  if (error || !device) return { ok: false, reason: 'No se pudo registrar el dispositivo.' };
  return {
    ok: true,
    token,
    device: { id: (device as { id: string }).id, name: (device as { name: string }).name },
    expiresAt,
  };
}

export interface AuthedDevice {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
}

/** Quién es el dueño de este token; null si no existe, venció o se revocó. */
export async function authenticateDeviceToken(
  serviceDb: SupabaseClient,
  authorization: string | null | undefined,
): Promise<AuthedDevice | null> {
  const token = bearerOf(authorization);
  if (!token || !looksLikeDeviceToken(token)) return null;
  const { data } = await serviceDb
    .from('browser_devices')
    .select(`${DEVICE_COLS}, token_hash`)
    .eq('token_hash', hashSecret(token))
    .maybeSingle();
  if (!data) return null;
  const row = data as DeviceDbRow;
  if (!deviceUsable(row)) return null;
  return { id: row.id, organizationId: row.organization_id, userId: row.user_id, name: row.name };
}

/** Marca de vida (y renueva el vencimiento si ya va a la mitad). */
export async function touchDevice(
  db: SupabaseClient,
  deviceId: string,
  extVersion?: string,
): Promise<void> {
  const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  if (extVersion) patch.ext_version = extVersion.slice(0, 32);
  await db.from('browser_devices').update(patch).eq('id', deviceId).is('revoked_at', null);
}

export async function renewDeviceIfNeeded(db: SupabaseClient, device: DeviceInfo): Promise<void> {
  if (new Date(device.expiresAt).getTime() - Date.now() > TOKEN_TTL_MS / 2) return;
  await db
    .from('browser_devices')
    .update({ expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString() })
    .eq('id', device.id)
    .is('revoked_at', null);
}

export async function listDevices(db: SupabaseClient, userId: string): Promise<DeviceInfo[]> {
  const { data, error } = await db
    .from('browser_devices')
    .select(DEVICE_COLS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error('No se pudieron leer tus dispositivos.');
  return ((data ?? []) as DeviceDbRow[]).map(toDevice);
}

export async function getDevice(
  db: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<DeviceInfo | null> {
  const { data } = await db
    .from('browser_devices')
    .select(DEVICE_COLS)
    .eq('id', deviceId)
    .eq('user_id', userId)
    .maybeSingle();
  return data ? toDevice(data as DeviceDbRow) : null;
}

/** El Chrome conectado de esta persona (el que habló más reciente), o null. */
export async function onlineDevice(db: SupabaseClient, userId: string): Promise<DeviceInfo | null> {
  const devices = await listDevices(db, userId);
  return (
    devices
      .filter((d) => d.online)
      .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))[0] ?? null
  );
}

/**
 * Revocar corta TODO de inmediato: el token deja de servir, las sesiones
 * abiertas se detienen y las órdenes en cola vencen.
 */
export async function revokeDevice(
  db: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await db
    .from('browser_devices')
    .update({ revoked_at: now })
    .eq('id', deviceId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (!data) return false;
  await db
    .from('browser_device_sessions')
    .update({ status: 'stopped', stopped_by: 'device', closed_at: now, awaiting: null })
    .eq('device_id', deviceId)
    .eq('status', 'open');
  await db
    .from('browser_device_commands')
    .update({ status: 'expired', payload: null, completed_at: now })
    .eq('device_id', deviceId)
    .in('status', ['pending', 'delivered']);
  return true;
}

// ---------------------------------------------------------------------------
// Reglas por sitio
// ---------------------------------------------------------------------------

export interface SiteRow {
  id: string;
  deviceId: string;
  site: string;
  decision: 'always' | 'never';
  createdAt: string;
}

export async function listSites(
  db: SupabaseClient,
  userId: string,
  deviceId?: string,
): Promise<SiteRow[]> {
  let q = db
    .from('browser_device_sites')
    .select('id, device_id, site, decision, created_at')
    .eq('user_id', userId);
  if (deviceId) q = q.eq('device_id', deviceId);
  const { data } = await q.order('site', { ascending: true });
  return ((data ?? []) as Array<Record<string, string>>).map((r) => ({
    id: r.id as string,
    deviceId: r.device_id as string,
    site: r.site as string,
    decision: r.decision as 'always' | 'never',
    createdAt: r.created_at as string,
  }));
}

export async function saveSiteRule(
  db: SupabaseClient,
  device: { id: string; userId: string },
  site: string,
  decision: 'always' | 'never',
): Promise<boolean> {
  const clean = site.toLowerCase();
  if (!validSite(clean)) return false;
  const { error } = await db
    .from('browser_device_sites')
    .upsert(
      { device_id: device.id, user_id: device.userId, site: clean, decision },
      { onConflict: 'device_id,site' },
    );
  return !error;
}

export async function deleteSiteRule(
  db: SupabaseClient,
  userId: string,
  ruleId: string,
): Promise<boolean> {
  const { data } = await db
    .from('browser_device_sites')
    .delete()
    .eq('id', ruleId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();
  return Boolean(data);
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

export interface ChromeSession {
  id: string;
  organizationId: string;
  userId: string;
  deviceId: string;
  purpose: string;
  status: 'open' | 'closed' | 'stopped';
  actionCap: number;
  actionsCount: number;
  awaiting: { kind: 'help' | 'secret'; text: string; at: string } | null;
  lastUrl: string | null;
  lastTitle: string | null;
  createdAt: string;
}

const SESSION_COLS =
  'id, organization_id, user_id, device_id, purpose, status, action_cap, actions_count, awaiting, last_url, last_title, created_at';

function toSession(r: Record<string, unknown>): ChromeSession {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    userId: r.user_id as string,
    deviceId: r.device_id as string,
    purpose: (r.purpose as string) ?? '',
    status: r.status as ChromeSession['status'],
    actionCap: r.action_cap as number,
    actionsCount: r.actions_count as number,
    awaiting: (r.awaiting as ChromeSession['awaiting']) ?? null,
    lastUrl: (r.last_url as string | null) ?? null,
    lastTitle: (r.last_title as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function openChromeSession(
  db: SupabaseClient,
  input: { userId: string; deviceId: string; conversationId?: string; purpose: string },
): Promise<ChromeSession> {
  const { count } = await db
    .from('browser_device_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('device_id', input.deviceId)
    .eq('status', 'open');
  if ((count ?? 0) >= MAX_LIVE_SESSIONS_PER_DEVICE) {
    throw new Error(
      'Ya hay varias sesiones abiertas en tu Chrome. Cierra alguna (o pulsa «Detener» en la extensión) antes de abrir otra.',
    );
  }
  const id = newSessionId(randomBytes(8).toString('hex'));
  const { data, error } = await db
    .from('browser_device_sessions')
    .insert({
      id,
      user_id: input.userId,
      device_id: input.deviceId,
      conversation_id: input.conversationId ?? null,
      purpose: input.purpose.slice(0, 200),
      action_cap: LIMITS.actionCap,
    })
    .select(SESSION_COLS)
    .single();
  if (error || !data) throw new Error('No se pudo abrir la sesión en tu Chrome.');
  void pruneOld(db);
  return toSession(data as Record<string, unknown>);
}

export async function getChromeSession(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
): Promise<ChromeSession | null> {
  const { data } = await db
    .from('browser_device_sessions')
    .select(SESSION_COLS)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  return data ? toSession(data as Record<string, unknown>) : null;
}

/** Para la extensión: la sesión debe ser DE ESTE dispositivo. */
export async function getDeviceSession(
  db: SupabaseClient,
  device: { id: string; userId: string },
  sessionId: string,
): Promise<ChromeSession | null> {
  const s = await getChromeSession(db, device.userId, sessionId);
  return s && s.deviceId === device.id ? s : null;
}

export async function endChromeSession(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  how: {
    status: 'closed' | 'stopped';
    stoppedBy?: 'person_panel' | 'person_extension' | 'cap' | 'device';
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await db
    .from('browser_device_sessions')
    .update({
      status: how.status,
      closed_at: now,
      awaiting: null,
      ...(how.stoppedBy ? { stopped_by: how.stoppedBy } : {}),
    })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('status', 'open')
    .select('id')
    .maybeSingle();
  if (data) {
    // Lo que seguía en cola ya no debe ejecutarse.
    await db
      .from('browser_device_commands')
      .update({ status: 'expired', payload: null, completed_at: now })
      .eq('session_id', sessionId)
      .in('status', ['pending', 'delivered']);
  }
  return Boolean(data);
}

export async function setAwaiting(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  awaiting: { kind: 'help' | 'secret'; text: string } | null,
): Promise<void> {
  await db
    .from('browser_device_sessions')
    .update({ awaiting: awaiting ? { ...awaiting, at: new Date().toISOString() } : null })
    .eq('id', sessionId)
    .eq('user_id', userId);
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

export function shotPath(shotId: string): string {
  return `/api/browser/chrome/shot/${shotId}`;
}

export async function saveShot(
  db: SupabaseClient,
  session: Pick<ChromeSession, 'id' | 'userId'>,
  b64: string,
): Promise<string | null> {
  const id = randomBytes(12).toString('hex');
  const { error } = await db
    .from('browser_device_shots')
    .insert({ id, user_id: session.userId, session_id: session.id, jpeg_b64: b64 });
  return error ? null : id;
}

export async function getShot(
  db: SupabaseClient,
  userId: string,
  shotId: string,
): Promise<string | null> {
  if (!/^[a-f0-9]{24}$/.test(shotId)) return null;
  const { data } = await db
    .from('browser_device_shots')
    .select('jpeg_b64')
    .eq('id', shotId)
    .eq('user_id', userId)
    .maybeSingle();
  return data ? (data as { jpeg_b64: string }).jpeg_b64 : null;
}

/** Mantenimiento perezoso: fotos de más de 2 días, auditoría de más de 90. */
async function pruneOld(db: SupabaseClient): Promise<void> {
  try {
    await db
      .from('browser_device_shots')
      .delete()
      .lt('created_at', new Date(Date.now() - 2 * 86_400_000).toISOString());
    await db
      .from('browser_device_commands')
      .delete()
      .lt('created_at', new Date(Date.now() - 90 * 86_400_000).toISOString());
  } catch {
    // Mantenimiento: nunca rompe la apertura de una sesión.
  }
}

// ---------------------------------------------------------------------------
// Cola de órdenes
// ---------------------------------------------------------------------------

function auditOf(body: CommandBody): Record<string, unknown> {
  // Qué se hizo, SIN el contenido: lo escrito solo deja su largo, el secreto ni eso.
  switch (body.op) {
    case 'fill':
    case 'select':
      return {
        op: body.op,
        ref: body.ref,
        name: body.name.slice(0, 80),
        text_len: body.text.length,
      };
    case 'click':
    case 'check':
      return { op: body.op, ref: body.ref, name: body.name.slice(0, 80) };
    case 'open':
    case 'goto':
      return { op: body.op, host: hostOf(body.url) };
    case 'secret':
      return { op: body.op, ref: body.ref, label: body.label.slice(0, 80) };
    case 'help':
      return { op: body.op, reason: body.reason.slice(0, 120) };
    case 'press':
      return { op: body.op, key: body.key };
    default:
      return { op: body.op };
  }
}

/** Reserva una acción del tope (sube el contador con compare-and-set). */
async function reserveAction(
  db: SupabaseClient,
  session: ChromeSession,
  op: CommandBody['op'],
): Promise<{ ok: true } | { ok: false; message: string }> {
  let used = session.actionsCount;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const verdict = capDecision(used, session.actionCap, op);
    if (!verdict.ok) return verdict;
    if (!verdict.counts) return { ok: true };
    const { data } = await db
      .from('browser_device_sessions')
      .update({ actions_count: used + 1 })
      .eq('id', session.id)
      .eq('status', 'open')
      .eq('actions_count', used)
      .select('actions_count')
      .maybeSingle();
    if (data) return { ok: true };
    const fresh = await getChromeSession(db, session.userId, session.id);
    if (!fresh || fresh.status !== 'open') {
      return { ok: false, message: 'Esa sesión de tu Chrome ya terminó.' };
    }
    used = fresh.actionsCount;
  }
  return { ok: false, message: 'La sesión está ocupada; intenta de nuevo.' };
}

export type RunOutcome =
  | { ok: true; result: CommandResult; thumbnail?: string }
  | { ok: false; code: string; message: string };

const POLL_EVERY_MS = 600;

/**
 * Encola una orden para el Chrome de la persona y espera su resultado.
 *
 * Los chequeos, en orden: la sesión es de ESTA persona y sigue abierta; el
 * dispositivo sigue vigente y conectado; el sitio no está prohibido ni dicho
 * «nunca»; cabe en el tope. Solo entonces se encola. La extensión vuelve a
 * hacer su parte (es la que manda).
 */
export async function runOnDevice(
  db: SupabaseClient,
  input: {
    userId: string;
    sessionId: string;
    body: CommandBody;
    protectedSites: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<RunOutcome> {
  const session = await getChromeSession(db, input.userId, input.sessionId);
  if (!session) {
    return { ok: false, code: 'no_session', message: 'Esa sesión de tu Chrome no existe.' };
  }
  if (session.status !== 'open') {
    return {
      ok: false,
      code: 'stopped',
      message:
        session.status === 'stopped'
          ? 'La persona detuvo a Cortex en su Chrome. No sigas: pregúntale si quiere continuar.'
          : 'Esa sesión de tu Chrome ya está cerrada.',
    };
  }
  const device = await getDevice(db, input.userId, session.deviceId);
  if (!device || !deviceUsable({ revoked_at: device.revokedAt, expires_at: device.expiresAt })) {
    return {
      ok: false,
      code: 'device_gone',
      message: 'Ese Chrome ya no está emparejado (se revocó o venció).',
    };
  }
  if (!device.online) {
    return {
      ok: false,
      code: 'offline',
      message:
        'Tu Chrome no está respondiendo. Pídele a la persona que abra Chrome con la extensión de Cortex activa.',
    };
  }

  const body = input.body;
  if (body.op === 'open' || body.op === 'goto') {
    const rules: SiteRule[] = (await listSites(db, input.userId)).map((r) => ({
      site: r.site,
      decision: r.decision,
    }));
    const verdict = decideConsent({
      url: body.url,
      rules,
      onceSites: [],
      protectedSites: input.protectedSites,
    });
    if (verdict.kind === 'deny') {
      return { ok: false, code: verdict.reason, message: verdict.message };
    }
  }

  const reserved = await reserveAction(db, session, body.op);
  if (!reserved.ok) return { ok: false, code: 'cap', message: reserved.message };

  const id = randomUUID();
  const full: Command = {
    ...body,
    id,
    sessionId: session.id,
    issuedAt: Date.now(),
    cap: session.actionCap,
  };
  const site =
    body.op === 'open' || body.op === 'goto'
      ? siteOfUrl(body.url)
      : siteOfUrl(session.lastUrl ?? '');
  const { error } = await db.from('browser_device_commands').insert({
    id,
    user_id: input.userId,
    device_id: device.id,
    session_id: session.id,
    op: body.op,
    site,
    audit: auditOf(body),
    payload: full,
  });
  if (error) return { ok: false, code: 'queue', message: 'No pude enviar la orden a tu Chrome.' };

  const deadline = Date.now() + (input.timeoutMs ?? 100_000);
  while (Date.now() < deadline) {
    if (input.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    const { data } = await db
      .from('browser_device_commands')
      .select('status, result, result_code')
      .eq('id', id)
      .eq('user_id', input.userId)
      .maybeSingle();
    const row = data as { status: string; result: unknown; result_code: string | null } | null;
    if (!row) break;
    if (row.status === 'expired') {
      return {
        ok: false,
        code: 'stopped',
        message: 'La orden se canceló (sesión detenida o Chrome desvinculado).',
      };
    }
    if (row.status === 'done' || row.status === 'failed') {
      const parsed = parseResult(row.result);
      // Lo que quedó guardado es solo el resumen: el contenido de la página no se archiva.
      await db
        .from('browser_device_commands')
        .update({
          result: { ok: parsed.ok ? parsed.value.ok : false, code: row.result_code },
        })
        .eq('id', id);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'bad_result',
          message: 'Tu Chrome contestó algo que no entendí.',
        };
      }
      const result = parsed.value;
      const fresh = result.page
        ? { last_url: result.page.url.slice(0, 2000), last_title: result.page.title.slice(0, 500) }
        : null;
      if (fresh) {
        await db
          .from('browser_device_sessions')
          .update(fresh)
          .eq('id', session.id)
          .eq('user_id', input.userId);
      }
      let thumbnail: string | undefined;
      if (result.shot) {
        const shotId = await saveShot(db, session, result.shot);
        if (shotId) thumbnail = shotPath(shotId);
      }
      // El base64 de la foto no vuelve al modelo.
      const { shot: _drop, ...rest } = result;
      return { ok: true, result: rest, ...(thumbnail ? { thumbnail } : {}) };
    }
  }
  await db
    .from('browser_device_commands')
    .update({ status: 'expired', payload: null, completed_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['pending', 'delivered']);
  return {
    ok: false,
    code: 'timeout',
    message: input.signal?.aborted
      ? 'Se canceló la espera.'
      : 'Tu Chrome no contestó a tiempo (¿está esperando que la persona apruebe el sitio?).',
  };
}

/** Para la extensión: las órdenes pendientes de ESTE dispositivo, marcadas como entregadas. */
export async function takePendingCommands(
  db: SupabaseClient,
  device: { id: string; userId: string },
  max = 5,
): Promise<Command[]> {
  const horizon = new Date(Date.now() - LIMITS.commandTtlMs).toISOString();
  // Lo que ya venció no se entrega nunca.
  await db
    .from('browser_device_commands')
    .update({ status: 'expired', payload: null, completed_at: new Date().toISOString() })
    .eq('device_id', device.id)
    .eq('status', 'pending')
    .lt('created_at', horizon);
  const { data } = await db
    .from('browser_device_commands')
    .select('id, payload')
    .eq('device_id', device.id)
    .eq('user_id', device.userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(max);
  const rows = (data ?? []) as Array<{ id: string; payload: Command | null }>;
  const out: Command[] = [];
  for (const row of rows) {
    // Reclamo atómico: solo una entrega por orden.
    const { data: claimed } = await db
      .from('browser_device_commands')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimed && row.payload) out.push(row.payload);
  }
  return out;
}

/** Para la extensión: el resultado de una orden entregada a ESTE dispositivo. */
export async function completeCommand(
  db: SupabaseClient,
  device: { id: string; userId: string },
  commandId: string,
  result: CommandResult,
): Promise<boolean> {
  const { data } = await db
    .from('browser_device_commands')
    .update({
      status: result.ok ? 'done' : 'failed',
      result,
      result_code: result.code ?? null,
      payload: null,
      completed_at: new Date().toISOString(),
      ...(result.site ? { site: result.site } : {}),
    })
    .eq('id', commandId)
    .eq('device_id', device.id)
    .eq('user_id', device.userId)
    .eq('status', 'delivered')
    .select('id')
    .maybeSingle();
  return Boolean(data);
}

/** Sesiones abiertas que la persona detuvo desde el chat: la extensión debe cerrarlas. */
export async function stoppedSessionsFor(
  db: SupabaseClient,
  device: { id: string; userId: string },
): Promise<string[]> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await db
    .from('browser_device_sessions')
    .select('id')
    .eq('device_id', device.id)
    .eq('user_id', device.userId)
    .in('status', ['stopped', 'closed'])
    .gte('closed_at', since)
    .limit(20);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}
