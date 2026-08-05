import { requireSession } from '@/lib/session';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { normalizePhone } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Which number belongs to which person.
 *
 * ADMIN ONLY, and not as a formality. This row is an authorisation: it decides
 * that messages from a number run with a named person's integrations, their
 * team permissions and their name in the audit log. Somebody able to write one
 * of these for themselves could point their own number at a colleague with more
 * access; somebody able to write one for anybody else could hand a stranger a
 * seat at the company's tools. So it lives where the other access decisions
 * live.
 *
 * There is deliberately no self-service "verify my number" flow. It would be a
 * nicer experience and it would rest on possession of a phone, which is exactly
 * the thing SIM-swap attacks are for — and unlike a normal SMS login, the prize
 * here is an agent that can already reach payroll and the CRM.
 */

export const dynamic = 'force-dynamic';

function adminOnly(role: string | null | undefined): NextResponse | null {
  if (role === 'org_admin') return null;
  return NextResponse.json(
    {
      error:
        'Solo un administrador puede vincular números. Vincular un número le da a ese teléfono los permisos de esa persona.',
    },
    { status: 403 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const refused = adminOnly(session.role);
  if (refused) return refused;

  const body = (await req.json().catch(() => ({}))) as { phone?: string; userId?: string };
  const phone = normalizePhone(body.phone ?? '');
  const userId = body.userId?.trim();

  if (!phone) {
    return NextResponse.json(
      {
        error: 'Ese número no se entiende. Escríbelo con indicativo, por ejemplo +57 300 111 2233.',
      },
      { status: 400 },
    );
  }
  if (!userId) {
    return NextResponse.json({ error: 'Elige a quién pertenece el número.' }, { status: 400 });
  }

  const db = getOrgScopedClient(session.organization.id);

  // Scoped: the person has to be in THIS workspace. Without the scope a valid
  // user id from another company would link a number to somebody who does not
  // work here, which is the one mistake this table must not be able to make.
  const { data: person } = await db
    .from('users')
    .select('id, name, email')
    .eq('id', userId)
    .maybeSingle();
  if (!person) {
    return NextResponse.json(
      { error: 'Esa persona no está en este espacio de trabajo.' },
      { status: 404 },
    );
  }

  // Read raw: the primary key is install-wide, so a number already linked in
  // ANOTHER workspace is invisible to a scoped read and the insert would fail
  // with a constraint error instead of an explanation.
  const { data: existing } = await getSupabaseServiceClient()
    .from('whatsapp_links')
    .select('organization_id')
    .eq('phone_e164', phone)
    .maybeSingle();
  if (existing && existing.organization_id !== session.organization.id) {
    return NextResponse.json(
      {
        error:
          'Ese número ya está vinculado en otro espacio de trabajo. Un número solo puede pertenecer a uno.',
      },
      { status: 409 },
    );
  }

  const { error } = await db.from('whatsapp_links').upsert(
    {
      phone_e164: phone,
      user_id: userId,
      display_name: (person.name as string | null) ?? (person.email as string),
      created_by: session.id,
    },
    { onConflict: 'phone_e164' },
  );
  if (error) {
    logger.error(`whatsapp: could not link a number — ${error.message}`);
    return NextResponse.json({ error: 'No se pudo guardar la vinculación.' }, { status: 500 });
  }

  logger.info(`whatsapp: a number was linked to a person by ${session.id}`);
  return NextResponse.json({ ok: true, phone });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const refused = adminOnly(session.role);
  if (refused) return refused;

  const phone = normalizePhone(new URL(req.url).searchParams.get('phone') ?? '');
  if (!phone) return NextResponse.json({ error: 'Falta el número.' }, { status: 400 });

  const db = getOrgScopedClient(session.organization.id);
  await db.from('whatsapp_links').delete().eq('phone_e164', phone);

  // Takes effect on the next message: the link is read fresh on every inbound
  // DM, so there is no session to expire and no cache to clear.
  return NextResponse.json({ ok: true });
}
