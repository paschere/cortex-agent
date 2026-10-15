import 'server-only';
import { chromeDevice } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrgScopedClient, getSupabaseServiceClient } from '../supabase/service';

/**
 * Las rutas de la extensión (/api/extension/*) no tienen cookie de sesión: se
 * autentican con el token de dispositivo (Authorization: Bearer cbd_…), cuyo
 * hash es lo único que existe en la base. Este archivo es el ÚNICO lugar de
 * «Cortex en tu Chrome» que toca el cliente de servicio, y solo para las dos
 * cosas que ocurren antes de saber la organización: canjear el código de
 * emparejamiento y resolver el token. En cuanto se sabe quién es, todo lo
 * demás va con el cliente de su organización y filtrando por su usuario.
 */

export interface ExtensionCaller {
  device: chromeDevice.AuthedDevice;
  db: SupabaseClient;
}

export async function authenticateExtension(request: Request): Promise<ExtensionCaller | null> {
  const device = await chromeDevice.authenticateDeviceToken(
    getSupabaseServiceClient(),
    request.headers.get('authorization'),
  );
  if (!device) return null;
  return { device, db: getOrgScopedClient(device.organizationId) };
}

export function redeemCode(
  code: string,
  info: { deviceName: string; extVersion?: string; userAgent?: string },
) {
  return chromeDevice.redeemPairingCode(getSupabaseServiceClient(), code, info);
}

/** Límite de intentos sin sesión: por IP y global, en memoria de la instancia. */
const attempts = new Map<string, number[]>();
export function pairingRateLimited(ip: string): boolean {
  const now = Date.now();
  const hit = (key: string, max: number): boolean => {
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    attempts.set(key, recent);
    return recent.length > max;
  };
  if (attempts.size > 5000) attempts.clear();
  return hit(`ip:${ip}`, 8) || hit('all', 60);
}
