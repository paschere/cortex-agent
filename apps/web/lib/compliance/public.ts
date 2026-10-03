import 'server-only';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { type ComplianceProfile, readComplianceProfile } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LA PUERTA DE AFUERA DEL FORMULARIO DE PQRS (/pqrs/<token>, migración 0195).
 *
 * Quien lo abre es un cliente o un consumidor: no tiene sesión de Cortex. El
 * token ES la credencial (24 bytes al azar, base64url), la misma postura que
 * /cotizacion/<token>. Por eso este es el único archivo de cumplimiento que
 * toca el cliente de servicio sin alcance (lib/tenancy-guard.test.ts lo lista
 * con la razón), y sólo para DOS lecturas: el perfil por token y el nombre de
 * su empresa. Radicar se hace con el handle del espacio de ese perfil.
 *
 * Un token que no abre (inventado, rotado o con el formulario apagado) es
 * `null` y la página responde 404 sin más explicación.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export interface OpenedPqrsForm {
  db: SupabaseClient;
  profile: ComplianceProfile;
  organizationName: string;
}

export async function openPublicPqrsForm(token: string): Promise<OpenedPqrsForm | null> {
  if (!TOKEN_RE.test(token)) return null;
  const service = getSupabaseServiceClient();
  const { data, error } = await service
    .from('compliance_profiles')
    .select('organization_id, pqrs_enabled, pqrs_token')
    .eq('pqrs_token', token)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { organization_id: string; pqrs_enabled: boolean; pqrs_token: string };
  if (!row.pqrs_enabled || row.pqrs_token !== token) return null;
  const db = getOrgScopedClient(row.organization_id);
  const profile = await readComplianceProfile(db).catch(() => null);
  if (!profile || profile.pqrsToken !== token || !profile.pqrsEnabled) return null;
  const { data: org, error: orgError } = await service
    .from('ba_organization')
    .select('name')
    .eq('id', row.organization_id)
    .maybeSingle();
  const name = orgError ? null : (org as { name?: string } | null)?.name;
  return { db, profile, organizationName: name ?? 'Cortex' };
}
