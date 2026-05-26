import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from './env';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const b = Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, 'base64');
  if (b.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  return b;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptToken(packed: string): string {
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = createDecipheriv(ALGO, getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
