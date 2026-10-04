import { ForbiddenError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';

/**
 * INVITAR A ALGUIEN A LA EMPRESA, DESDE EL CHAT.
 *
 *   team.invite   «invita a ana@x.com como administradora». Manda la invitación
 *                 por correo (en español, con el nombre de quien invita), con un
 *                 mensaje, un cargo y un equipo opcionales.
 *
 * ===========================================================================
 * POR QUÉ ESTA HERRAMIENTA NO INVITA ELLA MISMA
 * ===========================================================================
 * Invitar es de better-auth (`auth.api.createInvitation`): crea la fila, manda el
 * correo y comprueba que quien invita pertenezca a la empresa. Todo eso vive en
 * `apps/web`, y este paquete NO puede importar de la aplicación (lo consumen
 * también el runtime MCP y los tests). Copiar aquí una segunda forma de invitar
 * —insertar la fila a mano y mandar otro correo— es justo lo que se desvía de la
 * primera el día que alguien cambie el tope de asientos o el texto del correo.
 *
 * Por eso la herramienta recibe la capacidad por el contexto, igual que
 * `enqueueJob` (ver `ToolContext.inviteTeamMember`): `buildToolContext` la ata a
 * la MISMA función que usa la pantalla «Personas», con su tope de asientos. Si el
 * contexto no la trae (una rutina, el runtime MCP, un test), la herramienta lo
 * dice y manda a «Personas»; nunca finge que invitó.
 *
 * Quién puede: sólo quien administra la empresa o es su dueña (`isCompanyManager`,
 * la misma puerta de `work.configure`). Se comprueba AQUÍ y además la comprueba
 * better-auth con la sesión de quien invita: dos cerraduras. Y siempre pide
 * confirmación: invitar da acceso a la empresa, y ningún mandato lo delega
 * (security/mandatory-confirmation.ts).
 */

const INVITE_ROLES = ['member', 'admin'] as const;

const ROLE_WORD: Record<(typeof INVITE_ROLES)[number], string> = {
  member: 'miembro',
  admin: 'administrador',
};

export const teamInvite = registerTool({
  id: 'team.invite',
  description:
    'Invite a person to this company by email (admins and the company owner only). Sends a Spanish invitation with the inviter\'s name; the person creates an account (or logs in) and lands inside the company. `role` is "member" (works with Cortex and sees their own things and what is shared) or "admin" (also invites people, changes roles, configures the company); default "member". Optional `position` (cargo), `team` (name of an existing team, applied when they accept) and a short personal `message` shown in the email. One person per call. Respects the plan seat limit. Requires confirmation. Never use to invite someone who did not ask the user to be added.',
  inputSchema: z.object({
    email: z.string().trim().email().max(254),
    role: z.enum(INVITE_ROLES).optional(),
    position: z.string().trim().max(80).optional().describe('Cargo, p. ej. «Analista de cartera».'),
    team: z.string().trim().max(120).optional().describe('Name of an existing team.'),
    message: z.string().trim().max(600).optional().describe('Personal note for the email.'),
  }),
  outputSchema: z.object({
    status: z.enum(['sent', 'already_member', 'already_invited', 'no_seats', 'invalid', 'failed']),
    email: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    if (!(await isCompanyManager(ctx.db, ctx.userId)))
      throw new ForbiddenError(
        'Sólo quien administra la empresa o es su dueño puede invitar gente.',
      );
    if (!ctx.inviteTeamMember)
      throw new ValidationError(
        'Desde aquí no puedo mandar invitaciones. Hazlo en Personas (Administración → Personas) y queda igual.',
      );

    let teamId: string | null = null;
    if (input.team) {
      const { data, error } = await ctx.db.from('teams').select('id, name');
      if (error) throw error;
      const wanted = input.team.trim().toLowerCase();
      const teams = (data ?? []) as Array<{ id: string; name: string }>;
      const match = teams.find((team) => team.name.trim().toLowerCase() === wanted);
      if (!match)
        throw new ValidationError(
          teams.length > 0
            ? `No hay un equipo «${input.team}». Los equipos son: ${teams.map((t) => t.name).join(', ')}.`
            : `No hay un equipo «${input.team}» y todavía no hay equipos; se crean en Administración → Equipos.`,
        );
      teamId = match.id;
    }

    const role = input.role ?? 'member';
    const result = await ctx.inviteTeamMember({
      email: input.email,
      role,
      message: input.message ?? null,
      position: input.position ?? null,
      teamId,
    });

    const email = input.email.toLowerCase();
    if (result.status === 'sent') {
      const extras = [input.position, input.team ? `equipo ${input.team}` : null]
        .filter(Boolean)
        .join(', ');
      return {
        status: result.status,
        email,
        markdown: `Listo: le mandé la invitación a ${email} como ${ROLE_WORD[role]}${extras ? ` (${extras})` : ''}. El enlace dura siete días; mientras no acepte, la ves en Personas con la opción de reenviarla o copiar el enlace.`,
      };
    }
    return { status: result.status, email, markdown: result.message };
  },
});
