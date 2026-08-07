import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  getReport,
  renderStandaloneHtml,
  safeReportFilename,
} from '@cortex/agent-tools';
import { UnauthorizedError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/reports/<id>/export — download the report as one self-contained file.
 *
 * WHY AN EXPORT EXISTS AT ALL, GIVEN THERE IS ALREADY A LINK. They answer
 * different questions, and a product that only offers one of them is quietly
 * telling somebody their question does not count.
 *
 *   THE LINK is for a person. It lives at one address, it can be revoked, it
 *   counts its own opens.
 *   THIS is for a folder. Customs and postal operations get audited, and an
 *   audit wants a file with a date on it that opens in five years with no
 *   server involved. A link cannot be that, because a link is a promise that a
 *   server will still be there.
 *
 * One HTML file, charts included as inline SVG, no scripts, no external
 * requests, no fonts to fetch. It opens offline, it prints, it survives being
 * attached to an email. That is also why it is not a PDF: `presentations/`
 * already covers the mail-it-to-a-client artifact, and re-rendering these
 * charts through a headless browser would buy a worse document for a Chromium
 * launch.
 *
 * SCOPED, unlike the shared-link route: this one is behind the session, so the
 * workspace is known and the read goes through the scoped handle. Another
 * workspace's id resolves to no row, which is a 404 — not a 403, because
 * whether that id exists somewhere else is not this caller's business.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-fA-F-]{16,64}$/;

function problem(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !UUID_RE.test(id)) return problem('Ese informe no existe.', 404);

  let organizationId: string;
  try {
    const user = await requireSession();
    organizationId = user.organization.id;
  } catch (err) {
    if (err instanceof UnauthorizedError) return problem('Inicia sesión para descargar esto.', 401);
    throw err;
  }

  const db = getOrgScopedClient(organizationId);

  let html: string;
  let filename: string;
  try {
    const stored = await getReport(db, id);
    if (!stored) return problem('Ese informe no existe.', 404);
    html = renderStandaloneHtml(stored.document, {
      idPrefix: `e${id.replace(/-/g, '').slice(0, 12)}`,
      footerNote: stored.intact
        ? `Informe generado por Cortex el ${stored.document.generatedAt.slice(0, 10)}. Muestra los datos tal como estaban en ese momento.`
        : 'Atención: el contenido guardado no coincide con su huella. Estas cifras se modificaron después de generarse y no deberían citarse.',
    });
    filename = safeReportFilename(
      `${stored.document.title}-${stored.document.generatedAt.slice(0, 10)}`,
    );
  } catch (err) {
    console.error('[reports/export] failed:', (err as Error).message);
    return problem('No se pudo preparar la descarga. Vuelve a generar el informe.', 500);
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // `filename` is already reduced to ASCII word characters, because header
      // values are latin-1 and "Vencimientos — próximos 60 días" would be
      // rejected outright.
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
