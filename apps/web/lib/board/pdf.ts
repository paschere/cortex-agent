import 'server-only';
import { readBranding, readLogo } from '@/lib/branding/store';
import { type BoardReport, renderBoardPdf } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * El PDF del informe para socios con la marca de su empresa (0191 + 0170),
 * como respuesta HTTP. Lo usan la ruta con sesión (/api/board/<id>/pdf) y la
 * pública (/api/board/public/pdf?token=…), las dos con el handle del espacio
 * del informe. Pinta lo guardado: no recalcula.
 */
export async function boardPdfResponse(
  db: SupabaseClient,
  report: BoardReport,
  fallbackName: string,
): Promise<Response> {
  const [branding, logo] = await Promise.all([
    readBranding(db).catch(() => null),
    readLogo(db).catch(() => null),
  ]);
  const bytes = renderBoardPdf(report.content, {
    name: branding?.display_name?.trim() || report.content.company || fallbackName,
    primary: branding?.primary_color ?? null,
    logo: logo?.content ?? null,
  });
  const filename = `informe-socios-${report.period}.pdf`;
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
