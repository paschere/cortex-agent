import { decideAction, runApprovedActionRow } from '@/lib/actions/decide';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { adaptAction, editContent, getAction } from '@cortex/agent-tools';
import { NotFoundError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Approve, discard or rewrite a proposed action.
 *
 * ── WHAT THE REQUEST CARRIES, AND WHAT IT DOES NOT ────────────────────────
 * An id and a fingerprint. Never a payload. The text that gets sent is read
 * from the row by the statement that approves it, so there is nothing here for
 * a caller to substitute, a proxy to rewrite or a transport to truncate. That
 * is the same lesson `mcp_pending_actions` learned in migration 0033, where the
 * first version embedded the whole validated input in a token and the token got
 * truncated in transit.
 *
 * The fingerprint is not a capability either — holding it proves nothing. It is
 * an assertion about WHICH TEXT the person read, and it is checked against the
 * row, by the database, inside the same statement that decides. Somebody who
 * sends a hash they invented matches zero rows.
 *
 * ── WHY EDITING LIVES HERE TOO ────────────────────────────────────────────
 * Because editing and approving are the same conversation. A person who has to
 * adjust one line should not be moved to another screen, lose the draft, or —
 * far worse — end up editing a copy while the original is what runs. PATCH
 * takes the same fingerprint, refuses on the same staleness, and returns the
 * new one, so the next Approve is against the text now on screen.
 */

const Id = z.string().uuid();

const DecideBody = z.object({
  action: z.enum(['approve', 'dismiss']),
  /** Required to approve: the fingerprint of the draft as rendered. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reason: z.string().max(400).optional(),
});

const EditBody = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  to: z.array(z.string().email()).min(1).max(10).optional(),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(20_000).optional(),
});

async function readJson(req: NextRequest): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();

  const { id: rawId } = await params;
  const id = Id.safeParse(rawId);
  if (!id.success) return NextResponse.json({ error: 'Identificador inválido' }, { status: 400 });

  const body = await readJson(req);
  if (body === null) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  const parsed = DecideBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.action === 'approve' && !parsed.data.contentHash) {
    // Refusing here rather than defaulting to "whatever the row says" is the
    // whole point: an approval that does not name the text it approved is not
    // an approval of anything.
    return NextResponse.json(
      { error: 'Falta el sello del contenido, así que no se aprobó nada. Recarga y vuelve a intentarlo.' },
      { status: 400 },
    );
  }

  const outcome = await decideAction({
    organizationId: user.organization.id,
    actionId: id.data,
    userId: user.id,
    decision: parsed.data.action,
    contentHash: parsed.data.contentHash,
    reason: parsed.data.reason,
    via: 'web',
  });

  switch (outcome.status) {
    case 'unknown':
    case 'not_yours':
      // One answer for both: somebody who does not own an action learns
      // nothing about it, not even whether it exists.
      return NextResponse.json({ error: 'Esa acción no existe o no es tuya.' }, { status: 403 });

    case 'expired':
      return NextResponse.json(
        {
          error:
            'Esa propuesta ya venció — las cifras que trae quedaron viejas. Pídemela otra vez y la vuelvo a redactar con los datos de hoy.',
        },
        { status: 410 },
      );

    case 'content_changed':
      return NextResponse.json(
        {
          error:
            'El texto cambió desde que lo viste, así que no se envió nada. Vuelve a leerlo y apruébalo de nuevo.',
        },
        { status: 409 },
      );

    case 'already_decided':
      return NextResponse.json(
        {
          error:
            outcome.decision === 'approved'
              ? 'Esa acción ya se había aprobado. No se envió una segunda vez.'
              : 'Esa acción ya se había descartado.',
          decision: outcome.decision,
          decidedAt: outcome.decidedAt,
        },
        { status: 409 },
      );

    case 'claimed':
      break;
  }

  if (parsed.data.action === 'dismiss') {
    return NextResponse.json({ ok: true, dismissed: true });
  }

  const run = await runApprovedActionRow(
    user.organization.id,
    outcome.action,
    parsed.data.contentHash as string,
  );
  if (!run.ok) {
    return NextResponse.json(
      { error: run.message },
      { status: run.reason === 'failed' ? 500 : 409 },
    );
  }

  return NextResponse.json({ ok: true, sent: true, result: run.result });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();

  const { id: rawId } = await params;
  const id = Id.safeParse(rawId);
  if (!id.success) return NextResponse.json({ error: 'Identificador inválido' }, { status: 400 });

  const body = await readJson(req);
  if (body === null) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  const parsed = EditBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = getOrgScopedClient(user.organization.id);

  // Ownership before anything else. The scoped handle already keeps another
  // workspace out; this keeps a colleague from rewriting a message that will
  // leave over somebody else's signature.
  const current = await getAction(db, id.data);
  if (!current || current.user_id !== user.id) {
    return NextResponse.json({ error: 'Esa acción no existe o no es tuya.' }, { status: 403 });
  }

  try {
    const result = await editContent(db, {
      id: id.data,
      userId: user.id,
      expectedHash: parsed.data.contentHash,
      patch: {
        ...(parsed.data.to ? { to: parsed.data.to } : {}),
        ...(parsed.data.cc ? { cc: parsed.data.cc } : {}),
        ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
        ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      },
    });

    if (result.outcome === 'stale') {
      return NextResponse.json(
        {
          error:
            'El texto cambió mientras lo editabas, así que no se guardó. Recarga para ver la versión actual.',
        },
        { status: 409 },
      );
    }
    // 'unchanged' returns the row untouched and no revision is written — see
    // editContent. The client just re-renders with the same fingerprint.
    return NextResponse.json({ ok: true, action: adaptAction(result.action) });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'Esa acción ya no existe.' }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : 'No se pudo guardar el cambio.';
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 400 });
  }
}
