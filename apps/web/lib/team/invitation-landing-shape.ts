import { safeNextPath } from '../invite-landing';

/**
 * QUÉ MUESTRA LA PÁGINA DEL ENLACE, DECIDIDO CON HECHOS Y SIN PANTALLA.
 *
 * `/accept-invitation/<id>` la abre gente en cuatro situaciones muy distintas
 * (sin cuenta, con la cuenta correcta, con la cuenta equivocada, con un enlace
 * muerto) y antes mostraba lo mismo a todas: el id crudo y dos botones que
 * fallaban con «puede que haya vencido». Cada situación pide una pantalla
 * distinta, y equivocarse no revienta nada — enseña el botón que no toca—, que
 * es exactamente la clase de error que sólo se ve con una prueba. De ahí que la
 * regla sea una función que recibe hechos y devuelve una decisión.
 *
 * Sin `server-only`: lo importan la página (servidor) y sus pruebas.
 */

/** Los estados que escribe better-auth en `ba_invitation.status`. */
export type InvitationStatus = 'pending' | 'accepted' | 'canceled' | 'rejected';

export interface InvitationFacts {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string | Date;
}

/**
 * - `valid`      pendiente y con tiempo.
 * - `expired`    pendiente pero ya pasó la fecha (better-auth no la marca sola).
 * - `accepted`   ya se aceptó: el enlace sirve para entrar, no para aceptar otra vez.
 * - `closed`     cancelada o rechazada: la empresa la retiró o la persona dijo que no.
 * - `not_found`  no hay tal invitación. Es TAMBIÉN lo que ve quien inventa un id.
 */
export type LandingState = 'valid' | 'expired' | 'accepted' | 'closed' | 'not_found';

export function landingState(row: InvitationFacts | null, now: Date = new Date()): LandingState {
  if (!row) return 'not_found';
  if (row.status === 'accepted') return 'accepted';
  if (row.status !== 'pending') return 'closed';
  return new Date(row.expiresAt).getTime() > now.getTime() ? 'valid' : 'expired';
}

export type Viewer = { kind: 'anonymous' } | { kind: 'signed-in'; email: string };

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Qué botones salen.
 *
 *   signup-or-login   sin sesión y con la invitación viva: crear la cuenta (con
 *                     el correo ya puesto) o entrar.
 *   respond           con la cuenta correcta y la invitación viva: aceptar o rechazar.
 *   switch-account    con otra cuenta: cerrar sesión y entrar con la invitada.
 *                     NUNCA se ofrece aceptar con la cuenta equivocada.
 *   open-app          ya aceptada y es su cuenta: ir a Cortex.
 *   login-only        ya aceptada y sin sesión: entrar.
 *   none              nada que hacer; la página sólo explica.
 */
export type LandingAction =
  | 'signup-or-login'
  | 'respond'
  | 'switch-account'
  | 'open-app'
  | 'login-only'
  | 'none';

export function landingAction(
  state: LandingState,
  viewer: Viewer,
  invitedEmail: string | null,
): LandingAction {
  if (state === 'valid') {
    if (viewer.kind === 'anonymous') return 'signup-or-login';
    return invitedEmail && sameEmail(viewer.email, invitedEmail) ? 'respond' : 'switch-account';
  }
  if (state === 'accepted') {
    if (viewer.kind === 'anonymous') return 'login-only';
    return invitedEmail && sameEmail(viewer.email, invitedEmail) ? 'open-app' : 'none';
  }
  return 'none';
}

const INVITATION_PATH = /^\/accept-invitation\/([A-Za-z0-9_:-]{1,128})(?:[/?#].*)?$/;

/** El id de invitación que apunta un `?next=`, ya saneado. `null` si no apunta a una. */
export function invitationIdFromNext(next: string | null | undefined): string | null {
  const safe = safeNextPath(next);
  if (!safe) return null;
  return safe.match(INVITATION_PATH)?.[1] ?? null;
}

/** El enlace del correo, para copiarlo y mandarlo por WhatsApp. */
export function invitationPath(id: string): string {
  return `/accept-invitation/${id}`;
}

/** La inicial para el avatar cuando la empresa no tiene logo. */
export function companyInitial(name: string): string {
  return (name.trim().charAt(0) || 'C').toUpperCase();
}

/**
 * ¿Se acaba de crear la cuenta? Sólo entonces la página acepta sola
 * (`?auto=1`): venir de registrarse con el enlace de la invitación ES haber
 * dicho que sí. Con una cuenta antigua, un enlace con `auto=1` no puede aceptar
 * en nombre de nadie — aceptar es una decisión, y rechazar también.
 */
export function justCreated(createdAt: string | Date | null | undefined, now: Date = new Date()) {
  if (!createdAt) return false;
  const age = now.getTime() - new Date(createdAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 30 * 60_000;
}
