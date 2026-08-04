import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function gmailFetch<T>(
  ctx: ToolContext,
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
