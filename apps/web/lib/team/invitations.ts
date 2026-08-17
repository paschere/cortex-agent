import 'server-only';

/**
 * Las invitaciones que todavía no ha aceptado nadie: leerlas y cancelarlas.
 *
 * ===========================================================================
 * POR QUÉ SE LEE LA TABLA A MANO Y NO POR `auth.api.listInvitations`
 * ===========================================================================
 * better-auth expone `listInvitations` y `cancelInvitation`, y ninguna de las
 * dos se llamaba en el repositorio. No se llaman ahora tampoco, y la razón no es
 * gusto:
 *
 *  - `listInvitations` devuelve TODAS las filas del espacio, de cualquier estado
 *    —aceptadas, canceladas, rechazadas—, así que el filtro «pendiente» acabaría
 *    escrito en JavaScript aquí. La cifra de asientos que sale al lado la calcula
 *    `readSeats` con un `status = 'pending'` en la base. Dos reglas distintas
 *    para la misma pregunta se separan el día que alguien toque una: la lista
 *    diría tres y el contador cuatro, en la misma pantalla.
 *
 *  - `cancelInvitation` recibe SÓLO el id de la invitación y deduce la empresa de
 *    la propia fila; lo que comprueba después es que quien llama sea miembro de
 *    ESA empresa. No es la misma pregunta que «¿esta invitación es del espacio en
 *    el que va esta petición?». Una persona puede pertenecer hasta a cinco
 *    espacios (`organizationLimit` en lib/auth.ts), así que con un id ajeno en el
 *    cuerpo cancelaría la invitación del OTRO espacio y better-auth lo daría por
 *    bueno. Es exactamente el motivo por el que `api/team/invite/route.ts` nombra
 *    `organizationId` en vez de fiarse de la organización activa de la sesión.
 *    Para usarlo con seguridad habría que leer la fila antes y comparar — o sea,
 *    escribir igualmente el filtro de abajo, y encima dejar una carrera entre la
 *    comprobación y la escritura.
 *
 * Aquí el espacio va en el WHERE de la propia sentencia. Un id de otro inquilino
 * no coincide con ninguna fila: no se lee, no se cancela, y `cancelInvitation`
 * devuelve `false` en vez de un «listo» que no hizo nada.
 *
 * ===========================================================================
 * EL FILTRO ES A MANO PORQUE `ba_invitation` ES `shared`
 * ===========================================================================
 * Está clasificada `shared(...)` en packages/agent-tools/src/tenancy/tables.ts,
 * así que el manejador acotado la deja pasar TAL CUAL: no le añade
 * `organization_id` a nada, entre otras cosas porque la columna se llama
 * `"organizationId"` y es de better-auth. Es la misma excepción que ya documenta
 * `readSeats` en billing/usage.ts, y el mismo cuidado: el id sale del espacio al
 * que ya está fijado el manejador, nunca de lo que mandó el navegador.
 */

import { mustReadList } from '@/lib/supabase/read';
import type { SupabaseClient } from '@supabase/supabase-js';

export const INVITATIONS_TABLE = 'ba_invitation';

/**
 * El estado que escribe better-auth al cancelar, con una sola ele.
 *
 * Se nombra en vez de escribirse suelto porque es un valor COMPARTIDO con una
 * dependencia: sus propias consultas de pendientes filtran por `'pending'` y su
 * `cancelInvitation` escribe `'canceled'`. Un `'cancelled'` de más aquí no
 * fallaría —la columna es texto libre— y la invitación seguiría ocupando asiento
 * para siempre, invisible en esta pantalla y contada por `readSeats`.
 */
export const CANCELED = 'canceled';
export const PENDING = 'pending';

/** Los roles que better-auth guarda en la columna. `owner` sólo lo tiene quien creó el espacio. */
export type InvitationRole = 'member' | 'admin' | 'owner';

export interface PendingInvitation {
  id: string;
  email: string;
  role: InvitationRole;
  /** Cuándo caduca el enlace. Duran 48h — `invitationExpiresIn` en lib/auth.ts. */
  expiresAt: string;
  /**
   * Ya pasó la fecha. Sigue en la lista a propósito: better-auth no borra ni
   * marca las vencidas, así que ocultarlas dejaría un asiento ocupado por una
   * fila que nadie puede ver ni cancelar. Se lee «vencida», no desaparece.
   */
  expired: boolean;
}

interface InvitationRow {
  id: string;
  email: string;
  role: string | null;
  expiresAt: string;
}

const COLUMNS = 'id, email, role, expiresAt';

/**
 * Las invitaciones pendientes de este espacio, la más reciente primero.
 *
 * Se ordena por caducidad y no por creación porque `ba_invitation` no tiene
 * `createdAt` (migración 0052) y la caducidad ES la fecha de envío más 48 horas
 * fijas: ordenar por una es ordenar por la otra, sin añadir una columna.
 *
 * Va por `mustReadList` y no por un `?? []`: «no hay invitaciones pendientes» y
 * «no pude leer la tabla» se dibujan igual y significan lo contrario, y aquí la
 * segunda además haría creer que hay asientos libres que no hay.
 */
export async function listPendingInvitations(
  db: SupabaseClient,
  organizationId: string,
  at: Date = new Date(),
): Promise<PendingInvitation[]> {
  const rows = mustReadList<InvitationRow>(
    await db
      .from(INVITATIONS_TABLE)
      .select(COLUMNS)
      .eq('organizationId', organizationId)
      .eq('status', PENDING)
      .order('expiresAt', { ascending: false }),
    'las invitaciones pendientes de este espacio',
  );

  const now = at.getTime();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: (row.role === 'admin' || row.role === 'owner' ? row.role : 'member') as InvitationRole,
    expiresAt: row.expiresAt,
    expired: new Date(row.expiresAt).getTime() <= now,
  }));
}

/**
 * Cancelar una invitación de ESTE espacio. Devuelve si tocó alguna fila.
 *
 * Los tres filtros hacen tres cosas distintas y ninguno sobra:
 *
 *   organizationId  el aislamiento. Es el único de los tres cuya ausencia sería
 *                   un incidente y no una molestia.
 *   id              cuál.
 *   status pending  que no se pueda «cancelar» una invitación ya aceptada. La
 *                   persona ya está adentro; el botón diría que la sacó y no la
 *                   sacaría, que es la peor forma de fallar que tiene un botón.
 *
 * El `false` importa tanto como el `true`: sin él, un id de otro inquilino —o
 * uno inventado— saldría por pantalla como una cancelación hecha.
 *
 * Cancelar libera el asiento sin más trabajo, porque `readSeats` cuenta
 * `status = 'pending'` y esta fila deja de serlo.
 */
export async function cancelInvitation(
  db: SupabaseClient,
  organizationId: string,
  invitationId: string,
): Promise<boolean> {
  const { data: canceled, error } = await db
    .from(INVITATIONS_TABLE)
    .update({ status: CANCELED })
    .eq('id', invitationId)
    .eq('organizationId', organizationId)
    .eq('status', PENDING)
    .select('id');

  if (error) {
    throw new Error(`No se pudo cancelar la invitación: ${error.message}`);
  }
  return (canceled ?? []).length > 0;
}
