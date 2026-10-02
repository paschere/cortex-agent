import { canManageAccounting } from '@/lib/accounting/card';
import {
  QUICKBOOKS_STATE_COOKIE,
  quickbooksErrorCode,
  quickbooksRedirectUri,
  quickbooksStateKey,
  readQuickbooksState,
} from '@/lib/accounting/quickbooks-oauth';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  QuickBooksError,
  completeQuickbooksConnection,
  saveAccountingConnection,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * La vuelta de Intuit al conectar QuickBooks Online.
 *
 * Antes de cambiar el código por tokens: la sesión es de un administrador, el
 * `state` está firmado, vigente, con el nonce de la cookie de este navegador y
 * es de esta misma persona en este mismo espacio. Después: se lee la empresa
 * (eso prueba que el permiso sirve), la llave se guarda cifrada con
 * `saveAccountingConnection` —igual que Siigo y Alegra— y empieza la primera
 * carga.
 *
 * LOS TOKENS NUNCA SALEN DE AQUÍ EN CLARO: no se registran, no se devuelven y
 * no van en la redirección. Al navegador vuelve sólo «QuickBooks» o un código
 * de error.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/integrations?${query}#programas-contables`, req.url));

  const cookieStore = await cookies();
  const nonce = cookieStore.get(QUICKBOOKS_STATE_COOKIE)?.value;
  cookieStore.delete({ name: QUICKBOOKS_STATE_COOKIE, path: '/api/integrations/quickbooks' });

  const state = readQuickbooksState(url.searchParams.get('state'), quickbooksStateKey(), {
    userId: user.id,
    organizationId: user.organization.id,
    nonce,
  });
  if (!state) return back('error=quickbooks_state');
  if (url.searchParams.get('error')) return back('error=quickbooks_denied');
  if (!canManageAccounting(user.organization.role)) return back('error=quickbooks_admin');

  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  if (!code || !realmId) return back('error=quickbooks_failed');

  try {
    const { credentials, token } = await completeQuickbooksConnection({
      code,
      realmId,
      redirectUri: quickbooksRedirectUri(),
    });
    const db = getOrgScopedClient(user.organization.id);
    const conn = await saveAccountingConnection(db, {
      provider: 'quickbooks',
      credentials,
      token,
      entities: state.entities,
      intervalMinutes: state.intervalMinutes,
      notify: state.notify,
      userId: user.id,
    });
    await enqueueJob('accounting/run', {
      organizationId: user.organization.id,
      connectionId: conn.id,
    });
  } catch (err) {
    // El tipo de falla, nunca el cuerpo: la respuesta de Intuit puede repetir
    // partes de la petición.
    logger.warn(
      {
        organizationId: user.organization.id,
        kind: err instanceof QuickBooksError ? err.kind : 'unexpected',
        status: err instanceof QuickBooksError ? err.status : null,
      },
      'quickbooks connect failed',
    );
    return back(`error=${quickbooksErrorCode(err instanceof QuickBooksError ? err.kind : null)}`);
  }
  return back('connected=QuickBooks');
}
