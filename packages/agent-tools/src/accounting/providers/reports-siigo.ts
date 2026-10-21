import { logger } from '@cortex/core';
import { ProviderUncertainError, ProviderValidationError } from '../types';
import {
  type ProviderBalance,
  type ProviderPnl,
  type ProviderReports,
  type TrialBalanceRow,
  balanceFromTrialBalance,
  pnlFromTrialBalance,
  describeSheetsForLog,
  parseTrialBalanceSheets,
  readSpreadsheetSheets,
} from './reports';
import type { SiigoClient } from './siigo-client';
import { type PartyBalanceRow, parsePartyBalanceRows } from './siigo-more';

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

/** Pide un reporte de Excel a Siigo (POST → `file_url`) y lo lee, hoja por hoja. */
async function reportSheets(
  client: SiigoClient,
  doFetch: typeof fetch,
  path: string,
  body: Record<string, unknown>,
  label: string,
) {
  let out: { file_url?: string } | null;
  try {
    out = await client.post<{ file_url?: string } | null>(path, body);
  } catch (err) {
    if (err instanceof ProviderUncertainError || err instanceof ProviderValidationError)
      throw new Error(`Siigo no entregó ${label} (${err.message.split('.')[0]}). Inténtalo en unos minutos.`);
    throw err;
  }
  const url = out?.file_url ?? '';
  if (!isSiigoReportUrl(url)) throw new Error(`Siigo no devolvió el enlace de ${label}.`);
  const res = await doFetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`No se pudo descargar ${label} de Siigo (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error(`${label} de Siigo es demasiado grande.`);
  return readSpreadsheetSheets(bytes, { contentType: res.headers.get('content-type') });
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
  const sheets = await readSpreadsheetSheets(bytes, {
    contentType: res.headers.get('content-type'),
  });
  const { result } = parseTrialBalanceSheets(sheets);
  // Un mes sin movimientos: Siigo entrega un Excel sin la tabla (o con ella
  // vacía). Son ceros, no un error.
  if (result.kind === 'ok') return result.rows;
  if (result.kind === 'empty' || result.kind === 'no-data') return [];
  logger.warn(
    { year, monthStart, monthEnd, bytes: bytes.length, ...describeSheetsForLog(sheets) },
    'siigo: no reconocí las columnas del balance de prueba',
  );
  throw new Error(
    'No reconocí las columnas del balance de prueba de Siigo (código, débito, crédito, saldo final).',
  );
}

/** Marca de un período sin movimientos en Siigo (ceros, no faltante). */
export const NO_MOVEMENTS_NOTE = 'Sin movimientos en Siigo en este período.';

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
    async trialBalance(from: string, to: string): Promise<TrialBalanceRow[]> {
      if (year(from) !== year(to))
        throw new Error('Siigo arma el balance de prueba de un solo año a la vez.');
      return trialBalance(client, doFetch, year(from), month(from), month(to));
    },
    async trialBalanceByParty(y: number, m: number): Promise<PartyBalanceRow[]> {
      const sheets = await reportSheets(
        client,
        doFetch,
        '/v1/test-balance-report-by-thirdparty',
        { year: y, month_start: m, month_end: m, includes_tax_difference: false },
        `el balance de prueba por tercero de ${y}-${String(m).padStart(2, '0')}`,
      );
      for (const sheet of sheets) {
        const rows = parsePartyBalanceRows(sheet.rows);
        if (rows) return rows;
      }
      // Un mes sin movimientos puede venir sin la tabla: sólo es error si hay cifras.
      if (sheets.every((s) => !s.rows.some((r) => (r ?? []).some((c) => typeof c === 'number'))))
        return [];
      logger.warn(
        { year: y, month: m, ...describeSheetsForLog(sheets) },
        'siigo: no reconocí las columnas del balance de prueba por tercero',
      );
      throw new Error('No reconocí las columnas del balance de prueba por tercero de Siigo.');
    },
    async profitAndLoss(from: string, to: string): Promise<ProviderPnl> {
      if (year(from) !== year(to))
        throw new Error('Siigo arma el balance de prueba de un solo año a la vez.');
      const rows = await trialBalance(client, doFetch, year(from), month(from), month(to));
      const out = pnlFromTrialBalance(rows, { provider: 'siigo', from, to, currency });
      out.notes.push('Fuente: balance de prueba general de Siigo Nube.');
      if (!rows.length) out.notes.push(NO_MOVEMENTS_NOTE);
      return out;
    },
  };
}
