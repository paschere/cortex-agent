import 'server-only';

import type { OwnedCompany } from './founder-guard';
import { type QualitySummary, summarizeQuality } from './quality-shape';
import { getOrgScopedClient } from './supabase/service';

/**
 * Salud interna de las respuestas, últimos 7 días, por empresa propia.
 *
 * Una empresa por manejador (`getOrgScopedClient`), cada lectura con tope y
 * fallando por separado: una empresa sin la migración 0219 o sin lectura sale
 * con lo que sí se pudo leer. «Turnos cortados o fallidos» es el mejor proxy
 * disponible: `turn_latencies.message_id` queda nulo cuando la respuesta no
 * llegó a guardarse (0084).
 */

export const QUALITY_WINDOW_DAYS = 7;
const CAP = 3000;

export interface CompanyQuality {
  organizationId: string;
  name: string;
  summary: QualitySummary | null;
}

export async function readCompanyQuality(
  company: OwnedCompany,
  at: Date = new Date(),
): Promise<CompanyQuality> {
  try {
    const db = getOrgScopedClient(company.id);
    const since = new Date(at.getTime() - QUALITY_WINDOW_DAYS * 86_400_000).toISOString();
    const [latencies, errors, feedback] = await Promise.all([
      db.from('turn_latencies').select('total_ms, message_id').gte('created_at', since).limit(CAP),
      db
        .from('audit_events')
        .select('tool_id')
        .eq('status', 'error')
        .gte('created_at', since)
        .limit(CAP),
      db
        .from('chat_message_feedback')
        .select('rating, reason, comment, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);
    return {
      organizationId: company.id,
      name: company.name,
      summary: summarizeQuality({
        latencies: latencies.error ? [] : ((latencies.data ?? []) as never),
        errorToolIds: errors.error
          ? []
          : ((errors.data ?? []) as Array<{ tool_id: string }>).map((r) => r.tool_id),
        feedback: feedback.error ? [] : ((feedback.data ?? []) as never),
      }),
    };
  } catch (err) {
    console.error('[quality-health] no se pudo leer la empresa', company.id, err);
    return { organizationId: company.id, name: company.name, summary: null };
  }
}

export function readOwnedQuality(owned: OwnedCompany[]): Promise<CompanyQuality[]> {
  return Promise.all(owned.map((company) => readCompanyQuality(company)));
}
