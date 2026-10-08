import { ProviderUncertainError, ProviderValidationError } from '../types';
import {
  type ProviderBalance,
  type ProviderPnl,
  type ProviderReports,
  balanceFromTrialBalance,
  pnlFromTrialBalance,
  trialBalanceFromRows,
  xlsxRows,
} from './reports';
import type { SiigoClient } from './siigo-client';

/**
 * LOS ESTADOS FINANCIEROS DE SIIGO (0191).
 *
 * Siigo Nube no expone un balance general ni un estado de resultados por API:
 * expone el BALANCE DE PRUEBA GENERAL (POST /v1/test-balance-report, ver
 * siigoapi.docs.apiary.io › Reportes) para un año y un rango de meses (1 a
 * 13; el 13 es el de cierre). Devuelve `{ file_id, file_url }` y el archivo es
 * un Excel en el almacenamiento de Siigo; se descarga una vez y se lee aquí.
 *
 * Del balance de prueba salen los dos estados con las clases del PUC
 * (reports.ts). Es una LECTURA: no escribe nada en Siigo.
 */

/** Sólo se descarga de donde Siigo deja sus reportes: nunca de una URL cualquiera. */
export function isSiigoReportUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      (url.hostname.endsWith('.blob.core.windows.net') ||
        url.hostname === 'siigo.com' ||
        url.hostname.endsWith('.siigo.com'))
    );
  } catch {
    return false;
  }
}

async function trialBalance(
  client: SiigoClient,
  doFetch: typeof fetch,
  year: number,
  monthStart: number,
  monthEnd: number,
) {
  let out: { file_url?: string } | null;
  try {
    out = await client.post<{ file_url?: string } | null>('/v1/test-balance-report', {
      year,
      month_start: monthStart,
      month_end: monthEnd,
      includes_tax_difference: false,
    });
  } catch (err) {
    if (err instanceof ProviderUncertainError || err instanceof ProviderValidationError)
      throw new Error(
        `Siigo no entregó el balance de prueba de ${year} (${err.message.split('.')[0]}). Inténtalo en unos minutos.`,
      );
    throw err;
  }
  const url = out?.file_url ?? '';
  if (!isSiigoReportUrl(url))
    throw new Error(
      'Siigo no devolvió el enlace del balance de prueba. Inténtalo en unos minutos.',
    );
  const res = await doFetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok)
    throw new Error(`No se pudo descargar el balance de prueba de Siigo (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024)
    throw new Error('El balance de prueba de Siigo es demasiado grande.');
  const rows = trialBalanceFromRows(
    await xlsxRows(bytes, { contentType: res.headers.get('content-type') }),
  );
  if (!rows.length)
    throw new Error(
      'No reconocí las columnas del balance de prueba de Siigo (código, débito, crédito, saldo final).',
    );
  return rows;
}

const month = (day: string) => Number(day.slice(5, 7));
const year = (day: string) => Number(day.slice(0, 4));

export function siigoReports(
  client: SiigoClient,
  runtime: { fetch?: typeof fetch; currency?: string } = {},
): ProviderReports {
  const doFetch = runtime.fetch ?? fetch;
  const currency = runtime.currency ?? 'COP';
  return {
    async balanceSheet(asOf: string): Promise<ProviderBalance> {
      const rows = await trialBalance(client, doFetch, year(asOf), 1, month(asOf));
      const out = balanceFromTrialBalance(rows, { provider: 'siigo', asOf, currency });
      out.notes.push('Fuente: balance de prueba general de Siigo Nube.');
      return out;
    },
    async profitAndLoss(from: string, to: string): Promise<ProviderPnl> {
      if (year(from) !== year(to))
        throw new Error('Siigo arma el balance de prueba de un solo año a la vez.');
      const rows = await trialBalance(client, doFetch, year(from), month(from), month(to));
      const out = pnlFromTrialBalance(rows, { provider: 'siigo', from, to, currency });
      out.notes.push('Fuente: balance de prueba general de Siigo Nube.');
      return out;
    },
  };
}
