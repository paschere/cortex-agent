import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * URLs firmadas para app_files — el reemplazo de `createSignedUrl` de Supabase
 * Storage (migración 0109).
 *
 * QUIÉN LAS CONSUME. Deepgram: la transcripción no sube el audio, le pasa a
 * Deepgram una URL y él lo baja solo (ver inngest/functions/ingest-document.ts).
 * Esa URL tiene que funcionar sin cookie de sesión — Deepgram no es un usuario —
 * así que el token ES la autorización, igual que lo era la signed URL.
 *
 * FORMA. `base64url(payload JSON).base64url(HMAC-SHA256(payload))`, firmado con
 * JOBS_SECRET — el mismo secreto que ya autentica al worker de la cola, que
 * vive exactamente en los entornos que necesitan firmar (Vercel) y en ningún
 * cliente. El payload lleva bucket, path y expiración; la firma cubre el
 * payload entero, así que ni la ruta ni la vida útil se pueden alterar sin
 * invalidar el token.
 *
 * Este módulo es puro (crypto + strings) y `server-only`: un token de estos en
 * un bundle de cliente regalaría la capacidad de fabricar URLs de descarga.
 */

export interface BlobTokenPayload {
  bucket: string;
  path: string;
  /** Epoch ms. Pasada esta hora el token no verifica. */
  expiresAt: number;
}

function secret(): string {
  return (process.env.JOBS_SECRET ?? '').trim();
}

function sign(encodedPayload: string, key: string): string {
  return createHmac('sha256', key).update(encodedPayload).digest('base64url');
}

/** Firma un token de descarga de vida corta. Lanza si JOBS_SECRET no existe. */
export function mintBlobToken(payload: BlobTokenPayload): string {
  const key = secret();
  if (!key) throw new Error('JOBS_SECRET is not configured; cannot mint blob tokens');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, key)}`;
}

/**
 * Verifica un token: firma válida (en tiempo constante) y no expirado.
 * Devuelve el payload, o null — sin distinguir por qué falló, porque la ruta
 * pública que llama esto responde el mismo 404 genérico en todos los casos.
 */
export function verifyBlobToken(token: string): BlobTokenPayload | null {
  const key = secret();
  if (!key) return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const givenSignature = token.slice(dot + 1);

  const expected = Buffer.from(sign(encoded, key));
  const given = Buffer.from(givenSignature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let payload: BlobTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as BlobTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.bucket !== 'string' ||
    typeof payload.path !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }
  if (payload.expiresAt <= Date.now()) return null;
  return payload;
}
