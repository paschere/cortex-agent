import { auth } from '@/lib/auth';
import { setActiveOrganization } from '@/lib/organization';
import { applyInvitationDetails } from '@/lib/team/invite-flow';
import { workspaceHref } from '@/lib/workspace-context';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Aceptar o rechazar una invitación, del lado del servidor.
 *
 * ===========================================================================
 * POR QUÉ YA NO SE LLAMA A better-auth DESDE EL NAVEGADOR
 * ===========================================================================
 * Aceptar tiene cuatro pasos y el navegador sólo podía hacer el primero:
 *
 *   1. `acceptInvitation` de better-auth: crea la membresía. No toca la
 *      organización activa de la sesión (comprobado en la 1.6.24).
 *   2. Poner esa empresa como activa — con `setActiveOrganization`, que comprueba
 *      la membresía antes de escribir, igual que `/api/organizations/active`.
 *   3. Crear la fila del directorio y aplicar el cargo y el equipo que la
 *      invitación llevaba (migración 0199). Necesita la membresía recién creada.
 *   4. Decirle al navegador a dónde ir: a la bienvenida DENTRO de esa empresa,
 *      con `?workspace=` puesto. La sesión puede traer su `activeOrganizationId`
 *      viejo en la caché de cookie unos minutos, y la URL con el espacio es lo que
 *      no depende de esa caché.
 *
 * Hechos en el navegador eran cuatro viajes y un fallo a medias dejaba a alguien
 * dentro de la empresa y sin cargo. Aquí es uno, y los pasos 2 y 3 nunca
 * lanzan: la membresía ya existe, y un paso de comodidad no puede devolver un
 * error a quien ya entró.
 *
 * La autorización es de better-auth: comprueba que el correo de la invitación
 * sea el de la sesión y que siga pendiente y sin vencer. Esta ruta no lo repite.
 */
const Body = z.object({ action: z.enum(['accept', 'reject']) });

/** better-auth contesta en inglés; a la persona le sirve una frase que diga qué hacer. */
function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (/verification required/i.test(text))
    return 'Confirma tu correo con el enlace que te enviamos y vuelve a abrir esta invitación.';
  if (/recipient/i.test(text))
    return 'Esta invitación es para otro correo. Cierra sesión y entra con el correo al que llegó.';
  if (/not found|already|expired/i.test(text))
    return 'Esta invitación ya no está disponible: puede que haya vencido, que ya se haya aceptado o que la hayan cancelado.';
  return 'No se pudo responder la invitación. Inténtalo de nuevo o pide que te la envíen otra vez.';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Entra con tu cuenta para responder.' }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Falta la respuesta.' }, { status: 400 });

  if (parsed.data.action === 'reject') {
    try {
      await auth.api.rejectInvitation({ body: { invitationId: id }, headers: requestHeaders });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: explain(err) }, { status: 400 });
    }
  }

  let organizationId: string | undefined;
  try {
    const accepted = (await auth.api.acceptInvitation({
      body: { invitationId: id },
      headers: requestHeaders,
    })) as { member?: { organizationId?: string } } | null;
    organizationId = accepted?.member?.organizationId;
  } catch (err) {
    return NextResponse.json({ error: explain(err) }, { status: 400 });
  }
  if (!organizationId) {
    // La membresía se creó pero no sabemos de qué empresa: se sigue a la raíz,
    // que resuelve el espacio por su cuenta.
    return NextResponse.json({ ok: true, next: '/' });
  }

  try {
    await setActiveOrganization(session.user.id, organizationId);
  } catch (err) {
    console.error('[invitations] no se pudo activar la empresa recién aceptada', err);
  }
  await applyInvitationDetails({ invitationId: id, organizationId, accountId: session.user.id });

  return NextResponse.json({
    ok: true,
    organizationId,
    next: workspaceHref(organizationId, `/bienvenida?inv=${encodeURIComponent(id)}`),
  });
}
