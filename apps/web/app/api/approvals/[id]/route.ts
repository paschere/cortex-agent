import { decideApproval, runApprovedAction } from '@/lib/approvals/decide';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Approve or decline from the /approvals page.
 *
 * The interesting part is what this route no longer does. It used to read the
 * row, check ownership, check expiry, then delete it — four steps, three of
 * them in application code. The same approval can now be answered from a button
 * inside a Google Chat message, and two surfaces racing each other is normal
 * rather than exotic, so the decision moved into ONE atomic conditional update
 * shared by every surface (see @/lib/approvals/claim). This route is now the
 * web's thin wrapper around it: authenticate, claim, run.
 */

const Body = z.object({
  action: z.enum(['approve', 'decline']),
});

const Id = z.string().uuid();

/**
 * LO QUE SE VA A ENVIAR — PARA LA PERSONA, Y SÓLO CUANDO LO PIDE.
 *
 * ===========================================================================
 * POR QUÉ EL PAYLOAD TIENE QUE VIAJAR POR AQUÍ Y NO CON LA LISTA
 * ===========================================================================
 * `approvals.list` (packages/agent-tools/src/approvals) contesta «¿qué espera
 * mi aprobación?» dentro del chat, y NO devuelve el `input` de cada llamada:
 * su esquema de salida no tiene dónde meterlo. La cola puede contener la
 * exportación de una nómina, y meter eso en el contexto del modelo cada vez que
 * alguien hace una pregunta inocente es justo lo que la matriz de riesgo existe
 * para evitar.
 *
 * Pero la persona que decide SÍ tiene que poder verlo entero — aprobar un
 * titular no es aprobar nada. Así que el payload sale por una segunda puerta,
 * ésta: con sesión, una fila a la vez, y sólo cuando alguien despliega «ver lo
 * que se va a enviar». Resultado: la persona ve el payload; el modelo nunca.
 *
 * ===========================================================================
 * MISMA RESPUESTA PARA «NO EXISTE» Y «NO ES TUYA»
 * ===========================================================================
 * Igual que el POST de abajo, y por la misma razón: quien pregunta por una
 * aprobación ajena no aprende nada de ella, ni siquiera que existe. El filtro
 * por `user_id` va en la consulta, no en un `if` posterior.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();

  const { id: rawId } = await params;
  const idParsed = Id.safeParse(rawId);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data, error } = await getOrgScopedClient(user.organization.id)
    .from('mcp_pending_actions')
    .select('id, tool_id, input, created_at, expires_at, decision')
    .eq('id', idParsed.data)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: 'No se pudo leer lo que se va a enviar. Vuelve a intentarlo.' },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: 'Pending action not found' }, { status: 403 });
  }

  return NextResponse.json({
    id: data.id as string,
    toolId: data.tool_id as string,
    input: data.input,
    createdAt: data.created_at as string,
    expiresAt: data.expires_at as string,
    decision: (data.decision as 'approved' | 'declined' | null) ?? null,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const outcome = await decideApproval({
    organizationId: user.organization.id,
    approvalId: idParsed.data,
    userId: user.id,
    decision: parsed.data.action === 'approve' ? 'approved' : 'declined',
    via: 'web',
  });

  switch (outcome.status) {
    case 'unknown':
    case 'not_yours':
      // Same answer for both: a stranger learns nothing about an approval that
      // is not theirs, not even whether it exists.
      return NextResponse.json({ error: 'Pending action not found' }, { status: 403 });

    case 'expired':
      return NextResponse.json(
        { error: 'This confirmation has expired. Ask Cortex to stage the action again.' },
        { status: 410 },
      );

    case 'already_decided':
      return NextResponse.json(
        {
          error:
            outcome.decidedVia === 'google_chat'
              ? `You already ${outcome.decision} this in Google Chat.`
              : `This was already ${outcome.decision} elsewhere.`,
          decision: outcome.decision,
          decidedAt: outcome.decidedAt,
        },
        { status: 409 },
      );

    case 'claimed':
      break;
  }

  if (parsed.data.action === 'decline') {
    return NextResponse.json({ ok: true, declined: true });
  }

  const run = await runApprovedAction(outcome.action);
  if (!run.ok) {
    // The approval stays spent on purpose — see the note in decide.ts. Retrying
    // a half-executed write is worse than asking Cortex to stage it again.
    return NextResponse.json(
      { error: run.message },
      { status: run.reason === 'failed' ? 500 : 400 },
    );
  }

  return NextResponse.json({ result: run.result });
}
