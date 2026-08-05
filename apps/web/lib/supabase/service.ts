import 'server-only';
import { createOrgScopedClient } from '@cortex/agent-tools';
import { getEnv } from '@cortex/core';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

/**
 * Database access, in two flavours: one you should be using and one you should
 * have a reason for.
 *
 * `getOrgScopedClient(organizationId)` is the one. It hands back a client that
 * pins the workspace onto every read and every write, so ordinary code writes
 * ordinary queries and cannot leak across tenants by forgetting anything. See
 * packages/agent-tools/src/tenancy/scoped-client.ts.
 *
 * `getSupabaseServiceClient()` is the raw service-role client. It sees every
 * workspace at once. It is legitimately needed in exactly three shapes of code:
 *
 *   - authentication and workspace resolution, which run BEFORE a workspace is
 *     known and are the thing that determines it (lib/session.ts,
 *     lib/organization.ts, the OAuth endpoints, the MCP token exchange);
 *   - cron dispatchers, which by definition sweep every workspace and then fan
 *     out one unit of work per workspace (inngest/functions/*-dispatch, the
 *     Drive and meeting sweeps);
 *   - install-wide maintenance that touches no tenant-visible data (the
 *     embedding backfill).
 *
 * Anything else reaching for it is almost certainly a bug, so the list is not a
 * convention: `lib/tenancy-guard.test.ts` enumerates the files allowed to import
 * it and fails the build when a new one appears.
 */

let _service: SupabaseClient | null = null;

/**
 * The unscoped, sees-everything client. Read the note above before using it,
 * and add the file to the allowlist in lib/tenancy-guard.test.ts with a reason.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  if (_service) return _service;
  const env = getEnv();
  _service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}

/**
 * The client for business data. Everything a signed-in person or a scheduled
 * job touches goes through one of these.
 *
 * @param organizationId `SessionUser.organization.id` in a request, or the
 *   `organization_id` of the row being processed in a background job. Never a
 *   value taken from user input.
 */
export function getOrgScopedClient(organizationId: string): SupabaseClient {
  return createOrgScopedClient(getSupabaseServiceClient(), organizationId);
}
