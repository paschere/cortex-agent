import 'server-only';
import { decryptToken, logger } from '@cortex/core';
import type { PoolClient } from 'pg';

/**
 * REVOCAR LAS CONEXIONES ANTES DE BORRARLAS.
 *
 * Borrar el token cifrado de nuestra base no le quita a Cortex el permiso que
 * Google le dio: el «grant» sigue vivo en la cuenta de Google de la persona
 * hasta que alguien lo revoca. Por eso, antes de purgar una empresa o borrar un
 * usuario, se llama al endpoint de revocación de Google con el refresh token
 * (revocar el refresh token revoca el grant entero).
 *
 * Microsoft no ofrece un endpoint equivalente para que una aplicación revoque
 * sus propios tokens delegados: se borran y caducan solos (el de acceso en ~1 h,
 * el de refresco a los 90 días sin uso), y la persona puede quitar el permiso
 * en https://myapps.microsoft.com. Lo mismo HubSpot, GitHub y Linear desde sus
 * paneles. El informe dice cuántas se revocaron de verdad y cuántas sólo se
 * borraron, sin adornarlo.
 *
 * Mejor esfuerzo: un fallo de red no detiene el borrado (el dato tiene que
 * irse igual), pero se cuenta en el informe.
 */

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface RevokeReport {
  googleRevoked: number;
  googleFailed: number;
  deletedOnly: number;
}

export async function revokeGoogleToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    // 400 invalid_token = ya estaba revocado o caducado: el resultado buscado.
    return res.ok || res.status === 400;
  } catch (err) {
    logger.warn('legal: no se pudo revocar un token de Google', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function plain(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptToken(enc);
  } catch {
    return null;
  }
}

/**
 * Revoca las conexiones de `integrations` que cumplan el filtro. `where` es SQL
 * fijo escrito por quien llama (nunca entrada del usuario) sobre el alias `i`.
 */
export async function revokeIntegrations(
  client: PoolClient,
  where: string,
  params: unknown[],
): Promise<RevokeReport> {
  const report: RevokeReport = { googleRevoked: 0, googleFailed: 0, deletedOnly: 0 };
  const { rows } = await client.query<{
    provider: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
  }>(
    `select i.provider::text as provider, i.access_token_enc, i.refresh_token_enc
       from public.integrations i where ${where}`,
    params,
  );
  for (const row of rows) {
    if (row.provider !== 'google') {
      report.deletedOnly++;
      continue;
    }
    const token = plain(row.refresh_token_enc) ?? plain(row.access_token_enc);
    if (token && (await revokeGoogleToken(token))) report.googleRevoked++;
    else report.googleFailed++;
  }
  return report;
}

/** Revoca el token de inicio de sesión con Google de una cuenta (ba_account). */
export async function revokeLoginGrant(
  client: PoolClient,
  accountId: string,
): Promise<RevokeReport> {
  const report: RevokeReport = { googleRevoked: 0, googleFailed: 0, deletedOnly: 0 };
  const { rows } = await client.query<{ refreshToken: string | null; accessToken: string | null }>(
    `select "refreshToken", "accessToken" from public.ba_account
      where "userId" = $1 and "providerId" = 'google'`,
    [accountId],
  );
  for (const row of rows) {
    const token = row.refreshToken ?? row.accessToken;
    if (!token) continue;
    if (await revokeGoogleToken(token)) report.googleRevoked++;
    else report.googleFailed++;
  }
  return report;
}

export function mergeRevokeReports(...reports: RevokeReport[]): RevokeReport {
  return reports.reduce(
    (acc, r) => ({
      googleRevoked: acc.googleRevoked + r.googleRevoked,
      googleFailed: acc.googleFailed + r.googleFailed,
      deletedOnly: acc.deletedOnly + r.deletedOnly,
    }),
    { googleRevoked: 0, googleFailed: 0, deletedOnly: 0 },
  );
}
