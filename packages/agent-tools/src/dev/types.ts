/**
 * Shapes shared between the dev-task executor's pure core (this directory) and
 * the Inngest orchestrator in apps/web.
 *
 * CONTRACT ASSUMPTION: the `dev_tasks` / `dev_repositories` columns below mirror
 * infra/supabase/migrations/0046_dev_tasks.sql, written by the Linear-intake
 * agent. The executor only ever WRITES branch_name / pr_url / summary / error /
 * status / started_at / finished_at / attempt_count — every other column is
 * intake's to set.
 */

export type DevTaskStatus = 'queued' | 'running' | 'needs_review' | 'done' | 'failed' | 'cancelled';

export interface DevRepository {
  id: string;
  key: string;
  name: string;
  clone_url: string;
  default_branch: string;
  allow_pull_requests: boolean;
  is_active: boolean;
}

export interface DevTask {
  id: string;
  external_id: string;
  external_identifier: string;
  external_url: string | null;
  title: string;
  description: string | null;
  repository_id: string;
  repository_key: string;
  requester_name: string | null;
  requester_email: string | null;
  status: DevTaskStatus;
  attempt_count: number;
  max_attempts: number;
}

/**
 * How a run ended. `needs_input` is a first-class success: the guardrail is that
 * an ambiguous task produces a question, never a guessed implementation.
 */
export type DevRunOutcome = 'pr_opened' | 'needs_input' | 'failed';

export interface DevRunResult {
  outcome: DevRunOutcome;
  summary: string;
  branchName: string | null;
  prUrl: string | null;
  error: string | null;
}
