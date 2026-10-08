import {
  type NormalizedPayrollJournal,
  type SiigoJournal,
  normalizeSiigoPayrollJournal,
} from './payroll';
import type { SiigoClient } from './providers/siigo-client';
import { hasMorePages } from './providers/siigo-client';

/**
 * LA PÁGINA DE NÓMINA DE SIIGO (lo que `ProviderSession.listPayroll` llama).
 *
 *   GET /v1/journals?date_start=AAAA-MM-DD&page=N&page_size=100
 *
 * Es el listado de comprobantes contables (el SDK oficial lo documenta como
 * `getJournals`: filtros `date_start`, `date_end`, `created_start`,
 * `updated_start`, y cada comprobante con `items[].account.code|movement`,
 * `items[].customer.identification` y `items[].value`). Se leen TODOS los
 * comprobantes del rango y sólo se conservan los de nómina (payroll.ts): la API
 * no deja filtrar por cuenta.
 */

export interface PayrollPage {
  journals: NormalizedPayrollJournal[];
  hasMore: boolean;
  /** Comprobantes revisados en la página (de nómina o no). */
  seen: number;
}

export async function siigoPayrollPage(
  client: Pick<SiigoClient, 'page'>,
  since: string,
  page: number,
): Promise<PayrollPage> {
  const result = await client.page<SiigoJournal>(
    '/v1/journals',
    since ? { date_start: since } : {},
    page,
  );
  const journals = result.results
    .map((j) => normalizeSiigoPayrollJournal(j))
    .filter((j): j is NormalizedPayrollJournal => j !== null);
  return { journals, hasMore: hasMorePages(result), seen: result.results.length };
}
