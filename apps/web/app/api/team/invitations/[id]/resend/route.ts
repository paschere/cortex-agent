import { resendInvitation } from '@/lib/team/invite-flow';
import { requireInviter } from '@/lib/team/invite-guard';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Reenviar una invitación pendiente de ESTE espacio (vencida o no).
 *
 * El espacio sale de la sesión, y el id de la invitación es lo único que llega
 * de afuera: una de otra empresa no aparece en el `where` y se contesta igual
 * que una que ya no está pendiente.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireInviter();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;

  const result = await resendInvitation({
    organizationId: gate.user.organization.id,
    invitationId: id,
    requestHeaders: await headers(),
    inviterAccountId: gate.accountId,
  });
  if (result.status === 'sent') return NextResponse.json({ ok: true, result });
  return NextResponse.json(
    result.status === 'no_seats'
      ? { error: result.message, reason: 'plan_limit', meter: 'seats' }
      : { error: result.message },
    { status: result.status === 'no_seats' ? 402 : 400 },
  );
}
