import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ACCOUNTING_ENTITIES, type AccountingEntity } from '@cortex/agent-tools';
import { getEnv } from '@cortex/core';

/**
 * EL `state` DE LA CONEXIÓN CON QUICKBOOKS (OAuth de Intuit), PURO.
 *
 * Conectar QuickBooks es ir a Intuit y volver. El `state` que viaja de ida y
 * vuelta hace tres cosas:
 *
 *   1. CSRF: lleva un `nonce` que también queda en una cookie httpOnly del
 *      navegador que empezó; una vuelta que no trae los dos iguales no conecta
 *      nada (lo mismo que hacen Google y Microsoft con su cookie).
 *   2. Ata la vuelta a QUIEN empezó y a QUÉ espacio: va firmado (HMAC-SHA256
 *      con una llave derivada de TOKEN_ENCRYPTION_KEY, separada por dominio
 *      como en mcp-confirm.ts) con el usuario y la organización. Si al volver
 *      la sesión es de otra persona u otro espacio, no se conecta.
 *   3. Lleva lo que el administrador eligió en la tarjeta (qué traer, cada
 *      cuánto, si avisa), para no guardarlo en ningún lado mientras tanto.
 *
 * Vive diez minutos. Nada de esto es secreto —la firma es lo que importa—, y
 * ningún token de Intuit pasa por aquí.
 */

const STATE_TTL_MS = 10 * 60_000;
const HMAC_DOMAIN = 'cortex-quickbooks-oauth-state';
export const QUICKBOOKS_STATE_COOKIE = 'qb_oauth_state';
export const QUICKBOOKS_CALLBACK_PATH = '/api/integrations/quickbooks/callback';

export interface QuickbooksSettings {
  entities: AccountingEntity[];
  intervalMinutes: number;
  notify: boolean;
}

export interface QuickbooksState extends QuickbooksSettings {
  userId: string;
  organizationId: string;
  nonce: string;
  expiresAt: number;
}

export function quickbooksStateKey(): Buffer {
  const master = Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, 'base64');
  return createHmac('sha256', master).update(HMAC_DOMAIN).digest();
}

function sign(encoded: string, key: Buffer): string {
  return createHmac('sha256', key).update(encoded).digest('base64url');
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function mintQuickbooksState(
  input: Omit<QuickbooksState, 'expiresAt'>,
  key: Buffer,
  now = Date.now(),
): string {
  const payload: QuickbooksState = { ...input, expiresAt: now + STATE_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, key)}`;
}

/**
 * La vuelta: firma válida (en tiempo constante), vigente, con el mismo nonce
 * que la cookie y de la misma persona y espacio que la sesión. `null` si algo
 * no cuadra, sin decir qué: la ruta responde lo mismo en todos los casos.
 */
export function readQuickbooksState(
  state: string | null | undefined,
  key: Buffer,
  expected: { userId: string; organizationId: string; nonce: string | null | undefined },
  now = Date.now(),
): QuickbooksState | null {
  if (!state || !expected.nonce) return null;
  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;
  const encoded = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1));
  const wanted = Buffer.from(sign(encoded, key));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  let payload: QuickbooksState;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as QuickbooksState;
  } catch {
    return null;
  }
  if (typeof payload?.expiresAt !== 'number' || payload.expiresAt <= now) return null;
  if (payload.nonce !== expected.nonce) return null;
  if (payload.userId !== expected.userId || payload.organizationId !== expected.organizationId)
    return null;
  const settings = cleanQuickbooksSettings({
    entities: payload.entities,
    interval: String(payload.intervalMinutes),
    notify: payload.notify ? '1' : '0',
  });
  return settings ? { ...payload, ...settings } : null;
}

/** Lo que la tarjeta mandó en la dirección de inicio (`?entities=…&interval=…&notify=1`). */
export function cleanQuickbooksSettings(raw: {
  entities: string | readonly string[] | null | undefined;
  interval: string | null | undefined;
  notify: string | null | undefined;
}): QuickbooksSettings | null {
  const list = Array.isArray(raw.entities)
    ? raw.entities
    : String(raw.entities ?? '')
        .split(',')
        .map((s) => s.trim());
  const wanted = new Set(list);
  const entities = ACCOUNTING_ENTITIES.filter((e) => wanted.has(e));
  if (!entities.length) return null;
  const interval = Math.round(Number(raw.interval ?? 60));
  if (!Number.isFinite(interval) || interval < 15 || interval > 1440) return null;
  return { entities, intervalMinutes: interval, notify: raw.notify !== '0' };
}

/** A dónde vuelve Intuit: la que esté registrada en la app de Intuit, exactamente. */
export function quickbooksRedirectUri(): string {
  const explicit = process.env.QUICKBOOKS_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  return new URL(QUICKBOOKS_CALLBACK_PATH, getEnv().APP_BASE_URL).toString();
}

const ERRORS: Record<string, string> = {
  quickbooks_not_configured:
    'Falta configurar la app de QuickBooks en esta instalación. Quien administra Cortex tiene que registrarla en Intuit.',
  quickbooks_admin: 'Sólo quien administra el espacio puede conectar QuickBooks.',
  quickbooks_settings: 'Elige al menos una cosa para traer de QuickBooks y vuelve a intentarlo.',
  quickbooks_state:
    'La conexión con QuickBooks venció o se empezó desde otra sesión. Vuelve a intentarlo desde la tarjeta.',
  quickbooks_denied: 'No diste permiso en Intuit, así que QuickBooks no quedó conectado.',
  quickbooks_forbidden:
    'Ese usuario de QuickBooks no puede leer la contabilidad de la empresa. Conecta con un usuario administrador en QuickBooks.',
  quickbooks_setup:
    'Intuit no reconoció la conexión de QuickBooks de Cortex. Avísale al equipo de Cortex para que la revise y vuelve a intentarlo.',
  quickbooks_failed: 'Intuit no confirmó la conexión. Vuelve a intentarlo en un momento.',
};

/** El código de la vuelta para un error de QuickBooks (`QuickBooksError.kind`). */
export function quickbooksErrorCode(kind: string | null | undefined): string {
  if (kind === 'forbidden') return 'quickbooks_forbidden';
  if (kind === 'setup') return 'quickbooks_setup';
  return 'quickbooks_failed';
}

/** La frase para la pantalla de Integraciones a partir del código de la vuelta, o `null`. */
export function quickbooksErrorMessage(code: string | null | undefined): string | null {
  if (!code?.startsWith('quickbooks_')) return null;
  return ERRORS[code] ?? ERRORS.quickbooks_failed ?? null;
}
