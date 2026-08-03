import {
  type DevTaskStatus,
  type DevTaskStatusEvent,
  EVENT_TASK_STATUS,
  TERMINAL_STATUSES,
  isDevTaskStatus,
} from '@/lib/dev-tasks/contract';
import { commentOnIssue } from '@/lib/dev-tasks/linear-comment';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';

/**
 * The executor's write-back path.
 *
 * The executor emits `dev/task.status`; this function is the only thing that
 * updates `dev_tasks` after intake and the only thing that comments on the
 * Linear issue. Keeping both on this side means the executor needs no Linear
 * credentials and no knowledge of the schema — it reports what happened, and
 * the human-visible consequences are decided in one place.
 *
 * Consumes: dev/task.status (see @/lib/dev-tasks/contract).
 */

interface TaskRow {
  id: string;
  external_id: string;
  external_identifier: string;
  status: DevTaskStatus;
  repository_key: string;
  pr_url: string | null;
}

const MAX_TEXT = 4000;

function clip(value: string | undefined, max = MAX_TEXT): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n… (truncated)` : trimmed;
}

/** What the human reads on the issue. Composed here, never by a model. */
function statusComment(status: DevTaskStatus, row: TaskRow, ev: DevTaskStatusEvent): string | null {
  const summary = clip(ev.summary);
  const branch = ev.branchName ? `\`${ev.branchName}\`` : null;
  const pr = ev.prUrl ?? row.pr_url;

  switch (status) {
    case 'running':
      return `⚡ Started working on this in \`${row.repository_key}\`${branch ? ` on ${branch}` : ''}.`;
    case 'needs_review':
      return [
        `⚡ Ready for review${pr ? `: ${pr}` : ''}`,
        summary ? `\n${summary}` : '',
        '\nHave a look when you can — I stop here until someone reviews it.',
      ]
        .filter(Boolean)
        .join('\n');
    case 'done':
      return [`⚡ Done${pr ? ` — ${pr}` : ''}.`, summary ? `\n${summary}` : '']
        .filter(Boolean)
        .join('\n');
    case 'failed':
      return [
        "⚡ I couldn't finish this one.",
        clip(ev.error) ? `\n\`\`\`\n${clip(ev.error)}\n\`\`\`` : '',
        summary ? `\n${summary}` : '',
        '\nIt is back in your hands — assign it to me again once the blocker is cleared.',
      ]
        .filter(Boolean)
        .join('\n');
    case 'cancelled':
      return '⚡ Cancelled — I stopped working on this.';
    // `queued` is announced by intake; repeating it would just be noise.
    default:
      return null;
  }
}

export const devTaskStatus = inngest.createFunction(
  { id: 'dev-task-status', concurrency: { limit: 10 } },
  { event: EVENT_TASK_STATUS },
  async ({ event, step }) => {
    const ev = event.data as unknown as DevTaskStatusEvent;
    if (!ev?.taskId || !isDevTaskStatus(ev.status)) {
      logger.error(`dev-task-status: malformed event (status="${String(ev?.status)}")`);
      return { skipped: 'malformed event' };
    }
    const status = ev.status;

    const row = await step.run('load-task', async (): Promise<TaskRow | null> => {
      const db = getSupabaseServiceClient();
      const { data, error } = await db
        .from('dev_tasks')
        .select('id, external_id, external_identifier, status, repository_key, pr_url')
        .eq('id', ev.taskId)
        .maybeSingle();
      if (error) throw new Error(`Could not load dev task ${ev.taskId}: ${error.message}`);
      return (data as TaskRow | null) ?? null;
    });

    if (!row) return { skipped: 'task not found' };
    // A late report from an attempt that was already closed out (cancelled by a
    // human, or failed and retried) must not resurrect the row or comment again.
    if (TERMINAL_STATUSES.includes(row.status) && row.status !== status) {
      return { skipped: `task is already ${row.status}` };
    }
    if (row.status === status && !ev.prUrl && !ev.summary && !ev.error) {
      return { skipped: 'no change' };
    }

    await step.run('persist', async () => {
      const db = getSupabaseServiceClient();
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status, updated_at: now };
      if (ev.branchName) patch.branch_name = ev.branchName;
      if (ev.prUrl) patch.pr_url = ev.prUrl;
      if (ev.summary) patch.summary = clip(ev.summary);
      if (ev.error) patch.error = clip(ev.error);
      if (typeof ev.attempt === 'number') patch.attempt_count = ev.attempt;
      if (status === 'running') patch.started_at = now;
      if (TERMINAL_STATUSES.includes(status)) patch.finished_at = now;

      const { error } = await db.from('dev_tasks').update(patch).eq('id', row.id);
      if (error) throw new Error(`Could not update dev task ${row.id}: ${error.message}`);
    });

    // Commenting is courtesy and never fails the run — see linear-comment.ts.
    await step.run('notify-linear', async () => {
      const body = statusComment(status, row, ev);
      if (!body) return { commented: false };
      return { commented: await commentOnIssue(row.external_id, body) };
    });

    logger.info(`dev-task-status: ${row.external_identifier} → ${status}`);
    return { taskId: row.id, status };
  },
);
