import type { DevTaskRepository } from './contract';

/**
 * WHICH REPO DOES THIS ISSUE BELONG TO?
 *
 * A Linear issue does not say. Letting a model infer it is the one failure mode
 * with no cheap recovery — a plausible guess sends an autonomous agent into the
 * wrong codebase — so the rule is deterministic, data-driven, and refuses
 * rather than guesses. Precedence, highest first:
 *
 *   1. A `Repo: <key>` line in the issue description. A human typed it for this
 *      issue; nothing outranks that.
 *   2. A `repo:<key>` Linear label. Same instruction, different affordance.
 *   3. The issue's Linear project, if some repo claims that project id
 *      (dev_repositories.linear_project_ids). Narrower than a team, so it wins.
 *   4. The issue's Linear team key (dev_repositories.linear_team_keys).
 *   5. Nothing → REJECT and ask. Never a default, never "the obvious one",
 *      never "the only active repo".
 *
 * Tiers 3 and 4 are columns on `dev_repositories`, so mapping a new team to a
 * repo is an UPDATE, not a deploy. They ship empty on purpose: until somebody
 * maps a team, every issue must name its repo, which fails loudly instead of
 * quietly sending work to the wrong place.
 *
 * A key that is not on the allowlist, or whose row is inactive, is a REJECTION —
 * not a fallback to a lower tier. If a human said "payroll" and payroll is not
 * registered, the answer is "payroll is not on the list", not "here, have
 * cortex-agent".
 *
 * The rule lives apart from the database access in ./repository.ts so it stays
 * a pure function over the allowlist.
 */

export type RepoResolutionTier = 'description' | 'label' | 'project' | 'team';

export type RepoResolution =
  | { ok: true; repository: DevTaskRepository; via: RepoResolutionTier }
  | { ok: false; reason: string; askedFor: string | null; available: string[] };

/** One row of the allowlist, as stored. */
export interface RepoRow {
  id: string;
  key: string;
  clone_url: string;
  default_branch: string;
  allow_pull_requests: boolean;
  is_active: boolean;
  linear_team_keys: string[] | null;
  linear_project_ids: string[] | null;
}

export interface RepoSelectionInput {
  /** From a `Repo:` line in the description (tier 1). */
  directiveKey: string | null;
  /** From a `repo:<key>` label (tier 2). */
  labelKey: string | null;
  projectId: string | null;
  teamKey: string | null;
}

function toRepository(row: RepoRow): DevTaskRepository {
  return {
    id: row.id,
    key: row.key,
    provider: 'github',
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
    allowPullRequests: row.allow_pull_requests,
  };
}

export function pickRepository(rows: RepoRow[], input: RepoSelectionInput): RepoResolution {
  const active = rows.filter((r) => r.is_active);
  const available = active.map((r) => r.key).sort();

  const explicit = input.directiveKey ?? input.labelKey;
  if (explicit) {
    const key = explicit.trim().toLowerCase();
    const hit = active.find((r) => r.key.toLowerCase() === key);
    if (hit) {
      return {
        ok: true,
        repository: toRepository(hit),
        via: input.directiveKey ? 'description' : 'label',
      };
    }
    const inactive = rows.some((r) => r.key.toLowerCase() === key);
    return {
      ok: false,
      reason: inactive
        ? `"${key}" is registered but currently inactive`
        : `"${key}" is not a repository I am allowed to work in`,
      askedFor: key,
      available,
    };
  }

  const projectId = input.projectId;
  if (projectId) {
    const hit = active.find((r) => (r.linear_project_ids ?? []).includes(projectId));
    if (hit) return { ok: true, repository: toRepository(hit), via: 'project' };
  }

  if (input.teamKey) {
    const teamKey = input.teamKey.trim().toUpperCase();
    const matches = active.filter((r) =>
      (r.linear_team_keys ?? []).some((k) => k.trim().toUpperCase() === teamKey),
    );
    // Two repos claiming one team is a configuration mistake, and silently
    // picking either one hides it. Ambiguity is rejected the way absence is.
    if (matches.length > 1) {
      return {
        ok: false,
        reason: `team ${teamKey} is mapped to more than one repository (${matches.map((m) => m.key).join(', ')})`,
        askedFor: null,
        available,
      };
    }
    const only = matches[0];
    if (only) return { ok: true, repository: toRepository(only), via: 'team' };
  }

  return {
    ok: false,
    reason: 'the issue does not say which repository',
    askedFor: null,
    available,
  };
}
