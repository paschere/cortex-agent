import { canManageAccounting } from '@/lib/accounting/card';
import {
  QUICKBOOKS_STATE_COOKIE,
  cleanQuickbooksSettings,
  mintQuickbooksState,
  newNonce,
  quickbooksRedirectUri,
  quickbooksStateKey,
} from '@/lib/accounting/quickbooks-oauth';
import { requireSession } from '@/lib/session';
import { quickbooksAppConfig, quickbooksAuthorizeUrl } from '@cortex/agent-tools';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Empieza la conexión con QuickBooks Online (programas contables, 0165).
 *
 * La tarjeta de Integraciones manda aquí lo que el administrador eligió (qué
 * traer, cada cuánto, si avisa). Esto lo firma en el `state` junto con quién y
 * en qué espacio (lib/accounting/quickbooks-oauth.ts), deja el nonce en una
 * cookie httpOnly y manda a Intuit, que pide sólo el alcance de contabilidad.
 *
 * Una instalación sin la app de Intuit registrada no se cae: vuelve a
 * Integraciones con el motivo en español.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const back = (error: string) =>
    NextResponse.redirect(new URL(`/integrations?error=${error}#programas-contables`, req.url));
  if (!canManageAccounting(user.organization.role)) return back('quickbooks_admin');

  const config = quickbooksAppConfig();
  if (!config) return back('quickbooks_not_configured');

  const url = new URL(req.url);
  const settings = cleanQuickbooksSettings({
    entities: url.searchParams.get('entities'),
    interval: url.searchParams.get('interval'),
    notify: url.searchParams.get('notify'),
  });
  if (!settings) return back('quickbooks_settings');

  const nonce = newNonce();
  const state = mintQuickbooksState(
    { ...settings, userId: user.id, organizationId: user.organization.id, nonce },
    quickbooksStateKey(),
  );
  const cookieStore = await cookies();
  cookieStore.set(QUICKBOOKS_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/integrations/quickbooks',
    maxAge: 600,
  });
  return NextResponse.redirect(
    quickbooksAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: quickbooksRedirectUri(),
      state,
    }),
  );
}
