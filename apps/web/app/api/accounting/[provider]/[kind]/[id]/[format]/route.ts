import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  accountingTableSpec,
  getAccountingConnection,
  getAccountingProvider,
  getTrackerBySlug,
  openAccountingSession,
} from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/**
 * PDF Y XML DE UNA FACTURA O NOTA CRÉDITO DEL PROGRAMA CONTABLE (0235).
 *
 *   GET /api/accounting/siigo/invoices/<id>/pdf
 *   GET /api/accounting/siigo/credit-notes/<id>/xml
 *
 * No se guardan: la ruta pide el archivo al programa en el momento, con la
 * conexión de la empresa de quien pregunta (la llave nunca sale del servidor).
 * Sólo se sirve un documento que esté en la tabla sincronizada de ESA empresa
 * (por su id del programa), así que no sirve para pedir documentos ajenos.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = { invoices: 'invoice', 'credit-notes': 'credit_note' } as const;
const ENTITY = { invoice: 'invoices', credit_note: 'credit_notes' } as const;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ provider: string; kind: string; id: string; format: string }> },
) {
  const user = await requireSession().catch(() => null);
  if (!user) return new Response('Unauthorized', { status: 401 });
  const { provider: providerId, kind: rawKind, id: rawId, format } = await ctx.params;
  const kind = KINDS[rawKind as keyof typeof KINDS];
  const id = decodeURIComponent(rawId);
  const provider = getAccountingProvider(providerId);
  if (!kind || !provider || (format !== 'pdf' && format !== 'xml') || !/^[A-Za-z0-9-]{1,80}$/.test(id))
    return new Response('Bad request', { status: 400 });

  const db = getOrgScopedClient(user.organization.id);
  const conn = await getAccountingConnection(db, provider.id);
  if (!conn) return new Response('Ese programa contable no está conectado.', { status: 404 });

  // Sólo documentos que están en la tabla sincronizada de esta empresa.
  const tracker = await getTrackerBySlug(db, accountingTableSpec(provider, ENTITY[kind]).slug);
  if (!tracker) return new Response('Documento no encontrado.', { status: 404 });
  const { data: row, error } = await db
    .from('tracker_rows')
    .select('id, label')
    .eq('tracker_id', tracker.id)
    .eq('external_key', id)
    .maybeSingle();
  if (error || !row) return new Response('Documento no encontrado.', { status: 404 });

  try {
    const session = await openAccountingSession(db, conn.id);
    if (!session.documents)
      return new Response(`${provider.name} no entrega PDF ni XML por API.`, { status: 501 });
    const file = await session.documents.fetch(kind, id, format);
    const name = String((row as { label?: string }).label ?? id)
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 80);
    return new Response(file.bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `inline; filename="${name || id}.${format}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'No se pudo traer el archivo.', {
      status: 502,
    });
  }
}
