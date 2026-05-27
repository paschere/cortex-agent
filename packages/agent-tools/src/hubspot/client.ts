import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

const BASE = 'https://api.hubapi.com';

export async function hsFetch<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('hubspot');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: ctx.signal,
  });
  if (r.status === 401) throw new IntegrationError('HubSpot 401', 'hubspot');
  if (!r.ok) throw new IntegrationError(`HubSpot ${r.status} ${path}: ${await r.text()}`, 'hubspot');
  return r.json() as Promise<T>;
}
