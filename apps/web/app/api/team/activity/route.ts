import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  CorporateSupervisionError,
  assertCorporateFounder,
  listTeamActivity,
} from '@/lib/team-activity';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const Query = z.object({
  member: z.string().uuid().optional(),
  type: z.enum(['conversation', 'report']).optional(),
});

export async function GET(request: Request) {
  const user = await requireSession();
  try {
    assertCorporateFounder(user);
  } catch (error) {
    if (error instanceof CorporateSupervisionError)
      return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
  const url = new URL(request.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Filtros inválidos.' }, { status: 400 });
  const snapshot = await listTeamActivity(getOrgScopedClient(user.organization.id), {
    memberId: parsed.data.member,
    type: parsed.data.type,
  });
  return NextResponse.json(snapshot);
}
