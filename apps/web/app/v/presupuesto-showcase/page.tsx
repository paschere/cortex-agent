import { TODAY, fixtureHistory } from '@/app/v/estados-showcase/fixture';
import type { BudgetScenario } from '@/components/budget/types';
import {
  BUDGET_LIGHT_LABEL,
  BUDGET_STATUS_LABEL,
  type Budget,
  LEDGER_CATEGORIES,
  type ScenarioAdjustment,
  budgetCategoryLabel,
  budgetFromActuals,
  budgetVsActual,
  clientSalesForecast,
  forecastPnl,
  productDemandForecast,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { BudgetFixture } from './Showcase';

/**
 * PRESUPUESTO Y PRONÓSTICO CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * Parámetros: `?vista=editar|pronostico`, `?vacio=1` (sin presupuesto),
 * `?esc_ventas=-15`, `?esc_sin=Nexa Logística`, `?modo=oscuro`.
 */
export const dynamic = 'force-dynamic';

export default async function PresupuestoShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : '');
  const history = fixtureHistory();
  const empty = one('vacio') === '1';
  const cells = empty
    ? []
    : budgetFromActuals(history, { year: 2026, growthPct: 8, incomeGrowthPct: 12 });
  // Un sobrecosto para que el semáforo tenga rojo: el mercadeo de septiembre.
  const budget: Budget | null = empty
    ? null
    : {
        id: '00000000-0000-4000-8000-0000000000b1',
        year: 2026,
        version: 1,
        name: 'Presupuesto 2026',
        status: 'aprobado',
        basis: 'ultimo_anio',
        growthPct: 8,
        currency: 'COP',
        notes: null,
        createdBy: null,
        approvedAt: '2026-01-20T15:00:00Z',
        createdAt: '2026-01-15T15:00:00Z',
        updatedAt: '2026-01-20T15:00:00Z',
      };
  const tweaked = cells.map((c) =>
    c.category === 'mercadeo' ? { ...c, amount: Math.round(c.amount * 0.7) } : c,
  );
  const vs = budget ? budgetVsActual(tweaked, history, { year: 2026, today: TODAY }) : null;

  const clients = [
    'Nexa Logística',
    'Comercializadora del Valle',
    'Agroandes SAS',
    'Ferretería Central',
    'Distribuciones Norte',
  ];
  const invoices = clients.flatMap((name, k) =>
    Array.from({ length: 12 }, (_, i) => ({
      counterpartyName: name,
      date: `${i < 3 ? 2025 : 2026}-${String(i < 3 ? 10 + i : i - 2).padStart(2, '0')}-1${k}`,
      amount: k < 3 || i % 3 === 0 ? 45_000_000 - k * 8_000_000 : 0,
    })),
  );
  const clientF = clientSalesForecast(invoices, TODAY);
  const scenario: BudgetScenario = {
    ventasPct: one('esc_ventas') ? Number(one('esc_ventas')) : null,
    category: null,
    categoryPct: null,
    withoutClient: one('esc_sin') || null,
  };
  const adjustments: ScenarioAdjustment[] = [];
  if (scenario.ventasPct !== null)
    adjustments.push({
      kind: 'scale_category',
      category: 'ventas',
      factor: 1 + scenario.ventasPct / 100,
    });
  if (scenario.withoutClient)
    adjustments.push({ kind: 'drop_counterparty', counterpartyName: scenario.withoutClient });
  const pnl = forecastPnl({
    history,
    today: TODAY,
    recurring: [
      { label: 'Arriendo bodega', direction: 'out', category: 'arriendo', monthly: 9_500_000 },
    ],
    adjustments,
    clients: clientF.clients,
  });
  const demand = productDemandForecast(
    [
      { id: 'p1', name: 'Estiba de madera', unit: 'und', onHand: 140 },
      { id: 'p2', name: 'Película stretch', unit: 'rollo', onHand: 22 },
      { id: 'p3', name: 'Zuncho plástico', unit: 'rollo', onHand: 60 },
    ],
    ['p1', 'p2', 'p3'].flatMap((id, k) =>
      Array.from({ length: 6 }, (_, i) => ({
        productId: id,
        qty: [60, 14, 9][k] ?? 1,
        occurredOn: `2026-${String(4 + i).padStart(2, '0')}-10`,
      })),
    ),
    TODAY,
  );
  return (
    <BudgetFixture
      dark={one('modo') === 'oscuro'}
      year={2026}
      today={TODAY}
      tab={
        one('vista') === 'editar' ? 'editar' : one('vista') === 'pronostico' ? 'pronostico' : 'real'
      }
      budgets={budget ? [budget] : []}
      report={{ budget, cells: tweaked, vs, canEdit: true, payrollConfidential: false }}
      forecast={{ pnl, clients: clientF, demand, payrollConfidential: false, gaps: [] }}
      forecastError={null}
      categories={[...LEDGER_CATEGORIES].map((key) => ({ key, label: budgetCategoryLabel(key) }))}
      lightLabels={{ ...BUDGET_LIGHT_LABEL }}
      statusLabels={{ ...BUDGET_STATUS_LABEL }}
      scenario={scenario}
      hasLastYear
      links={{
        self: '/v/presupuesto-showcase',
        statements: '/v/estados-showcase',
        board: '/v/informe-socios-showcase',
        finance: '#',
      }}
    />
  );
}
