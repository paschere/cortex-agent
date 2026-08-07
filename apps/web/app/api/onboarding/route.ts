import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { saveOnboarding } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * The two things the first-run guide stores.
 *
 * Everything else about progress is DERIVED from the data — is there an
 * integration, a document, an answer, a second person — so there is nothing here
 * to mark as done. See the header of packages/agent-tools/src/billing/onboarding.ts.
 */
const Body = z.object({
  goal: z.enum(['email', 'documents', 'deadlines', 'meetings']).optional(),
  dismissed: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.goal && parsed.data.dismissed === undefined)) {
    return NextResponse.json({ error: 'Nada que guardar.' }, { status: 400 });
  }

  const db = getOrgScopedClient(user.organization.id);
  await saveOnboarding(db, parsed.data);
  return NextResponse.json({ ok: true });
}
