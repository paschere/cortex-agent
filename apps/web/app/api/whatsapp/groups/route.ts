import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { assertCanWriteToSpace } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Switching a group's archiving on and off.
 *
 * THIS IS THE CONSENT DECISION, so it is written out rather than implied.
 *
 * Turning a group ON requires naming the Brain Knowledge space its
 * conversations go into, and the person doing it must be able to write there —
 * `assertCanWriteToSpace` already refuses a company-wide space to anyone who is
 * not an org admin. So "archive this client's group where the whole company can
 * read it" takes an explicit act by somebody with the authority, group by group.
 * There is no default and no bulk switch, because a bulk switch is how a
 * decision that should be made twelve times gets made once by accident.
 *
 * `archive_from` is set to NOW, never to zero. Switching a group on starts the
 * archive from this moment: it does not reach back and swallow two years of a
 * conversation that a dozen people — several of them not employees — were
 * having under the reasonable assumption that it was not being filed anywhere.
 *
 * Turning a group OFF stops it immediately and leaves what was already archived
 * alone. Those are documents in a space now, with their own permissions and
 * their own delete button; quietly destroying them from here would be a
 * different and much larger action than the one the switch describes.
 */

export const dynamic = 'force-dynamic';

interface Body {
  jid?: string;
  archiving?: boolean;
  spaceId?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);

  const body = (await req.json().catch(() => ({}))) as Body;
  const jid = body.jid?.trim();
  if (!jid) return NextResponse.json({ error: 'Falta el grupo.' }, { status: 400 });

  const { data: group } = await db
    .from('whatsapp_groups')
    .select('id, jid, subject, archive_enabled, space_id')
    .eq('jid', jid)
    .maybeSingle();
  if (!group) {
    return NextResponse.json(
      { error: 'Ese grupo ya no aparece en la lista. Reconecta WhatsApp y vuelve a intentar.' },
      { status: 404 },
    );
  }

  if (body.archiving === false) {
    await db
      .from('whatsapp_groups')
      .update({ archive_enabled: false, updated_at: new Date().toISOString() })
      .eq('jid', jid);
    logger.info(`whatsapp: archiving switched off for a group by ${session.id}`);
    return NextResponse.json({
      ok: true,
      archiving: false,
      note: 'Dejé de archivar ese grupo. Lo que ya está guardado sigue en su espacio.',
    });
  }

  const spaceId = body.spaceId?.trim();
  if (!spaceId) {
    return NextResponse.json(
      { error: 'Elige en qué espacio de Brain Knowledge van a quedar las conversaciones.' },
      { status: 400 },
    );
  }

  let spaceName: string;
  try {
    const space = await assertCanWriteToSpace(db, session.id, spaceId);
    spaceName = space.name;
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }

  const now = new Date().toISOString();
  const { error } = await db
    .from('whatsapp_groups')
    .update({
      archive_enabled: true,
      space_id: spaceId,
      enabled_by: session.id,
      enabled_at: now,
      // Only on the way ON from OFF. Re-pointing an already-archiving group at
      // a different space must not create a gap in what has been remembered.
      ...(group.archive_enabled ? {} : { archive_from: now }),
      updated_at: now,
    })
    .eq('jid', jid);

  if (error) {
    logger.error(`whatsapp: could not switch a group on — ${error.message}`);
    return NextResponse.json({ error: 'No se pudo guardar el cambio.' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    archiving: true,
    spaceId,
    note: group.archive_enabled
      ? `Las próximas conversaciones de este grupo quedan en ${spaceName}.`
      : `Listo. Desde ahora las conversaciones de este grupo quedan en ${spaceName}. Lo anterior a este momento no se archiva.`,
  });
}
