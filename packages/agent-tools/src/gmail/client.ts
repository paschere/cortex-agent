import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Lo MÍNIMO que hace falta para hablar con Gmail: un token y con qué cancelar.
 *
 * Se escribe así, y no como `ToolContext`, porque desde la 0121 hay dos
 * llamadores que no son una herramienta — la carga histórica de un buzón y el
 * barrido de cada mañana corren dentro de un trabajo en segundo plano, donde no
 * hay conversación, ni agente, ni tramo que medir. Un `ToolContext` completo
 * ahí sería un objeto medio inventado, y `as ToolContext` sobre un objeto medio
 * inventado es exactamente cómo se cuela un `undefined` en producción.
 */
export type GmailFetchContext = Pick<ToolContext, 'integrations' | 'signal'>;

export async function gmailFetch<T>(
  ctx: GmailFetchContext,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: ctx.signal,
  });
  if (r.status === 401) throw new IntegrationError('Gmail 401', 'google');
  if (!r.ok) throw new IntegrationError(`Gmail ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}
