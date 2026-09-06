import { browserService } from '@/lib/browser-service';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  defaultBrowserProfile,
  getBrowserProfile,
  listBrowserProfiles,
} from '@cortex/agent-tools/src/browser/profiles';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  try {
    await defaultBrowserProfile(db, session.organization.id, session.id);
    const profiles = await listBrowserProfiles(db, session.id);
    return NextResponse.json({
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        shared: p.shared,
        owned: p.owner_id === session.id,
      })),
    });
  } catch {
    return NextResponse.json(
      {
        error:
          'No se pudieron cargar los perfiles. Revisa que la migración de perfiles esté aplicada.',
      },
      { status: 503 },
    );
  }
}
export async function POST(req: NextRequest) {
  const session = await requireSession();
  const parsed = z
    .object({ name: z.string().trim().min(1).max(100) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Escribe un nombre para el perfil.' }, { status: 400 });
  const { data, error } = await getOrgScopedClient(session.organization.id)
    .from('browser_profiles')
    .insert({ name: parsed.data.name, owner_id: session.id, shared: false })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: 'No se pudo crear el perfil.' }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
export async function PATCH(req: NextRequest) {
  const session = await requireSession();
  const parsed = z
    .object({ id: z.string().uuid(), shared: z.boolean() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const db = getOrgScopedClient(session.organization.id);
  const profile = await getBrowserProfile(db, parsed.data.id, session.id).catch(() => null);
  if (!profile || profile.owner_id !== session.id)
    return NextResponse.json(
      { error: 'Sólo el dueño puede compartir este perfil.' },
      { status: 403 },
    );
  if (profile.shared === parsed.data.shared) return NextResponse.json({ ok: true });
  try {
    // Fence old opens and close live sockets BEFORE changing visibility. A failed
    // update leaves the profile safely fenced; retry advances the same revision.
    await browserService(session, '/profile/revoke', 'POST', {
      key: `profile-${profile.id}`,
      revision: profile.revision + 1,
    });
    const { data, error } = await db
      .from('browser_profiles')
      .update({ shared: parsed.data.shared, revision: profile.revision + 1 })
      .eq('id', profile.id)
      .eq('owner_id', session.id)
      .eq('revision', profile.revision)
      .select('id')
      .maybeSingle();
    if (error || !data)
      return NextResponse.json(
        { error: 'El perfil cambió. Recarga e inténtalo de nuevo.' },
        { status: 409 },
      );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
