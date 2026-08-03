import { supabaseDeliveryLedger } from '@/lib/dev-tasks/claim';
import {
  type DevTaskIntakeEvent,
  type DevTaskQueuedEvent,
  type DevTaskRepository,
  EVENT_TASK_INTAKE,
  EVENT_TASK_QUEUED,
} from '@/lib/dev-tasks/contract';
import { commentOnIssue } from '@/lib/dev-tasks/linear-comment';
import { resolveRepository } from '@/lib/dev-tasks/repository';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';

/**
 * Intake: a claimed Linear delivery becomes a `dev_tasks` row and a queued job.
 *
 * The webhook route did the fast, security-critical part (signature, replay,
 * trigger, claim). Everything with a database or a network on the other end
 * happens here, where a slow step costs latency instead of a duplicate run.
 *
 * The three ways this ends:
 *
 *   rejected  the issue does not say which repository, or names one that is not
 *             on the allowlist. Cortex comments asking the human to say which,
 *             and stops. It never guesses — see @/lib/dev-tasks/repository.
 *   ignored   a task for this issue is already open. The partial unique index
 *             `dev_tasks_one_open_per_issue` is what decides this, so two
 *             concurrent deliveries cannot both win.
 *   accepted  a task row exists, the issue has been commented on, and
 *             `dev/task.queued` is emitted for the executor.
 *
 * Emits: dev/task.queued (see @/lib/dev-tasks/contract).
 */

const PG_UNIQUE_VIOLATION = '23505';

function rejectionComment(reason: string, available: string[]): string {
  const list = available.length > 0 ? available.map((k) => `\`${k}\``).join(', ') : '(none yet)';
  return [
    "⚡ I can't pick this up yet — I don't know which repository it belongs to.",
    '',
    `Reason: ${reason}.`,
    '',
    `Add a line \`Repo: <name>\` to the description (or a \`repo:<name>\` label) and assign it to me again. Repositories I'm allowed to work in: ${list}.`,
  ].join('\n');
}

function acknowledgementComment(repo: DevTaskRepository, via: string): string {
  const pr = repo.allowPullRequests
    ? "I'll open a pull request when it's ready and comment here with the link."
    : "I'm not cleared to open pull requests in that repo, so I'll do the work and report back here instead.";
  return [
    `⚡ Picked this up — working in \`${repo.key}\` (branching off \`${repo.defaultBranch}\`).`,
    '',
    pr,
    '',
    `_Triggered by ${via === 'assignee' ? 'the assignment to me' : 'the label'}._`,
  ].join('\n');
}

type IntakeOutcome =
  | { kind: 'rejected'; reason: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'accepted'; taskId: string; repository: DevTaskRepository; attempt: number };

export const devTaskIntake = inngest.createFunction(
  { id: 'dev-task-intake', concurrency: { limit: 5 } },
  { event: EVENT_TASK_INTAKE },
  async ({ event, step }) => {
    const intake = event.data as unknown as DevTaskIntakeEvent;

    const outcome = await step.run('resolve-and-create', async (): Promise<IntakeOutcome> => {
      const resolution = await resolveRepository({
        directiveKey: intake.repoHint?.from === 'description' ? intake.repoHint.key : null,
        labelKey: intake.repoHint?.from === 'label' ? intake.repoHint.key : null,
        projectId: intake.issue.projectId,
        teamKey: intake.issue.teamKey,
      });
      if (!resolution.ok) {
        await commentOnIssue(
          intake.issue.id,
          rejectionComment(resolution.reason, resolution.available),
        );
        return { kind: 'rejected', reason: resolution.reason };
      }

      const repo = resolution.repository;
      const db = getSupabaseServiceClient();
      const { data, error } = await db
        .from('dev_tasks')
        .insert({
          source: intake.source,
          external_id: intake.issue.id,
          external_identifier: intake.issue.identifier,
          external_url: intake.issue.url,
          title: intake.issue.title,
          description: intake.issue.description,
          repository_id: repo.id,
          repository_key: repo.key,
          requester_name: intake.requester.name,
          requester_email: intake.requester.email,
          requester_external_id: intake.requester.externalId,
          status: 'queued',
          attempt_count: 1,
          trigger_context: {
            via: intake.via,
            action: intake.action,
            repoResolvedVia: resolution.via,
            teamKey: intake.issue.teamKey,
            projectId: intake.issue.projectId,
          },
        })
        .select('id, attempt_count')
        .single();

      if (error) {
        if (error.code === PG_UNIQUE_VIOLATION) {
          // Someone re-assigned or re-labelled while a run is live. Deliberately
          // silent on Linear: the human already sees the earlier "picked this
          // up" comment, and a second one would read like progress.
          return { kind: 'ignored', reason: 'a task for this issue is already open' };
        }
        throw new Error(`Could not create the dev task: ${error.message}`);
      }

      await commentOnIssue(intake.issue.id, acknowledgementComment(repo, intake.via));
      return {
        kind: 'accepted',
        taskId: data.id as string,
        repository: repo,
        attempt: (data.attempt_count as number | null) ?? 1,
      };
    });

    if (outcome.kind === 'accepted') {
      const queued: DevTaskQueuedEvent = {
        taskId: outcome.taskId,
        source: intake.source,
        attempt: outcome.attempt,
        maxAttempts: 3,
        repository: outcome.repository,
        issue: intake.issue,
        requester: intake.requester,
      };
      await step.sendEvent('queue-for-executor', { name: EVENT_TASK_QUEUED, data: queued });
    }

    await step.run('settle-delivery', async () => {
      const ledger = supabaseDeliveryLedger(getSupabaseServiceClient());
      await ledger.settle(intake.deliveryId, {
        outcome: outcome.kind === 'accepted' ? 'accepted' : outcome.kind,
        taskId: outcome.kind === 'accepted' ? outcome.taskId : null,
        reason: outcome.kind === 'accepted' ? null : outcome.reason,
      });
    });

    logger.info(
      `dev-task-intake: ${intake.issue.identifier} → ${outcome.kind}${
        outcome.kind === 'accepted' ? ` (${outcome.repository.key})` : ` (${outcome.reason})`
      }`,
    );
    return outcome.kind === 'accepted'
      ? { status: 'accepted', taskId: outcome.taskId }
      : { status: outcome.kind, reason: outcome.reason };
  },
);
