import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import { forecast } from './forecast';
import { cashRunwayWeeks, compareScenarios, explainWeek } from './forecast-explain';
import { formatDay, formatMoney, weekdayName } from './forecast-shared';
import {
  buildForecastInput,
  decideDetectedRecurring,
  declareRecurring,
  saveScenario,
} from './plans';
import {
  PAYROLL_CONFIDENTIAL_LABEL,
  canSeePayrollDetail,
  isPayrollCategory,
  maskPayrollForecast,
} from './privacy';
import { detectRecurring } from './recurring';
import { describeScenario } from './scenario';
import { syncLedger } from './sync';
import { type ForecastResult, LEDGER_CATEGORIES, type Scenario } from './types';

/**
 * LA CAJA DE LAS PRÓXIMAS SEMANAS, EN EL CHAT (migraciones 0172 y 0173).
 *
 *   ledger.forecast          «¿cómo va a estar la caja?», «¿me alcanza para la
 *                            nómina de diciembre?», «¿y si Nexa paga tarde?»,
 *                            «¿y si contrato 2 personas?»: la proyección de 13
 *                            semanas, la semana más apretada, las alertas y,
 *                            con un escenario, la comparación contra la base.
 *   ledger.explain_week      «¿por qué la semana del 17 queda tan apretada?».
 *   ledger.save_scenario     guardar un escenario para volver a él.
 *   ledger.declare_recurring «pagamos el crédito, 2 M el 28 de cada mes».
 *   ledger.decide_recurring  confirmar o ignorar algo que el motor detectó.
 *
 * Las de lectura no escriben nada; las otras piden confirmación. La nómina
 * sale con nombres sólo para quien administra la empresa (privacy.ts).
 */

const CURRENCY = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .default('COP')
  .describe('Tres letras. Por defecto COP; la proyección es de una sola moneda.');
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ADJUSTMENT = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delay_counterparty'),
    counterpartyName: z
      .string()
      .min(1)
      .max(200)
      .describe('El cliente o proveedor, como lo dijo la persona: «Nexa».'),
    days: z
      .number()
      .int()
      .min(-365)
      .max(365)
      .describe('Cuántos días más tarde paga (negativo: más temprano). «Un mes» = 30.'),
  }),
  z.object({
    kind: z.literal('drop_counterparty'),
    counterpartyName: z.string().min(1).max(200).describe('«¿Y si perdemos a Nexa?».'),
  }),
  z.object({
    kind: z.literal('add_recurring'),
    label: z.string().min(1).max(120).describe('«Dos personas nuevas», «Arriendo bodega 2».'),
    direction: z.enum(['in', 'out']),
    amount: z
      .number()
      .positive()
      .describe(
        'Cuánto cada vez, en la moneda. Para contratar gente, el costo total mensual (salario más prestaciones, ~1,5 veces el salario si la persona no lo dice).',
      ),
    every: z.enum(['week', 'month']),
    start: DAY.describe('Desde qué día; el día del mes (o de la semana) en que se repite.'),
  }),
  z.object({
    kind: z.literal('scale_category'),
    category: z
      .string()
      .min(1)
      .max(40)
      .describe(`Una de: ${LEDGER_CATEGORIES.join(', ')}.`),
    factor: z.number().min(0).max(100).describe('1,1 = sube 10%; 0,8 = baja 20%; 0 = desaparece.'),
  }),
  z.object({
    kind: z.literal('one_off'),
    label: z.string().min(1).max(120),
    direction: z.enum(['in', 'out']),
    amount: z.number().positive(),
    date: DAY,
  }),
]);

const SCENARIO_INPUT = {
  scenarioId: z
    .string()
    .uuid()
    .nullish()
    .describe('Un escenario guardado (ledger.save_scenario) para comparar contra la base.'),
  adjustments: z
    .array(ADJUSTMENT)
    .max(20)
    .nullish()
    .describe(
      'Un escenario armado ahora, sin guardarlo: «¿y si Nexa paga un mes tarde?» = [{kind: delay_counterparty, counterpartyName: Nexa, days: 30}]. Manda sobre scenarioId.',
    ),
  scenarioLabel: z.string().max(80).nullish().describe('Cómo llamar el escenario armado ahora.'),
};

async function freshLedger(ctx: ToolContext, today: string) {
  // Lo nuevo de las fuentes, sin modelo y como mucho cada 15 minutos.
  try {
    await syncLedger(ctx.db, ctx.organizationId, {
      today,
      classifier: null,
      minIntervalMinutes: 15,
      deadline: Date.now() + 15_000,
    });
  } catch (err) {
    ctx.logger.warn({ err }, 'ledger sync before forecast failed');
  }
}

function inlineScenario(input: {
  adjustments?: z.infer<typeof ADJUSTMENT>[] | null;
  scenarioLabel?: string | null;
}): Scenario | null {
  if (!input.adjustments?.length) return null;
  return {
    id: 'en-el-chat',
    label: input.scenarioLabel?.trim() || 'Escenario',
    adjustments: input.adjustments,
  };
}

interface Run {
  base: ForecastResult;
  scenario: ForecastResult | null;
  detected: ReturnType<typeof detectRecurring>;
  admin: boolean;
}

async function run(
  ctx: ToolContext,
  input: {
    currency?: string;
    scenarioId?: string | null;
    adjustments?: z.infer<typeof ADJUSTMENT>[] | null;
    scenarioLabel?: string | null;
    includeEstimatedSales?: boolean;
    minimumCash?: number | null;
  },
): Promise<Run> {
  const today = bogotaToday();
  await freshLedger(ctx, today);
  const [built, admin] = await Promise.all([
    buildForecastInput(ctx.db, {
      today,
      currency: input.currency ?? 'COP',
      scenarioId: input.scenarioId ?? null,
      scenario: inlineScenario(input),
      includeEstimatedSales: input.includeEstimatedSales ?? true,
      minimumCash: input.minimumCash ?? null,
    }),
    canSeePayrollDetail(ctx.db, ctx.userId),
  ]);
  const base = forecast({ ...built, scenario: null });
  const scenario = built.scenario ? forecast(built) : null;
  const mask = (r: ForecastResult) => (admin ? r : maskPayrollForecast(r));
  return {
    base: mask(base),
    scenario: scenario ? mask(scenario) : null,
    detected: detectRecurring(built.movements, today).filter((f) => f.currency === built.currency),
    admin,
  };
}

const fm = (n: number, currency: string) => formatMoney(n, currency);

function weeksTable(r: ForecastResult) {
  return r.weeks.map((w) => ({
    semana: w.start,
    abre: w.opening,
    entra: w.inflows,
    sale: w.outflows,
    cierra: w.closing,
  }));
}

function runwayText(r: ForecastResult): string {
  const weeks = cashRunwayWeeks(r);
  const floor =
    r.minimumCash && r.minimumCash > 0
      ? `la caja mínima (${fm(r.minimumCash, r.currency)})`
      : 'cero';
  if (weeks === null) return `En las ${r.weeks.length} semanas la caja no baja de ${floor}.`;
  if (weeks === 0) return `Ya esta semana la caja queda por debajo de ${floor}.`;
  return `La caja aguanta ${weeks} ${weeks === 1 ? 'semana' : 'semanas'} antes de bajar de ${floor}.`;
}

// ---------------------------------------------------------------------------

const WEEK_ROW = z.object({
  semana: z.string(),
  abre: z.number(),
  entra: z.number(),
  sale: z.number(),
  cierra: z.number(),
});
const ALERT_ROW = z.object({
  severity: z.enum(['info', 'warn', 'critical']),
  week: z.string().nullable(),
  message: z.string(),
});

export const ledgerForecast = registerTool({
  id: 'ledger.forecast',
  description:
    '¿Y si un cliente nos paga tarde? ¿Y si perdemos un cliente o contratamos a alguien? ¿Me alcanza la plata para la nómina? Proyecta la caja semana a semana (13 semanas) con los cobros y pagos pendientes y lo que se repite, y simula escenarios de qué pasaría si: un cliente paga un mes tarde, se va un cliente, entra un gasto nuevo. Dice la semana más apretada y cuántas semanas alcanza la caja. Sólo lectura.',
  inputSchema: z.object({
    ...SCENARIO_INPUT,
    includeEstimatedSales: z
      .boolean()
      .default(true)
      .describe(
        'Contar las ventas aún no facturadas de los clientes que facturan casi todos los meses.',
      ),
    minimumCash: z
      .number()
      .min(0)
      .nullish()
      .describe(
        'La caja mínima con la que la persona está tranquila. Por defecto, un mes de gastos fijos.',
      ),
    currency: CURRENCY,
  }),
  outputSchema: z.object({
    currency: z.string(),
    startingCash: z.number(),
    lowest: z.object({ week: z.string(), closing: z.number() }),
    runwayWeeks: z.number().nullable(),
    minimumCash: z.number(),
    weeks: z.array(WEEK_ROW),
    alerts: z.array(ALERT_ROW),
    explanation: z.array(z.string()),
    assumptions: z.array(z.string()),
    recurring: z.array(
      z.object({
        key: z.string().nullable(),
        label: z.string(),
        sentido: z.enum(['entra', 'sale']),
        valor: z.number(),
        cada: z.string(),
      }),
    ),
    scenario: z
      .object({
        label: z.string(),
        description: z.string(),
        lowest: z.object({ week: z.string(), closing: z.number() }),
        runwayWeeks: z.number().nullable(),
        weeks: z.array(WEEK_ROW),
        alerts: z.array(ALERT_ROW),
        comparison: z.string(),
        notes: z.array(z.string()),
      })
      .nullable(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const r = await run(ctx, input);
    const { base } = r;
    const cur = base.currency;
    const lowestWhy = explainWeek(base, base.lowest.week).summary;
    const explanation = [
      `Caja hoy: ${fm(base.startingCash, cur)}. La semana más apretada es la del ${formatDay(base.lowest.week)}, que cierra con ${fm(base.lowest.closing, cur)}.`,
      runwayText(base),
      lowestWhy,
    ];
    let scenario = null;
    if (r.scenario) {
      const cmp = compareScenarios(base, r.scenario);
      explanation.push(cmp.summary);
      const describeLine = describeScenario(r.scenario.scenario ?? null, cur);
      const describedIndex = r.scenario.assumptions.indexOf(describeLine);
      scenario = {
        label: r.scenario.scenario?.label ?? 'Escenario',
        description: describeLine,
        lowest: r.scenario.lowest,
        runwayWeeks: cashRunwayWeeks(r.scenario),
        weeks: weeksTable(r.scenario),
        alerts: r.scenario.alerts.map((a) => ({
          severity: a.severity,
          week: a.week ?? null,
          message: a.message,
        })),
        comparison: cmp.summary,
        notes: describedIndex >= 0 ? r.scenario.assumptions.slice(describedIndex + 1) : [],
      };
    }
    const recurring = r.detected.slice(0, 20).map((f) => {
      const hidden = !r.admin && isPayrollCategory(f.category);
      return {
        key: f.detectedKey ?? null,
        label: hidden ? PAYROLL_CONFIDENTIAL_LABEL : f.label,
        sentido: f.direction === 'in' ? ('entra' as const) : ('sale' as const),
        valor: f.amount,
        cada:
          f.every === 'month'
            ? `cada mes, hacia el día ${f.anchor}`
            : `cada ${weekdayName(f.anchor)}`,
      };
    });
    const nothing = (base.accountCount ?? 0) === 0 && base.weeks.every((w) => w.items.length === 0);
    return {
      currency: cur,
      startingCash: base.startingCash,
      lowest: base.lowest,
      runwayWeeks: cashRunwayWeeks(base),
      minimumCash: base.minimumCash ?? 0,
      weeks: weeksTable(base),
      alerts: base.alerts.map((a) => ({
        severity: a.severity,
        week: a.week ?? null,
        message: a.message,
      })),
      explanation,
      assumptions: base.assumptions,
      recurring,
      scenario,
      guidance: nothing
        ? 'No hay datos en el libro de plata para proyectar: ni saldos de cuentas ni cobros o pagos esperados. Importa un extracto del banco, conecta el programa contable o dime el saldo de hoy (ledger.set_balance).'
        : [
            'Contesta con la semana más apretada, cuántas semanas aguanta la caja y la alerta más importante, en pocas frases; nombra los supuestos que más pesan.',
            r.scenario ? 'Con escenario: di primero la comparación contra la base.' : '',
            r.admin ? '' : 'La nómina va como total confidencial: no intentes nombrar personas.',
          ]
            .filter(Boolean)
            .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const ledgerExplainWeek = registerTool({
  id: 'ledger.explain_week',
  description:
    'Explicar una semana de la proyección de caja: con cuánto abre, qué entra y qué sale (lo que más pesa primero, cada línea con su razón: «vence el 3 nov; Nexa suele pagar 12 días tarde») y con cuánto cierra. Úsala para «¿por qué la semana del 17 queda tan apretada?», «¿qué sale la semana de la prima?». Acepta el mismo escenario que ledger.forecast. Sólo lectura.',
  inputSchema: z.object({
    week: DAY.describe('Cualquier día de la semana que se quiere ver (AAAA-MM-DD).'),
    ...SCENARIO_INPUT,
    currency: CURRENCY,
  }),
  outputSchema: z.object({
    weekStart: z.string(),
    summary: z.string(),
    opening: z.number().nullable(),
    inflows: z.number().nullable(),
    outflows: z.number().nullable(),
    closing: z.number().nullable(),
    items: z.array(
      z.object({
        label: z.string(),
        sentido: z.enum(['entra', 'sale']),
        valor: z.number(),
        esperado: z.number(),
        probabilidad: z.number(),
        fecha: z.string(),
        razon: z.string(),
        origen: z.string(),
      }),
    ),
    scenario: z.string().nullable(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const r = await run(ctx, input);
    const target = r.scenario ?? r.base;
    const e = explainWeek(target, input.week);
    return {
      weekStart: e.weekStart,
      summary: e.summary,
      opening: e.week?.opening ?? null,
      inflows: e.week?.inflows ?? null,
      outflows: e.week?.outflows ?? null,
      closing: e.week?.closing ?? null,
      items: e.items.slice(0, 15).map((i) => ({
        label: i.label,
        sentido: i.direction === 'in' ? ('entra' as const) : ('sale' as const),
        valor: i.amount,
        esperado: i.expectedAmount,
        probabilidad: i.probability,
        fecha: i.expectedDate,
        razon: i.reason,
        origen:
          i.from === 'estimate'
            ? 'venta estimada'
            : i.from === 'recurring'
              ? 'se repite'
              : i.from === 'scenario'
                ? 'escenario'
                : 'libro',
      })),
      scenario: r.scenario
        ? describeScenario(r.scenario.scenario ?? null, r.scenario.currency)
        : null,
    };
  },
});

// ---------------------------------------------------------------------------

export const ledgerSaveScenario = registerTool({
  id: 'ledger.save_scenario',
  description:
    'Guardar un escenario de caja con nombre para volver a él y verlo en Finanzas: «guarda “Nexa se atrasa” con Nexa pagando 30 días tarde», «guarda el escenario de contratar dos personas». Guardar otra vez el mismo nombre lo reemplaza. No cambia el libro ni la proyección base. Requiere confirmación.',
  inputSchema: z.object({
    id: z.string().uuid().nullish().describe('Para cambiar un escenario guardado.'),
    label: z.string().min(1).max(80).describe('El nombre: «Nexa se atrasa».'),
    adjustments: z.array(ADJUSTMENT).min(1).max(20),
  }),
  outputSchema: z.object({
    scenarioId: z.string(),
    label: z.string(),
    adjustments: z.number(),
    comparison: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const saved = await saveScenario(ctx.db, {
      id: input.id ?? undefined,
      label: input.label,
      adjustments: input.adjustments,
      userId: ctx.userId,
    });
    let comparison: string | null = null;
    try {
      const today = bogotaToday();
      const built = await buildForecastInput(ctx.db, { today, scenario: saved });
      comparison = compareScenarios(
        forecast({ ...built, scenario: null }),
        forecast(built),
      ).summary;
    } catch (err) {
      ctx.logger.warn({ err }, 'scenario comparison after save failed');
    }
    return {
      scenarioId: saved.id,
      label: saved.label,
      adjustments: saved.adjustments.length,
      comparison,
      guidance: [`Guardé el escenario «${saved.label}».`, describeScenario(saved), comparison ?? '']
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const ledgerDeclareRecurring = registerTool({
  id: 'ledger.declare_recurring',
  description:
    'Anotar algo que se repite y que la proyección de caja debe contar: «pagamos el crédito de Bancolombia, 2 M el 28 de cada mes», «cada viernes sale 1,5 M de combustible». Lo que pasa una sola vez (la prima de diciembre, un impuesto anual) no va aquí: va como escenario one_off en ledger.forecast. Se suma a lo que Cortex detecta del historial; si habla de lo mismo que algo detectado (misma contraparte o categoría, día parecido, o su key de ledger.forecast), lo reemplaza. Requiere confirmación.',
  inputSchema: z.object({
    label: z.string().min(1).max(120).describe('Qué es: «Cuota crédito Bancolombia».'),
    direction: z.enum(['in', 'out']).describe('in: entra. out: sale.'),
    amount: z.number().positive().describe('Cuánto cada vez, en la moneda.'),
    currency: CURRENCY,
    every: z.enum(['week', 'month']),
    anchor: z
      .number()
      .int()
      .min(1)
      .max(31)
      .describe(
        'Mensual: el día del mes (1–31). Semanal: el día de la semana (1 lunes … 7 domingo).',
      ),
    category: z
      .string()
      .max(40)
      .nullish()
      .describe(`Una de: ${LEDGER_CATEGORIES.join(', ')}.`),
    counterpartyName: z.string().max(200).nullish().describe('A quién se le paga o quién paga.'),
    detectedKey: z
      .string()
      .max(80)
      .nullish()
      .describe('La key de un recurrente detectado (ledger.forecast) que esto corrige.'),
  }),
  outputSchema: z.object({ recurringId: z.string(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const flow = await declareRecurring(ctx.db, {
      label: input.label,
      direction: input.direction,
      amount: input.amount,
      currency: input.currency ?? 'COP',
      every: input.every,
      anchor: input.anchor,
      category: input.category ?? null,
      counterpartyName: input.counterpartyName ?? null,
      detectedKey: input.detectedKey ?? null,
      userId: ctx.userId,
    });
    const when =
      flow.every === 'month'
        ? `cada mes, el día ${flow.anchor}`
        : `cada ${weekdayName(flow.anchor)}`;
    return {
      recurringId: flow.id,
      guidance: `Listo: «${flow.label}», ${flow.direction === 'out' ? 'sale' : 'entra'} ${formatMoney(flow.amount, flow.currency)} ${when}. La proyección de caja ya lo cuenta${flow.detectedKey ? ' en lugar de lo que había detectado' : ''}.`,
    };
  },
});

// ---------------------------------------------------------------------------

export const ledgerDecideRecurring = registerTool({
  id: 'ledger.decide_recurring',
  description:
    'Confirmar o ignorar algo que Cortex detectó que se repite en el historial (aparece en ledger.forecast con su key): «sí, el arriendo es fijo» (confirmed), «eso de Homecenter fue de una vez, no lo cuentes» (ignored). Lo ignorado deja de entrar en la proyección de caja. Requiere confirmación.',
  inputSchema: z.object({
    detectedKey: z.string().min(1).max(80).describe('La key que dio ledger.forecast.'),
    decision: z.enum(['confirmed', 'ignored']),
  }),
  outputSchema: z.object({
    detectedKey: z.string(),
    status: z.enum(['confirmed', 'ignored']),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await decideDetectedRecurring(ctx.db, {
      detectedKey: input.detectedKey,
      status: input.decision,
      userId: ctx.userId,
      today: bogotaToday(),
    });
    return {
      detectedKey: input.detectedKey,
      status: input.decision,
      guidance:
        input.decision === 'ignored'
          ? 'Listo: eso ya no entra en la proyección de caja. Si vuelve a repetirse, dímelo y lo confirmo.'
          : 'Listo: quedó confirmado como algo que se repite.',
    };
  },
});
