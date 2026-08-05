import { isMissingTable } from '@/lib/dev-work';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Pull the brake on one of Cortex's development runs.
 *
 * Deliberately open to any signed-in teammate. Adding a repository is an admin
 * decision because it widens what Cortex can touch; stopping a run only ever
 * narrows it, and a safety brake nobody can reach is not a safety brake. Who
 * pressed it is recorded on the row and shown on the page.
 *
 * How it is honoured (see lib/dev-work.ts for the full contract):
 *
 *   queued   → nothing is running, so the row is finished as `cancelled` here.
 *   running  → `cancel_requested_at` / `cancel_requested_by` are set and the
 *              status column is left alone. The executor owns the lifecycle
 *              while it holds the sandbox; it checks this flag between steps
 *              and finishes the row as `cancelled`. A durable flag, not a
 *              signal on a wire — the person and the sandbox are minutes and
 *              one process apart, and a missed packet must not lose a stop.
 *
 * Idempotent: pressing Stop twice is one stop.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;

  const db = getOrgScopedClient(user.organization.id);
  const { data: task, error: readError } = await db
    .from('dev_tasks')
    .select('id, title, status, cancel_requested_at')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    if (isMissingTable(readError)) {
      return NextResponse.json(
        { error: "Cortex's development work isn't set up in this environment yet." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (!task) return NextResponse.json({ error: 'That run no longer exists.' }, { status: 404 });

  const status = String(task.status ?? '');
  if (status !== 'queued' && status !== 'running') {
    return NextResponse.json(
      { error: 'That run has already finished — there is nothing left to stop.' },
      { status: 409 },
    );
  }

  // Already asked. Say so rather than re-stamping who asked and when: the first
  // person to press it is the one on the record.
  if (task.cancel_requested_at) {
    return NextResponse.json({ id, alreadyStopping: true, status });
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    status === 'queued'
      ? {
          status: 'cancelled',
          cancel_requested_at: now,
          cancel_requested_by: user.id,
          finished_at: now,
        }
      : { cancel_requested_at: now, cancel_requested_by: user.id };

  const { data: updated, error } = await db
    .from('dev_tasks')
    .update(patch)
    .eq('id', id)
    // Only stop what is still stoppable: if the executor finished the run in
    // the moment between the read above and this write, leave its result alone.
    .in('status', ['queued', 'running'])
    .select('id, status, cancel_requested_at')
    .maybeSingle();

  if (error) {
    logger.error('dev-work: stop failed', { taskId: id, error: error.message });
    return NextResponse.json(
      { error: 'Could not record the stop. Nothing changed — try again.' },
      { status: 500 },
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: 'That run finished a moment before you pressed Stop.' },
      { status: 409 },
    );
  }

  logger.info('dev-work: run stopped by a human', {
    taskId: id,
    by: user.email,
    previousStatus: status,
  });

  return NextResponse.json({
    id,
    status: updated.status,
    // The queued case is over; the running case is a request the executor honours.
    stopped: status === 'queued',
    stopping: status === 'running',
  });
}
