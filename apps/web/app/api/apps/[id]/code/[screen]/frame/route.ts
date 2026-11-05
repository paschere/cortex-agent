import { openScreenForApi, previewAttributesOf } from '@/lib/apps/access';
import { getAppCode, getBuild } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * EL MARCO DE UNA PANTALLA CON CÓDIGO (0243).
 *
 * Devuelve una página HTML con el bundle compilado EN LÍNEA, pensada para ir
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

const CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-downloads',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  'img-src https: data: blob:',
  "connect-src 'none'",
  // Solo Cortex la puede enmarcar (lo mismo que dice X-Frame-Options en next.config).
  "frame-ancestors 'self'",
].join('; ');

/** El texto va dentro de <script>/<style>: que no pueda cerrar la etiqueta ni abrir un comentario. */
function inlineSafe(text: string, tag: 'script' | 'style'): string {
  return text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`).replace(/<!--/g, '<\\!--');
}

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

  const code = await getAppCode(db, access.app.id);
  if (!code)
    return notFound(
      'Esta pantalla todavía no tiene código publicado. En el editor, pestaña «Código»: Compilar y luego Publicar.',
    );

  const wanted = sp.get('build');
  let buildId = code.published_build_id;
  if (wanted) {
    // Vista previa de una compilación: sólo quien administra, con sesión de Cortex.
    if (external || !viewer.companyAdmin || !UUID_RE.test(wanted)) return notFound();
    buildId = wanted;
  }
  if (!buildId)
    return notFound(
      'Esta pantalla todavía no tiene código publicado. En el editor, pestaña «Código»: Compilar y luego Publicar.',
    );
  const build = await getBuild(db, code.id, buildId);
  const bundle = build?.status === 'ok' ? build.bundles[screen.slug] : undefined;
  if (!build || !bundle?.js)
    return notFound(
      'Esta pantalla todavía no está en la versión publicada. En el editor, pestaña «Código»: Compilar y luego Publicar.',
    );

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${screen.title.replace(/[<>&"]/g, '')}</title>
<style>html,body{margin:0;padding:0;background:transparent}*{box-sizing:border-box}</style>
${bundle.css ? `<style>${inlineSafe(bundle.css, 'style')}</style>` : ''}
</head>
<body>
<div id="root"></div>
<script>${inlineSafe(bundle.js, 'script')}</script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Depende de quién mira (rol) y la publicada puede cambiar: nada de cachés compartidas.
      'cache-control': 'private, no-store',
    },
  });
}
