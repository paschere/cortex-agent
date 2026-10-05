import { normalizeMembershipRole } from '@/lib/founder-rules';
import { inviteCofounder } from '@/lib/team/founder-admin';
import { MAX_INVITES_PER_REQUEST, parseEmailList } from '@/lib/team/invitation-input';
import { inviteEmails, teamBelongsToOrganization } from '@/lib/team/invite-flow';
import { requireInviter } from '@/lib/team/invite-guard';
import { verifyStepUp } from '@/lib/team/step-up';
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
/**
 * DOS FORMAS DE LLAMARLA, UNA SOLA IMPLEMENTACIÓN.
 *
 *   { email, role }                      la de siempre (un solo correo). Responde
 *                                        `{ ok: true, id }` o el error con su código,
 *                                        exactamente como antes.
 *   { emails: [...], role, message?,     varias a la vez, con mensaje personal, cargo
 *     position?, teamId? }               y equipo. Responde `{ ok, results }` con UN
 *                                        resultado por correo; el HTTP es 200 aunque
 *                                        alguno no haya salido, porque «3 de 5» no es
 *                                        un error de la petición.
 *
 * El tope de asientos se comprueba en cada invitación (ver lib/team/invite-flow.ts).
 */
const Body = z
  .object({
    email: z.string().email('Ese correo no parece válido.').optional(),
    emails: z
      .array(z.string().max(320))
      .max(MAX_INVITES_PER_REQUEST * 4)
      .optional(),
    role: z.enum(['member', 'admin', 'owner']).default('member'),
    message: z.string().max(600).optional(),
    position: z.string().max(80).optional(),
    teamId: z.string().max(64).nullish(),
    // Sólo para `owner`: confirmar que eres tú (ver lib/team/step-up.ts).
    password: z.string().max(512).optional(),
    code: z.string().max(16).optional(),
  })
  .refine((body) => body.email || (body.emails && body.emails.length > 0), {
    message: 'Escribe al menos un correo.',
  });

export async function POST(req: NextRequest) {
  const gate = await requireInviter();
  if (!gate.ok) return gate.response;
  const { user, accountId } = gate;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Revisa el correo.' },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // El equipo viaja como id, y un id de otra empresa no se aplica ni se guarda.
  if (body.teamId && !(await teamBelongsToOrganization(user.organization.id, body.teamId))) {
    return NextResponse.json({ error: 'Ese equipo no es de este espacio.' }, { status: 400 });
  }

  const single = Boolean(body.email) && !body.emails;
  const list = single
    ? parseEmailList(body.email ?? '')
    : parseEmailList((body.emails ?? []).join('\n'));
  if (list.valid.length + list.invalid.length === 0) {
    return NextResponse.json({ error: 'Escribe al menos un correo.' }, { status: 400 });
  }
  if (list.valid.length > MAX_INVITES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Invita de a ${MAX_INVITES_PER_REQUEST} personas como máximo por vez.` },
      { status: 400 },
    );
  }

  const requestHeaders = await headers();
  const send = (emails: string[]) =>
    inviteEmails({
      organizationId: user.organization.id,
      emails,
      role: body.role,
      details: { message: body.message, position: body.position, teamId: body.teamId },
      requestHeaders,
      inviterAccountId: accountId,
    });

  /**
   * INVITAR COMO COFUNDADOR: EL MISMO PODER QUE «HACER COFUNDADOR».
   *
   * Quien acepte entra como dueño de la empresa, así que se piden las mismas
   * tres cosas que al nombrar a alguien de adentro: que quien invita sea
   * fundador (leído de `ba_member` en esta petición, no de lo que mandó el
   * navegador), que confirme que es él (contraseña o código de 2 pasos), y una
   * sola persona por vez. Queda en la auditoría y se avisa a los fundadores.
   */
  if (body.role === 'owner') {
    if (normalizeMembershipRole(user.organization.role) !== 'owner') {
      return NextResponse.json(
        { error: 'Solo un fundador puede invitar a un cofundador.' },
        { status: 403 },
      );
    }
    if (list.valid.length !== 1 || list.invalid.length > 0) {
      return NextResponse.json(
        { error: 'Invita a los cofundadores de a uno, con un correo válido.' },
        { status: 400 },
      );
    }
    const step = await verifyStepUp({
      accountId,
      requestHeaders,
      credential: { password: body.password, code: body.code },
    });
    if (!step.ok) {
      return NextResponse.json(
        { error: step.message, requirement: step.requirement },
        { status: 403 },
      );
    }
  }

  const results =
    body.role === 'owner'
      ? [
          await inviteCofounder(
            {
              organizationId: user.organization.id,
              organizationName: user.organization.name,
              workspaceKind: user.organization.kind === 'personal' ? 'personal' : 'company',
              actorAccountId: accountId,
              actorUserId: user.id,
              requestHeaders,
            },
            list.valid[0] as string,
            async () =>
              (await send(list.valid))[0] ?? {
                email: list.valid[0] as string,
                status: 'failed' as const,
                message: 'No se pudo enviar la invitación.',
              },
          ),
        ]
      : await send(list.valid);
  // Los que no parecían correo no llegaron a `inviteEmails`: se informan igual.
  for (const bad of list.invalid) {
    results.push({ email: bad, status: 'invalid', message: 'Ese correo no parece válido.' });
  }

  if (!single) return NextResponse.json({ ok: results.some((r) => r.status === 'sent'), results });

  // Contrato de siempre para un solo correo.
  const only = results[0];
  if (only?.status === 'sent') return NextResponse.json({ ok: true, id: only.id ?? null });
  if (only?.status === 'no_seats') {
    return NextResponse.json(
      { error: only.message, reason: 'plan_limit', meter: 'seats' },
      { status: 402 },
    );
  }
  return NextResponse.json(
    { error: only?.message ?? 'No se pudo enviar la invitación.' },
    { status: 400 },
  );
}
