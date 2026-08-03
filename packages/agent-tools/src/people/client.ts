import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

const BASE = 'https://people.googleapis.com/v1';

/** GET a People API endpoint and parse the JSON response. */
export async function peopleGet<T>(
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
  if (!r.ok) {
    throw new IntegrationError(`People API ${r.status} ${path}: ${await r.text()}`, 'google');
  }
  return r.json() as Promise<T>;
}

// ---- Shared People API response shapes (only the fields we read) ----
export interface PersonResult {
  name: string | null;
  email: string | null;
  title: string | null;
  department: string | null;
  source: 'directory' | 'contacts';
}

interface RawPerson {
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string; metadata?: { primary?: boolean } }>;
  organizations?: Array<{ title?: string; department?: string; name?: string }>;
}

function primaryOr<T>(arr: T[] | undefined, pick: (t: T) => boolean): T | undefined {
  if (!arr?.length) return undefined;
  return arr.find(pick) ?? arr[0];
}

export function adaptPerson(p: RawPerson, source: 'directory' | 'contacts'): PersonResult {
  const name = primaryOr(p.names, (n) => !!n.metadata?.primary);
  const email = primaryOr(p.emailAddresses, (e) => !!e.metadata?.primary);
  const org = p.organizations?.[0];
  return {
    name: name?.displayName ?? null,
    email: email?.value ?? null,
    title: org?.title ?? null,
    department: org?.department ?? null,
    source,
  };
}
