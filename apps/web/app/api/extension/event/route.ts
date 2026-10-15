import { authenticateExtension } from '@/lib/browser-device/auth';
import { chromeDevice } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * Lo que pasa en el navegador de la persona y Cortex debe saber:
 *   stopped       pulsó «Detener» (barra de la pestaña o panel lateral)
 *   person_done   terminó lo que Cortex le pidió a mano (ayuda o un secreto)
 *   tab_closed    cerró la pestaña de trabajo
 *   site_rule     decidió «siempre» o «nunca» en un sitio
 *   site_removed  quitó su regla de un sitio desde la extensión
 * Todo se limita a las sesiones y reglas de ESTE dispositivo.
 */
export async function POST(request: Request) {
  const caller = await authenticateExtension(request);
  if (!caller) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  const { device, db } = caller;
  const body = (await request.json().catch(() => null)) as {
    kind?: unknown;
    sessionId?: unknown;
    site?: unknown;
    decision?: unknown;
  } | null;
  if (!body || typeof body.kind !== 'string') {
    return NextResponse.json({ error: 'Evento inválido.' }, { status: 400 });
  }

  if (body.kind === 'site_rule' || body.kind === 'site_removed') {
    if (typeof body.site !== 'string' || !chromeDevice.validSite(body.site.toLowerCase())) {
      return NextResponse.json({ error: 'Sitio inválido.' }, { status: 400 });
    }
    if (body.kind === 'site_rule') {
      if (body.decision !== 'always' && body.decision !== 'never') {
        return NextResponse.json({ error: 'Decisión inválida.' }, { status: 400 });
      }
      await chromeDevice.saveSiteRule(db, device, body.site, body.decision);
    } else {
      const mine = (await chromeDevice.listSites(db, device.userId, device.id)).find(
        (s) => s.site === (body.site as string).toLowerCase(),
      );
      if (mine) await chromeDevice.deleteSiteRule(db, device.userId, mine.id);
    }
    return NextResponse.json({ ok: true });
  }

  if (typeof body.sessionId !== 'string' || !chromeDevice.isChromeSessionId(body.sessionId)) {
    return NextResponse.json({ error: 'Sesión inválida.' }, { status: 400 });
  }
  const session = await chromeDevice.getDeviceSession(db, device, body.sessionId);
  if (!session) return NextResponse.json({ error: 'Sesión desconocida.' }, { status: 404 });

  if (body.kind === 'stopped') {
    await chromeDevice.endChromeSession(db, device.userId, session.id, {
      status: 'stopped',
      stoppedBy: 'person_extension',
    });
  } else if (body.kind === 'tab_closed') {
    await chromeDevice.endChromeSession(db, device.userId, session.id, { status: 'closed' });
  } else if (body.kind === 'person_done') {
    await chromeDevice.setAwaiting(db, device.userId, session.id, null);
  } else {
    return NextResponse.json({ error: 'Evento desconocido.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
