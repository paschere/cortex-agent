import type { SupabaseClient } from '@supabase/supabase-js';
import { loadInventoryOverview } from '../inventory/products';
import { listRecurringDecisions, monthlyPnl } from '../ledger/plans';
import { canSeePayrollDetail } from '../ledger/privacy';
import { addDays, num } from '../ledger/shape';
import { listMovements } from '../ledger/store';
import type { ScenarioAdjustment } from '../ledger/types';
import {
  type ClientsForecast,
  type ProductDemand,
  clientSalesForecast,
  productDemandForecast,
} from './demand';
import { type PnlForecast, type RecurringHint, forecastPnl } from './pnl';

/**
 * LO QUE EL PRONÓSTICO LEE (0191): 24 meses del libro, los recurrentes
 * declarados o confirmados, las facturas de venta de 12 meses (por cliente) y,
 * si el inventario existe, las salidas de 12 meses por producto. Cada lectura
 * aparte; lo que falta queda en `gaps`.
 */

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

export interface ForecastBundle {
  pnl: PnlForecast;
  clients: ClientsForecast | null;
  demand: ProductDemand[] | null;
  payrollConfidential: boolean;
  gaps: string[];
}

export async function loadForecast(
  db: SupabaseClient,
  opts: {
    today: string;
    viewerId: string | null;
    horizon?: number;
    adjustments?: ScenarioAdjustment[];
    withDemand?: boolean;
  },
): Promise<ForecastBundle> {
  const gaps: string[] = [];
  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (!isMissingTable(err)) gaps.push(label);
      return null;
    }
  };
  const admin = await canSeePayrollDetail(db, opts.viewerId);
  const since = addDays(opts.today, -400);
  const [history, decisions, invoices, inventory, outflows] = await Promise.all([
    monthlyPnl(db, { months: 25, today: opts.today, includePayroll: admin }),
    attempt('los gastos que se repiten', () => listRecurringDecisions(db)),
    attempt('las facturas de venta', async () => {
      const { rows } = await listMovements(db, {
        from: since,
        kinds: ['receivable'],
        currency: 'COP',
      });
      return rows.map((r) => ({
        counterpartyName: r.counterparty_name,
        date: r.date,
        amount: num(r.amount) ?? 0,
      }));
    }),
    opts.withDemand === false
      ? Promise.resolve(null)
      : attempt('el inventario', () => loadInventoryOverview(db, { today: opts.today })),
    opts.withDemand === false
      ? Promise.resolve(null)
      : attempt('las salidas del inventario', async () => {
          const { data, error } = await db
            .from('stock_movements')
            .select('product_id, qty, occurred_on')
            .eq('kind', 'salida')
            .gte('occurred_on', addDays(opts.today, -400))
            .limit(20_000);
          if (error) throw error;
          return (
            (data ?? []) as Array<{ product_id: string; qty: number | string; occurred_on: string }>
          ).map((r) => ({
            productId: r.product_id,
            qty: Math.abs(num(r.qty) ?? 0),
            occurredOn: r.occurred_on,
          }));
        }),
  ]);
  const recurring: RecurringHint[] = (decisions ?? [])
    .filter((d) => (d.status === 'declared' || d.status === 'confirmed') && d.currency === 'COP')
    .map((d) => ({
      label: d.label,
      direction: d.direction,
      category: d.category ?? null,
      monthly: d.every === 'week' ? (d.amount * 52) / 12 : d.amount,
    }));
  const clients = invoices ? clientSalesForecast(invoices, opts.today) : null;
  const pnl = forecastPnl({
    history,
    today: opts.today,
    horizon: opts.horizon ?? 12,
    recurring,
    adjustments: opts.adjustments,
    clients: clients?.clients ?? [],
  });
  if (clients && clients.count > 0) {
    const share =
      pnl.months[0] && pnl.months[0].sales > 0
        ? clients.recurringMonthly / pnl.months[0].sales
        : null;
    pnl.assumptions.push(
      `De las ventas, ${clients.clients.filter((c) => c.recurring).length} clientes facturan casi todos los meses (4 o más de los últimos 6)${share !== null ? `: suman alrededor del ${Math.round(Math.min(share, 9.99) * 100)} % de lo que se espera vender el próximo mes` : ''}.`,
    );
  }
  const demand =
    inventory && outflows
      ? productDemandForecast(
          inventory.products
            .filter((p) => p.trackStock && p.active)
            .map((p) => ({ id: p.id, name: p.name, unit: p.unit, onHand: p.onHand ?? 0 })),
          outflows,
          opts.today,
        )
      : null;
  return { pnl, clients, demand, payrollConfidential: !admin, gaps };
}
