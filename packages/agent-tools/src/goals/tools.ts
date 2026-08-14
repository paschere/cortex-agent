import { z } from 'zod';
import { registerTool } from '../index';
import { METRIC_CATALOG, metricByKey, offerMetrics } from './catalog';
import {
  CADENCES,
  CADENCE_LABEL,
  DIRECTION_LABEL,
  STATUS_LABEL,
  UNIT_LABEL,
  bogotaToday,
  describeTarget,
  lastClosedPeriod,
  periodContaining,
} from './shape';
import {
  type GoalRow,
  getGoal,
  hydrateGoals,
  listGoals,
  listReadings,
  measureLive,
  writeGoal,
} from './store';

/**
 * LAS METAS, DICHAS EN VOZ ALTA.
 *
 * ===========================================================================
 * QUÉ SE ARREGLA AQUÍ
 * ===========================================================================
 * El módulo entero —el catálogo que se niega a ofrecer lo que no sabe medir, la
 * lectura congelada de cada período, el aviso cuando se incumple— existía y
 * estaba probado, y desde el chat no se podía ni ver una meta ni fijarla. En un
 * producto que se vende como un gerente y cuya superficie principal es una
 * conversación, lo que no tiene herramienta NO EXISTE: la pantalla `/goals` la
 * abre quien ya sabe que está ahí.
 *
 * ===========================================================================
 * ESTAS CUATRO SON DE PAPEL, Y ESO ES DELIBERADO
 * ===========================================================================
 * No hay una sola regla de negocio en este archivo. No decide qué se puede
 * medir (`offerMetrics`), no juzga si una meta se cumplió (`judge`, dentro de
 * `measureLive`), no comprueba dos veces que la métrica esté disponible
 * (`writeGoal` lo hace al guardar, que es donde la regla se hace cumplir de
 * verdad) y no formatea una sola cifra (`display` viene ya escrito para
 * Colombia). Todo eso ya está resuelto una vez, y una segunda implementación
 * aquí sería una segunda respuesta a la misma pregunta.
 *
 * En particular, LOS MENSAJES DE RECHAZO SON LOS DEL MOTOR. Cuando este espacio
 * no puede medir la cartera, la frase que llega —«Para medir la cartera
 * necesito saber qué se ha pagado…»— es la misma que enseña el selector de la
 * pantalla y la misma que devuelve `writeGoal` al negarse. Reescribirla aquí
 * daría dos explicaciones del mismo no, y la que se ve ganaría a la que manda.
 *
 * ===========================================================================
 * POR QUÉ `goals.list` Y `goals.measure` SON DOS Y NO UNA
 * ===========================================================================
 * Porque las dos cifras no valen lo mismo. La de `goals.list` es la del último
 * período CERRADO: está congelada, se juzgó contra el objetivo que la meta
 * tenía ese día y es la que se cita. La de `goals.measure` es del período EN
 * CURSO, se calcula en vivo, no se guarda en ninguna parte y cambia cada
 * mañana. Devolverlas juntas y sin distinguir enseñaría a citar la segunda como
 * si fuera la primera, que es exactamente lo que la migración 0101 se prohíbe a
 * sí misma al no dejar que el cron escriba un período abierto.
 */

// ---------------------------------------------------------------------------
// Vocabulario compartido por las cuatro
// ---------------------------------------------------------------------------

/**
 * La lista cerrada, sacada del catálogo y no escrita a mano: una métrica nueva
 * es un objeto más en `METRIC_CATALOG` y aparece aquí sola.
 */
const METRIC_KEYS = METRIC_CATALOG.map((m) => m.key) as [string, ...string[]];

const CATALOG_LINE = METRIC_CATALOG.map((m) => `${m.key} (${m.label})`).join(', ');

const ReadingSchema = z.object({
  periodLabel: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  display: z.string(),
  value: z.number().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  /** El objetivo contra el que se juzgó ESE período, ya redactado. */
  judgedAgainst: z.string(),
  method: z.string(),
  sampleSize: z.number(),
  frozenAt: z.string(),
});

const GoalSchema = z.object({
  id: z.string(),
  label: z.string(),
  metricKey: z.string(),
  /** Nulo cuando la métrica ya no está en el catálogo. */
  metricLabel: z.string().nullable(),
  cadence: z.string(),
  cadenceLabel: z.string(),
  targetValue: z.number(),
  targetLabel: z.string(),
  unitLabel: z.string(),
  sourceSystem: z.string().nullable(),
  createdBy: z.string(),
  createdOn: z.string(),
  /** El último período cerrado. Nulo hasta que cierre el primero. */
  latest: ReadingSchema.nullable(),
});

type GoalOut = z.infer<typeof GoalSchema>;

function toGoal(goal: GoalRow, latest: GoalOut['latest']): GoalOut {
  const spec = metricByKey(goal.metric_key);
  return {
    id: goal.id,
    label: goal.label,
    metricKey: goal.metric_key,
    metricLabel: spec?.label ?? null,
    cadence: goal.cadence,
    cadenceLabel: CADENCE_LABEL[goal.cadence],
    targetValue: goal.target_value,
    targetLabel: describeTarget(goal.direction, goal.target_value, goal.unit),
    unitLabel: UNIT_LABEL[goal.unit],
    sourceSystem: spec?.source.system ?? null,
    createdBy: goal.created_by_name ?? 'alguien de este espacio',
    createdOn: goal.created_at.slice(0, 10),
    latest,
  };
}

// ---------------------------------------------------------------------------

export const goalsOfferMetrics = registerTool({
  id: 'goals.offer_metrics',
  description:
    'Qué puede medir ESTE espacio de trabajo hoy y qué no, con el motivo de cada no. Es el paso previo a fijar una meta: cada métrica dice qué mide, en qué unidad, si más es mejor o peor, qué objetivo se suele poner y de qué sistema sale la cifra. Las que no se pueden calcular NO desaparecen: salen marcadas y con qué hace falta para desbloquearlas («conecta Siigo o registra pagos a mano»). Úsala antes de goals.set y cuando alguien pregunte qué sabe medir Cortex de esta empresa.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    metrics: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        blurb: z.string(),
        unitLabel: z.string(),
        directionLabel: z.string(),
        suggestedTarget: z.number(),
        sourceSystem: z.string(),
        available: z.boolean(),
        /** En español y accionable. Sólo cuando `available` es falso. */
        reason: z.string().nullable(),
      }),
    ),
    availableCount: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const offers = await offerMetrics(ctx.db);
    const available = offers.filter((o) => o.available).length;

    return {
      metrics: offers.map((offer) => ({
        key: offer.spec.key,
        label: offer.spec.label,
        blurb: offer.spec.blurb,
        unitLabel: UNIT_LABEL[offer.spec.unit] || 'unidades',
        directionLabel: DIRECTION_LABEL[offer.spec.direction],
        suggestedTarget: offer.spec.suggestedTarget,
        sourceSystem: offer.spec.source.system,
        available: offer.available,
        reason: offer.reason,
      })),
      availableCount: available,
      // La prosa de aquí cuenta la lista; el porqué de cada no viene en su
      // `reason` y NO se reescribe. Ver la cabecera.
      guidance:
        available === 0
          ? `Ninguna de las ${offers.length} métricas del catálogo se puede medir todavía en este espacio de trabajo. Cada una trae en "reason" qué le falta; dile eso a la persona en vez de proponerle una meta que quedaría vacía.`
          : `${available} de ${offers.length} métricas se pueden medir hoy aquí. Las demás vienen con "available": false y el motivo en "reason" — dilo tal cual, es lo que hay que hacer para desbloquearlas. Para fijar una, goals.set con su "key"; el objetivo lo dice la persona (en "suggestedTarget" hay una sugerencia, no una regla).`,
    };
  },
});

// ---------------------------------------------------------------------------

export const goalsList = registerTool({
  id: 'goals.list',
  description:
    'Las metas que esta empresa fijó y cómo van: la cifra del último período CERRADO, contra qué objetivo se juzgó, con qué aritmética se calculó y quién fijó la meta. Responde «¿cómo vamos con las metas?» y «¿estamos cumpliendo lo de la cartera?». La cifra que devuelve está congelada y es la que se cita; para lo que va del período en curso, goals.measure.',
  inputSchema: z.object({
    state: z
      .enum(['active', 'archived'])
      .default('active')
      .describe('Las retiradas se guardan porque su histórico es historia; por defecto no salen.'),
    metricKey: z.enum(METRIC_KEYS).nullish().describe(`Para una sola métrica. ${CATALOG_LINE}`),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    goals: z.array(GoalSchema),
    breached: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const rows = await hydrateGoals(
      ctx.db,
      await listGoals(ctx.db, {
        state: input.state ?? 'active',
        metricKey: input.metricKey ?? undefined,
        limit: input.limit,
      }),
    );

    const today = bogotaToday();
    const goals = await Promise.all(
      rows.map(async (goal) => {
        // La del último período cerrado, y si todavía no está escrita, la más
        // reciente que haya. Es la misma elección que hace la pantalla.
        const history = await listReadings(ctx.db, goal.id, 3);
        const closed = lastClosedPeriod(goal.cadence, today);
        const row = history.find((r) => r.period_start === closed.start) ?? history[0] ?? null;
        return toGoal(
          goal,
          row
            ? {
                periodLabel: periodContaining(goal.cadence, row.period_start).label,
                periodStart: row.period_start,
                periodEnd: row.period_end,
                display: row.display,
                value: row.value,
                status: row.status,
                statusLabel: STATUS_LABEL[row.status],
                // El objetivo de ESE período, sacado de la fila congelada: subir
                // la meta mañana no reescribe el veredicto de julio.
                judgedAgainst: describeTarget(row.direction, row.target_value, row.unit),
                method: row.method,
                sampleSize: row.sample_size,
                frozenAt: row.computed_at.slice(0, 10),
              }
            : null,
        );
      }),
    );

    const breached = goals.filter((g) => g.latest?.status === 'breached').length;
    const waiting = goals.filter((g) => g.latest === null).length;

    return {
      goals,
      breached,
      guidance: [
        goals.length === 0
          ? 'Esta empresa todavía no ha fijado ninguna meta. Con goals.offer_metrics se ve qué se puede medir aquí hoy, y con goals.set se fija.'
          : `${goals.length} meta(s) fijada(s)${breached > 0 ? `, ${breached} fuera de meta en el último período cerrado` : ''}.`,
        waiting > 0
          ? `${waiting} todavía no tiene(n) ningún período cerrado: la primera lectura se congela cuando cierre, y no se rellena hacia atrás.`
          : '',
        goals.length > 0
          ? 'Cada cifra es la del último período CERRADO y viene con el método con el que se calculó. Para lo que va del período en curso, goals.measure.'
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const goalsSet = registerTool({
  id: 'goals.set',
  description:
    'Fijar una meta: «la cartera no debe pasar de 45 días», «al menos el 95% de los vencimientos a tiempo». Es una declaración de la empresa y queda con el nombre de quien la fija. SE NIEGA si este espacio de trabajo no puede calcular esa métrica todavía, y dice qué falta — una meta sin datos que la alimenten es una casilla vacía, y una casilla vacía resta más confianza de la que suma. También se niega si ya hay una meta activa de esa métrica con esa periodicidad. El objetivo lo dice la persona: nunca lo inventes, y si no lo dijo, pregúntaselo. Requiere confirmación.',
  inputSchema: z.object({
    metricKey: z.enum(METRIC_KEYS).describe(`Del catálogo, y sólo del catálogo: ${CATALOG_LINE}`),
    cadence: z
      .enum(CADENCES)
      .describe('week = semanal, month = mensual. Es el período que se congela y se juzga.'),
    targetValue: z
      .number()
      .describe(
        'El número que la persona fijó. En porcentaje va de 0 a 100. La dirección (no pasar de / al menos) NO se recibe: la pone el catálogo.',
      ),
    label: z
      .string()
      .max(120)
      .nullish()
      .describe('Cómo la llama quien la fija. Vacío = la etiqueta de la métrica.'),
  }),
  outputSchema: z.object({
    goal: GoalSchema,
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Las tres negativas —métrica inexistente, espacio que no sabe medirla,
    // meta duplicada— las levanta `writeGoal` con su propia frase en español, y
    // esa frase es la que tiene que llegar. Ver la cabecera.
    const goal = await writeGoal(ctx.db, {
      metricKey: input.metricKey,
      label: input.label ?? null,
      cadence: input.cadence,
      targetValue: input.targetValue,
      createdBy: ctx.userId,
    });

    const [hydrated] = await hydrateGoals(ctx.db, [goal]);
    const view = toGoal(hydrated ?? goal, null);

    return {
      goal: view,
      guidance: [
        `Queda fijada: «${view.label}», ${view.cadenceLabel.toLowerCase()}, ${view.targetLabel}.`,
        `La cifra sale de ${view.sourceSystem ?? 'este espacio de trabajo'} y se congela sola al cerrar cada período;`,
        'si un período incumple, sale un aviso, y otro cuando se recupera.',
        'No se rellena hacia atrás: el histórico empieza en el primer período que cierre desde hoy.',
        'Para ver cómo va el período en curso desde ya, goals.measure.',
      ].join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

const MeasureReadingSchema = z.object({
  goalId: z.string(),
  label: z.string(),
  metricKey: z.string(),
  periodLabel: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  display: z.string(),
  value: z.number().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  targetLabel: z.string(),
  method: z.string(),
  sampleSize: z.number(),
});

export const goalsMeasure = registerTool({
  id: 'goals.measure',
  description:
    'La lectura EN VIVO del período en curso de una meta, o de todas. Contesta «¿cómo vamos este mes?» antes de que el mes cierre. NO es una predicción y NO se guarda en ninguna parte: es lo que va del período con la aritmética con la que se calculó, y cambia cada mañana — por eso no es la cifra que se cita. La que se cita es la del último período cerrado, y esa la da goals.list.',
  inputSchema: z.object({
    goalId: z
      .string()
      .uuid()
      .nullish()
      .describe('Una sola meta. Vacío = todas las metas activas de este espacio.'),
  }),
  outputSchema: z.object({
    readings: z.array(MeasureReadingSchema),
    /** Metas cuya métrica ya no está en el catálogo: no hay con qué medirlas. */
    unmeasurable: z.array(z.object({ goalId: z.string(), label: z.string(), reason: z.string() })),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const goals = input.goalId
      ? [await getGoal(ctx.db, input.goalId)].filter((g): g is GoalRow => g !== null)
      : await listGoals(ctx.db, { state: 'active', limit: 20 });

    if (input.goalId && goals.length === 0) {
      throw new Error(
        'Esa meta no existe en este espacio de trabajo. Mira las que hay con goals.list.',
      );
    }

    const today = bogotaToday();
    const readings: Array<z.infer<typeof MeasureReadingSchema>> = [];
    const unmeasurable: Array<{ goalId: string; label: string; reason: string }> = [];

    for (const goal of goals) {
      const spec = metricByKey(goal.metric_key);
      if (!spec) {
        unmeasurable.push({
          goalId: goal.id,
          label: goal.label,
          reason: `La métrica «${goal.metric_key}» ya no está en el catálogo, así que no hay con qué calcular esta meta. Su histórico se conserva.`,
        });
        continue;
      }
      const period = periodContaining(goal.cadence, today);
      const measured = await measureLive(ctx.db, goal, period, spec);
      readings.push({
        goalId: goal.id,
        label: goal.label,
        metricKey: goal.metric_key,
        periodLabel: period.label,
        periodStart: period.start,
        periodEnd: period.end,
        display: measured.display,
        value: measured.value,
        status: measured.status,
        statusLabel: STATUS_LABEL[measured.status],
        targetLabel: describeTarget(goal.direction, goal.target_value, goal.unit),
        method: measured.method,
        sampleSize: measured.sampleSize,
      });
    }

    return {
      readings,
      unmeasurable,
      guidance:
        readings.length === 0 && unmeasurable.length === 0
          ? 'No hay ninguna meta activa que medir. Con goals.offer_metrics se ve qué se puede medir aquí, y con goals.set se fija una.'
          : `Lectura EN VIVO del período en curso, sin guardar: ${readings.length} meta(s). Dilo como lo que es —«va por X en lo que va de ${readings[0]?.periodLabel ?? 'el período'}»— y no como el resultado del período, que todavía no cerró. Cada una trae en "method" cómo se hizo la cuenta.`,
    };
  },
});
