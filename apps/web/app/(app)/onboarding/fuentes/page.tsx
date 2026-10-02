import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { FirstSteps } from './_components/FirstSteps';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tus primeros 10 minutos · Cortex' };

/**
 * LOS PRIMEROS 10 MINUTOS: DE DÓNDE SALEN TUS DATOS Y QUÉ HACEMOS CON ELLOS.
 *
 * La guía completa (/onboarding) es para quien dirige y tiene doce pasos. Esta
 * es la puerta corta: elegir UNA fuente y UN proceso, y que cada elección
 * termine en algo que ya funciona — el chat con la petición escrita, el Feed,
 * la conexión de Google. Lo único que se lee aquí es si Google está conectado,
 * porque dos de las fuentes lo necesitan y decirlo antes ahorra un viaje.
 */
export default async function FirstStepsPage({
  searchParams,
}: { searchParams: Promise<{ paso?: string }> }) {
  const user = await requireSession();
  const { paso } = await searchParams;
  const db = getOrgScopedClient(user.organization.id);
  const google = await db
    .from('integrations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('provider', 'google');
  return (
    <FirstSteps
      initialStep={paso === 'proceso' ? 'process' : 'source'}
      googleConnected={!google.error && (google.count ?? 0) > 0}
    />
  );
}
