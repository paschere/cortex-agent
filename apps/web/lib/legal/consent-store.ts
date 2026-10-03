import 'server-only';
import { createHash } from 'node:crypto';
import { auth, pool } from '@/lib/auth';
import { headers } from 'next/headers';
import { cache } from 'react';
import {
  type ConsentRecord,
  LEGAL_DOCUMENT_VERSIONS,
  type LegalDocument,
  REQUIRED_CONSENTS,
  missingConsents,
} from './versions';

/**
 * LA PRUEBA DE LA AUTORIZACIÓN: leer y escribir `legal_consents`.
 *
 * Es de la PERSONA (ba_user), no del directorio de una empresa, así que va por
 * el pool de pg de lib/auth.ts — el mismo que resuelve la sesión — y siempre
 * con el id de la cuenta de la sesión, nunca con uno que llegue del navegador.
 * No hay lista de «todas las autorizaciones»: cada consulta lleva un user_id.
 */

/** La cuenta (ba_user) de la sesión actual. Memoizada por petición. */
export const currentAccount = cache(
  async (): Promise<{ id: string; email: string; name: string | null } | null> => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
    };
  },
);

/**
 * Huella de la IP: sha256(sal || ip). La IP en claro es un dato personal que no
 * hace falta guardar para probar nada; la huella basta para correlacionar con
 * un registro del proveedor si alguna vez se discute. La sal es
 * LEGAL_IP_SALT, o JOBS_SECRET si no hay — nunca vacía en producción.
 */
export function hashIp(ip: string | null | undefined, salt?: string): string | null {
  const clean = (ip ?? '').split(',')[0]?.trim();
  if (!clean) return null;
  const key = salt ?? (process.env.LEGAL_IP_SALT || process.env.JOBS_SECRET || 'cortex-legal');
  return createHash('sha256').update(`${key}|${clean}`).digest('hex');
}

/** IP y navegador de la petición actual. */
export async function requestFingerprint(): Promise<{
  ipHash: string | null;
  userAgent: string | null;
}> {
  const h = await headers();
  const ip = h.get('x-forwarded-for') ?? h.get('x-real-ip');
  const ua = h.get('user-agent');
  return { ipHash: hashIp(ip), userAgent: ua ? ua.slice(0, 400) : null };
}

export async function listConsents(accountId: string): Promise<ConsentRecord[]> {
  const { rows } = await pool.query<{
    document: string;
    version: string;
    revoked_at: string | null;
  }>(
    `select document, version, revoked_at
       from public.legal_consents
      where user_id = $1
      order by accepted_at desc`,
    [accountId],
  );
  return rows;
}

export interface ConsentDetail {
  document: string;
  version: string;
  accepted_at: string;
  source: string;
  revoked_at: string | null;
}

export async function listConsentDetails(accountId: string): Promise<ConsentDetail[]> {
  const { rows } = await pool.query<ConsentDetail>(
    `select document, version, accepted_at, source, revoked_at
       from public.legal_consents
      where user_id = $1
      order by accepted_at desc
      limit 50`,
    [accountId],
  );
  return rows;
}

/**
 * Guarda la aceptación de las versiones vigentes. Idempotente: aceptar dos
 * veces la misma versión no crea otra fila (la restricción única lo impide) y
 * una revocada vuelve a quedar vigente con la hora nueva.
 */
export async function recordConsents(input: {
  accountId: string;
  organizationId: string | null;
  documents: readonly LegalDocument[];
  source: 'registro' | 'app';
  ipHash: string | null;
  userAgent: string | null;
}): Promise<void> {
  for (const document of input.documents) {
    await pool.query(
      `insert into public.legal_consents
         (user_id, organization_id, document, version, ip_hash, user_agent, source)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, document, version) do update
         set revoked_at = null,
             accepted_at = case when public.legal_consents.revoked_at is null
                                then public.legal_consents.accepted_at else now() end`,
      [
        input.accountId,
        input.organizationId,
        document,
        LEGAL_DOCUMENT_VERSIONS[document],
        input.ipHash,
        input.userAgent,
        input.source,
      ],
    );
  }
}

/**
 * Revocar la autorización (Ley 1581 art. 8 e). Marca las filas vigentes; la
 * aplicación vuelve a pedirla en la siguiente página, y sin ella no se puede
 * usar — que es lo que la revocación significa para un servicio que no
 * funciona sin tratar datos. Para que dejemos de tenerlos, está «eliminar mi
 * usuario».
 */
export async function revokeConsents(accountId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `update public.legal_consents set revoked_at = now()
      where user_id = $1 and revoked_at is null and document = any($2::text[])`,
    [accountId, REQUIRED_CONSENTS],
  );
  return rowCount ?? 0;
}

export async function pendingConsents(accountId: string): Promise<{
  missing: LegalDocument[];
  hadPrevious: boolean;
}> {
  const accepted = await listConsents(accountId);
  return {
    missing: missingConsents(accepted),
    hadPrevious: accepted.length > 0,
  };
}
