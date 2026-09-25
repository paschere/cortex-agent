import { requireSession } from '@/lib/session';
import { inviteToCompany } from '@/lib/team/membership-admin';
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
 * a fourth invitation interrupts nothing. The three people already inside keep
 * working, nobody is mid-anything, and there is no half-finished state to
 * protect. Contrast the answers meter, which gets a courtesy margin precisely
 * because a person IS mid-something when it runs out. See LIMIT_POLICY in
 * packages/agent-tools/src/billing/plans.ts.
 *
 * SINCE MIGRATION 0086 THIS ONLY EVER REFUSES ON THE FREE PLAN. `seatsMaximum`
 * is null on Equipo, Empresa and Enterprise, because Cortex is priced per person
 * and a ceiling on a per-person price is a rule that declines money and caps the
 * customer's quota at the same time. The plan minimums (5 and 25) are floors on
 * the BILL and are not consulted here at all — a team of eight belongs on Equipo,
 * and a team of three that wants it pays for five rather than being told to hire.
 */
const Body = z.object({
  email: z.string().email('Ese correo no parece válido.'),
  role: z.enum(['member', 'admin']).default('member'),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (user.organization.kind === 'personal') {
    return NextResponse.json(
      { error: 'Tu espacio personal es privado. Crea una empresa para invitar a tu equipo.' },
      { status: 403 },
    );
  }

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

  // El tope de asientos y la llamada a better-auth viven en
  // lib/team/membership-admin.ts, compartidos con la consola del fundador, que
  // invita a varias empresas a la vez. Este comentario de cabecera sigue
  // siendo el porqué; aquella función es el cómo.
  const result = await inviteToCompany({
    organizationId: user.organization.id,
    email: parsed.data.email,
    role: parsed.data.role,
    requestHeaders: await headers(),
  });
  if (result.ok) return NextResponse.json({ ok: true, id: result.id ?? null });
  return NextResponse.json(
    result.reason === 'plan_limit'
      ? { error: result.message, reason: 'plan_limit', meter: 'seats' }
      : { error: result.message },
    { status: result.status },
  );
}
