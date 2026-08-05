/**
 * Reading the workspace's custom tools.
 *
 * `db` is always the scoped handle, so `organization_id` is pinned on the way
 * past and nothing here filters by it explicitly (migration 0064 + tenancy/
 * scoped-client.ts). A raw service-role client passed in here would read every
 * tenant's tools, which is exactly the mistake the scoped client exists to make
 * impossible — so the type says `SupabaseClient` and the call sites all go
 * through `getOrgScopedClient` / `buildToolContext`.
 *
 * Failure is silent and empty on purpose: this runs on the hot path of every
 * chat turn, and a table that is momentarily unreachable must cost the user
 * their custom tools, never their message.
 */

import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CustomToolRow, EXECUTION_COLUMNS, MAX_TOOLS_PER_ORG } from './types';

export const CUSTOM_TOOLS_TABLE = 'custom_tools';

/**
 * Every enabled custom tool for the workspace `db` is pinned to, with the
 * encrypted secret attached because the executor needs it. Callers that render
 * anything to a human must use `SAFE_COLUMNS` instead.
 */
export async function fetchEnabledCustomTools(db: SupabaseClient): Promise<CustomToolRow[]> {
  const { data, error } = await db
    .from(CUSTOM_TOOLS_TABLE)
    .select(EXECUTION_COLUMNS)
    .eq('enabled', true)
    .order('slug', { ascending: true })
    .limit(MAX_TOOLS_PER_ORG);

  if (error) {
    logger.warn({ err: error }, 'fetchEnabledCustomTools: query failed');
    return [];
  }
  return (data ?? []) as unknown as CustomToolRow[];
}

/** One tool by id, with its secret. Used by the tester and by direct invocation. */
export async function fetchCustomToolById(
  db: SupabaseClient,
  id: string,
): Promise<CustomToolRow | null> {
  const { data, error } = await db
    .from(CUSTOM_TOOLS_TABLE)
    .select(EXECUTION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as CustomToolRow;
}
