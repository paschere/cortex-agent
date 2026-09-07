import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  CorporateSupervisionError,
  assertCorporateFounder,
  readTeamActivity,
} from '@/lib/team-activity';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  context: { params: Promise<{ type: string; id: string }> },
) {
  const user = await requireSession();
  try {
    assertCorporateFounder(user);
  } catch (error) {
    if (error instanceof CorporateSupervisionError)
      return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
  const { type, id } = await context.params;
  if ((type !== 'conversation' && type !== 'report') || !/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: 'Actividad inválida.' }, { status: 400 });
  const detail = await readTeamActivity(getOrgScopedClient(user.organization.id), type, id);
  return detail
    ? NextResponse.json(detail)
    : NextResponse.json({ error: 'No existe en esta empresa.' }, { status: 404 });
}
