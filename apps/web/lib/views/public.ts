import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { type PublicViewRow, findViewByToken } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA PUERTA DE AFUERA DE UNA VISTA (/v/<token>).
 *
 * Quien abre el enlace no tiene sesión: viene de WhatsApp, de un correo, de un
 * cliente. El token ES la credencial, igual que el enlace de un informe, y por
 * eso este es el único archivo de vistas que toca el cliente de servicio sin
 * alcance (lib/tenancy-guard.test.ts lo tiene en la lista con la razón). Lo
 * toca para UNA cosa —encontrar la fila por token— y todo lo que sigue se lee
 * con un handle del espacio que esa fila trae.
 *
 * LA CONTRASEÑA. Se comprueba una vez (`unlockView`, que gasta el intento en la
 * base antes de comparar) y queda recordada en una cookie firmada de 12 horas,
 * atada a la vista y a una huella del hash vigente: cambiar la contraseña
 * invalida todas las cookies viejas sin tener que llevar la cuenta de ellas.
 */

export const UNLOCK_HOURS = 12;

export interface OpenedView {
  view: PublicViewRow;
  db: SupabaseClient;
  organizationName: string;
}

export async function openPublicView(token: string): Promise<OpenedView | null> {
  const service = getSupabaseServiceClient();
  const view = await findViewByToken(service, token);
  if (!view) return null;
  // El nombre es un adorno de la cabecera: si su lectura falla, la vista se
  // abre igual con «Cortex». La decisión queda escrita aquí, no tragada.
  const { data, error } = await service
    .from('ba_organization')
    .select('name')
    .eq('id', view.organization_id)
    .maybeSingle();
  const name = error ? null : (data as { name?: string } | null)?.name;
  return {
    view,
    db: getOrgScopedClient(view.organization_id),
    organizationName: name ?? 'Cortex',
  };
}

function secret(): string {
  const key = (process.env.BETTER_AUTH_SECRET ?? '').trim();
  if (!key && process.env.NODE_ENV === 'production') throw new Error('BETTER_AUTH_SECRET missing');
  return key || 'cortex-dev-view-unlock';
}

export function unlockCookieName(viewId: string): string {
  return `cortex_view_${viewId.replaceAll('-', '').slice(0, 16)}`;
}

/** Huella del hash vigente. Sólo se usa para firmar; el hash no sale de aquí. */
async function passwordFingerprint(db: SupabaseClient, viewId: string): Promise<string | null> {
  const { data, error } = await db
    .from('custom_views')
    .select('password_hash')
    .eq('id', viewId)
    .maybeSingle();
  // Sin poder leer el hash vigente, ninguna cookie vale: la puerta queda cerrada.
  if (error) return null;
  const hash = (data as { password_hash?: string | null } | null)?.password_hash;
  return hash ? createHash('sha256').update(hash).digest('base64url').slice(0, 22) : null;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export async function mintUnlockCookie(
  db: SupabaseClient,
  viewId: string,
): Promise<{ name: string; value: string; maxAge: number } | null> {
  const fp = await passwordFingerprint(db, viewId);
  if (!fp) return null;
  const exp = Date.now() + UNLOCK_HOURS * 3_600_000;
  const payload = `${viewId}.${exp}.${fp}`;
  return {
    name: unlockCookieName(viewId),
    value: `${exp}.${sign(payload)}`,
    maxAge: UNLOCK_HOURS * 3600,
  };
}

export async function isUnlocked(
  db: SupabaseClient,
  viewId: string,
  cookieValue: string | undefined,
): Promise<boolean> {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf('.');
  const exp = Number(cookieValue.slice(0, dot));
  const given = cookieValue.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now() || !given) return false;
  const fp = await passwordFingerprint(db, viewId);
  if (!fp) return false;
  const expected = Buffer.from(sign(`${viewId}.${exp}.${fp}`));
  const got = Buffer.from(given);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
