import { listVisibleSpaces } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

export type SetupCheck = {
  id: string;
  label: string;
  state: 'checked' | 'blocked' | 'unknown';
  detail: string;
  affects: string;
  href: string;
  checkedAt: string;
};

/** Read-only checks; configured credentials are never described as a tested session. */
export async function readSetupDiagnostics(db: SupabaseClient, userId: string) {
  const checks: SetupCheck[] = [];
  const checkedAt = new Date().toISOString();
  async function check(
    id: string,
    label: string,
    affects: string,
    href: string,
    read: () => Promise<{ state: SetupCheck['state']; detail: string }>,
  ) {
    try {
      checks.push({ id, label, affects, href, checkedAt, ...(await read()) });
    } catch {
      checks.push({
        id,
        checkedAt,
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
      'Consultar tus sistemas y preparar acciones con los permisos de tu cuenta.',
      '/integrations',
      async () => {
        const r = await db.from('integrations').select('provider,scopes').eq('user_id', userId);
        if (r.error) throw r.error;
        return {
          state: r.data?.length ? 'unknown' : 'blocked',
          detail: r.data?.length
            ? `${r.data.length} conexiones registradas. Abre Integraciones para comprobar acceso; los permisos guardados no prueban que el proveedor acepte la sesión.`
            : 'No hay conexiones personales. Conecta el sistema que necesita tu proceso; también puedes empezar con archivos o texto en Feed.',
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
        const examined = rows.slice(0, 500);
        const bad = examined.filter(
          (d) =>
            d.status !== 'ready' ||
            d.superseded_by ||
            (d.valid_until &&
              (!Number.isFinite(Date.parse(d.valid_until)) ||
                Date.parse(d.valid_until) < Date.now())),
        );
        return {
          state: bad.length || rows.length > 500 ? 'unknown' : 'checked',
          detail: `${Math.min(rows.length, 500)} documentos examinados${rows.length > 500 ? ' (vista parcial)' : ''}; ${bad.length} requieren revisar indexación, vencimiento o reemplazo. Esto no confirma la veracidad ni detecta todas las contradicciones.`,
        };
      },
    ),
    check(
      'feed',
      'Fuentes temporales',
      'Consultar archivos, enlaces y texto sin incorporarlos al cerebro.',
      '/feed',
      async () => {
        const r = await db
          .from('chat_attachments')
          .select('id', { count: 'exact', head: true })
          .eq('created_by', userId)
          .not('feed_kind', 'is', null)
          .gt('purge_at', checkedAt);
        if (r.error) throw r.error;
        return {
          state: r.count ? 'checked' : 'unknown',
          detail: r.count
            ? `${r.count} entradas temporales disponibles para tu cuenta en este espacio. Comprueba su contenido y fecha antes de usarlas como evidencia; no se guardan automáticamente en el cerebro.`
            : 'Tu Feed está vacío. Puedes añadir un archivo, una URL o texto para la primera consulta. Es opcional si ya tienes otra fuente disponible.',
        };
      },
    ),
    check(
      'custom-tools',
      'API de la empresa',
      'Consultar o actuar sobre sistemas personalizados.',
      '/tools#custom-tools',
      async () => {
        const r = await db
          .from('custom_tools')
          .select('id,enabled,last_tested_at,last_error')
          .limit(501);
        if (r.error) throw r.error;
        const active = (r.data ?? []).filter((row) => row.enabled);
        const failed = active.filter((row) => row.last_error);
        const untested = active.filter((row) => !row.last_tested_at);
        return {
          state: failed.length ? 'blocked' : 'unknown',
          detail: active.length
            ? `${active.length} herramientas habilitadas${r.data?.length === 501 ? ' (vista parcial)' : ''}; ${failed.length} con error registrado y ${untested.length} sin prueba registrada. Revisa el resultado de cada prueba y los permisos antes de ejecutar; una prueba anterior no garantiza acceso actual.`
            : 'No hay API propias habilitadas. Si tu proceso usa un sistema especial, prepara su conexión desde Herramientas con su documentación. Esta conexión es opcional.',
        };
      },
    ),
    check(
      'mcp',
      'Servidores MCP',
      'Descubrir herramientas externas disponibles para tu cuenta.',
      '/integrations#mcp',
      async () => {
        const r = await db
          .from('user_mcp_servers')
          .select('id,enabled,last_checked_at,last_error,tool_count')
          .eq('user_id', userId)
          .limit(101);
        if (r.error) throw r.error;
        const active = (r.data ?? []).filter((row) => row.enabled);
        const failed = active.filter((row) => row.last_error);
        return {
          state: failed.length ? 'blocked' : 'unknown',
          detail: active.length
            ? `${active.length} servidores habilitados; ${failed.length} con error registrado. Actualiza su catálogo en Integraciones y revisa las herramientas permitidas; descubrirlas no verifica su ejecución.`
            : 'No tienes servidores MCP habilitados en este espacio. Añade uno si tu sistema ofrece MCP; puedes trabajar con las otras fuentes sin este paso.',
        };
      },
    ),
    check(
      'workflows',
      'Motor de la primera misión',
      'Recorrer un proceso desde el dato inicial hasta su cierre con evidencia.',
      '/management/mission',
      async () => {
        const r = await db
          .from('management_workflows')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId);
        if (r.error) throw r.error;
        return {
          state: r.count ? 'unknown' : 'blocked',
          detail: r.count
            ? `${r.count} procesos registrados. Recorre una misión para comprobar las acciones, aprobaciones y evidencia de cierre; la existencia del proceso no prueba su ejecución.`
            : 'Todavía no hay una misión registrada para tu cuenta. Elige un proceso, sus datos de entrada y la evidencia que demostrará su cierre.',
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
  const order = [
    'connections',
    'feed',
    'sources',
    'custom-tools',
    'mcp',
    'workflows',
    'routines',
    'browser',
  ];
  return checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
