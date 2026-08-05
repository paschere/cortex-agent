import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { assertCanWriteToSpace, getVisibleSpace, isGroupReplyScope } from '@cortex/agent-tools';
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
  /** Archiving: whether this group's conversations become documents. */
  archiving?: boolean;
  spaceId?: string;
  /** Answering: whether Cortex may reply here when it is mentioned. */
  replying?: boolean;
  replyScope?: string;
  replySpaceId?: string | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);

  const body = (await req.json().catch(() => ({}))) as Body;
  const jid = body.jid?.trim();
  if (!jid) return NextResponse.json({ error: 'Falta el grupo.' }, { status: 400 });

  const { data: group } = await db
    .from('whatsapp_groups')
    .select('id, jid, subject, archive_enabled, space_id, reply_enabled')
    .eq('jid', jid)
    .maybeSingle();
  if (!group) {
    return NextResponse.json(
      { error: 'Ese grupo ya no aparece en la lista. Reconecta WhatsApp y vuelve a intentar.' },
      { status: 404 },
    );
  }

  // Answering is its own switch and is handled on its own. A request that only
  // changes answering must not disturb archiving, and vice versa — they are
  // separate permissions with separate risks (migration 0072).
  if (body.replying !== undefined) {
    return setReplying(db, session, group as Record<string, unknown>, body);
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

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/**
 * Switching Cortex's voice on or off in a group.
 *
 * THE TWO CHECKS THAT MATTER, and why they are checks rather than guidance:
 *
 *   The scope is stored per group and defaults to `plain` — no tools at all.
 *   Somebody widening it is making a decision about a specific room, and the
 *   screen says in words what each step lets Cortex reach.
 *
 *   `replySpaceId` must be a COMPANY-WIDE space. A personal space is one
 *   person's private notes, and there is no reading of "quote my private notes
 *   into a room that contains a client" that is correct — so it is refused
 *   here, and refused again at retrieval time through ToolContext.kbSpaceIds.
 *   Two locks, because this is the one that quietly leaks if it is wrong.
 */
async function setReplying(
  db: ReturnType<typeof getOrgScopedClient>,
  session: { id: string; role?: string | null },
  group: Record<string, unknown>,
  body: Body,
): Promise<NextResponse> {
  const now = new Date().toISOString();
  const jid = group.jid as string;

  if (body.replying === false) {
    await db
      .from('whatsapp_groups')
      .update({ reply_enabled: false, updated_at: now })
      .eq('jid', jid);
    logger.info(`whatsapp: group answering switched off by ${session.id}`);
    return NextResponse.json({
      ok: true,
      replying: false,
      note: 'Cortex deja de responder en ese grupo. Sigue sin escribir nada por su cuenta.',
    });
  }

  const scope = isGroupReplyScope(body.replyScope) ? body.replyScope : 'plain';

  let replySpaceId: string | null = null;
  if (scope === 'knowledge') {
    const wanted = body.replySpaceId?.trim();
    if (!wanted) {
      return NextResponse.json(
        { error: 'Elige el espacio de empresa que Cortex puede citar en este grupo.' },
        { status: 400 },
      );
    }
    try {
      const space = await getVisibleSpace(db, session.id, wanted);
      if (space.kind !== 'global') {
        return NextResponse.json(
          {
            error:
              'Solo un espacio de toda la empresa puede citarse en un grupo. Los espacios personales son notas privadas de alguien y en el grupo hay gente de fuera.',
          },
          { status: 400 },
        );
      }
      replySpaceId = space.id;
    } catch {
      return NextResponse.json({ error: 'Ese espacio ya no existe.' }, { status: 404 });
    }
  }

  const { error } = await db
    .from('whatsapp_groups')
    .update({
      reply_enabled: true,
      reply_scope: scope,
      reply_space_id: replySpaceId,
      reply_enabled_by: session.id,
      reply_enabled_at: now,
      updated_at: now,
    })
    .eq('jid', jid);

  if (error) {
    logger.error(`whatsapp: could not switch group answering on — ${error.message}`);
    return NextResponse.json({ error: 'No se pudo guardar el cambio.' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    replying: true,
    replyScope: scope,
    note:
      scope === 'plain'
        ? 'Listo. Cortex responde en ese grupo solo cuando lo mencionen, y solo con lo que se dijo ahí.'
        : scope === 'knowledge'
          ? 'Listo. Cortex responde cuando lo mencionen y puede citar el espacio que elegiste.'
          : 'Listo. Cortex responde cuando lo mencionen y puede consultar los sistemas de quien pregunta. Asegúrate de que en ese grupo no haya gente de fuera.',
  });
}
