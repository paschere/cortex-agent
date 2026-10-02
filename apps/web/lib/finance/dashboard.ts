import 'server-only';

import { compareScenarios } from '@cortex/agent-tools/src/ledger/forecast-explain';
import {
  listRecurringDecisions,
  listScenarios,
  monthlyPnl,
  runForecast,
} from '@cortex/agent-tools/src/ledger/plans';
import { maskPayrollForecast } from '@cortex/agent-tools/src/ledger/privacy';
import { detectRecurring } from '@cortex/agent-tools/src/ledger/recurring';
import { describeScenario } from '@cortex/agent-tools/src/ledger/scenario';
import { listAccounts, loadLedger } from '@cortex/agent-tools/src/ledger/store';
import type { ForecastResult } from '@cortex/agent-tools/src/ledger/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type FinanceDashboard,
  type ForecastPanel,
  type PnlPanel,
  type RecurringDecision,
  buildCash,
  buildDue,
  counterpartyNames,
  defaultPnlFocus,
  maskPayroll,
  mergeRecurring,
  scenarioChip,
  settle,
} from './dashboard-shape';

/**
 * EL PANEL DE FINANZAS, LEÍDO.
 *
 * Seis lecturas independientes —saldos, libro, proyección, escenarios,
 * resultados del mes y decisiones sobre los gastos fijos— y cada una aislada:
 * la que falle deja su sección en «sin dato» y la página sigue. El cálculo
 * (proyección, P&G, escenarios) vive en `@cortex/agent-tools/ledger`; aquí
 * sólo se junta y se recorta para quien mira.
 *
 * La nómina: quien no administra la ve como un total confidencial. Se recorta
 * AQUÍ, en el servidor, para que el detalle por persona no viaje al navegador.
 */

export interface ReadFinanceDashboardInput {
  userId: string;
  isAdmin: boolean;
  /** Hoy, día de Bogotá (`YYYY-MM-DD`). */
  today: string;
  scenarioId?: string | null;
  includeEstimatedSales?: boolean;
  minimumCash?: number | null;
}

const PNL_MONTHS = 14;

export async function readFinanceDashboard(
  db: SupabaseClient,
  input: ReadFinanceDashboardInput,
): Promise<FinanceDashboard> {
  const { today, isAdmin } = input;
  const includeEstimatedSales = input.includeEstimatedSales ?? true;
  const minimumCash = input.minimumCash ?? null;

  const [accounts, ledger, run, scenarios, pnl, decisions] = await Promise.all([
    settle(() => listAccounts(db), 'No se pudieron leer las cuentas.'),
    settle(() => loadLedger(db, { today, historyDays: 400 }), 'No se pudo leer el libro.'),
    settle(
      () =>
        runForecast(db, {
          today,
          scenarioId: input.scenarioId ?? undefined,
          includeEstimatedSales,
          minimumCash: minimumCash ?? undefined,
        }),
      'No se pudo calcular la proyección.',
    ),
    settle(() => listScenarios(db), 'No se pudieron leer los escenarios.'),
    settle(
      () => monthlyPnl(db, { months: PNL_MONTHS, today, includePayroll: isAdmin }),
      'No se pudieron calcular los resultados del mes.',
    ),
    settle(() => listRecurringDecisions(db), 'No se pudieron leer los gastos fijos.'),
  ]);

  const currency = run.ok ? run.data.base.currency : 'COP';

  const cash = accounts.ok
    ? {
        ok: true as const,
        data: buildCash(
          accounts.data.map((a) => ({
            id: a.id,
            name: a.name,
            currency: a.currency,
            balance: Number(a.balance) || 0,
            balanceAt: a.balance_at,
            balanceSource: a.balance_source,
            sourceSystem: a.source_system,
          })),
          today,
          currency,
        ),
      }
    : accounts;

  const forecast = run.ok
    ? {
        ok: true as const,
        data: forecastPanel(run.data, { isAdmin, currency, minimumCash }),
      }
    : run;

  const due = ledger.ok
    ? { ok: true as const, data: buildDue(ledger.data.movements, today, { currency, isAdmin }) }
    : { ok: false as const, error: ledger.error };

  const recurring =
    ledger.ok && decisions.ok
      ? {
          ok: true as const,
          data: mergeRecurring(
            detectRecurring(ledger.data.movements, today),
            decisions.data as RecurringDecision[],
            { isAdmin },
          ),
        }
      : {
          ok: false as const,
          error: ledger.ok ? (decisions as { error: string }).error : ledger.error,
        };

  const pnlPanel = pnl.ok
    ? {
        ok: true as const,
        data: {
          currency,
          months: pnl.data,
          focus: defaultPnlFocus(today),
          payrollConfidential: !isAdmin,
        } satisfies PnlPanel,
      }
    : pnl;

  const chips = scenarios.ok
    ? {
        ok: true as const,
        data: scenarios.data.map((s) => scenarioChip(s, describeScenario(s, currency))),
      }
    : scenarios;

  // Vacía de verdad sólo si las dos lecturas contestaron y no hay nada.
  const empty =
    accounts.ok && ledger.ok && accounts.data.length === 0 && ledger.data.movements.length === 0;

  return {
    today,
    currency,
    isAdmin,
    includeEstimatedSales,
    activeScenarioId: forecast.ok && forecast.data.scenario ? (input.scenarioId ?? null) : null,
    minimumCash,
    empty,
    cash,
    forecast,
    scenarios: chips,
    pnl: pnlPanel,
    due,
    recurring,
    counterparties: ledger.ok ? counterpartyNames(ledger.data.movements) : [],
  };
}

function forecastPanel(
  run: Awaited<ReturnType<typeof runForecast>>,
  opts: { isAdmin: boolean; currency: string; minimumCash: number | null },
): ForecastPanel {
  // ledger/privacy quita los nombres (también de las alertas); maskPayroll funde
  // además las líneas en un total por semana, para que no se lea un salario.
  const hide = (r: ForecastResult) => maskPayroll(maskPayrollForecast(r));
  const base = opts.isAdmin ? run.base : hide(run.base);
  const scenario = run.scenario ? (opts.isAdmin ? run.scenario : hide(run.scenario)) : null;
  const comparison = run.comparison ?? (scenario ? compareScenarios(base, scenario) : null);
  return {
    currency: opts.currency,
    minimumCash: opts.minimumCash,
    base,
    scenario,
    comparison: comparison ? { summary: comparison.summary } : null,
  };
}
