import { openApp, previewAttributesOf } from '@/lib/apps/access';
import {
  type LiveTable,
  changedTables,
  parseLiveTables,
  readFingerprint,
  resolveLiveTables,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * EL CANAL EN VIVO DE UNA APP (apps con código).
 *
 *   GET /api/apps/<app>/live?tables=vuelos,guias   →   text/event-stream
 *
 *   event: open     data: {tables, denied}     al conectar (denied = las que el rol no lee)
 *   event: change   data: {table, at}          una tabla cambió (cuenta o última modificación)
 *   event: closed   data: {}                   a ~280 s o si la sesión/rol ya no vale; el cliente reconecta
 *   : keep-alive                                comentario en cada vuelta sin cambios
 *
 * Se autentica igual que la puerta del SDK (`openApp`: sesión de Cortex o cookie de usuario
 * externo de la app, y «Ver como…» con `?como=`), y solo deja mirar las tablas que ese rol LEE
 * (`rowAccessFor`, la misma comprobación de `tables.query`). Cada ~2 s se pide una huella barata
 * por tabla (lib de agent-tools `readFingerprint`, compartida entre conexiones) y solo se avisa
 * cuando cambia. Cada 10 s se vuelve a abrir la app: si la sesión cayó o el rol cambió, se corta.
 * Mismo patrón (probado) que /api/notifications/stream.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const TICK_MS = 2_000;
const REVALIDATE_MS = 10_000;
const MAX_LIFETIME_MS = 280_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const slugs = parseLiveTables(sp.get('tables'));
  if (slugs.length === 0)
    return NextResponse.json(
      { ok: false, error: 'Falta ?tables=' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  const options = { as: sp.get('como'), attributes: previewAttributesOf(sp.getAll('atr')) };
  const opened = await openApp(id, options);
  if (!opened)
    return NextResponse.json(
      { ok: false, error: 'No existe.' },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          /* el runtime ya cerró la petición */
        }
      };
      const send = (event: string, data: unknown) => {
        if (!open) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      req.signal.addEventListener('abort', close);
      try {
        let current = opened;
        let { tables, denied } = await resolveLiveTables(current.db, current.access, slugs);
        send('open', { tables: tables.map((t) => t.slug), denied });
        let previous = new Map<string, string>();
        let lastCheck = Date.now();
        while (open && Date.now() - startedAt < MAX_LIFETIME_MS) {
          if (Date.now() - lastCheck >= REVALIDATE_MS) {
            lastCheck = Date.now();
            const fresh = await openApp(id, options).catch(() => undefined);
            // `undefined` = no se pudo comprobar ahora (se reintenta a los 10 s); null = ya no entra.
            if (fresh === null) break;
            if (fresh) {
              current = fresh;
              const again = await resolveLiveTables(current.db, current.access, slugs);
              tables = again.tables;
              denied = again.denied;
            }
          }
          const next = await fingerprints(current.db, tables);
          if (next) {
            const changed = changedTables(previous, next);
            // Una tabla que dejó de poder leerse sale de la base; una que vuelve, empieza de nuevo.
            previous = next;
            const at = new Date().toISOString();
            for (const table of changed) send('change', { table, at });
            if (changed.length === 0) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          }
          await sleep(TICK_MS);
        }
        send('closed', {});
      } catch (err) {
        logger.error({ err, app: id }, 'live: channel failed');
        send('fault', { message: 'La actualización en vivo se interrumpió.' });
      } finally {
        close();
      }
    },
  });
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** La huella de cada tabla; null si la consulta falló (se salta esta vuelta, no se corta el canal). */
async function fingerprints(
  db: Parameters<typeof readFingerprint>[0],
  tables: LiveTable[],
): Promise<Map<string, string> | null> {
  try {
    const entries = await Promise.all(
      tables.map(async (t) => [t.slug, await readFingerprint(db, t)] as const),
    );
    return new Map(entries);
  } catch (err) {
    logger.warn({ err }, 'live: fingerprint failed');
    return null;
  }
}
