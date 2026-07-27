import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type RepoResolution,
  type RepoRow,
  type RepoSelectionInput,
  pickRepository,
} from './repository-rule';

export type {
  RepoResolution,
  RepoResolutionTier,
  RepoSelectionInput,
} from './repository-rule';

/**
 * Apply the repo-selection rule (./repository-rule.ts) to the live allowlist.
 *
 * The allowlist is small — a handful of rows — so it is read whole rather than
 * filtered in SQL: the precedence between an explicit key, a project mapping
 * and a team mapping belongs in one readable place, not spread across four
 * queries.
 */
export async function resolveRepository(input: RepoSelectionInput): Promise<RepoResolution> {
  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('dev_repositories')
    .select(
      'id, key, clone_url, default_branch, allow_pull_requests, is_active, linear_team_keys, linear_project_ids',
    );
  if (error) throw new Error(`Could not read the repository allowlist: ${error.message}`);
  return pickRepository((data ?? []) as unknown as RepoRow[], input);
}
