import { authenticateExtension } from '@/lib/browser-device/auth';
import { chromeDevice } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * El canal de la extensión hacia Cortex: una espera larga («long-poll») que
 * Vercel sí soporta (nada de WebSockets). La extensión pide, el servidor mira
 * la cola cada ~1 s hasta ~20 s y contesta en cuanto hay una orden o una
 * parada; si no hay nada contesta vacío y la extensión vuelve a pedir.
 *
 * Responde además las reglas por sitio del servidor: la extensión las usa solo
 * para BORRAR las suyas cuando la persona las revocó desde Ajustes — nunca
 * para agregar permisos que ella no dio en su propio navegador.
 */
const STEP_MS = 1_200;

export async function GET(request: Request) {
  const caller = await authenticateExtension(request);
  if (!caller) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  const { device, db } = caller;
  const url = new URL(request.url);
  const waitS = Math.min(22, Math.max(0, Number(url.searchParams.get('wait') ?? 20) || 0));
  const ack = new Set(
    (url.searchParams.get('ack') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => chromeDevice.isChromeSessionId(s)),
  );
  const version = url.searchParams.get('v') ?? undefined;
  await chromeDevice.touchDevice(db, device.id, version);

  const deadline = Date.now() + waitS * 1000;
  let commands: chromeDevice.Command[] = [];
  let stops: string[] = [];
  for (;;) {
    commands = await chromeDevice.takePendingCommands(db, device);
    stops = (await chromeDevice.stoppedSessionsFor(db, device)).filter((s) => !ack.has(s));
    if (commands.length > 0 || stops.length > 0 || Date.now() + STEP_MS >= deadline) break;
    if (request.signal.aborted) break;
    await new Promise((r) => setTimeout(r, STEP_MS));
  }
  const sites = (await chromeDevice.listSites(db, device.userId, device.id)).map((s) => ({
    site: s.site,
    decision: s.decision,
  }));
  return NextResponse.json(
    { commands, stops, sites, deviceName: device.name, serverTime: Date.now() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
