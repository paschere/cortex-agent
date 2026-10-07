import 'server-only';
import { openExternalApp } from '@/lib/apps/external-session';
import {
  type KioskDevice,
  type KioskSettings,
  type PublishedApp,
  getKioskSettings,
  resolveDevice,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * EL DISPOSITIVO DE KIOSCO, DEL LADO WEB (0211).
 *
 * Un celular «en modo kiosco» guarda un token de DISPOSITIVO en la cookie
 * `cortex_appdev_<appId>` (httpOnly, un año; aquí el servidor sólo conoce su
 * hash). No es una sesión de persona: sólo prueba que este celular fue
 * autorizado para esta app, y por eso es lo único que deja usar un PIN. La
 * sesión de la persona sigue siendo `cortex_app_<appId>` (external-session.ts).
 */

export function deviceCookieName(appId: string): string {
  return `cortex_appdev_${appId}`;
}

export function deviceCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 365 * 86_400,
  };
}

export interface KioskDeviceContext {
  app: PublishedApp;
  db: SupabaseClient;
  device: KioskDevice;
  settings: KioskSettings;
  token: string;
}

/** El dispositivo de ESTE navegador para esta app, o null (sin cookie, revocado o kiosco apagado). */
export async function getKioskDevice(appId: string): Promise<KioskDeviceContext | null> {
  const opened = await openExternalApp(appId);
  if (!opened) return null;
  const token = (await cookies()).get(deviceCookieName(opened.app.id))?.value;
  if (!token) return null;
  const device = await resolveDevice(opened.db, opened.app, token);
  if (!device) return null;
  const settings = await getKioskSettings(opened.db, opened.app.id);
  return { ...opened, device, settings, token };
}
