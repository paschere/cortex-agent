import { readManagement } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildLaunchPlan } from './launch-plan';
/** All counts use the tenant-scoped client. Personal surfaces additionally enforce ownership. */
export async function readLaunchPlan(
  db: SupabaseClient,
  userId: string,
  browserConfigured: boolean,
  isAdmin = false,
) {
  const head = { count: 'exact' as const, head: true };
  const count = async (query: PromiseLike<{ count: number | null; error: unknown }>) => {
    try {
      const result = await query;
      return result.error ? null : (result.count ?? null);
    } catch {
      return null;
    }
  };
  const now = new Date().toISOString();
  const [
    board,
    facts,
    sources,
    knowledge,
    people,
    goals,
    browserProfiles,
    mandates,
    routines,
    verified,
  ] = await Promise.all([
    readManagement(db).catch(() => null),
    count(db.from('company_facts').select('id', head)),
    count(db.from('integrations').select('user_id', head)),
    count(db.from('kb_documents').select('id', head)),
    count(db.from('users').select('id', head)),
    count(db.from('goals').select('id', head).eq('state', 'active')),
    count(
      db.from('browser_profiles').select('id', head).or(`owner_id.eq.${userId},shared.eq.true`),
    ),
    isAdmin
      ? count(
          db
            .from('mandates')
            .select('id', head)
            .is('revoked_at', null)
            .lte('starts_at', now)
            .gt('expires_at', now),
        )
      : Promise.resolve(null),
    count(
      db
        .from('scheduled_jobs')
        .select('id', head)
        .eq('status', 'active')
        .or(`user_id.eq.${userId},is_global.eq.true`),
    ),
    count(db.from('management_cases').select('id', head).eq('data->>state', 'verified')),
  ]);
  return {
    board,
    steps: buildLaunchPlan({
      facts,
      configured: board ? board.profile.revision > 0 : null,
      owner: board ? !!board.profile.data.escalationOwnerId : null,
      sources,
      knowledge,
      people,
      goals,
      manuals: board?.profile.data.playbooks.length ?? null,
      browserProfiles,
      browserConfigured,
      mandates,
      routines,
      verified,
    }),
    readAt: new Date().toISOString(),
  };
}
