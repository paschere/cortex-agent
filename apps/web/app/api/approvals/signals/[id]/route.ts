import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const Body = z.object({
  status: z.enum(['qualified', 'rejected']),
});

const Id = z.string().uuid();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Growth signals are team-wide: any signed-in user may triage them.
  const user = await requireSession();

  const { id: rawId } = await params;
  const idParsed = Id.safeParse(rawId);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = getOrgScopedClient(user.organization.id);
  // Attributed like every other triage decision — /prospects shows "Qualified by
  // Ana", and a signal moved from this queue must name a person there too.
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('growth_signals')
    .update({
      status: parsed.data.status,
      updated_at: now,
      reviewed_by: user.id,
      reviewed_at: now,
    })
    .eq('id', idParsed.data)
    .select('id')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, status: parsed.data.status });
}
