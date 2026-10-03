import 'server-only';
import { headers } from 'next/headers';
import { auth, pool } from '../auth';
import { requireSession } from '../session';
import { operatorEmails } from './shape';

/**
 * LA PUERTA DE LA BANDEJA DE SOPORTE: quién opera la plataforma.
 *
 * No es el admin de una empresa (eso es `org_admin` en SU espacio) ni el
 * fundador (dueño de sus empresas): es quien atiende a TODAS las empresas. Dos
 * maneras de serlo, las dos fuera del alcance de una empresa cliente:
 *
 *   · `ba_user.role = 'admin'` — el admin de la plataforma del plugin admin de
 *     better-auth (lib/auth.ts: la primera cuenta de una instalación);
 *   · el correo está en `SUPPORT_OPERATORS` (lista separada por comas), para
 *     sumar a alguien del equipo sin tocar la base.
 *
 * Se lee en cada petición, igual que `requireFounderContext`: perder el rol
 * corta el acceso en la petición siguiente.
 */

export async function isSupportOperator(email: string): Promise<boolean> {
  if (operatorEmails(process.env.SUPPORT_OPERATORS).has(email.trim().toLowerCase())) return true;
  const session = await auth.api.getSession({ headers: await headers() });
  const accountId = session?.user?.id;
  if (!accountId) return false;
  const { rows } = await pool.query<{ role: string | null }>(
    'select role from public.ba_user where id = $1',
    [accountId],
  );
  return rows[0]?.role === 'admin';
}

export class SupportOperatorError extends Error {
  constructor() {
    super('Esta bandeja es sólo para quien opera Cortex.');
    this.name = 'SupportOperatorError';
  }
}

/** La sesión, sólo si es de alguien que opera la plataforma. Lanza si no. */
export async function requireSupportOperator() {
  const user = await requireSession();
  if (!(await isSupportOperator(user.email))) throw new SupportOperatorError();
  return user;
}
