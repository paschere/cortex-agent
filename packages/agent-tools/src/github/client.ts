import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

const BASE = 'https://api.github.com';

export async function githubFetch<T>(
  ctx: ToolContext,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('github');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: ctx.signal,
  });
  if (r.status === 401) throw new IntegrationError('GitHub 401', 'github');
  if (!r.ok) throw new IntegrationError(`GitHub ${r.status} ${path}: ${await r.text()}`, 'github');
  return r.json() as Promise<T>;
}
