import 'server-only';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { NPS_SURVEY_TOKEN_RE, type NpsSurveyRow, getNpsSurvey } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA PUERTA DE AFUERA DE UNA ENCUESTA (/encuesta/<token>, migración 0193).
 *
 * Quien abre el enlace es el cliente: no tiene sesión de Cortex y viene de un
 * correo o de un WhatsApp. El token ES la credencial (24 bytes al azar), la
 * misma postura que /cotizacion/<token>. Por eso este es el único archivo del
 * embudo que toca el cliente de servicio sin alcance
 * (lib/tenancy-guard.test.ts lo tiene en la lista con la razón), y lo toca
 * para DOS lecturas: la fila por token y el nombre de su empresa. Responder,
 * la tarea del detractor y el aviso van con el handle del espacio de esa fila.
 *
 * Un token que no abre (inventado o de una encuesta anulada) es `null` y la
 * página responde 404 sin más explicación.
 */

export interface OpenedSurvey {
  survey: NpsSurveyRow;
  db: SupabaseClient;
  organizationId: string;
  organizationName: string;
}

export async function openPublicSurvey(token: string): Promise<OpenedSurvey | null> {
  if (!NPS_SURVEY_TOKEN_RE.test(token)) return null;
  const service = getSupabaseServiceClient();
  const { data, error } = await service
    .from('nps_surveys')
    .select('organization_id, id, status')
    .eq('token', token)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { organization_id: string; id: string; status: string };
  if (row.status === 'anulada') return null;
  const db = getOrgScopedClient(row.organization_id);
  const survey = await getNpsSurvey(db, row.id).catch(() => null);
  if (!survey || survey.token !== token) return null;
  // El nombre es un adorno de la cabecera: si su lectura falla, se abre igual.
  const { data: org, error: orgError } = await service
    .from('ba_organization')
    .select('name')
    .eq('id', row.organization_id)
    .maybeSingle();
  const name = orgError ? null : (org as { name?: string } | null)?.name;
  return {
    survey,
    db,
    organizationId: row.organization_id,
    organizationName: name ?? 'Cortex',
  };
}
