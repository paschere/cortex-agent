import 'server-only';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { type SalesDocumentRow, getSalesDocumentRow } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA PUERTA DE AFUERA DE UNA COTIZACIÓN (/cotizacion/<token>, migración 0182).
 *
 * Quien abre el enlace es el cliente: no tiene sesión de Cortex y viene de un
 * correo. El token ES la credencial (24 bytes al azar, base64url), la misma
 * postura que /v/<token> de las vistas compartidas. Por eso este es el único
 * archivo de ventas que toca el cliente de servicio sin alcance
 * (lib/tenancy-guard.test.ts lo tiene en la lista con la razón), y lo toca para
 * DOS lecturas: la fila por token y el nombre de su empresa. Todo lo que sigue
 * —líneas, marca, logo, aceptar— se hace con el handle del espacio de esa fila.
 *
 * Un token que no abre (inventado, de un documento anulado o que no es una
 * cotización) es `null` y la página responde 404 sin más explicación.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export interface OpenedQuote {
  doc: SalesDocumentRow;
  db: SupabaseClient;
  organizationName: string;
}

export async function openPublicQuote(token: string): Promise<OpenedQuote | null> {
  if (!TOKEN_RE.test(token)) return null;
  const service = getSupabaseServiceClient();
  const { data, error } = await service
    .from('sales_documents')
    .select('organization_id, id, kind, status')
    .eq('share_token', token)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { organization_id: string; id: string; kind: string; status: string };
  if (row.kind !== 'quote' || row.status === 'anulada') return null;
  const db = getOrgScopedClient(row.organization_id);
  const doc = await getSalesDocumentRow(db, row.id).catch(() => null);
  if (!doc || doc.share_token !== token) return null;
  // El nombre es un adorno de la cabecera: si su lectura falla, se abre igual.
  const { data: org, error: orgError } = await service
    .from('ba_organization')
    .select('name')
    .eq('id', row.organization_id)
    .maybeSingle();
  const name = orgError ? null : (org as { name?: string } | null)?.name;
  return { doc, db, organizationName: name ?? 'Cortex' };
}
