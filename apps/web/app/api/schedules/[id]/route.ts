import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { computeNextRun } from '@zipdev/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({ action: z.enum(['pause', 'resume', 'cancel']) });

/** Pause / resume / cancel one of the caller's scheduled jobs (UI actions). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { action } = parsed.data;

  const db = getSupabaseServiceClient();
  const { data: job } = await db
    .from('scheduled_jobs')
    .select('id, status, schedule_kind, cron, timezone, run_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let patch: Record<string, unknown>;
  if (action === 'cancel') {
    if (job.status === 'completed' || job.status === 'cancelled') {
      return NextResponse.json({ error: `Job is already ${job.status}` }, { status: 409 });
    }
    patch = { status: 'cancelled', next_run_at: null };
  } else if (action === 'pause') {
    if (job.status !== 'active') {
      return NextResponse.json({ error: `Job is ${job.status}, not active` }, { status: 409 });
    }
    patch = { status: 'paused' };
  } else {
    if (job.status !== 'paused') {
      return NextResponse.json({ error: `Job is ${job.status}, not paused` }, { status: 409 });
    }
    if (job.schedule_kind === 'cron') {
      try {
        patch = {
          status: 'active',
          next_run_at: computeNextRun(job.cron as string, job.timezone as string).toISOString(),
        };
      } catch {
        return NextResponse.json({ error: 'Invalid cron expression on job' }, { status: 409 });
      }
    } else {
      const runAt = new Date(job.run_at as string);
      if (runAt.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: 'One-off run time is in the past; create a new job' },
          { status: 409 },
        );
      }
      patch = { status: 'active', next_run_at: runAt.toISOString() };
    }
  }

  const { data: updated, error } = await db
    .from('scheduled_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id, status, next_run_at')
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 500 });
  }
  return NextResponse.json(updated);
}
