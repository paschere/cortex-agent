import { inngest } from '@/lib/inngest';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { runWeeklyReport } from '@/lib/weekly-report';
import { addDays, bogotaToday, mondayOf } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * El parte semanal, cada lunes, sin que nadie se acuerde.
 *
 * ===========================================================================
 * POR QUÉ ESTA FUNCIÓN ES UNA CÁSCARA
 * ===========================================================================
 * Todo el trabajo está en `lib/weekly-report.ts`, y no por gusto: lo único que
 * de verdad hay que probar aquí es que correrlo dos veces sobre la misma semana
 * produce un informe y un correo, y una función de Inngest no se puede invocar
 * desde una prueba sin levantar medio entorno. Así que el trabajo vive donde se
 * puede llamar y esto es la forma que ya usan `commitments-watch` y
 * `schedule-dispatch`: un despachador sin alcance que sólo lee
 * `organization_id`, y un evento por espacio de trabajo con handle acotado.
 *
 * ===========================================================================
 * LA IDEMPOTENCIA NO ESTÁ AQUÍ
 * ===========================================================================
 * Y es a propósito. Inngest reintenta pasos y los despliegues reinician
 * funciones a medias, así que «¿ya mandamos el de esta semana?» no lo puede
 * contestar esta función: lo contesta el índice único parcial
 * `reports_period_once_idx` de la migración 0100, contra el que
 * `claimWeeklyReport` reclama la semana antes de mandar nada. Este archivo se
 * puede ejecutar diez veces un lunes y sale un correo.
 *
 * ===========================================================================
 * LA CONCURRENCIA
 * ===========================================================================
 * 5, que es el techo del plan. Inngest valida la concurrencia al REGISTRAR la
 * aplicación y no rechaza la función que se pasa: rechaza la aplicación entera,
 * con lo que se caen todos los trabajos de fondo del producto en silencio. Hay
 * una prueba que lo vigila (`concurrency-guard.test.ts`) porque eso ya pasó una
 * vez aquí.
 */

/**
 * Lunes 07:00 en Bogotá.
 *
 * Colombia no tiene horario de verano, así que UTC-5 es fijo y las 12:00 UTC
 * son las 07:00 de allá todos los lunes del año. Temprano, pero no de
 * madrugada: el parte tiene que estar arriba en la bandeja cuando la gente se
 * sienta, y el lunes es el único día de la semana en que «la semana pasada» y
 * «la semana que entra» significan lo mismo para todo el mundo.
 */
const WEEKLY_CRON = '0 12 * * 1';

// ---------------------------------------------------------------------------
// Despachador
// ---------------------------------------------------------------------------

export const weeklyReportDispatch = inngest.createFunction(
  { id: 'weekly-report-dispatch' },
  { cron: WEEKLY_CRON },
  async ({ step }) => {
    // Sin alcance, y sólo aquí. «Qué espacios de trabajo hay» cruza la
    // instalación y detrás de un cron no hay sesión. Cada id que se lee viaja en
    // su propio evento y la función de abajo construye todos sus handles a
    // partir de ese id, así que el parte de una empresa sólo puede leer y
    // escribir filas de esa empresa.
    //
    // Se leen los ADMINISTRADORES y no las organizaciones: un espacio sin nadie
    // que responda por él no tiene a quién rendirle cuentas, y generar un
    // informe que nadie va a recibir sólo produce filas.
    const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
      const db = getSupabaseServiceClient();
      const { data, error } = await db
        .from('users')
        .select('organization_id')
        .eq('role', 'org_admin')
        .limit(20_000);
      if (error) {
        throw new Error(`No se pudieron leer los espacios de trabajo: ${error.message}`);
      }
      const seen = new Set<string>();
      for (const row of (data ?? []) as Array<{ organization_id: string | null }>) {
        if (row.organization_id) seen.add(row.organization_id);
      }
      return [...seen];
    });

    if (workspaces.length > 0) {
      await step.sendEvent(
        'weekly-report-per-workspace',
        workspaces.map((organizationId) => ({
          name: 'reports/weekly.workspace' as const,
          data: { organizationId },
        })),
      );
    }
    return { dispatched: workspaces.length };
  },
);

// ---------------------------------------------------------------------------
// Un espacio de trabajo
// ---------------------------------------------------------------------------

export const weeklyReportWorkspace = inngest.createFunction(
  { id: 'weekly-report-workspace', concurrency: { limit: 5 } },
  { event: 'reports/weekly.workspace' },
  async ({ event, step }) => {
    const organizationId = event.data.organizationId as string | undefined;
    if (!organizationId) return { skipped: 'no workspace on the event' };

    // El día se fija UNA vez y viaja por todos los pasos. Si una corrida cruza
    // la medianoche en Bogotá —un reintento a las 23:59, un despliegue lento—,
    // sin esto un paso podría reclamar una semana y el siguiente reportar otra.
    const today = bogotaToday();
    const weekStart = addDays(mondayOf(today), -7);

    const result = await step.run('build-claim-send', async () => {
      const db = getOrgScopedClient(organizationId);
      return runWeeklyReport({ db, today, weekStart });
    });

    logger.info({ organizationId, ...result }, 'weekly report finished');
    return { organizationId, ...result };
  },
);
