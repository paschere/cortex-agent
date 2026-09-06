import { getBrowserProfile, profileRef } from '@cortex/agent-tools/src/browser/profiles';
import { browserService } from '@/lib/browser-service';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  const session = await requireSession();
  const parsed = z
    .object({
      profileId: z.string().uuid(),
      startUrl: z
        .string()
        .url()
        .max(2000)
        .refine((s) => /^https?:\/\//.test(s)),
    })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Elige un perfil y una dirección web válida.' },
      { status: 400 },
    );
  const profile = await getBrowserProfile(
    getOrgScopedClient(session.organization.id),
    parsed.data.profileId,
    session.id,
  ).catch(() => null);
  if (!profile)
    return NextResponse.json({ error: 'No tienes acceso a ese perfil.' }, { status: 403 });
  try {
    return NextResponse.json(
      await browserService(session, '/session', 'POST', {
        startUrl: parsed.data.startUrl,
        profile: profileRef(profile),
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
