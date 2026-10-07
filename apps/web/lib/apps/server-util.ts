import 'server-only';
import { headers } from 'next/headers';

/** La llave del servidor con la que se mezclan códigos y PIN antes de guardarlos. */
export function appSecret(): string {
  const key = (process.env.BETTER_AUTH_SECRET ?? '').trim();
  if (!key && process.env.NODE_ENV === 'production') throw new Error('BETTER_AUTH_SECRET missing');
  return key || 'cortex-dev-app-login';
}

/** La IP de quien llama, corta, sólo para los topes en memoria. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip')?.trim() ||
    'sin-ip'
  ).slice(0, 64);
}
