import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { forgetMemory, listMemories, setMemoryStatus } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { MemoryActionBody, type MemoryView, toMemoryView } from './schema';

export const runtime = 'nodejs';

/**
 * What Cortex remembers about the person, and their controls over it.
 *
 * Every call is scoped to `requireSession().id` and there is no user id in the
 * URL or body — but that is only the second line of defence. The first is that
 * the database functions behind `listMemories`, `setMemoryStatus` and
 * `forgetMemory` all take the person as an argument and derive the row set from
 * it (migration 0051), so a memory id belonging to somebody else matches
 * nothing and reports "not found" rather than acting on their row.
 */

async function view(userId: string): Promise<MemoryView[]> {
  const db = getSupabaseServiceClient();
  return (await listMemories(db, userId)).map(toMemoryView);
}

export async function GET() {
  const user = await requireSession();
  try {
    return NextResponse.json({ memories: await view(user.id) });
  } catch {
    return NextResponse.json({ error: 'Could not load what Cortex remembers.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = MemoryActionBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'That is not a valid action.' }, { status: 422 });
  }
  const { id, action } = parsed.data;

  const db = getSupabaseServiceClient();
  const status =
    action === 'accept'
      ? 'active'
      : action === 'reject'
        ? 'rejected'
        : action === 'archive'
          ? 'archived'
          : 'active';

  try {
    const hit = await setMemoryStatus(db, user.id, id, status);
    // Indistinguishable from a stale id on purpose — a distinguishable
    // "forbidden" would confirm that somebody else's memory exists.
    if (!hit) return NextResponse.json({ error: 'That memory is gone.' }, { status: 404 });
    return NextResponse.json({ memories: await view(user.id) });
  } catch {
    return NextResponse.json({ error: 'Could not update that memory.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await requireSession();
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!id) return NextResponse.json({ error: 'Which memory?' }, { status: 400 });

  const db = getSupabaseServiceClient();
  try {
    const gone = await forgetMemory(db, user.id, id);
    if (!gone) return NextResponse.json({ error: 'That memory is gone.' }, { status: 404 });
    return NextResponse.json({ memories: await view(user.id) });
  } catch {
    return NextResponse.json({ error: 'Could not delete that memory.' }, { status: 500 });
  }
}
