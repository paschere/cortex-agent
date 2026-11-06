import { openScreenForApi, previewAttributesOf } from '@/lib/apps/access';
import { getBuildBundle, getCodeRef } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * EL MARCO DE UNA PANTALLA CON CÓDIGO (0243).
 *
 * Devuelve una página HTML PEQUEÑA que carga el bundle compilado desde la ruta inmutable
 * `/api/apps/code/bundle/<build>/<pantalla>.js|css` (cacheable un año: el id de compilación
 * cambia con cada compilación), pensada para ir
 * dentro de `<iframe sandbox="allow-scripts allow-forms allow-popups
 * allow-downloads">` (sin `allow-same-origin`): el documento tiene origen nulo,
 * no ve las cookies ni el DOM de Cortex. La CSP repite esa jaula del lado del
 * servidor (`sandbox` también sirve si alguien abre la URL suelta) y deja a la
 * pantalla sin red propia: `connect-src 'none'`. Todo dato entra por el puente
 * del SDK (postMessage al host), donde el servidor aplica el rol.
 *
 * Quién ve qué: la pantalla se abre con `openScreenForApi` (el rol tiene que
 * ver la pantalla; si no, 404). Sin `?build=` se sirve la compilación
 * PUBLICADA; `?build=<id>` (vista previa de una compilación) sólo la sirve a
 * quien administra la empresa. Si la pantalla no es de código o no hay nada
 * publicado, 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La CSP del marco. El documento tiene origen NULO (sandbox sin allow-same-origin): no todos los
 * navegadores hacen coincidir 'self' con el host en ese caso, así que además se nombra el host
 * explícito de la petición. El bundle sale de /api/apps/code/bundle/…; no hay script en línea.
 */
function cspFor(host: string | null): string {
  const self = host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? ` https://${host}` : '';
  return [
    'sandbox allow-scripts allow-forms allow-popups allow-downloads',
    "default-src 'none'",
    `script-src 'self'${self}`,
    `style-src 'self'${self} 'unsafe-inline' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com data:',
    'img-src https: data: blob:',
    "connect-src 'none'",
    // Solo Cortex la puede enmarcar (lo mismo que dice X-Frame-Options en next.config).
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Las páginas de aviso no cargan nada externo. */
const CSP = cspFor(null);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Va dentro del marco: una página legible, no un JSON. */
const notFound = (message = 'Esa pantalla no existe.') =>
  new NextResponse(
    `<!doctype html><html lang="es"><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px/1.5 system-ui,sans-serif;color:#57534e;background:#faf8f3"><p style="max-width:28rem;padding:24px;text-align:center">${message.replace(/[<>&]/g, '')}</p></body></html>`,
    {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
    },
  );

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; screen: string }> },
) {
  const { id, screen: screenRef } = await params;
  const sp = req.nextUrl.searchParams;
  const opened = await openScreenForApi(id, screenRef, {
    as: sp.get('como'),
    attributes: previewAttributesOf(sp.getAll('atr')),
  });
  if (opened instanceof NextResponse) return opened;
  const { db, access, screen, viewer, external } = opened;
  if (screen.kind !== 'code') return notFound();

  const notPublished =
    'Esta pantalla todavía no tiene código publicado. En el editor, pestaña «Código»: Compilar y luego Publicar.';
  const code = await getCodeRef(db, access.app.id);
  if (!code) return notFound(notPublished);

  const wanted = sp.get('build');
  let buildId = code.published_build_id;
  if (wanted) {
    // Vista previa de una compilación: sólo quien administra, con sesión de Cortex.
    if (external || !viewer.companyAdmin || !UUID_RE.test(wanted)) return notFound();
    buildId = wanted;
  }
  if (!buildId) return notFound(notPublished);
  // Solo el bundle de ESTA pantalla (no la fila con todos), de una compilación de este proyecto.
  const bundle = await getBuildBundle(db, { buildId, slug: screen.slug, codeId: code.id });
  if (!bundle)
    return notFound(
      'Esta pantalla todavía no está en la versión publicada. En el editor, pestaña «Código»: Compilar y luego Publicar.',
    );

  // La compilación y la pantalla fijan el contenido: sirve de validador (304 sin repetir el HTML).
  const etag = `"${buildId}:${screen.slug}:${bundle.css ? 'c' : 'n'}"`;
  const headers = {
    'content-security-policy': cspFor(req.headers.get('host')),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Depende de quién mira (rol) y la publicada puede cambiar: nada de cachés compartidas,
    // y el navegador revalida siempre (la autorización de arriba corre en cada visita).
    'cache-control': 'private, no-cache',
    etag,
  };
  if (req.headers.get('if-none-match') === etag)
    return new NextResponse(null, { status: 304, headers });

  const src = `/api/apps/code/bundle/${buildId}/${encodeURIComponent(screen.slug)}`;
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${screen.title.replace(/[<>&"]/g, '')}</title>
<style>html,body{margin:0;padding:0;background:transparent}*{box-sizing:border-box}</style>
${bundle.css ? `<link rel="stylesheet" href="${src}.css">` : ''}
</head>
<body>
<div id="root"></div>
<script src="${src}.js"></script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
  });
}
