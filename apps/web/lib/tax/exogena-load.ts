import {
  type ExogenaFormat,
  buildExogena,
  readTaxPurchases,
  readTaxReceivables,
  readTaxSales,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Los cuatro formatos de exógena de un año gravable, con los datos de la empresa (0197). */
export async function loadExogena(db: SupabaseClient, year: number): Promise<ExogenaFormat[]> {
  const [purchases, sales, receivables] = await Promise.all([
    // Tres años atrás: una factura de 2023 sin pagar al 31 de diciembre cuenta en 1009.
    readTaxPurchases(db, `${year - 3}-01-01`, `${year}-12-31`),
    readTaxSales(db, `${year}-01-01`, `${year}-12-31`),
    readTaxReceivables(db, `${year}-12-31`),
  ]);
  return buildExogena({ year, purchases: purchases.purchases, sales: sales.sales, receivables });
}
