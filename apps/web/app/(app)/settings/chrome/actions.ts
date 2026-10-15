'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { chromeDevice } from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * Cada export de este archivo es un endpoint que cualquiera con sesión puede
 * llamar: el usuario sale SIEMPRE de la sesión (nunca del cuerpo) y cada
 * consulta filtra por él. Una persona no ve ni revoca el Chrome de otra.
 */

export interface DeviceView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  extVersion: string | null;
  expiresAt: string;
  revoked: boolean;
}
export interface SiteView {
  id: string;
  deviceId: string;
  site: string;
  decision: 'always' | 'never';
}
export interface ChromeState {
  devices: DeviceView[];
  sites: SiteView[];
}

export async function readChromeState(): Promise<ChromeState> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [devices, sites] = await Promise.all([
    chromeDevice.listDevices(db, user.id),
    chromeDevice.listSites(db, user.id),
  ]);
  return {
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      online: d.online,
      lastSeenAt: d.lastSeenAt,
      extVersion: d.extVersion,
      expiresAt: d.expiresAt,
      revoked: Boolean(d.revokedAt),
    })),
    sites: sites.map((s) => ({
      id: s.id,
      deviceId: s.deviceId,
      site: s.site,
      decision: s.decision,
    })),
  };
}

export async function createPairingCodeAction(): Promise<
  { ok: true; code: string; expiresAt: string } | { ok: false; note: string }
> {
  const user = await requireSession();
  try {
    const made = await chromeDevice.createPairingCode(
      getOrgScopedClient(user.organization.id),
      user.id,
    );
    return { ok: true, ...made };
  } catch (err) {
    const text = err instanceof Error ? err.message : '';
    return { ok: false, note: text && text.length < 300 ? text : 'No se pudo crear el código.' };
  }
}

export async function revokeDeviceAction(deviceId: string): Promise<{ ok: boolean }> {
  const user = await requireSession();
  if (typeof deviceId !== 'string' || deviceId.length > 64) return { ok: false };
  const ok = await chromeDevice.revokeDevice(
    getOrgScopedClient(user.organization.id),
    user.id,
    deviceId,
  );
  revalidatePath('/settings/chrome');
  return { ok };
}

export async function removeSiteAction(ruleId: string): Promise<{ ok: boolean }> {
  const user = await requireSession();
  if (typeof ruleId !== 'string' || ruleId.length > 64) return { ok: false };
  const ok = await chromeDevice.deleteSiteRule(
    getOrgScopedClient(user.organization.id),
    user.id,
    ruleId,
  );
  revalidatePath('/settings/chrome');
  return { ok };
}
