import {
  type FinanceDashboard,
  type PnlMonth,
  type RecurringDecision,
  accountsFromCash,
  buildCash,
  buildDue,
  counterpartyNames,
  defaultPnlFocus,
  maskPayroll,
  mergeRecurring,
  scenarioChip,
  shiftMonth,
} from '@/lib/finance/dashboard-shape';
import { forecast } from '@cortex/agent-tools/src/ledger/forecast';
import { compareScenarios } from '@cortex/agent-tools/src/ledger/forecast-explain';
import { AS_OF, company } from '@cortex/agent-tools/src/ledger/forecast.fixtures';
import { maskPayrollForecast } from '@cortex/agent-tools/src/ledger/privacy';
import { detectRecurring } from '@cortex/agent-tools/src/ledger/recurring';
import { describeScenario } from '@cortex/agent-tools/src/ledger/scenario';
import type {
  ForecastResult,
  LedgerMovement,
  Scenario,
} from '@cortex/agent-tools/src/ledger/types';

/**
 * EL PANEL DE FINANZAS CON DATOS INVENTADOS: Transportes del Valle S.A.S., la
 * empresa de prueba de la proyección (`forecast.fixtures.ts`), pasada por el
 * motor de verdad. Sólo para el escaparate de desarrollo.
 */

const SCENARIOS: Scenario[] = [
  {
    id: 'esc-nexa',
    label: 'Nexa se atrasa',
    adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }],
  },
  {
    id: 'esc-conductor',
    label: 'Contrato dos conductores',
    adjustments: [
      {
        kind: 'add_recurring',
        label: 'Dos conductores',
        direction: 'out',
        amount: 5_800_000,
        every: 'month',
        start: '2026-10-30',
      },
      { kind: 'scale_category', category: 'transporte', factor: 1.15 },
    ],
  },
];

/** Resultados por mes desde el libro de prueba (el P&G de verdad lo calcula ledger/plans). */
function fixturePnl(movements: LedgerMovement[], today: string, months: number): PnlMonth[] {
  const last = today.slice(0, 7);
  const out = new Map<string, PnlMonth>();
  for (let i = months - 1; i >= 0; i--) {
    const m = shiftMonth(last, -i);
    out.set(m, { month: m, sales: 0, otherIncome: 0, expenses: 0, byCategory: {}, margin: 0 });
  }
  for (const mv of movements) {
    if (mv.status !== 'settled' || mv.kind === 'transfer') continue;
    const day = (mv.settledAt ?? mv.date).slice(0, 7);
    const bucket = out.get(day);
    if (!bucket) continue;
    if (mv.direction === 'in') {
      if ((mv.category ?? 'ventas') === 'ventas') bucket.sales += mv.amount;
      else bucket.otherIncome += mv.amount;
    } else {
      bucket.expenses += mv.amount;
      const key = mv.category ?? 'sin_categoria';
      bucket.byCategory[key] = (bucket.byCategory[key] ?? 0) + mv.amount;
    }
  }
  return [...out.values()].map((b) => ({ ...b, margin: b.sales + b.otherIncome - b.expenses }));
}

export function fixtureDashboard(opts: {
  isAdmin: boolean;
  empty: boolean;
  failing: boolean;
  scenarioId: string | null;
  includeEstimatedSales: boolean;
  minimumCash: number | null;
}): FinanceDashboard {
  const { accounts, movements } = company();
  const today = AS_OF;
  const minimumCash = opts.minimumCash ?? 20_000_000;
  const scenario = SCENARIOS.find((s) => s.id === opts.scenarioId) ?? null;
  const detected = detectRecurring(movements, today);
  const arriendo = detected.find((f) => f.category === 'arriendo');
  const terpel = detected.find((f) => f.counterpartyName === 'Terpel');
  const input = {
    asOf: today,
    currency: 'COP',
    accounts,
    movements,
    minimumCash,
    includeEstimatedSales: opts.includeEstimatedSales,
    ignoredRecurring: terpel?.detectedKey ? [terpel.detectedKey] : [],
    confirmedRecurring: arriendo?.detectedKey ? [arriendo.detectedKey] : [],
  };
  const rawBase = forecast(input);
  const rawScenario = scenario ? forecast({ ...input, scenario }) : null;
  const hide = (r: ForecastResult) => maskPayroll(maskPayrollForecast(r));
  const base = opts.isAdmin ? rawBase : hide(rawBase);
  const scen = rawScenario ? (opts.isAdmin ? rawScenario : hide(rawScenario)) : null;

  const decisions: RecurringDecision[] = [
    ...(arriendo ? [{ ...arriendo, status: 'confirmed' as const }] : []),
    {
      id: 'decl-contador',
      label: 'Contador externo',
      direction: 'out',
      amount: 1_800_000,
      currency: 'COP',
      every: 'month',
      anchor: 10,
      category: 'honorarios',
      origin: 'declared',
      status: 'declared',
      detectedKey: null,
    },
  ];
  if (terpel) decisions.push({ ...terpel, status: 'ignored' });

  const fail = (error: string) => ({ ok: false as const, error });
  return {
    today,
    currency: 'COP',
    isAdmin: opts.isAdmin,
    includeEstimatedSales: opts.includeEstimatedSales,
    activeScenarioId: scenario?.id ?? null,
    minimumCash,
    companyMinimumCash: null,
    canSaveMinimum: opts.isAdmin,
    empty: opts.empty,
    cash: { ok: true, data: buildCash(accountsFromCash(accounts), today, 'COP') },
    forecast: {
      ok: true,
      data: {
        currency: 'COP',
        minimumCash,
        base,
        scenario: scen,
        comparison: scen ? { summary: compareScenarios(base, scen).summary } : null,
      },
    },
    scenarios: {
      ok: true,
      data: SCENARIOS.map((s) => scenarioChip(s, describeScenario(s, 'COP'))),
    },
    pnl: opts.failing
      ? fail('No se pudieron calcular los resultados del mes.')
      : {
          ok: true,
          data: {
            currency: 'COP',
            months: fixturePnl(movements, today, 14),
            focus: defaultPnlFocus(today),
            payrollConfidential: !opts.isAdmin,
          },
        },
    due: opts.failing
      ? fail('No se pudo leer el libro.')
      : { ok: true, data: buildDue(movements, today, { currency: 'COP', isAdmin: opts.isAdmin }) },
    recurring: { ok: true, data: mergeRecurring(detected, decisions, { isAdmin: opts.isAdmin }) },
    counterparties: counterpartyNames(movements),
  };
}
