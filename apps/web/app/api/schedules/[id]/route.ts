import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { computeNextRun } from '@zipdev/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/** The original UI contract: lifecycle actions. */
const ActionBody = z.object({ action: z.enum(['pause', 'resume', 'cancel']) });

/** The inline editor's contract: partial field updates. */
const PatchBody = z.object({
  patch: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      cron: z.string().trim().min(1).max(120).optional(),
      timezone: z.string().trim().min(1).max(64).optional(),
      notifyEmail: z.boolean().optional(),
      recipients: z.array(z.string().trim().toLowerCase().email()).max(25).optional(),
    })
    .refine((p) => Object.values(p).some((v) => v !== undefined), {
      message: 'patch must change at least one field',
    }),
});

const Body = z.union([ActionBody, PatchBody]);

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Update one scheduled job: either a lifecycle action (`{ action }`) or an
 * edit of its essentials (`{ patch }`) from the Routines page.
 *
 * Permission: the owner, or anybody on the team when the routine is global —
 * the same rule POST /api/schedules/[id]/run already applies.
 */
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

  const db = getSupabaseServiceClient();
  const { data: job } = await db
    .from('scheduled_jobs')
    .select('id, user_id, is_global, status, schedule_kind, cron, timezone, run_at')
    .eq('id', id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isOwner = (job.user_id as string) === user.id;
  if (!isOwner && !(job.is_global as boolean)) {
    return NextResponse.json({ error: 'Not allowed to change this routine' }, { status: 403 });
  }

  const status = job.status as string;
  const scheduleKind = job.schedule_kind as 'once' | 'cron';
  let patch: Record<string, unknown>;

  if ('action' in parsed.data) {
    const { action } = parsed.data;
    if (action === 'cancel') {
      if (status === 'completed' || status === 'cancelled') {
        return NextResponse.json({ error: `Job is already ${status}` }, { status: 409 });
      }
      patch = { status: 'cancelled', next_run_at: null };
    } else if (action === 'pause') {
      if (status !== 'active') {
        return NextResponse.json({ error: `Job is ${status}, not active` }, { status: 409 });
      }
      patch = { status: 'paused' };
    } else {
      if (status !== 'paused') {
        return NextResponse.json({ error: `Job is ${status}, not paused` }, { status: 409 });
      }
      if (scheduleKind === 'cron') {
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
  } else {
    const p = parsed.data.patch;
    patch = {};

    if (p.name !== undefined) patch.name = p.name;
    if (p.notifyEmail !== undefined) patch.notify_email = p.notifyEmail;
    if (p.recipients !== undefined) patch.recipients = [...new Set(p.recipients)];

    if (p.timezone !== undefined) {
      if (!isValidTimezone(p.timezone)) {
        return NextResponse.json({ error: `Unknown timezone "${p.timezone}"` }, { status: 400 });
      }
      patch.timezone = p.timezone;
    }

    if (p.cron !== undefined) {
      if (scheduleKind !== 'cron') {
        return NextResponse.json(
          { error: 'This routine runs once; it has no cron expression to change' },
          { status: 409 },
        );
      }
      patch.cron = p.cron;
    }

    // Retiming invalidates the stored next_run_at: recompute it with the same
    // helper the dispatcher and schedule.create use (cron-parser, tz-aware).
    // Cancelled/completed jobs keep next_run_at null — resuming recomputes.
    const retimed = p.cron !== undefined || p.timezone !== undefined;
    if (retimed && scheduleKind === 'cron' && (status === 'active' || status === 'paused')) {
      const cron = p.cron ?? (job.cron as string);
      const timezone = p.timezone ?? (job.timezone as string);
      try {
        patch.next_run_at = computeNextRun(cron, timezone).toISOString();
      } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 400 });
      }
    }
  }

  const { data: updated, error } = await db
    .from('scheduled_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, status, cron, timezone, notify_email, recipients, next_run_at')
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 500 });
  }
  return NextResponse.json(updated);
}
