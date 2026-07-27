import { inngest } from '@/lib/inngest';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Fire a routine right now. Emits the very same `scheduled/job.run` event the
 * minute-by-minute dispatcher emits (plus `manual: true`), so the run goes
 * through schedule-run.ts unchanged — same execution, same notifications.
 *
 * Global routines are runnable by anyone on the team; private ones only by
 * their owner.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;

  const db = getSupabaseServiceClient();
  const { data: job } = await db
    .from('scheduled_jobs')
    .select('id, user_id, is_global, status')
    .eq('id', id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isOwner = (job.user_id as string) === user.id;
  if (!isOwner && !(job.is_global as boolean)) {
    return NextResponse.json({ error: 'Not allowed to run this routine' }, { status: 403 });
  }

  // schedule-run.ts refuses to execute anything that is not active, so say so
  // here instead of queueing an event that would silently no-op.
  if (job.status !== 'active') {
    return NextResponse.json(
      { error: `This routine is ${job.status as string}, not active` },
      { status: 409 },
    );
  }

  if (!process.env.INNGEST_SIGNING_KEY) {
    return NextResponse.json(
      { error: 'Background runs are not configured yet' },
      { status: 503 },
    );
  }

  try {
    await inngest.send({
      name: 'scheduled/job.run',
      data: {
        jobId: job.id as string,
        scheduledFor: new Date().toISOString(),
        manual: true,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not queue the run: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
