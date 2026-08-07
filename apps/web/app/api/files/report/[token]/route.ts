import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { documentHash, renderStandaloneHtml, validateDocument } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/files/report/<token> — open a shared report, with no session.
 *
 * AUTH POSTURE. Identical to /api/files/presentation/<token>, deliberately: one
 * shape for "a Cortex artifact somebody outside the app can open" is worth more
 * than a marginally better second one, and the trade-off is the same. The link
 * is pasted into WhatsApp, Outlook or a client email, where no Cortex cookie
 * exists; a session check would hand the recipient a login page instead of the
 * report. So the link authenticates itself: whoever holds the token gets the
 * document.
 *
 * The compensating controls, unchanged from the presentation route:
 *   1. UNGUESSABLE. 32 random bytes (256 bits), base64url.
 *   2. SHORT-LIVED. `share_expires_at`, 30 days by default. Past it the row
 *      stays — so we can still say what happened — and the answer is 410, not
 *      404. "Este enlace venció" is a better answer than "no existe", and it is
 *      not information a stranger can act on.
 *   3. REVOCABLE. Nulling `share_token` kills the link instantly, and
 *      re-sharing MINTS A NEW ONE rather than extending the old, so "share this
 *      again" also closes the door on whoever had the previous link.
 *   4. ACCOUNTED. Every open increments `share_views`, so the reports screen
 *      shows a link being used more than expected.
 *   5. NOT INDEXABLE, NOT CACHEABLE.
 *
 * WHAT IT SERVES. The stored snapshot, rendered by the same renderer the app
 * screen uses, as one self-contained HTML file: no scripts, no external
 * requests, charts included as inline SVG. It shows what the report showed the
 * day it was generated — which is the whole reason a link is safe to send at
 * all, because "the report I sent you" cannot silently become a different
 * report tomorrow.
 *
 * `text/html` from our own origin is a real decision. The bytes are produced by
 * our renderer and every piece of content in them is escaped
 * (packages/agent-tools/src/reports/html.ts, tested against a document of pure
 * attack strings), and a strict CSP with no script sources is sent alongside —
 * so even a hole in the renderer cannot execute.
 */

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

interface ShareRow {
  id: string;
  title: string;
  document: unknown;
  content_hash: string;
  generated_at: string;
  share_expires_at: string | null;
  share_views: number;
}

function problem(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!token || !TOKEN_RE.test(token)) {
    return problem('Este enlace no es válido.', 404);
  }

  // Unscoped by design: a shared link has no session and therefore no workspace
  // to scope to. The token itself is what proves the caller may see this one
  // row, and the unique partial index means it can only ever match one.
  const sb = getSupabaseServiceClient();

  const { data, error } = await sb
    .from('reports')
    .select('id, title, document, content_hash, generated_at, share_expires_at, share_views')
    .eq('share_token', token)
    .maybeSingle();

  if (error) {
    console.error('[files/report] lookup failed:', error.message);
    return problem('No se pudo abrir este informe ahora mismo. Intenta de nuevo.', 500);
  }
  if (!data) return problem('Este enlace no es válido.', 404);

  const row = data as unknown as ShareRow;

  if (!row.share_expires_at || Date.parse(row.share_expires_at) <= Date.now()) {
    return problem(
      'Este enlace venció. Pídele a quien te lo envió que genere uno nuevo desde Cortex.',
      410,
    );
  }

  let html: string;
  try {
    // Validated on the way out, exactly as the in-app viewer does: a stored row
    // outlives the code that wrote it, and a figure whose citation no longer
    // resolves must not reach a page — least of all one served outside the app.
    const document = validateDocument(row.document);
    const intact = documentHash(document) === row.content_hash;
    html = renderStandaloneHtml(document, {
      idPrefix: `s${row.id.replace(/-/g, '').slice(0, 12)}`,
      footerNote: intact
        ? 'Informe generado por Cortex. Muestra los datos tal como estaban al momento de calcularlo.'
        : 'Atención: el contenido guardado no coincide con su huella. Estas cifras se modificaron después de generarse y no deberían citarse.',
    });
  } catch (err) {
    console.error('[files/report] render failed:', (err as Error).message);
    return problem('Este informe no se puede mostrar. Vuelve a generarlo desde Cortex.', 500);
  }

  // Count the open before responding. Fire-and-forget: a failed counter must
  // never cost somebody their document, and the value is in the trend.
  void sb
    .from('reports')
    .update({ share_views: (row.share_views ?? 0) + 1 })
    .eq('id', row.id)
    .then(({ error: bumpError }) => {
      if (bumpError) console.error('[files/report] counter bump failed:', bumpError.message);
    });

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Belt and braces over the escaping: the document declares no script
      // sources at all, so nothing in it can execute even if a future edit to
      // the renderer let markup through. `sandbox` without allow-scripts also
      // strips the page of an origin, so it cannot reach our cookies.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-same-origin",
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
