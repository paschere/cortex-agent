import { getOrgScopedClient } from '@/lib/supabase/service';
import { autopilotToday, bogotaToday } from '@cortex/agent-tools';
import { AutopilotStrip } from './AutopilotStrip';

/**
 * «PILOTO AUTOMÁTICO: HOY HICE N, TE ESPERA M», en Inicio.
 *
 * Sólo si el piloto está encendido o corrió hoy: un aviso de algo apagado en
 * cada visita es ruido. Su propio Suspense; si la lectura falla, no se pinta
 * (Inicio no se cae por esto).
 */
export async function AutopilotCard({ organizationId }: { organizationId: string }) {
  const db = getOrgScopedClient(organizationId);
  const day = bogotaToday();
  const state = await autopilotToday(db, { day }).catch(() => null);
  if (!state) return null;
  if (!state.settings.enabled && !state.run) return null;
  return (
    <AutopilotStrip
      enabled={state.settings.enabled}
      ran={Boolean(state.run && state.run.status !== 'running')}
      running={state.run?.status === 'running'}
      done={state.run?.done_count ?? 0}
      waiting={state.waiting}
      href={state.run ? `/piloto/${state.run.id}` : '/piloto'}
      runHour={state.settings.runHour}
    />
  );
}
