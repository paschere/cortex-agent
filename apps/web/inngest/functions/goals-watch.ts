import { sendEmail } from '@/lib/email';
import { renderGoalNoticeEmail } from '@/lib/goal-notice-email';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type GoalReadingRow,
  type GoalRow,
  type NoticeClass,
  bogotaToday,
  claimGoalNotice,
  goalNoticesOwed,
  hydrateGoals,
  lastClosedPeriod,
  lastMeasuredStatus,
  listGoals,
  measureAndRecord,
  metricByKey,
  readingFor,
  releaseGoalNotice,
  settleGoalNotice,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * Lo que convierte una tabla de metas en un gerente: nadie tiene que acordarse
 * de mirar.
 *
 * Cada mañana, por espacio de trabajo, Cortex mira si algún período ya cerró,
 * congela su lectura si todavía no estaba escrita, y manda un correo cuando la
 * cifra se salió de lo fijado — o cuando volvió a su sitio.
 *
 * ===========================================================================
 * SÓLO SE MIDE LO QUE YA TERMINÓ
 * ===========================================================================
 * `lastClosedPeriod` devuelve el último período CERRADO, y es el único que se
 * escribe. Medir el mes en curso daría una fila que cambia cada mañana, que es
 * exactamente el marcador-contra-fotografía que la 0101 existe para no ser. La
 * pantalla sí enseña el período en curso, calculado en vivo y marcado como tal,
 * sin guardarlo en ninguna parte.
 *
 * Y NO HAY BACKFILL. Una meta empieza a tener historia el primer período que
 * cierra después de fijarla. Rellenar hacia atrás sería calcular hoy, con los
 * datos de hoy, un número presentado como el de marzo.
 *
 * ===========================================================================
 * LA IDEMPOTENCIA NO ES BEST-EFFORT
 * ===========================================================================
 * Inngest reintenta pasos, los despliegues los reinician y un cron que dispara
 * dos veces es un martes normal. Así que ninguna de las dos preguntas que
 * importan se decide en este archivo:
 *
 *   «¿ya está medido este período?»  lo decide `goal_readings_once`
 *   «¿ya dijimos esto?»              lo decide `goal_notices_once_idx`
 *
 * Correr esta función diez veces seguidas escribe una lectura y manda un
 * correo.
 *
 * ===========================================================================
 * FORMA
 * ===========================================================================
 * Dispatcher por cron + evento por espacio, igual que commitments-watch,
 * schedule-dispatch y memory-derive: una función decide quién toca y reparte,
 * otra hace el trabajo de un solo espacio para que un fallo quede contenido y
 * Inngest reintente sólo ese espacio. Concurrencia 5, que es el techo del plan
 * — pedir seis no desregistra esa función, desregistra LA APLICACIÓN ENTERA
 * (ver concurrency-guard.test.ts).
 *
 * CERO LLAMADAS AL MODELO. Todo lo de aquí es aritmética sobre tablas y una
 * plantilla de correo. Una meta cuya cifra dependiera de lo que un modelo
 * opinara esa mañana no sería una meta.
 */

/**
 * 06:30 en Bogotá. Media hora después del vigilante de compromisos, para que
 * los dos correos de la mañana no salgan en el mismo minuto y el de la meta
 * —que es un resumen de un período— llegue debajo del que es urgente. Colombia
 * no cambia la hora, así que 11:30 UTC son las 06:30 allí todos los días.
 */
const WATCH_CRON = '30 11 * * *';

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** El cuerpo, extraído a la firma de la cola nueva; `event` no se usa. */
export const goalsWatchDispatchJob: JobHandler = async ({ step }) => {
  // Sin alcance, y sólo aquí. «Qué espacios tienen metas» cruza la instalación
  // entera y no hay sesión detrás de un cron. Cada id que sale de aquí viaja
  // en su propio evento, y la función de abajo construye todos sus handles a
  // partir de ese id — así que el vigilante de una empresa sólo puede leer y
  // escribir las filas de esa empresa.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const db = getSupabaseServiceClient();
    const { data, error } = await db
      .from('goals')
      .select('organization_id')
      .eq('state', 'active')
      .limit(20_000);
    if (error) throw error;
    const seen = new Set<string>();
    for (const row of (data ?? []) as Array<{ organization_id: string | null }>) {
      if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });

  if (workspaces.length > 0) {
    await step.sendEvent(
      'goals-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'goals/watch.workspace' as const,
        data: { organizationId },
      })),
    );
  }
  return { dispatched: workspaces.length };
};

export const goalsWatchDispatch = inngest.createFunction(
  { id: 'goals-watch-dispatch' },
  { cron: WATCH_CRON },
  async (ctx) => goalsWatchDispatchJob(ctx as unknown as JobContext),
);

// ---------------------------------------------------------------------------
// Un espacio de trabajo
// ---------------------------------------------------------------------------

interface PlannedNotice {
  goalId: string;
  readingId: string;
  periodStart: string;
  periodLabel: string;
  noticeClass: NoticeClass;
  previousDisplay: string | null;
}

export const goalsWatchWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };

  // Se calcula una vez y se lleva por todos los pasos. Si una ejecución cruza
  // la medianoche en Bogotá, todos los pasos siguen de acuerdo sobre qué día
  // estaban decidiendo — de otro modo un aviso se reclamaría para una fecha y
  // se reportaría contra otra.
  const today = bogotaToday();

  // 1. Congelar lo que ya cerró ------------------------------------------
  const frozen = await step.run('freeze-readings', async () => {
    const db = getOrgScopedClient(organizationId);
    const goals = await listGoals(db, { state: 'active', limit: 200 });

    let recorded = 0;
    let already = 0;
    let unknown = 0;
    for (const goal of goals) {
      const spec = metricByKey(goal.metric_key);
      if (!spec) {
        // Una meta cuya métrica ya no está en el catálogo. No se borra ni se
        // inventa un número: se salta, y el histórico que tenga se queda tal
        // cual. La pantalla lo dice.
        unknown += 1;
        continue;
      }
      const period = lastClosedPeriod(goal.cadence, today);
      const result = await measureAndRecord(db, goal, period, spec);
      if (result.outcome === 'recorded') recorded += 1;
      else already += 1;
    }
    return { goals: goals.length, recorded, already, unknown };
  });

  // 2. Qué avisos debe hoy este espacio -----------------------------------
  const planned = await step.run('plan-notices', async (): Promise<PlannedNotice[]> => {
    const db = getOrgScopedClient(organizationId);
    const goals = await listGoals(db, { state: 'active', limit: 200 });
    const plan: PlannedNotice[] = [];

    for (const goal of goals) {
      const period = lastClosedPeriod(goal.cadence, today);
      const reading = await readingFor(db, goal.id, period.start);
      if (!reading) continue;

      // El último veredicto MEDIBLE anterior, no el del período de al lado:
      // un mes sin datos no puede tragarse el correo que cierra el lazo.
      const previousStatus = await lastMeasuredStatus(db, goal.id, period.start);
      for (const noticeClass of goalNoticesOwed({ status: reading.status, previousStatus })) {
        plan.push({
          goalId: goal.id,
          readingId: reading.id,
          periodStart: period.start,
          periodLabel: period.label,
          noticeClass,
          previousDisplay: await previousReadingDisplay(db, goal.id, period.start),
        });
      }
    }
    return plan;
  });

  // 3. Reclamar y mandar. La reclamación es lo que hace esto reintentable. -
  const sent = await step.run('send-notices', async () => {
    const db = getOrgScopedClient(organizationId);
    let delivered = 0;
    let skipped = 0;
    let failed = 0;

    const goals = await hydrateGoals(db, await listGoals(db, { state: 'active', limit: 200 }));
    const byId = new Map(goals.map((g) => [g.id, g]));
    const admins = await orgAdmins(db);
    const book = await addressBook(db, [
      ...new Set([...goals.map((g) => g.created_by), ...admins]),
    ]);

    for (const item of planned) {
      const goal = byId.get(item.goalId);
      if (!goal) {
        skipped += 1;
        continue;
      }

      // A quien fijó la meta, o a los administradores si ese usuario ya no
      // tiene correo. Se resuelve ahora y no se congela en la meta, para que
      // un cambio de responsable surta efecto inmediatamente.
      const to = book.get(goal.created_by) ? goal.created_by : (admins[0] ?? null);
      const email = to ? (book.get(to) ?? null) : null;

      const claim = await claimGoalNotice(db, {
        goalId: item.goalId,
        readingId: item.readingId,
        periodStart: item.periodStart,
        noticeClass: item.noticeClass,
        sentOn: today,
        recipientUserId: to,
        recipientEmail: email,
      });
      // Alguien ya lo dijo, en este período y de esta clase. Ese es todo el
      // punto del libro de avisos; se sigue sin decir nada.
      if (claim.outcome === 'taken' || !claim.id) {
        skipped += 1;
        continue;
      }

      if (!email) {
        // Se suelta la reclamación en vez de cerrarla en falso: dejarla haría
        // que este incumplimiento no se avisara NUNCA, por un problema que se
        // arregla poniéndole un correo a alguien.
        await releaseGoalNotice(db, claim.id);
        failed += 1;
        continue;
      }

      const reading = await readingFor(db, item.goalId, item.periodStart);
      if (!reading) {
        await releaseGoalNotice(db, claim.id);
        skipped += 1;
        continue;
      }

      const mail = renderGoalNoticeEmail({
        goal,
        reading,
        noticeClass: item.noticeClass,
        periodLabel: item.periodLabel,
        previousDisplay: item.previousDisplay,
      });
      const outcome = await sendEmail({
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });

      await settleGoalNotice(db, {
        id: claim.id,
        delivered: outcome.sent,
        note: outcome.sent ? null : (outcome.reason ?? 'No se pudo enviar'),
      });
      if (outcome.sent) delivered += 1;
      else failed += 1;
    }
    return { planned: planned.length, delivered, skipped, failed };
  });

  logger.info({ organizationId, today, frozen, notices: sent }, 'goals watch finished');
  return { organizationId, today, frozen, notices: sent };
};

export const goalsWatchWorkspace = inngest.createFunction(
  { id: 'goals-watch-workspace', concurrency: { limit: 5 } },
  { event: 'goals/watch.workspace' },
  async (ctx) => goalsWatchWorkspaceJob(ctx as unknown as JobContext),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** El número del período medible anterior, para poner el contraste al lado. */
async function previousReadingDisplay(
  db: ReturnType<typeof getOrgScopedClient>,
  goalId: string,
  beforePeriodStart: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('goal_readings')
    .select('display, status, period_start')
    .eq('goal_id', goalId)
    .lt('period_start', beforePeriodStart)
    .order('period_start', { ascending: false })
    .limit(12);
  if (error) throw error;
  const rows = (data ?? []) as Array<Pick<GoalReadingRow, 'display' | 'status'>>;
  return rows.find((r) => r.status !== 'unmeasurable')?.display ?? null;
}

/** Los administradores, a quienes cae el aviso si el autor ya no tiene correo. */
async function orgAdmins(db: ReturnType<typeof getOrgScopedClient>): Promise<string[]> {
  const { data, error } = await db.from('users').select('id').eq('role', 'org_admin').limit(10);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((u) => u.id);
}

async function addressBook(
  db: ReturnType<typeof getOrgScopedClient>,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from('users').select('id, email').in('id', ids);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Array<{ id: string; email: string | null }>)
      .filter((u): u is { id: string; email: string } => Boolean(u.email))
      .map((u) => [u.id, u.email]),
  );
}

export type { GoalRow };
