import 'server-only';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type AppAccess,
  type ExternalSession,
  type ExternalUserRow,
  type PublishedApp,
  SESSION_DAYS,
  externalAppAccess,
  findPublishedApp,
  resolveExternalSession,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * LA PUERTA DE UN USUARIO EXTERNO (/a/<app>), DEL LADO WEB.
 *
 * Quien abre una app sin ser miembro de Cortex no tiene better-auth: trae una
 * cookie propia, `cortex_app_<appId>`, con el token de su sesión. El servidor
 * sólo guarda el hash (packages/agent-tools/src/apps/external.ts) y vuelve a
 * mirar al usuario en CADA petición, así que desactivarlo lo saca en la
 * siguiente.
 *
 * `requireAppUser(appId)` es el equivalente de `openPublicView` en las vistas:
 * entrega {app, user, role, db} con el cliente acotado a la empresa de la app,
 * que es la ÚNICA empresa a la que esta sesión da acceso. La única lectura sin
 * alcance es encontrar la app por su id (lib/tenancy-guard.test.ts lo lista).
 */

export function appCookieName(appId: string): string {
  return `cortex_app_${appId}`;
}

export interface ExternalApp {
  app: PublishedApp;
  db: SupabaseClient;
}

/** La app publicada y el handle de SU empresa, o null (no existe, borrador, archivada: todo igual). */
export async function openExternalApp(appId: string): Promise<ExternalApp | null> {
  const app = await findPublishedApp(getSupabaseServiceClient(), appId);
  if (!app) return null;
  return { app, db: getOrgScopedClient(app.organization_id) };
}

export interface AppUserContext extends ExternalApp {
  user: ExternalUserRow;
  role: AppAccess['role'];
  access: AppAccess;
  session: ExternalSession;
}

export function cookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    // El nombre de la cookie ya es de esta app (lleva su id).
    path: '/',
    expires: expiresAt,
  };
}

/** Quién es, con la cookie de esta app; null si no hay sesión válida. */
export async function getAppUser(appId: string): Promise<AppUserContext | null> {
  const opened = await openExternalApp(appId);
  if (!opened) return null;
  const jar = await cookies();
  const token = jar.get(appCookieName(opened.app.id))?.value;
  const session = await resolveExternalSession(opened.db, opened.app, token);
  if (!session) return null;
  const access = await externalAppAccess(opened.db, opened.app, session.user);
  if (!access) return null;
  if (session.renewed && token) {
    // Desliza la cookie junto con la sesión. En una página de servidor no se
    // pueden escribir cookies: ahí el intento se ignora y la renueva la
    // siguiente acción o ruta de datos.
    try {
      jar.set(appCookieName(opened.app.id), token, cookieOptions(new Date(session.expiresAt)));
    } catch {
      // Render de servidor: sin cookies de escritura.
    }
  }
  return { ...opened, user: session.user, role: access.role, access, session };
}

/** Para páginas: sin sesión, a la pantalla de entrada de la app. */
export async function requireAppUser(appId: string): Promise<AppUserContext> {
  const ctx = await getAppUser(appId);
  if (!ctx) redirect(`/a/${encodeURIComponent(appId)}`);
  return ctx;
}

/** Días que dura la cookie, para quien la escribe al entrar. */
export const SESSION_COOKIE_DAYS = SESSION_DAYS;
