import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';

/**
 * LAS FOTOS CHICAS DE CADA PASO («la repetición» de la computadora de Cortex).
 *
 * ===========================================================================
 * POR QUÉ NO VIAJAN EN EL RESULTADO DE LA HERRAMIENTA
 * ===========================================================================
 * Es la misma regla de `download.ts` en el paquete de herramientas: lo que
 * llega al resultado de una herramienta termina en tres sitios que no deberían
 * cargar bytes — el contexto del modelo (base64 es lo peor que se le puede dar
 * a leer), la fila de la base de datos donde se guarda el resultado, y la
 * respuesta a la pantalla. Una foto de 480 px pesa ~15–25 KB; veinte pasos son
 * 400 KB de base64 en cada turno siguiente.
 *
 * Así que los bytes se quedan AQUÍ, en memoria, y el resultado lleva sólo un
 * id de 12 caracteres. La pantalla lo pide por una ruta de apps/web
 * (`/api/browser/live/[id]/shot/[shotId]`) que añade quién pregunta; este
 * servicio contesta 404 a quien no sea el dueño.
 *
 * Viven más que la pestaña (la repetición se mira después de cerrarla) pero no
 * para siempre: tope de bytes con desalojo del más viejo, y vencimiento por
 * tiempo. Si el servicio se reinicia, las fotos se van; la pantalla lo trata
 * como «sin foto» y deja el paso solo con su frase.
 */

const THUMB_WIDTH = 480;
const QUALITY = 55;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const TTL_MS = 6 * 60 * 60_000;
/** Una foto que se pase de esto es una página rara; mejor ninguna que una pesada. */
const MAX_ONE_BYTES = 120 * 1024;

interface Entry {
  owner: string;
  sessionId: string;
  jpeg: Buffer;
  at: number;
}

export class ShotStore {
  private readonly entries = new Map<string, Entry>();
  private total = 0;

  constructor(
    private readonly maxTotal = MAX_TOTAL_BYTES,
    private readonly ttlMs = TTL_MS,
  ) {}

  put(owner: string | undefined, sessionId: string, jpeg: Buffer, now = Date.now()): string | null {
    if (jpeg.length === 0 || jpeg.length > MAX_ONE_BYTES) return null;
    this.sweep(now);
    const id = randomBytes(9).toString('base64url');
    this.entries.set(id, { owner: owner ?? '', sessionId, jpeg, at: now });
    this.total += jpeg.length;
    // Map conserva el orden de inserción: el primero es el más viejo.
    for (const [key, entry] of this.entries) {
      if (this.total <= this.maxTotal) break;
      if (key === id) continue;
      this.entries.delete(key);
      this.total -= entry.jpeg.length;
    }
    return id;
  }

  /** `null` si no existe, venció o es de otro dueño (no se distingue a propósito). */
  get(owner: string | undefined, sessionId: string, id: string, now = Date.now()): Buffer | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (now - entry.at > this.ttlMs) {
      this.entries.delete(id);
      this.total -= entry.jpeg.length;
      return null;
    }
    if (entry.sessionId !== sessionId || entry.owner !== (owner ?? '')) return null;
    return entry.jpeg;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.total;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at <= this.ttlMs) break;
      this.entries.delete(key);
      this.total -= entry.jpeg.length;
    }
  }
}

/**
 * Un JPEG de ~480 px de ancho de lo que se ve ahora. Por el protocolo de
 * Chromium (`clip.scale`) para que la reducción la haga el navegador y no
 * viaje la captura entera. Nunca lanza: una foto que falla es «sin foto».
 */
export async function captureThumb(
  page: Page,
  viewport: { width: number; height: number },
): Promise<Buffer | null> {
  let cdp: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>> | null = null;
  try {
    cdp = await page.context().newCDPSession(page);
    const shot = (await Promise.race([
      cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: QUALITY,
        clip: {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
          scale: Math.min(1, THUMB_WIDTH / viewport.width),
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('thumb timeout')), 4_000),
      ),
    ])) as { data: string };
    return Buffer.from(shot.data, 'base64');
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}
