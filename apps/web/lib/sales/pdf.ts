import 'server-only';
import { readBranding, readLogo } from '@/lib/branding/store';
import {
  type SalesDocumentRow,
  getSalesLines,
  renderSalesPdf,
  salesDocumentNumber,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * El PDF de un documento de venta con la marca de su empresa (0182 + 0170),
 * listo como respuesta HTTP. Lo usan la ruta con sesión (/api/sales/<id>/pdf)
 * y la pública (/api/sales/public/pdf?token=…); las dos llegan aquí con el
 * handle del espacio del documento, así que el logo es el de esa empresa y de
 * ninguna otra.
 */
export async function salesPdfResponse(
  db: SupabaseClient,
  doc: SalesDocumentRow,
  fallbackName: string,
): Promise<Response> {
  const [lines, branding, logo] = await Promise.all([
    getSalesLines(db, doc.id),
    readBranding(db),
    readLogo(db).catch(() => null),
  ]);
  const bytes = renderSalesPdf({
    doc,
    lines,
    brand: {
      name: branding?.display_name?.trim() || fallbackName,
      primary: branding?.primary_color ?? null,
      logo: logo ? { bytes: logo.content, contentType: logo.contentType } : null,
    },
  });
  const filename = `${salesDocumentNumber(doc)}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
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
