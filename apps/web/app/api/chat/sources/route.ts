import { canManageAccounting } from '@/lib/accounting/card';
import { requireSession } from '@/lib/session';
import { buildConnectedSources } from '@/lib/sources/overview';
import { readSourcesSnapshot } from '@/lib/sources/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LAS FUENTES CONECTADAS, PARA LAS PASTILLAS DEL COMPOSITOR.
 *
 * Es la misma lectura que arma /integrations (`readSourcesSnapshot` +
 * `buildConnectedSources`), reducida a lo que cabe en una pastilla: un nombre y
 * si está bien. Ningún secreto, ninguna cuenta, ningún texto de error. El
 * navegador la pide sin bloquear nada y, si falla o tarda, no dibuja la fila.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const snapshot = await readSourcesSnapshot(db, {
      userId: user.id,
      canManage: canManageAccounting(user.organization.role),
      hubspotWorkspace: !!process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    });
    const sources = buildConnectedSources(snapshot)
      .filter((s) => s.tone !== 'paused')
      .map((s) => ({ id: s.key, label: s.name, tone: s.tone }));
    return NextResponse.json({ sources });
  } catch (error) {
    console.error('[chat/sources] failed:', error);
    return NextResponse.json({ sources: [] });
  }
}
