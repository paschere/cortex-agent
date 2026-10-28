import type { ToolContext } from '../types';
import { GoogleApiError, logGoogleError } from './errors';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function sheetsFetch<T>(
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
  if (!r.ok) {
    const err = new GoogleApiError('sheets', r.status, path, await r.text());
    logGoogleError(ctx.logger, err, `sheets ${(init?.method ?? 'GET').toUpperCase()}`);
    throw err;
  }
  return r.json() as Promise<T>;
}
