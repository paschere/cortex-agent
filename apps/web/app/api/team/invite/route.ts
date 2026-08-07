import { auth } from '@/lib/auth';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readSeats, readWorkspacePlan } from '@cortex/agent-tools';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Invite somebody into this workspace.
 *
 * WHY THIS ROUTE EXISTS AT ALL, when better-auth already exposes
 * `authClient.organization.inviteMember` straight from the browser. Because the
 * seat limit has to be checked somewhere the browser cannot skip, and a client
 * calling better-auth's endpoint directly bypasses every check we would write
 * around it. So the product calls this, this checks the plan, and only then does
 * it hand the work to better-auth — which still owns the invitation row, the
 * token, the expiry and the email, none of which is reimplemented here.
 *
 * SEATS BLOCK RATHER THAN DEGRADE, and this is the clean case for it: refusing
 * a sixteenth invitation interrupts nothing. The fifteen people already inside
 * keep working, nobody is mid-anything, and there is no half-finished state to
 * protect. Contrast the answers meter, which gets a courtesy margin precisely
 * because a person IS mid-something when it runs out. See LIMIT_POLICY in
 * packages/agent-tools/src/billing/plans.ts.
 */
const Body = z.object({
  email: z.string().email('Ese correo no parece válido.'),
  role: z.enum(['member', 'admin']).default('member'),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();

  // Only the people who run the workspace add to it. `role` here is the Cortex
  // directory role, which lib/session.ts derives from the better-auth
  // membership — so this is the same answer the workspace switcher gives.
  if (user.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Solo quien administra el espacio puede invitar.' },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Revisa el correo.' },
      { status: 400 },
    );
  }

  const db = getOrgScopedClient(user.organization.id);
  const { plan } = await readWorkspacePlan(db);
  const seats = await readSeats(db, user.organization.id, plan.seatsLimit);

  if (seats.full) {
    return NextResponse.json(
      {
        error:
          `Tu plan ${plan.name} llega hasta ${seats.limit} personas y ya están ocupadas ` +
          `(${seats.members} adentro${seats.pending > 0 ? ` y ${seats.pending} por aceptar` : ''}). ` +
          'Amplía el plan en Plan y consumo, o cancela una invitación pendiente.',
        reason: 'plan_limit',
        meter: 'seats',
      },
      { status: 402 },
    );
  }

  try {
    const invitation = await auth.api.createInvitation({
      body: {
        email: parsed.data.email,
        role: parsed.data.role,
        // Stated rather than left to the session's active workspace. The two are
        // the same value here — `requireSession` resolved it — but naming it
        // means a stale `activeOrganizationId` cannot send an invitation into a
        // workspace this request was not acting in.
        organizationId: user.organization.id,
        // Re-inviting somebody whose first email got lost should send another
        // one, not fail with "ya está invitado". The seat check above already
        // counted that pending invitation, so this cannot buy a second seat.
        resend: true,
      },
      headers: await headers(),
    });
    return NextResponse.json({ ok: true, id: (invitation as { id?: string })?.id ?? null });
  } catch (err) {
    // better-auth's own refusals (already a member, already invited) carry a
    // usable sentence; anything else gets a generic one rather than a stack.
    const message = err instanceof Error ? err.message : '';
    return NextResponse.json(
      {
        error:
          message && message.length < 200
            ? message
            : 'No se pudo enviar la invitación. Inténtalo de nuevo.',
      },
      { status: 400 },
    );
  }
}
