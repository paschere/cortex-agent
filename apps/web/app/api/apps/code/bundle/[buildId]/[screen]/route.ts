import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { getBuildBundle } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * EL CÓDIGO DE UNA PANTALLA CON CÓDIGO, COMO ARCHIVO CACHEABLE.
 *
 *   GET /api/apps/code/bundle/<buildId>/<pantalla>.js   (y .css)
 *
 * El marco (`/api/apps/<app>/code/<pantalla>/frame`) ya no lleva el JS en línea: carga esta ruta.
 * Una compilación nunca cambia después de guardada, así que el contenido es inmutable
 * (`max-age=31536000, immutable`) y el navegador y la CDN lo guardan: pasar de una pantalla a otra
 * ya no vuelve a bajar ~300 KB.
 *
 * POR QUÉ NO LLEVA SESIÓN. El iframe tiene origen nulo (sandbox sin `allow-same-origin`): sus
 * peticiones NO llevan cookies. Esta ruta es pública en el middleware y la puerta es el id:
 *   - es el código de CLIENTE de una pantalla (lo que cualquier rol que la vea ya baja al
 *     navegador); los secretos viven en funciones de servidor, que esta ruta NUNCA sirve (solo
 *     lee `bundles`, que son pantallas; `functions` es otra columna);
 *   - `buildId` es un uuid v4 (122 bits) imposible de adivinar, y solo se ve en el HTML del marco
 *     o en la lista de compilaciones del editor (administradores);
 *   - solo se sirve una compilación con estado `ok`, y se valida el formato de ambos parámetros.
 *   - La vista previa de una compilación NO publicada (`?build=` en el marco) usa esta misma ruta:
 *     el marco ya exigió ser administrador, y aquí el uuid es el permiso efectivo.
 * La autorización de «quién ve esta pantalla» sigue en el marco, que no se cachea sin revalidar.
 */

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^([a-zA-Z0-9_-]{1,64})\.(js|css)$/;

const NOT_FOUND = () =>
  new NextResponse('Not found', {
    status: 404,
    // Un 404 no se guarda: la compilación puede quedar lista un momento después.
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ buildId: string; screen: string }> },
) {
  const { buildId, screen } = await params;
  const m = NAME_RE.exec(screen);
  if (!UUID_RE.test(buildId) || !m) return NOT_FOUND();
  const [, slug, ext] = m as unknown as [string, string, 'js' | 'css'];

  const bundle = await getBuildBundle(getSupabaseServiceClient(), {
    buildId: buildId.toLowerCase(),
    slug,
  });
  if (!bundle) return NOT_FOUND();
  const body = ext === 'js' ? bundle.js : bundle.css;
  return new NextResponse(body, {
    headers: {
      'content-type': ext === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
