import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

const BASE = 'https://www.googleapis.com/drive/v3';

/** GET a Drive API endpoint and parse the JSON response. */
export async function driveGet<T>(
  ctx: ToolContext,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Drive ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}

/** GET a Drive API endpoint and return the raw text body (exports / media downloads). */
export async function driveGetText(
  ctx: ToolContext,
  path: string,
  params: Record<string, string> = {},
): Promise<string> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Drive ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.text();
}

/** GET a Drive API endpoint and return the raw bytes (binary media downloads, alt=media). */
export async function driveGetBytes(
  ctx: ToolContext,
  path: string,
  params: Record<string, string> = {},
): Promise<Buffer> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Drive ${r.status} ${path}: ${await r.text()}`, 'google');
  return Buffer.from(await r.arrayBuffer());
}
