import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function sheetsFetch<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Sheets ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}
