/**
 * Lo que una invitación DICE: el rol en palabras y cuánto dura el enlace.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN ARCHIVO PURO Y COMPARTIDO
 * ===========================================================================
 * El rol de una invitación se cuenta en cuatro sitios —el correo, la página a la
 * que llega el enlace, la lista de pendientes y la herramienta del chat— y la
 * columna `ba_invitation.role` es texto libre de better-auth: `member`, `admin`
 * o `owner`. Si cada sitio traduce por su cuenta, uno dice «Administra» y otro
 * «Administrador» para lo mismo, y el día que alguien invite a un cofundador
 * (`owner`) tres de los cuatro caen al `member` por defecto y el correo promete
 * un acceso menor del que se concede. Una sola tabla, y un `owner` que se dice
 * «Cofundador» en todas partes.
 *
 * Sin `server-only` ni base de datos: la importan componentes de cliente.
 */

export type InvitationRole = 'member' | 'admin' | 'owner';

/** Cuánto vive el enlace. Lo lee `invitationExpiresIn` en lib/auth.ts. */
export const INVITATION_TTL_DAYS = 7;
export const INVITATION_TTL_SECONDS = INVITATION_TTL_DAYS * 24 * 60 * 60;

/** Cualquier cosa que no se reconozca baja al menor privilegio, nunca al mayor. */
export function normalizeInvitationRole(role: string | null | undefined): InvitationRole {
  return role === 'owner' || role === 'admin' ? role : 'member';
}

const LABEL: Record<InvitationRole, string> = {
  member: 'Miembro',
  admin: 'Administrador',
  owner: 'Cofundador',
};

const BLURB: Record<InvitationRole, string> = {
  member: 'Trabaja con Cortex y ve lo suyo y lo que le compartan.',
  admin: 'Además invita gente, cambia roles y configura la empresa.',
  owner:
    'Dueño de la empresa en Cortex: todo lo del administrador, y además nombra o retira cofundadores y puede borrar la empresa.',
};

export function invitationRoleLabel(role: string | null | undefined): string {
  return LABEL[normalizeInvitationRole(role)];
}

/** Una línea que explica qué puede hacer quien entra con ese rol. */
export function invitationRoleBlurb(role: string | null | undefined): string {
  return BLURB[normalizeInvitationRole(role)];
}

/** Los dos roles que se ofrecen al invitar desde la pantalla (owner no se ofrece). */
export const INVITABLE_ROLES: ReadonlyArray<{
  value: 'member' | 'admin';
  label: string;
  blurb: string;
}> = [
  { value: 'member', label: LABEL.member, blurb: BLURB.member },
  { value: 'admin', label: LABEL.admin, blurb: BLURB.admin },
];

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * «vence en 6 días», «vence en 5 h», «vencida».
 *
 * Cuenta de reloj y no de calendario: el enlace vale hasta una hora exacta, y
 * «vence mañana» a las 11 pm es una promesa que la mañana siguiente rompe.
 */
export function expiryCountdown(expiresAt: string | Date, now: Date = new Date()): string {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return 'vencida';
  if (left >= DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    return `vence en ${days} ${days === 1 ? 'día' : 'días'}`;
  }
  if (left >= HOUR_MS) return `vence en ${Math.floor(left / HOUR_MS)} h`;
  return `vence en ${Math.max(1, Math.floor(left / 60_000))} min`;
}

/** La fecha completa en hora de Bogotá: «sábado 10 de octubre, 3:20 p. m.». */
export function expiryDate(expiresAt: string | Date): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
