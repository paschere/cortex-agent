import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { type PublicBoardRow, boardPasswordHash, findBoardByToken } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA PUERTA DE AFUERA DEL INFORME PARA SOCIOS (/informe/<token>, 0191).
 *
 * Quien abre el enlace es un socio o un miembro de junta sin cuenta de Cortex:
 * el token ES la credencial (24 bytes al azar), la misma postura que una vista
 * compartida (/v/<token>). Por eso este es el único archivo del informe que
 * toca el cliente de servicio sin alcance (lib/tenancy-guard.test.ts lo tiene
 * en la lista con la razón), para DOS lecturas: la fila por token y el nombre
 * de su empresa. Lo demás —el PDF, la marca, el intento de contraseña— va con
 * el handle del espacio de esa fila.
 *
 * LA CONTRASEÑA se comprueba una vez (gastando el intento en la base antes de
 * comparar) y queda recordada 12 horas en una cookie firmada, atada al informe
 * y a una huella del hash vigente: cambiar la contraseña invalida las viejas.
 */

export const UNLOCK_HOURS = 12;

export interface OpenedBoard {
  report: PublicBoardRow;
  db: SupabaseClient;
  organizationName: string;
}

export async function openPublicBoard(token: string): Promise<OpenedBoard | null> {
  const service = getSupabaseServiceClient();
  const report = await findBoardByToken(service, token);
  if (!report) return null;
  const { data, error } = await service
    .from('ba_organization')
    .select('name')
    .eq('id', report.organizationId)
    .maybeSingle();
  const name = error ? null : (data as { name?: string } | null)?.name;
  return {
    report,
    db: getOrgScopedClient(report.organizationId),
    organizationName: name ?? 'Cortex',
  };
}

function secret(): string {
  const key = (process.env.BETTER_AUTH_SECRET ?? '').trim();
  if (!key && process.env.NODE_ENV === 'production') throw new Error('BETTER_AUTH_SECRET missing');
  return key || 'cortex-dev-board-unlock';
}

export function boardUnlockCookieName(reportId: string): string {
  return `cortex_board_${reportId.replaceAll('-', '').slice(0, 16)}`;
}

async function fingerprint(db: SupabaseClient, reportId: string): Promise<string | null> {
  const hash = await boardPasswordHash(db, reportId);
  return hash ? createHash('sha256').update(hash).digest('base64url').slice(0, 22) : null;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(`board.${payload}`).digest('base64url');
}

export async function mintBoardUnlockCookie(
  db: SupabaseClient,
  reportId: string,
): Promise<{ name: string; value: string; maxAge: number } | null> {
  const fp = await fingerprint(db, reportId);
  if (!fp) return null;
  const exp = Date.now() + UNLOCK_HOURS * 3_600_000;
  return {
    name: boardUnlockCookieName(reportId),
    value: `${exp}.${sign(`${reportId}.${exp}.${fp}`)}`,
    maxAge: UNLOCK_HOURS * 3600,
  };
}

export async function isBoardUnlocked(
  db: SupabaseClient,
  reportId: string,
  cookieValue: string | undefined,
): Promise<boolean> {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf('.');
  const exp = Number(cookieValue.slice(0, dot));
  const given = cookieValue.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now() || !given) return false;
  const fp = await fingerprint(db, reportId);
  if (!fp) return false;
  const expected = Buffer.from(sign(`${reportId}.${exp}.${fp}`));
  const got = Buffer.from(given);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
