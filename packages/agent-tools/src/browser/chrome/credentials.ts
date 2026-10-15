import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Códigos de emparejamiento y tokens de dispositivo.
 *
 * DOS SECRETOS DISTINTOS, A PROPÓSITO:
 *   - El CÓDIGO (8 caracteres) vive 10 minutos, sirve una sola vez y solo
 *     canjea un token. Se escribe a mano, por eso el alfabeto no tiene
 *     caracteres que se confundan (0/O, 1/I/L).
 *   - El TOKEN (cbd_ + 32 bytes) vive en la extensión. En la base solo existe
 *     su hash SHA-256: quien lea la tabla no puede hacerse pasar por el
 *     dispositivo. El token no tiene más poder que las rutas /api/extension.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 símbolos
export const PAIRING_TTL_MS = 10 * 60_000;
export const TOKEN_TTL_MS = 90 * 24 * 3_600_000;
export const TOKEN_PREFIX = 'cbd_';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** 8 caracteres, mostrados como XXXX-XXXX. ~39.6 bits. */
export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    // Rechazo por sesgo: 248 es el mayor múltiplo de 31 bajo 256.
    let b = bytes[i] as number;
    while (b >= 248) b = randomBytes(1)[0] as number;
    out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Lo que la persona escribió → forma canónica, o null si no puede ser un código. */
export function normalizePairingCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== 8) return null;
  for (const ch of raw) if (!CODE_ALPHABET.includes(ch)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function generateDeviceToken(): { token: string; hash: string; prefix: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashSecret(token), prefix: token.slice(0, 10) };
}

/** Forma válida de un token, antes de tocar la base. */
export function looksLikeDeviceToken(token: string): boolean {
  return /^cbd_[A-Za-z0-9_-]{43}$/.test(token);
}

/** Comparación en tiempo constante de dos hashes hex. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** El token de un encabezado `Authorization: Bearer …`, o null. */
export function bearerOf(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

export interface DeviceRow {
  revoked_at: string | null;
  expires_at: string;
}

/** ¿Este dispositivo puede usarse ahora? Revocado o vencido: no. */
export function deviceUsable(row: DeviceRow, now = Date.now()): boolean {
  return !row.revoked_at && new Date(row.expires_at).getTime() > now;
}

/** ¿Un dispositivo se considera conectado? (hizo poll hace poco) */
export const ONLINE_WINDOW_MS = 75_000;
export function deviceOnline(lastSeenAt: string | null, now = Date.now()): boolean {
  return Boolean(lastSeenAt) && now - new Date(lastSeenAt as string).getTime() < ONLINE_WINDOW_MS;
}
