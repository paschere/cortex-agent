import 'server-only';

/**
 * Invitar a varias personas, reenviar y aplicar lo que la invitación llevaba.
 *
 * ===========================================================================
 * QUÉ HAY AQUÍ Y QUÉ NO
 * ===========================================================================
 * `inviteToCompany` (membership-admin.ts) sigue siendo LA forma de invitar a UNA
 * persona: comprueba el tope de asientos y le pide a better-auth la invitación.
 * No se toca ni se copia. Este archivo la envuelve con lo que le faltaba para
 * que invitar sea cómodo:
 *
 *   - varias direcciones en una pasada, con un resultado POR correo (enviada, ya
 *     es miembro, sin cupo…), porque «3 de 5 salieron» es información que quien
 *     invita necesita y un único «error» no le da;
 *   - el mensaje, el cargo y el equipo (migración 0199), que se guardan atados a
 *     la invitación y se aplican cuando la persona acepta;
 *   - reenviar una pendiente sin perder esos datos, también la vencida.
 *
 * El asiento se vuelve a comprobar en CADA invitación, no una vez para el lote:
 * cada pendiente cuenta como asiento, así que la tercera de cinco puede ser la
 * que no cabe, y es justo la que hay que decir.
 */

import { z } from 'zod';
import { pool } from '../auth';
import { resolveSessionDirectory } from '../session-directory';
import { getOrgScopedClient } from '../supabase/service';
import { withInvitationMessage } from './invitation-context';
import {
  type InviteEmailResult,
  type InviteStatus,
  MAX_INVITES_PER_REQUEST,
} from './invitation-input';
import { cancelInvitation } from './invitations';
import { inviteToCompany } from './membership-admin';

export interface InviteDetails {
  message?: string | null;
  /** Cargo con el que entra (work_people_meta.role_label). */
  position?: string | null;
  /** Equipo al que se une (team_members). Tiene que ser de esta empresa. */
  teamId?: string | null;
}

const MESSAGE_MAX = 600;
const POSITION_MAX = 80;

export function cleanDetails(details: InviteDetails | undefined): Required<InviteDetails> {
  const text = (value: string | null | undefined, max: number) => {
    const trimmed = (value ?? '').replace(/\r\n/g, '\n').trim();
    return trimmed ? trimmed.slice(0, max) : null;
  };
  return {
    message: text(details?.message, MESSAGE_MAX),
    position: text(details?.position, POSITION_MAX),
    teamId: details?.teamId?.trim() || null,
  };
}

/** ¿Este equipo es de esta empresa? Un id ajeno no se acepta ni se aplica. */
export async function teamBelongsToOrganization(
  organizationId: string,
  teamId: string,
): Promise<boolean> {
  if (!z.string().uuid().safeParse(teamId).success) return false;
  const { rows } = await pool.query(
    'select 1 from public.teams where id = $1 and organization_id = $2',
    [teamId, organizationId],
  );
  return rows.length > 0;
}

async function isAlreadyMember(organizationId: string, email: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1
       from public.ba_member m
       join public.ba_user b on b.id = m."userId"
      where m."organizationId" = $1 and lower(b.email) = lower($2)
      limit 1`,
    [organizationId, email],
  );
  return rows.length > 0;
}

async function pendingInvitationFor(
  organizationId: string,
  email: string,
): Promise<{ id: string; message: string | null } | null> {
  const { rows } = await pool.query<{ id: string; message: string | null }>(
    `select i.id, d.personal_message as message
       from public.ba_invitation i
       left join public.invitation_details d
         on d.invitation_id = i.id and d.organization_id = i."organizationId"
      where i."organizationId" = $1 and lower(i.email) = lower($2)
        and i.status = 'pending' and i."expiresAt" > now()
      order by i."expiresAt" desc
      limit 1`,
    [organizationId, email],
  );
  return rows[0] ?? null;
}

async function saveDetails(input: {
  invitationId: string;
  organizationId: string;
  invitedBy: string | null;
  details: Required<InviteDetails>;
}): Promise<void> {
  const { details } = input;
  if (!details.message && !details.position && !details.teamId) return;
  // Reenviar sin datos nuevos no borra los que ya había: `coalesce` conserva.
  // El `where` impide que un id de invitación de OTRA empresa se pise desde aquí.
  await pool.query(
    `insert into public.invitation_details
       (invitation_id, organization_id, personal_message, position_label, team_id, invited_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (invitation_id) do update set
       personal_message = coalesce(excluded.personal_message, invitation_details.personal_message),
       position_label   = coalesce(excluded.position_label, invitation_details.position_label),
       team_id          = coalesce(excluded.team_id, invitation_details.team_id)
     where invitation_details.organization_id = excluded.organization_id`,
    [
      input.invitationId,
      input.organizationId,
      details.message,
      details.position,
      details.teamId,
      input.invitedBy,
    ],
  );
}

function statusFor(result: { reason?: string; message: string }): InviteStatus {
  if (result.reason === 'plan_limit') return 'no_seats';
  if (/already a member|ya es miembro/i.test(result.message)) return 'already_member';
  if (/already invited|ya (fue|est[aá]) invitad/i.test(result.message)) return 'already_invited';
  return 'failed';
}

/**
 * Invitar a una o varias direcciones a UNA empresa, con un resultado por cada una.
 *
 * `inviterAccountId` se guarda sólo como rastro (`invited_by`); quien de verdad
 * autoriza es better-auth, con las cabeceras de la sesión de quien invita.
 */
export async function inviteEmails(input: {
  organizationId: string;
  emails: readonly string[];
  /** `owner` sólo llega aquí desde la ruta, después de comprobar fundador y re-autenticación. */
  role: 'member' | 'admin' | 'owner';
  details?: InviteDetails;
  requestHeaders: Headers;
  inviterAccountId?: string | null;
}): Promise<InviteEmailResult[]> {
  const details = cleanDetails(input.details);
  const results: InviteEmailResult[] = [];
  const emailSchema = z.string().email();
  let seatsFull: string | null = null;

  for (const raw of input.emails.slice(0, MAX_INVITES_PER_REQUEST)) {
    const email = raw.trim().toLowerCase();
    if (!emailSchema.safeParse(email).success) {
      results.push({
        email: raw,
        status: 'invalid',
        message: 'Ese correo no parece válido.',
      });
      continue;
    }
    if (seatsFull) {
      results.push({ email, status: 'no_seats', message: seatsFull });
      continue;
    }
    if (await isAlreadyMember(input.organizationId, email)) {
      results.push({
        email,
        status: 'already_member',
        message: 'Esta persona ya está en la empresa.',
      });
      continue;
    }

    const pending = await pendingInvitationFor(input.organizationId, email);
    // Sin mensaje nuevo, el reenvío conserva el que ya llevaba la invitación.
    const message = details.message ?? pending?.message ?? null;
    const result = await withInvitationMessage(message, () =>
      inviteToCompany({
        organizationId: input.organizationId,
        email,
        role: input.role,
        requestHeaders: input.requestHeaders,
      }),
    );

    if (!result.ok) {
      const status = statusFor(result);
      if (status === 'no_seats') seatsFull = result.message;
      results.push({ email, status, message: result.message });
      continue;
    }

    if (result.id) {
      try {
        await saveDetails({
          invitationId: result.id,
          organizationId: input.organizationId,
          invitedBy: input.inviterAccountId ?? null,
          details,
        });
      } catch (err) {
        // La invitación ya salió: perder el cargo o el equipo no puede volverla
        // un error. Se anota y quien invita puede ponerlos a mano al aceptar.
        console.error('[invite-flow] no se pudieron guardar los datos de la invitación', err);
      }
    }
    results.push({
      email,
      status: 'sent',
      message: pending ? 'Reenviada: el enlace nuevo ya dura siete días.' : 'Invitación enviada.',
      id: result.id ?? null,
    });
  }
  return results;
}

/* ---------------------------------------------------------------------------
 * Reenviar
 * ------------------------------------------------------------------------- */

/**
 * Reenviar una invitación pendiente de ESTA empresa, vencida o no.
 *
 * Una vencida no se puede refrescar (better-auth sólo refresca las vivas e
 * inserta una fila nueva si no encuentra una), así que se cancela primero y se
 * invita de nuevo, pasando el cargo, el equipo y el mensaje a la fila nueva.
 */
export async function resendInvitation(input: {
  organizationId: string;
  invitationId: string;
  requestHeaders: Headers;
  inviterAccountId?: string | null;
}): Promise<InviteEmailResult> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: string | null;
    expiresAt: Date | string;
    message: string | null;
    position: string | null;
    teamId: string | null;
  }>(
    `select i.id, i.email, i.role, i."expiresAt",
            d.personal_message as message, d.position_label as position, d.team_id as "teamId"
       from public.ba_invitation i
       left join public.invitation_details d
         on d.invitation_id = i.id and d.organization_id = i."organizationId"
      where i.id = $1 and i."organizationId" = $2 and i.status = 'pending'`,
    [input.invitationId, input.organizationId],
  );
  const current = rows[0];
  if (!current) {
    return {
      email: '',
      status: 'failed',
      message: 'Esa invitación ya no está pendiente. Recarga la pantalla.',
    };
  }
  // Reenviar una vencida es crear otra, y dar la propiedad pide confirmar que
  // eres tú: la de cofundador se cancela y se vuelve a invitar, con ese paso.
  if (current.role === 'owner') {
    return {
      email: current.email,
      status: 'failed',
      message:
        'Una invitación de cofundador no se reenvía: compártele el enlace, o cancélala e invítalo de nuevo.',
    };
  }

  const expired = new Date(current.expiresAt).getTime() <= Date.now();
  if (expired) {
    const canceled = await cancelInvitation(
      getOrgScopedClient(input.organizationId),
      input.organizationId,
      current.id,
    );
    if (!canceled) {
      return {
        email: current.email,
        status: 'failed',
        message: 'Esa invitación ya no está pendiente. Recarga la pantalla.',
      };
    }
  }

  const [result] = await inviteEmails({
    organizationId: input.organizationId,
    emails: [current.email],
    role: current.role === 'admin' ? 'admin' : 'member',
    details: { message: current.message, position: current.position, teamId: current.teamId },
    requestHeaders: input.requestHeaders,
    inviterAccountId: input.inviterAccountId,
  });
  if (expired && result?.id && result.id !== current.id) {
    await pool
      .query(
        'delete from public.invitation_details where invitation_id = $1 and organization_id = $2',
        [current.id, input.organizationId],
      )
      .catch(() => {});
  }
  return result ?? { email: current.email, status: 'failed', message: 'No se pudo reenviar.' };
}

/* ---------------------------------------------------------------------------
 * Leer las pendientes con su detalle
 * ------------------------------------------------------------------------- */

export interface InvitationDetailRow {
  id: string;
  email: string;
  role: 'member' | 'admin' | 'owner';
  expiresAt: string;
  expired: boolean;
  inviterName: string | null;
  message: string | null;
  position: string | null;
  teamName: string | null;
}

/**
 * Las pendientes de ESTA empresa con quién invitó y lo que llevan. El filtro por
 * empresa va en el `where`: `ba_invitation` es `shared` y nada la acota sola.
 */
export async function listInvitationDetails(
  organizationId: string,
  now: Date = new Date(),
): Promise<InvitationDetailRow[]> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: string | null;
    expiresAt: Date | string;
    inviterName: string | null;
    inviterEmail: string | null;
    message: string | null;
    position: string | null;
    teamName: string | null;
  }>(
    `select i.id, i.email, i.role, i."expiresAt",
            u.name as "inviterName", u.email as "inviterEmail",
            d.personal_message as message, d.position_label as position, t.name as "teamName"
       from public.ba_invitation i
       left join public.ba_user u on u.id = i."inviterId"
       left join public.invitation_details d
         on d.invitation_id = i.id and d.organization_id = i."organizationId"
       left join public.teams t on t.id = d.team_id and t.organization_id = i."organizationId"
      where i."organizationId" = $1 and i.status = 'pending'
      order by i."expiresAt" desc`,
    [organizationId],
  );
  return rows.map((row) => {
    const expiresAt = new Date(row.expiresAt).toISOString();
    return {
      id: row.id,
      email: row.email,
      role: row.role === 'admin' || row.role === 'owner' ? row.role : 'member',
      expiresAt,
      expired: new Date(expiresAt).getTime() <= now.getTime(),
      inviterName: row.inviterName?.trim() || row.inviterEmail || null,
      message: row.message,
      position: row.position,
      teamName: row.teamName,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Al aceptar: aplicar el cargo y el equipo
 * ------------------------------------------------------------------------- */

/**
 * Aplicar el cargo y el equipo de la invitación a la persona que acaba de
 * aceptar. NUNCA lanza: la membresía ya existe, y un cargo que no se pudo
 * escribir no puede dejar a alguien mirando un error después de haber entrado.
 *
 * Necesita la fila de `public.users`, que `resolveSessionDirectory` crea (o
 * actualiza) a partir de la membresía recién escrita; por eso se llama aquí
 * mismo y no se espera a la primera visita.
 *
 * Se aplica UNA vez (`applied_at`): si después un administrador le cambia el
 * cargo, abrir de nuevo el enlace no lo pisa.
 */
export async function applyInvitationDetails(input: {
  invitationId: string;
  organizationId: string;
  accountId: string;
}): Promise<{ position: string | null; teamName: string | null }> {
  const nothing = { position: null, teamName: null };
  try {
    const { rows } = await pool.query<{
      position: string | null;
      teamId: string | null;
      teamName: string | null;
    }>(
      `select d.position_label as position, d.team_id as "teamId", t.name as "teamName"
         from public.invitation_details d
         left join public.teams t on t.id = d.team_id and t.organization_id = d.organization_id
        where d.invitation_id = $1 and d.organization_id = $2 and d.applied_at is null`,
      [input.invitationId, input.organizationId],
    );
    const details = rows[0];
    if (!details) return nothing;

    const directory = await resolveSessionDirectory(input.accountId, input.organizationId);
    if (!directory) return nothing;

    if (details.position) {
      await pool.query(
        `insert into public.work_people_meta (organization_id, user_id, role_label)
         values ($1, $2, $3)
         on conflict (organization_id, user_id) do update set role_label = excluded.role_label, updated_at = now()`,
        [input.organizationId, directory.id, details.position],
      );
    }
    if (details.teamId) {
      await pool.query(
        `insert into public.team_members (team_id, user_id, organization_id)
         values ($1, $2, $3)
         on conflict (team_id, user_id) do nothing`,
        [details.teamId, directory.id, input.organizationId],
      );
    }
    await pool.query(
      `update public.invitation_details set applied_at = now()
        where invitation_id = $1 and organization_id = $2`,
      [input.invitationId, input.organizationId],
    );
    return { position: details.position, teamName: details.teamName };
  } catch (err) {
    console.error('[invite-flow] no se pudieron aplicar el cargo y el equipo', err);
    return nothing;
  }
}
