import 'server-only';

/**
 * Invitar desde una herramienta del chat, EN NOMBRE de quien habla.
 *
 * Es lo que `buildToolContext` ata a `ToolContext.inviteTeamMember` (lib/agent.ts).
 * Llama a la MISMA `inviteEmails` que la pantalla «Personas» —tope de asientos,
 * correo en español, mensaje, cargo y equipo incluidos—; lo único propio es
 * conseguir las cabeceras de sesión que better-auth exige para firmar la
 * invitación como la persona que invita.
 *
 * ===========================================================================
 * DE DÓNDE SALEN LAS CABECERAS, Y POR QUÉ SE VERIFICA QUE SEAN DE QUIEN HABLA
 * ===========================================================================
 * En el chat web la herramienta corre dentro de la petición de la persona, así
 * que `headers()` trae SU cookie. Fuera de una petición (una rutina, el runtime
 * MCP, la aprobación por Google Chat) no hay cookie y esto responde que no puede:
 * la alternativa sería firmar invitaciones sin una persona detrás, que es lo que
 * better-auth está hecho para no permitir.
 *
 * Aun con cookie se comprueba que la cuenta de la sesión sea la dueña de la fila
 * del directorio con la que corre la herramienta (`ctx.userId`): el correo de
 * una y de otra tienen que ser el mismo en ESTA empresa. Sin eso, un contexto
 * armado para una persona podría invitar con la sesión de otra.
 */

import { headers } from 'next/headers';
import { auth, pool } from '../auth';
import type { InviteStatus } from './invitation-input';
import { inviteEmails } from './invite-flow';

export interface ActorInviteResult {
  status: InviteStatus;
  message: string;
}

export async function inviteForActor(input: {
  organizationId: string;
  /** El id de la fila del directorio (`public.users`) con la que corre la herramienta. */
  actorDirectoryId: string;
  email: string;
  role: 'member' | 'admin';
  message?: string | null;
  position?: string | null;
  teamId?: string | null;
}): Promise<ActorInviteResult> {
  let requestHeaders: Headers;
  try {
    requestHeaders = await headers();
  } catch {
    return {
      status: 'failed',
      message:
        'Desde aquí no puedo firmar una invitación (no hay una sesión abierta). Hazla en Administración → Personas.',
    };
  }

  const session = await auth.api.getSession({ headers: requestHeaders });
  const accountId = session?.user?.id;
  if (!accountId || !session?.user?.email) {
    return {
      status: 'failed',
      message: 'Tu sesión venció. Vuelve a entrar e inténtalo de nuevo.',
    };
  }

  const { rows } = await pool.query<{ email: string }>(
    'select email from public.users where id = $1 and organization_id = $2',
    [input.actorDirectoryId, input.organizationId],
  );
  const directoryEmail = rows[0]?.email?.toLowerCase();
  if (!directoryEmail || directoryEmail !== session.user.email.toLowerCase()) {
    return {
      status: 'failed',
      message: 'No pude comprobar que la sesión abierta sea la tuya en esta empresa.',
    };
  }

  const [result] = await inviteEmails({
    organizationId: input.organizationId,
    emails: [input.email],
    role: input.role,
    details: { message: input.message, position: input.position, teamId: input.teamId },
    requestHeaders,
    inviterAccountId: accountId,
  });
  return result
    ? { status: result.status, message: result.message }
    : { status: 'failed', message: 'No se pudo enviar la invitación.' };
}
