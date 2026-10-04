import 'server-only';
import { pool } from '../auth';
import type { InvitationFacts } from './invitation-landing-shape';

/**
 * Leer una invitación POR SU ID para la página pública del enlace.
 *
 * ===========================================================================
 * POR QUÉ AQUÍ SE LEE LA TABLA A MANO, SIN SESIÓN
 * ===========================================================================
 * La página `/accept-invitation/<id>` la abre alguien que quizá no tiene cuenta
 * todavía, así que no hay `requireSession` ni manejador acotado por espacio: la
 * credencial ES el id (aleatorio de better-auth, que viaja sólo en el correo o en
 * el enlace que alguien copió). Es la misma postura que los enlaces de
 * cotización o de encuesta (lib/sales/public.ts): el token abre exactamente UNA
 * cosa, y de esa cosa sale lo mínimo.
 *
 * Lo que sale: empresa (nombre y logo si lo tiene), quién invitó, correo
 * invitado, rol, vencimiento y el mensaje personal. NO sale nada de la empresa
 * más allá de eso: ni miembros, ni plan, ni otras invitaciones. Un id que no
 * existe devuelve `null` y la página dice «no encontramos esta invitación», sin
 * distinguir entre «nunca existió» y «es de otro».
 *
 * `ba_invitation`, `ba_organization` y `ba_user` son `shared` (tenancy/tables.ts)
 * y esta lectura va por `pool`, no por el cliente de servicio, así que no entra
 * en la lista de tenancy-guard.
 */

export interface InvitationLanding extends InvitationFacts {
  organizationId: string;
  organizationName: string;
  /** Sólo si es una URL https; nunca un valor arbitrario de la columna. */
  organizationLogo: string | null;
  inviterName: string;
  message: string | null;
}

/**
 * Si la base falla, la excepción sube: un fallo nuestro no puede leerse como
 * «el enlace no existe» y mandar a alguien a pedir otra invitación de balde.
 */
const ID_SHAPE = /^[A-Za-z0-9_:-]{1,128}$/;

export async function readInvitationLanding(id: string): Promise<InvitationLanding | null> {
  if (!ID_SHAPE.test(id)) return null;
  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: string | null;
    status: string;
    expiresAt: Date | string;
    organizationId: string;
    organizationName: string;
    logo: string | null;
    inviterName: string | null;
    inviterEmail: string | null;
    message: string | null;
  }>(
    `select i.id, i.email, i.role, i.status, i."expiresAt", i."organizationId",
              o.name as "organizationName", o.logo,
              u.name as "inviterName", u.email as "inviterEmail",
              d.personal_message as message
         from public.ba_invitation i
         join public.ba_organization o on o.id = i."organizationId"
         left join public.ba_user u on u.id = i."inviterId"
         left join public.invitation_details d
           on d.invitation_id = i.id and d.organization_id = i."organizationId"
        where i.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: new Date(row.expiresAt).toISOString(),
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationLogo: row.logo && /^https:\/\//i.test(row.logo) ? row.logo : null,
    inviterName: row.inviterName?.trim() || row.inviterEmail || 'Alguien de tu equipo',
    message: row.message,
  };
}

export interface WelcomeFacts {
  inviterName: string;
  role: string | null;
  message: string | null;
  position: string | null;
  teamName: string | null;
}

/**
 * Lo que la bienvenida cuenta de la invitación que la persona ACABA de aceptar.
 *
 * A diferencia de `readInvitationLanding`, esta lectura es de alguien con sesión
 * y exige tres cosas a la vez: que la invitación sea de la empresa en la que
 * está, que su correo sea el de la invitación y que esté aceptada. Con un id
 * ajeno, o de otra empresa, no devuelve nada: la bienvenida sale genérica.
 */
export async function readWelcomeFacts(input: {
  invitationId: string;
  organizationId: string;
  email: string;
}): Promise<WelcomeFacts | null> {
  if (!ID_SHAPE.test(input.invitationId)) return null;
  const { rows } = await pool.query<{
    role: string | null;
    inviterName: string | null;
    inviterEmail: string | null;
    message: string | null;
    position: string | null;
    teamName: string | null;
  }>(
    `select i.role, u.name as "inviterName", u.email as "inviterEmail",
            d.personal_message as message, d.position_label as position, t.name as "teamName"
       from public.ba_invitation i
       left join public.ba_user u on u.id = i."inviterId"
       left join public.invitation_details d
         on d.invitation_id = i.id and d.organization_id = i."organizationId"
       left join public.teams t on t.id = d.team_id and t.organization_id = i."organizationId"
      where i.id = $1 and i."organizationId" = $2
        and lower(i.email) = lower($3) and i.status = 'accepted'`,
    [input.invitationId, input.organizationId, input.email],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    inviterName: row.inviterName?.trim() || row.inviterEmail || 'Tu equipo',
    role: row.role,
    message: row.message,
    position: row.position,
    teamName: row.teamName,
  };
}
