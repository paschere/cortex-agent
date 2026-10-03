import 'server-only';
import { UnauthorizedError } from '@cortex/core';
import { headers } from 'next/headers';
import { auth, pool } from '../auth';

/**
 * QUIÉN OPERA LA PLATAFORMA (y por eso revisa las solicitudes de acceso).
 *
 * No es «el fundador»: `/overview` es la consola de quien dirige SUS empresas,
 * y cualquier cliente con una empresa es fundador. Aprobar a un desconocido
 * para que entre a Cortex es una decisión de quien opera Cortex.
 *
 * Lo que ya existía en el repo para eso es el rol `admin` del plugin admin de
 * better-auth (`ba_user.role`): la primera cuenta de una instalación lo recibe
 * en el gancho de registro (lib/auth.ts). Se usa ese, y además
 * `PLATFORM_OPERATOR_EMAILS` (lista separada por comas) para sumar operadores
 * sin tocar la base. Se lee de `ba_user` en cada llamada: quitar el rol corta
 * el acceso en la petición siguiente.
 */

export function operatorEmailsFrom(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  return new Set(
    (env.PLATFORM_OPERATOR_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function isPlatformOperator(accountId: string): Promise<boolean> {
  const { rows } = await pool.query<{ role: string | null; email: string }>(
    'select role, email from public.ba_user where id = $1',
    [accountId],
  );
  const row = rows[0];
  if (!row) return false;
  if (
    (row.role ?? '')
      .split(',')
      .map((r) => r.trim())
      .includes('admin')
  )
    return true;
  return operatorEmailsFrom().has(row.email.trim().toLowerCase());
}

/** La cuenta en sesión, sólo si opera la plataforma. Lanza en cualquier otro caso. */
export async function requirePlatformOperator(): Promise<{ accountId: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  const accountId = session?.user?.id;
  if (!accountId) throw new UnauthorizedError();
  if (!(await isPlatformOperator(accountId))) throw new UnauthorizedError();
  return { accountId };
}
