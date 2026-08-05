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
 *
 * IT IS ALSO THE ONE READ HERE THAT SPANS EVERY WORKSPACE, and it has to be. A
 * Linear webhook carries no session and no workspace; the repository the issue
 * names is what determines whose work this is, so the lookup cannot already be
 * scoped to the answer it is trying to find. `pickRepository` rejects rather
 * than guesses whenever the key matches rows in more than one workspace, and
 * every step after this one runs against `repository.organizationId`.
 */
export async function resolveRepository(input: RepoSelectionInput): Promise<RepoResolution> {
  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('dev_repositories')
    .select(
      'id, organization_id, key, clone_url, default_branch, allow_pull_requests, is_active, linear_team_keys, linear_project_ids',
    );
  if (error) throw new Error(`Could not read the repository allowlist: ${error.message}`);
  return pickRepository((data ?? []) as unknown as RepoRow[], input);
}
