import { listVisibleSpaces } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

export type SetupCheck = {
  id: string;
  label: string;
  state: 'checked' | 'blocked' | 'unknown';
  detail: string;
  affects: string;
  href: string;
};

/** Read-only checks; configured credentials are never described as a tested session. */
export async function readSetupDiagnostics(db: SupabaseClient, userId: string) {
  const checks: SetupCheck[] = [];
  async function check(
    id: string,
    label: string,
    affects: string,
    href: string,
    read: () => Promise<{ state: SetupCheck['state']; detail: string }>,
  ) {
    try {
      checks.push({ id, label, affects, href, ...(await read()) });
    } catch {
      checks.push({
        id,
        label,
        affects,
        href,
        state: 'unknown',
        detail: 'No se pudo comprobar. Reintenta; este resultado no significa que esté listo.',
      });
    }
  }
  await Promise.all([
    check(
      'connections',
      'Conexiones y permisos',
      'Leer fuentes y enviar cobros desde tu cuenta.',
      '/integrations',
      async () => {
        const r = await db.from('integrations').select('provider,scopes').eq('user_id', userId);
        if (r.error) throw r.error;
        return {
          state: r.data?.length ? 'unknown' : 'blocked',
          detail: r.data?.length
            ? `${r.data.length} conexiones registradas. Abre Integraciones para comprobar acceso; los permisos guardados no prueban que el proveedor acepte la sesión.`
            : 'No hay conexiones personales. Para enviar un cobro debes conectar tu correo.',
        };
      },
    ),
    check(
      'sources',
      'Información disponible',
      'Decidir qué documentos usar como evidencia.',
      '/kb',
      async () => {
        const spaces = await listVisibleSpaces(db, userId);
        if (!spaces.length)
          return {
            state: 'blocked',
            detail:
              'No tienes espacios de conocimiento visibles. Puedes empezar consultando datos temporales en Feed.',
          };
        const r = await db
          .from('kb_documents')
          .select('id,status,valid_until,superseded_by', { count: 'exact' })
          .in(
            'collection_id',
            spaces.map((s) => s.id),
          )
          .limit(501);
        if (r.error) throw r.error;
        const rows = r.data ?? [];
        if (!rows.length)
          return {
            state: 'blocked',
            detail:
              'No hay documentos visibles en el cerebro. El Feed sigue siendo temporal hasta que decidas guardar algo.',
          };
        const bad = rows.filter(
          (d) =>
            d.status !== 'ready' ||
            d.superseded_by ||
            (d.valid_until && new Date(d.valid_until).getTime() < Date.now()),
        );
        return {
          state: bad.length || rows.length > 500 ? 'unknown' : 'checked',
          detail: `${Math.min(rows.length, 500)} documentos examinados${rows.length > 500 ? ' (vista parcial)' : ''}; ${bad.length} requieren revisar indexación, vencimiento o reemplazo. Esto no confirma la veracidad ni detecta todas las contradicciones.`,
        };
      },
    ),
    check(
      'workflows',
      'Motor de la primera misión',
      'Preparar y seguir una factura sin duplicar el cobro.',
      '/management/mission',
      async () => {
        const r = await db
          .from('management_workflows')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId);
        if (r.error) throw r.error;
        return {
          state: 'checked',
          detail:
            'La tabla de procesos responde. El guardado, las aprobaciones y el seguimiento deben validarse recorriendo una misión real.',
        };
      },
    ),
    check(
      'routines',
      'Rutinas y avisos',
      'Dar seguimiento cuando no estás en el chat.',
      '/schedules',
      async () => {
        const r = await db
          .from('scheduled_jobs')
          .select('id,next_run_at,last_run_at,notify_email,notify_conversation')
          .eq('status', 'active')
          .or(`user_id.eq.${userId},is_global.eq.true`)
          .limit(101);
        if (r.error) throw r.error;
        const rows = r.data ?? [];
        if (!rows.length)
          return {
            state: 'blocked',
            detail:
              'No hay rutinas activas visibles. Programa el parte o un seguimiento con destinatarios autorizados.',
          };
        const late = rows.filter(
          (j) => j.next_run_at && Date.parse(j.next_run_at) < Date.now() - 30 * 60000,
        );
        return {
          state: late.length ? 'blocked' : 'unknown',
          detail: `${rows.length} rutinas activas; ${late.length} con ejecución pendiente hace más de 30 minutos. Revisa el historial y el canal de aviso para confirmar la entrega.`,
        };
      },
    ),
    check(
      'browser',
      'Navegador de Cortex',
      'Enseñar trámites en un perfil aislado.',
      '/browser',
      async () => {
        const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
        if (!base || !process.env.BROWSER_SERVICE_TOKEN)
          return {
            state: 'blocked',
            detail: 'Falta configurar la dirección o credencial del servicio de navegador.',
          };
        const r = await fetch(`${base}/health`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok || (await r.json()).ok !== true) throw new Error('health');
        return {
          state: 'unknown',
          detail:
            'El servicio responde. Falta abrir tu perfil para comprobar la credencial, Chromium y el acceso al portal; la salud del servidor no prueba esos pasos.',
        };
      },
    ),
  ]);
  const order = ['connections', 'sources', 'workflows', 'routines', 'browser'];
  return checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
