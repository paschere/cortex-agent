import { HoyDashboard } from '@/components/hoy/HoyDashboard';
import { readHoy } from '@/lib/hoy/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday } from '@cortex/agent-tools';
import { decideAutopilot } from './actions';

export const dynamic = 'force-dynamic';

/**
 * «HOY» (el enlace del menú): el tablero de datos del día. La caja con su
 * gráfico y sus indicadores, lo que espera tu decisión, quién te debe y lo que
 * Cortex hizo. Cada bloque depende de su módulo (finanzas, piloto) y de lo que
 * esta persona puede ver: la nómina llega ya recortada del servidor.
 *
 * El panel completo del piloto automático (encender, niveles, ensayo, días
 * anteriores) vive en /piloto/panel; el detalle de una corrida, en /piloto/[id].
 * Decidir una cosa usa la misma acción de servidor que el panel, que vuelve a
 * comprobar quién puede.
 */
export default async function HoyPage() {
  const user = await requireSession();
  const view = await readHoy({
    db: getOrgScopedClient(user.organization.id),
    organizationId: user.organization.id,
    userId: user.id,
    name: user.name ?? null,
    email: user.email,
    isAdmin: user.role === 'org_admin',
    today: bogotaToday(),
  });
  return <HoyDashboard view={view} decide={decideAutopilot} />;
}
